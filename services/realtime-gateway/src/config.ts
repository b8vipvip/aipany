import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  AIPANY_GATEWAY_TOKEN: z.string().optional(),

  DASHSCOPE_API_KEY: z.string().min(1),
  DASHSCOPE_WORKSPACE_ID: z.string().optional(),
  DASHSCOPE_ASR_WS_BASE_URL: z.string().url().optional(),
  DASHSCOPE_TTS_WS_BASE_URL: z.string().url().optional(),

  QWEN_ASR_MODEL: z.string().default("qwen3-asr-flash-realtime"),
  QWEN_ASR_LANGUAGE: z.string().default("zh"),
  QWEN_ASR_VAD_THRESHOLD: z.coerce.number().min(-1).max(1).default(0),
  QWEN_ASR_SILENCE_MS: z.coerce.number().int().min(200).max(6000).default(500),

  QWEN_TTS_MODEL: z.string().default("qwen3-tts-instruct-flash-realtime"),
  QWEN_TTS_VOICE: z.string().default("Cherry"),
  QWEN_TTS_LANGUAGE: z.string().default("Chinese"),
  QWEN_TTS_SAMPLE_RATE: z.coerce.number().int().default(24000),
  QWEN_TTS_OPTIMIZE_INSTRUCTIONS: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),

  LLM_BASE_URL: z.string().url(),
  LLM_API_KEY: z.string().min(1),
  LLM_MODEL: z.string().min(1),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.8),
  LLM_MAX_TOKENS: z.coerce.number().int().positive().default(800),

  SPEAKER_INTELLIGENCE_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  SPEAKER_INTELLIGENCE_BASE_URL: z.string().url().default("http://speaker-intelligence:3200"),
  SPEAKER_INTELLIGENCE_TOKEN: z.string().optional(),
  SPEAKER_INTELLIGENCE_TIMEOUT_MS: z.coerce.number().int().min(300).max(30000).default(2500),
  SPEAKER_MIN_AUDIO_MS: z.coerce.number().int().min(300).max(10000).default(700),
  SPEAKER_PRE_ROLL_MS: z.coerce.number().int().min(0).max(2000).default(350),
  SPEAKER_ANALYSIS_WAIT_MS: z.coerce.number().int().min(0).max(5000).default(700),
  SPEAKER_SESSION_MATCH_THRESHOLD: z.coerce.number().min(-1).max(1).default(0.76),

  MAX_HISTORY_MESSAGES: z.coerce.number().int().min(4).max(100).default(20),
  DEFAULT_SYSTEM_PROMPT: z.string().default(
    "你是一个自然、温暖、有陪伴感的中文语音助手。回答适合直接说出口，优先简洁、口语化。可以自然使用语气词，但不要刻意堆砌。不要输出舞台说明、Markdown 或情绪标签。",
  ),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`环境变量配置错误：${details}`);
  }

  const env = parsed.data;
  const workspaceBase = env.DASHSCOPE_WORKSPACE_ID
    ? `wss://${env.DASHSCOPE_WORKSPACE_ID}.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime`
    : "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";

  return {
    server: {
      port: env.PORT,
      host: env.HOST,
      token: env.AIPANY_GATEWAY_TOKEN,
    },
    qwen: {
      apiKey: env.DASHSCOPE_API_KEY,
      workspaceId: env.DASHSCOPE_WORKSPACE_ID,
      asrBaseUrl: env.DASHSCOPE_ASR_WS_BASE_URL ?? workspaceBase,
      ttsBaseUrl: env.DASHSCOPE_TTS_WS_BASE_URL ?? workspaceBase,
      asrModel: env.QWEN_ASR_MODEL,
      asrLanguage: env.QWEN_ASR_LANGUAGE,
      vadThreshold: env.QWEN_ASR_VAD_THRESHOLD,
      silenceMs: env.QWEN_ASR_SILENCE_MS,
      ttsModel: env.QWEN_TTS_MODEL,
      ttsVoice: env.QWEN_TTS_VOICE,
      ttsLanguage: env.QWEN_TTS_LANGUAGE,
      ttsSampleRate: env.QWEN_TTS_SAMPLE_RATE,
      optimizeInstructions: env.QWEN_TTS_OPTIMIZE_INSTRUCTIONS,
    },
    llm: {
      baseUrl: env.LLM_BASE_URL.replace(/\/$/, ""),
      apiKey: env.LLM_API_KEY,
      model: env.LLM_MODEL,
      temperature: env.LLM_TEMPERATURE,
      maxTokens: env.LLM_MAX_TOKENS,
    },
    speaker: {
      enabled: env.SPEAKER_INTELLIGENCE_ENABLED,
      baseUrl: env.SPEAKER_INTELLIGENCE_BASE_URL.replace(/\/$/, ""),
      token: env.SPEAKER_INTELLIGENCE_TOKEN,
      timeoutMs: env.SPEAKER_INTELLIGENCE_TIMEOUT_MS,
      minAudioMs: env.SPEAKER_MIN_AUDIO_MS,
      preRollMs: env.SPEAKER_PRE_ROLL_MS,
      analysisWaitMs: env.SPEAKER_ANALYSIS_WAIT_MS,
      sessionMatchThreshold: env.SPEAKER_SESSION_MATCH_THRESHOLD,
    },
    conversation: {
      maxHistoryMessages: env.MAX_HISTORY_MESSAGES,
      defaultSystemPrompt: env.DEFAULT_SYSTEM_PROMPT,
    },
  } as const;
}
