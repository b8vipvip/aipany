export interface QualityLatencySample {
  speechEndToFirstAudioMs?: number;
  speechEndToPlaybackStartMs?: number;
}

export interface SessionQualityInput {
  latency: QualityLatencySample[];
  errors: number;
  abnormalDisconnect?: boolean;
}

export interface SessionQualitySummary {
  score: number;
  grade: "excellent" | "good" | "fair" | "poor";
  sampleCount: number;
  playbackSampleCount: number;
  medianSpeechEndToPlaybackStartMs?: number;
  medianSpeechEndToFirstAudioMs?: number;
  latencySource: "playback_started" | "gateway_first_audio" | "none";
  errorPenalty: number;
  disconnectPenalty: number;
}

export function scoreRealtimeSessionQuality(input: SessionQualityInput): SessionQualitySummary {
  const playback = input.latency
    .map((sample) => sample.speechEndToPlaybackStartMs)
    .filter(isFiniteNumber);
  const gateway = input.latency
    .map((sample) => sample.speechEndToFirstAudioMs)
    .filter(isFiniteNumber);
  const playbackMedian = median(playback);
  const gatewayMedian = median(gateway);
  const latencySource = playbackMedian !== undefined
    ? "playback_started"
    : gatewayMedian !== undefined
      ? "gateway_first_audio"
      : "none";
  const latencyMs = playbackMedian ?? gatewayMedian;
  const latencyScore = latencyMs === undefined ? 72 : scoreLatency(latencyMs);
  const errorPenalty = Math.min(32, Math.max(0, input.errors) * 7);
  const disconnectPenalty = input.abnormalDisconnect ? 16 : 0;
  const score = Math.round(clamp(latencyScore - errorPenalty - disconnectPenalty, 0, 100));

  return {
    score,
    grade: score >= 90 ? "excellent" : score >= 76 ? "good" : score >= 60 ? "fair" : "poor",
    sampleCount: Math.max(playback.length, gateway.length),
    playbackSampleCount: playback.length,
    medianSpeechEndToPlaybackStartMs: playbackMedian,
    medianSpeechEndToFirstAudioMs: gatewayMedian,
    latencySource,
    errorPenalty,
    disconnectPenalty,
  };
}

function scoreLatency(latencyMs: number): number {
  if (latencyMs <= 500) return 100;
  if (latencyMs <= 800) return interpolate(latencyMs, 500, 800, 100, 93);
  if (latencyMs <= 1200) return interpolate(latencyMs, 800, 1200, 93, 84);
  if (latencyMs <= 2000) return interpolate(latencyMs, 1200, 2000, 84, 70);
  if (latencyMs <= 3500) return interpolate(latencyMs, 2000, 3500, 70, 50);
  if (latencyMs <= 7000) return interpolate(latencyMs, 3500, 7000, 50, 28);
  return 20;
}

function interpolate(value: number, from: number, to: number, high: number, low: number): number {
  const ratio = clamp((value - from) / Math.max(1, to - from), 0, 1);
  return high + (low - high) * ratio;
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return Math.round(sorted[middle] ?? 0);
  return Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
}

function isFiniteNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
