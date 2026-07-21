import assert from "node:assert/strict";
import test from "node:test";
import {
  LowLatencyRealtimeSession,
  resolveOwnerFocusSpeakerAnalysisWaitMs,
} from "../src/session/low-latency-realtime-session.js";

test("未授权声纹时 Owner Focus 不阻塞等待 Speaker Intelligence", () => {
  assert.equal(resolveOwnerFocusSpeakerAnalysisWaitMs({
    configuredWaitMs: 700,
    consentRequired: true,
    consentGranted: false,
  }), 0);
});

test("已经授权声纹时保留配置的 Owner Focus 分析等待", () => {
  assert.equal(resolveOwnerFocusSpeakerAnalysisWaitMs({
    configuredWaitMs: 700,
    consentRequired: true,
    consentGranted: true,
  }), 700);
});

test("不要求授权的部署保留 Speaker Intelligence 等待", () => {
  assert.equal(resolveOwnerFocusSpeakerAnalysisWaitMs({
    configuredWaitMs: 350,
    consentRequired: false,
    consentGranted: false,
  }), 350);
});

test("显式 input_audio_buffer.commit 会转发到 ASR provider", () => {
  let commits = 0;
  const session = Object.create(LowLatencyRealtimeSession.prototype) as any;
  session.asr = { commit: () => { commits += 1; } };

  session.commitAudio();

  assert.equal(commits, 1);
});
