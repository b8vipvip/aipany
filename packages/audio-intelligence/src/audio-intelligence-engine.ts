import type {
  InteractionMode,
  ModeState,
  SocialDecision,
  SocialTurnContext,
  SpeakerMatch,
  SpeakerObservation,
} from "./types.js";
import { InMemorySpeakerIdentityStore, type SpeakerIdentityStoreOptions } from "./speaker-identity-store.js";
import { ProgressiveVoiceEnrollmentManager } from "./progressive-enrollment.js";
import { ModeManager, type ModeManagerOptions } from "./mode-manager.js";
import { SocialConversationManager } from "./social-conversation-manager.js";

export interface AudioIntelligenceEngineOptions {
  identity?: SpeakerIdentityStoreOptions;
  mode?: ModeManagerOptions;
}

/**
 * Audio Intelligence Engine 是 v0.2 的领域入口。
 * 当前不绑定任何具体声纹/分离/环境模型，只接收标准化 observation，
 * 后续接 TitaNet、ECAPA、Sortformer 或商业 API 时无需修改上层会话逻辑。
 */
export class AudioIntelligenceEngine {
  readonly identities: InMemorySpeakerIdentityStore;
  readonly enrollments: ProgressiveVoiceEnrollmentManager;
  readonly modes: ModeManager;
  readonly social: SocialConversationManager;

  constructor(options: AudioIntelligenceEngineOptions = {}) {
    this.identities = new InMemorySpeakerIdentityStore(options.identity);
    this.enrollments = new ProgressiveVoiceEnrollmentManager(this.identities);
    this.modes = new ModeManager(options.mode);
    this.social = new SocialConversationManager();
  }

  observeSpeaker(observation: SpeakerObservation): {
    match?: SpeakerMatch;
    suggestion?: ReturnType<ModeManager["observeSpeaker"]>;
  } {
    const match = observation.embedding ? this.identities.identify(observation.embedding) : undefined;
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
