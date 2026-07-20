import assert from "node:assert/strict";
import test from "node:test";
import type { AudioFormatDescriptor, SpeakerEmbeddingProvider } from "@aipany/audio-intelligence";
import { UtteranceSpeakerAnalyzer } from "../src/speaker/utterance-speaker-analyzer.js";

class FakeProvider implements SpeakerEmbeddingProvider {
  readonly name = "fake";

  async extractEmbedding(audio: Buffer, _format: AudioFormatDescriptor) {
    return {
      embedding: audio[0] === 1 ? [1, 0, 0] : [0, 1, 0],
      quality: 0.9,
      durationMs: 1000,
      model: "fake",
      dimensions: 3,
    };
  }
}

test("同类语音轮次得到稳定的会话 Speaker ID", async () => {
  const analyzer = new UtteranceSpeakerAnalyzer(new FakeProvider(), {
    minAudioMs: 1,
    preRollMs: 0,
    sessionMatchThreshold: 0.8,
  });

  analyzer.startSpeech();
  analyzer.append(Buffer.alloc(64, 1));
  const first = await analyzer.stopSpeech();

  analyzer.startSpeech();
  analyzer.append(Buffer.alloc(64, 1));
  const second = await analyzer.stopSpeech();

  assert.ok(first);
  assert.ok(second);
  assert.equal(first.sessionSpeakerId, second.sessionSpeakerId);
});
