import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  INPUT_AUDIO_FORMAT,
  OUTPUT_AUDIO_FORMAT,
  type InteractionMode,
  type ServerEvent,
  type SessionStartEvent,
  type UserEmotion,
} from "@aipany/protocol";
import {
  AudioIntelligenceEngine,
  type SpeakerObservation,
} from "@aipany/audio-intelligence";
import type { AppConfig } from "../config.js";
import { QwenAsrRealtimeClient } from "../providers/qwen-asr.js";
import { QwenTtsRealtimeClient } from "../providers/qwen-tts.js";
import { OpenAiCompatibleLlm, type ChatMessage } from "../providers/openai-compatible-llm.js";
import { EmotionDirector } from "../pipeline/emotion-director.js";
import { StreamingTextChunker } from "../pipeline/text-chunker.js";

interface ActiveResponse {
  id: string;
  abortController: AbortController;
  tts?: QwenTtsRealtimeClient;
  interrupted: boolean;
}

export class RealtimeSession {
  readonly id = randomUUID();
  private asr?: QwenAsrRealtimeClient;
  private readonly llm: OpenAiCompatibleLlm;
  private readonly emotionDirector = new EmotionDirector();
  private history: ChatMessage[] = [];
  private activeResponse?: ActiveResponse;
  private audioIntelligence?: AudioIntelligenceEngine;
  private activeEnrollmentId?: string;
  private socialProactivity = 0.45;
  private started = false;
  private closed = false;

  constructor(
    private readonly client: WebSocket,
    private readonly config: AppConfig,
  ) {
    this.llm = new OpenAiCompatibleLlm(config.llm);
  }

  async start(event: SessionStartEvent): Promise<void> {
    if (this.started) throw new Error("会话已经启动");
    this.started = true;
    this.socialProactivity = event.session.socialProactivity;
    this.audioIntelligence = new AudioIntelligenceEngine({
      mode: {
        initialMode: event.session.interactionMode,
        initialActiveMode: event.session.interactionMode === "group" ? "group" : "owner_focus",
      },
    });

    const systemPrompt = event.session.systemPrompt?.trim() || this.config.conversation.defaultSystemPrompt;
    this.history = [{ role: "system", content: systemPrompt }];

    this.send({
      type: "session.created",
      sessionId: this.id,
      inputAudio: INPUT_AUDIO_FORMAT,
      outputAudio: OUTPUT_AUDIO_FORMAT,
    });
    this.sendModeState();

    const asr = new QwenAsrRealtimeClient({
      apiKey: this.config.qwen.apiKey,
      workspaceId: this.config.qwen.workspaceId,
      baseUrl: this.config.qwen.asrBaseUrl,
      model: this.config.qwen.asrModel,
      language: this.config.qwen.asrLanguage,
      vadThreshold: this.config.qwen.vadThreshold,
      silenceMs: this.config.qwen.silenceMs,
    });
    this.asr = asr;

    asr.on("speechStarted", () => {
      this.send({ type: "input_audio_buffer.speech_started" });
      this.interrupt("barge_in");
    });
    asr.on("speechStopped", () => this.send({ type: "input_audio_buffer.speech_stopped" }));
    asr.on("partial", (result) => {
      this.send({
        type: "transcript.partial",
        text: result.text,
        emotion: result.emotion,
        language: result.language,
      });
    });
    asr.on("final", (result) => {
      if (!result.text) return;
      this.send({
        type: "transcript.final",
        text: result.text,
        emotion: result.emotion,
        language: result.language,
      });
      void this.handleFinalTranscript(result.text, result.emotion);
    });
    asr.on("error", (error) => this.sendError("ASR_ERROR", error.message, true));

    await asr.connect();
    this.send({ type: "session.ready", sessionId: this.id });
  }

  appendAudio(audio: Buffer): void {
    if (!this.started || this.closed) return;
    this.asr?.appendAudio(audio);
  }

  commitAudio(): void {
    // 当前使用千问 Server VAD 自动切轮。事件继续保留，为后续客户端 VAD/硬件端点检测兼容。
  }

  cancelResponse(): void {
    this.interrupt("client_cancel");
  }

  setInteractionMode(mode: InteractionMode, source: "manual" | "voice_command" | "auto"): void {
    const engine = this.audioIntelligence;
    if (!engine) return;
    engine.setMode(mode, source);
    this.sendModeState();
  }

  respondToModeSuggestion(suggestionId: string, accepted: boolean): void {
    const manager = this.audioIntelligence?.modes;
    if (!manager) return;
    if (accepted) {
      const state = manager.acceptSuggestion(suggestionId);
      if (state) this.sendModeState();
      return;
    }
    manager.dismissSuggestion(suggestionId);
  }

  startSpeakerEnrollment(input: { personName: string; relation?: string; isOwner?: boolean }): void {
    const engine = this.audioIntelligence;
    if (!engine) return;
    const enrollment = engine.enrollments.begin({
      sessionId: this.id,
      personName: input.personName,
      relation: input.relation,
      isOwner: input.isOwner,
    });
    this.activeEnrollmentId = enrollment.id;
    this.send({
      type: "speaker.enrollment.started",
      enrollmentId: enrollment.id,
      personId: enrollment.personId,
      personName: enrollment.personName,
    });
  }

  cancelSpeakerEnrollment(enrollmentId: string): void {
    const state = this.audioIntelligence?.enrollments.cancel(enrollmentId);
    if (!state) return;
    if (this.activeEnrollmentId === enrollmentId) this.activeEnrollmentId = undefined;
    this.send({ type: "speaker.enrollment.cancelled", enrollmentId });
  }

  /**
   * 供下一阶段真实 Speaker Provider 调用。
   * 当前千问 ASR 本身不提供说话人分离，因此 v0.2 先把统一入口和业务闭环打通。
   */
  observeSpeaker(observation: SpeakerObservation): void {
    const engine = this.audioIntelligence;
    if (!engine) return;

    const { suggestion } = engine.observeSpeaker(observation);
    if (suggestion) {
      this.send({
        type: "mode.suggestion",
        suggestionId: suggestion.id,
        from: suggestion.from,
        to: suggestion.to,
        reason: suggestion.reason,
        speakerCount: suggestion.speakerCount,
      });
    }

    if (!this.activeEnrollmentId) return;
    const result = engine.enrollments.ingest(this.activeEnrollmentId, observation);
    this.send({
      type: "speaker.enrollment.updated",
      enrollmentId: result.state.id,
      acceptedSamples: result.state.acceptedSamples,
      status: result.state.status,
    });
    if (result.state.status === "confirmed") this.activeEnrollmentId = undefined;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.interrupt("client_cancel");
    this.asr?.close();
    this.asr = undefined;
  }

  private async handleFinalTranscript(text: string, emotion: UserEmotion): Promise<void> {
    if (this.closed) return;
    this.interrupt("new_turn");

    const modeCommand = this.audioIntelligence?.detectModeCommand(text);
    if (modeCommand) this.setInteractionMode(modeCommand, "voice_command");

    this.history.push({ role: "user", content: text });
    this.trimHistory();

    const requestMessages = [...this.history];
    const modeState = this.audioIntelligence?.modes.getState();
    if (modeState) {
      requestMessages.push({
        role: "system",
        content: buildModeInstruction(modeState.configuredMode, modeState.activeMode, this.socialProactivity, Boolean(modeCommand)),
      });
    }

    const response: ActiveResponse = {
      id: randomUUID(),
      abortController: new AbortController(),
      interrupted: false,
    };
    this.activeResponse = response;
    this.send({ type: "response.created", responseId: response.id });

    const direction = this.emotionDirector.direct(emotion);
    const tts = new QwenTtsRealtimeClient(
      {
        apiKey: this.config.qwen.apiKey,
        workspaceId: this.config.qwen.workspaceId,
        baseUrl: this.config.qwen.ttsBaseUrl,
        model: this.config.qwen.ttsModel,
        voice: this.config.qwen.ttsVoice,
        language: this.config.qwen.ttsLanguage,
        sampleRate: this.config.qwen.ttsSampleRate,
        optimizeInstructions: this.config.qwen.optimizeInstructions,
      },
      direction.instructions,
    );
    response.tts = tts;

    let audioStarted = false;
    tts.on("audio", (audio) => {
      if (response.interrupted || this.activeResponse?.id !== response.id) return;
      if (!audioStarted) {
        audioStarted = true;
        this.send({
          type: "response.audio.started",
          responseId: response.id,
          format: OUTPUT_AUDIO_FORMAT,
        });
      }
      if (this.client.readyState === WebSocket.OPEN) this.client.send(audio, { binary: true });
    });
    tts.on("error", (error) => this.sendError("TTS_ERROR", error.message, true));

    const ttsReady = tts.connect();
    const chunker = new StreamingTextChunker();
    let assistantText = "";

    try {
      await this.llm.streamChat({
        messages: requestMessages,
        signal: response.abortController.signal,
        onDelta: async (delta) => {
          if (response.interrupted || this.activeResponse?.id !== response.id) return;
          assistantText += delta;
          this.send({ type: "response.text.delta", responseId: response.id, delta });

          const chunks = chunker.push(delta);
          if (chunks.length === 0) return;
          await ttsReady;
          for (const chunk of chunks) tts.appendText(chunk);
        },
      });

      if (response.interrupted || this.activeResponse?.id !== response.id) return;
      const rest = chunker.flush();
      await ttsReady;
      if (rest) tts.appendText(rest);
      await tts.finish();

      if (response.interrupted || this.activeResponse?.id !== response.id) return;
      this.send({ type: "response.audio.done", responseId: response.id });
      this.send({ type: "response.done", responseId: response.id, text: assistantText });
      if (assistantText.trim()) {
        this.history.push({ role: "assistant", content: assistantText.trim() });
        this.trimHistory();
      }
      this.activeResponse = undefined;
    } catch (error) {
      if (isAbortError(error) || response.interrupted) return;
      response.tts?.cancel();
      if (this.activeResponse?.id === response.id) this.activeResponse = undefined;
      this.sendError("PIPELINE_ERROR", error instanceof Error ? error.message : String(error), true);
    }
  }

  private sendModeState(): void {
    const state = this.audioIntelligence?.modes.getState();
    if (!state) return;
    this.send({
      type: "mode.changed",
      configuredMode: state.configuredMode,
      activeMode: state.activeMode,
      source: state.source,
    });
  }

  private interrupt(reason: "barge_in" | "client_cancel" | "new_turn"): void {
    const response = this.activeResponse;
    if (!response || response.interrupted) return;
    response.interrupted = true;
    response.abortController.abort();
    response.tts?.cancel();
    this.send({ type: "response.interrupted", responseId: response.id, reason });
    this.activeResponse = undefined;
  }

  private trimHistory(): void {
    const system = this.history.find((item) => item.role === "system");
    const nonSystem = this.history.filter((item) => item.role !== "system");
    const trimmed = nonSystem.slice(-this.config.conversation.maxHistoryMessages);
    this.history = system ? [system, ...trimmed] : trimmed;
  }

  private send(event: ServerEvent): void {
    if (this.client.readyState !== WebSocket.OPEN) return;
    this.client.send(JSON.stringify(event));
  }

  private sendError(code: string, message: string, retryable: boolean): void {
    this.send({ type: "error", code, message, retryable });
  }
}

function buildModeInstruction(
  configuredMode: InteractionMode,
  activeMode: "owner_focus" | "group",
  proactivity: number,
  switchedByVoice: boolean,
): string {
  const activeDescription = activeMode === "group"
    ? "当前处于多人聊天模式。要理解不同参与者的上下文，不要每句话都抢答；只有被明确询问，或出现非常合适且有价值的自然插话机会时才发言。"
    : "当前处于专注模式。主要和设备主人持续交流，忽略无关背景对话。";
  const switchInstruction = switchedByVoice
    ? "用户刚刚通过语音切换了交互模式，请先用一句很自然的话简短确认，然后继续当前对话。"
    : "";
  return `${activeDescription} 用户配置模式=${configuredMode}，主动参与程度=${proactivity.toFixed(2)}。${switchInstruction}`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted"));
}
