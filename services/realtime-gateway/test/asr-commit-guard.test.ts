import assert from "node:assert/strict";
import test from "node:test";
import { AsrCommitGuard, estimatePcm16Dbfs } from "../src/providers/asr-commit-guard.js";

function pcmFrame(amplitude: number, samples = 320): Buffer {
  const buffer = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index++) {
    buffer.writeInt16LE(index % 2 === 0 ? amplitude : -amplitude, index * 2);
  }
  return buffer;
}

test("suppresses an empty manual ASR commit", () => {
  const guard = new AsrCommitGuard({ minimumSpeechLikeMs: 160 });
  repeat(20, () => guard.observeAudio(pcmFrame(50)));

  const decision = guard.tryCommit(1_000);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "no_speech_evidence");
});

test("allows sustained speech and blocks duplicate commit", () => {
  const guard = new AsrCommitGuard({ minimumSpeechLikeMs: 160 });
  repeat(10, () => guard.observeAudio(pcmFrame(6_000)));

  assert.equal(guard.tryCommit(1_000).allowed, true);
  assert.equal(guard.tryCommit(1_300).reason, "commit_pending");
  guard.resolve();
  assert.equal(guard.tryCommit(1_600).allowed, false);
  guard.markServerSpeechStarted();
  assert.equal(guard.tryCommit(1_600).allowed, true);
});

test("server VAD evidence permits a short but valid utterance", () => {
  const guard = new AsrCommitGuard({ minimumSpeechLikeMs: 300 });
  guard.markServerSpeechStarted();

  assert.equal(guard.tryCommit(2_000).allowed, true);
});

test("pcm energy estimator distinguishes speech from silence", () => {
  assert.ok(estimatePcm16Dbfs(pcmFrame(8_000)) > -20);
  assert.ok(estimatePcm16Dbfs(pcmFrame(0)) <= -90);
});

function repeat(count: number, callback: () => void): void {
  for (let index = 0; index < count; index++) callback();
}
