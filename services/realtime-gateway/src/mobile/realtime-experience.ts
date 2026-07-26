import type { ExperienceMode } from "@aipany/protocol";
import type { AppConfig } from "../config.js";
import type { RealtimeEngine } from "../observability/realtime-observability.js";

export const QWEN_AUDIO_REALTIME_PLUS = "qwen-audio-3.0-realtime-plus";
export const QWEN_AUDIO_REALTIME_FLASH = "qwen-audio-3.0-realtime-flash";

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
  model: string;
  recommendedTurnDetection?: "server_vad" | "smart_turn" | "semantic_vad";
}

export function getRealtimeExperienceDefinitions(config: AppConfig): RealtimeExperienceDefinition[] {
  const nativeAvailable = isNativeExperienceAvailable(config);
  const nativeDisabledSubtitle = "音色仍可试听 · 服务器尚未开启 Native Live，正式会话会自动回退到 Economy Live";
  return [
    {
      id: "economy_live",
      title: "Economy Live",
      subtitle: "低成本实时链路 · 流式 ASR + LLM + 情绪化 TTS",
      engine: "cascaded",
      model: config.qwen.ttsModel,
    },
    {
      id: "native_flash",
      title: nativeAvailable ? "Native Flash" : "Native Flash · 未启用",
      subtitle: nativeAvailable ? "端到端实时语音 · 更低成本、更快响应" : nativeDisabledSubtitle,
      engine: "omni_realtime",
      model: QWEN_AUDIO_REALTIME_FLASH,
      recommendedTurnDetection: "smart_turn",
    },
    {
      id: "native_plus",
      title: nativeAvailable ? "Native Plus" : "Native Plus · 未启用",
      subtitle: nativeAvailable ? "端到端实时语音 · 更强理解与自然表达" : nativeDisabledSubtitle,
      engine: "omni_realtime",
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

export function isNativeExperienceAvailable(config: AppConfig): boolean {
  return config.qwenOmniRealtime.enabled && Boolean(config.qwenOmniRealtime.apiKey.trim());
}

export function isQwenAudioRealtimeModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized === QWEN_AUDIO_REALTIME_PLUS || normalized === QWEN_AUDIO_REALTIME_FLASH;
}

export function isQwen35OmniRealtimeModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized.includes("qwen3.5") && normalized.includes("omni") && normalized.includes("realtime");
}
