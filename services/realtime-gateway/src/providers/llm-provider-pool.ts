import { z } from "zod";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export const llmProtocolSchema = z.enum(["chat_completions", "responses"]);
export type LlmProtocol = z.infer<typeof llmProtocolSchema>;

const llmModelSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().optional(),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(10000).default(100),
  protocols: z.array(llmProtocolSchema).min(1),
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
}

const routeHealth = new Map<string, RouteHealth>();
let preferredRouteKey: string | undefined;

export class LlmProviderPool {
  constructor(private readonly config: LlmProviderPoolConfig) {}

  async streamChat(options: LlmStreamOptions): Promise<void> {
    const candidates = orderCandidates(flattenCandidates(this.config));
    if (candidates.length === 0) throw new Error("没有配置可用的 LLM 中转站 / 模型 / 请求协议");

    const maxAttempts = Math.min(this.config.maxAttempts, candidates.length);
    const errors: string[] = [];

    for (const candidate of candidates.slice(0, maxAttempts)) {
      let emittedAny = false;
      try {
        await this.streamCandidate(candidate, {
          ...options,
          onDelta: async (delta) => {
            emittedAny = true;
            await options.onDelta(delta);
          },
        });
        markRouteSuccess(candidate.key);
        preferredRouteKey = candidate.key;
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        markRouteFailure(candidate.key, this.config.cooldownMs, message);
        errors.push(`${describeRoute(candidate)} => ${message}`);
        if (emittedAny) {
          throw new Error(`LLM 流式响应中途失败，避免重复输出，未继续切换：${describeRoute(candidate)}：${message}`);
        }
      }
    }

    throw new Error(`所有 LLM 路由均失败：${errors.join(" | ")}`);
  }

  getStatus() {
    return flattenCandidates(this.config).map((candidate) => {
      const health = routeHealth.get(candidate.key);
      return {
        providerId: candidate.provider.id,
        providerName: candidate.provider.name,
        model: candidate.model.id,
        protocol: candidate.protocol,
        preferred: preferredRouteKey === candidate.key,
        failures: health?.failures ?? 0,
        cooldownUntil: health?.cooldownUntil ?? 0,
        lastSuccessAt: health?.lastSuccessAt,
        lastFailureAt: health?.lastFailureAt,
        lastError: health?.lastError,
      };
    });
  }

  private async streamCandidate(candidate: RouteCandidate, options: LlmStreamOptions): Promise<void> {
    const firstTokenTimeoutMs = candidate.provider.firstTokenTimeoutMs ?? this.config.firstTokenTimeoutMs;
    const totalTimeoutMs = candidate.provider.totalTimeoutMs ?? this.config.totalTimeoutMs;
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
      }
      await options.onDelta(delta);
    };

    try {
      if (candidate.protocol === "chat_completions") {
        await streamChatCompletions(candidate, options.messages, controller.signal, onDelta);
      } else {
        await streamResponses(candidate, options.messages, controller.signal, onDelta);
      }
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

export async function testLlmRoute(input: {
  provider: LlmProviderConfig;
  model: LlmModelConfig;
  protocol: LlmProtocol;
  firstTokenTimeoutMs: number;
  totalTimeoutMs: number;
}): Promise<{ text: string; elapsedMs: number }> {
  const startedAt = Date.now();
  let text = "";
  const pool = new LlmProviderPool({
    providers: [{ ...input.provider, models: [{ ...input.model, protocols: [input.protocol] }] }],
    firstTokenTimeoutMs: input.firstTokenTimeoutMs,
    totalTimeoutMs: input.totalTimeoutMs,
    cooldownMs: 1000,
    maxAttempts: 1,
  });
  await pool.streamChat({
    messages: [{ role: "user", content: "请只回复：Aipany LLM 测试成功" }],
    signal: new AbortController().signal,
    onDelta: (delta) => { text += delta; },
  });
  return { text, elapsedMs: Date.now() - startedAt };
}

async function streamChatCompletions(
  candidate: RouteCandidate,
  messages: ChatMessage[],
  signal: AbortSignal,
  onDelta: (delta: string) => Promise<void> | void,
): Promise<void> {
  const response = await fetch(`${trimBaseUrl(candidate.provider.baseUrl)}/chat/completions`, {
    method: "POST",
    headers: authHeaders(candidate.provider.apiKey),
    body: JSON.stringify({
      model: candidate.model.id,
      messages,
      temperature: 0.8,
      max_tokens: 800,
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
): Promise<void> {
  const response = await fetch(`${trimBaseUrl(candidate.provider.baseUrl)}/responses`, {
    method: "POST",
    headers: authHeaders(candidate.provider.apiKey),
    body: JSON.stringify({
      model: candidate.model.id,
      input: messages.map((message) => ({ role: message.role, content: message.content })),
      temperature: 0.8,
      max_output_tokens: 800,
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

function orderCandidates(candidates: RouteCandidate[]): RouteCandidate[] {
  const now = Date.now();
  return [...candidates].sort((a, b) => {
    const aPreferred = a.key === preferredRouteKey ? -1 : 0;
    const bPreferred = b.key === preferredRouteKey ? -1 : 0;
    if (aPreferred !== bPreferred) return aPreferred - bPreferred;
    const aCooling = (routeHealth.get(a.key)?.cooldownUntil ?? 0) > now ? 1 : 0;
    const bCooling = (routeHealth.get(b.key)?.cooldownUntil ?? 0) > now ? 1 : 0;
    if (aCooling !== bCooling) return aCooling - bCooling;
    if (a.provider.priority !== b.provider.priority) return a.provider.priority - b.provider.priority;
    if (a.model.priority !== b.model.priority) return a.model.priority - b.model.priority;
    return a.model.protocols.indexOf(a.protocol) - b.model.protocols.indexOf(b.protocol);
  });
}

function markRouteSuccess(key: string): void {
  const previous = routeHealth.get(key);
  routeHealth.set(key, {
    failures: 0,
    cooldownUntil: 0,
    lastSuccessAt: Date.now(),
    lastFailureAt: previous?.lastFailureAt,
    lastError: undefined,
  });
}

function markRouteFailure(key: string, cooldownMs: number, error: string): void {
  const previous = routeHealth.get(key);
  routeHealth.set(key, {
    failures: (previous?.failures ?? 0) + 1,
    cooldownUntil: Date.now() + cooldownMs,
    lastSuccessAt: previous?.lastSuccessAt,
    lastFailureAt: Date.now(),
    lastError: error,
  });
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
