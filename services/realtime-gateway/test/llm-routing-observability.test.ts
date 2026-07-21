import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  getLlmRequestTrace,
  getLlmRoutingSnapshot,
  LlmProviderPool,
  parseLlmProviderPool,
  resetLlmRoutingState,
} from "../src/providers/llm-provider-pool.js";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function writeSse(response: import("node:http").ServerResponse, text: string): void {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  response.end("data: [DONE]\n\n");
}

test("config fingerprint prevents a previous preferred route from overriding new priorities", async () => {
  resetLlmRoutingState({ clearTraces: true });
  const hits: string[] = [];
  const server = createServer((request, response) => {
    if (request.url === "/a/v1/chat/completions") {
      hits.push("a");
      writeSse(response, "A");
      return;
    }
    if (request.url === "/b/v1/chat/completions") {
      hits.push("b");
      writeSse(response, "B");
      return;
    }
    response.writeHead(404).end();
  });
  const port = await listen(server);

  try {
    const makeConfig = (aPriority: number, bPriority: number) => parseLlmProviderPool({
      providers: [
        { id: "a", name: "A", baseUrl: `http://127.0.0.1:${port}/a/v1`, apiKey: "a", enabled: true, priority: aPriority, models: [{ id: "m", enabled: true, priority: 10, protocols: ["chat_completions"] }] },
        { id: "b", name: "B", baseUrl: `http://127.0.0.1:${port}/b/v1`, apiKey: "b", enabled: true, priority: bPriority, models: [{ id: "m", enabled: true, priority: 10, protocols: ["chat_completions"] }] },
      ],
      firstTokenTimeoutMs: 2000,
      totalTimeoutMs: 5000,
      cooldownMs: 1000,
      maxAttempts: 2,
    });

    const first = new LlmProviderPool(makeConfig(10, 20));
    await first.streamChat({ messages: [{ role: "user", content: "x" }], signal: new AbortController().signal, onDelta: () => {} });
    assert.equal(hits[0], "a");

    const changed = new LlmProviderPool(makeConfig(20, 10));
    await changed.streamChat({ messages: [{ role: "user", content: "x" }], signal: new AbortController().signal, onDelta: () => {} });
    assert.equal(hits[1], "b");
  } finally {
    await close(server);
  }
});

test("routing trace records the failed route and the successful fallback", async () => {
  resetLlmRoutingState({ clearTraces: true });
  const server = createServer((request, response) => {
    if (request.url === "/bad/v1/chat/completions") {
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "relay down" }));
      return;
    }
    if (request.url === "/good/v1/chat/completions") {
      writeSse(response, "OK");
      return;
    }
    response.writeHead(404).end();
  });
  const port = await listen(server);

  try {
    const config = parseLlmProviderPool({
      providers: [
        { id: "bad", name: "Bad", baseUrl: `http://127.0.0.1:${port}/bad/v1`, apiKey: "bad", enabled: true, priority: 10, models: [{ id: "m1", enabled: true, priority: 10, protocols: ["chat_completions"] }] },
        { id: "good", name: "Good", baseUrl: `http://127.0.0.1:${port}/good/v1`, apiKey: "good", enabled: true, priority: 20, models: [{ id: "m2", enabled: true, priority: 10, protocols: ["chat_completions"] }] },
      ],
      firstTokenTimeoutMs: 2000,
      totalTimeoutMs: 5000,
      cooldownMs: 1000,
      maxAttempts: 2,
    });
    const pool = new LlmProviderPool(config);
    let text = "";
    await pool.streamChat({
      traceId: "trace-test",
      messages: [{ role: "user", content: "hello" }],
      signal: new AbortController().signal,
      onDelta: (delta) => { text += delta; },
    });

    assert.equal(text, "OK");
    const trace = getLlmRequestTrace("trace-test");
    assert.equal(trace?.status, "success");
    assert.equal(trace?.attempts.length, 2);
    assert.equal(trace?.attempts[0]?.status, "failed");
    assert.match(trace?.attempts[0]?.error ?? "", /HTTP 503/);
    assert.equal(trace?.attempts[1]?.status, "success");
    assert.equal(trace?.selectedRouteKey, "good::m2::chat_completions");
  } finally {
    await close(server);
  }
});

test("fresh benchmark latency creates a shorter adaptive first-token timeout", () => {
  resetLlmRoutingState({ clearTraces: true });
  const config = parseLlmProviderPool({
    providers: [{
      id: "bench",
      name: "Bench",
      baseUrl: "https://example.com/v1",
      apiKey: "key",
      enabled: true,
      priority: 10,
      models: [{
        id: "fast-model",
        enabled: true,
        priority: 10,
        protocols: ["chat_completions"],
        benchmarkAt: Date.now(),
        benchmarkScoreMs: 1000,
        protocolLatencyMs: { chat_completions: 1000 },
      }],
    }],
    firstTokenTimeoutMs: 12000,
    totalTimeoutMs: 60000,
    cooldownMs: 60000,
    maxAttempts: 8,
  });

  const snapshot = getLlmRoutingSnapshot(config);
  assert.equal(snapshot.routes[0]?.configuredFirstTokenTimeoutMs, 12000);
  assert.equal(snapshot.routes[0]?.firstTokenTimeoutMs, 4000);
  assert.equal(snapshot.routes[0]?.benchmarkFirstTokenMs, 1000);
});

test("reset clears preferred route and health while keeping traces by default", async () => {
  resetLlmRoutingState({ clearTraces: true });
  const server = createServer((_request, response) => writeSse(response, "OK"));
  const port = await listen(server);
  try {
    const config = parseLlmProviderPool({
      providers: [{ id: "one", name: "One", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "key", enabled: true, priority: 10, models: [{ id: "m", enabled: true, priority: 10, protocols: ["chat_completions"] }] }],
      firstTokenTimeoutMs: 2000,
      totalTimeoutMs: 5000,
      cooldownMs: 1000,
      maxAttempts: 1,
    });
    const pool = new LlmProviderPool(config);
    await pool.streamChat({ traceId: "kept-trace", messages: [{ role: "user", content: "x" }], signal: new AbortController().signal, onDelta: () => {} });
    assert.ok(getLlmRoutingSnapshot(config).preferredRoute);
    resetLlmRoutingState();
    const snapshot = getLlmRoutingSnapshot(config);
    assert.equal(snapshot.preferredRoute, undefined);
    assert.ok(snapshot.recentRequests.some((trace) => trace.id === "kept-trace"));
  } finally {
    await close(server);
  }
});
