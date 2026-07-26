import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { recordGlobalRealtimeEvent } from "../observability/global-observability.js";

export interface QwenTtsConfig {
  apiKey: string;
  workspaceId?: string;
  baseUrl: string;
  model: string;
  voice: string;
  language: string;
  sampleRate: number;
  optimizeInstructions: boolean;
}

export interface QwenTtsPrewarmConfig {
  apiKey: string;
  workspaceId?: string;
  baseUrl: string;
  model: string;
}

export type QwenTtsProtocol = "qwen_realtime" | "dashscope_inference";

export interface QwenTtsProsody {
  volume: number;
  rate: number;
  pitch: number;
  style: string;
}

export interface QwenTtsInstructionPlan {
  rawChars: number;
  rawWeightedChars: number;
  finalChars: number;
  finalWeightedChars: number;
  instruction: string;
  profile: string;
  shortened: boolean;
}

export interface QwenTtsInferenceParameters {
  text_type: "PlainText";
  voice: string;
  format: "pcm";
  sample_rate: number;
  volume: number;
  rate: number;
  pitch: number;
  enable_ssml: false;
  language_hints: string[];
  instruction?: string;
}

interface QwenTtsEvents {
  audio: [Buffer];
  error: [Error];
  finished: [];
}

interface TtsTransportEvents {
  audio: [Buffer];
  error: [Error];
  finished: [];
}

interface WarmEntry {
  transport: BaseTtsTransport;
  timer: ReturnType<typeof setTimeout>;
}

const PREWARM_TTL_MS = 20_000;
const QWEN_INSTRUCTION_SAFE_WEIGHT = 80;
const warmPool = new Map<string, WarmEntry>();

const SAFE_INSTRUCTION_BY_STYLE: Record<string, string> = {
  none: "",
  natural: "自然口语表达，语速适中，避免播音腔。",
  warm_support: "语气温暖轻柔，语速稍慢，像熟人自然陪伴。",
  reassuring: "语气稳定安心，柔和清晰，语速稍慢。",
  bright_playful: "语气自然轻快，带一点笑意，语速稍快。",
  curious_surprised: "语气自然好奇，轻快灵动，不要夸张。",
  grounded_calm: "语气冷静柔和，语速稍慢，保持克制。",
  focused: "语气清晰专注，节奏利落，不制造紧张感。",
  reflective_soft: "语气平和柔软，语速稍慢，适当轻停顿。",
  engaged_lively: "语气自然有精神，节奏轻快，但不要抢话。",
};

abstract class BaseTtsTransport extends EventEmitter<TtsTransportEvents> {
  abstract open(): Promise<void>;
  abstract configure(config: QwenTtsConfig, instructions: string): Promise<void>;
  abstract appendText(text: string): void;
  abstract finish(): Promise<void>;
  abstract cancel(): void;
}

/** Existing Qwen3-TTS/Qwen-TTS Realtime session protocol. */
class RealtimeSessionTtsTransport extends BaseTtsTransport {
  private ws?: WebSocket;
  private openPromise?: Promise<void>;
  private configurePromise?: Promise<void>;
  private created = false;
  private ready = false;
  private closed = false;
  private openResolve?: () => void;
  private openReject?: (error: Error) => void;
  private configureResolve?: () => void;
  private configureReject?: (error: Error) => void;
  private finishPromise?: Promise<void>;
  private finishResolve?: () => void;
  private finishedEmitted = false;

  constructor(private readonly connection: QwenTtsPrewarmConfig) {
    super();
  }

  open(): Promise<void> {
    if (this.created && !this.closed) return Promise.resolve();
    if (this.openPromise) return this.openPromise;
    this.openPromise = new Promise<void>((resolve, reject) => {
      this.openResolve = resolve;
      this.openReject = reject;
      const ws = new WebSocket(resolveTtsWebSocketUrl(this.connection.baseUrl, this.connection.model), {
        headers: buildHeaders(this.connection),
        perMessageDeflate: false,
      });
      this.ws = ws;

      ws.on("message", (raw, isBinary) => {
        if (isBinary) return;
        try {
          const event = JSON.parse(raw.toString()) as Record<string, unknown>;
          const type = event.type;
          if (type === "session.created") {
            this.created = true;
            this.openResolve?.();
            this.openResolve = undefined;
            this.openReject = undefined;
            return;
          }
          if (type === "session.updated") {
            this.ready = true;
            this.configureResolve?.();
            this.configureResolve = undefined;
            this.configureReject = undefined;
            return;
          }
          if (type === "response.audio.delta") {
            const delta = typeof event.delta === "string" ? event.delta : "";
            if (delta) this.emit("audio", Buffer.from(delta, "base64"));
            return;
          }
          if (type === "session.finished") {
            this.resolveFinished();
            this.shutdownSocket();
            return;
          }
          if (type === "error") {
            const detail = event.error as { message?: string; code?: string } | undefined;
            this.fail(new Error(`千问 TTS 错误${detail?.code ? `(${detail.code})` : ""}：${detail?.message ?? "未知错误"}`));
          }
        } catch (error) {
          this.fail(asError(error));
        }
      });

      ws.on("error", (error) => this.fail(error));
      ws.on("close", () => {
        const wasReady = this.ready;
        this.closed = true;
        this.ready = false;
        this.ws = undefined;
        if (!this.created) this.openReject?.(new Error("千问 TTS WebSocket 在 session.created 前关闭"));
        if (this.configurePromise && !wasReady) this.configureReject?.(new Error("千问 TTS WebSocket 在初始化完成前关闭"));
        this.resolveFinished();
      });
    });
    return this.openPromise;
  }

  configure(config: QwenTtsConfig, instructions: string): Promise<void> {
    if (this.ready && !this.closed) return Promise.resolve();
    if (this.configurePromise) return this.configurePromise;
    this.configurePromise = (async () => {
      await this.open();
      await new Promise<void>((resolve, reject) => {
        this.configureResolve = resolve;
        this.configureReject = reject;
        this.send({
          event_id: randomUUID(),
          type: "session.update",
          session: {
            voice: config.voice,
            mode: "server_commit",
            language_type: config.language,
            response_format: "pcm",
            sample_rate: config.sampleRate,
            instructions,
            optimize_instructions: config.optimizeInstructions,
          },
        });
      });
    })();
    return this.configurePromise;
  }

  appendText(text: string): void {
    if (!this.ready || !text) return;
    this.send({ event_id: randomUUID(), type: "input_text_buffer.append", text });
  }

  async finish(): Promise<void> {
    if (this.closed) return;
    this.finishPromise ??= new Promise<void>((resolve) => {
      this.finishResolve = resolve;
    });
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({ event_id: randomUUID(), type: "session.finish" });
    } else {
      this.resolveFinished();
    }
    await this.finishPromise;
  }

  cancel(): void {
    this.shutdownSocket();
    this.resolveFinished();
  }

  private fail(error: Error): void {
    this.openReject?.(error);
    this.configureReject?.(error);
    this.emit("error", error);
  }

  private resolveFinished(): void {
    this.finishResolve?.();
    this.finishResolve = undefined;
    if (!this.finishedEmitted) {
      this.finishedEmitted = true;
      this.emit("finished");
    }
  }

  private shutdownSocket(): void {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    const ws = this.ws;
    this.ws = undefined;
    if (!ws) return;
    try { ws.close(); } catch { /* ignore */ }
  }

  private send(payload: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }
}

/** Qwen-Audio-TTS/CosyVoice duplex inference protocol. */
class InferenceTaskTtsTransport extends BaseTtsTransport {
  private ws?: WebSocket;
  private openPromise?: Promise<void>;
  private configurePromise?: Promise<void>;
  private taskId?: string;
  private taskStarted = false;
  private cancelled = false;
  private closed = false;
  private configureResolve?: () => void;
  private configureReject?: (error: Error) => void;
  private finishPromise?: Promise<void>;
  private finishResolve?: () => void;
  private finishedEmitted = false;

  constructor(private readonly connection: QwenTtsPrewarmConfig) {
    super();
  }

  open(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN && !this.closed) return Promise.resolve();
    if (this.openPromise) return this.openPromise;
    this.openPromise = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(resolveTtsWebSocketUrl(this.connection.baseUrl, this.connection.model), {
        headers: buildHeaders(this.connection),
        perMessageDeflate: false,
      });
      this.ws = ws;
      ws.once("open", resolve);
      ws.once("error", reject);

      ws.on("message", (raw, isBinary) => {
        if (isBinary) {
          if (!this.cancelled) this.emit("audio", Buffer.from(raw as Buffer));
          return;
        }
        try {
          const event = JSON.parse(raw.toString()) as {
            header?: {
              event?: string;
              task_id?: string;
              error_code?: string;
              error_message?: string;
            };
          };
          const header = event.header;
          if (header?.task_id && this.taskId && header.task_id !== this.taskId) return;
          if (header?.event === "task-started") {
            this.taskStarted = true;
            this.configureResolve?.();
            this.configureResolve = undefined;
            this.configureReject = undefined;
            return;
          }
          if (header?.event === "task-finished") {
            this.resolveFinished();
            this.shutdownSocket();
            return;
          }
          if (header?.event === "task-failed") {
            this.fail(new Error(`千问 Qwen-Audio-TTS 错误${header.error_code ? `(${header.error_code})` : ""}：${header.error_message ?? "未知错误"}`));
          }
        } catch (error) {
          this.fail(asError(error));
        }
      });

      ws.on("error", (error) => {
        if (!this.closed && !this.cancelled) this.fail(error);
      });
      ws.on("close", () => {
        const started = this.taskStarted;
        this.closed = true;
        this.ws = undefined;
        if (this.configurePromise && !started && !this.cancelled) {
          this.configureReject?.(new Error("Qwen-Audio-TTS WebSocket 在 task-started 前关闭"));
        }
        this.resolveFinished();
      });
    });
    return this.openPromise;
  }

  configure(config: QwenTtsConfig, instructions: string): Promise<void> {
    if (this.taskStarted && !this.closed) return Promise.resolve();
    if (this.configurePromise) return this.configurePromise;
    this.configurePromise = (async () => {
      await this.open();
      const taskId = randomUUID();
      this.taskId = taskId;
      this.cancelled = false;
      await new Promise<void>((resolve, reject) => {
        this.configureResolve = resolve;
        this.configureReject = reject;
        this.send({
          header: { action: "run-task", task_id: taskId, streaming: "duplex" },
          payload: {
            task_group: "audio",
            task: "tts",
            function: "SpeechSynthesizer",
            model: config.model,
            parameters: buildInferenceTtsParameters(config, instructions),
            input: {},
          },
        });
      });
    })();
    return this.configurePromise;
  }

  appendText(text: string): void {
    if (!this.taskStarted || this.cancelled || !text.trim() || !this.taskId) return;
    this.send({
      header: { action: "continue-task", task_id: this.taskId, streaming: "duplex" },
      payload: { input: { text } },
    });
  }

  async finish(): Promise<void> {
    if (this.closed || this.cancelled || !this.taskId) return;
    this.finishPromise ??= new Promise<void>((resolve) => {
      this.finishResolve = resolve;
    });
    this.send({
      header: { action: "finish-task", task_id: this.taskId, streaming: "duplex" },
      payload: { input: {} },
    });
    await this.finishPromise;
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    if (this.taskId && this.ws?.readyState === WebSocket.OPEN) {
      this.send({
        header: { action: "finish-task", task_id: this.taskId, streaming: "duplex" },
        payload: { input: { directive: "cancel" } },
      });
      const timer = setTimeout(() => this.shutdownSocket(), 500);
      timer.unref?.();
    } else {
      this.shutdownSocket();
    }
    this.resolveFinished();
  }

  private fail(error: Error): void {
    this.configureReject?.(error);
    this.emit("error", error);
    this.shutdownSocket();
    this.resolveFinished();
  }

  private resolveFinished(): void {
    this.finishResolve?.();
    this.finishResolve = undefined;
    if (!this.finishedEmitted) {
      this.finishedEmitted = true;
      this.emit("finished");
    }
  }

  private shutdownSocket(): void {
    if (this.closed) return;
    this.closed = true;
    this.taskStarted = false;
    const ws = this.ws;
    this.ws = undefined;
    if (!ws) return;
    try { ws.close(); } catch { /* ignore */ }
  }

  private send(payload: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }
}

export class QwenTtsRealtimeClient extends EventEmitter<QwenTtsEvents> {
  private transport?: BaseTtsTransport;
  private connectPromise?: Promise<void>;
  private finished = false;
  private selectionRecorded = false;
  private readonly traceId = randomUUID();

  constructor(
    private readonly config: QwenTtsConfig,
    private readonly instructions: string,
  ) {
    super();
  }

  static async prewarm(config: QwenTtsPrewarmConfig): Promise<void> {
    if (!config.apiKey.trim()) return;
    const key = poolKey(config);
    const existing = warmPool.get(key);
    if (existing) return existing.transport.open();
    const transport = createTransport(config);
    const timer = setTimeout(() => {
      const current = warmPool.get(key);
      if (current?.transport !== transport) return;
      warmPool.delete(key);
      transport.cancel();
    }, PREWARM_TTL_MS);
    timer.unref?.();
    warmPool.set(key, { transport, timer });
    try {
      await transport.open();
    } catch (error) {
      const current = warmPool.get(key);
      if (current?.transport === transport) {
        clearTimeout(current.timer);
        warmPool.delete(key);
      }
      transport.cancel();
      throw error;
    }
  }

  static cancelPrewarm(config: QwenTtsPrewarmConfig): void {
    const key = poolKey(config);
    const entry = warmPool.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    warmPool.delete(key);
    entry.transport.cancel();
  }

  async connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connectWithInstructionFallback();
    return this.connectPromise;
  }

  appendText(text: string): void {
    this.transport?.appendText(text);
  }

  async finish(): Promise<void> {
    if (this.finished) return;
    await this.transport?.finish();
    this.finished = true;
  }

  cancel(): void {
    if (this.finished) return;
    const protocolFamily = resolveTtsProtocol(this.config.model);
    recordGlobalRealtimeEvent({
      level: "info",
      category: "tts",
      event: "tts.cancel.requested",
      engine: "cascaded",
      data: {
        traceId: this.traceId,
        model: this.config.model,
        voice: this.config.voice,
        protocolFamily,
        cancelMethodRequested: protocolFamily === "dashscope_inference" ? "finish_task_cancel" : "socket_close",
        transportCreated: Boolean(this.transport),
      },
    });
    this.finished = true;
    this.transport?.cancel();
    this.transport = undefined;
  }

  private async connectWithInstructionFallback(): Promise<void> {
    const connection = connectionConfig(this.config);
    const protocol = resolveTtsProtocol(this.config.model);
    const plan = planQwenTtsInstruction(this.instructions);
    const primaryInstruction = protocol === "dashscope_inference" ? plan.instruction : this.instructions.trim();
    this.recordSelection(plan, primaryInstruction);

    let transport = takeWarmTransport(connection) ?? createTransport(connection);
    try {
      await this.configureTransport(transport, primaryInstruction);
    } catch (error) {
      const firstError = asError(error);
      transport.cancel();
      if (protocol !== "dashscope_inference" || !primaryInstruction || !isInvalidInstructionError(firstError)) {
        throw firstError;
      }

      recordGlobalRealtimeEvent({
        level: "warn",
        category: "tts",
        event: "tts.instruction.fallback",
        engine: "cascaded",
        data: {
          traceId: this.traceId,
          model: this.config.model,
          voice: this.config.voice,
          reason: "instruction_invalid",
          retryAttempt: 1,
          fallbackInstructionConfigured: false,
          instructionProfile: plan.profile,
          instructionWeightedChars: plan.finalWeightedChars,
        },
      });

      transport = createTransport(connection);
      await this.configureTransport(transport, "");
    }

    this.transport = transport;
    this.bindTransport(transport);
  }

  private async configureTransport(transport: BaseTtsTransport, instructions: string): Promise<void> {
    let emittedError: Error | undefined;
    const captureError = (error: Error) => {
      emittedError = error;
    };
    transport.on("error", captureError);
    try {
      await transport.configure(this.config, instructions);
    } catch (error) {
      throw emittedError ?? asError(error);
    } finally {
      transport.off("error", captureError);
    }
  }

  private bindTransport(transport: BaseTtsTransport): void {
    transport.on("audio", (audio) => this.emit("audio", audio));
    transport.on("error", (error) => this.emit("error", error));
    transport.on("finished", () => {
      if (this.finished) return;
      this.finished = true;
      this.emit("finished");
    });
  }

  private recordSelection(plan: QwenTtsInstructionPlan, effectiveInstruction: string): void {
    if (this.selectionRecorded) return;
    this.selectionRecorded = true;
    const prosody = resolveTtsProsody(this.instructions);
    recordGlobalRealtimeEvent({
      level: "info",
      category: "tts",
      event: "tts.session.selected",
      engine: "cascaded",
      data: {
        traceId: this.traceId,
        model: this.config.model,
        voice: this.config.voice,
        protocolFamily: resolveTtsProtocol(this.config.model),
        language: this.config.language,
        sampleRate: this.config.sampleRate,
        optimizeInstructions: this.config.optimizeInstructions,
        instructionConfigured: Boolean(effectiveInstruction),
        instructionChars: effectiveInstruction.length,
        instructionRawChars: plan.rawChars,
        instructionRawWeightedChars: plan.rawWeightedChars,
        instructionWeightedChars: instructionWeightedLength(effectiveInstruction),
        instructionShortened: plan.shortened,
        instructionProfile: plan.profile,
        instructionHash: effectiveInstruction
          ? createHash("sha256").update(effectiveInstruction).digest("hex").slice(0, 12)
          : undefined,
        emotionStyle: prosody.style,
        prosodyRate: prosody.rate,
        prosodyPitch: prosody.pitch,
        prosodyVolume: prosody.volume,
        numericProsodyApplied: resolveTtsProtocol(this.config.model) === "dashscope_inference",
        compatibilityProfile: "safe_instruction_v3",
      },
    });
  }
}

export function isQwenAudioTtsModel(model: string): boolean {
  return model.trim().toLowerCase().startsWith("qwen-audio-") && model.toLowerCase().includes("-tts-");
}

export function resolveTtsProtocol(model: string): QwenTtsProtocol {
  return isQwenAudioTtsModel(model) || model.trim().toLowerCase().startsWith("cosyvoice-")
    ? "dashscope_inference"
    : "qwen_realtime";
}

export function resolveTtsWebSocketUrl(baseUrl: string, model: string): string {
  const url = new URL(baseUrl);
  if (resolveTtsProtocol(model) === "dashscope_inference") {
    url.pathname = url.pathname.replace(
      /\/api-ws\/v1\/(?:realtime|inference)\/?$/u,
      "/api-ws/v1/inference",
    );
    if (!/\/api-ws\/v1\/inference$/u.test(url.pathname)) url.pathname = "/api-ws/v1/inference";
    url.search = "";
  } else {
    url.searchParams.set("model", model);
  }
  return url.toString();
}

export function classifyTtsInstructionStyle(instructions: string): string {
  const value = instructions.trim();
  if (!value) return "none";
  if (/(?:温暖|轻柔|陪伴|柔和、真诚)/u.test(value)) return "warm_support";
  if (/(?:安心|安全感|稳定、安心)/u.test(value)) return "reassuring";
  if (/(?:自然开心|轻快|笑意|灵动)/u.test(value)) return "bright_playful";
  if (/(?:惊喜|好奇)/u.test(value)) return "curious_surprised";
  if (/(?:冷静|克制|不与对方对抗)/u.test(value)) return "grounded_calm";
  if (/(?:专注|清晰、可靠)/u.test(value)) return "focused";
  if (/(?:平和|呼吸感|反思)/u.test(value)) return "reflective_soft";
  if (/(?:有参与感|有精神|活力)/u.test(value)) return "engaged_lively";
  return "natural";
}

export function instructionWeightedLength(value: string): number {
  let total = 0;
  for (const character of value) {
    total += /[\u3400-\u9fff\uf900-\ufaff]/u.test(character) ? 2 : 1;
  }
  return total;
}

export function planQwenTtsInstruction(rawInstructions: string): QwenTtsInstructionPlan {
  const raw = rawInstructions.trim();
  const profile = classifyTtsInstructionStyle(raw);
  const candidate = raw ? SAFE_INSTRUCTION_BY_STYLE[profile] ?? SAFE_INSTRUCTION_BY_STYLE.natural! : "";
  const instruction = instructionWeightedLength(candidate) <= QWEN_INSTRUCTION_SAFE_WEIGHT
    ? candidate
    : trimInstructionByWeight(candidate, QWEN_INSTRUCTION_SAFE_WEIGHT);
  return {
    rawChars: raw.length,
    rawWeightedChars: instructionWeightedLength(raw),
    finalChars: instruction.length,
    finalWeightedChars: instructionWeightedLength(instruction),
    instruction,
    profile,
    shortened: raw !== instruction,
  };
}

export function resolveTtsProsody(instructions: string): QwenTtsProsody {
  const style = classifyTtsInstructionStyle(instructions);
  const profiles: Record<string, Omit<QwenTtsProsody, "style">> = {
    none: { volume: 50, rate: 1, pitch: 1 },
    natural: { volume: 50, rate: 1, pitch: 1 },
    warm_support: { volume: 48, rate: 0.9, pitch: 1 },
    reassuring: { volume: 48, rate: 0.9, pitch: 1 },
    bright_playful: { volume: 53, rate: 1.1, pitch: 1 },
    curious_surprised: { volume: 52, rate: 1, pitch: 1.1 },
    grounded_calm: { volume: 49, rate: 0.9, pitch: 1 },
    focused: { volume: 52, rate: 1, pitch: 1 },
    reflective_soft: { volume: 48, rate: 0.9, pitch: 1 },
    engaged_lively: { volume: 52, rate: 1.1, pitch: 1 },
  };
  const base = profiles[style] ?? profiles.natural!;
  return {
    style,
    volume: clamp(Math.round(base.volume), 0, 100),
    rate: round(clamp(base.rate, 0.5, 2), 1),
    pitch: round(clamp(base.pitch, 0.5, 2), 1),
  };
}

export function buildInferenceTtsParameters(
  config: Pick<QwenTtsConfig, "voice" | "sampleRate" | "language">,
  instructions: string,
): QwenTtsInferenceParameters {
  const plan = planQwenTtsInstruction(instructions);
  const prosody = plan.instruction ? resolveTtsProsody(instructions) : resolveTtsProsody("");
  return {
    text_type: "PlainText",
    voice: config.voice,
    format: "pcm",
    sample_rate: config.sampleRate,
    volume: prosody.volume,
    rate: prosody.rate,
    pitch: prosody.pitch,
    enable_ssml: false,
    language_hints: [normalizeInferenceLanguage(config.language)],
    ...(plan.instruction ? { instruction: plan.instruction } : {}),
  };
}

export function isInvalidInstructionError(error: unknown): boolean {
  const message = asError(error).message.toLowerCase();
  return message.includes("instruction is invalid") ||
    (message.includes("invalidparameter") && message.includes("instruction"));
}

function createTransport(config: QwenTtsPrewarmConfig): BaseTtsTransport {
  return resolveTtsProtocol(config.model) === "dashscope_inference"
    ? new InferenceTaskTtsTransport(config)
    : new RealtimeSessionTtsTransport(config);
}

function takeWarmTransport(config: QwenTtsPrewarmConfig): BaseTtsTransport | undefined {
  const key = poolKey(config);
  const warm = warmPool.get(key);
  if (!warm) return undefined;
  clearTimeout(warm.timer);
  warmPool.delete(key);
  return warm.transport;
}

function connectionConfig(config: QwenTtsConfig): QwenTtsPrewarmConfig {
  return {
    apiKey: config.apiKey,
    workspaceId: config.workspaceId,
    baseUrl: config.baseUrl,
    model: config.model,
  };
}

function buildHeaders(config: QwenTtsPrewarmConfig): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    "user-agent": "aipany-realtime-gateway/0.9.0",
  };
  if (config.workspaceId) headers["X-DashScope-WorkSpace"] = config.workspaceId;
  return headers;
}

function normalizeInferenceLanguage(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (["chinese", "zh-cn", "zh_cn", "zh"].includes(normalized)) return "zh";
  if (["english", "en-us", "en_us", "en"].includes(normalized)) return "en";
  return normalized || "zh";
}

function trimInstructionByWeight(value: string, maximum: number): string {
  let result = "";
  let weight = 0;
  for (const character of value) {
    const characterWeight = /[\u3400-\u9fff\uf900-\ufaff]/u.test(character) ? 2 : 1;
    if (weight + characterWeight > maximum) break;
    result += character;
    weight += characterWeight;
  }
  return result.trim();
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function poolKey(config: QwenTtsPrewarmConfig): string {
  const secretHash = createHash("sha256").update(config.apiKey).digest("hex").slice(0, 12);
  return [resolveTtsWebSocketUrl(config.baseUrl, config.model), config.model, config.workspaceId ?? "", secretHash].join("|");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
