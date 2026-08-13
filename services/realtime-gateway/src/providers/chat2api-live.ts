import { EventEmitter } from "node:events";
import WebSocket from "ws";

export interface Chat2ApiLiveConfig {
  apiKey: string;
  baseUrl: string;
  model: "gpt-live" | "gpt-live-mini" | string;
  clientId?: string;
  instructions: string;
}

interface Chat2ApiLiveEvents {
  ready: [];
  speechStarted: [];
  speechStopped: [];
  transcriptDelta: [text: string];
  transcriptFinal: [text: string];
  responseCreated: [responseId: string];
  textDelta: [responseId: string, delta: string];
  audio: [responseId: string, audio: Buffer];
  audioDone: [responseId: string];
  responseDone: [responseId: string, text: string, status?: string];
  interrupted: [responseId: string, reason: string];
  error: [error: Error];
  close: [code: number, reason: string];
}

const LIVE_INPUT_FRAME_BYTES = 1280; // 40 ms PCM16 mono @ 16 kHz
const LIVE_STARTUP_TIMEOUT_MS = 20_000;
const LIVE_HEARTBEAT_INTERVAL_MS = 15_000;
const LIVE_HEARTBEAT_TIMEOUT_MS = 45_000;

/**
 * Native speech-to-speech bridge backed by the user's chat2api browser service.
 * Aipany sends binary PCM16/16 kHz and receives binary PCM16/24 kHz while the
 * browser-side bridge keeps one ChatGPT Voice session open continuously.
 */
export class Chat2ApiLiveClient extends EventEmitter<Chat2ApiLiveEvents> {
  private ws?: WebSocket;
  private connectPromise?: Promise<void>;
  private ready = false;
  private closed = false;
  private currentResponseId?: string;
  private readonly responseText = new Map<string, string>();
  private inputBuffer = Buffer.alloc(0);
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private lastPongAt = 0;

  constructor(private readonly config: Chat2ApiLiveConfig) {
    super();
  }

  connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const url = buildLiveUrl(this.config.baseUrl, this.config.clientId);
      let settled = false;
      let startupTimer: ReturnType<typeof setTimeout> | undefined;
      const ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "user-agent": "aipany-realtime-gateway/0.5 chat2api-live",
        },
        perMessageDeflate: false,
      });
      this.ws = ws;

      const clearStartupTimer = () => {
        if (!startupTimer) return;
        clearTimeout(startupTimer);
        startupTimer = undefined;
      };

      const failBeforeReady = (error: Error) => {
        if (!settled) {
          settled = true;
          clearStartupTimer();
          reject(error);
          this.emit("error", error);
          return;
        }
        this.emit("error", error);
      };

      startupTimer = setTimeout(() => {
        if (settled || this.ready || this.closed) return;
        const error = new Error(`Chat2API GPT-Live 启动超时（>${LIVE_STARTUP_TIMEOUT_MS / 1000}s）`);
        failBeforeReady(error);
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(1011, "chat2api live startup timeout");
        }
      }, LIVE_STARTUP_TIMEOUT_MS);
      startupTimer.unref();

      ws.on("open", () => {
        this.send({
          type: "session.start",
          model: this.config.model,
          client_id: this.config.clientId,
          instructions: this.config.instructions,
          input_audio: { encoding: "pcm_s16le", sample_rate: 16000, channels: 1 },
          output_audio: { encoding: "pcm_s16le", sample_rate: 24000, channels: 1 },
        });
      });

      ws.on("message", (raw, isBinary) => {
        if (isBinary) {
          const responseId = this.currentResponseId;
          if (responseId) this.emit("audio", responseId, Buffer.from(raw as Buffer));
          return;
        }
        try {
          const event = JSON.parse(raw.toString()) as Record<string, unknown>;
          const type = stringValue(event.type);
          if (type === "session.ready") {
            this.ready = true;
            this.lastPongAt = Date.now();
            clearStartupTimer();
            this.startHeartbeat();
            if (!settled) {
              settled = true;
              resolve();
            }
            this.emit("ready");
            return;
          }
          if (type === "session.closed") {
            this.ready = false;
            this.stopHeartbeat();
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
              ws.close(1012, "chat2api live upstream session closed");
            }
            return;
          }
          if (type === "pong") {
            this.lastPongAt = Date.now();
            return;
          }
          if (type === "input_audio_buffer.speech_started") {
            this.emit("speechStarted");
            return;
          }
          if (type === "input_audio_buffer.speech_stopped") {
            this.emit("speechStopped");
            return;
          }
          if (type === "transcript.partial") {
            const text = stringValue(event.text);
            if (text) this.emit("transcriptDelta", text);
            return;
          }
          if (type === "transcript.final") {
            const text = stringValue(event.text);
            if (text) this.emit("transcriptFinal", text);
            return;
          }
          if (type === "response.created") {
            const responseId = stringValue(event.response_id) || stringValue(event.responseId);
            if (!responseId) return;
            this.currentResponseId = responseId;
            this.responseText.set(responseId, "");
            this.emit("responseCreated", responseId);
            return;
          }
          if (type === "response.text.delta") {
            const responseId = stringValue(event.response_id) || this.currentResponseId;
            const delta = stringValue(event.delta);
            if (!responseId || !delta) return;
            this.responseText.set(responseId, `${this.responseText.get(responseId) ?? ""}${delta}`);
            this.emit("textDelta", responseId, delta);
            return;
          }
          if (type === "response.audio.started") {
            const responseId = stringValue(event.response_id) || this.currentResponseId;
            if (responseId) this.currentResponseId = responseId;
            return;
          }
          if (type === "response.audio.done") {
            const responseId = stringValue(event.response_id) || this.currentResponseId;
            if (responseId) this.emit("audioDone", responseId);
            return;
          }
          if (type === "response.interrupted") {
            const responseId = stringValue(event.response_id) || this.currentResponseId;
            if (!responseId) return;
            this.emit("interrupted", responseId, stringValue(event.reason) || "barge_in");
            if (this.currentResponseId === responseId) this.currentResponseId = undefined;
            return;
          }
          if (type === "response.done") {
            const responseId = stringValue(event.response_id) || this.currentResponseId;
            if (!responseId) return;
            const text = stringValue(event.text) || this.responseText.get(responseId) || "";
            this.responseText.delete(responseId);
            if (this.currentResponseId === responseId) this.currentResponseId = undefined;
            this.emit("responseDone", responseId, text, "completed");
            return;
          }
          if (type === "error") {
            const code = stringValue(event.code);
            const message = stringValue(event.message) || "未知错误";
            const error = new Error(`Chat2API GPT-Live 错误${code ? `(${code})` : ""}：${message}`);
            if (!this.ready && !settled) {
              failBeforeReady(error);
              if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                ws.close(1011, "chat2api live startup error");
              }
            } else {
              this.emit("error", error);
            }
            return;
          }
        } catch (error) {
          const normalized = error instanceof Error ? error : new Error(String(error));
          if (!this.ready && !settled) failBeforeReady(normalized);
          else this.emit("error", normalized);
        }
      });

      ws.on("error", (error) => failBeforeReady(error));
      ws.on("close", (code, reason) => {
        clearStartupTimer();
        this.stopHeartbeat();
        this.ready = false;
        this.ws = undefined;
        this.inputBuffer = Buffer.alloc(0);
        if (!settled) {
          settled = true;
          reject(new Error(`Chat2API GPT-Live 在初始化前关闭：${code} ${reason.toString()}`.trim()));
        }
        if (!this.closed) this.emit("close", code, reason.toString());
      });
    });
    return this.connectPromise;
  }

  appendAudio(audio: Buffer): void {
    if (!this.ready || this.closed || audio.length === 0) return;
    this.inputBuffer = this.inputBuffer.length ? Buffer.concat([this.inputBuffer, audio]) : Buffer.from(audio);
    while (this.inputBuffer.length >= LIVE_INPUT_FRAME_BYTES) {
      const frame = this.inputBuffer.subarray(0, LIVE_INPUT_FRAME_BYTES);
      this.inputBuffer = this.inputBuffer.subarray(LIVE_INPUT_FRAME_BYTES);
      this.sendBinary(frame);
    }
  }

  commitTurn(): void {
    // GPT-Live uses the ChatGPT Voice session's own turn detection. Flush only a
    // partial local frame so an explicit client endpoint hint never strands PCM.
    this.flushInput();
  }

  requestTextResponse(_text: string): boolean {
    return false;
  }

  cancelResponse(): void {
    if (!this.ready) return;
    this.send({ type: "response.cancel" });
  }

  updateInstructions(_instructions: string): void {
    // The browser bridge currently binds instructions when the Voice session is opened.
  }

  close(): void {
    if (this.closed) return;
    this.flushInput();
    this.closed = true;
    this.ready = false;
    this.stopHeartbeat();
    this.send({ type: "session.finish" });
    this.ws?.close(1000, "session finished");
    this.ws = undefined;
    this.inputBuffer = Buffer.alloc(0);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastPongAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      const ws = this.ws;
      if (this.closed || !this.ready || !ws || ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastPongAt > LIVE_HEARTBEAT_TIMEOUT_MS) {
        this.ready = false;
        ws.close(1012, "chat2api live heartbeat timeout");
        return;
      }
      this.send({ type: "ping", timestamp: Date.now() });
    }, LIVE_HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private flushInput(): void {
    if (!this.inputBuffer.length) return;
    const frame = this.inputBuffer;
    this.inputBuffer = Buffer.alloc(0);
    this.sendBinary(frame);
  }

  private sendBinary(audio: Buffer): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(audio, { binary: true });
    return true;
  }

  private send(payload: Record<string, unknown>): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(payload));
    return true;
  }
}

export function buildLiveUrl(baseUrl: string, clientId?: string): string {
  const url = new URL(baseUrl.trim());
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("Chat2API Live Base URL 必须使用 http(s) 或 ws(s)");
  }
  const cleanPath = url.pathname.replace(/\/+$/, "");
  if (!cleanPath.endsWith("/v1/audio/realtime")) {
    url.pathname = `${cleanPath}/v1/audio/realtime`.replace(/\/+/g, "/");
  }
  if (clientId?.trim()) url.searchParams.set("client_id", clientId.trim());
  return url.toString();
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
