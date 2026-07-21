import assert from "node:assert/strict";
import test from "node:test";
import { pcmDurationMs } from "../src/admin/e2e-test-runner.js";

test("PCM 16k mono duration is calculated accurately", () => {
  assert.equal(pcmDurationMs(Buffer.alloc(16000 * 2 * 3), 16000, 1), 3000);
});

test("invalid PCM format returns zero duration", () => {
  assert.equal(pcmDurationMs(Buffer.alloc(32000), 0, 1), 0);
  assert.equal(pcmDurationMs(Buffer.alloc(32000), 16000, 0), 0);
});
