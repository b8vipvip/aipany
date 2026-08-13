import assert from "node:assert/strict";
import test from "node:test";
import type { RealtimeObservabilityStore } from "../src/observability/realtime-observability.js";
import { setGlobalRealtimeObservabilityStore } from "../src/observability/global-observability.js";
import { Chat2ApiLiveClient } from "../src/providers/chat2api-live.js";

test("GPT-Live status and heartbeat enter observability without secrets", () => {
  const events: Array<Record<string, unknown>> = [];
  const fakeStore = {
    record(input: Record<string, unknown>) {
      events.push(input);
    },
  } as unknown as RealtimeObservabilityStore;

  setGlobalRealtimeObservabilityStore(fakeStore);
  try {
    const client = new Chat2ApiLiveClient({
      apiKey: "super-secret-key",
      baseUrl: "https://chat2api.example.test",
      model: "gpt-live",
      clientId: "browser-1",
      instructions: "private instructions",
    });
    const internals = client as unknown as {
      emitStatus(state: "ready" | "degraded", detail?: string): void;
      observeHeartbeat(now: number): void;
    };

    internals.emitStatus("ready", "Voice ready");
    internals.observeHeartbeat(100_000);
    internals.observeHeartbeat(120_000);
    internals.observeHeartbeat(161_000);

    const status = events.find((event) => event.event === "chat2api_live.status");
    assert.ok(status);
    assert.equal(status.category, "gpt-live");
    assert.equal(status.engine, "omni_realtime");

    const heartbeats = events.filter((event) => event.event === "chat2api_live.heartbeat");
    assert.equal(heartbeats.length, 2, "heartbeat observability should be throttled to once per minute");

    const serialized = JSON.stringify(events);
    assert.doesNotMatch(serialized, /super-secret-key/u);
    assert.doesNotMatch(serialized, /private instructions/u);
    assert.doesNotMatch(serialized, /chat2api\.example\.test/u);
    assert.match(serialized, /gpt-live/u);
  } finally {
    setGlobalRealtimeObservabilityStore(undefined);
  }
});
