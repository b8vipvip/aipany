import type { SessionStartEvent } from "@aipany/protocol";
import { RealtimeSession } from "./realtime-session.js";

interface RealtimeSessionInternals {
  asr?: { commit(): void };
  config: {
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
 *   path waiting for identity analysis that cannot legally be used anyway. The
 *   analysis promise still continues in the background and can emit environment
 *   and diagnostic events when it completes.
 * - Explicit input_audio_buffer.commit is forwarded to the realtime ASR provider,
 *   allowing clients with local endpoint detection to finish a turn immediately
 *   instead of relying exclusively on server-side VAD silence detection.
 */
export class LowLatencyRealtimeSession extends RealtimeSession {
  private configuredOwnerFocusSpeakerAnalysisWaitMs?: number;

  override async start(event: SessionStartEvent): Promise<void> {
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
