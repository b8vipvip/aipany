import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  INPUT_AUDIO_FORMAT,
  OUTPUT_AUDIO_FORMAT,
  type InteractionMode,
  type ServerEvent,
  type SessionStartEvent,
} from "@aipany/protocol";
import { assertSessionIdentity, requireScope, type AuthContext } from "../auth.js";
import type { AppConfig } from "../config.js";
import { recordGlobalRealtimeEvent } from "../observability/global-observability.js";
import type { SessionObservability } from "../observability/realtime-observability.js";
import { Chat2ApiLiveClient } from "../providers/chat2api-live.js";

/**
 * Aipany client-protocol adapter for a persistent ChatGPT Voice session exposed
 * by chat2api. No ASR -> text LLM -> TTS cascade is used for response generation.
 */
export class Chat2ApiLiveSession {
  readonly id: string;
  private provider?: Chat2ApiLiveClient;
  private started = false;
  private closed = false;
  private mode: InteractionMode = "auto";
  private activeResponseId?: string;
  private readonly audioStarted = new Set<string>();
  private readonly responseText = new Map<string, string>();
  private transcriptBuffer = "";

  constructor(
    private readonly client: WebSocket,
    private readonly config: AppConfig,
    private readonly authContext: AuthContext,
    private readonly telemetry?: SessionObservability,
    sessionId?: string,
  ) {
    this.id = sessionId ?? randomUUID();
  }

  async start(event: SessionStartEvent): Promise<void> {
    if (this.started) throw new Error("会话已经启动");
    requireScope(this.authContext, "realtime");
    assertSessionIdentity(this.authContext, event.session);
    if (!this.config.chat2apiLive.enabled) throw new Error("Chat2API GPT-Live 未启用");
    if (!this.config.chat2apiLive.apiKey.trim()) throw new Error("Chat2API GPT-Live 缺少 API Key");

    this.started = true;
    this.mode = event.session.interactionMode;
    const instructions = event.session.systemPrompt?.trim() || this.config.conversation.defaultSystemPrompt;
    const provider = new Chat2ApiLiveClient({
      apiKey: this.config.chat2apiLive.apiKey,
      baseUrl: this.config.chat2apiLive.baseUrl,
      model: this.config.chat2apiLive.model,
      clientId: this.config.chat2apiLive.clientId,
      instructions,
    });
    this.provider = provider;
    this.bindProvider(provider);
    await provider.connect();
    if (this.closed || this.provider !== provider) {
      provider.close();
      throw new Error("Chat2API GPT-Live 会话在连接完成前已经关闭");
    }

    this.send({
      type: "session.created",
      sessionId: this.id,
      inputAudio: INPUT_AUDIO_FORMAT,
      outputAudio: OUTPUT_AUDIO_FORMAT,
    });
    this.sendModeState("auto");
    this.send({ type: "speaker.consent.updated", granted: false });
    this.observe("chat2api_live.session.ready", {
      upstream: "chat2api",
      model: this.config.chat2apiLive.model,
    });
    this.send({ type: "session.ready", sessionId: this.id });
  }

  appendAudio(audio: Buffer): void {
    if (!this.started || this.closed || audio.length === 0) return;
    this.provider?.appendAudio(audio);
  }

  commitAudio(): void {
    this.telemetry?.event("client.endpoint_hint", {}, "info", "client");
  }

  cancelResponse(): void {
    this.provider?.cancelResponse();
  }

  setInteractionMode(mode: InteractionMode, source: "manual" | "voice_command" | "auto"): void {
    this.mode = mode;
    this.sendModeState(source);
  }

  respondToModeSuggestion(_suggestionId: string, _accepted: boolean): void {}

  async setSpeakerConsent(_granted: boolean): Promise<void> {
    throw new Error("Chat2API GPT-Live 暂不支持声纹写入，请切换 Economy Live 完成声纹管理");
  }

  async revokeSpeakerConsent(_deleteExisting: boolean): Promise<void> {
    throw new Error("Chat2API GPT-Live 暂不支持声纹写入，请切换 Economy Live 完成声纹管理");
  }

  async sendSpeakerConsentStatus(): Promise<void> {
    this.send({ type: "speaker.consent.updated", granted: false });
  }

  async listSpeakerIdentities(): Promise<void> {
    throw new Error("Chat2API GPT-Live 暂不支持声纹列表，请切换 Economy Live");
  }

  async startSpeakerEnrollment(_input: { personName: string; relation?: string; isOwner?: boolean }): Promise<void> {
    throw new Error("Chat2API GPT-Live 暂不支持声纹注册，请切换 Economy Live");
  }

  cancelSpeakerEnrollment(_enrollmentId: string): void {}

  async deleteSpeakerIdentity(_personId: string): Promise<void> {
    throw new Error("Chat2API GPT-Live 暂不支持声纹删除，请切换 Economy Live");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.provider?.close();
    this.provider = undefined;
  }

  private bindProvider(provider: Chat2ApiLiveClient): void {
    provider.on("speechStarted", () => {
      if (this.provider !== provider) return;
      this.transcriptBuffer = "";
      this.send({ type: "input_audio_buffer.speech_started" });
    });
    provider.on("speechStopped", () => {
      if (this.provider !== provider) return;
      this.send({ type: "input_audio_buffer.speech_stopped" });
    });
    provider.on("transcriptDelta", (delta) => {
      if (this.provider !== provider) return;
      this.transcriptBuffer += delta;
      this.send({ type: "transcript.partial", text: this.transcriptBuffer, emotion: "unknown" });
    });
    provider.on("transcriptFinal", (text) => {
      if (this.provider !== provider) return;
      this.transcriptBuffer = text;
      this.send({ type: "transcript.final", text, emotion: "unknown" });
    });
    provider.on("responseCreated", (responseId) => {
      if (this.provider !== provider) return;
      this.activeResponseId = responseId;
      this.responseText.set(responseId, "");
      this.send({ type: "response.created", responseId });
    });
    provider.on("textDelta", (responseId, delta) => {
      if (this.provider !== provider) return;
      const text = `${this.responseText.get(responseId) ?? ""}${delta}`;
      this.responseText.set(responseId, text);
      this.send({ type: "response.text.delta", responseId, delta });
    });
    provider.on("audio", (responseId, audio) => {
      if (this.provider !== provider) return;
      if (!this.audioStarted.has(responseId)) {
        this.audioStarted.add(responseId);
        this.send({ type: "response.audio.started", responseId, format: OUTPUT_AUDIO_FORMAT });
      }
      if (this.client.readyState === WebSocket.OPEN) this.client.send(audio, { binary: true });
    });
    provider.on("audioDone", (responseId) => {
      if (this.provider !== provider) return;
      this.send({ type: "response.audio.done", responseId });
    });
    provider.on("interrupted", (responseId, reason) => {
      if (this.provider !== provider) return;
      this.send({
        type: "response.interrupted",
        responseId,
        reason: reason === "client_cancel" ? "client_cancel" : "barge_in",
      });
      this.audioStarted.delete(responseId);
      this.responseText.delete(responseId);
      if (this.activeResponseId === responseId) this.activeResponseId = undefined;
    });
    provider.on("responseDone", (responseId, text) => {
      if (this.provider !== provider) return;
      this.send({ type: "response.done", responseId, text });
      this.audioStarted.delete(responseId);
      this.responseText.delete(responseId);
      if (this.activeResponseId === responseId) this.activeResponseId = undefined;
    });
    provider.on("error", (error) => {
      if (this.provider !== provider) return;
      this.observe("chat2api_live.error", { message: error.message }, "error");
      this.sendError("CHAT2API_LIVE_ERROR", error.message, true);
    });
    provider.on("close", (code, reason) => {
      if (this.closed || this.provider !== provider) return;
      this.observe("chat2api_live.closed", { code, reason }, code === 1000 ? "info" : "warn");
      this.sendError("CHAT2API_LIVE_CLOSED", `Chat2API GPT-Live 已断开：${code} ${reason}`.trim(), true);
      queueMicrotask(() => {
        if (this.client.readyState === WebSocket.OPEN || this.client.readyState === WebSocket.CONNECTING) {
          this.client.close(1011, "chat2api live closed");
        }
      });
    });
  }

  private sendModeState(source = "manual"): void {
    this.send({
      type: "mode.changed",
      configuredMode: this.mode,
      activeMode: this.mode === "group" ? "group" : "owner_focus",
      source,
    });
  }

  private send(event: ServerEvent): void {
    if (this.client.readyState !== WebSocket.OPEN) return;
    this.client.send(JSON.stringify(event));
  }

  private sendError(code: string, message: string, retryable: boolean): void {
    this.send({ type: "error", code, message, retryable });
  }

  private observe(
    event: string,
    data: Record<string, unknown>,
    level: "info" | "warn" | "error" = "info",
  ): void {
    this.telemetry?.event(event, data, level, "omni");
    recordGlobalRealtimeEvent({ level, category: "omni", event, sessionId: this.id, engine: "omni_realtime", data });
  }
}
