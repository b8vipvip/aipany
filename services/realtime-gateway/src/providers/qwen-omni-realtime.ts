import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { loadChat2ApiLiveConfig } from "./chat2api-live-config.js";
import { Chat2ApiLiveClient, type Chat2ApiLiveStatusState } from "./chat2api-live.js";
import { isChat2ApiRealtimeModel, isQwenAudioRealtimeModel } from "../mobile/realtime-experience.js";

export interface QwenOmniRealtimeConfig {
  apiKey: string;
  workspaceId?: string;
  baseUrl: string;
  model: string;
  voice: string;
  instructions: string;
  turnDetection: "server_vad" | "semantic_vad" | "smart_turn";
  vadThreshold: number;
  silenceMs: number;
}

interface QwenOmniRealtimeEvents {
  upstreamStatus: [state: Chat2ApiLiveStatusState, detail?: string];
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
 * Native realtime provider facade.
 *
 * Qwen models use Alibaba Cloud directly. The `gpt-live` model ids intentionally
 * reuse the same Aipany provider contract but delegate to the user's chat2api
 * browser bridge, keeping QwenOmniLiveSession and all mobile protocol events
 * unchanged.
 */
export class QwenOmniRealtimeClient extends EventEmitter<QwenOmniRealtimeEvents> {
  private ws?: WebSocket;
  private chat2api?: Chat2ApiLiveClient;
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
    if (isChat2ApiRealtimeModel(this.config.model)) {
      this.connectPromise = this.connectChat2Api();
      return this.connectPromise;
    }
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
            const session: Record<string, unknown> = {
              modalities: isQwenAudioRealtimeModel(this.config.model) ? ["audio", "text"] : ["text", "audio"],
              voice: this.config.voice,
              input_audio_format: "pcm",
              output_audio_format: "pcm",
              instructions: this.config.instructions,
              turn_detection: this.buildTurnDetection(),
            };
            if (!isQwenAudioRealtimeModel(this.config.model)) {
              session.input_audio_transcription = { model: "qwen3-asr-flash-realtime" };
            }
            this.send({ event_id: randomUUID(), type: "session.update", session });
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
            this.emit("error", new Error(`Qwen Realtime 错误${code ? `(${code})` : ""}：${message}`));
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
          reject(new Error(`Qwen Realtime 在初始化前关闭：${code} ${reason.toString()}`.trim()));
        }
        if (!this.closed) this.emit("close", code, reason.toString());
      });
    });
    return this.connectPromise;
  }

  appendAudio(audio: Buffer): void {
    if (this.chat2api) {
      this.chat2api.appendAudio(audio);
      return;
    }
    if (this.closed || audio.length === 0) return;
    this.audioBuffer = this.audioBuffer.length ? Buffer.concat([this.audioBuffer, audio]) : Buffer.from(audio);
    while (this.audioBuffer.length >= 1280) {
      const chunk = this.audioBuffer.subarray(0, 1280);
      this.audioBuffer = this.audioBuffer.subarray(1280);
      this.sendAudioChunk(chunk);
    }
  }

  commitTurn(): void {
    if (this.chat2api) {
      this.chat2api.commitTurn();
      return;
    }
    this.flushAudio();
    this.send({ event_id: randomUUID(), type: "input_audio_buffer.commit" });
    this.send({ event_id: randomUUID(), type: "response.create" });
  }

  requestTextResponse(text: string): boolean {
    if (this.chat2api) return this.chat2api.requestTextResponse(text);
    if (!this.ready || !text.trim()) return false;
    const created = this.send({
      event_id: randomUUID(),
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: text.trim() }],
      },
    });
    if (!created) return false;
    return this.send({
      event_id: randomUUID(),
      type: "response.create",
      response: { modalities: ["audio", "text"] },
    });
  }

  cancelResponse(): void {
    if (this.chat2api) {
      this.chat2api.cancelResponse();
      return;
    }
    if (!this.responding) return;
    const responseId = this.currentResponseId;
    this.send({ event_id: randomUUID(), type: "response.cancel" });
    if (responseId) this.emit("interrupted", responseId, "client_cancel");
  }

  updateInstructions(instructions: string): void {
    if (this.chat2api) {
      this.chat2api.updateInstructions(instructions);
      return;
    }
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
    if (this.chat2api) {
      this.chat2api.close();
      this.chat2api = undefined;
      this.ready = false;
      return;
    }
    this.flushAudio();
    this.ws?.close(1000, "aipany session closed");
    this.ws = undefined;
    this.ready = false;
  }

  private async connectChat2Api(): Promise<void> {
    const live = loadChat2ApiLiveConfig();
    if (!live.enabled || !live.apiKey) throw new Error("Chat2API GPT-Live 未启用或缺少 API Key");
    const client = new Chat2ApiLiveClient({
      apiKey: live.apiKey,
      baseUrl: live.baseUrl,
      model: this.config.model,
      clientId: live.clientId,
      instructions: this.config.instructions,
    });
    this.chat2api = client;
    client.on("status", (state, detail) => this.emit("upstreamStatus", state, detail));
    client.on("ready", () => {
      this.ready = true;
      this.emit("ready");
    });
    client.on("speechStarted", () => this.emit("speechStarted"));
    client.on("speechStopped", () => this.emit("speechStopped"));
    client.on("transcriptDelta", (text) => this.emit("transcriptDelta", text));
    client.on("transcriptFinal", (text) => this.emit("transcriptFinal", text));
    client.on("responseCreated", (responseId) => {
      this.responding = true;
      this.currentResponseId = responseId;
      this.responseText.set(responseId, "");
      this.emit("responseCreated", responseId);
    });
    client.on("textDelta", (responseId, delta) => {
      this.responseText.set(responseId, `${this.responseText.get(responseId) ?? ""}${delta}`);
      this.emit("textDelta", responseId, delta);
    });
    client.on("audio", (responseId, audio) => this.emit("audio", responseId, audio));
    client.on("audioDone", (responseId) => this.emit("audioDone", responseId));
    client.on("interrupted", (responseId, reason) => {
      this.responding = false;
      if (this.currentResponseId === responseId) this.currentResponseId = undefined;
      this.responseText.delete(responseId);
      this.emit("interrupted", responseId, reason);
    });
    client.on("responseDone", (responseId, text, status) => {
      this.responding = false;
      if (this.currentResponseId === responseId) this.currentResponseId = undefined;
      const finalText = text || this.responseText.get(responseId) || "";
      this.responseText.delete(responseId);
      this.emit("responseDone", responseId, finalText, status);
    });
    client.on("error", (error) => this.emit("error", error));
    client.on("close", (code, reason) => {
      this.ready = false;
      if (!this.closed) this.emit("close", code, reason);
    });
    await client.connect();
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
    if (this.config.turnDetection === "smart_turn") {
      return { type: "smart_turn" };
    }
    if (this.config.turnDetection === "semantic_vad") {
      if (isQwenAudioRealtimeModel(this.config.model)) return { type: "smart_turn" };
      return {
        type: "semantic_vad",
        create_response: true,
        interrupt_response: true,
      };
    }
    if (isQwenAudioRealtimeModel(this.config.model)) {
      return {
        type: "server_vad",
        threshold: this.config.vadThreshold,
        silence_duration_ms: this.config.silenceMs,
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
