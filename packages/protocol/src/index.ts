import { z } from "zod";

export const interactionModeSchema = z.enum(["auto", "owner_focus", "group"]);
export type InteractionMode = z.infer<typeof interactionModeSchema>;

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
    systemPrompt: z.string().optional(),
    interactionMode: interactionModeSchema.default("auto"),
    socialProactivity: z.number().min(0).max(1).default(0.45),
    device: deviceSchema,
  }),
});

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
    type: z.literal("speaker.enrollment.start"),
    personName: z.string().min(1),
    relation: z.string().optional(),
    isOwner: z.boolean().optional(),
  }),
  z.object({ type: z.literal("speaker.enrollment.cancel"), enrollmentId: z.string().min(1) }),
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

export type ServerEvent =
  | { type: "session.created"; sessionId: string; inputAudio: AudioFormat; outputAudio: AudioFormat }
  | { type: "session.ready"; sessionId: string }
  | { type: "input_audio_buffer.speech_started" }
  | { type: "input_audio_buffer.speech_stopped" }
  | { type: "transcript.partial"; text: string; emotion: UserEmotion; language?: string }
  | { type: "transcript.final"; text: string; emotion: UserEmotion; language?: string; speaker?: SpeakerAttribution }
  | { type: "speaker.identified"; speaker: SpeakerAttribution }
  | {
      type: "speaker.filtered";
      sessionSpeakerId: string;
      personId?: string;
      personName?: string;
      reason: "owner_focus_non_owner";
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
  | { type: "speaker.enrollment.started"; enrollmentId: string; personId: string; personName: string }
  | { type: "speaker.enrollment.updated"; enrollmentId: string; acceptedSamples: number; status: string }
  | { type: "speaker.enrollment.cancelled"; enrollmentId: string }
  | { type: "speaker.identity.deleted"; personId: string }
  | { type: "response.created"; responseId: string }
  | { type: "response.text.delta"; responseId: string; delta: string }
  | { type: "response.audio.started"; responseId: string; format: AudioFormat }
  | { type: "response.audio.done"; responseId: string }
  | { type: "response.done"; responseId: string; text: string }
  | { type: "response.interrupted"; responseId: string; reason: "barge_in" | "client_cancel" | "new_turn" }
  | { type: "pong"; timestamp: number }
  | { type: "error"; code: string; message: string; retryable?: boolean };

export interface AudioFormat {
  encoding: "pcm_s16le";
  sampleRate: 16000 | 24000;
  channels: 1;
}

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
