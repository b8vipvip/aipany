import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  INPUT_AUDIO_FORMAT,
  OUTPUT_AUDIO_FORMAT,
  type InteractionMode,
  type ServerEvent,
  type SessionStartEvent,
  type SpeakerAttribution,
  type UserEmotion,
} from "@aipany/protocol";
import {
  AudioIntelligenceEngine,
  HttpSpeakerIntelligenceProvider,
  type SpeakerIdentityStore,
  type SpeakerObservation,
} from "@aipany/audio-intelligence";
import type { AppConfig } from "../config.js";
import { QwenAsrRealtimeClient } from "../providers/qwen-asr.js";
import { QwenTtsRealtimeClient } from "../providers/qwen-tts.js";
import { OpenAiCompatibleLlm, type ChatMessage } from "../providers/openai-compatible-llm.js";
import { EmotionDirector } from "../pipeline/emotion-director.js";
import { StreamingTextChunker } from "../pipeline/text-chunker.js";
import { UtteranceSpeakerAnalyzer } from "../speaker/utterance-speaker-analyzer.js";

interface ActiveResponse {
  id: string;
  abortController: AbortController;
  tts?: QwenTtsRealtimeClient;
  interrupted: boolean;
}

interface SpeakerAnalysisOutcome {
  observation: SpeakerObservation;
  attribution?: SpeakerAttribution;
}

export class RealtimeSession {
  readonly id = randomUUID();
  private asr?: QwenAsrRealtimeClient;
  private readonly llm: OpenAiCompatibleLlm;
  private readonly emotionDirector = new EmotionDirector();
  private history: ChatMessage[] = [];
  private activeResponse?: ActiveResponse;
  private audioIntelligence?: AudioIntelligenceEngine;
  private speakerAnalyzer?: UtteranceSpeakerAnalyzer;
  private readonly pendingSpeakerAnalyses: Array<Promise<SpeakerAnalysisOutcome | undefined>> = [];
  private activeEnrollmentId?: string;
  private socialProactivity = 0.45;
  private started = false;
  private closed = false;

  constructor(
    private readonly client: WebSocket,
    private readonly config: AppConfig,
    private readonly identityStore: SpeakerIdentityStore,
  ) {
    this.llm = new OpenAiCompatibleLlm(config.llm);
  }

  async start(event: SessionStartEvent): Promise<void> {
    if (this.started) throw new Error("会话已经启动");
    this.started = true;
    this.socialProactivity = event.session.socialProactivity;
    this.audioIntelligence = new AudioIntelligenceEngine({
      identityStore: this.identityStore,
      identityScope: {
        tenantId: event.session.tenantId,
        userId: event.session.userId,
      },
      mode: {
        initialMode: event.session.interactionMode,
        initialActiveMode: event.session.interactionMode === "group" ? "group" : "owner_focus",
      },
    });

    if (this.config.speaker.enabled) {
      const provider = new HttpSpeakerIntelligenceProvider({
        baseUrl: this.config.speaker.baseUrl,
        token: this.config.speaker.token,
        timeoutMs: this.config.speaker.timeoutMs,
      });
      this.speakerAnalyzer = new UtteranceSpeakerAnalyzer(provider, {
        minAudioMs: this.config.speaker.minAudioMs,
        preRollMs: this.config.speaker.preRollMs,
        sessionMatchThreshold: this.config.speaker.sessionMatchThreshold,
      });
      void provider.healthCheck?.().then((ok) => {
        if (!ok && !this.closed) {
          this.sendError("SPEAKER_INTELLIGENCE_UNAVAILABLE", "Speaker Intelligence 服务当前不可用，语音对话将继续但暂不进行声纹识别", true);
        }
      });
    }

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
      this.speakerAnalyzer?.startSpeech();
      this.send({ type: "input_audio_buffer.speech_started" });
      this.interrupt("barge_in");
    });
    asr.on("speechStopped", () => {
      this.queueSpeakerAnalysis();
      this.send({ type: "input_audio_buffer.speech_stopped" });
    });
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
      const speakerAnalysis = this.pendingSpeakerAnalyses.shift();
      void this.handleFinalTranscript(result.text, result.emotion, result.language, speakerAnalysis);
    });
    asr.on("error", (error) => this.sendError("ASR_ERROR", error.message, true));

    await asr.connect();
    this.send({ type: "session.ready", sessionId: this.id });
  }

  appendAudio(audio: Buffer): void {
    if (!this.started || this.closed) return;
    this.speakerAnalyzer?.append(audio);
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

  async startSpeakerEnrollment(input: { personName: string; relation?: string; isOwner?: boolean }): Promise<void> {
    const engine = this.audioIntelligence;
    if (!engine) return;
    const enrollment = await engine.enrollments.begin({
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

  async deleteSpeakerIdentity(personId: string): Promise<void> {
    const engine = this.audioIntelligence;
    if (!engine) throw new Error("会话尚未启动");

    if (this.activeEnrollmentId) {
      const enrollment = engine.enrollments.get(this.activeEnrollmentId);
      if (enrollment?.personId === personId) {
        engine.enrollments.cancel(this.activeEnrollmentId);
        this.activeEnrollmentId = undefined;
      }
    }

    const deleted = await engine.identities.deletePerson(engine.identityScope, personId);
    if (!deleted) throw new Error("人物不存在或无权删除");
    this.send({ type: "speaker.identity.deleted", personId });
  }

  /**
   * Speaker Provider 的统一业务入口。
   * 它同时驱动长期身份匹配、渐进式声纹学习、自动模式建议以及客户端说话人事件。
   */
  async observeSpeaker(observation: SpeakerObservation): Promise<SpeakerAttribution | undefined> {
    const engine = this.audioIntelligence;
    if (!engine) return undefined;

    const { match, suggestion } = await engine.observeSpeaker(observation);
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

    let enrollmentPersonId: string | undefined;
    let enrollmentPersonName: string | undefined;
    let enrollmentConfirmed = false;
    if (this.activeEnrollmentId) {
      const result = await engine.enrollments.ingest(this.activeEnrollmentId, observation);
      enrollmentPersonId = result.state.personId;
      enrollmentPersonName = result.state.personName;
      enrollmentConfirmed = result.state.status === "confirmed";
      this.send({
        type: "speaker.enrollment.updated",
        enrollmentId: result.state.id,
        acceptedSamples: result.state.acceptedSamples,
        status: result.state.status,
      });
      if (result.state.status === "confirmed") this.activeEnrollmentId = undefined;
    }

    const enrolledPerson = enrollmentPersonId
      ? await engine.identities.getPerson(engine.identityScope, enrollmentPersonId)
      : undefined;
    const attribution: SpeakerAttribution = {
      sessionSpeakerId: observation.sessionSpeakerId,
      personId: match?.person?.id ?? enrollmentPersonId,
      personName: match?.person?.name ?? enrollmentPersonName,
      isOwner: match?.person?.isOwner ?? enrolledPerson?.isOwner ?? Boolean(observation.isOwnerHint),
      confident: Boolean(match?.confident || enrollmentConfirmed),
      similarity: match?.similarity ?? (enrollmentPersonId ? 1 : 0),
      observationConfidence: observation.confidence,
    };

    this.send({ type: "speaker.identified", speaker: attribution });
    return attribution;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.interrupt("client_cancel");
    this.asr?.close();
    this.asr = undefined;
    this.speakerAnalyzer?.reset();
    this.speakerAnalyzer = undefined;
    this.pendingSpeakerAnalyses.splice(0);
  }

  private queueSpeakerAnalysis(): void {
    const analysis = this.speakerAnalyzer?.stopSpeech();
    if (!analysis) return;

    const processed = analysis
      .then(async (observation): Promise<SpeakerAnalysisOutcome | undefined> => {
        if (!observation || this.closed) return undefined;
        return {
          observation,
          attribution: await this.observeSpeaker(observation),
        };
      })
      .catch((error) => {
        if (!this.closed) {
          this.sendError(
            "SPEAKER_INTELLIGENCE_ERROR",
            error instanceof Error ? error.message : String(error),
            true,
          );
        }
        return undefined;
      });

    this.pendingSpeakerAnalyses.push(processed);
    if (this.pendingSpeakerAnalyses.length > 8) this.pendingSpeakerAnalyses.shift();
  }

  private async handleFinalTranscript(
    text: string,
    emotion: UserEmotion,
    language?: string,
    speakerAnalysis?: Promise<SpeakerAnalysisOutcome | undefined>,
  ): Promise<void> {
    if (this.closed) return;
    this.interrupt("new_turn");

    const outcome = await waitForSpeakerAnalysis(speakerAnalysis, this.config.speaker.analysisWaitMs);
    const speaker = outcome?.attribution;

    this.send({
      type: "transcript.final",
      text,
      emotion,
      language,
      speaker,
    });

    const modeStateBeforeCommand = this.audioIntelligence?.modes.getState();
    const isConfidentNonOwner = Boolean(speaker?.confident && speaker.personId && !speaker.isOwner);
    const modeCommand = !isConfidentNonOwner ? this.audioIntelligence?.detectModeCommand(text) : undefined;
    if (modeCommand) this.setInteractionMode(modeCommand, "voice_command");

    const modeState = this.audioIntelligence?.modes.getState() ?? modeStateBeforeCommand;
    if (modeState?.activeMode === "owner_focus" && isConfidentNonOwner && speaker) {
      this.send({
        type: "speaker.filtered",
        sessionSpeakerId: speaker.sessionSpeakerId,
        personId: speaker.personId,
        personName: speaker.personName,
        reason: "owner_focus_non_owner",
      });
      return;
    }

    const userContent = formatSpeakerAttributedText(text, speaker, modeState?.activeMode);
    this.history.push({ role: "user", content: userContent });
    this.trimHistory();

    const requestMessages = [...this.history];
    if (modeState) {
      requestMessages.push({
        role: "system",
        content: buildModeInstruction(modeState.configuredMode, modeState.activeMode, this.socialProactivity, Boolean(modeCommand)),
      });
    }
    if (speaker) {
      requestMessages.push({
        role: "system",
        content: buildSpeakerInstruction(speaker),
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

function formatSpeakerAttributedText(
  text: string,
  speaker: SpeakerAttribution | undefined,
  activeMode: "owner_focus" | "group" | undefined,
): string {
  if (activeMode !== "group" || !speaker) return text;
  const label = speaker.personName ?? speaker.sessionSpeakerId;
  return `[${label}] ${text}`;
}

function buildSpeakerInstruction(speaker: SpeakerAttribution): string {
  const identity = speaker.personName
    ? `当前发言者识别为“${speaker.personName}”${speaker.isOwner ? "，是设备主人" : ""}`
    : `当前发言者暂记为 ${speaker.sessionSpeakerId}，尚未确认真实身份`;
  const confidence = speaker.confident
    ? `身份匹配置信较高，相似度=${speaker.similarity.toFixed(3)}`
    : `身份尚未可靠确认，相似度=${speaker.similarity.toFixed(3)}，不要擅自断言其真实姓名`;
  return `${identity}。${confidence}。`;
}

function buildModeInstruction(
  configuredMode: InteractionMode,
  activeMode: "owner_focus" | "group",
  proactivity: number,
  switchedByVoice: boolean,
): string {
  const activeDescription = activeMode === "group"
    ? "当前处于多人聊天模式。要理解不同参与者的上下文，不要每句话都抢答；只有被明确询问，或出现非常合适且有价值的自然插话机会时才发言。"
    : "当前处于专注模式。主要和设备主人持续交流，已确认的非主人发言应被系统过滤。";
  const switchInstruction = switchedByVoice
    ? "用户刚刚通过语音切换了交互模式，请先用一句很自然的话简短确认，然后继续当前对话。"
    : "";
  return `${activeDescription} 用户配置模式=${configuredMode}，主动参与程度=${proactivity.toFixed(2)}。${switchInstruction}`;
}

async function waitForSpeakerAnalysis(
  analysis: Promise<SpeakerAnalysisOutcome | undefined> | undefined,
  waitMs: number,
): Promise<SpeakerAnalysisOutcome | undefined> {
  if (!analysis || waitMs <= 0) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      analysis,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), waitMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted"));
}
