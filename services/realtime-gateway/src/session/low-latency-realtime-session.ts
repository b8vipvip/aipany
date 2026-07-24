import type { SessionStartEvent } from "@aipany/protocol";
import { resolveRequestedVoice } from "../mobile/client-capabilities.js";
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
  asr?: {
    commit(): void;
    on(event: "partial", listener: (result: { text: string }) => void): unknown;
    on(event: "speechStarted", listener: () => void): unknown;
    on(event: "speechStopped", listener: () => void): unknown;
  };
  llm: { streamChat: StreamChatFunction };
  history: ChatMessage[];
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
 * Low-latency behavior layered on top of the stable RealtimeSession core.
 *
 * Phase 1 additions:
 * - Stable ASR partials can start a private speculative LLM stream. The normal
 *   final-turn pipeline adopts it only when the final transcript still matches.
 * - Speaker analysis can continue in parallel with speculative inference; no
 *   speculative token is exposed before the normal identity/mode gates pass.
 * - A raw TTS websocket is pre-opened while the user is speaking and configured
 *   only when the final Humanizer instructions are known.
 */
export class LowLatencyRealtimeSession extends RealtimeSession {
  private configuredOwnerFocusSpeakerAnalysisWaitMs?: number;
  private readonly partialTracker = new StablePartialTracker();
  private speculativeLlm?: SpeculativeLlmCoordinator;
  private optimizationHooksInstalled = false;

  override async start(event: SessionStartEvent): Promise<void> {
    const state = this.internals();
    state.config.qwen.ttsVoice = resolveRequestedVoice(
      state.config.qwen.ttsModel,
      state.config.qwen.ttsVoice,
      event.session.outputVoice,
    );
    this.installSpeculativeLlm(state);
    await super.start(event);
    this.syncOwnerFocusSpeakerAnalysisWait();
    this.installOptimizationHooks();
  }

  override commitAudio(): void {
    this.internals().asr?.commit();
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
    this.speculativeLlm?.cancel("session_closed");
    // The warm pool is shared by sessions with the same upstream configuration.
    // Do not cancel a pooled idle socket from one session's close path; its TTL
    // cleanup owns disposal and prevents cross-session interference.
    super.close();
  }

  private installSpeculativeLlm(state: RealtimeSessionInternals): void {
    if (this.speculativeLlm) return;
    const original = state.llm.streamChat.bind(state.llm);
    this.speculativeLlm = new SpeculativeLlmCoordinator(original);
    state.llm.streamChat = (options) => this.speculativeLlm!.streamOrAdopt(options);
  }

  private installOptimizationHooks(): void {
    if (this.optimizationHooksInstalled) return;
    const asr = this.internals().asr;
    if (!asr) return;
    this.optimizationHooksInstalled = true;

    asr.on("speechStarted", () => {
      this.partialTracker.reset();
      this.speculativeLlm?.cancel("new_speech");
      this.prewarmTts();
    });
    asr.on("partial", (result) => {
      this.partialTracker.observe(result.text);
      if (this.partialTracker.shouldStartEarly()) this.startSpeculation();
    });
    asr.on("speechStopped", () => {
      this.startSpeculation();
      this.prewarmTts();
    });
  }

  private startSpeculation(): void {
    const state = this.internals();
    if (state.audioIntelligence?.modes.getState().activeMode === "group") return;
    if (this.speculativeLlm?.hasActive()) return;
    const candidate = this.partialTracker.current();
    if (!candidate || candidate.text.trim().length < 4) return;
    this.speculativeLlm?.start(
      candidate.text,
      buildSpeculativeMessages(state.history, candidate.text),
    );
  }

  private prewarmTts(): void {
    // Prewarm is an optimization only. DNS/TLS/upstream failures here must never
    // surface as an unhandled rejection or affect the stable response path.
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

  private internals(): RealtimeSessionInternals {
    return this as unknown as RealtimeSessionInternals;
  }
}
