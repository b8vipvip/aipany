import { z } from "zod";

const envSchema = z.object({
  AI_REALTIME_API_KEY: z.string().min(1, "缺少 AI_REALTIME_API_KEY"),
  DATABASE_URL: z.string().optional(),
  AIPANY_CONFIG_ENCRYPTION_KEY: z.string().optional(),
  OPENAI_REALTIME_MODEL: z.string().min(1).default("gpt-realtime-2.1"),
  OPENAI_REALTIME_VOICE: z.string().min(1).default("marin"),
  OPENAI_REALTIME_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  VOICE_SESSION_HOST: z.string().default("0.0.0.0"),
  VOICE_SESSION_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});

export interface VoiceSessionConfig {
  apiKey: string;
  model: string;
  voice: string;
  baseUrl: string;
  host: string;
  port: number;
  databaseUrl?: string;
  encryptionKey?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): VoiceSessionConfig {
  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => issue.message).join("；");
    throw new Error(`Voice Session 配置无效：${message}`);
  }

  return {
    apiKey: parsed.data.AI_REALTIME_API_KEY,
    model: parsed.data.OPENAI_REALTIME_MODEL,
    voice: parsed.data.OPENAI_REALTIME_VOICE,
    baseUrl: parsed.data.OPENAI_REALTIME_BASE_URL.replace(/\/$/, ""),
    host: parsed.data.VOICE_SESSION_HOST,
    port: parsed.data.VOICE_SESSION_PORT,
    databaseUrl: parsed.data.DATABASE_URL,
    encryptionKey: parsed.data.AIPANY_CONFIG_ENCRYPTION_KEY,
  };
}