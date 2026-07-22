import { z } from "zod";

export const interactionModeSchema = z.enum(["auto", "owner_focus", "group"]);
export type InteractionMode = z.infer<typeof interactionModeSchema>;

export const experienceModeSchema = z.enum(["economy_live", "native_flash", "native_plus"]);
export type ExperienceMode = z.infer<typeof experienceModeSchema>;

export const inputAudioSchema = z.object({
  encoding: z.literal("pcm_s16le").default("pcm_s16le"),
  sampleRate: z.literal(16000).default(16000),
  channels: z.number().int().min(1).max(8).default(1),
  beamformingDelaysSamples: z.array(z.number().int().min(-512).max(512)).max(8).optional(),
});

export const deviceSchema = z.object({
  deviceId: z.string().min(1),
  productId: z.string().min(1),
  deviceType: z.enum(["mobile", "web", "embedded", "speaker", "robot", "unknown"]),
  platform: z.string().min(1),
  appVersion: z.string().optional(),
  firmwareVersion: z.string().optional(),
});

export const sessionStartEventSchema = z.object({
  type: z.literal("session.start"),
  session: z.object({
    tenantId: z.string().min(1).default("default"),
    userId: z.string().min(1),
    agentId: z.string().min(1).default("default-agent"),
    locale: z.string().default("zh-CN"),
    assistantAliases: z.array(z.string().min(1)).max(12).default(["Aipany"]),
    systemPrompt: z.string().optional(),
    experienceMode: experienceModeSchema.optional(),
    interactionMode: interactionModeSchema.default("auto"),
    socialProactivity: z.number().min(0).max(1).default(0.45),
    outputVoice: z.string().trim().min(1).max(120).optional(),
    inputAudio: inputAudioSchema.default({ encoding: "pcm_s16le", sampleRate: 16000, channels: 1 }),
    device: deviceSchema,
  }),
});

export const clientTelemetryNameSchema = z.enum([
  "endpoint_detected",
  "barge_in_detected",
  "playback_interrupted",
  "first_audio_rendered",
  "audio_effects",
  "heartbeat_rtt",
]);

export const clientControlEventSchema = z.discriminatedUnion("type", [
  sessionStartEventSchema,
  z.object({ type: z.literal("input_audio_buffer.commit") }),
  z.object({ type: z.literal("response.cancel") }),
  z.object({ type: z.literal("session.finish") }),
  z.object({ type: z.literal("mode.set"), mode: interactionModeSchema }),
  z.object({
    type: z.literal("mode.suggestion.respond"),
    suggestionId: z.string().min(1),
    accepted: z.boolean(),
  }),
  z.object({
    type: z.literal("client.telemetry"),
    name: clientTelemetryNameSchema,
    valueMs: z.number().min(0).max(600000).optional(),
    details: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  }),
  z.object({ type: z.literal("speaker.consent.grant") }),
  z.object({ type: z.literal("speaker.consent.revoke"), deleteExisting: z.boolean().default(false) }),
  z.object({ type: z.literal("speaker.consent.status") }),
  z.object({
    type: z.literal("speaker.enrollment.start"),
    personName: z.string().min(1),
    relation: z.string().optional(),
    isOwner: z.boolean().optional(),
  }),
  z.object({ type: z.literal("speaker.enrollment.cancel"), enrollmentId: z.string().min(1) }),
  z.object({ type: z.literal("speaker.identity.list") }),
  z.object({ type: z.literal("speaker.identity.delete"), personId: z.string().uuid() }),
  z.object({ type: z.literal("ping"), timestamp: z.number().optional() }),
]);

export type ClientControlEvent = z.infer<typeof clientControlEventSchema>;
export type SessionStartEvent = z.infer<typeof sessionStartEventSchema>;

export type UserEmotion =
  | "surprised"
  | "neutral"
  | "happy"
  | "sad"
  | "disgusted"
  | "angry"
  | "fearful"
  | "unknown";

export interface SpeakerAttribution {
  sessionSpeakerId: string;
  personId?: string;
  personName?: string;
  isOwner: boolean;
  confident: boolean;
  similarity: number;
  observationConfidence: number;
}

export interface GroupTranscriptSegment {
  startMs: number;
  endMs: number;
  text?: string;
  overlap: boolean;
  confidence: number;
  speaker: SpeakerAttribution;
}

export interface EnvironmentSnapshot {
  scene?: string;
  sceneConfidence?: number;
  noiseLevel?: "quiet" | "low" | "medium" | "high" | "very_high";
  events: Array<{ type: string; confidence: number }>;
  capturedAt: number;
}

export interface SpeakerIdentitySummary {
  personId: string;
  name: string;
  relation?: string;
  isOwner: boolean;
  voiceProfileId?: string;
}

export interface AudioFormat {
  encoding: "pcm_s16le";
  sampleRate: 16000 | 24000;
  channels: number;
}

export type ServerEvent =
  | { type: "session.created"; sessionId: string; inputAudio: AudioFormat; outputAudio: AudioFormat }
  | { type: "session.ready"; sessionId: string }
  | { type: "input_audio_buffer.speech_started" }
  | { type: "input_audio_buffer.speech_stopped" }
  | { type: "transcript.partial"; text: string; emotion: UserEmotion; language?: string }
  | { type: "transcript.final"; text: string; emotion: UserEmotion; language?: string; speaker?: SpeakerAttribution }
  | { type: "transcript.group"; segments: GroupTranscriptSegment[]; overlapDetected: boolean }
  | { type: "environment.updated"; environment: EnvironmentSnapshot }
  | {
      type: "social.decision";
      action: "respond" | "stay_silent" | "intervene";
      score: number;
      reason: string;
    }
  | {
      type: "speaker.target.extracted";
      matched: boolean;
      similarity: number;
      confidence: number;
      transcript?: string;
    }
  | { type: "speaker.identified"; speaker: SpeakerAttribution }
  | {
      type: "speaker.filtered";
      sessionSpeakerId: string;
      personId?: string;
      personName?: string;
      reason: "owner_focus_non_owner" | "target_speaker_not_matched";
    }
  | { type: "mode.changed"; configuredMode: InteractionMode; activeMode: "owner_focus" | "group"; source: string }
  | {
      type: "mode.suggestion";
      suggestionId: string;
      from: "owner_focus" | "group";
      to: "owner_focus" | "group";
      reason: string;
      speakerCount: number;
    }
  | { type: "speaker.consent.updated"; granted: boolean }
  | { type: "speaker.enrollment.started"; enrollmentId: string; personId: string; personName: string }
  | { type: "speaker.enrollment.updated"; enrollmentId: string; acceptedSamples: number; status: string }
  | { type: "speaker.enrollment.cancelled"; enrollmentId: string }
  | { type: "speaker.identity.list"; people: SpeakerIdentitySummary[] }
  | { type: "speaker.identity.deleted"; personId: string }
  | {
      type: "audio.frontend.metrics";
      inputRms: number;
      outputRms: number;
      appliedGain: number;
      echoAttenuation: number;
      noiseSuppressionGain: number;
      clippedSamples: number;
    }
  | { type: "response.created"; responseId: string }
  | { type: "response.text.delta"; responseId: string; delta: string }
  | { type: "response.audio.started"; responseId: string; format: AudioFormat }
  | { type: "response.audio.done"; responseId: string }
  | { type: "response.done"; responseId: string; text: string }
  | { type: "response.interrupted"; responseId: string; reason: "barge_in" | "client_cancel" | "new_turn" }
  | { type: "pong"; timestamp: number }
  | { type: "error"; code: string; message: string; retryable?: boolean };

export const INPUT_AUDIO_FORMAT: AudioFormat = {
  encoding: "pcm_s16le",
  sampleRate: 16000,
  channels: 1,
};

export const OUTPUT_AUDIO_FORMAT: AudioFormat = {
  encoding: "pcm_s16le",
  sampleRate: 24000,
  channels: 1,
};
