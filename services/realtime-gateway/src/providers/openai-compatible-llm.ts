export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OpenAiCompatibleLlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

export class OpenAiCompatibleLlm {
  constructor(private readonly config: OpenAiCompatibleLlmConfig) {}

  async streamChat(options: {
    messages: ChatMessage[];
    signal: AbortSignal;
    onDelta: (delta: string) => Promise<void> | void;
  }): Promise<void> {
    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: options.messages,
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens,
        stream: true,
      }),
      signal: options.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`LLM 请求失败 HTTP ${response.status}：${body.slice(0, 500)}`);
    }
    if (!response.body) throw new Error("LLM 未返回流式响应体");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary < 0) break;
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        for (const rawLine of block.split("\n")) {
          const line = rawLine.trim();
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;

          let payload: unknown;
          try {
            payload = JSON.parse(data);
          } catch {
            continue;
          }

          const delta = extractDelta(payload);
          if (delta) await options.onDelta(delta);
        }
      }
    }
  }
}

function extractDelta(payload: unknown): string {
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
