import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { WebSocketServer } from "ws";
import { Chat2ApiLiveClient, type Chat2ApiLiveStatusState } from "../src/providers/chat2api-live.js";

test("Chat2API health exposes bridge connection before Voice readiness", async () => {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert.ok(address && typeof address === "object");
  const states: Chat2ApiLiveStatusState[] = [];

  wss.on("connection", (socket) => {
    socket.on("message", (raw, isBinary) => {
      if (isBinary) return;
      const event = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (event.type === "session.start") {
        socket.send(JSON.stringify({ type: "session.ready", session_id: "status-test" }));
      }
    });
  });

  const client = new Chat2ApiLiveClient({
    apiKey: "test-key",
    baseUrl: `http://127.0.0.1:${address.port}`,
    model: "gpt-live",
    instructions: "status test",
  });
  client.on("status", (state) => states.push(state));
  client.on("error", () => {});

  try {
    await client.connect();
    assert.deepEqual(states.slice(0, 3), ["connecting", "bridge_connected", "ready"]);
  } finally {
    client.close();
    for (const socket of wss.clients) socket.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});

test("Chat2API upstream session closure reports unavailable before recovery close", async () => {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert.ok(address && typeof address === "object");
  const states: Chat2ApiLiveStatusState[] = [];

  wss.on("connection", (socket) => {
    socket.on("message", (raw, isBinary) => {
      if (isBinary) return;
      const event = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (event.type === "session.start") {
        socket.send(JSON.stringify({ type: "session.ready", session_id: "status-close" }));
        setImmediate(() => socket.send(JSON.stringify({ type: "session.closed", session_id: "status-close" })));
      }
    });
  });

  const client = new Chat2ApiLiveClient({
    apiKey: "test-key",
    baseUrl: `http://127.0.0.1:${address.port}`,
    model: "gpt-live",
    instructions: "status close test",
  });
  client.on("status", (state) => states.push(state));
  client.on("error", () => {});
  const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));

  try {
    await client.connect();
    await closed;
    const unavailableIndex = states.indexOf("unavailable");
    assert.ok(unavailableIndex >= 0, `expected unavailable state, got ${states.join(",")}`);
    assert.equal(states.includes("ready"), true);
  } finally {
    client.close();
    for (const socket of wss.clients) socket.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});
