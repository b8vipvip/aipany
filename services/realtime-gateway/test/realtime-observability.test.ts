import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { RealtimeObservabilityStore } from "../src/observability/realtime-observability.js";

function withMockedNow<T>(run: (advance: (ms: number) => void) => T): T {
  const original = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  try {
    return run((ms) => { now += ms; });
  } finally {
    Date.now = original;
  }
}

test("会话可聚合异常断线、打断和完整首响时间线", () => {
  withMockedNow((advance) => {
    const store = new RealtimeObservabilityStore({
      filePath: join(tmpdir(), `aipany-observability-${randomUUID()}.jsonl`),
    });
    const session = store.beginSession({
      sessionId: "session-a",
      connectionId: "connection-a",
      engine: "cascaded",
      tenantId: "tenant-a",
      userId: "user-a",
      deviceId: "device-a",
      platform: "android",
      appVersion: "0.3.0",
    });

    advance(1000);
    session.event("speech.stopped", {}, "info", "audio");
    advance(200);
    session.event("transcript.final", { textChars: 8 }, "info", "asr");
    advance(100);
    session.event("response.created", { responseId: "response-a" });
    advance(200);
    session.event("response.first_text", { responseId: "response-a" });
    advance(200);
    session.event("response.first_audio", { responseId: "response-a" }, "info", "audio");
    advance(100);
    session.event("response.interrupted", { responseId: "response-a", reason: "barge_in" });
    advance(100);
    session.event("pipeline.error", { code: "TEST_ERROR" }, "error", "llm");
    advance(100);
    session.end(1006, "network lost");

    const overview = store.overview();
    assert.equal(overview.sessions, 1);
    assert.equal(overview.completedSessions, 1);
    assert.equal(overview.abnormalDisconnects, 1);
    assert.equal(overview.turns, 1);
    assert.equal(overview.interruptions, 1);
    assert.equal(overview.errors, 1);
    assert.equal(overview.latency.speechEndToTranscriptFinal.p50Ms, 200);
    assert.equal(overview.latency.transcriptFinalToFirstText.p50Ms, 300);
    assert.equal(overview.latency.firstTextToFirstAudio.p50Ms, 200);
    assert.equal(overview.latency.speechEndToFirstAudio.p50Ms, 700);
  });
});

test("同设备短时间重新建立会话会标记为疑似自动重连", () => {
  withMockedNow((advance) => {
    const store = new RealtimeObservabilityStore({
      filePath: join(tmpdir(), `aipany-observability-${randomUUID()}.jsonl`),
    });
    const first = store.beginSession({
      sessionId: "session-1",
      connectionId: "connection-1",
      engine: "omni_realtime",
      deviceId: "same-device",
    });
    advance(2000);
    first.end(1006, "network lost");
    advance(5000);
    const second = store.beginSession({
      sessionId: "session-2",
      connectionId: "connection-2",
      engine: "omni_realtime",
      deviceId: "same-device",
    });

    assert.equal(second.report.reconnectLikely, true);
    assert.equal(store.overview().reconnects, 1);
  });
});
