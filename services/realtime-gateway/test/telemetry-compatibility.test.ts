import assert from "node:assert/strict";
import test from "node:test";
import { clientControlEventSchema } from "@aipany/protocol";

// Regression for the production INVALID_EVENT that surfaced when the Android
// client added endpoint_commit_suppressed before the Gateway enum was updated.
test("endpoint suppression telemetry is accepted as a non-fatal control event", () => {
  const result = clientControlEventSchema.safeParse({
    type: "client.telemetry",
    name: "endpoint_commit_suppressed",
    details: { reason: "awaiting_transcript" },
  });
  assert.equal(result.success, true);
});
