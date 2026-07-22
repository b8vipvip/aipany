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
      title: "Native Flash",
      subtitle: "端到端实时语音 · 更低成本、更快响应",
      engine: "omni_realtime",
      model: QWEN_AUDIO_REALTIME_FLASH,
      recommendedTurnDetection: "smart_turn",
    },
    {
      id: "native_plus",
      title: "Native Plus",
      subtitle: "端到端实时语音 · 更强理解与自然表达",
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

export function isQwenAudioRealtimeModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized === QWEN_AUDIO_REALTIME_PLUS || normalized === QWEN_AUDIO_REALTIME_FLASH;
}

export function isQwen35OmniRealtimeModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized.includes("qwen3.5") && normalized.includes("omni") && normalized.includes("realtime");
}
