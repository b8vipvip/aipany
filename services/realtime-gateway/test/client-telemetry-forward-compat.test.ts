import assert from "node:assert/strict";
import test from "node:test";
import { clientTelemetryNameSchema } from "@aipany/protocol";

test("client telemetry accepts bounded future snake-case metrics", () => {
  assert.equal(clientTelemetryNameSchema.safeParse("future_metric_v2").success, true);
  assert.equal(clientTelemetryNameSchema.safeParse("endpoint_commit_suppressed").success, true);
  assert.equal(clientTelemetryNameSchema.safeParse("audio_dropped_after_cancel").success, true);
});

test("client telemetry rejects path-like or unbounded names", () => {
  assert.equal(clientTelemetryNameSchema.safeParse("../secret").success, false);
  assert.equal(clientTelemetryNameSchema.safeParse("Bad.Metric").success, false);
  assert.equal(clientTelemetryNameSchema.safeParse("x".repeat(65)).success, false);
});
