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
import { resolveRequestedVoice } from "../mobile/client-capabilities.js";
import { recordGlobalRealtimeEvent } from "../observability/global-observability.js";
import type { ObservabilityLevel, SessionObservability } from "../observability/realtime-observability.js";
import {
  QwenOmniRealtimeClient,
  type QwenOmniRealtimeConfig,
} from "../providers/qwen-omni-realtime.js";

const RECOVERY_DELAYS_MS = [0, 500, 1500] as const;
const RECOVERY_AUDIO_BUFFER_MAX_BYTES = 96_000; // 3 seconds of 16 kHz PCM16 mono.

type QwenOmniRealtimeClientFactory = (config: QwenOmniRealtimeConfig) => QwenOmniRealtimeClient;

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
  private voice = "";
  private activeResponseId?: string;
  private readonly audioStarted = new Set<string>();
  private readonly responseText = new Map<string, string>();
  private transcriptBuffer = "";
  private recoveryPromise?: Promise<void>;
  private recoveryAudioBuffer = Buffer.alloc(0);

  constructor(
    private readonly client: WebSocket,
    private readonly config: AppConfig,
    private readonly authContext: AuthContext,
    private readonly telemetry?: SessionObservability,
    sessionId?: string,
    private readonly providerFactory: QwenOmniRealtimeClientFactory = (providerConfig) => new QwenOmniRealtimeClient(providerConfig),
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
    this.voice = resolveRequestedVoice(
      this.config.qwenOmniRealtime.model,
      this.config.qwenOmniRealtime.voice,
      event.session.outputVoice,
    );

    await this.openProvider();
    this.send({
      type: "session.created",
      sessionId: this.id,
      inputAudio: INPUT_AUDIO_FORMAT,
      outputAudio: OUTPUT_AUDIO_FORMAT,
    });
    this.sendModeState();
    this.send({ type: "speaker.consent.updated", granted: false });
    this.observe("omni.session.ready", { upstream: "qwen-omni-realtime", voice: this.voice }, "info", "omni");
    this.send({ type: "session.ready", sessionId: this.id });
  }

  appendAudio(audio: Buffer): void {
    if (!this.started || this.closed || audio.length === 0) return;
    if (this.providerReady && this.provider) {
      this.provider.appendAudio(audio);
      return;
    }
    if (this.recoveryPromise) this.bufferRecoveryAudio(audio);
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
    this.recoveryAudioBuffer = Buffer.alloc(0);
    this.provider?.close();
    this.provider = undefined;
    this.providerReady = false;
  }

  private async openProvider(): Promise<void> {
    const provider = this.providerFactory({
      apiKey: this.config.qwenOmniRealtime.apiKey,
      workspaceId: this.config.qwenOmniRealtime.workspaceId,
      baseUrl: this.config.qwenOmniRealtime.baseUrl,
      model: this.config.qwenOmniRealtime.model,
      voice: this.voice,
      instructions: this.buildInstructions(),
      turnDetection: this.config.qwenOmniRealtime.turnDetection,
      vadThreshold: this.config.qwenOmniRealtime.vadThreshold,
      silenceMs: this.config.qwenOmniRealtime.silenceMs,
    });
    this.provider = provider;
    this.bindProvider(provider);
    await provider.connect();
    if (this.closed || this.provider !== provider) {
      provider.close();
      throw new Error("Native Live 会话在上游连接完成前已经关闭");
    }
    this.providerReady = true;
  }

  private bindProvider(provider: QwenOmniRealtimeClient): void {
    // Forwarded client-protocol events are observed once by server.ts through
    // instrumentOutgoingWebSocket(). Do not record the same semantic event here,
    // otherwise Native Live turns, interruptions and latency samples are doubled.
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
      const previous = this.responseText.get(responseId) ?? "";
      this.responseText.set(responseId, previous + delta);
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
      this.send({ type: "response.interrupted", responseId, reason: reason === "barge_in" ? "barge_in" : "client_cancel" });
      if (this.activeResponseId === responseId) this.activeResponseId = undefined;
    });
    provider.on("responseDone", (responseId, text, _status) => {
      if (this.provider !== provider) return;
      this.send({ type: "response.done", responseId, text });
      this.responseText.delete(responseId);
      this.audioStarted.delete(responseId);
      if (this.activeResponseId === responseId) this.activeResponseId = undefined;
    });
    provider.on("error", (error) => {
      if (this.provider !== provider) return;
      this.observe("omni.error", { message: error.message }, "error", "omni");
      // Startup errors are handled by startGatewaySession so Auto can fall back.
      // Runtime errors may be non-fatal; surface them while keeping recovery tied
      // to an actual upstream close event.
      if (this.providerReady) this.sendError("OMNI_REALTIME_ERROR", error.message, true);
    });
    provider.on("close", (code, reason) => {
      if (this.closed || this.provider !== provider) return;
      const wasReady = this.providerReady;
      this.providerReady = false;
      this.provider = undefined;
      this.observe("omni.closed", { code, reason }, code === 1000 ? "info" : "warn", "omni");
      if (wasReady) this.beginRecovery(code, reason);
    });
  }

  private beginRecovery(code: number, reason: string): void {
    if (this.closed || this.recoveryPromise) return;
    this.interruptActiveResponseForRecovery();
    const startedAt = Date.now();
    this.observe("omni.recovery.started", {
      code,
      reason,
      maxAttempts: RECOVERY_DELAYS_MS.length,
    }, "warn", "omni");
    this.recoveryPromise = this.recoverProvider(startedAt).finally(() => {
      this.recoveryPromise = undefined;
    });
    void this.recoveryPromise;
  }

  private async recoverProvider(startedAt: number): Promise<void> {
    let lastError: unknown;
    for (let index = 0; index < RECOVERY_DELAYS_MS.length; index += 1) {
      const delayMs = RECOVERY_DELAYS_MS[index] ?? 0;
      if (delayMs > 0) await delay(delayMs);
      if (this.closed) return;
      const attempt = index + 1;
      try {
        await this.openProvider();
        const bufferedAudio = this.recoveryAudioBuffer;
        this.recoveryAudioBuffer = Buffer.alloc(0);
        if (bufferedAudio.length) this.provider?.appendAudio(bufferedAudio);
        this.observe("omni.recovered", {
          attempt,
          recoveryMs: Date.now() - startedAt,
          bufferedAudioMs: Math.round(bufferedAudio.length / 32),
          contextReset: true,
        }, "info", "omni");
        return;
      } catch (error) {
        lastError = error;
        this.observe("omni.recovery.attempt_failed", {
          attempt,
          message: error instanceof Error ? error.message : String(error),
        }, "warn", "omni");
      }
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown recovery error");
    this.observe("omni.recovery.exhausted", {
      attempts: RECOVERY_DELAYS_MS.length,
      message,
    }, "error", "omni");
    this.sendError("OMNI_REALTIME_RECOVERY_FAILED", `Native Live 自动恢复失败：${message}`, true);
    queueMicrotask(() => {
      if (this.client.readyState === WebSocket.OPEN || this.client.readyState === WebSocket.CONNECTING) {
        this.client.close(1011, "omni recovery failed");
      }
    });
  }

  private interruptActiveResponseForRecovery(): void {
    const responseId = this.activeResponseId;
    if (!responseId) return;
    this.send({ type: "response.interrupted", responseId, reason: "client_cancel" });
    this.responseText.delete(responseId);
    this.audioStarted.delete(responseId);
    this.activeResponseId = undefined;
    this.observe("omni.recovery.interrupted_response", {}, "warn", "omni");
  }

  private bufferRecoveryAudio(audio: Buffer): void {
    const combined = this.recoveryAudioBuffer.length
      ? Buffer.concat([this.recoveryAudioBuffer, audio])
      : Buffer.from(audio);
    this.recoveryAudioBuffer = combined.length <= RECOVERY_AUDIO_BUFFER_MAX_BYTES
      ? combined
      : combined.subarray(combined.length - RECOVERY_AUDIO_BUFFER_MAX_BYTES);
  }

  private observe(
    event: string,
    data: Record<string, unknown>,
    level: ObservabilityLevel,
    category: string,
  ): void {
    if (this.telemetry) {
      this.telemetry.event(event, data, level, category);
      return;
    }
    recordGlobalRealtimeEvent({
      level,
      category,
      event,
      engine: "omni_realtime",
      data,
    });
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
