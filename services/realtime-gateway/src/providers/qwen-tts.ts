import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
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

interface QwenTtsEvents {
  audio: [Buffer];
  error: [Error];
  finished: [];
}

export class QwenTtsRealtimeClient extends EventEmitter<QwenTtsEvents> {
  private ws?: WebSocket;
  private ready = false;
  private finished = false;
  private finishPromise?: Promise<void>;
  private finishResolve?: () => void;

  constructor(
    private readonly config: QwenTtsConfig,
    private readonly instructions: string,
  ) {
    super();
  }

  async connect(): Promise<void> {
    const url = new URL(this.config.baseUrl);
    url.searchParams.set("model", this.config.model);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.config.apiKey}`,
        "user-agent": "aipany-realtime-gateway/0.1",
      };
      if (this.config.workspaceId) {
        headers["X-DashScope-WorkSpace"] = this.config.workspaceId;
      }

      const ws = new WebSocket(url, { headers });
      this.ws = ws;

      const fail = (error: Error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
        this.emit("error", error);
      };

      ws.on("message", (raw, isBinary) => {
        if (isBinary) return;
        try {
          const event = JSON.parse(raw.toString()) as Record<string, unknown>;
          const type = event.type;

          if (type === "session.created") {
            this.send({
              event_id: randomUUID(),
              type: "session.update",
              session: {
                voice: this.config.voice,
                mode: "server_commit",
                language_type: this.config.language,
                response_format: "pcm",
                sample_rate: this.config.sampleRate,
                instructions: this.instructions,
                optimize_instructions: this.config.optimizeInstructions,
              },
            });
            return;
          }

          if (type === "session.updated") {
            this.ready = true;
            if (!settled) {
              settled = true;
              resolve();
            }
            return;
          }

          if (type === "response.audio.delta") {
            const delta = typeof event.delta === "string" ? event.delta : "";
            if (delta) this.emit("audio", Buffer.from(delta, "base64"));
            return;
          }

          if (type === "session.finished") {
            this.resolveFinished();
            return;
          }

          if (type === "error") {
            const error = event.error as { message?: string; code?: string } | undefined;
            fail(new Error(`千问 TTS 错误${error?.code ? `(${error.code})` : ""}：${error?.message ?? "未知错误"}`));
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });

      ws.on("error", (error) => fail(error));
      ws.on("close", () => {
        this.ready = false;
        this.ws = undefined;
        if (!settled) {
          settled = true;
          reject(new Error("千问 TTS WebSocket 在初始化完成前关闭"));
        }
        this.resolveFinished();
      });
    });
  }

  appendText(text: string): void {
    if (!this.ready || !text) return;
    this.send({
      event_id: randomUUID(),
      type: "input_text_buffer.append",
      text,
    });
  }

  async finish(): Promise<void> {
    if (this.finished) return;
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
    this.ready = false;
    this.ws?.close();
    this.ws = undefined;
    this.resolveFinished();
  }

  private resolveFinished(): void {
    if (this.finished) return;
    this.finished = true;
    this.finishResolve?.();
    this.emit("finished");
  }

  private send(payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }
}
