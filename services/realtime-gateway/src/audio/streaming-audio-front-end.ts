import type { AudioFrontEndMetrics, AudioFormatDescriptor } from "@aipany/audio-intelligence";

export interface StreamingAudioFrontEndOptions {
  inputFormat: AudioFormatDescriptor;
  enabled?: boolean;
  aec?: boolean;
  noiseSuppression?: boolean;
  agc?: boolean;
  dereverb?: boolean;
  beamforming?: boolean;
  beamformingDelaysSamples?: number[];
  aecDelayMs?: number;
  targetRmsDbfs?: number;
  maxGain?: number;
}

export interface ProcessedAudioFrame {
  /** 波束合成后的原始单声道，供 Speaker / Environment Intelligence 使用。 */
  analysisAudio: Buffer;
  /** AEC/NS/AGC/Dereverb 后的单声道，送实时 ASR。 */
  asrAudio: Buffer;
  metrics: AudioFrontEndMetrics;
}

/**
 * 纯 Node 流式 Audio Front-End。
 *
 * 这是可运行的服务端基础实现，目标不是替代专业 DSP 芯片，而是让 App/Web/普通硬件
 * 在没有本地 WebRTC APM 时也具备统一的 AEC / NS / AGC / Dereverb / Beamforming 入口。
 * 高端硬件仍可在设备侧先做更强的阵列处理，再把干净 PCM 送入 Aipany。
 */
export class StreamingAudioFrontEnd {
  private readonly inputFormat: AudioFormatDescriptor;
  private readonly enabled: boolean;
  private readonly useAec: boolean;
  private readonly useNoiseSuppression: boolean;
  private readonly useAgc: boolean;
  private readonly useDereverb: boolean;
  private readonly useBeamforming: boolean;
  private readonly delays: number[];
  private readonly targetRms: number;
  private readonly maxGain: number;
  private readonly aecDelaySamples: number;

  private previousHighPassInput = 0;
  private previousHighPassOutput = 0;
  private agcGain = 1;
  private echoGain = 0;
  private noiseFloor = 0.006;
  private readonly dereverbDelay: Float32Array;
  private dereverbCursor = 0;

  private playbackReference: number[] = [];
  private playbackReadIndex = 0;
  private playbackPrimed = false;

  constructor(options: StreamingAudioFrontEndOptions) {
    this.inputFormat = options.inputFormat;
    if (this.inputFormat.encoding !== "pcm_s16le") {
      throw new Error("StreamingAudioFrontEnd 当前只支持 pcm_s16le");
    }
    if (this.inputFormat.sampleRate !== 16000) {
      throw new Error("StreamingAudioFrontEnd 当前要求 16kHz 输入");
    }
    if (this.inputFormat.channels < 1 || this.inputFormat.channels > 8) {
      throw new Error("StreamingAudioFrontEnd 输入声道数必须在 1-8 之间");
    }

    this.enabled = options.enabled ?? true;
    this.useAec = options.aec ?? true;
    this.useNoiseSuppression = options.noiseSuppression ?? true;
    this.useAgc = options.agc ?? true;
    this.useDereverb = options.dereverb ?? true;
    this.useBeamforming = options.beamforming ?? this.inputFormat.channels > 1;
    this.delays = normalizeDelays(options.beamformingDelaysSamples, this.inputFormat.channels);
    this.targetRms = dbfsToLinear(options.targetRmsDbfs ?? -20);
    this.maxGain = clamp(options.maxGain ?? 6, 1, 20);
    this.aecDelaySamples = Math.max(0, Math.round(this.inputFormat.sampleRate * (options.aecDelayMs ?? 120) / 1000));
    this.dereverbDelay = new Float32Array(Math.max(1, Math.round(this.inputFormat.sampleRate * 0.04)));
  }

  process(audio: Buffer): ProcessedAudioFrame {
    const channels = decodePcmS16Le(audio, this.inputFormat.channels);
    const mono = this.useBeamforming
      ? delayAndSum(channels, this.delays)
      : channels[0]?.slice() ?? new Float32Array();
    const analysisAudio = encodePcmS16Le(mono);

    if (!this.enabled || mono.length === 0) {
      return {
        analysisAudio,
        asrAudio: analysisAudio,
        metrics: {
          inputRms: rms(mono),
          outputRms: rms(mono),
          appliedGain: 1,
          echoAttenuation: 0,
          noiseSuppressionGain: 1,
          clippedSamples: countClipped(mono),
        },
      };
    }

    const inputRms = rms(mono);
    let processed = this.highPass(mono);
    let echoAttenuation = 0;
    if (this.useAec) {
      const echoResult = this.cancelEcho(processed);
      processed = echoResult.audio;
      echoAttenuation = echoResult.attenuation;
    }

    let noiseSuppressionGain = 1;
    if (this.useNoiseSuppression) {
      const suppression = this.suppressNoise(processed);
      processed = suppression.audio;
      noiseSuppressionGain = suppression.gain;
    }

    if (this.useDereverb) processed = this.reduceLateReverb(processed);

    let appliedGain = 1;
    if (this.useAgc) {
      const agc = this.applyAgc(processed);
      processed = agc.audio;
      appliedGain = agc.gain;
    }

    let clippedSamples = 0;
    for (let index = 0; index < processed.length; index += 1) {
      const value = processed[index] ?? 0;
      if (Math.abs(value) > 1) clippedSamples += 1;
      processed[index] = softLimit(value);
    }

    return {
      analysisAudio,
      asrAudio: encodePcmS16Le(processed),
      metrics: {
        inputRms,
        outputRms: rms(processed),
        appliedGain,
        echoAttenuation,
        noiseSuppressionGain,
        clippedSamples,
      },
    };
  }

  /** 将服务端正在播放的 TTS PCM 作为 AEC far-end reference。 */
  appendPlaybackReference(audio: Buffer, sampleRate: number): void {
    if (!this.useAec || audio.length === 0) return;
    const decoded = decodePcmS16Le(audio, 1)[0] ?? new Float32Array();
    const resampled = sampleRate === this.inputFormat.sampleRate
      ? decoded
      : resampleLinear(decoded, sampleRate, this.inputFormat.sampleRate);

    const unread = this.playbackReference.length - this.playbackReadIndex;
    if (!this.playbackPrimed || unread < this.aecDelaySamples / 3) {
      for (let index = 0; index < this.aecDelaySamples; index += 1) this.playbackReference.push(0);
      this.playbackPrimed = true;
    }
    for (const sample of resampled) this.playbackReference.push(sample);
    this.compactPlaybackReference();
  }

  clearPlaybackReference(): void {
    this.playbackReference = [];
    this.playbackReadIndex = 0;
    this.playbackPrimed = false;
    this.echoGain = 0;
  }

  reset(): void {
    this.previousHighPassInput = 0;
    this.previousHighPassOutput = 0;
    this.agcGain = 1;
    this.echoGain = 0;
    this.noiseFloor = 0.006;
    this.dereverbDelay.fill(0);
    this.dereverbCursor = 0;
    this.clearPlaybackReference();
  }

  private highPass(input: Float32Array): Float32Array {
    const output = new Float32Array(input.length);
    const alpha = 0.985;
    for (let index = 0; index < input.length; index += 1) {
      const sample = input[index] ?? 0;
      const filtered = sample - this.previousHighPassInput + alpha * this.previousHighPassOutput;
      this.previousHighPassInput = sample;
      this.previousHighPassOutput = filtered;
      output[index] = filtered;
    }
    return output;
  }

  private cancelEcho(input: Float32Array): { audio: Float32Array; attenuation: number } {
    const reference = this.readPlaybackReference(input.length);
    let dot = 0;
    let refEnergy = 0;
    for (let index = 0; index < input.length; index += 1) {
      const ref = reference[index] ?? 0;
      dot += (input[index] ?? 0) * ref;
      refEnergy += ref * ref;
    }

    const estimatedGain = refEnergy > 1e-8 ? clamp(dot / refEnergy, 0, 1.4) : 0;
    this.echoGain = this.echoGain * 0.82 + estimatedGain * 0.18;
    const output = new Float32Array(input.length);
    let removedEnergy = 0;
    let inputEnergy = 0;
    for (let index = 0; index < input.length; index += 1) {
      const original = input[index] ?? 0;
      const echo = (reference[index] ?? 0) * this.echoGain;
      output[index] = original - echo;
      removedEnergy += echo * echo;
      inputEnergy += original * original;
    }
    return {
      audio: output,
      attenuation: inputEnergy > 1e-8 ? clamp(removedEnergy / inputEnergy, 0, 1) : 0,
    };
  }

  private suppressNoise(input: Float32Array): { audio: Float32Array; gain: number } {
    const level = rms(input);
    if (level < this.noiseFloor * 2.2) {
      this.noiseFloor = this.noiseFloor * 0.96 + level * 0.04;
    } else {
      this.noiseFloor = this.noiseFloor * 0.998 + Math.min(level, this.noiseFloor * 1.5) * 0.002;
    }

    const snr = level / Math.max(1e-5, this.noiseFloor);
    const gain = clamp(1 - 1 / Math.max(1, snr * snr), 0.22, 1);
    const output = new Float32Array(input.length);
    for (let index = 0; index < input.length; index += 1) output[index] = (input[index] ?? 0) * gain;
    return { audio: output, gain };
  }

  private reduceLateReverb(input: Float32Array): Float32Array {
    const output = new Float32Array(input.length);
    const coefficient = 0.16;
    for (let index = 0; index < input.length; index += 1) {
      const sample = input[index] ?? 0;
      const delayed = this.dereverbDelay[this.dereverbCursor] ?? 0;
      output[index] = sample - delayed * coefficient;
      this.dereverbDelay[this.dereverbCursor] = sample;
      this.dereverbCursor = (this.dereverbCursor + 1) % this.dereverbDelay.length;
    }
    return output;
  }

  private applyAgc(input: Float32Array): { audio: Float32Array; gain: number } {
    const level = rms(input);
    const desired = level > 1e-5 ? clamp(this.targetRms / level, 0.35, this.maxGain) : 1;
    const smoothing = desired < this.agcGain ? 0.32 : 0.08;
    this.agcGain += (desired - this.agcGain) * smoothing;
    const output = new Float32Array(input.length);
    for (let index = 0; index < input.length; index += 1) output[index] = (input[index] ?? 0) * this.agcGain;
    return { audio: output, gain: this.agcGain };
  }

  private readPlaybackReference(length: number): Float32Array {
    const output = new Float32Array(length);
    for (let index = 0; index < length; index += 1) {
      output[index] = this.playbackReference[this.playbackReadIndex] ?? 0;
      if (this.playbackReadIndex < this.playbackReference.length) this.playbackReadIndex += 1;
    }
    this.compactPlaybackReference();
    return output;
  }

  private compactPlaybackReference(): void {
    if (this.playbackReadIndex < 32768) return;
    this.playbackReference = this.playbackReference.slice(this.playbackReadIndex);
    this.playbackReadIndex = 0;
  }
}

function decodePcmS16Le(audio: Buffer, channels: number): Float32Array[] {
  if (audio.length % (2 * channels) !== 0) throw new Error("PCM 数据长度与声道数不匹配");
  const frames = audio.length / 2 / channels;
  const output = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      output[channel]![frame] = audio.readInt16LE((frame * channels + channel) * 2) / 32768;
    }
  }
  return output;
}

function encodePcmS16Le(samples: Float32Array): Buffer {
  const output = Buffer.allocUnsafe(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) {
    const value = clamp(samples[index] ?? 0, -1, 1);
    output.writeInt16LE(Math.round(value * 32767), index * 2);
  }
  return output;
}

function delayAndSum(channels: Float32Array[], delays: number[]): Float32Array {
  const frames = channels[0]?.length ?? 0;
  const output = new Float32Array(frames);
  if (channels.length === 0) return output;
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    let count = 0;
    for (let channel = 0; channel < channels.length; channel += 1) {
      const source = channels[channel];
      if (!source) continue;
      const sourceIndex = frame - (delays[channel] ?? 0);
      if (sourceIndex < 0 || sourceIndex >= source.length) continue;
      sum += source[sourceIndex] ?? 0;
      count += 1;
    }
    output[frame] = count > 0 ? sum / count : 0;
  }
  return output;
}

function normalizeDelays(value: number[] | undefined, channels: number): number[] {
  return Array.from({ length: channels }, (_, index) => {
    const delay = value?.[index] ?? 0;
    return Number.isFinite(delay) ? Math.round(clamp(delay, -512, 512)) : 0;
  });
}

function resampleLinear(input: Float32Array, sourceRate: number, targetRate: number): Float32Array {
  if (input.length === 0 || sourceRate <= 0 || targetRate <= 0) return new Float32Array();
  const outputLength = Math.max(1, Math.round(input.length * targetRate / sourceRate));
  const output = new Float32Array(outputLength);
  const ratio = sourceRate / targetRate;
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(input.length - 1, left + 1);
    const fraction = position - left;
    output[index] = (input[left] ?? 0) * (1 - fraction) + (input[right] ?? 0) * fraction;
  }
  return output;
}

function rms(value: Float32Array): number {
  if (value.length === 0) return 0;
  let sum = 0;
  for (const sample of value) sum += sample * sample;
  return Math.sqrt(sum / value.length + 1e-12);
}

function countClipped(value: Float32Array): number {
  let count = 0;
  for (const sample of value) if (Math.abs(sample) >= 0.999) count += 1;
  return count;
}

function softLimit(value: number): number {
  if (Math.abs(value) <= 0.92) return value;
  return Math.tanh(value / 0.92) * 0.92;
}

function dbfsToLinear(dbfs: number): number {
  return 10 ** (dbfs / 20);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
