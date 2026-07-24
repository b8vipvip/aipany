export interface AcousticProsodySnapshot {
  durationMs: number;
  rmsDbfs: number;
  peakDbfs: number;
  dynamicRangeDb: number;
  silenceRatio: number;
  zeroCrossingRate: number;
  pitchHz?: number;
  pitchVariation: number;
  energy: "low" | "medium" | "high";
  tempoHint: "slow" | "normal" | "fast";
  confidence: number;
}

const SAMPLE_RATE = 16_000;
const PRE_ROLL_BYTES = Math.round(SAMPLE_RATE * 2 * 0.3);
const SILENCE_DBFS = -45;
const PITCH_DOWNSAMPLE = 2;
const PITCH_RATE = SAMPLE_RATE / PITCH_DOWNSAMPLE;
const PITCH_WINDOW_SAMPLES = 480;
const PITCH_INTERVAL_SOURCE_SAMPLES = 1_600;

/**
 * CPU-light streaming prosody analysis for PCM16 mono input.
 * It is intentionally descriptive rather than diagnostic: the output nudges
 * conversational delivery but never claims to infer a user's mental state.
 */
export class AcousticProsodyAnalyzer {
  private active = false;
  private sampleCount = 0;
  private sumSquares = 0;
  private peak = 0;
  private zeroCrossings = 0;
  private previousSample = 0;
  private hasPrevious = false;
  private readonly frameDbfs: number[] = [];
  private readonly pitchEstimates: number[] = [];
  private readonly pitchWindow: number[] = [];
  private pitchSourceSamplesSinceEstimate = 0;
  private preRoll: Buffer[] = [];
  private preRollBytes = 0;

  append(audio: Buffer): void {
    if (!audio.length) return;
    this.pushPreRoll(audio);
    if (this.active) this.process(audio);
  }

  beginSpeech(): void {
    this.resetMetrics();
    this.active = true;
    if (this.preRollBytes > 0) this.process(Buffer.concat(this.preRoll, this.preRollBytes));
  }

  endSpeech(): AcousticProsodySnapshot | undefined {
    if (!this.active || this.sampleCount < 160) {
      this.active = false;
      return undefined;
    }
    this.active = false;
    const durationMs = Math.max(10, Math.round(this.sampleCount / SAMPLE_RATE * 1_000));
    const rms = Math.sqrt(this.sumSquares / Math.max(1, this.sampleCount));
    const rmsDbfs = amplitudeToDbfs(rms);
    const peakDbfs = amplitudeToDbfs(this.peak);
    const sortedFrames = [...this.frameDbfs].sort((a, b) => a - b);
    const p10 = percentile(sortedFrames, 0.1, rmsDbfs);
    const p90 = percentile(sortedFrames, 0.9, rmsDbfs);
    const silenceFrames = this.frameDbfs.filter((value) => value <= SILENCE_DBFS).length;
    const silenceRatio = this.frameDbfs.length ? silenceFrames / this.frameDbfs.length : 0;
    const zeroCrossingRate = this.zeroCrossings / Math.max(1, this.sampleCount - 1);
    const validPitch = this.pitchEstimates.filter((value) => Number.isFinite(value) && value >= 55 && value <= 520);
    const pitchHz = validPitch.length ? mean(validPitch) : undefined;
    const pitchVariation = pitchHz && validPitch.length >= 2
      ? clamp(standardDeviation(validPitch) / pitchHz, 0, 1)
      : 0;
    const energy = rmsDbfs < -31 ? "low" : rmsDbfs > -19 ? "high" : "medium";
    const tempoHint = inferTempoHint({ durationMs, silenceRatio, zeroCrossingRate, pitchVariation });
    const confidence = clamp(
      0.25
      + Math.min(0.35, durationMs / 8_000 * 0.35)
      + Math.min(0.2, this.frameDbfs.length / 80 * 0.2)
      + Math.min(0.2, validPitch.length / 12 * 0.2),
      0,
      1,
    );

    return {
      durationMs,
      rmsDbfs: round(rmsDbfs),
      peakDbfs: round(peakDbfs),
      dynamicRangeDb: round(Math.max(0, p90 - p10)),
      silenceRatio: round(clamp(silenceRatio, 0, 1), 3),
      zeroCrossingRate: round(clamp(zeroCrossingRate, 0, 1), 4),
      pitchHz: pitchHz ? round(pitchHz) : undefined,
      pitchVariation: round(pitchVariation, 3),
      energy,
      tempoHint,
      confidence: round(confidence, 3),
    };
  }

  reset(): void {
    this.active = false;
    this.resetMetrics();
    this.preRoll = [];
    this.preRollBytes = 0;
  }

  private process(audio: Buffer): void {
    const usable = audio.length - (audio.length % 2);
    if (usable <= 0) return;
    let frameSquares = 0;
    let frameSamples = 0;

    for (let offset = 0, index = 0; offset < usable; offset += 2, index += 1) {
      const sample = audio.readInt16LE(offset) / 32768;
      const absolute = Math.abs(sample);
      const square = sample * sample;
      this.sampleCount += 1;
      this.sumSquares += square;
      frameSquares += square;
      frameSamples += 1;
      if (absolute > this.peak) this.peak = absolute;
      if (this.hasPrevious && ((sample >= 0) !== (this.previousSample >= 0))) this.zeroCrossings += 1;
      this.previousSample = sample;
      this.hasPrevious = true;

      if (index % PITCH_DOWNSAMPLE === 0) {
        this.pitchWindow.push(sample);
        if (this.pitchWindow.length > PITCH_WINDOW_SAMPLES) this.pitchWindow.shift();
      }
      this.pitchSourceSamplesSinceEstimate += 1;
      if (this.pitchSourceSamplesSinceEstimate >= PITCH_INTERVAL_SOURCE_SAMPLES) {
        this.pitchSourceSamplesSinceEstimate = 0;
        const pitch = estimatePitch(this.pitchWindow);
        if (pitch !== undefined) this.pitchEstimates.push(pitch);
      }
    }

    if (frameSamples > 0) {
      const frameRms = Math.sqrt(frameSquares / frameSamples);
      this.frameDbfs.push(amplitudeToDbfs(frameRms));
      if (this.frameDbfs.length > 600) this.frameDbfs.shift();
    }
  }

  private pushPreRoll(audio: Buffer): void {
    const copy = Buffer.from(audio);
    this.preRoll.push(copy);
    this.preRollBytes += copy.length;
    while (this.preRollBytes > PRE_ROLL_BYTES && this.preRoll.length > 1) {
      const removed = this.preRoll.shift();
      if (removed) this.preRollBytes -= removed.length;
    }
  }

  private resetMetrics(): void {
    this.sampleCount = 0;
    this.sumSquares = 0;
    this.peak = 0;
    this.zeroCrossings = 0;
    this.previousSample = 0;
    this.hasPrevious = false;
    this.frameDbfs.splice(0);
    this.pitchEstimates.splice(0);
    this.pitchWindow.splice(0);
    this.pitchSourceSamplesSinceEstimate = 0;
  }
}

function estimatePitch(window: number[]): number | undefined {
  if (window.length < 240) return undefined;
  const meanValue = mean(window);
  const centered = window.map((value) => value - meanValue);
  const energy = centered.reduce((sum, value) => sum + value * value, 0);
  if (energy / centered.length < 0.00002) return undefined;

  const minLag = Math.floor(PITCH_RATE / 500);
  const maxLag = Math.min(Math.floor(PITCH_RATE / 60), centered.length - 40);
  let bestLag = 0;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let correlation = 0;
    let leftEnergy = 0;
    let rightEnergy = 0;
    const limit = centered.length - lag;
    for (let index = 0; index < limit; index += 1) {
      const left = centered[index] ?? 0;
      const right = centered[index + lag] ?? 0;
      correlation += left * right;
      leftEnergy += left * left;
      rightEnergy += right * right;
    }
    const denominator = Math.sqrt(leftEnergy * rightEnergy);
    if (denominator <= 0) continue;
    const score = correlation / denominator;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  if (bestLag <= 0 || bestScore < 0.45) return undefined;
  return PITCH_RATE / bestLag;
}

function inferTempoHint(input: {
  durationMs: number;
  silenceRatio: number;
  zeroCrossingRate: number;
  pitchVariation: number;
}): "slow" | "normal" | "fast" {
  const fastScore = (input.silenceRatio < 0.08 ? 1 : 0)
    + (input.zeroCrossingRate > 0.12 ? 1 : 0)
    + (input.pitchVariation > 0.18 ? 1 : 0);
  const slowScore = (input.silenceRatio > 0.28 ? 1 : 0)
    + (input.zeroCrossingRate < 0.07 ? 1 : 0)
    + (input.durationMs > 5_000 && input.pitchVariation < 0.08 ? 1 : 0);
  if (fastScore >= 2 && fastScore > slowScore) return "fast";
  if (slowScore >= 2 && slowScore > fastScore) return "slow";
  return "normal";
}

function amplitudeToDbfs(value: number): number {
  if (value <= 0.000001) return -120;
  return 20 * Math.log10(value);
}

function percentile(values: number[], ratio: number, fallback: number): number {
  if (!values.length) return fallback;
  const index = Math.min(values.length - 1, Math.max(0, Math.round((values.length - 1) * ratio)));
  return values[index] ?? fallback;
}

function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: number[]): number {
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function round(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
