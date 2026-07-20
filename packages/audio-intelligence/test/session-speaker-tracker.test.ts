import assert from "node:assert/strict";
import test from "node:test";
import { SessionSpeakerTracker } from "../src/session-speaker-tracker.js";

test("相似声纹在同一会话中复用 Speaker ID", () => {
  const tracker = new SessionSpeakerTracker({ matchThreshold: 0.8 });
  const first = tracker.observe([1, 0, 0]);
  const second = tracker.observe([0.99, 0.05, 0]);

  assert.equal(first.isNew, true);
  assert.equal(second.isNew, false);
  assert.equal(second.sessionSpeakerId, first.sessionSpeakerId);
  assert.equal(tracker.getSpeakerCount(), 1);
});

test("明显不同声纹创建新的 Speaker ID", () => {
  const tracker = new SessionSpeakerTracker({ matchThreshold: 0.8 });
  const first = tracker.observe([1, 0, 0]);
  const second = tracker.observe([0, 1, 0]);

  assert.notEqual(second.sessionSpeakerId, first.sessionSpeakerId);
  assert.equal(tracker.getSpeakerCount(), 2);
});
