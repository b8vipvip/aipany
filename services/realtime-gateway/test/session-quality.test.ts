import assert from "node:assert/strict";
import test from "node:test";
import { scoreRealtimeSessionQuality } from "../src/observability/session-quality.js";

test("quality scoring prefers true playback-start latency when available", () => {
  const quality = scoreRealtimeSessionQuality({
    latency: [
      { speechEndToFirstAudioMs: 420, speechEndToPlaybackStartMs: 690 },
      { speechEndToFirstAudioMs: 460, speechEndToPlaybackStartMs: 730 },
      { speechEndToFirstAudioMs: 410, speechEndToPlaybackStartMs: 710 },
    ],
    errors: 0,
    abnormalDisconnect: false,
  });

  assert.equal(quality.latencySource, "playback_started");
  assert.equal(quality.medianSpeechEndToPlaybackStartMs, 710);
  assert.ok(quality.score >= 90);
});

test("quality scoring falls back to gateway first audio for legacy clients", () => {
  const quality = scoreRealtimeSessionQuality({
    latency: [
      { speechEndToFirstAudioMs: 900 },
      { speechEndToFirstAudioMs: 1100 },
    ],
    errors: 0,
  });

  assert.equal(quality.latencySource, "gateway_first_audio");
  assert.equal(quality.playbackSampleCount, 0);
  assert.ok(quality.score > 70);
});

test("errors and abnormal disconnect reduce quality without penalizing normal interruptions", () => {
  const clean = scoreRealtimeSessionQuality({
    latency: [{ speechEndToPlaybackStartMs: 800 }],
    errors: 0,
    abnormalDisconnect: false,
  });
  const degraded = scoreRealtimeSessionQuality({
    latency: [{ speechEndToPlaybackStartMs: 800 }],
    errors: 2,
    abnormalDisconnect: true,
  });

  assert.ok(degraded.score < clean.score);
  assert.equal(degraded.errorPenalty, 14);
  assert.equal(degraded.disconnectPenalty, 16);
});
