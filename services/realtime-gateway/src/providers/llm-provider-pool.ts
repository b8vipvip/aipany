import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export const llmProtocolSchema = z.enum(["chat_completions", "responses"]);
export type LlmProtocol = z.infer<typeof llmProtocolSchema>;

const protocolLatencySchema = z.object({
  chat_completions: z.number().int().positive().optional(),
  responses: z.number().int().positive().optional(),
}).optional();

const llmModelSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().optional(),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(10000).default(100),
  protocols: z.array(llmProtocolSchema).min(1),
  benchmarkAt: z.number().int().nonnegative().optional(),
  benchmarkScoreMs: z.number().int().positive().optional(),
  protocolLatencyMs: protocolLatencySchema,
});

const llmProviderSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  baseUrl: z.string().url(),
  apiKey: z.string(),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(10000).default(100),
  firstTokenTimeoutMs: z.number().int().min(1000).max(120000).optional(),
  totalTimeoutMs: z.number().int().min(3000).max(300000).optional(),
  models: z.array(llmModelSchema).min(1),
});

export const llmProviderPoolSchema = z.object({
  providers: z.array(llmProviderSchema).max(30).default([]),
  firstTokenTimeoutMs: z.number().int().min(1000).max(120000).default(12000),
  totalTimeoutMs: z.number().int().min(3000).max(300000).default(60000),
  cooldownMs: z.number().int().min(1000).max(600000).default(60000),
  maxAttempts: z.number().int().min(1).max(100).default(8),
});

export type LlmProviderPoolConfig = z.infer<typeof llmProviderPoolSchema>;
export type LlmProviderConfig = z.infer<typeof llmProviderSchema>;
export type LlmModelConfig = z.infer<typeof llmModelSchema>;

export interface LlmStreamOptions {
  messages: ChatMessage[];
  signal: AbortSignal;
  onDelta: (delta: string) => Promise<void> | void;
  traceId?: string;
}

export interface LlmGenerationConfig {
  temperature: number;
  maxTokens: number;
}

export interface LlmRouteAttemptTrace {
  routeKey: string;
  providerId: string;
  providerName: string;
  baseUrl: string;
  model: string;
  protocol: LlmProtocol;
  status: "success" | "failed" | "cancelled";
  startedAt: number;
  completedAt: number;
  elapsedMs: number;
  firstTokenMs?: number;
  firstTokenTimeoutMs: number;
  totalTimeoutMs: number;
  preferredAtStart: boolean;
  error?: string;
}

export interface LlmRequestTrace {
  id: string;
  configFingerprint: string;
  startedAt: number;
  completedAt: number;
  totalMs: number;
  status: "success" | "failed" | "cancelled";
  selectedRouteKey?: string;
  attempts: LlmRouteAttemptTrace[];
}

interface RouteCandidate {
  key: string;
  provider: LlmProviderConfig;
  model: LlmModelConfig;
  protocol: LlmProtocol;
}

interface RouteHealth {
  failures: number;
  cooldownUntil: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastError?: string;
  lastFirstTokenMs?: number;
}

interface PreferredRouteState {
  key: string;
  configFingerprint: string;
  expiresAt: number;
}

const routeHealth = new Map<string, RouteHealth>();
const recentTraces: LlmRequestTrace[] = [];
const TRACE_LIMIT = 100;
const PREFERRED_ROUTE_TTL_MS = 5 * 60 * 1000;
const BENCHMARK_FRESH_MS = 24 * 60 * 60 * 1000;
let preferredRoute: PreferredRouteState | undefined;

export class LlmProviderPool {
  private readonly fingerprint: string;

  constructor(
    private readonly config: LlmProviderPoolConfig,
    private readonly generation: LlmGenerationConfig = { temperature: 0.8, maxTokens: 800 },
  ) {
    this.fingerprint = getLlmProviderPoolFingerprint(config);
  }

  async streamChat(options: LlmStreamOptions): Promise<void> {
    const candidates = orderCandidates(flattenCandidates(this.config), this.fingerprint);
    if (candidates.length === 0) throw new Error("没有配置可用的 LLM 中转站 / 模型 / 请求协议");

    const trace: LlmRequestTrace = {
      id: options.traceId?.trim() || randomUUID(),
      configFingerprint: this.fingerprint,
      startedAt: Date.now(),
      completedAt: 0,
      totalMs: 0,
      status: "failed",
      attempts: [],
    };
    rememberTrace(trace);

    const maxAttempts = Math.min(this.config.maxAttempts, candidates.length);
    const errors: string[] = [];

    for (const candidate of candidates.slice(0, maxAttempts)) {
      let emittedAny = false;
      let firstTokenMs: number | undefined;
      const attemptStartedAt = Date.now();
      const firstTokenTimeoutMs = resolveFirstTokenTimeoutMs(candidate, this.config);
      const totalTimeoutMs = candidate.provider.totalTimeoutMs ?? this.config.totalTimeoutMs;
      const preferredAtStart = isPreferred(candidate.key, this.fingerprint);

      try {
        await this.streamCandidate(
          candidate,
          {
            ...options,
            onDelta: async (delta) => {
              emittedAny = true;
              await options.onDelta(delta);
            },
          },
          firstTokenTimeoutMs,
          totalTimeoutMs,
          (elapsedMs) => { firstTokenMs = elapsedMs; },
        );

        const completedAt = Date.now();
        markRouteSuccess(candidate, this.fingerprint, firstTokenMs);
        preferredRoute = {
          key: candidate.key,
          configFingerprint: this.fingerprint,
          expiresAt: completedAt + PREFERRED_ROUTE_TTL_MS,
        };
        trace.attempts.push({
          ...traceAttemptBase(candidate, attemptStartedAt, completedAt, firstTokenTimeoutMs, totalTimeoutMs, preferredAtStart),
          status: "success",
          firstTokenMs,
        });
        trace.selectedRouteKey = candidate.key;
        finalizeTrace(trace, "success");
        return;
      } catch (error) {
        const completedAt = Date.now();
        const message = error instanceof Error ? error.message : String(error);
        const cancelled = options.signal.aborted;
        if (!cancelled) markRouteFailure(candidate, this.fingerprint, this.config.cooldownMs, message);
        trace.attempts.push({
          ...traceAttemptBase(candidate, attemptStartedAt, completedAt, firstTokenTimeoutMs, totalTimeoutMs, preferredAtStart),
          status: cancelled ? "cancelled" : "failed",
          firstTokenMs,
          error: message,
        });
        errors.push(`${describeRoute(candidate)} => ${message}`);
        if (cancelled) {
          finalizeTrace(trace, "cancelled");
          throw error;
        }
        if (emittedAny) {
          finalizeTrace(trace, "failed");
          throw new Error(`LLM 流式响应中途失败，避免重复输出，未继续切换：${describeRoute(candidate)}：${message}`);
        }
      }
    }

    finalizeTrace(trace, "failed");
    throw new Error(`所有 LLM 路由均失败：${errors.join(" | ")}`);
  }

  getStatus() {
    return getLlmRoutingSnapshot(this.config).routes;
  }

  private async streamCandidate(
    candidate: RouteCandidate,
    options: LlmStreamOptions,
    firstTokenTimeoutMs: number,
    totalTimeoutMs: number,
    onFirstToken: (elapsedMs: number) => void,
  ): Promise<void> {
    const startedAt = Date.now();
    const controller = new AbortController();
    let firstTokenReceived = false;
    let firstTokenTimedOut = false;
    let totalTimedOut = false;

    const onParentAbort = () => controller.abort(options.signal.reason ?? new Error("LLM 请求已取消"));
    if (options.signal.aborted) onParentAbort();
    else options.signal.addEventListener("abort", onParentAbort, { once: true });

    const firstTokenTimer = setTimeout(() => {
      firstTokenTimedOut = true;
      controller.abort(new Error(`首 Token 超时（${firstTokenTimeoutMs}ms）`));
    }, firstTokenTimeoutMs);
    const totalTimer = setTimeout(() => {
      totalTimedOut = true;
      controller.abort(new Error(`总请求超时（${totalTimeoutMs}ms）`));
    }, totalTimeoutMs);

    const onDelta = async (delta: string) => {
      if (!firstTokenReceived) {
        firstTokenReceived = true;
        clearTimeout(firstTokenTimer);
        onFirstToken(Date.now() - startedAt);
      }
      await options.onDelta(delta);
    };

    try {
      if (candidate.protocol === "chat_completions") {
        await streamChatCompletions(candidate, options.messages, controller.signal, onDelta, this.generation);
      } else {
        await streamResponses(candidate, options.messages, controller.signal, onDelta, this.generation);
      }
      if (!firstTokenReceived) throw new Error("流式响应结束但未收到任何文本 Token");
    } catch (error) {
      if (firstTokenTimedOut) throw new Error(`首 Token 超时（${firstTokenTimeoutMs}ms）`);
      if (totalTimedOut) throw new Error(`总请求超时（${totalTimeoutMs}ms）`);
      if (options.signal.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new Error("LLM 请求已取消");
      throw error;
    } finally {
      clearTimeout(firstTokenTimer);
      clearTimeout(totalTimer);
      options.signal.removeEventListener("abort", onParentAbort);
    }
  }
}

export function parseLlmProviderPool(input: unknown): LlmProviderPoolConfig {
  const parsed = llmProviderPoolSchema.safeParse(input);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`LLM Provider Pool 配置无效：${detail}`);
  }

  const config = parsed.data;
  const ids = new Set<string>();
  for (const provider of config.providers) {
    if (ids.has(provider.id)) throw new Error(`LLM Provider ID 重复：${provider.id}`);
    ids.add(provider.id);
    if (provider.enabled && !provider.apiKey.trim()) throw new Error(`已启用的 LLM Provider ${provider.name} 缺少 API Key`);
  }
  return config;
}

export function createLegacyLlmProviderPool(input: {
  baseUrl: string;
  apiKey: string;
  model: string;
}): LlmProviderPoolConfig {
  return llmProviderPoolSchema.parse({
    providers: input.baseUrl && input.apiKey && input.model
      ? [{
          id: "legacy-provider",
          name: "Legacy LLM Provider",
          baseUrl: input.baseUrl,
          apiKey: input.apiKey,
          enabled: true,
          priority: 100,
          models: [{ id: input.model, enabled: true, priority: 100, protocols: ["chat_completions"] }],
        }]
      : [],
  });
}

export function resetLlmRoutingState(options: { clearTraces?: boolean } = {}): void {
  preferredRoute = undefined;
  routeHealth.clear();
  if (options.clearTraces) recentTraces.splice(0);
}

export function getLlmRequestTrace(traceId: string): LlmRequestTrace | undefined {
  const trace = recentTraces.find((item) => item.id === traceId);
  return trace ? cloneTrace(trace) : undefined;
}

export function getLlmRoutingSnapshot(config: LlmProviderPoolConfig, traceLimit = 20) {
  const fingerprint = getLlmProviderPoolFingerprint(config);
  const now = Date.now();
  expirePreferred(now);
  const candidates = flattenCandidates(config);
  return {
    generatedAt: now,
    configFingerprint: fingerprint,
    preferredRoute: preferredRoute && preferredRoute.configFingerprint === fingerprint
      ? { ...preferredRoute, remainingMs: Math.max(0, preferredRoute.expiresAt - now) }
      : undefined,
    routes: candidates.map((candidate) => {
      const health = routeHealth.get(healthKey(candidate, fingerprint));
      const firstTokenTimeoutMs = resolveFirstTokenTimeoutMs(candidate, config);
      return {
        routeKey: candidate.key,
        providerId: candidate.provider.id,
        providerName: candidate.provider.name,
        baseUrl: candidate.provider.baseUrl,
        model: candidate.model.id,
        protocol: candidate.protocol,
        providerPriority: candidate.provider.priority,
        modelPriority: candidate.model.priority,
        preferred: isPreferred(candidate.key, fingerprint),
        firstTokenTimeoutMs,
        configuredFirstTokenTimeoutMs: candidate.provider.firstTokenTimeoutMs ?? config.firstTokenTimeoutMs,
        benchmarkFirstTokenMs: getFreshBenchmarkLatency(candidate),
        failures: health?.failures ?? 0,
        cooldownUntil: health?.cooldownUntil ?? 0,
        cooldownRemainingMs: Math.max(0, (health?.cooldownUntil ?? 0) - now),
        lastSuccessAt: health?.lastSuccessAt,
        lastFailureAt: health?.lastFailureAt,
        lastFirstTokenMs: health?.lastFirstTokenMs,
        lastError: health?.lastError,
      };
    }),
    recentRequests: recentTraces.slice(0, Math.max(1, Math.min(traceLimit, TRACE_LIMIT))).map(cloneTrace),
  };
}

export function getLlmProviderPoolFingerprint(config: LlmProviderPoolConfig): string {
  const stable = {
    firstTokenTimeoutMs: config.firstTokenTimeoutMs,
    totalTimeoutMs: config.totalTimeoutMs,
    cooldownMs: config.cooldownMs,
    maxAttempts: config.maxAttempts,
    providers: config.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      enabled: provider.enabled,
      priority: provider.priority,
      firstTokenTimeoutMs: provider.firstTokenTimeoutMs,
      totalTimeoutMs: provider.totalTimeoutMs,
      models: provider.models.map((model) => ({
        id: model.id,
        enabled: model.enabled,
        priority: model.priority,
        protocols: model.protocols,
        benchmarkAt: model.benchmarkAt,
        benchmarkScoreMs: model.benchmarkScoreMs,
        protocolLatencyMs: model.protocolLatencyMs,
      })),
    })),
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex").slice(0, 16);
}

export async function testLlmRoute(input: {
  provider: LlmProviderConfig;
  model: LlmModelConfig;
  protocol: LlmProtocol;
  firstTokenTimeoutMs: number;
  totalTimeoutMs: number;
}): Promise<{ text: string; elapsedMs: number; trace?: LlmRequestTrace }> {
  const startedAt = Date.now();
  let text = "";
  const traceId = `admin-route-test-${randomUUID()}`;
  const pool = new LlmProviderPool({
    providers: [{ ...input.provider, models: [{ ...input.model, protocols: [input.protocol] }] }],
    firstTokenTimeoutMs: input.firstTokenTimeoutMs,
    totalTimeoutMs: input.totalTimeoutMs,
    cooldownMs: 1000,
    maxAttempts: 1,
  }, { temperature: 0.2, maxTokens: 100 });
  await pool.streamChat({
    messages: [{ role: "user", content: "请只回复：Aipany LLM 测试成功" }],
    signal: new AbortController().signal,
    traceId,
    onDelta: (delta) => { text += delta; },
  });
  return { text, elapsedMs: Date.now() - startedAt, trace: getLlmRequestTrace(traceId) };
}

async function streamChatCompletions(
  candidate: RouteCandidate,
  messages: ChatMessage[],
  signal: AbortSignal,
  onDelta: (delta: string) => Promise<void> | void,
  generation: LlmGenerationConfig,
): Promise<void> {
  const response = await fetch(`${trimBaseUrl(candidate.provider.baseUrl)}/chat/completions`, {
    method: "POST",
    headers: authHeaders(candidate.provider.apiKey),
    body: JSON.stringify({
      model: candidate.model.id,
      messages,
      temperature: generation.temperature,
      max_tokens: generation.maxTokens,
      stream: true,
    }),
    signal,
  });
  await assertOk(response, candidate);
  await consumeSse(response, async (payload) => {
    const delta = extractChatCompletionDelta(payload);
    if (delta) await onDelta(delta);
  });
}

async function streamResponses(
  candidate: RouteCandidate,
  messages: ChatMessage[],
  signal: AbortSignal,
  onDelta: (delta: string) => Promise<void> | void,
  generation: LlmGenerationConfig,
): Promise<void> {
  const response = await fetch(`${trimBaseUrl(candidate.provider.baseUrl)}/responses`, {
    method: "POST",
    headers: authHeaders(candidate.provider.apiKey),
    body: JSON.stringify({
      model: candidate.model.id,
      input: messages.map((message) => ({ role: message.role, content: message.content })),
      temperature: generation.temperature,
      max_output_tokens: generation.maxTokens,
      stream: true,
    }),
    signal,
  });
  await assertOk(response, candidate);
  await consumeSse(response, async (payload) => {
    const delta = extractResponsesDelta(payload) || extractChatCompletionDelta(payload);
    if (delta) await onDelta(delta);
  });
}

async function consumeSse(response: Response, onPayload: (payload: unknown) => Promise<void> | void): Promise<void> {
  if (!response.body) throw new Error("LLM 未返回流式响应体");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const consumeBlock = async (block: string) => {
    for (const rawLine of block.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        await onPayload(JSON.parse(data));
      } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    while (true) {
      const match = /\r?\n\r?\n/.exec(buffer);
      if (!match || match.index === undefined) break;
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      await consumeBlock(block);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) await consumeBlock(buffer);
}

async function assertOk(response: Response, candidate: RouteCandidate): Promise<void> {
  if (response.ok) return;
  const body = await response.text().catch(() => "");
  throw new Error(`HTTP ${response.status} ${describeRoute(candidate)}：${body.slice(0, 500)}`);
}

function extractChatCompletionDelta(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return "";
  const first = choices[0];
  if (!first || typeof first !== "object") return "";
  const delta = (first as { delta?: unknown }).delta;
  if (!delta || typeof delta !== "object") return "";
  const content = (delta as { content?: unknown }).content;
  return typeof content === "string" ? content : "";
}

function extractResponsesDelta(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const event = payload as { type?: unknown; delta?: unknown; text?: unknown };
  if (event.type === "response.output_text.delta" && typeof event.delta === "string") return event.delta;
  if (event.type === "response.output_text.done" && typeof event.text === "string") return "";
  if (typeof event.delta === "string" && typeof event.type === "string" && event.type.includes("output_text")) return event.delta;
  return "";
}

function flattenCandidates(config: LlmProviderPoolConfig): RouteCandidate[] {
  const candidates: RouteCandidate[] = [];
  for (const provider of config.providers) {
    if (!provider.enabled || !provider.apiKey.trim()) continue;
    for (const model of provider.models) {
      if (!model.enabled) continue;
      for (const protocol of model.protocols) {
        candidates.push({
          key: `${provider.id}::${model.id}::${protocol}`,
          provider,
          model,
          protocol,
        });
      }
    }
  }
  return candidates;
}

function orderCandidates(candidates: RouteCandidate[], fingerprint: string): RouteCandidate[] {
  const now = Date.now();
  expirePreferred(now);
  return [...candidates].sort((a, b) => {
    const aCooling = (routeHealth.get(healthKey(a, fingerprint))?.cooldownUntil ?? 0) > now ? 1 : 0;
    const bCooling = (routeHealth.get(healthKey(b, fingerprint))?.cooldownUntil ?? 0) > now ? 1 : 0;
    if (aCooling !== bCooling) return aCooling - bCooling;
    const aPreferred = isPreferred(a.key, fingerprint) ? -1 : 0;
    const bPreferred = isPreferred(b.key, fingerprint) ? -1 : 0;
    if (aPreferred !== bPreferred) return aPreferred - bPreferred;
    if (a.provider.priority !== b.provider.priority) return a.provider.priority - b.provider.priority;
    if (a.model.priority !== b.model.priority) return a.model.priority - b.model.priority;
    return a.model.protocols.indexOf(a.protocol) - b.model.protocols.indexOf(b.protocol);
  });
}

function resolveFirstTokenTimeoutMs(candidate: RouteCandidate, config: LlmProviderPoolConfig): number {
  const configured = candidate.provider.firstTokenTimeoutMs ?? config.firstTokenTimeoutMs;
  const benchmark = getFreshBenchmarkLatency(candidate);
  if (benchmark === undefined) return configured;
  const adaptive = Math.max(4000, Math.ceil(benchmark * 3 + 1000));
  return Math.min(configured, adaptive);
}

function getFreshBenchmarkLatency(candidate: RouteCandidate): number | undefined {
  const measured = candidate.model.protocolLatencyMs?.[candidate.protocol];
  const benchmarkAt = candidate.model.benchmarkAt;
  if (!measured || !benchmarkAt || Date.now() - benchmarkAt > BENCHMARK_FRESH_MS) return undefined;
  return measured;
}

function markRouteSuccess(candidate: RouteCandidate, fingerprint: string, firstTokenMs?: number): void {
  const key = healthKey(candidate, fingerprint);
  const previous = routeHealth.get(key);
  routeHealth.set(key, {
    failures: 0,
    cooldownUntil: 0,
    lastSuccessAt: Date.now(),
    lastFailureAt: previous?.lastFailureAt,
    lastError: undefined,
    lastFirstTokenMs: firstTokenMs,
  });
}

function markRouteFailure(candidate: RouteCandidate, fingerprint: string, cooldownMs: number, error: string): void {
  const key = healthKey(candidate, fingerprint);
  const previous = routeHealth.get(key);
  if (isPreferred(candidate.key, fingerprint)) preferredRoute = undefined;
  routeHealth.set(key, {
    failures: (previous?.failures ?? 0) + 1,
    cooldownUntil: Date.now() + cooldownMs,
    lastSuccessAt: previous?.lastSuccessAt,
    lastFailureAt: Date.now(),
    lastFirstTokenMs: previous?.lastFirstTokenMs,
    lastError: error,
  });
}

function healthKey(candidate: RouteCandidate, fingerprint: string): string {
  return `${fingerprint}::${candidate.key}`;
}

function isPreferred(routeKey: string, fingerprint: string): boolean {
  expirePreferred(Date.now());
  return preferredRoute?.key === routeKey && preferredRoute.configFingerprint === fingerprint;
}

function expirePreferred(now: number): void {
  if (preferredRoute && preferredRoute.expiresAt <= now) preferredRoute = undefined;
}

function traceAttemptBase(
  candidate: RouteCandidate,
  startedAt: number,
  completedAt: number,
  firstTokenTimeoutMs: number,
  totalTimeoutMs: number,
  preferredAtStart: boolean,
) {
  return {
    routeKey: candidate.key,
    providerId: candidate.provider.id,
    providerName: candidate.provider.name,
    baseUrl: candidate.provider.baseUrl,
    model: candidate.model.id,
    protocol: candidate.protocol,
    startedAt,
    completedAt,
    elapsedMs: completedAt - startedAt,
    firstTokenTimeoutMs,
    totalTimeoutMs,
    preferredAtStart,
  };
}

function rememberTrace(trace: LlmRequestTrace): void {
  const existing = recentTraces.findIndex((item) => item.id === trace.id);
  if (existing >= 0) recentTraces.splice(existing, 1);
  recentTraces.unshift(trace);
  if (recentTraces.length > TRACE_LIMIT) recentTraces.length = TRACE_LIMIT;
}

function finalizeTrace(trace: LlmRequestTrace, status: LlmRequestTrace["status"]): void {
  trace.status = status;
  trace.completedAt = Date.now();
  trace.totalMs = trace.completedAt - trace.startedAt;
}

function cloneTrace(trace: LlmRequestTrace): LlmRequestTrace {
  return {
    ...trace,
    attempts: trace.attempts.map((attempt) => ({ ...attempt })),
  };
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
}

function trimBaseUrl(value: string): string {
  return value.replace(/\/$/, "");
}

function describeRoute(candidate: RouteCandidate): string {
  return `${candidate.provider.name}/${candidate.model.id}/${candidate.protocol}`;
}
