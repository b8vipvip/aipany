import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  INPUT_AUDIO_FORMAT,
  OUTPUT_AUDIO_FORMAT,
  type AudioFormat,
  type GroupTranscriptSegment,
  type InteractionMode,
  type ServerEvent,
  type SessionStartEvent,
  type SpeakerAttribution,
  type UserEmotion,
} from "@aipany/protocol";
import {
  AudioIntelligenceEngine,
  HttpSpeakerIntelligenceProvider,
  type EnvironmentContext,
  type SpeakerDiarizationSegment,
  type SpeakerIdentityStore,
  type SpeakerObservation,
} from "@aipany/audio-intelligence";
import { assertSessionIdentity, requireScope, type AuthContext } from "../auth.js";
import type { AppConfig } from "../config.js";
import { StreamingAudioFrontEnd } from "../audio/streaming-audio-front-end.js";
import { QwenAsrRealtimeClient } from "../providers/qwen-asr.js";
import { QwenTtsRealtimeClient } from "../providers/qwen-tts.js";
import { OpenAiCompatibleLlm, type ChatMessage } from "../providers/openai-compatible-llm.js";
import { EmotionDirector } from "../pipeline/emotion-director.js";
import { StreamingTextChunker } from "../pipeline/text-chunker.js";
import { buildEnvironmentInstruction, evaluateSocialTurn } from "../social/social-turn-evaluator.js";
import {
  UtteranceSpeakerAnalyzer,
  type UtteranceSpeakerAnalysis,
} from "../speaker/utterance-speaker-analyzer.js";

interface ActiveResponse {
  id: string;
  abortController: AbortController;
  tts?: QwenTtsRealtimeClient;
  interrupted: boolean;
}

interface SpeakerAnalysisOutcome {
  analysis: UtteranceSpeakerAnalysis;
  attribution?: SpeakerAttribution;
  groupSegments: GroupTranscriptSegment[];
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
  private audioFrontEnd?: StreamingAudioFrontEnd;
  private readonly pendingSpeakerAnalyses: Array<Promise<SpeakerAnalysisOutcome | undefined>> = [];
  private activeEnrollmentId?: string;
  private ownerEmbedding?: number[];
  private speakerConsentGranted = false;
  private socialProactivity = 0.45;
  private assistantAliases: string[] = ["Aipany"];
  private locale = "zh-CN";
  private inputAudioFormat: AudioFormat = INPUT_AUDIO_FORMAT;
  private readonly recentHumanTurns: string[] = [];
  private readonly recentAiInterventions: number[] = [];
  private lastAiSpokeAt = 0;
  private lastSpeechStoppedAt = 0;
  private lastFrontEndMetricsAt = 0;
  private started = false;
  private closed = false;

  constructor(
    private readonly client: WebSocket,
    private readonly config: AppConfig,
    private readonly identityStore: SpeakerIdentityStore,
    private readonly authContext: AuthContext,
  ) {
    this.llm = new OpenAiCompatibleLlm(config.llm);
  }

  async start(event: SessionStartEvent): Promise<void> {
    if (this.started) throw new Error("会话已经启动");
    requireScope(this.authContext, "realtime");
    assertSessionIdentity(this.authContext, event.session);
    this.started = true;
    this.socialProactivity = event.session.socialProactivity;
    this.assistantAliases = event.session.assistantAliases;
    this.locale = event.session.locale;
    this.inputAudioFormat = {
      encoding: event.session.inputAudio.encoding,
      sampleRate: event.session.inputAudio.sampleRate,
      channels: event.session.inputAudio.channels,
    };

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

    const consent = await this.identityStore.getConsent?.(this.audioIntelligence.identityScope);
    this.speakerConsentGranted = this.config.speakerIdentity.consentRequired ? Boolean(consent?.granted) : true;
    if (this.speakerConsentGranted) await this.refreshOwnerEmbedding();

    this.audioFrontEnd = new StreamingAudioFrontEnd({
      inputFormat: this.inputAudioFormat,
      enabled: this.config.audioFrontEnd.enabled,
      aec: this.config.audioFrontEnd.aec,
      noiseSuppression: this.config.audioFrontEnd.noiseSuppression,
      agc: this.config.audioFrontEnd.agc,
      dereverb: this.config.audioFrontEnd.dereverb,
      beamforming: this.config.audioFrontEnd.beamforming,
      beamformingDelaysSamples: event.session.inputAudio.beamformingDelaysSamples,
      aecDelayMs: this.config.audioFrontEnd.aecDelayMs,
      targetRmsDbfs: this.config.audioFrontEnd.targetRmsDbfs,
      maxGain: this.config.audioFrontEnd.maxGain,
    });

    if (this.config.speaker.enabled) {
      const provider = new HttpSpeakerIntelligenceProvider({
        baseUrl: this.config.speaker.baseUrl,
        token: this.config.speaker.token,
        timeoutMs: this.config.speaker.timeoutMs,
        analysisTimeoutMs: this.config.speaker.analysisTimeoutMs,
      });
      this.speakerAnalyzer = new UtteranceSpeakerAnalyzer(provider, {
        minAudioMs: this.config.speaker.minAudioMs,
        preRollMs: this.config.speaker.preRollMs,
        sessionMatchThreshold: this.config.speaker.sessionMatchThreshold,
        format: INPUT_AUDIO_FORMAT,
      });
      void provider.healthCheck?.().then((ok) => {
        if (!ok && !this.closed) {
          this.sendError("SPEAKER_INTELLIGENCE_UNAVAILABLE", "Audio Intelligence 服务当前不可用，主语音链路将自动降级继续运行", true);
        }
      });
    }

    const systemPrompt = event.session.systemPrompt?.trim() || this.config.conversation.defaultSystemPrompt;
    this.history = [{ role: "system", content: systemPrompt }];

    this.send({
      type: "session.created",
      sessionId: this.id,
      inputAudio: this.inputAudioFormat,
      outputAudio: OUTPUT_AUDIO_FORMAT,
    });
    this.sendModeState();
    this.send({ type: "speaker.consent.updated", granted: this.speakerConsentGranted });

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
      this.lastSpeechStoppedAt = Date.now();
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
    try {
      const processed = this.audioFrontEnd?.process(audio);
      const analysisAudio = processed?.analysisAudio ?? audio;
      const asrAudio = processed?.asrAudio ?? audio;
      this.speakerAnalyzer?.append(analysisAudio);
      this.asr?.appendAudio(asrAudio);

      if (processed && this.config.audioFrontEnd.metricsIntervalMs > 0) {
        const now = Date.now();
        if (now - this.lastFrontEndMetricsAt >= this.config.audioFrontEnd.metricsIntervalMs) {
          this.lastFrontEndMetricsAt = now;
          this.send({ type: "audio.frontend.metrics", ...processed.metrics });
        }
      }
    } catch (error) {
      this.sendError("AUDIO_FRONTEND_ERROR", error instanceof Error ? error.message : String(error), true);
      this.speakerAnalyzer?.append(audio);
      this.asr?.appendAudio(audio);
    }
  }

  commitAudio(): void {
    // 当前仍以 Qwen Server VAD 为主；协议保留手动 commit 供后续硬件端点检测使用。
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

  async setSpeakerConsent(granted: boolean): Promise<void> {
    requireScope(this.authContext, "speaker:write");
    const engine = this.requireEngine();
    const state = await this.identityStore.setConsent?.(
      engine.identityScope,
      granted,
      this.authContext.subject ?? engine.identityScope.userId,
    );
    this.speakerConsentGranted = state?.granted ?? granted;
    if (this.speakerConsentGranted) await this.refreshOwnerEmbedding();
    this.send({ type: "speaker.consent.updated", granted: this.speakerConsentGranted });
  }

  async revokeSpeakerConsent(deleteExisting: boolean): Promise<void> {
    requireScope(this.authContext, "speaker:write");
    const engine = this.requireEngine();
    await this.setSpeakerConsent(false);
    this.ownerEmbedding = undefined;
    if (this.activeEnrollmentId) {
      engine.enrollments.cancel(this.activeEnrollmentId);
      this.activeEnrollmentId = undefined;
    }
    if (deleteExisting) {
      if (this.identityStore.deleteAllPeople) {
        await this.identityStore.deleteAllPeople(engine.identityScope);
      } else {
        const people = await this.identityStore.listPeople(engine.identityScope);
        for (const person of people) await this.identityStore.deletePerson(engine.identityScope, person.id);
      }
    }
  }

  async sendSpeakerConsentStatus(): Promise<void> {
    const engine = this.requireEngine();
    const consent = await this.identityStore.getConsent?.(engine.identityScope);
    const granted = this.config.speakerIdentity.consentRequired ? Boolean(consent?.granted) : true;
    this.speakerConsentGranted = granted;
    this.send({ type: "speaker.consent.updated", granted });
  }

  async listSpeakerIdentities(): Promise<void> {
    requireScope(this.authContext, "speaker:read");
    const engine = this.requireEngine();
    const people = await this.identityStore.listPeople(engine.identityScope);
    this.send({
      type: "speaker.identity.list",
      people: people.map((person) => ({
        personId: person.id,
        name: person.name,
        relation: person.relation,
        isOwner: person.isOwner,
        voiceProfileId: person.voiceProfileId,
      })),
    });
  }

  async startSpeakerEnrollment(input: { personName: string; relation?: string; isOwner?: boolean }): Promise<void> {
    requireScope(this.authContext, "speaker:write");
    const engine = this.requireEngine();
    if (this.config.speakerIdentity.consentRequired && !this.speakerConsentGranted) {
      throw new Error("开始长期声纹学习前必须先获得用户授权 speaker.consent.grant");
    }
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
    requireScope(this.authContext, "speaker:write");
    const engine = this.requireEngine();
    if (this.activeEnrollmentId) {
      const enrollment = engine.enrollments.get(this.activeEnrollmentId);
      if (enrollment?.personId === personId) {
        engine.enrollments.cancel(this.activeEnrollmentId);
        this.activeEnrollmentId = undefined;
      }
    }
    const deleted = await engine.identities.deletePerson(engine.identityScope, personId);
    if (!deleted) throw new Error("人物不存在或无权删除");
    await this.refreshOwnerEmbedding();
    this.send({ type: "speaker.identity.deleted", personId });
  }

  async observeSpeaker(observation: SpeakerObservation): Promise<SpeakerAttribution | undefined> {
    const engine = this.audioIntelligence;
    if (!engine) return undefined;

    const allowIdentity = this.speakerConsentGranted || !this.config.speakerIdentity.consentRequired;
    const result = allowIdentity
      ? await engine.observeSpeaker(observation)
      : { match: undefined, suggestion: engine.modes.observeSpeaker(observation) };
    const { match, suggestion } = result;
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
    if (allowIdentity && this.activeEnrollmentId) {
      const enrollmentResult = await engine.enrollments.ingest(this.activeEnrollmentId, observation);
      enrollmentPersonId = enrollmentResult.state.personId;
      enrollmentPersonName = enrollmentResult.state.personName;
      enrollmentConfirmed = enrollmentResult.state.status === "confirmed";
      this.send({
        type: "speaker.enrollment.updated",
        enrollmentId: enrollmentResult.state.id,
        acceptedSamples: enrollmentResult.state.acceptedSamples,
        status: enrollmentResult.state.status,
      });
      if (enrollmentResult.state.status === "confirmed") {
        this.activeEnrollmentId = undefined;
        await this.refreshOwnerEmbedding();
      }
    }

    const enrolledPerson = enrollmentPersonId
      ? await engine.identities.getPerson(engine.identityScope, enrollmentPersonId)
      : undefined;
    const attribution: SpeakerAttribution = {
      sessionSpeakerId: observation.sessionSpeakerId,
      personId: allowIdentity ? match?.person?.id ?? enrollmentPersonId : undefined,
      personName: allowIdentity ? match?.person?.name ?? enrollmentPersonName : undefined,
      isOwner: allowIdentity
        ? match?.person?.isOwner ?? enrolledPerson?.isOwner ?? Boolean(observation.isOwnerHint)
        : Boolean(observation.isOwnerHint),
      confident: allowIdentity && Boolean(match?.confident || enrollmentConfirmed),
      similarity: allowIdentity ? match?.similarity ?? (enrollmentPersonId ? 1 : 0) : 0,
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
    this.audioFrontEnd?.reset();
    this.audioFrontEnd = undefined;
    this.pendingSpeakerAnalyses.splice(0);
  }

  private queueSpeakerAnalysis(): void {
    const analyzer = this.speakerAnalyzer;
    if (!analyzer) return;
    const activeMode = this.audioIntelligence?.modes.getState().activeMode ?? "owner_focus";
    const analysis = analyzer.stopSpeechDetailed({
      sessionId: this.id,
      mode: activeMode,
      language: this.locale,
      ownerEmbedding: this.speakerConsentGranted ? this.ownerEmbedding : undefined,
      includeTranscript: this.config.speaker.segmentTranscriptionEnabled && (activeMode === "group" || Boolean(this.ownerEmbedding)),
      enableSeparation: this.config.speaker.separationEnabled && (activeMode === "group" || activeMode === "owner_focus"),
      enableEnvironment: this.config.speaker.environmentEnabled,
    });
    if (!analysis) return;

    const processed = analysis
      .then(async (detailed): Promise<SpeakerAnalysisOutcome | undefined> => {
        if (!detailed || this.closed) return undefined;
        const attribution = await this.observeSpeaker(detailed.observation);
        const groupSegments = await this.attributeDiarizationSegments(detailed, attribution);
        const environment = detailed.audioAnalysis.environment;
        if (environment) this.send({ type: "environment.updated", environment });
        if (groupSegments.length > 0) {
          this.send({
            type: "transcript.group",
            segments: groupSegments,
            overlapDetected: detailed.audioAnalysis.overlapDetected,
          });
        }
        if (detailed.audioAnalysis.targetSpeaker) {
          this.send({
            type: "speaker.target.extracted",
            matched: detailed.audioAnalysis.targetSpeaker.matched,
            similarity: detailed.audioAnalysis.targetSpeaker.similarity,
            confidence: detailed.audioAnalysis.targetSpeaker.confidence,
            transcript: detailed.audioAnalysis.targetSpeaker.transcript,
          });
        }
        return { analysis: detailed, attribution, groupSegments };
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

  private async attributeDiarizationSegments(
    detailed: UtteranceSpeakerAnalysis,
    dominant: SpeakerAttribution | undefined,
  ): Promise<GroupTranscriptSegment[]> {
    const engine = this.audioIntelligence;
    if (!engine) return [];
    const allowIdentity = this.speakerConsentGranted || !this.config.speakerIdentity.consentRequired;
    const output: GroupTranscriptSegment[] = [];

    for (const segment of detailed.audioAnalysis.diarization) {
      let speaker: SpeakerAttribution | undefined;
      if (allowIdentity && segment.embedding?.length) {
        const match = await engine.identities.identify(engine.identityScope, segment.embedding);
        speaker = {
          sessionSpeakerId: segment.speakerId,
          personId: match.person?.id,
          personName: match.person?.name,
          isOwner: Boolean(match.person?.isOwner),
          confident: match.confident,
          similarity: match.similarity,
          observationConfidence: segment.confidence,
        };
      } else if (dominant && dominant.sessionSpeakerId === segment.speakerId) {
        speaker = { ...dominant, observationConfidence: segment.confidence };
      }
      speaker ??= {
        sessionSpeakerId: segment.speakerId,
        isOwner: false,
        confident: false,
        similarity: 0,
        observationConfidence: segment.confidence,
      };
      output.push({
        startMs: segment.startMs,
        endMs: segment.endMs,
        text: segment.transcript,
        overlap: Boolean(segment.overlap),
        confidence: segment.confidence,
        speaker,
      });
    }
    return output;
  }

  private async handleFinalTranscript(
    originalText: string,
    emotion: UserEmotion,
    language?: string,
    speakerAnalysis?: Promise<SpeakerAnalysisOutcome | undefined>,
  ): Promise<void> {
    if (this.closed) return;
    this.interrupt("new_turn");

    const currentMode = this.audioIntelligence?.modes.getState().activeMode ?? "owner_focus";
    const waitMs = currentMode === "group" ? this.config.speaker.groupAnalysisWaitMs : this.config.speaker.analysisWaitMs;
    const outcome = await waitForSpeakerAnalysis(speakerAnalysis, waitMs);
    const speaker = outcome?.attribution;
    const analysis = outcome?.analysis.audioAnalysis;
    let text = originalText;

    if (currentMode === "owner_focus" && this.ownerEmbedding && analysis?.overlapDetected) {
      const target = analysis.targetSpeaker;
      if (target?.matched && target.confidence >= this.config.speaker.targetSpeakerMinConfidence && target.transcript) {
        text = target.transcript;
      } else {
        this.send({
          type: "transcript.final",
          text: originalText,
          emotion,
          language,
          speaker,
        });
        this.send({
          type: "speaker.filtered",
          sessionSpeakerId: speaker?.sessionSpeakerId ?? "overlap_unknown",
          personId: speaker?.personId,
          personName: speaker?.personName,
          reason: "target_speaker_not_matched",
        });
        return;
      }
    }

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

    const groupedText = buildGroupAttributedText(outcome?.groupSegments ?? []);
    const userContent = modeState?.activeMode === "group" && groupedText
      ? groupedText
      : formatSpeakerAttributedText(text, speaker, modeState?.activeMode);
    const socialText = buildPlainGroupText(outcome?.groupSegments ?? []) || text;
    const environment = analysis?.environment;

    let socialAction: "respond" | "stay_silent" | "intervene" = "respond";
    if (modeState?.activeMode === "group" && this.config.conversation.socialDecisionEnabled && this.audioIntelligence) {
      const signals = evaluateSocialTurn({
        text: socialText,
        assistantAliases: this.assistantAliases,
        recentHumanTurns: this.recentHumanTurns,
        environment,
      });
      const now = Date.now();
      trimTimestamps(this.recentAiInterventions, now - 180000);
      const decision = this.audioIntelligence.decideSocialAction({
        mode: modeState.activeMode,
        speakerId: speaker?.sessionSpeakerId ?? "group",
        speakerName: speaker?.personName,
        isOwner: Boolean(speaker?.isOwner),
        text: socialText,
        addressedToAssistant: signals.addressedToAssistant,
        explicitWakeWord: signals.explicitWakeWord,
        directQuestionToAssistant: signals.directQuestionToAssistant,
        naturalPauseMs: Math.max(this.config.qwen.silenceMs, Date.now() - this.lastSpeechStoppedAt),
        humanOverlap: Boolean(analysis?.overlapDetected),
        helpfulnessScore: signals.helpfulnessScore,
        urgencyScore: signals.urgencyScore,
        noveltyScore: signals.noveltyScore,
        recentAiInterventions: this.recentAiInterventions.length,
        secondsSinceAiSpoke: this.lastAiSpokeAt > 0 ? (now - this.lastAiSpokeAt) / 1000 : 999,
        proactivity: this.socialProactivity,
      });
      socialAction = decision.action;
      this.send({ type: "social.decision", action: decision.action, score: decision.score, reason: decision.reason });
      if (decision.action === "intervene") this.recentAiInterventions.push(now);
    }

    this.history.push({ role: "user", content: userContent });
    this.trimHistory();
    this.recentHumanTurns.push(socialText);
    if (this.recentHumanTurns.length > 20) this.recentHumanTurns.splice(0, this.recentHumanTurns.length - 20);
    if (socialAction === "stay_silent") return;

    const requestMessages = [...this.history];
    if (modeState) {
      requestMessages.push({
        role: "system",
        content: buildModeInstruction(modeState.configuredMode, modeState.activeMode, this.socialProactivity, Boolean(modeCommand), socialAction),
      });
    }
    if (speaker) {
      requestMessages.push({ role: "system", content: buildSpeakerInstruction(speaker) });
    }
    const environmentInstruction = buildEnvironmentInstruction(environment);
    if (environmentInstruction) requestMessages.push({ role: "system", content: environmentInstruction });

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
      this.audioFrontEnd?.appendPlaybackReference(audio, this.config.qwen.ttsSampleRate);
      if (!audioStarted) {
        audioStarted = true;
        this.send({ type: "response.audio.started", responseId: response.id, format: OUTPUT_AUDIO_FORMAT });
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
      this.lastAiSpokeAt = Date.now();
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

  private async refreshOwnerEmbedding(): Promise<void> {
    const engine = this.audioIntelligence;
    if (!engine || !this.speakerConsentGranted) {
      this.ownerEmbedding = undefined;
      return;
    }
    const people = await engine.identities.listPeople(engine.identityScope);
    const owner = people.find((person) => person.isOwner && person.voiceProfileId);
    if (!owner) {
      this.ownerEmbedding = undefined;
      return;
    }
    const profile = await engine.identities.getProfileByPerson(engine.identityScope, owner.id);
    this.ownerEmbedding = profile?.status === "confirmed" ? [...profile.centroid] : undefined;
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
    this.audioFrontEnd?.clearPlaybackReference();
    this.send({ type: "response.interrupted", responseId: response.id, reason });
    this.activeResponse = undefined;
  }

  private trimHistory(): void {
    const system = this.history.find((item) => item.role === "system");
    const nonSystem = this.history.filter((item) => item.role !== "system");
    const trimmed = nonSystem.slice(-this.config.conversation.maxHistoryMessages);
    this.history = system ? [system, ...trimmed] : trimmed;
  }

  private requireEngine(): AudioIntelligenceEngine {
    if (!this.audioIntelligence) throw new Error("会话尚未启动");
    return this.audioIntelligence;
  }

  private send(event: ServerEvent): void {
    if (this.client.readyState !== WebSocket.OPEN) return;
    this.client.send(JSON.stringify(event));
  }

  private sendError(code: string, message: string, retryable: boolean): void {
    this.send({ type: "error", code, message, retryable });
  }
}

function buildGroupAttributedText(segments: GroupTranscriptSegment[]): string | undefined {
  const lines = segments
    .filter((segment) => segment.text?.trim())
    .map((segment) => `[${segment.speaker.personName ?? segment.speaker.sessionSpeakerId}] ${segment.text!.trim()}`);
  return lines.length ? lines.join("\n") : undefined;
}

function buildPlainGroupText(segments: GroupTranscriptSegment[]): string | undefined {
  const values = segments.map((segment) => segment.text?.trim()).filter((value): value is string => Boolean(value));
  return values.length ? values.join(" ") : undefined;
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
  socialAction: "respond" | "stay_silent" | "intervene",
): string {
  const activeDescription = activeMode === "group"
    ? "当前处于多人聊天模式。理解不同参与者的上下文，不要每句话都抢答；被明确询问时正常回答，主动插话时只说真正有价值且适合在自然停顿说出的内容。"
    : "当前处于专注模式。主要和设备主人持续交流；系统已尽量在混合声音中提取主人音轨，并保守过滤已确认的非主人。";
  const switchInstruction = switchedByVoice
    ? "用户刚刚通过语音切换了交互模式，请先用一句很自然的话简短确认，然后继续当前对话。"
    : "";
  const interventionInstruction = socialAction === "intervene"
    ? "这次是你主动加入人类对话，不要假装有人问了你；先用自然的过渡语，再简短说出最有价值的信息。"
    : "";
  return `${activeDescription} 用户配置模式=${configuredMode}，主动参与程度=${proactivity.toFixed(2)}。${switchInstruction}${interventionInstruction}`;
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

function trimTimestamps(values: number[], minimum: number): void {
  while ((values[0] ?? Infinity) < minimum) values.shift();
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message.includes("aborted"));
}
