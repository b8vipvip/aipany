import type { ChatMessage } from "../providers/openai-compatible-llm.js";

export interface StablePartialCandidate {
  text: string;
  stableCount: number;
  observedAt: number;
  likelyComplete: boolean;
}

export class StablePartialTracker {
  private previous = "";
  private stableCount = 0;
  private candidate?: StablePartialCandidate;

  observe(text: string, now = Date.now()): StablePartialCandidate | undefined {
    const normalized = normalizeText(text);
    if (!normalized) return this.candidate;
    const similarity = textSimilarity(this.previous, normalized);
    this.stableCount = similarity >= 0.92 ? this.stableCount + 1 : 1;
    this.previous = normalized;
    this.candidate = {
      text: text.trim(),
      stableCount: this.stableCount,
      observedAt: now,
      likelyComplete: /[。！？!?；;]$/u.test(text.trim()),
    };
    return this.candidate;
  }

  current(): StablePartialCandidate | undefined {
    return this.candidate;
  }

  shouldStartEarly(): boolean {
    const candidate = this.candidate;
    return Boolean(
      candidate
      && candidate.text.trim().length >= 8
      && candidate.stableCount >= 2
      && candidate.likelyComplete,
    );
  }

  reset(): void {
    this.previous = "";
    this.stableCount = 0;
    this.candidate = undefined;
  }
}

export interface StreamChatOptions {
  messages: ChatMessage[];
  signal: AbortSignal;
  onDelta: (delta: string) => Promise<void> | void;
  traceId?: string;
}

export type StreamChatFunction = (options: StreamChatOptions) => Promise<void>;

interface ActiveSpeculation {
  partialText: string;
  startedAt: number;
  abortController: AbortController;
  pendingDeltas: string[];
  sink?: (delta: string) => Promise<void> | void;
  delivery: Promise<void>;
  done: Promise<void>;
  error?: unknown;
  adopted: boolean;
}

export interface SpeculativeLlmStats {
  started: number;
  adopted: number;
  rejected: number;
  aborted: number;
}

/**
 * Starts an LLM stream from a stable ASR partial and keeps its tokens private
 * until the final transcript reaches the normal response pipeline. If the final
 * user turn still matches the partial, the buffered stream is adopted; otherwise
 * it is cancelled and the normal request runs unchanged.
 */
export class SpeculativeLlmCoordinator {
  private active?: ActiveSpeculation;
  readonly stats: SpeculativeLlmStats = { started: 0, adopted: 0, rejected: 0, aborted: 0 };

  constructor(
    private readonly runOriginal: StreamChatFunction,
    private readonly maxAgeMs = 4_000,
    private readonly minimumSimilarity = 0.86,
  ) {}

  start(partialText: string, messages: ChatMessage[], now = Date.now()): boolean {
    const text = partialText.trim();
    if (text.length < 4) return false;
    if (this.active && !this.active.adopted && now - this.active.startedAt < this.maxAgeMs) {
      const similarity = textSimilarity(this.active.partialText, text);
      if (similarity >= 0.94) return false;
      this.cancel("superseded");
    }

    const abortController = new AbortController();
    const state: ActiveSpeculation = {
      partialText: text,
      startedAt: now,
      abortController,
      pendingDeltas: [],
      delivery: Promise.resolve(),
      done: Promise.resolve(),
      adopted: false,
    };
    state.done = this.runOriginal({
      messages,
      signal: abortController.signal,
      traceId: `speculative-${now}`,
      onDelta: (delta) => {
        if (!delta) return;
        if (!state.sink) {
          state.pendingDeltas.push(delta);
          return;
        }
        state.delivery = state.delivery.then(() => Promise.resolve(state.sink!(delta)));
      },
    }).catch((error) => {
      state.error = error;
    });
    this.active = state;
    this.stats.started += 1;
    return true;
  }

  async streamOrAdopt(options: StreamChatOptions, now = Date.now()): Promise<void> {
    const state = this.active;
    const finalText = extractLastUserText(options.messages);
    if (!state || state.adopted || !finalText || now - state.startedAt > this.maxAgeMs) {
      if (state && !state.adopted) this.cancel("expired");
      return this.runOriginal(options);
    }

    const similarity = textSimilarity(state.partialText, finalText);
    if (similarity < this.minimumSimilarity) {
      this.stats.rejected += 1;
      this.cancel("final_mismatch");
      return this.runOriginal(options);
    }

    state.adopted = true;
    state.sink = options.onDelta;
    this.stats.adopted += 1;
    const buffered = state.pendingDeltas.splice(0);
    for (const delta of buffered) {
      state.delivery = state.delivery.then(() => Promise.resolve(options.onDelta(delta)));
    }
    await state.done;
    await state.delivery;
    if (state.error && !isAbortError(state.error)) {
      this.active = undefined;
      return this.runOriginal(options);
    }
    if (this.active === state) this.active = undefined;
  }

  cancel(_reason = "cancelled"): void {
    const state = this.active;
    if (!state) return;
    if (!state.adopted) {
      state.abortController.abort();
      this.stats.aborted += 1;
    }
    this.active = undefined;
  }

  hasActive(): boolean {
    return Boolean(this.active && !this.active.adopted);
  }
}

export function buildSpeculativeMessages(history: ChatMessage[], userText: string): ChatMessage[] {
  return [
    ...history.map((message) => ({ ...message })),
    { role: "user", content: userText.trim() },
    {
      role: "system",
      content: "这是实时语音对话的预测性预生成。回答要自然、简短、口语化，先说最有用的信息，不要提及这是预测。",
    },
  ];
}

export function textSimilarity(left: string, right: string): number {
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length > b.length ? a : b;
  if (longer.startsWith(shorter) && shorter.length / longer.length >= 0.8) return 0.94;

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const old = previous[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + cost);
      diagonal = old;
    }
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}

function extractLastUserText(messages: ChatMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return messages[index]?.content;
  }
  return undefined;
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .trim();
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted"));
}
