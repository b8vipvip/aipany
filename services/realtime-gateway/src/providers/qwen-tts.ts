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
  transport: TtsTransport;
  timer: ReturnType<typeof setTimeout>;
}

const PREWARM_TTL_MS = 20_000;
const warmPool = new Map<string, WarmEntry>();

/**
 * One upstream websocket. It can be opened before the final voice/prosody
 * instructions are known, then configured exactly once when the response starts.
 */
class TtsTransport extends EventEmitter<TtsTransportEvents> {
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

  constructor(private readonly connection: QwenTtsPrewarmConfig) {
    super();
  }

  open(): Promise<void> {
    if (this.created && !this.closed) return Promise.resolve();
    if (this.openPromise) return this.openPromise;
    this.openPromise = new Promise<void>((resolve, reject) => {
      this.openResolve = resolve;
      this.openReject = reject;
      const url = new URL(this.connection.baseUrl);
      url.searchParams.set("model", this.connection.model);
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.connection.apiKey}`,
        "user-agent": "aipany-realtime-gateway/0.6",
      };
      if (this.connection.workspaceId) headers["X-DashScope-WorkSpace"] = this.connection.workspaceId;
      const ws = new WebSocket(url, { headers, perMessageDeflate: false });
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
        this.closed = true;
        this.ready = false;
        this.ws = undefined;
        if (!this.created) this.openReject?.(new Error("千问 TTS WebSocket 在 session.created 前关闭"));
        if (this.configurePromise && !this.ready) this.configureReject?.(new Error("千问 TTS WebSocket 在初始化完成前关闭"));
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
    this.emit("finished");
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

export class QwenTtsRealtimeClient extends EventEmitter<QwenTtsEvents> {
  private transport?: TtsTransport;
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
    const transport = new TtsTransport(config);
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
        this.transport = new TtsTransport(connection);
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

function connectionConfig(config: QwenTtsConfig): QwenTtsPrewarmConfig {
  return {
    apiKey: config.apiKey,
    workspaceId: config.workspaceId,
    baseUrl: config.baseUrl,
    model: config.model,
  };
}

function poolKey(config: QwenTtsPrewarmConfig): string {
  const secretHash = createHash("sha256").update(config.apiKey).digest("hex").slice(0, 12);
  return [config.baseUrl, config.model, config.workspaceId ?? "", secretHash].join("|");
}
