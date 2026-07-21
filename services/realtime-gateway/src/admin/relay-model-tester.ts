import type { LlmModelConfig, LlmProtocol, LlmProviderConfig } from "../providers/llm-provider-pool.js";

export interface RelayProtocolBenchmark {
  protocol: LlmProtocol;
  success: boolean;
  firstTokenMs?: number;
  totalMs: number;
  error?: string;
}

export interface RelayModelBenchmark {
  model: string;
  eligible: boolean;
  scoreMs?: number;
  protocols: RelayProtocolBenchmark[];
}

export interface RelayBenchmarkResult {
  providerId: string;
  providerName: string;
  testedBaseUrl: string;
  discoveredModels: number;
  eligibleModels: LlmModelConfig[];
  results: RelayModelBenchmark[];
  elapsedMs: number;
}

const PROTOCOLS: LlmProtocol[] = ["responses", "chat_completions"];

export async function benchmarkRelayProvider(
  provider: LlmProviderConfig,
  options: { firstTokenTimeoutMs?: number; totalTimeoutMs?: number; concurrency?: number } = {},
): Promise<RelayBenchmarkResult> {
  const startedAt = Date.now();
  const firstTokenTimeoutMs = options.firstTokenTimeoutMs ?? Math.min(provider.firstTokenTimeoutMs ?? 12000, 15000);
  const totalTimeoutMs = options.totalTimeoutMs ?? Math.min(provider.totalTimeoutMs ?? 60000, 30000);
  const concurrency = Math.max(1, Math.min(5, options.concurrency ?? 3));
  const discovery = await discoverRelayModels(provider.baseUrl, provider.apiKey, totalTimeoutMs);
  if (!discovery.models.length) throw new Error("没有从中转站发现任何模型");

  const results = await mapWithConcurrency(discovery.models, concurrency, async (model) => {
    const protocols = await Promise.all(PROTOCOLS.map((protocol) => benchmarkProtocol({
      baseUrl: discovery.apiRoot,
      apiKey: provider.apiKey,
      model,
      protocol,
      firstTokenTimeoutMs,
      totalTimeoutMs,
    })));
    const eligible = protocols.every((item) => item.success && item.firstTokenMs !== undefined);
    const firstTokenValues = protocols.flatMap((item) => item.firstTokenMs === undefined ? [] : [item.firstTokenMs]);
    const scoreMs = eligible && firstTokenValues.length === PROTOCOLS.length
      ? Math.round(firstTokenValues.reduce((sum, value) => sum + value, 0) / firstTokenValues.length)
      : undefined;
    return { model, eligible, scoreMs, protocols } satisfies RelayModelBenchmark;
  });

  const eligible = results
    .filter((item) => item.eligible && item.scoreMs !== undefined)
    .sort((a, b) => (a.scoreMs ?? Number.MAX_SAFE_INTEGER) - (b.scoreMs ?? Number.MAX_SAFE_INTEGER));

  const eligibleModels: LlmModelConfig[] = eligible.map((item, index) => ({
    id: item.model,
    enabled: true,
    priority: (index + 1) * 10,
    protocols: [...item.protocols]
      .sort((a, b) => (a.firstTokenMs ?? Number.MAX_SAFE_INTEGER) - (b.firstTokenMs ?? Number.MAX_SAFE_INTEGER))
      .map((entry) => entry.protocol),
  }));

  return {
    providerId: provider.id,
    providerName: provider.name,
    testedBaseUrl: discovery.apiRoot,
    discoveredModels: discovery.models.length,
    eligibleModels,
    results: results.sort((a, b) => {
      if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
      return (a.scoreMs ?? Number.MAX_SAFE_INTEGER) - (b.scoreMs ?? Number.MAX_SAFE_INTEGER);
    }),
    elapsedMs: Date.now() - startedAt,
  };
}

async function discoverRelayModels(baseUrl: string, apiKey: string, timeoutMs: number): Promise<{ apiRoot: string; models: string[] }> {
  const errors: string[] = [];
  for (const apiRoot of getApiRoots(baseUrl)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${apiRoot}/models`, {
        headers: authHeaders(apiKey, "application/json"),
        signal: controller.signal,
      });
      if (!response.ok) {
        errors.push(`${apiRoot}/models => HTTP ${response.status}`);
        continue;
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().includes("json")) {
        errors.push(`${apiRoot}/models => 返回内容不是 JSON`);
        continue;
      }
      const models = extractModels(await response.json());
      if (models.length) return { apiRoot, models };
      errors.push(`${apiRoot}/models => JSON 中没有识别到模型列表`);
    } catch (error) {
      errors.push(`${apiRoot}/models => ${formatError(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`模型列表检测失败：${errors.join(" | ")}`);
}

async function benchmarkProtocol(input: {
  baseUrl: string;
  apiKey: string;
  model: string;
  protocol: LlmProtocol;
  firstTokenTimeoutMs: number;
  totalTimeoutMs: number;
}): Promise<RelayProtocolBenchmark> {
  const startedAt = Date.now();
  const controller = new AbortController();
  let firstTokenAt = 0;
  let firstTokenTimedOut = false;
  let totalTimedOut = false;
  const firstTimer = setTimeout(() => {
    firstTokenTimedOut = true;
    controller.abort();
  }, input.firstTokenTimeoutMs);
  const totalTimer = setTimeout(() => {
    totalTimedOut = true;
    controller.abort();
  }, input.totalTimeoutMs);

  try {
    const response = await fetch(
      input.protocol === "responses" ? `${input.baseUrl}/responses` : `${input.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: authHeaders(input.apiKey, "text/event-stream"),
        body: JSON.stringify(input.protocol === "responses"
          ? { model: input.model, input: "只回复 OK", max_output_tokens: 16, stream: true }
          : { model: input.model, messages: [{ role: "user", content: "只回复 OK" }], max_tokens: 16, temperature: 0, stream: true }),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}${body ? `：${body.slice(0, 240)}` : ""}`);
    }
    if (!response.body) throw new Error("没有流式响应体");

    await consumeSse(response, (payload) => {
      const text = input.protocol === "responses" ? extractResponsesDelta(payload) : extractChatDelta(payload);
      if (text && !firstTokenAt) {
        firstTokenAt = Date.now();
        clearTimeout(firstTimer);
      }
    });
    if (!firstTokenAt) throw new Error("流式请求结束但没有收到文本 Token");

    return {
      protocol: input.protocol,
      success: true,
      firstTokenMs: firstTokenAt - startedAt,
      totalMs: Date.now() - startedAt,
    };
  } catch (error) {
    const message = firstTokenTimedOut
      ? `首 Token 超时（${input.firstTokenTimeoutMs}ms）`
      : totalTimedOut
        ? `总请求超时（${input.totalTimeoutMs}ms）`
        : formatError(error);
    return { protocol: input.protocol, success: false, totalMs: Date.now() - startedAt, error: message };
  } finally {
    clearTimeout(firstTimer);
    clearTimeout(totalTimer);
  }
}

async function consumeSse(response: Response, onPayload: (payload: unknown) => void): Promise<void> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const consumeBlock = (block: string) => {
    for (const rawLine of block.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try { onPayload(JSON.parse(data)); } catch { /* 忽略非 JSON SSE 行 */ }
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
      consumeBlock(block);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) consumeBlock(buffer);
}

function extractModels(input: unknown): string[] {
  const models = new Set<string>();
  const candidates = Array.isArray(input)
    ? input
    : input && typeof input === "object" && Array.isArray((input as { data?: unknown }).data)
      ? (input as { data: unknown[] }).data
      : input && typeof input === "object" && Array.isArray((input as { models?: unknown }).models)
        ? (input as { models: unknown[] }).models
        : [];
  for (const item of candidates) {
    if (typeof item === "string" && item.trim()) models.add(item.trim());
    else if (item && typeof item === "object") {
      const value = (item as { id?: unknown; name?: unknown; model?: unknown }).id
        ?? (item as { name?: unknown }).name
        ?? (item as { model?: unknown }).model;
      if (typeof value === "string" && value.trim()) models.add(value.trim());
    }
  }
  return [...models].sort();
}

function getApiRoots(baseUrl: string): string[] {
  const normalized = baseUrl.trim().replace(/\/$/, "");
  const roots = normalized.endsWith("/v1")
    ? [normalized, normalized.slice(0, -3).replace(/\/$/, "")]
    : [`${normalized}/v1`, normalized];
  return [...new Set(roots.filter(Boolean))];
}

function authHeaders(apiKey: string, accept: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: accept,
    "User-Agent": "Mozilla/5.0 Aipany-Relay-Tester/0.4.3",
  };
}

function extractChatDelta(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") return "";
  const delta = (choices[0] as { delta?: unknown }).delta;
  if (!delta || typeof delta !== "object") return "";
  const content = (delta as { content?: unknown }).content;
  return typeof content === "string" ? content : "";
}

function extractResponsesDelta(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const event = payload as { type?: unknown; delta?: unknown };
  return event.type === "response.output_text.delta" && typeof event.delta === "string" ? event.delta : "";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      output[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return output;
}
