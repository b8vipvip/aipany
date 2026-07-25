import assert from "node:assert/strict";
import test from "node:test";
import { clientControlEventSchema } from "@aipany/protocol";
import { resolveTtsProsody } from "../src/providers/qwen-tts.js";

// Production regression: Android emitted this metric and the old strict enum
// converted it into a user-visible pipeline error.
test("new Android observability events remain protocol-compatible", () => {
  const events = [
    { name: "endpoint_commit_suppressed", details: { reason: "awaiting_transcript" } },
    { name: "audio_dropped_after_cancel", details: { frames: 4, bytes: 61440 } },
  ];
  for (const event of events) {
    assert.equal(clientControlEventSchema.safeParse({ type: "client.telemetry", ...event }).success, true);
  }
});

test("expressive prosody stays subtle enough for stable voice identity", () => {
  const styles = [
    resolveTtsProsody("温暖、轻柔、有陪伴感，语速稍慢。"),
    resolveTtsProsody("自然开心、轻快、带一点真实笑意。"),
    resolveTtsProsody("冷静、克制、尊重，不与对方对抗。"),
  ];
  for (const style of styles) {
    assert.ok(style.rate >= 0.88 && style.rate <= 1.1);
    assert.ok(style.pitch >= 0.95 && style.pitch <= 1.08);
    assert.ok(style.volume >= 46 && style.volume <= 55);
  }
});
