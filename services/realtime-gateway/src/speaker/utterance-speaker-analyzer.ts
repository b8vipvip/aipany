import {
  SessionSpeakerTracker,
  type AudioFormatDescriptor,
  type SpeakerEmbeddingProvider,
  type SpeakerObservation,
  type UtteranceAudioAnalysis,
  type UtteranceAudioAnalysisOptions,
  type UtteranceAudioAnalysisProvider,
} from "@aipany/audio-intelligence";
import { INPUT_AUDIO_FORMAT } from "@aipany/protocol";

export interface UtteranceSpeakerAnalyzerOptions {
  preRollMs?: number;
  minAudioMs?: number;
  sessionMatchThreshold?: number;
  maxSpeakers?: number;
  format?: AudioFormatDescriptor;
}

export interface UtteranceSpeakerAnalysis {
  observation: SpeakerObservation;
  audioAnalysis: UtteranceAudioAnalysis;
}

/**
 * 收集 Server VAD 切出的单个语音轮次，并调用 Audio/Speaker Intelligence Provider。
 *
 * Provider 支持 v0.3 analyzeUtterance 时，一次分析同时得到：
 * embedding、轮次内 diarization、重叠讲话、环境事件、分段转写和目标说话人提取。
 * 旧 Provider 仍可只实现 extractEmbedding，Gateway 会自动降级。
 */
export class UtteranceSpeakerAnalyzer {
  private readonly tracker: SessionSpeakerTracker;
  private readonly preRollBytes: number;
  private readonly minAudioBytes: number;
  private readonly format: AudioFormatDescriptor;
  private preRollChunks: Buffer[] = [];
  private preRollSize = 0;
  private utteranceChunks: Buffer[] = [];
  private collecting = false;

  constructor(
    private readonly provider: SpeakerEmbeddingProvider,
    options: UtteranceSpeakerAnalyzerOptions = {},
  ) {
    this.format = options.format ?? INPUT_AUDIO_FORMAT;
    const bytesPerSample = this.format.encoding === "pcm_f32le" ? 4 : 2;
    const bytesPerMs = this.format.sampleRate * this.format.channels * bytesPerSample / 1000;
    this.preRollBytes = Math.max(0, Math.round((options.preRollMs ?? 350) * bytesPerMs));
    this.minAudioBytes = Math.max(1, Math.round((options.minAudioMs ?? 700) * bytesPerMs));
    this.tracker = new SessionSpeakerTracker({
      matchThreshold: options.sessionMatchThreshold,
      maxSpeakers: options.maxSpeakers,
    });
  }

  append(audio: Buffer): void {
    if (audio.length === 0) return;
    this.pushPreRoll(audio);
    if (this.collecting) this.utteranceChunks.push(audio);
  }

  startSpeech(): void {
    if (this.collecting) return;
    this.collecting = true;
    this.utteranceChunks = this.preRollChunks.length > 0
      ? [Buffer.concat(this.preRollChunks, this.preRollSize)]
      : [];
  }

  /** 兼容 v0.2 调用，只返回主说话人 observation。 */
  stopSpeech(): Promise<SpeakerObservation | undefined> | undefined {
    const detailed = this.stopSpeechDetailed();
    return detailed?.then((result) => result?.observation);
  }

  stopSpeechDetailed(
    options: UtteranceAudioAnalysisOptions = {},
  ): Promise<UtteranceSpeakerAnalysis | undefined> | undefined {
    if (!this.collecting) return undefined;
    this.collecting = false;
    const chunks = this.utteranceChunks;
    this.utteranceChunks = [];
    const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (totalBytes < this.minAudioBytes) return Promise.resolve(undefined);

    const audio = Buffer.concat(chunks, totalBytes);
    return this.analyze(audio, options);
  }

  reset(): void {
    this.collecting = false;
    this.utteranceChunks = [];
    this.preRollChunks = [];
    this.preRollSize = 0;
  }

  private async analyze(
    audio: Buffer,
    options: UtteranceAudioAnalysisOptions,
  ): Promise<UtteranceSpeakerAnalysis> {
    const provider = this.provider as SpeakerEmbeddingProvider & Partial<UtteranceAudioAnalysisProvider>;
    const audioAnalysis = typeof provider.analyzeUtterance === "function"
      ? await provider.analyzeUtterance(audio, this.format, options)
      : await this.fallbackAnalysis(audio);

    const observedAt = Date.now();
    const mappedSegments = audioAnalysis.diarization.map((segment) => {
      if (!segment.embedding?.length) return { ...segment };
      const assignment = this.tracker.observe(segment.embedding, observedAt + segment.startMs);
      return { ...segment, speakerId: assignment.sessionSpeakerId };
    });

    const assignment = this.tracker.observe(audioAnalysis.embedding, observedAt);
    for (const segment of mappedSegments) {
      if (!segment.embedding && mappedSegments.length === 1) segment.speakerId = assignment.sessionSpeakerId;
    }
    audioAnalysis.diarization = mappedSegments;

    return {
      observation: {
        sessionSpeakerId: assignment.sessionSpeakerId,
        observedAt,
        speechDurationMs: audioAnalysis.durationMs,
        confidence: audioAnalysis.quality,
        embedding: audioAnalysis.embedding,
        proximity: audioAnalysis.proximity ?? "unknown",
        environment: audioAnalysis.environment,
      },
      audioAnalysis,
    };
  }

  private async fallbackAnalysis(audio: Buffer): Promise<UtteranceAudioAnalysis> {
    const result = await this.provider.extractEmbedding(audio, this.format);
    return {
      ...result,
      diarization: [],
      overlapDetected: false,
    };
  }

  private pushPreRoll(audio: Buffer): void {
    if (this.preRollBytes === 0) return;
    this.preRollChunks.push(audio);
    this.preRollSize += audio.length;

    while (this.preRollSize > this.preRollBytes && this.preRollChunks.length > 0) {
      const first = this.preRollChunks[0];
      if (!first) break;
      const overflow = this.preRollSize - this.preRollBytes;
      if (first.length <= overflow) {
        this.preRollChunks.shift();
        this.preRollSize -= first.length;
        continue;
      }
      this.preRollChunks[0] = first.subarray(overflow);
      this.preRollSize -= overflow;
      break;
    }
  }
}
