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
  const providers = config.providers.map((provider) => {
    const scoredModels = provider.models.map((model) => ({
      model,
      adjustment: modelPriorityAdjustment(model, routeClass, variant),
    }));
    const bestAdjustment = scoredModels.length
      ? Math.min(...scoredModels.map((entry) => entry.adjustment))
      : 0;
    return {
      ...provider,
      priority: clampPriority(provider.priority + Math.round(bestAdjustment * 0.35)),
      models: scoredModels.map(({ model, adjustment }) => ({
        ...model,
        priority: clampPriority(model.priority + adjustment),
      })),
    };
  });
  return { ...config, providers };
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
