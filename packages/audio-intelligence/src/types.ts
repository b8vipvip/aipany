export type InteractionMode = "auto" | "owner_focus" | "group";
export type ActiveInteractionMode = Exclude<InteractionMode, "auto">;
export type ModeChangeSource = "manual" | "voice_command" | "auto" | "suggestion_accepted";

export type SpeakerIdentityStatus = "unknown" | "learning" | "confirmed";
export type SpeakerProximity = "very_near" | "near" | "medium" | "far" | "background" | "unknown";

export interface AudioFormatDescriptor {
  encoding: "pcm_s16le" | "pcm_f32le" | "opus";
  sampleRate: number;
  channels: number;
}

export interface EnvironmentEvent {
  type: string;
  confidence: number;
}

export interface EnvironmentContext {
  scene?: string;
  sceneConfidence?: number;
  noiseLevel?: "quiet" | "low" | "medium" | "high" | "very_high";
  events: EnvironmentEvent[];
  capturedAt: number;
}

export interface SpeakerObservation {
  sessionSpeakerId: string;
  observedAt: number;
  speechDurationMs: number;
  confidence: number;
  embedding?: number[];
  proximity?: SpeakerProximity;
  directionDegrees?: number;
  environment?: EnvironmentContext;
  isOwnerHint?: boolean;
}

export interface VoiceSample {
  id: string;
  embedding: number[];
  createdAt: number;
  sourceSessionId?: string;
  environment?: string;
  proximity?: SpeakerProximity;
  quality: number;
}

export interface VoiceProfile {
  id: string;
  personId: string;
  status: SpeakerIdentityStatus;
  confidence: number;
  centroid: number[];
  samples: VoiceSample[];
  createdAt: number;
  updatedAt: number;
}

export interface PersonRecord {
  id: string;
  name: string;
  relation?: string;
  isOwner: boolean;
  voiceProfileId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SpeakerMatch {
  person?: PersonRecord;
  profile?: VoiceProfile;
  similarity: number;
  confident: boolean;
}

export interface ModeSuggestion {
  id: string;
  from: ActiveInteractionMode;
  to: ActiveInteractionMode;
  reason: "multiple_stable_speakers" | "returned_to_single_speaker";
  speakerCount: number;
  createdAt: number;
}

export interface ModeState {
  configuredMode: InteractionMode;
  activeMode: ActiveInteractionMode;
  pendingSuggestion?: ModeSuggestion;
  changedAt: number;
  source: ModeChangeSource;
}

export type SocialAction = "respond" | "stay_silent" | "intervene";

export interface SocialTurnContext {
  mode: ActiveInteractionMode;
  speakerId: string;
  speakerName?: string;
  isOwner: boolean;
  text: string;
  addressedToAssistant: boolean;
  explicitWakeWord: boolean;
  directQuestionToAssistant: boolean;
  naturalPauseMs: number;
  humanOverlap: boolean;
  helpfulnessScore: number;
  urgencyScore: number;
  noveltyScore: number;
  recentAiInterventions: number;
  secondsSinceAiSpoke: number;
  proactivity: number;
}

export interface SocialDecision {
  action: SocialAction;
  score: number;
  reason:
    | "owner_focus_non_owner"
    | "explicitly_addressed"
    | "human_overlap"
    | "proactive_opportunity"
    | "insufficient_value"
    | "owner_turn";
}

export interface EnrollmentState {
  id: string;
  personId: string;
  personName: string;
  relation?: string;
  sessionId: string;
  sessionSpeakerId?: string;
  status: "collecting" | "confirmed" | "cancelled";
  acceptedSamples: number;
  startedAt: number;
  updatedAt: number;
}

export interface SpeakerEmbeddingProvider {
  readonly name: string;
  extractEmbedding(audio: Buffer, format: AudioFormatDescriptor): Promise<number[]>;
}

export interface SpeakerDiarizationSegment {
  speakerId: string;
  startMs: number;
  endMs: number;
  confidence: number;
  overlap?: boolean;
}

export interface SpeakerDiarizationProvider {
  readonly name: string;
  diarize(audio: Buffer, format: AudioFormatDescriptor): Promise<SpeakerDiarizationSegment[]>;
}

export interface EnvironmentAnalysisProvider {
  readonly name: string;
  analyze(audio: Buffer, format: AudioFormatDescriptor): Promise<EnvironmentContext>;
}
