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
import type { SessionObservability } from "../observability/realtime-observability.js";
import { QwenOmniRealtimeClient } from "../providers/qwen-omni-realtime.js";

/**
 * Native speech-to-speech session backed by Qwen-Omni-Realtime.
 *
 * It intentionally keeps Aipany's client protocol stable: mobile/web/embedded
 * clients still stream binary 16 kHz PCM to the Gateway and receive binary
 * 24 kHz PCM plus the familiar session/transcript/response events.
 */
export class QwenOmniLiveSession {
  readonly id: string;
  private provider?: QwenOmniRealtimeClient;
  private started = false;
  private providerReady = false;
  private closed = false;
  private mode: InteractionMode = "auto";
  private aliases: string[] = ["Aipany", "小派"];
  private socialProactivity = 0.45;
  private systemPrompt = "";
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
    if (!this.config.qwenOmniRealtime.enabled) throw new Error("Qwen Omni Realtime 未启用");
    if (!this.config.qwenOmniRealtime.apiKey) throw new Error("Qwen Omni Realtime 缺少 API Key");

    this.started = true;
    this.mode = event.session.interactionMode;
    this.aliases = event.session.assistantAliases;
    this.socialProactivity = event.session.socialProactivity;
    this.systemPrompt = event.session.systemPrompt?.trim() || this.config.conversation.defaultSystemPrompt;
    const voice = event.session.outputVoice?.trim() || this.config.qwenOmniRealtime.voice;

    const provider = new QwenOmniRealtimeClient({
      apiKey: this.config.qwenOmniRealtime.apiKey,
      workspaceId: this.config.qwenOmniRealtime.workspaceId,
      baseUrl: this.config.qwenOmniRealtime.baseUrl,
      model: this.config.qwenOmniRealtime.model,
      voice,
      instructions: this.buildInstructions(),
      turnDetection: this.config.qwenOmniRealtime.turnDetection,
      vadThreshold: this.config.qwenOmniRealtime.vadThreshold,
      silenceMs: this.config.qwenOmniRealtime.silenceMs,
    });
    this.provider = provider;

    provider.on("speechStarted", () => {
      this.transcriptBuffer = "";
      this.telemetry?.event("speech.started", {}, "info", "audio");
      this.send({ type: "input_audio_buffer.speech_started" });
    });
    provider.on("speechStopped", () => {
      this.telemetry?.event("speech.stopped", {}, "info", "audio");
      this.send({ type: "input_audio_buffer.speech_stopped" });
    });
    provider.on("transcriptDelta", (delta) => {
      this.transcriptBuffer += delta;
      this.send({ type: "transcript.partial", text: this.transcriptBuffer, emotion: "unknown" });
    });
    provider.on("transcriptFinal", (text) => {
      this.transcriptBuffer = text;
      this.telemetry?.event("transcript.final", { textChars: text.length }, "info", "asr");
      this.send({ type: "transcript.final", text, emotion: "unknown" });
    });
    provider.on("responseCreated", (responseId) => {
      this.activeResponseId = responseId;
      this.responseText.set(responseId, "");
      this.telemetry?.event("response.created", { responseId }, "info", "omni");
      this.send({ type: "response.created", responseId });
    });
    provider.on("textDelta", (responseId, delta) => {
      const previous = this.responseText.get(responseId) ?? "";
      if (!previous) this.telemetry?.event("response.first_text", { responseId }, "info", "omni");
      this.responseText.set(responseId, previous + delta);
      this.send({ type: "response.text.delta", responseId, delta });
    });
    provider.on("audio", (responseId, audio) => {
      if (!this.audioStarted.has(responseId)) {
        this.audioStarted.add(responseId);
        this.telemetry?.event("response.first_audio", { responseId, bytes: audio.length }, "info", "omni");
        this.send({ type: "response.audio.started", responseId, format: OUTPUT_AUDIO_FORMAT });
      }
      if (this.client.readyState === WebSocket.OPEN) this.client.send(audio, { binary: true });
    });
    provider.on("audioDone", (responseId) => {
      this.send({ type: "response.audio.done", responseId });
    });
    provider.on("interrupted", (responseId, reason) => {
      this.telemetry?.event("response.interrupted", { responseId, reason }, "info", "omni");
      this.send({ type: "response.interrupted", responseId, reason: reason === "barge_in" ? "barge_in" : "client_cancel" });
      if (this.activeResponseId === responseId) this.activeResponseId = undefined;
    });
    provider.on("responseDone", (responseId, text, status) => {
      this.telemetry?.event("response.done", { responseId, status: status || "", textChars: text.length }, "info", "omni");
      this.send({ type: "response.done", responseId, text });
      this.responseText.delete(responseId);
      this.audioStarted.delete(responseId);
      if (this.activeResponseId === responseId) this.activeResponseId = undefined;
    });
    provider.on("error", (error) => {
      this.telemetry?.event("omni.error", { message: error.message }, "error", "omni");
      // Before session.ready the server may transparently fall back to the
      // cascaded engine, so do not leak a transient upstream startup error to
      // the client. After ready it is a real live-session error and is surfaced.
      if (this.providerReady) this.sendError("OMNI_REALTIME_ERROR", error.message, true);
    });
    provider.on("close", (code, reason) => {
      if (this.closed) return;
      this.telemetry?.event("omni.closed", { code, reason }, code === 1000 ? "info" : "warn", "omni");
      if (this.providerReady) {
        this.sendError("OMNI_REALTIME_CLOSED", `Qwen Omni Realtime 连接关闭：${code} ${reason}`.trim(), true);
      }
    });

    await provider.connect();
    this.providerReady = true;
    this.send({
      type: "session.created",
      sessionId: this.id,
      inputAudio: INPUT_AUDIO_FORMAT,
      outputAudio: OUTPUT_AUDIO_FORMAT,
    });
    this.sendModeState();
    this.send({ type: "speaker.consent.updated", granted: false });
    this.telemetry?.event("session.ready", { upstream: "qwen-omni-realtime" }, "info", "session");
    this.send({ type: "session.ready", sessionId: this.id });
  }

  appendAudio(audio: Buffer): void {
    if (!this.started || this.closed) return;
    this.provider?.appendAudio(audio);
  }

  commitAudio(): void {
    // Native Live mode uses upstream VAD/turn detection. The client-side endpoint
    // detector remains active for the cascaded fallback, but does not create a
    // duplicate response here.
    this.telemetry?.event("client.endpoint_hint", {}, "info", "client");
  }

  cancelResponse(): void {
    this.provider?.cancelResponse();
  }

  setInteractionMode(mode: InteractionMode, source: "manual" | "voice_command" | "auto"): void {
    this.mode = mode;
    this.provider?.updateInstructions(this.buildInstructions());
    this.sendModeState(source);
  }

  respondToModeSuggestion(_suggestionId: string, _accepted: boolean): void {
    // Native Live mode currently does not emit local mode suggestions.
  }

  async setSpeakerConsent(_granted: boolean): Promise<void> {
    throw new Error("Native Live 模式暂不支持声纹写入，请切换 Cascaded 模式完成声纹管理");
  }

  async revokeSpeakerConsent(_deleteExisting: boolean): Promise<void> {
    throw new Error("Native Live 模式暂不支持声纹写入，请切换 Cascaded 模式完成声纹管理");
  }

  async sendSpeakerConsentStatus(): Promise<void> {
    this.send({ type: "speaker.consent.updated", granted: false });
  }

  async listSpeakerIdentities(): Promise<void> {
    throw new Error("Native Live 模式暂不支持声纹列表，请切换 Cascaded 模式");
  }

  async startSpeakerEnrollment(_input: { personName: string; relation?: string; isOwner?: boolean }): Promise<void> {
    throw new Error("Native Live 模式暂不支持声纹注册，请切换 Cascaded 模式");
  }

  cancelSpeakerEnrollment(_enrollmentId: string): void {}

  async deleteSpeakerIdentity(_personId: string): Promise<void> {
    throw new Error("Native Live 模式暂不支持声纹删除，请切换 Cascaded 模式");
  }

  recordClientTelemetry(event: { name: string; valueMs?: number; details?: Record<string, string | number | boolean> }): void {
    this.telemetry?.event(`client.${event.name}`, {
      valueMs: event.valueMs,
      ...(event.details ? { details: event.details } : {}),
    }, "info", "client");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.provider?.close();
    this.provider = undefined;
    this.providerReady = false;
  }

  private buildInstructions(): string {
    const modeInstruction = this.mode === "group"
      ? "当前是多人聊天模式。只在被明确询问或确实有价值时回答，不要每句话都抢答。"
      : this.mode === "owner_focus"
        ? "当前是专注主人模式。主要持续和设备主人自然交流。"
        : "当前使用自动交互模式，根据对话自然判断何时回应。";
    return [
      this.systemPrompt,
      `你的称呼包括：${this.aliases.join("、")}。`,
      modeInstruction,
      `主动参与程度为 ${this.socialProactivity.toFixed(2)}。`,
      "这是实时语音对话。回答要口语化、自然、简洁。允许用户随时打断；被打断后立即停止上一句并听用户继续说。",
    ].filter(Boolean).join("\n");
  }

  private sendModeState(source = "manual"): void {
    const activeMode = this.mode === "group" ? "group" : "owner_focus";
    this.send({ type: "mode.changed", configuredMode: this.mode, activeMode, source });
  }

  private send(event: ServerEvent): void {
    if (this.client.readyState !== WebSocket.OPEN) return;
    this.client.send(JSON.stringify(event));
  }

  private sendError(code: string, message: string, retryable: boolean): void {
    this.send({ type: "error", code, message, retryable });
  }
}
