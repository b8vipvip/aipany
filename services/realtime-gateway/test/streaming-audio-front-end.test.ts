import assert from "node:assert/strict";
import test from "node:test";
import { StreamingAudioFrontEnd } from "../src/audio/streaming-audio-front-end.js";

function pcm(samples: number[], channels = 1): Buffer {
  const buffer = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) {
    buffer.writeInt16LE(samples[index] ?? 0, index * 2);
  }
  assert.equal(samples.length % channels, 0);
  return buffer;
}

test("双声道输入会输出单声道 analysis/asr PCM", () => {
  const frontEnd = new StreamingAudioFrontEnd({
    inputFormat: { encoding: "pcm_s16le", sampleRate: 16000, channels: 2 },
    beamforming: true,
    aec: false,
    noiseSuppression: false,
    agc: false,
    dereverb: false,
  });
  const input = pcm([1000, 3000, 2000, 4000, -1000, 1000], 2);
  const output = frontEnd.process(input);
  assert.equal(output.analysisAudio.length, input.length / 2);
  assert.equal(output.asrAudio.length, input.length / 2);
  assert.equal(output.analysisAudio.readInt16LE(0), 2000);
  assert.equal(output.analysisAudio.readInt16LE(2), 3000);
});

test("AGC 会提升低电平语音且保持有限输出", () => {
  const frontEnd = new StreamingAudioFrontEnd({
    inputFormat: { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 },
    aec: false,
    noiseSuppression: false,
    agc: true,
    dereverb: false,
    targetRmsDbfs: -18,
    maxGain: 6,
  });
  const input = pcm(Array.from({ length: 1600 }, (_, index) => Math.round(Math.sin(index / 12) * 400)));
  const output = frontEnd.process(input);
  assert.ok(output.metrics.appliedGain > 1);
  assert.ok(output.metrics.outputRms > output.metrics.inputRms);
  assert.equal(output.metrics.clippedSamples, 0);
});

test("TTS reference 可进入 AEC 且 reset 后清空状态", () => {
  const frontEnd = new StreamingAudioFrontEnd({
    inputFormat: { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 },
    aec: true,
    noiseSuppression: false,
    agc: false,
    dereverb: false,
    aecDelayMs: 0,
  });
  const reference = pcm(Array.from({ length: 800 }, (_, index) => Math.round(Math.sin(index / 8) * 8000)));
  frontEnd.appendPlaybackReference(reference, 16000);
  const output = frontEnd.process(reference);
  assert.ok(output.metrics.echoAttenuation > 0);
  frontEnd.reset();
  const afterReset = frontEnd.process(reference);
  assert.equal(afterReset.metrics.echoAttenuation, 0);
});
