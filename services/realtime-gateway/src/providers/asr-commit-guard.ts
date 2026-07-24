export type AsrCommitSuppressionReason =
  | "commit_pending"
  | "commit_cooldown"
  | "no_speech_evidence";

export interface AsrCommitDecision {
  allowed: boolean;
  reason?: AsrCommitSuppressionReason;
  speechLikeMs: number;
  serverSpeechEvidence: boolean;
}

export interface AsrCommitGuardOptions {
  sampleRate?: number;
  minimumSpeechLikeMs?: number;
  minimumCommitIntervalMs?: number;
  pendingTimeoutMs?: number;
  speechThresholdDbfs?: number;
}

/**
 * Defensive guard around manual ASR commits.
 *
 * Economy Live continuously streams PCM while Qwen Server VAD is active. A
 * client-side false endpoint can therefore ask DashScope to commit an empty
 * logical utterance even though the socket has received plenty of silence. This
 * guard requires either upstream VAD evidence or a minimum amount of recent
 * speech-like PCM, and allows only one commit until the transcript resolves.
 */
export class AsrCommitGuard {
  private readonly sampleRate: number;
  private readonly minimumSpeechLikeMs: number;
  private readonly minimumCommitIntervalMs: number;
  private readonly pendingTimeoutMs: number;
  private readonly speechThresholdDbfs: number;

  private speechLikeMs = 0;
  private serverSpeechEvidence = false;
  private commitPending = false;
  private pendingSinceMs = 0;
  private lastCommitAtMs = Number.NEGATIVE_INFINITY;

  constructor(options: AsrCommitGuardOptions = {}) {
    this.sampleRate = options.sampleRate ?? 16_000;
    this.minimumSpeechLikeMs = options.minimumSpeechLikeMs ?? 160;
    this.minimumCommitIntervalMs = options.minimumCommitIntervalMs ?? 500;
    this.pendingTimeoutMs = options.pendingTimeoutMs ?? 4_000;
    this.speechThresholdDbfs = options.speechThresholdDbfs ?? -48;
  }

  observeAudio(audio: Buffer): void {
    if (audio.length < 2) return;
    const durationMs = (Math.floor(audio.length / 2) / this.sampleRate) * 1_000;
    const dbfs = estimatePcm16Dbfs(audio);
    if (dbfs >= this.speechThresholdDbfs) {
      this.speechLikeMs = Math.min(2_000, this.speechLikeMs + durationMs);
    } else {
      this.speechLikeMs = Math.max(0, this.speechLikeMs - durationMs * 0.75);
    }
  }

  markServerSpeechStarted(): void {
    this.serverSpeechEvidence = true;
  }

  markPartial(text: string): void {
    if (text.trim()) this.serverSpeechEvidence = true;
  }

  tryCommit(nowMs = Date.now()): AsrCommitDecision {
    if (this.commitPending) {
      const pendingAgeMs = nowMs - this.pendingSinceMs;
      if (pendingAgeMs >= 0 && pendingAgeMs < this.pendingTimeoutMs) {
        return this.decision(false, "commit_pending");
      }
      this.commitPending = false;
      this.pendingSinceMs = 0;
    }

    if (nowMs - this.lastCommitAtMs < this.minimumCommitIntervalMs) {
      return this.decision(false, "commit_cooldown");
    }

    if (!this.serverSpeechEvidence && this.speechLikeMs < this.minimumSpeechLikeMs) {
      return this.decision(false, "no_speech_evidence");
    }

    this.commitPending = true;
    this.pendingSinceMs = nowMs;
    this.lastCommitAtMs = nowMs;
    return this.decision(true);
  }

  resolve(): void {
    this.commitPending = false;
    this.pendingSinceMs = 0;
    this.speechLikeMs = 0;
    this.serverSpeechEvidence = false;
  }

  reset(): void {
    this.resolve();
    this.lastCommitAtMs = Number.NEGATIVE_INFINITY;
  }

  snapshot(): Pick<AsrCommitDecision, "speechLikeMs" | "serverSpeechEvidence"> {
    return {
      speechLikeMs: Math.round(this.speechLikeMs),
      serverSpeechEvidence: this.serverSpeechEvidence,
    };
  }

  private decision(allowed: boolean, reason?: AsrCommitSuppressionReason): AsrCommitDecision {
    return {
      allowed,
      reason,
      speechLikeMs: Math.round(this.speechLikeMs),
      serverSpeechEvidence: this.serverSpeechEvidence,
    };
  }
}

export function estimatePcm16Dbfs(audio: Buffer): number {
  const sampleCount = Math.floor(audio.length / 2);
  if (sampleCount <= 0) return -96;
  let energy = 0;
  for (let offset = 0; offset + 1 < audio.length; offset += 2) {
    const sample = audio.readInt16LE(offset);
    energy += sample * sample;
  }
  const rms = Math.sqrt(energy / sampleCount);
  if (rms < 1) return -96;
  return 20 * Math.log10(rms / 32_768);
}
