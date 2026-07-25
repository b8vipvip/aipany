import assert from "node:assert/strict";
import test from "node:test";
import { clientControlEventSchema } from "@aipany/protocol";

test("new safe telemetry metrics do not become INVALID_EVENT errors", () => {
  for (const name of ["endpoint_commit_suppressed", "audio_dropped_after_cancel", "response_watchdog_triggered"]) {
    const parsed = clientControlEventSchema.safeParse({
      type: "client.telemetry",
      name,
      details: { reason: "test", frames: 2, active: true },
    });
    assert.equal(parsed.success, true, name);
  }
});

test("telemetry name remains bounded to safe snake case", () => {
  for (const name of ["Bad.Name", "../../secret", "包含中文", "a".repeat(65)]) {
    const parsed = clientControlEventSchema.safeParse({ type: "client.telemetry", name });
    assert.equal(parsed.success, false, name);
  }
});
