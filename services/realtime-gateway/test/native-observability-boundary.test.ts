import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const FORWARDED_METRIC_EVENTS = [
  "speech.started",
  "speech.stopped",
  "transcript.final",
  "response.created",
  "response.first_text",
  "response.first_audio",
  "response.interrupted",
  "response.done",
];

test("Native Live forwarded protocol events are measured only at the gateway websocket boundary", async () => {
  const source = await readFile(new URL("../src/session/qwen-omni-live-session.ts", import.meta.url), "utf8");

  for (const event of FORWARDED_METRIC_EVENTS) {
    assert.equal(
      source.includes(`telemetry?.event("${event}"`) || source.includes(`observe("${event}"`),
      false,
      `${event} must be recorded by instrumentOutgoingWebSocket instead of QwenOmniLiveSession`,
    );
  }

  assert.match(source, /observe\("omni\.error"/);
  assert.match(source, /observe\("omni\.closed"/);
  assert.match(source, /observe\("omni\.session\.ready"/);
  assert.match(source, /recordGlobalRealtimeEvent/);
  assert.match(source, /instrumentOutgoingWebSocket/);
});
