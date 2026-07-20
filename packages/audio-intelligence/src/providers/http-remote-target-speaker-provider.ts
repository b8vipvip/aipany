import type { AudioFormatDescriptor, TargetSpeakerExtractionProvider, TargetSpeakerExtractionResult } from "../types.js";
import { HttpSpeakerIntelligenceProvider, type HttpSpeakerIntelligenceProviderOptions } from "./http-speaker-intelligence-provider.js";

export interface HttpRemoteTargetSpeakerProviderOptions extends HttpSpeakerIntelligenceProviderOptions {
  language?: string;
}

/**
 * Remote GPU 适配器。
 * 远端只需部署兼容 Aipany /v1/analyze 协议的 Speaker Intelligence 服务，
 * 即可把 SepFormer 从 Gateway 所在低配服务器迁移到按需 GPU Worker。
 */
export class HttpRemoteTargetSpeakerProvider implements TargetSpeakerExtractionProvider {
  readonly name = "http-remote-target-speaker";
  private readonly delegate: HttpSpeakerIntelligenceProvider;

  constructor(private readonly options: HttpRemoteTargetSpeakerProviderOptions) {
    this.delegate = new HttpSpeakerIntelligenceProvider(options);
  }

  async extractTargetSpeaker(
    audio: Buffer,
    format: AudioFormatDescriptor,
    ownerEmbedding: number[],
  ): Promise<TargetSpeakerExtractionResult> {
    const result = await this.delegate.analyzeUtterance(audio, format, {
      mode: "owner_focus",
      language: this.options.language,
      ownerEmbedding,
      includeTranscript: true,
      enableSeparation: true,
      enableEnvironment: false,
    });
    return result.targetSpeaker ?? { matched: false, similarity: 0, confidence: 0 };
  }

  healthCheck(): Promise<boolean> {
    return this.delegate.healthCheck();
  }
}
