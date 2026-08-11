import type { ExperienceMode } from "@aipany/protocol";
import type { AppConfig } from "../config.js";
import type { RealtimeEngine } from "../observability/realtime-observability.js";
import { isChat2ApiLiveAvailable, loadChat2ApiLiveConfig } from "../providers/chat2api-live-config.js";

export const QWEN_AUDIO_REALTIME_PLUS = "qwen-audio-3.0-realtime-plus";
export const QWEN_AUDIO_REALTIME_FLASH = "qwen-audio-3.0-realtime-flash";
export const CHAT2API_GPT_LIVE = "gpt-live";
export const CHAT2API_GPT_LIVE_MINI = "gpt-live-mini";

// This list backs the existing Qwen Native model selector. ChatGPT Live is a
// separate provider/mode and must not appear as if it were a DashScope model.
export const SUPPORTED_NATIVE_REALTIME_MODELS = [
  QWEN_AUDIO_REALTIME_PLUS,
  QWEN_AUDIO_REALTIME_FLASH,
  "qwen3.5-omni-plus-realtime",
  "qwen3.5-omni-flash-realtime",
] as const;

export interface RealtimeExperienceDefinition {
  id: ExperienceMode;
  title: string;
  subtitle: string;
  engine: RealtimeEngine;
  provider?: "qwen" | "chat2api";
  model: string;
  recommendedTurnDetection?: "server_vad" | "smart_turn" | "semantic_vad";
}

export function getRealtimeExperienceDefinitions(config: AppConfig): RealtimeExperienceDefinition[] {
  const qwenNativeAvailable = isQwenNativeExperienceAvailable(config);
  const chat2apiConfig = loadChat2ApiLiveConfig();
  const chat2apiAvailable = isChat2ApiLiveAvailable();
  const nativeDisabledSubtitle = "音色仍可试听 · 服务器尚未开启 Qwen Native Live，正式会话会自动回退到 Economy Live";
  const chat2apiDisabledSubtitle = "需要启用 Chat2API Live 并配置 API Key；不可用时会自动回退到 Economy Live";
  return [
    {
      id: "economy_live",
      title: "Economy Live",
      subtitle: "低成本实时链路 · 流式 ASR + LLM + 情绪化 TTS",
      engine: "cascaded",
      model: config.qwen.ttsModel,
    },
    {
      id: "chat2api_live",
      title: chat2apiAvailable ? "ChatGPT Live" : "ChatGPT Live · 未启用",
      subtitle: chat2apiAvailable
        ? "经 chat2api 直连 ChatGPT Voice · 音频原生实时对话"
        : chat2apiDisabledSubtitle,
      engine: "omni_realtime",
      provider: "chat2api",
      model: chat2apiConfig.model,
    },
    {
      id: "native_flash",
      title: qwenNativeAvailable ? "Native Flash" : "Native Flash · 未启用",
      subtitle: qwenNativeAvailable ? "端到端实时语音 · 更低成本、更快响应" : nativeDisabledSubtitle,
      engine: "omni_realtime",
      provider: "qwen",
      model: QWEN_AUDIO_REALTIME_FLASH,
      recommendedTurnDetection: "smart_turn",
    },
    {
      id: "native_plus",
      title: qwenNativeAvailable ? "Native Plus" : "Native Plus · 未启用",
      subtitle: qwenNativeAvailable ? "端到端实时语音 · 更强理解与自然表达" : nativeDisabledSubtitle,
      engine: "omni_realtime",
      provider: "qwen",
      model: QWEN_AUDIO_REALTIME_PLUS,
      recommendedTurnDetection: "smart_turn",
    },
  ];
}

export function resolveExperienceDefinition(
  config: AppConfig,
  experienceMode: ExperienceMode | undefined,
): RealtimeExperienceDefinition | undefined {
  if (!experienceMode) return undefined;
  return getRealtimeExperienceDefinitions(config).find((item) => item.id === experienceMode);
}

export function isQwenNativeExperienceAvailable(config: AppConfig): boolean {
  return config.qwenOmniRealtime.qwenEnabled
    && Boolean(config.qwenOmniRealtime.apiKey.trim())
    && config.qwenOmniRealtime.apiKey !== "__chat2api_live__";
}

export function isRealtimeExperienceAvailable(
  config: AppConfig,
  experience: RealtimeExperienceDefinition | undefined,
): boolean {
  if (!experience || experience.engine === "cascaded") return true;
  if (experience.provider === "chat2api") return isChat2ApiLiveAvailable();
  return isQwenNativeExperienceAvailable(config);
}

export function isNativeExperienceAvailable(config: AppConfig): boolean {
  return isQwenNativeExperienceAvailable(config) || isChat2ApiLiveAvailable();
}

export function isChat2ApiRealtimeModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized === CHAT2API_GPT_LIVE || normalized === CHAT2API_GPT_LIVE_MINI;
}

export function isQwenAudioRealtimeModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized === QWEN_AUDIO_REALTIME_PLUS || normalized === QWEN_AUDIO_REALTIME_FLASH;
}

export function isQwen35OmniRealtimeModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized.includes("qwen3.5") && normalized.includes("omni") && normalized.includes("realtime");
}
