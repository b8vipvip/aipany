import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { experienceModeSchema } from "@aipany/protocol";
import WebSocket, { WebSocketServer } from "ws";
import { loadConfig } from "../src/config.js";
import { getRealtimeExperienceDefinitions } from "../src/mobile/realtime-experience.js";
import { buildLiveUrl } from "../src/providers/chat2api-live.js";
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

test("protocol accepts chat2api_live experience mode", () => {
  assert.equal(experienceModeSchema.safeParse("chat2api_live").success, true);
});

test("Chat2API live URL upgrades http and keeps optional extension client", () => {
  const url = new URL(buildLiveUrl("https://chat2api.example.test/", "browser-1"));
  assert.equal(url.protocol, "wss:");
  assert.equal(url.pathname, "/v1/audio/realtime");
  assert.equal(url.searchParams.get("client_id"), "browser-1");
});

test("ChatGPT Live is exposed without falsely enabling Qwen Native modes", async () => {
  await withEnvironment({
    AIPANY_REALTIME_ENGINE: "auto",
    CHAT2API_LIVE_ENABLED: "true",
    CHAT2API_LIVE_API_KEY: "test-live-key",
    CHAT2API_LIVE_BASE_URL: "https://chat2api.example.test",
    CHAT2API_LIVE_MODEL: "gpt-live",
    QWEN_OMNI_REALTIME_ENABLED: "false",
    QWEN_OMNI_API_KEY: "",
    DASHSCOPE_API_KEY: "",
    SPEAKER_IDENTITY_STORE: "memory",
  }, () => {
    const config = loadConfig();
    assert.equal(config.qwenOmniRealtime.enabled, true, "explicit ChatGPT Live should pass the native-session gate");
    assert.equal(config.qwenOmniRealtime.qwenEnabled, false);
    assert.equal(config.server.realtimeEngine, "cascaded", "legacy auto sessions must not be redirected to an unconfigured Qwen provider");
    const modes = getRealtimeExperienceDefinitions(config);
    const chatgpt = modes.find((item) => item.id === "chat2api_live");
    const qwen = modes.find((item) => item.id === "native_plus");
    assert.equal(chatgpt?.model, "gpt-live");
    assert.equal(chatgpt?.title, "ChatGPT Live");
    assert.match(qwen?.title ?? "", /未启用/u);
  });
});

test("gpt-live model delegates the existing native client contract to Chat2API", async () => {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let authorization = "";
  let microphone = Buffer.alloc(0);

  wss.on("connection", (socket, request) => {
    authorization = String(request.headers.authorization ?? "");
    socket.on("message", (raw, isBinary) => {
      if (isBinary) {
        microphone = Buffer.from(raw as Buffer);
        socket.send(JSON.stringify({ type: "response.created", response_id: "r1" }));
        socket.send(JSON.stringify({ type: "response.audio.started", response_id: "r1" }));
        socket.send(Buffer.from([1, 2, 3, 4]), { binary: true });
        socket.send(JSON.stringify({ type: "response.audio.done", response_id: "r1" }));
        socket.send(JSON.stringify({ type: "response.done", response_id: "r1", text: "你好" }));
        return;
      }
      const event = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (event.type === "session.start") {
        assert.equal(event.model, "gpt-live");
        socket.send(JSON.stringify({ type: "session.ready", session_id: "s1" }));
      }
    });
  });

  try {
    await withEnvironment({
      CHAT2API_LIVE_ENABLED: "true",
      CHAT2API_LIVE_API_KEY: "bridge-key",
      CHAT2API_LIVE_BASE_URL: baseUrl,
      CHAT2API_LIVE_MODEL: "gpt-live",
    }, async () => {
      const client = new QwenOmniRealtimeClient({
        apiKey: "not-used-for-chat2api",
        baseUrl: "wss://qwen.invalid/realtime",
        model: "gpt-live",
        voice: "chatgpt-current",
        instructions: "自然聊天",
        turnDetection: "smart_turn",
        vadThreshold: 0.2,
        silenceMs: 500,
      });
      const audioPromise = new Promise<Buffer>((resolve) => client.once("audio", (_id, audio) => resolve(audio)));
      const donePromise = new Promise<string>((resolve) => client.once("responseDone", (_id, text) => resolve(text)));
      await client.connect();
      const microphoneFrame = Buffer.alloc(1280, 0x09);
      client.appendAudio(microphoneFrame);
      assert.deepEqual(await audioPromise, Buffer.from([1, 2, 3, 4]));
      assert.equal(await donePromise, "你好");
      assert.deepEqual(microphone, microphoneFrame);
      assert.equal(authorization, "Bearer bridge-key");
      client.close();
    });
  } finally {
    for (const client of wss.clients) client.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});

test("Chat2API startup error rejects the native session instead of hanging", async () => {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  wss.on("connection", (socket) => {
    socket.on("message", (raw, isBinary) => {
      if (isBinary) return;
      const event = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (event.type === "session.start") {
        socket.send(JSON.stringify({
          type: "error",
          code: "GPT_LIVE_BROWSER_ERROR",
          message: "voice tab unavailable",
          retryable: true,
        }));
      }
    });
  });

  try {
    await withEnvironment({
      CHAT2API_LIVE_ENABLED: "true",
      CHAT2API_LIVE_API_KEY: "bridge-key",
      CHAT2API_LIVE_BASE_URL: baseUrl,
      CHAT2API_LIVE_MODEL: "gpt-live",
    }, async () => {
      const client = new QwenOmniRealtimeClient({
        apiKey: "not-used-for-chat2api",
        baseUrl: "wss://qwen.invalid/realtime",
        model: "gpt-live",
        voice: "chatgpt-current",
        instructions: "自然聊天",
        turnDetection: "smart_turn",
        vadThreshold: 0.2,
        silenceMs: 500,
      });
      client.on("error", () => {});
      await assert.rejects(client.connect(), /voice tab unavailable/u);
      client.close();
    });
  } finally {
    for (const client of wss.clients) client.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});

test("Chat2API session.closed closes the provider so Aipany recovery can reopen it", async () => {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  wss.on("connection", (socket) => {
    socket.on("message", (raw, isBinary) => {
      if (isBinary) return;
      const event = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (event.type === "session.start") {
        socket.send(JSON.stringify({ type: "session.ready", session_id: "s1" }));
        setImmediate(() => socket.send(JSON.stringify({ type: "session.closed", session_id: "s1" })));
      }
    });
  });

  try {
    await withEnvironment({
      CHAT2API_LIVE_ENABLED: "true",
      CHAT2API_LIVE_API_KEY: "bridge-key",
      CHAT2API_LIVE_BASE_URL: baseUrl,
      CHAT2API_LIVE_MODEL: "gpt-live",
    }, async () => {
      const client = new QwenOmniRealtimeClient({
        apiKey: "not-used-for-chat2api",
        baseUrl: "wss://qwen.invalid/realtime",
        model: "gpt-live",
        voice: "chatgpt-current",
        instructions: "自然聊天",
        turnDetection: "smart_turn",
        vadThreshold: 0.2,
        silenceMs: 500,
      });
      client.on("error", () => {});
      const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        client.once("close", (code, reason) => resolve({ code, reason }));
      });
      await client.connect();
      const result = await closed;
      assert.equal(result.code, 1012);
      assert.match(result.reason, /upstream session closed/u);
      client.close();
    });
  } finally {
    for (const client of wss.clients) client.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});
