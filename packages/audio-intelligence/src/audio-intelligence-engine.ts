import type {
  InteractionMode,
  ModeState,
  SocialDecision,
  SocialTurnContext,
  SpeakerIdentityScope,
  SpeakerMatch,
  SpeakerObservation,
} from "./types.js";
import {
  InMemorySpeakerIdentityStore,
  type SpeakerIdentityStore,
  type SpeakerIdentityStoreOptions,
} from "./speaker-identity-store.js";
import { ProgressiveVoiceEnrollmentManager } from "./progressive-enrollment.js";
import { ModeManager, type ModeManagerOptions } from "./mode-manager.js";
import { SocialConversationManager } from "./social-conversation-manager.js";

export interface AudioIntelligenceEngineOptions {
  identity?: SpeakerIdentityStoreOptions;
  identityStore?: SpeakerIdentityStore;
  identityScope?: SpeakerIdentityScope;
  mode?: ModeManagerOptions;
}

/**
 * Audio Intelligence Engine 是 v0.2 的领域入口。
 * Speaker Identity Store 可以是内存或持久化实现；Mode / Social 状态仍按实时会话隔离。
 */
export class AudioIntelligenceEngine {
  readonly identities: SpeakerIdentityStore;
  readonly identityScope: SpeakerIdentityScope;
  readonly enrollments: ProgressiveVoiceEnrollmentManager;
  readonly modes: ModeManager;
  readonly social: SocialConversationManager;

  constructor(options: AudioIntelligenceEngineOptions = {}) {
    this.identities = options.identityStore ?? new InMemorySpeakerIdentityStore(options.identity);
    this.identityScope = options.identityScope ?? { tenantId: "default", userId: "default" };
    this.enrollments = new ProgressiveVoiceEnrollmentManager(this.identities, this.identityScope);
    this.modes = new ModeManager(options.mode);
    this.social = new SocialConversationManager();
  }

  async observeSpeaker(observation: SpeakerObservation): Promise<{
    match?: SpeakerMatch;
    suggestion?: ReturnType<ModeManager["observeSpeaker"]>;
  }> {
    const match = observation.embedding
      ? await this.identities.identify(this.identityScope, observation.embedding)
      : undefined;
    const suggestion = this.modes.observeSpeaker(observation);
    return { match, suggestion };
  }

  setMode(mode: InteractionMode, source: "manual" | "voice_command" | "auto" = "manual"): ModeState {
    return this.modes.setMode(mode, source);
  }

  detectModeCommand(text: string): InteractionMode | undefined {
    return this.modes.detectVoiceCommand(text);
  }

  decideSocialAction(context: SocialTurnContext): SocialDecision {
    return this.social.decide(context);
  }
}
