import assert from "node:assert/strict";
import test from "node:test";
import { AcousticProsodyAnalyzer } from "../src/pipeline/acoustic-prosody-analyzer.js";

function sinePcm(amplitude: number, samples = 320, frequency = 180, phase = 0): Buffer {
  const buffer = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    const value = Math.sin(phase + index / 16_000 * frequency * Math.PI * 2) * amplitude;
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value * 32767))), index * 2);
  }
  return buffer;
}

test("acoustic analyzer describes low-energy speech with substantial pauses", () => {
  const analyzer = new AcousticProsodyAnalyzer();
  analyzer.beginSpeech();
  for (let index = 0; index < 16; index += 1) analyzer.append(Buffer.alloc(640));
  for (let index = 0; index < 18; index += 1) analyzer.append(sinePcm(0.025, 320, 170));

  const snapshot = analyzer.endSpeech();
  assert.ok(snapshot);
  assert.equal(snapshot.energy, "low");
  assert.ok(snapshot.silenceRatio > 0.35);
  assert.ok(snapshot.durationMs >= 600);
  assert.ok(snapshot.confidence >= 0.3);
});

test("acoustic analyzer describes energetic variable speech without external models", () => {
  const analyzer = new AcousticProsodyAnalyzer();
  analyzer.beginSpeech();
  for (let index = 0; index < 36; index += 1) {
    const amplitude = index % 3 === 0 ? 0.78 : 0.46;
    const frequency = index % 2 === 0 ? 175 : 245;
    analyzer.append(sinePcm(amplitude, 320, frequency, index * 0.2));
  }

  const snapshot = analyzer.endSpeech();
  assert.ok(snapshot);
  assert.equal(snapshot.energy, "high");
  assert.ok(snapshot.peakDbfs > -5);
  assert.ok(snapshot.dynamicRangeDb >= 0);
  assert.ok(snapshot.confidence >= 0.3);
});

test("acoustic analyzer ignores too-short speech safely", () => {
  const analyzer = new AcousticProsodyAnalyzer();
  analyzer.beginSpeech();
  analyzer.append(Buffer.alloc(100));
  assert.equal(analyzer.endSpeech(), undefined);
  analyzer.reset();
});
