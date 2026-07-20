import type {
  AudioFormatDescriptor,
  EnvironmentContext,
  SpeakerDiarizationSegment,
  SpeakerEmbeddingResult,
  SpeakerIntelligenceCapabilities,
  TargetSpeakerExtractionProvider,
  UtteranceAudioAnalysis,
  UtteranceAudioAnalysisOptions,
  UtteranceAudioAnalysisProvider,
} from "../types.js";

export interface CloudAudioAnalysisOptions {
  language?: string;
  includeDiarization?: boolean;
  includeEnvironment?: boolean;
}

export interface CloudAudioAnalysis {
  diarization: SpeakerDiarizationSegment[];
  environment?: EnvironmentContext;
  provider?: string;
}

export interface CloudAudioAnalysisProvider {
  readonly name: string;
  analyzeCloudAudio(
    audio: Buffer,
    format: AudioFormatDescriptor,
    options?: CloudAudioAnalysisOptions,
  ): Promise<CloudAudioAnalysis>;
  healthCheck?(): Promise<boolean>;
}

export type RemoteSeparationTrigger = "overlap_only" | "overlap_or_multi_speaker" | "always_owner_focus";

export interface HybridAudioIntelligenceProviderOptions {
  local: UtteranceAudioAnalysisProvider;
  cloud?: CloudAudioAnalysisProvider;
  remoteTargetSpeaker?: TargetSpeakerExtractionProvider;
  remoteSeparationTrigger?: RemoteSeparationTrigger;
}

/**
 * v0.4 混合 Audio Intelligence 编排层。
 *
 * Local Realtime 始终负责低延迟 embedding / diarization / overlap hints；
 * Cloud Intelligence 按需补充环境理解和分说话人转写；
 * Remote GPU 只在策略命中时执行目标说话人分离。
 * 任一增强能力失败都 fail-open，保留本地结果，绝不阻断主语音链路。
 */
export class HybridAudioIntelligenceProvider implements UtteranceAudioAnalysisProvider {
  readonly name = "hybrid-audio-intelligence";
  private readonly remoteSeparationTrigger: RemoteSeparationTrigger;

  constructor(private readonly options: HybridAudioIntelligenceProviderOptions) {
    this.remoteSeparationTrigger = options.remoteSeparationTrigger ?? "overlap_or_multi_speaker";
  }

  extractEmbedding(audio: Buffer, format: AudioFormatDescriptor): Promise<SpeakerEmbeddingResult> {
    return this.options.local.extractEmbedding(audio, format);
  }

  async getCapabilities(): Promise<SpeakerIntelligenceCapabilities> {
    const local = await this.options.local.getCapabilities?.().catch(() => undefined);
    return {
      embeddings: local?.embeddings ?? true,
      verification: local?.verification ?? true,
      diarization: Boolean(local?.diarization || this.options.cloud),
      streamingDiarization: Boolean(local?.streamingDiarization),
      overlapDetection: Boolean(local?.overlapDetection || this.options.remoteTargetSpeaker),
      speechSeparation: Boolean(local?.speechSeparation || this.options.remoteTargetSpeaker),
      targetSpeakerExtraction: Boolean(local?.targetSpeakerExtraction || this.options.remoteTargetSpeaker),
      environmentAnalysis: Boolean(local?.environmentAnalysis || this.options.cloud),
      segmentTranscription: Boolean(local?.segmentTranscription || this.options.cloud),
    };
  }

  async healthCheck(): Promise<boolean> {
    if (!this.options.local.healthCheck) return true;
    return this.options.local.healthCheck();
  }

  async analyzeUtterance(
    audio: Buffer,
    format: AudioFormatDescriptor,
    options: UtteranceAudioAnalysisOptions = {},
  ): Promise<UtteranceAudioAnalysis> {
    const cloudPromise = this.shouldUseCloud(options)
      ? this.options.cloud?.analyzeCloudAudio(audio, format, {
          language: options.language,
          includeDiarization: Boolean(options.includeTranscript),
          includeEnvironment: Boolean(options.enableEnvironment),
        })
      : undefined;

    const localOptions: UtteranceAudioAnalysisOptions = {
      ...options,
      // Cloud provider 存在时关闭本地 Whisper / AST，避免重复重推理。
      includeTranscript: this.options.cloud ? false : options.includeTranscript,
      enableEnvironment: this.options.cloud ? false : options.enableEnvironment,
      // Remote GPU 存在时本地不加载 SepFormer。
      enableSeparation: this.options.remoteTargetSpeaker ? false : options.enableSeparation,
      ownerEmbedding: this.options.remoteTargetSpeaker ? undefined : options.ownerEmbedding,
    };

    const local = await this.options.local.analyzeUtterance(audio, format, localOptions);
    const cloud = cloudPromise ? await settle(cloudPromise) : undefined;

    if (cloud) {
      local.diarization = mergeDiarization(local.diarization, cloud.diarization);
      if (cloud.environment) local.environment = cloud.environment;
    }

    if (
      options.enableSeparation
      && options.ownerEmbedding?.length
      && this.options.remoteTargetSpeaker
      && shouldInvokeRemoteSeparation(local, options.mode, this.remoteSeparationTrigger)
    ) {
      const remoteTarget = await settle(
        this.options.remoteTargetSpeaker.extractTargetSpeaker(audio, format, options.ownerEmbedding),
      );
      if (remoteTarget) {
        local.targetSpeaker = remoteTarget;
        if (remoteTarget.matched) local.overlapDetected = true;
      }
    }

    return local;
  }

  private shouldUseCloud(options: UtteranceAudioAnalysisOptions): boolean {
    if (!this.options.cloud) return false;
    return Boolean(options.includeTranscript || options.enableEnvironment);
  }
}

function shouldInvokeRemoteSeparation(
  analysis: UtteranceAudioAnalysis,
  mode: UtteranceAudioAnalysisOptions["mode"],
  trigger: RemoteSeparationTrigger,
): boolean {
  if (trigger === "always_owner_focus") return mode === "owner_focus";
  if (analysis.overlapDetected) return true;
  if (trigger === "overlap_only") return false;
  return new Set(analysis.diarization.map((segment) => segment.speakerId)).size >= 2;
}

function mergeDiarization(
  localSegments: SpeakerDiarizationSegment[],
  cloudSegments: SpeakerDiarizationSegment[],
): SpeakerDiarizationSegment[] {
  if (cloudSegments.length === 0) return localSegments;
  if (localSegments.length === 0) return cloudSegments;

  const enriched = localSegments.map((local) => {
    const best = cloudSegments
      .map((cloud) => ({ cloud, overlap: overlapMs(local, cloud) }))
      .sort((a, b) => b.overlap - a.overlap)[0];
    if (!best || best.overlap <= 0) return local;
    return {
      ...local,
      transcript: best.cloud.transcript ?? local.transcript,
      overlap: Boolean(local.overlap || best.cloud.overlap),
      confidence: Math.max(local.confidence, best.cloud.confidence),
    };
  });

  // 云端可能切出本地 diarization 未覆盖的短段，保留下来用于多人转写展示。
  for (const cloud of cloudSegments) {
    if (enriched.some((local) => overlapMs(local, cloud) > 0)) continue;
    enriched.push(cloud);
  }
  return enriched.sort((a, b) => a.startMs - b.startMs);
}

function overlapMs(a: SpeakerDiarizationSegment, b: SpeakerDiarizationSegment): number {
  return Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));
}

async function settle<T>(promise: Promise<T>): Promise<T | undefined> {
  try {
    return await promise;
  } catch {
    return undefined;
  }
}
