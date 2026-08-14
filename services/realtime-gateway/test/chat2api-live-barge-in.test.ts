import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { QwenOmniRealtimeClient } from "../src/providers/qwen-omni-realtime.js";

function withEnvironment(values: Record<string, string>, fn: () => Promise<void> | void): Promise<void> {
  const before = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    before.set(key, process.env[key]);
    process.env[key] = value;
  }
  return Promise.resolve(fn()).finally(() => {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function createClient(): QwenOmniRealtimeClient {
  return new QwenOmniRealtimeClient({
    apiKey: "not-used-for-chat2api",
    baseUrl: "wss://qwen.invalid/realtime",
    model: "gpt-live",
    voice: "chatgpt-current",
    instructions: "自然聊天",
    turnDetection: "smart_turn",
    vadThreshold: 0.2,
    silenceMs: 500,
  });
}

async function createBridgeHarness() {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let peer: WebSocket | undefined;
  let cancelCount = 0;
  let resolveCancel: (() => void) | undefined;
  let cancelReceived = new Promise<void>((resolve) => { resolveCancel = resolve; });

  wss.on("connection", (socket) => {
    peer = socket;
    socket.on("message", (raw, isBinary) => {
      if (isBinary) return;
      const event = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (event.type === "session.start") {
        socket.send(JSON.stringify({ type: "session.ready", session_id: "s-barge" }));
        return;
      }
      if (event.type === "response.cancel") {
        cancelCount += 1;
        resolveCancel?.();
        resolveCancel = undefined;
      }
    });
  });

  return {
    baseUrl,
    get peer() {
      assert.ok(peer, "bridge peer should be connected");
      return peer;
    },
    get cancelCount() {
      return cancelCount;
    },
    get cancelReceived() {
      return cancelReceived;
    },
    resetCancelWaiter() {
      cancelReceived = new Promise<void>((resolve) => { resolveCancel = resolve; });
    },
    async close() {
      for (const client of wss.clients) client.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

async function withLiveEnvironment(baseUrl: string, fn: () => Promise<void>): Promise<void> {
  await withEnvironment({
    CHAT2API_LIVE_ENABLED: "true",
    CHAT2API_LIVE_API_KEY: "bridge-key",
    CHAT2API_LIVE_BASE_URL: baseUrl,
    CHAT2API_LIVE_MODEL: "gpt-live",
  }, fn);
}

test("ChatGPT Live speech_started automatically cancels the active response as barge-in", async () => {
  const bridge = await createBridgeHarness();
  try {
    await withLiveEnvironment(bridge.baseUrl, async () => {
      const client = createClient();
      await client.connect();

      const created = new Promise<string>((resolve) => client.once("responseCreated", resolve));
      const interrupted = new Promise<{ responseId: string; reason: string }>((resolve) => {
        client.once("interrupted", (responseId, reason) => resolve({ responseId, reason }));
      });

      bridge.peer.send(JSON.stringify({ type: "response.created", response_id: "r-auto" }));
      assert.equal(await created, "r-auto");
      bridge.peer.send(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
      await bridge.cancelReceived;
      assert.equal(bridge.cancelCount, 1);

      bridge.peer.send(JSON.stringify({
        type: "response.interrupted",
        response_id: "r-auto",
        reason: "client_cancel",
      }));
      assert.deepEqual(await interrupted, { responseId: "r-auto", reason: "barge_in" });
      client.close();
    });
  } finally {
    await bridge.close();
  }
});

test("Android fast-path cancel and upstream speech_started are deduplicated", async () => {
  const bridge = await createBridgeHarness();
  try {
    await withLiveEnvironment(bridge.baseUrl, async () => {
      const client = createClient();
      await client.connect();

      const created = new Promise<string>((resolve) => client.once("responseCreated", resolve));
      bridge.peer.send(JSON.stringify({ type: "response.created", response_id: "r-dedupe" }));
      assert.equal(await created, "r-dedupe");

      client.cancelResponse();
      await bridge.cancelReceived;
      assert.equal(bridge.cancelCount, 1);

      bridge.peer.send(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(bridge.cancelCount, 1, "speech_started must not send a duplicate response.cancel");

      const interrupted = new Promise<{ responseId: string; reason: string }>((resolve) => {
        client.once("interrupted", (responseId, reason) => resolve({ responseId, reason }));
      });
      bridge.peer.send(JSON.stringify({
        type: "response.interrupted",
        response_id: "r-dedupe",
        reason: "client_cancel",
      }));
      assert.deepEqual(await interrupted, { responseId: "r-dedupe", reason: "barge_in" });
      client.close();
    });
  } finally {
    await bridge.close();
  }
});
