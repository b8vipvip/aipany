import type {
  AudioFormatDescriptor,
  SpeakerEmbeddingResult,
  SpeakerIntelligenceCapabilities,
  UtteranceAudioAnalysis,
  UtteranceAudioAnalysisOptions,
  UtteranceAudioAnalysisProvider,
} from "../types.js";
import {
  HttpSpeakerIntelligenceProvider as LocalHttpSpeakerIntelligenceProvider,
  type HttpSpeakerIntelligenceProviderOptions,
} from "./http-speaker-intelligence-provider.js";
import { HybridAudioIntelligenceProvider } from "./hybrid-audio-intelligence-provider.js";
import { HttpRemoteTargetSpeakerProvider } from "./http-remote-target-speaker-provider.js";
import { QwenOmniCloudAudioProvider } from "./qwen-omni-cloud-audio-provider.js";

/**
 * Gateway 默认入口。通过环境变量自动组装 v0.4 三层架构，同时保持 v0.3 构造函数兼容。
 */
export class AutoHybridSpeakerIntelligenceProvider implements UtteranceAudioAnalysisProvider {
  readonly name = "auto-hybrid-speaker-intelligence";
  private readonly local: LocalHttpSpeakerIntelligenceProvider;
  private readonly hybrid: HybridAudioIntelligenceProvider;

  constructor(options: HttpSpeakerIntelligenceProviderOptions) {
    this.local = new LocalHttpSpeakerIntelligenceProvider(options);
    const cloudEnabled = envBool("CLOUD_AUDIO_INTELLIGENCE_ENABLED", false);
    const remoteEnabled = envBool("REMOTE_SEPARATION_ENABLED", false);
    const cloud = cloudEnabled
      ? new QwenOmniCloudAudioProvider({
          baseUrl: process.env.QWEN_OMNI_BASE_URL || defaultOmniBaseUrl(),
          apiKey: process.env.QWEN_OMNI_API_KEY || process.env.DASHSCOPE_API_KEY || "",
          model: process.env.QWEN_OMNI_MODEL || "qwen3.5-omni-flash",
          timeoutMs: envInt("CLOUD_AUDIO_TIMEOUT_MS", 30000),
        })
      : undefined;
    const remoteBaseUrl = process.env.REMOTE_SEPARATION_BASE_URL?.trim();
    const remoteTargetSpeaker = remoteEnabled && remoteBaseUrl
      ? new HttpRemoteTargetSpeakerProvider({
          baseUrl: remoteBaseUrl,
          token: process.env.REMOTE_SEPARATION_TOKEN,
          timeoutMs: envInt("REMOTE_SEPARATION_TIMEOUT_MS", 30000),
          analysisTimeoutMs: envInt("REMOTE_SEPARATION_TIMEOUT_MS", 30000),
          language: process.env.QWEN_ASR_LANGUAGE || "zh",
        })
      : undefined;
    this.hybrid = new HybridAudioIntelligenceProvider({
      local: this.local,
      cloud,
      remoteTargetSpeaker,
      remoteSeparationTrigger: parseRemoteTrigger(process.env.REMOTE_SEPARATION_TRIGGER),
    });
  }

  extractEmbedding(audio: Buffer, format: AudioFormatDescriptor): Promise<SpeakerEmbeddingResult> {
    return this.hybrid.extractEmbedding(audio, format);
  }

  analyzeUtterance(audio: Buffer, format: AudioFormatDescriptor, options?: UtteranceAudioAnalysisOptions): Promise<UtteranceAudioAnalysis> {
    return this.hybrid.analyzeUtterance(audio, format, {
      ...options,
      includeTranscript: Boolean(options?.includeTranscript && envBool("CLOUD_AUDIO_DIARIZED_TRANSCRIPTION_ENABLED", true)),
      enableEnvironment: Boolean(options?.enableEnvironment && envBool("CLOUD_AUDIO_ENVIRONMENT_ENABLED", true)),
    });
  }

  getCapabilities(): Promise<SpeakerIntelligenceCapabilities> {
    return this.hybrid.getCapabilities();
  }

  healthCheck(): Promise<boolean> {
    return this.local.healthCheck();
  }
}

function defaultOmniBaseUrl(): string {
  const workspaceId = process.env.DASHSCOPE_WORKSPACE_ID?.trim();
  return workspaceId
    ? `https://${workspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`
    : "https://dashscope.aliyuncs.com/compatible-mode/v1";
}

function envBool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function parseRemoteTrigger(value: string | undefined): "overlap_only" | "overlap_or_multi_speaker" | "always_owner_focus" {
  if (value === "overlap_only" || value === "always_owner_focus") return value;
  return "overlap_or_multi_speaker";
}
