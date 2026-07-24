import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import WebSocket from "ws";

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
const warmPool = new Map<string, WarmEntry>();

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
      const url = resolveTtsWebSocketUrl(this.connection.baseUrl, this.connection.model);
      const ws = new WebSocket(url, {
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
          this.fail(error instanceof Error ? error : new Error(String(error)));
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
    if (!this.finishPromise) {
      this.finishPromise = new Promise<void>((resolve) => {
        this.finishResolve = resolve;
      });
    }
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
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
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
      const url = resolveTtsWebSocketUrl(this.connection.baseUrl, this.connection.model);
      const ws = new WebSocket(url, {
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
          this.fail(error instanceof Error ? error : new Error(String(error)));
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
      this.taskId = randomUUID();
      this.cancelled = false;
      await new Promise<void>((resolve, reject) => {
        this.configureResolve = resolve;
        this.configureReject = reject;
        this.send({
          header: {
            action: "run-task",
            task_id: this.taskId,
            streaming: "duplex",
          },
          payload: {
            task_group: "audio",
            task: "tts",
            function: "SpeechSynthesizer",
            model: config.model,
            parameters: {
              text_type: "PlainText",
              voice: config.voice,
              format: "pcm",
              sample_rate: config.sampleRate,
              volume: 50,
              rate: 1.0,
              pitch: 1.0,
              enable_ssml: false,
              language_hints: [normalizeInferenceLanguage(config.language)],
              instruction: instructions,
            },
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
      header: {
        action: "continue-task",
        task_id: this.taskId,
        streaming: "duplex",
      },
      payload: { input: { text } },
    });
  }

  async finish(): Promise<void> {
    if (this.closed || this.cancelled || !this.taskId) return;
    this.finishPromise ??= new Promise<void>((resolve) => {
      this.finishResolve = resolve;
    });
    this.send({
      header: {
        action: "finish-task",
        task_id: this.taskId,
        streaming: "duplex",
      },
      payload: { input: {} },
    });
    await this.finishPromise;
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    if (this.taskId && this.ws?.readyState === WebSocket.OPEN) {
      this.send({
        header: {
          action: "finish-task",
          task_id: this.taskId,
          streaming: "duplex",
        },
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
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }
}

export class QwenTtsRealtimeClient extends EventEmitter<QwenTtsEvents> {
  private transport?: BaseTtsTransport;
  private connectPromise?: Promise<void>;
  private finished = false;

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
    this.connectPromise = (async () => {
      const connection = connectionConfig(this.config);
      const key = poolKey(connection);
      const warm = warmPool.get(key);
      if (warm) {
        clearTimeout(warm.timer);
        warmPool.delete(key);
        this.transport = warm.transport;
      } else {
        this.transport = createTransport(connection);
      }
      this.transport.on("audio", (audio) => this.emit("audio", audio));
      this.transport.on("error", (error) => this.emit("error", error));
      this.transport.on("finished", () => {
        if (this.finished) return;
        this.finished = true;
        this.emit("finished");
      });
      await this.transport.configure(this.config, this.instructions);
    })();
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
    this.finished = true;
    this.transport?.cancel();
    this.transport = undefined;
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
    url.pathname = url.pathname.replace(/\/api-ws\/v1\/realtime\/?$/u, "/api-ws/v1/inference/");
    if (!/\/api-ws\/v1\/inference\/?$/u.test(url.pathname)) {
      url.pathname = "/api-ws/v1/inference/";
    }
    url.search = "";
  } else {
    url.searchParams.set("model", model);
  }
  return url.toString();
}

function createTransport(config: QwenTtsPrewarmConfig): BaseTtsTransport {
  return resolveTtsProtocol(config.model) === "dashscope_inference"
    ? new InferenceTaskTtsTransport(config)
    : new RealtimeSessionTtsTransport(config);
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
    "user-agent": "aipany-realtime-gateway/0.7",
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

function poolKey(config: QwenTtsPrewarmConfig): string {
  const secretHash = createHash("sha256").update(config.apiKey).digest("hex").slice(0, 12);
  return [resolveTtsWebSocketUrl(config.baseUrl, config.model), config.model, config.workspaceId ?? "", secretHash].join("|");
}
