import type { SessionStartEvent } from "@aipany/protocol";
import { resolveRequestedVoice } from "../mobile/client-capabilities.js";
import { RealtimeSession } from "./realtime-session.js";

interface RealtimeSessionInternals {
  asr?: { commit(): void };
  config: {
    qwen: { ttsModel: string; ttsVoice: string };
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
 * - Owner Focus without speaker-identity consent must not block the main ASR -> LLM
 *   path waiting for identity analysis that cannot legally be used anyway.
 * - Explicit input_audio_buffer.commit is forwarded to the realtime ASR provider.
 * - Mobile/web clients can request one of the voices advertised by the server for
 *   the current realtime TTS model. Unsupported values safely fall back to the
 *   server-configured voice.
 */
export class LowLatencyRealtimeSession extends RealtimeSession {
  private configuredOwnerFocusSpeakerAnalysisWaitMs?: number;

  override async start(event: SessionStartEvent): Promise<void> {
    const state = this.internals();
    state.config.qwen.ttsVoice = resolveRequestedVoice(
      state.config.qwen.ttsModel,
      state.config.qwen.ttsVoice,
      event.session.outputVoice,
    );
    await super.start(event);
    this.syncOwnerFocusSpeakerAnalysisWait();
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

  private syncOwnerFocusSpeakerAnalysisWait(): void {
    const state = this.internals();
    this.configuredOwnerFocusSpeakerAnalysisWaitMs ??= state.config.speaker.analysisWaitMs;
    state.config.speaker.analysisWaitMs = resolveOwnerFocusSpeakerAnalysisWaitMs({
      configuredWaitMs: this.configuredOwnerFocusSpeakerAnalysisWaitMs,
      consentRequired: state.config.speakerIdentity.consentRequired,
      consentGranted: state.speakerConsentGranted,
    });
  }

  private internals(): RealtimeSessionInternals {
    return this as unknown as RealtimeSessionInternals;
  }
}
