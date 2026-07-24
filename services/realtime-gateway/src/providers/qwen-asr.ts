import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { UserEmotion } from "@aipany/protocol";
import { recordGlobalRealtimeEvent } from "../observability/global-observability.js";
import { AsrCommitGuard } from "./asr-commit-guard.js";

export interface QwenAsrConfig {
  apiKey: string;
  workspaceId?: string;
  baseUrl: string;
  model: string;
  language: string;
  vadThreshold: number;
  silenceMs: number;
}

export interface AsrPartialResult {
  text: string;
  emotion: UserEmotion;
  language?: string;
}

export interface AsrFinalResult extends AsrPartialResult {}

interface QwenAsrEvents {
  ready: [];
  speechStarted: [];
  speechStopped: [];
  partial: [AsrPartialResult];
  final: [AsrFinalResult];
  error: [Error];
  closed: [];
}

export class QwenAsrRealtimeClient extends EventEmitter<QwenAsrEvents> {
  private ws?: WebSocket;
  private ready = false;
  private readonly commitGuard = new AsrCommitGuard();
  private readonly traceId = randomUUID();

  constructor(private readonly config: QwenAsrConfig) {
    super();
  }

  async connect(): Promise<void> {
    if (this.ws) return;

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
        this.commitGuard.resolve();
        if (!settled) {
          settled = true;
          reject(error);
        }
        this.emit("error", error);
      };

      ws.once("open", () => {
        this.send({
          event_id: randomUUID(),
          type: "session.update",
          session: {
            input_audio_format: "pcm",
            sample_rate: 16000,
            input_audio_transcription: {
              language: this.config.language,
            },
            turn_detection: {
              type: "server_vad",
              threshold: this.config.vadThreshold,
              silence_duration_ms: this.config.silenceMs,
            },
          },
        });
      });

      ws.on("message", (raw, isBinary) => {
        if (isBinary) return;
        try {
          const event = JSON.parse(raw.toString()) as Record<string, unknown>;
          const type = event.type;

          if (type === "session.updated") {
            this.ready = true;
            this.commitGuard.reset();
            if (!settled) {
              settled = true;
              resolve();
            }
            this.emit("ready");
            return;
          }

          if (type === "input_audio_buffer.speech_started") {
            this.commitGuard.markServerSpeechStarted();
            this.emit("speechStarted");
            return;
          }

          if (type === "input_audio_buffer.speech_stopped") {
            this.emit("speechStopped");
            return;
          }

          if (type === "conversation.item.input_audio_transcription.text") {
            const text = typeof event.text === "string" ? event.text : "";
            const stash = typeof event.stash === "string" ? event.stash : "";
            const combined = `${text}${stash}`;
            this.commitGuard.markPartial(combined);
            this.emit("partial", {
              text: combined,
              emotion: normalizeEmotion(event.emotion),
              language: typeof event.language === "string" ? event.language : undefined,
            });
            return;
          }

          if (type === "conversation.item.input_audio_transcription.completed") {
            this.commitGuard.resolve();
            this.emit("final", {
              text: typeof event.transcript === "string" ? event.transcript.trim() : "",
              emotion: normalizeEmotion(event.emotion),
              language: typeof event.language === "string" ? event.language : undefined,
            });
            return;
          }

          if (type === "conversation.item.input_audio_transcription.failed") {
            const error = event.error as { message?: string } | undefined;
            fail(new Error(error?.message ?? "千问 ASR 识别失败"));
            return;
          }

          if (type === "error") {
            const error = event.error as { message?: string; code?: string } | undefined;
            fail(new Error(`千问 ASR 错误${error?.code ? `(${error.code})` : ""}：${error?.message ?? "未知错误"}`));
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });

      ws.on("error", (error) => fail(error));
      ws.on("close", () => {
        this.ready = false;
        this.ws = undefined;
        this.commitGuard.reset();
        if (!settled) {
          settled = true;
          reject(new Error("千问 ASR WebSocket 在初始化完成前关闭"));
        }
        this.emit("closed");
      });
    });
  }

  appendAudio(audio: Buffer): void {
    if (!this.ready) return;
    this.commitGuard.observeAudio(audio);
    this.send({
      event_id: randomUUID(),
      type: "input_audio_buffer.append",
      audio: audio.toString("base64"),
    });
  }

  commit(): boolean {
    if (!this.ready) return false;
    const decision = this.commitGuard.tryCommit();
    if (!decision.allowed) {
      recordGlobalRealtimeEvent({
        level: "info",
        category: "asr",
        event: "asr.commit.suppressed",
        engine: "cascaded",
        data: {
          traceId: this.traceId,
          model: this.config.model,
          reason: decision.reason,
          speechLikeMs: decision.speechLikeMs,
          serverSpeechEvidence: decision.serverSpeechEvidence,
        },
      });
      return false;
    }
    this.send({ event_id: randomUUID(), type: "input_audio_buffer.commit" });
    return true;
  }

  finish(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.send({ event_id: randomUUID(), type: "session.finish" });
  }

  close(): void {
    const ws = this.ws;
    this.ws = undefined;
    this.ready = false;
    this.commitGuard.reset();
    if (!ws) return;
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ event_id: randomUUID(), type: "session.finish" }));
      } catch {
        // ignore
      }
    }
    ws.close();
  }

  private send(payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }
}

function normalizeEmotion(value: unknown): UserEmotion {
  switch (value) {
    case "surprised":
    case "neutral":
    case "happy":
    case "sad":
    case "disgusted":
    case "angry":
    case "fearful":
      return value;
    default:
      return "unknown";
  }
}
