import { randomUUID } from "node:crypto";
import type { LiveRouteClass, LiveRoutingExperimentVariant } from "../pipeline/live-model-router.js";
import {
  createLegacyLlmProviderPool,
  getLlmRequestTrace,
  LlmProviderPool,
  parseLlmProviderPool,
  type ChatMessage as ProviderPoolChatMessage,
  type LlmGenerationConfig,
  type LlmProviderPoolConfig,
} from "./llm-provider-pool.js";
import { applyLiveRoutingPolicy } from "./llm-routing-policy.js";

export type ChatMessage = ProviderPoolChatMessage;

export interface OpenAiCompatibleLlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

export interface LlmRouteSelectionSummary {
  traceId: string;
  routeClass?: LiveRouteClass;
  experimentVariant?: LiveRoutingExperimentVariant;
  providerId: string;
  providerName: string;
  model: string;
  protocol: string;
  routeKey: string;
  firstTokenMs?: number;
  totalMs: number;
}

export class OpenAiCompatibleLlm {
  private readonly basePoolConfig: LlmProviderPoolConfig;
  private readonly generation: LlmGenerationConfig;
  private readonly defaultPool: LlmProviderPool;

  constructor(private readonly config: OpenAiCompatibleLlmConfig) {
    this.basePoolConfig = readProviderPool(config);
    this.generation = {
      temperature: config.temperature,
      maxTokens: config.maxTokens,
    };
    this.defaultPool = new LlmProviderPool(this.basePoolConfig, this.generation);
  }

  async streamChat(options: {
    messages: ChatMessage[];
    signal: AbortSignal;
    onDelta: (delta: string) => Promise<void> | void;
    traceId?: string;
    routeClass?: LiveRouteClass;
    experimentVariant?: LiveRoutingExperimentVariant;
    onRouteSelected?: (summary: LlmRouteSelectionSummary) => void;
  }): Promise<void> {
    const traceId = options.traceId?.trim() || randomUUID();
    const pool = options.routeClass && options.experimentVariant
      ? new LlmProviderPool(
          applyLiveRoutingPolicy(this.basePoolConfig, options.routeClass, options.experimentVariant),
          this.generation,
        )
      : this.defaultPool;

    await pool.streamChat({
      messages: options.messages,
      signal: options.signal,
      onDelta: options.onDelta,
      traceId,
    });

    if (!options.onRouteSelected) return;
    const trace = getLlmRequestTrace(traceId);
    const selected = trace?.attempts.find((attempt) => attempt.routeKey === trace.selectedRouteKey && attempt.status === "success")
      ?? [...(trace?.attempts ?? [])].reverse().find((attempt) => attempt.status === "success");
    if (!trace || !selected) return;
    options.onRouteSelected({
      traceId,
      routeClass: options.routeClass,
      experimentVariant: options.experimentVariant,
      providerId: selected.providerId,
      providerName: selected.providerName,
      model: selected.model,
      protocol: selected.protocol,
      routeKey: selected.routeKey,
      firstTokenMs: selected.firstTokenMs,
      totalMs: trace.totalMs,
    });
  }
}

function readProviderPool(config: OpenAiCompatibleLlmConfig): LlmProviderPoolConfig {
  const runtime = process.env.LLM_PROVIDER_POOL_JSON?.trim();
  if (!runtime) {
    return createLegacyLlmProviderPool({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
    });
  }

  try {
    return parseLlmProviderPool(JSON.parse(runtime));
  } catch (error) {
    throw new Error(`LLM Provider Pool 运行时配置无效：${error instanceof Error ? error.message : String(error)}`);
  }
}
