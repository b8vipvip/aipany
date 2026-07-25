import type {
  LlmModelConfig,
  LlmProviderPoolConfig,
} from "./llm-provider-pool.js";
import type {
  LiveRouteClass,
  LiveRoutingExperimentVariant,
} from "../pipeline/live-model-router.js";

export function applyLiveRoutingPolicy(
  config: LlmProviderPoolConfig,
  routeClass: LiveRouteClass,
  variant: LiveRoutingExperimentVariant,
): LlmProviderPoolConfig {
  const routeCount = countEnabledRoutes(config);
  const liveDeadlineMs = routeCount > 1 ? liveFirstTokenDeadlineMs(routeClass, variant) : undefined;
  const providers = config.providers.map((provider) => {
    const scoredModels = provider.models.map((model) => ({
      model,
      adjustment: modelPriorityAdjustment(model, routeClass, variant),
    }));
    const bestAdjustment = scoredModels.length
      ? Math.min(...scoredModels.map((entry) => entry.adjustment))
      : 0;
    const configuredDeadline = provider.firstTokenTimeoutMs ?? config.firstTokenTimeoutMs;
    return {
      ...provider,
      priority: clampPriority(provider.priority + Math.round(bestAdjustment * 0.35)),
      firstTokenTimeoutMs: liveDeadlineMs === undefined
        ? provider.firstTokenTimeoutMs
        : Math.min(configuredDeadline, liveDeadlineMs),
      models: scoredModels.map(({ model, adjustment }) => ({
        ...model,
        priority: clampPriority(model.priority + adjustment),
      })),
    };
  });
  return {
    ...config,
    firstTokenTimeoutMs: liveDeadlineMs === undefined
      ? config.firstTokenTimeoutMs
      : Math.min(config.firstTokenTimeoutMs, liveDeadlineMs),
    providers,
  };
}

/**
 * Economy Live should switch routes before silence becomes socially awkward.
 * The cap is enabled only when there is another usable route to fall back to;
 * a single-provider installation keeps its configured timeout rather than
 * turning a slow answer into a guaranteed failure.
 */
export function liveFirstTokenDeadlineMs(
  routeClass: LiveRouteClass,
  variant: LiveRoutingExperimentVariant,
): number {
  const latencyBias = variant === "latency_first" ? 0 : 350;
  switch (routeClass) {
    case "quick_chat": return 1_800 + latencyBias;
    case "simple_answer": return 2_600 + latencyBias;
    case "coding": return 4_500 + latencyBias;
    case "reasoning": return 6_000 + latencyBias;
    case "long_context": return 7_500 + latencyBias;
  }
}

export function modelPriorityAdjustment(
  model: LlmModelConfig,
  routeClass: LiveRouteClass,
  variant: LiveRoutingExperimentVariant,
): number {
  const id = model.id.toLowerCase();
  const latencyMs = bestKnownLatency(model);
  const latencyWeight = variant === "latency_first" ? 1 : 0.55;
  const qualityWeight = variant === "latency_first" ? 0.55 : 1;
  let adjustment = 0;

  if (latencyMs !== undefined) {
    // 200 ms is strongly preferred; >= 3000 ms receives a bounded penalty.
    adjustment += Math.round((Math.min(3000, latencyMs) - 600) / 12 * latencyWeight);
  }

  const fastHint = scoreHints(id, [
    /flash/u, /mini/u, /turbo/u, /lite/u, /instant/u, /speed/u, /fast/u,
    /(?:^|[-_.])(?:7b|8b|9b|14b)(?:[-_.]|$)/u,
  ]);
  const qualityHint = scoreHints(id, [
    /plus/u, /max/u, /pro/u, /thinking/u, /reason/u, /r1/u,
    /(?:^|[-_.])(?:32b|70b|72b|110b|235b)(?:[-_.]|$)/u,
  ]);
  const codingHint = scoreHints(id, [/coder/u, /code/u, /devstral/u, /codestral/u]);

  if (routeClass === "quick_chat") {
    adjustment -= Math.round(fastHint * 140 * latencyWeight);
    adjustment += Math.round(qualityHint * 35 * latencyWeight);
  } else if (routeClass === "simple_answer") {
    adjustment -= Math.round(fastHint * 90 * latencyWeight);
    adjustment -= Math.round(qualityHint * 18 * qualityWeight);
  } else if (routeClass === "coding") {
    adjustment -= Math.round(codingHint * 220 * qualityWeight);
    adjustment -= Math.round(qualityHint * 85 * qualityWeight);
    adjustment += Math.round(fastHint * 20 * qualityWeight);
  } else if (routeClass === "reasoning") {
    adjustment -= Math.round(qualityHint * 190 * qualityWeight);
    adjustment += Math.round(fastHint * 25 * qualityWeight);
  } else if (routeClass === "long_context") {
    adjustment -= Math.round(qualityHint * 150 * qualityWeight);
    adjustment -= Math.round(codingHint * 45 * qualityWeight);
  }

  return Math.max(-600, Math.min(600, adjustment));
}

function countEnabledRoutes(config: LlmProviderPoolConfig): number {
  return config.providers.reduce((count, provider) => {
    if (!provider.enabled || !provider.apiKey.trim()) return count;
    return count + provider.models.reduce((modelCount, model) => {
      if (!model.enabled) return modelCount;
      return modelCount + model.protocols.length;
    }, 0);
  }, 0);
}

function bestKnownLatency(model: LlmModelConfig): number | undefined {
  const values = [
    model.benchmarkScoreMs,
    model.protocolLatencyMs?.chat_completions,
    model.protocolLatencyMs?.responses,
  ].filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  return values.length ? Math.min(...values) : undefined;
}

function scoreHints(value: string, patterns: RegExp[]): number {
  return patterns.reduce((score, pattern) => score + (pattern.test(value) ? 1 : 0), 0);
}

function clampPriority(value: number): number {
  return Math.max(0, Math.min(10000, Math.round(value)));
}
