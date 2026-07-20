import { z } from "zod";

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
    userId: z.string().min(1),
    agentId: z.string().min(1).default("default-agent"),
    locale: z.string().default("zh-CN"),
    systemPrompt: z.string().optional(),
    device: deviceSchema,
  }),
});

export const clientControlEventSchema = z.discriminatedUnion("type", [
  sessionStartEventSchema,
  z.object({ type: z.literal("input_audio_buffer.commit") }),
  z.object({ type: z.literal("response.cancel") }),
  z.object({ type: z.literal("session.finish") }),
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

export type ServerEvent =
  | { type: "session.created"; sessionId: string; inputAudio: AudioFormat; outputAudio: AudioFormat }
  | { type: "session.ready"; sessionId: string }
  | { type: "input_audio_buffer.speech_started" }
  | { type: "input_audio_buffer.speech_stopped" }
  | { type: "transcript.partial"; text: string; emotion: UserEmotion; language?: string }
  | { type: "transcript.final"; text: string; emotion: UserEmotion; language?: string }
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
