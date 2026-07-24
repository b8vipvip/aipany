import type { SessionStartEvent, UserEmotion } from "@aipany/protocol";
import WebSocket from "ws";
import { resolveRequestedVoice } from "../mobile/client-capabilities.js";
import { BackchannelEngine, getBackchannelAudio } from "../pipeline/backchannel-engine.js";
import { InterruptionMemory } from "../pipeline/interruption-memory.js";
import { SemanticTurnManager } from "../pipeline/semantic-turn-manager.js";
import {
  buildSpeculativeMessages,
  SpeculativeLlmCoordinator,
  StablePartialTracker,
  type StreamChatFunction,
} from "../pipeline/speculative-llm.js";
import type { ChatMessage } from "../providers/openai-compatible-llm.js";
import { QwenTtsRealtimeClient } from "../providers/qwen-tts.js";
import { RealtimeSession } from "./realtime-session.js";

interface RealtimeSessionInternals {
  client: WebSocket;
  asr?: {
    commit(): void;
    on(event: "partial", listener: (result: { text: string; emotion: UserEmotion }) => void): unknown;
    on(event: "speechStarted", listener: () => void): unknown;
    on(event: "speechStopped", listener: () => void): unknown;
    on(event: "final", listener: () => void): unknown;
  };
  llm: { streamChat: StreamChatFunction };
  history: ChatMessage[];
  activeResponse?: { id: string };
  audioIntelligence?: {
    modes: { getState(): { activeMode: "owner_focus" | "group" } };
  };
  config: {
    qwen: {
      apiKey: string;
      workspaceId?: string;
      ttsBaseUrl: string;
      ttsModel: string;
      ttsVoice: string;
      ttsLanguage: string;
      ttsSampleRate: number;
      optimizeInstructions: boolean;
      silenceMs: number;
    };
    speaker: { analysisWaitMs: number };
    speakerIdentity: { consentRequired: boolean };
  };
  speakerConsentGranted: boolean;
}

export interface OwnerFocusSpeakerWaitPolicyInput {
  configuredWaitMs: number;
  consentRequired: boolean;
  consentGranted: boolean;
}

export function resolveOwnerFocusSpeakerAnalysisWaitMs(
  input: OwnerFocusSpeakerWaitPolicyInput,
): number {
  if (!input.consentRequired || input.consentGranted) return input.configuredWaitMs;
  return 0;
}

/**
 * Economy Live low-latency interaction layer.
 *
 * Phase 1:
 * - stable-partial speculative LLM
 * - TTS websocket prewarm
 *
 * Phase 2:
 * - semantic commit delay so thought pauses do not become forced new turns
 * - conservative cached backchannels during long continuous narration
 * - one-turn interruption memory so the next answer can continue instead of
 *   restarting from the beginning
 */
export class LowLatencyRealtimeSession extends RealtimeSession {
  private configuredOwnerFocusSpeakerAnalysisWaitMs?: number;
  private readonly partialTracker = new StablePartialTracker();
  private readonly semanticTurnManager = new SemanticTurnManager();
  private readonly backchannelEngine = new BackchannelEngine();
  private readonly interruptionMemory = new InterruptionMemory();
  private speculativeLlm?: SpeculativeLlmCoordinator;
  private optimizationHooksInstalled = false;
  private continuityHookInstalled = false;
  private pendingCommitTimer?: ReturnType<typeof setTimeout>;
  private backchannelEpoch = 0;
  private backchannelSpeechActive = false;
  private backchannelInFlight = false;
  private currentResponseText = "";

  override async start(event: SessionStartEvent): Promise<void> {
    const state = this.internals();
    state.config.qwen.ttsVoice = resolveRequestedVoice(
      state.config.qwen.ttsModel,
      state.config.qwen.ttsVoice,
      event.session.outputVoice,
    );
    // Android clients continuously stream PCM and explicitly send local endpoint
    // commits. Give the upstream VAD more room for thinking pauses while the
    // semantic commit policy handles clear completions earlier.
    if (event.session.device.platform.toLowerCase() === "android") {
      state.config.qwen.silenceMs = Math.max(state.config.qwen.silenceMs, 1_200);
    }
    this.installClientContinuityHook(state);
    this.installSpeculativeLlm(state);
    await super.start(event);
    this.syncOwnerFocusSpeakerAnalysisWait();
    this.installOptimizationHooks();
  }

  override commitAudio(): void {
    const candidate = this.partialTracker.current()?.text ?? "";
    this.scheduleSemanticCommit(candidate);
  }

  override async setSpeakerConsent(granted: boolean): Promise<void> {
    await super.setSpeakerConsent(granted);
    this.syncOwnerFocusSpeakerAnalysisWait();
  }

  override async revokeSpeakerConsent(deleteExisting: boolean): Promise<void> {
    await super.revokeSpeakerConsent(deleteExisting);
    this.syncOwnerFocusSpeakerAnalysisWait();
  }

  override async sendSpeakerConsentStatus(): Promise<void> {
    await super.sendSpeakerConsentStatus();
    this.syncOwnerFocusSpeakerAnalysisWait();
  }

  override close(): void {
    this.clearPendingCommit();
    this.speculativeLlm?.cancel("session_closed");
    this.backchannelEpoch += 1;
    this.backchannelSpeechActive = false;
    super.close();
  }

  private installSpeculativeLlm(state: RealtimeSessionInternals): void {
    if (this.speculativeLlm) return;
    const original = state.llm.streamChat.bind(state.llm);
    this.speculativeLlm = new SpeculativeLlmCoordinator(original);
    state.llm.streamChat = (options) => {
      const continuity = this.interruptionMemory.consumeInstruction();
      const messages = continuity
        ? [...options.messages, { role: "system" as const, content: continuity }]
        : options.messages;
      return this.speculativeLlm!.streamOrAdopt({ ...options, messages });
    };
  }

  private installClientContinuityHook(state: RealtimeSessionInternals): void {
    if (this.continuityHookInstalled) return;
    this.continuityHookInstalled = true;
    const originalSend = state.client.send.bind(state.client) as (...args: unknown[]) => boolean;
    (state.client as unknown as { send: (...args: unknown[]) => boolean }).send = (...args: unknown[]): boolean => {
      const data = args[0];
      if (typeof data === "string") {
        try {
          const event = JSON.parse(data) as Record<string, unknown>;
          const type = typeof event.type === "string" ? event.type : "";
          if (type === "response.created") {
            this.currentResponseText = "";
          } else if (type === "response.text.delta") {
            const delta = typeof event.delta === "string" ? event.delta : "";
            this.currentResponseText += delta;
          } else if (type === "response.interrupted") {
            const reason = normalizeInterruptReason(event.reason);
            this.interruptionMemory.remember({
              generatedText: this.currentResponseText,
              reason,
            });
            this.currentResponseText = "";
          } else if (type === "response.done") {
            this.currentResponseText = "";
          }
        } catch {
          // Ignore non-JSON text frames.
        }
      }
      return originalSend(...args);
    };
  }

  private installOptimizationHooks(): void {
    if (this.optimizationHooksInstalled) return;
    const asr = this.internals().asr;
    if (!asr) return;
    this.optimizationHooksInstalled = true;

    asr.on("speechStarted", () => {
      this.clearPendingCommit();
      this.partialTracker.reset();
      this.speculativeLlm?.cancel("new_speech");
      this.backchannelEpoch += 1;
      this.backchannelSpeechActive = true;
      this.backchannelEngine.beginSpeech();
      this.prewarmTts();
    });
    asr.on("partial", (result) => {
      this.partialTracker.observe(result.text);
      if (this.pendingCommitTimer) this.scheduleSemanticCommit(result.text);
      if (this.partialTracker.shouldStartEarly()) this.startSpeculation();
      this.maybeSendBackchannel(result.text, result.emotion);
    });
    asr.on("speechStopped", () => {
      this.clearPendingCommit();
      this.backchannelSpeechActive = false;
      this.backchannelEngine.endSpeech();
      this.startSpeculation();
      this.prewarmTts();
    });
    asr.on("final", () => {
      this.clearPendingCommit();
      this.backchannelSpeechActive = false;
      this.backchannelEngine.endSpeech();
    });
  }

  private scheduleSemanticCommit(text: string): void {
    const asr = this.internals().asr;
    if (!asr) return;
    const decision = this.semanticTurnManager.decide(text);
    this.clearPendingCommit();
    if (decision.completion === "complete" || decision.completion === "likely_complete") {
      this.backchannelEpoch += 1;
      this.backchannelSpeechActive = false;
    }
    this.pendingCommitTimer = setTimeout(() => {
      this.pendingCommitTimer = undefined;
      asr.commit();
    }, decision.commitDelayMs);
    this.pendingCommitTimer.unref?.();
  }

  private clearPendingCommit(): void {
    if (this.pendingCommitTimer) clearTimeout(this.pendingCommitTimer);
    this.pendingCommitTimer = undefined;
  }

  private startSpeculation(): void {
    const state = this.internals();
    if (state.audioIntelligence?.modes.getState().activeMode === "group") return;
    if (this.interruptionMemory.peek()) return;
    if (this.speculativeLlm?.hasActive()) return;
    const candidate = this.partialTracker.current();
    if (!candidate || candidate.text.trim().length < 4) return;
    this.speculativeLlm?.start(
      candidate.text,
      buildSpeculativeMessages(state.history, candidate.text),
    );
  }

  private maybeSendBackchannel(text: string, emotion: UserEmotion): void {
    const state = this.internals();
    const mode = state.audioIntelligence?.modes.getState().activeMode ?? "owner_focus";
    const decision = this.backchannelEngine.observe({
      text,
      emotion,
      interactionMode: mode,
      activeResponse: Boolean(state.activeResponse),
    });
    if (!decision || this.backchannelInFlight) return;

    const epoch = this.backchannelEpoch;
    this.backchannelInFlight = true;
    void getBackchannelAudio(decision.cue, this.ttsConfig())
      .then((audio) => {
        if (!audio.length || !this.backchannelSpeechActive || epoch !== this.backchannelEpoch) return;
        if (state.activeResponse || state.client.readyState !== WebSocket.OPEN) return;
        const durationMs = Math.max(80, Math.ceil(audio.length / (24_000 * 2) * 1_000));
        state.client.send(JSON.stringify({
          type: "backchannel.audio.started",
          cue: decision.cue,
          reason: decision.reason,
          durationMs,
        }));
        state.client.send(audio, { binary: true });
        const doneTimer = setTimeout(() => {
          if (state.client.readyState === WebSocket.OPEN) {
            state.client.send(JSON.stringify({ type: "backchannel.audio.done" }));
          }
        }, durationMs + 80);
        doneTimer.unref?.();
      })
      .catch(() => undefined)
      .finally(() => {
        this.backchannelInFlight = false;
      });
  }

  private prewarmTts(): void {
    void QwenTtsRealtimeClient.prewarm(this.ttsConnectionConfig()).catch(() => undefined);
  }

  private syncOwnerFocusSpeakerAnalysisWait(): void {
    const state = this.internals();
    this.configuredOwnerFocusSpeakerAnalysisWaitMs ??= state.config.speaker.analysisWaitMs;
    state.config.speaker.analysisWaitMs = resolveOwnerFocusSpeakerAnalysisWaitMs({
      configuredWaitMs: this.configuredOwnerFocusSpeakerAnalysisWaitMs,
      consentRequired: state.config.speakerIdentity.consentRequired,
      consentGranted: state.speakerConsentGranted,
    });
  }

  private ttsConnectionConfig() {
    const qwen = this.internals().config.qwen;
    return {
      apiKey: qwen.apiKey,
      workspaceId: qwen.workspaceId,
      baseUrl: qwen.ttsBaseUrl,
      model: qwen.ttsModel,
    };
  }

  private ttsConfig() {
    const qwen = this.internals().config.qwen;
    return {
      apiKey: qwen.apiKey,
      workspaceId: qwen.workspaceId,
      baseUrl: qwen.ttsBaseUrl,
      model: qwen.ttsModel,
      voice: qwen.ttsVoice,
      language: qwen.ttsLanguage,
      sampleRate: qwen.ttsSampleRate,
      optimizeInstructions: qwen.optimizeInstructions,
    };
  }

  private internals(): RealtimeSessionInternals {
    return this as unknown as RealtimeSessionInternals;
  }
}

function normalizeInterruptReason(value: unknown): "barge_in" | "client_cancel" | "new_turn" {
  if (value === "client_cancel" || value === "new_turn") return value;
  return "barge_in";
}
