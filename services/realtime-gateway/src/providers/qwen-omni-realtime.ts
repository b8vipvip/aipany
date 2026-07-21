import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import WebSocket from "ws";

export interface QwenOmniRealtimeConfig {
  apiKey: string;
  workspaceId?: string;
  baseUrl: string;
  model: string;
  voice: string;
  instructions: string;
  turnDetection: "server_vad" | "semantic_vad";
  vadThreshold: number;
  silenceMs: number;
}

interface QwenOmniRealtimeEvents {
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

/**
 * Thin server-side bridge to Qwen-Omni-Realtime.
 *
 * The mobile client keeps speaking to Aipany's stable binary-PCM WebSocket
 * protocol while this provider converts the stream to the JSON/base64 event
 * format used by the upstream native speech-to-speech service.
 */
export class QwenOmniRealtimeClient extends EventEmitter<QwenOmniRealtimeEvents> {
  private ws?: WebSocket;
  private ready = false;
  private closed = false;
  private responding = false;
  private currentResponseId?: string;
  private readonly responseText = new Map<string, string>();
  private audioBuffer = Buffer.alloc(0);
  private connectPromise?: Promise<void>;

  constructor(private readonly config: QwenOmniRealtimeConfig) {
    super();
  }

  connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const url = new URL(this.config.baseUrl);
      url.searchParams.set("model", this.config.model);
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.config.apiKey}`,
        "user-agent": "aipany-realtime-gateway/0.5",
      };
      if (this.config.workspaceId) headers["X-DashScope-WorkSpace"] = this.config.workspaceId;

      let settled = false;
      const ws = new WebSocket(url, { headers, perMessageDeflate: false });
      this.ws = ws;

      const failBeforeReady = (error: Error) => {
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
          const type = typeof event.type === "string" ? event.type : "";

          if (type === "session.created") {
            this.send({
              event_id: randomUUID(),
              type: "session.update",
              session: {
                modalities: ["text", "audio"],
                voice: this.config.voice,
                input_audio_format: "pcm",
                output_audio_format: "pcm",
                input_audio_transcription: { model: "qwen3-asr-flash-realtime" },
                instructions: this.config.instructions,
                turn_detection: this.buildTurnDetection(),
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
            this.emit("ready");
            return;
          }

          if (type === "input_audio_buffer.speech_started") {
            this.emit("speechStarted");
            if (this.responding && this.currentResponseId) {
              const responseId = this.currentResponseId;
              this.send({ event_id: randomUUID(), type: "response.cancel" });
              this.emit("interrupted", responseId, "barge_in");
            }
            return;
          }

          if (type === "input_audio_buffer.speech_stopped") {
            this.emit("speechStopped");
            return;
          }

          if (type === "conversation.item.input_audio_transcription.delta") {
            const delta = stringValue(event.delta) || stringValue(event.text);
            if (delta) this.emit("transcriptDelta", delta);
            return;
          }

          if (type === "conversation.item.input_audio_transcription.completed") {
            const transcript = stringValue(event.transcript) || stringValue(event.text);
            if (transcript) this.emit("transcriptFinal", transcript);
            return;
          }

          if (type === "response.created") {
            const response = objectValue(event.response);
            const responseId = stringValue(response?.id) || randomUUID();
            this.currentResponseId = responseId;
            this.responding = true;
            this.responseText.set(responseId, "");
            this.emit("responseCreated", responseId);
            return;
          }

          if (type === "response.audio_transcript.delta" || type === "response.text.delta") {
            const responseId = stringValue(event.response_id) || this.currentResponseId || randomUUID();
            const delta = stringValue(event.delta);
            if (!delta) return;
            this.responseText.set(responseId, `${this.responseText.get(responseId) ?? ""}${delta}`);
            this.emit("textDelta", responseId, delta);
            return;
          }

          if (type === "response.audio.delta") {
            const responseId = stringValue(event.response_id) || this.currentResponseId || randomUUID();
            const delta = stringValue(event.delta);
            if (delta) this.emit("audio", responseId, Buffer.from(delta, "base64"));
            return;
          }

          if (type === "response.audio.done") {
            const responseId = stringValue(event.response_id) || this.currentResponseId || randomUUID();
            this.emit("audioDone", responseId);
            return;
          }

          if (type === "response.done") {
            const response = objectValue(event.response);
            const responseId = stringValue(response?.id) || this.currentResponseId || randomUUID();
            const status = stringValue(response?.status);
            const text = this.responseText.get(responseId) ?? "";
            this.responding = false;
            if (this.currentResponseId === responseId) this.currentResponseId = undefined;
            this.responseText.delete(responseId);
            this.emit("responseDone", responseId, text, status);
            return;
          }

          if (type === "error") {
            const detail = objectValue(event.error);
            const code = stringValue(detail?.code);
            const message = stringValue(detail?.message) || "未知错误";
            this.emit("error", new Error(`Qwen Omni Realtime 错误${code ? `(${code})` : ""}：${message}`));
          }
        } catch (error) {
          this.emit("error", error instanceof Error ? error : new Error(String(error)));
        }
      });

      ws.on("error", (error) => failBeforeReady(error));
      ws.on("close", (code, reason) => {
        this.ready = false;
        this.ws = undefined;
        if (!settled) {
          settled = true;
          reject(new Error(`Qwen Omni Realtime 在初始化前关闭：${code} ${reason.toString()}`.trim()));
        }
        if (!this.closed) this.emit("close", code, reason.toString());
      });
    });
    return this.connectPromise;
  }

  appendAudio(audio: Buffer): void {
    if (this.closed || audio.length === 0) return;
    this.audioBuffer = this.audioBuffer.length ? Buffer.concat([this.audioBuffer, audio]) : Buffer.from(audio);
    // 16 kHz / PCM16 / mono: 1280 bytes = 40 ms. This keeps interruption
    // latency low while avoiding one JSON envelope for every 20 ms frame.
    while (this.audioBuffer.length >= 1280) {
      const chunk = this.audioBuffer.subarray(0, 1280);
      this.audioBuffer = this.audioBuffer.subarray(1280);
      this.sendAudioChunk(chunk);
    }
  }

  commitTurn(): void {
    this.flushAudio();
    this.send({ event_id: randomUUID(), type: "input_audio_buffer.commit" });
    this.send({ event_id: randomUUID(), type: "response.create" });
  }

  cancelResponse(): void {
    if (!this.responding) return;
    const responseId = this.currentResponseId;
    this.send({ event_id: randomUUID(), type: "response.cancel" });
    if (responseId) this.emit("interrupted", responseId, "client_cancel");
  }

  updateInstructions(instructions: string): void {
    if (!this.ready) return;
    this.send({
      event_id: randomUUID(),
      type: "session.update",
      session: { instructions },
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.flushAudio();
    this.ws?.close(1000, "aipany session closed");
    this.ws = undefined;
    this.ready = false;
  }

  private flushAudio(): void {
    if (!this.audioBuffer.length) return;
    const chunk = this.audioBuffer;
    this.audioBuffer = Buffer.alloc(0);
    this.sendAudioChunk(chunk);
  }

  private sendAudioChunk(audio: Buffer): void {
    this.send({
      event_id: randomUUID(),
      type: "input_audio_buffer.append",
      audio: audio.toString("base64"),
    });
  }

  private buildTurnDetection(): Record<string, unknown> {
    if (this.config.turnDetection === "semantic_vad") {
      return {
        type: "semantic_vad",
        create_response: true,
        interrupt_response: true,
      };
    }
    return {
      type: "server_vad",
      threshold: this.config.vadThreshold,
      prefix_padding_ms: 300,
      silence_duration_ms: this.config.silenceMs,
      create_response: true,
      interrupt_response: true,
    };
  }

  private send(payload: unknown): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(payload));
    return true;
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
