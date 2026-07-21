import { z } from "zod";

const booleanString = z.enum(["true", "false"]).transform((value) => value === "true");
const optionalString = z.preprocess((value) => value === "" ? undefined : value, z.string().optional());
const optionalUrl = z.preprocess((value) => value === "" ? undefined : value, z.string().url().optional());

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  AIPANY_GATEWAY_TOKEN: optionalString,
  AIPANY_JWT_SECRET: optionalString,
  AIPANY_JWT_ISSUER: optionalString,
  AIPANY_JWT_AUDIENCE: optionalString,
  AIPANY_ALLOW_ANONYMOUS: booleanString.default("false"),
  AIPANY_MOBILE_PREVIEW_ENABLED: booleanString.default("false"),
  AIPANY_MOBILE_PREVIEW_TOKEN_TTL_SECONDS: z.coerce.number().int().min(300).max(86400).default(21600),
  AIPANY_MOBILE_PREVIEW_TENANT: z.string().min(1).default("mobile-preview"),

  DASHSCOPE_API_KEY: z.string().default(""),
  DASHSCOPE_WORKSPACE_ID: optionalString,
  DASHSCOPE_ASR_WS_BASE_URL: optionalUrl,
  DASHSCOPE_TTS_WS_BASE_URL: optionalUrl,

  QWEN_ASR_MODEL: z.string().default("qwen3-asr-flash-realtime"),
  QWEN_ASR_LANGUAGE: z.string().default("zh"),
  QWEN_ASR_VAD_THRESHOLD: z.coerce.number().min(-1).max(1).default(0),
  QWEN_ASR_SILENCE_MS: z.coerce.number().int().min(200).max(6000).default(500),

  QWEN_TTS_MODEL: z.string().default("qwen3-tts-instruct-flash-realtime"),
  QWEN_TTS_VOICE: z.string().default("Cherry"),
  QWEN_TTS_LANGUAGE: z.string().default("Chinese"),
  QWEN_TTS_SAMPLE_RATE: z.coerce.number().int().default(24000),
  QWEN_TTS_OPTIMIZE_INSTRUCTIONS: booleanString.default("false"),

  LLM_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  LLM_API_KEY: z.string().default(""),
  LLM_MODEL: z.string().default("gpt-5.6-sol"),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.8),
  LLM_MAX_TOKENS: z.coerce.number().int().positive().default(800),

  SPEAKER_INTELLIGENCE_ENABLED: booleanString.default("false"),
  SPEAKER_INTELLIGENCE_BASE_URL: z.string().url().default("http://speaker-intelligence:3200"),
  SPEAKER_INTELLIGENCE_TOKEN: optionalString,
  SPEAKER_INTELLIGENCE_TIMEOUT_MS: z.coerce.number().int().min(300).max(30000).default(2500),
  SPEAKER_INTELLIGENCE_ANALYSIS_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(20000),
  SPEAKER_MIN_AUDIO_MS: z.coerce.number().int().min(300).max(10000).default(700),
  SPEAKER_PRE_ROLL_MS: z.coerce.number().int().min(0).max(2000).default(350),
  SPEAKER_ANALYSIS_WAIT_MS: z.coerce.number().int().min(0).max(10000).default(700),
  GROUP_ANALYSIS_WAIT_MS: z.coerce.number().int().min(0).max(30000).default(3500),
  SPEAKER_SESSION_MATCH_THRESHOLD: z.coerce.number().min(-1).max(1).default(0.76),
  AUDIO_DIARIZATION_ENABLED: booleanString.default("true"),
  AUDIO_SEPARATION_ENABLED: booleanString.default("true"),
  AUDIO_ENVIRONMENT_ENABLED: booleanString.default("true"),
  AUDIO_SEGMENT_TRANSCRIPTION_ENABLED: booleanString.default("true"),
  TARGET_SPEAKER_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.62),

  AUDIO_FRONTEND_ENABLED: booleanString.default("true"),
  AUDIO_AEC_ENABLED: booleanString.default("true"),
  AUDIO_NOISE_SUPPRESSION_ENABLED: booleanString.default("true"),
  AUDIO_AGC_ENABLED: booleanString.default("true"),
  AUDIO_DEREVERB_ENABLED: booleanString.default("true"),
  AUDIO_BEAMFORMING_ENABLED: booleanString.default("true"),
  AUDIO_AEC_DELAY_MS: z.coerce.number().int().min(0).max(2000).default(120),
  AUDIO_AGC_TARGET_DBFS: z.coerce.number().min(-40).max(-6).default(-20),
  AUDIO_AGC_MAX_GAIN: z.coerce.number().min(1).max(20).default(6),
  AUDIO_FRONTEND_METRICS_INTERVAL_MS: z.coerce.number().int().min(0).max(60000).default(5000),

  SPEAKER_IDENTITY_STORE: z.enum(["memory", "postgres"]).default("memory"),
  DATABASE_URL: optionalString,
  SPEAKER_IDENTITY_ENCRYPTION_KEY: optionalString,
  SPEAKER_IDENTITY_DATABASE_SSL: booleanString.default("false"),
  SPEAKER_IDENTITY_DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  SPEAKER_IDENTITY_MATCH_CANDIDATES: z.coerce.number().int().min(1).max(100).default(20),
  SPEAKER_CONSENT_REQUIRED: booleanString.default("true"),

  SOCIAL_DECISION_ENABLED: booleanString.default("true"),
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
  if (env.SPEAKER_IDENTITY_STORE === "postgres") {
    if (!env.DATABASE_URL?.trim()) {
      throw new Error("环境变量配置错误：SPEAKER_IDENTITY_STORE=postgres 时必须配置 DATABASE_URL");
    }
    if (!env.SPEAKER_IDENTITY_ENCRYPTION_KEY?.trim()) {
      throw new Error("环境变量配置错误：SPEAKER_IDENTITY_STORE=postgres 时必须配置 SPEAKER_IDENTITY_ENCRYPTION_KEY");
    }
  }

  const workspaceBase = env.DASHSCOPE_WORKSPACE_ID
    ? `wss://${env.DASHSCOPE_WORKSPACE_ID}.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime`
    : "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";

  return {
    server: {
      port: env.PORT,
      host: env.HOST,
      token: env.AIPANY_GATEWAY_TOKEN,
      auth: {
        legacyToken: env.AIPANY_GATEWAY_TOKEN,
        jwtSecret: env.AIPANY_JWT_SECRET,
        jwtIssuer: env.AIPANY_JWT_ISSUER,
        jwtAudience: env.AIPANY_JWT_AUDIENCE,
        allowAnonymous: env.AIPANY_ALLOW_ANONYMOUS,
      },
      mobilePreview: {
        enabled: env.AIPANY_MOBILE_PREVIEW_ENABLED,
        ttlSeconds: env.AIPANY_MOBILE_PREVIEW_TOKEN_TTL_SECONDS,
        tenantId: env.AIPANY_MOBILE_PREVIEW_TENANT,
      },
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
      analysisTimeoutMs: env.SPEAKER_INTELLIGENCE_ANALYSIS_TIMEOUT_MS,
      minAudioMs: env.SPEAKER_MIN_AUDIO_MS,
      preRollMs: env.SPEAKER_PRE_ROLL_MS,
      analysisWaitMs: env.SPEAKER_ANALYSIS_WAIT_MS,
      groupAnalysisWaitMs: env.GROUP_ANALYSIS_WAIT_MS,
      sessionMatchThreshold: env.SPEAKER_SESSION_MATCH_THRESHOLD,
      diarizationEnabled: env.AUDIO_DIARIZATION_ENABLED,
      separationEnabled: env.AUDIO_SEPARATION_ENABLED,
      environmentEnabled: env.AUDIO_ENVIRONMENT_ENABLED,
      segmentTranscriptionEnabled: env.AUDIO_SEGMENT_TRANSCRIPTION_ENABLED,
      targetSpeakerMinConfidence: env.TARGET_SPEAKER_MIN_CONFIDENCE,
    },
    audioFrontEnd: {
      enabled: env.AUDIO_FRONTEND_ENABLED,
      aec: env.AUDIO_AEC_ENABLED,
      noiseSuppression: env.AUDIO_NOISE_SUPPRESSION_ENABLED,
      agc: env.AUDIO_AGC_ENABLED,
      dereverb: env.AUDIO_DEREVERB_ENABLED,
      beamforming: env.AUDIO_BEAMFORMING_ENABLED,
      aecDelayMs: env.AUDIO_AEC_DELAY_MS,
      targetRmsDbfs: env.AUDIO_AGC_TARGET_DBFS,
      maxGain: env.AUDIO_AGC_MAX_GAIN,
      metricsIntervalMs: env.AUDIO_FRONTEND_METRICS_INTERVAL_MS,
    },
    speakerIdentity: {
      store: env.SPEAKER_IDENTITY_STORE,
      connectionString: env.DATABASE_URL,
      encryptionKey: env.SPEAKER_IDENTITY_ENCRYPTION_KEY,
      databaseSsl: env.SPEAKER_IDENTITY_DATABASE_SSL,
      poolMax: env.SPEAKER_IDENTITY_DB_POOL_MAX,
      matchCandidates: env.SPEAKER_IDENTITY_MATCH_CANDIDATES,
      consentRequired: env.SPEAKER_CONSENT_REQUIRED,
    },
    conversation: {
      socialDecisionEnabled: env.SOCIAL_DECISION_ENABLED,
      maxHistoryMessages: env.MAX_HISTORY_MESSAGES,
      defaultSystemPrompt: env.DEFAULT_SYSTEM_PROMPT,
    },
  } as const;
}
