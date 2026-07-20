import {
  SessionSpeakerTracker,
  type SpeakerEmbeddingProvider,
  type SpeakerObservation,
} from "@aipany/audio-intelligence";
import { INPUT_AUDIO_FORMAT } from "@aipany/protocol";

export interface UtteranceSpeakerAnalyzerOptions {
  preRollMs?: number;
  minAudioMs?: number;
  sessionMatchThreshold?: number;
  maxSpeakers?: number;
}

/**
 * 收集千问 Server VAD 切出的单个语音轮次，并调用 Speaker Intelligence Provider。
 *
 * 设计原则：
 * - 预留一小段 pre-roll，避免远端 VAD 的 speech_started 事件到达时丢失句首。
 * - 每个 VAD 轮次只提取一次 embedding，控制 CPU/GPU 成本。
 * - 会话内先用 embedding 聚类生成稳定 Speaker ID，再交给长期 Voice Profile 做人物匹配。
 */
export class UtteranceSpeakerAnalyzer {
  private readonly tracker: SessionSpeakerTracker;
  private readonly preRollBytes: number;
  private readonly minAudioBytes: number;
  private preRollChunks: Buffer[] = [];
  private preRollSize = 0;
  private utteranceChunks: Buffer[] = [];
  private collecting = false;

  constructor(
    private readonly provider: SpeakerEmbeddingProvider,
    options: UtteranceSpeakerAnalyzerOptions = {},
  ) {
    const bytesPerMs = INPUT_AUDIO_FORMAT.sampleRate * INPUT_AUDIO_FORMAT.channels * 2 / 1000;
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

  stopSpeech(): Promise<SpeakerObservation | undefined> | undefined {
    if (!this.collecting) return undefined;
    this.collecting = false;
    const chunks = this.utteranceChunks;
    this.utteranceChunks = [];
    const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (totalBytes < this.minAudioBytes) return Promise.resolve(undefined);

    const audio = Buffer.concat(chunks, totalBytes);
    return this.analyze(audio);
  }

  reset(): void {
    this.collecting = false;
    this.utteranceChunks = [];
    this.preRollChunks = [];
    this.preRollSize = 0;
  }

  private async analyze(audio: Buffer): Promise<SpeakerObservation> {
    const result = await this.provider.extractEmbedding(audio, {
      encoding: INPUT_AUDIO_FORMAT.encoding,
      sampleRate: INPUT_AUDIO_FORMAT.sampleRate,
      channels: INPUT_AUDIO_FORMAT.channels,
    });
    const observedAt = Date.now();
    const assignment = this.tracker.observe(result.embedding, observedAt);

    return {
      sessionSpeakerId: assignment.sessionSpeakerId,
      observedAt,
      speechDurationMs: result.durationMs,
      confidence: result.quality,
      embedding: result.embedding,
      proximity: "unknown",
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
