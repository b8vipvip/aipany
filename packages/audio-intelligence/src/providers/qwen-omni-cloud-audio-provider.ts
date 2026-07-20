import type { AudioFormatDescriptor } from "../types.js";
import type { CloudAudioAnalysis, CloudAudioAnalysisOptions, CloudAudioAnalysisProvider } from "./hybrid-audio-intelligence-provider.js";

export interface QwenOmniCloudAudioProviderOptions {
  baseUrl: string;
  apiKey: string;
  model?: string;
  timeoutMs?: number;
}

export class QwenOmniCloudAudioProvider implements CloudAudioAnalysisProvider {
  readonly name = "qwen-omni-cloud-audio";

  constructor(private readonly options: QwenOmniCloudAudioProviderOptions) {}

  async analyzeCloudAudio(
    audio: Buffer,
    format: AudioFormatDescriptor,
    options: CloudAudioAnalysisOptions = {},
  ): Promise<CloudAudioAnalysis> {
    void audio;
    void format;
    void options;
    throw new Error(`Qwen Omni provider is not configured: ${this.options.baseUrl}`);
  }
}
