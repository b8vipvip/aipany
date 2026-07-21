import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { LlmProviderPool, parseLlmProviderPool } from "../src/providers/llm-provider-pool.js";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function writeSse(response: import("node:http").ServerResponse, payloads: unknown[]): void {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const payload of payloads) response.write(`data: ${JSON.stringify(payload)}\n\n`);
  response.write("data: [DONE]\n\n");
  response.end();
}

test("provider pool fails over after first-token timeout", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/slow/v1/chat/completions") {
      request.on("aborted", () => response.destroy());
      return;
    }
    if (request.url === "/fast/v1/chat/completions") {
      writeSse(response, [
        { choices: [{ delta: { role: "assistant" }, finish_reason: null }] },
        { choices: [{ delta: { content: "fallback-ok" }, finish_reason: null }] },
      ]);
      return;
    }
    response.writeHead(404).end();
  });
  const port = await listen(server);

  try {
    const pool = new LlmProviderPool(parseLlmProviderPool({
      providers: [
        {
          id: "slow",
          name: "Slow Relay",
          baseUrl: `http://127.0.0.1:${port}/slow/v1`,
          apiKey: "slow-key",
          enabled: true,
          priority: 10,
          firstTokenTimeoutMs: 1000,
          models: [{ id: "slow-model", enabled: true, priority: 10, protocols: ["chat_completions"] }],
        },
        {
          id: "fast",
          name: "Fast Relay",
          baseUrl: `http://127.0.0.1:${port}/fast/v1`,
          apiKey: "fast-key",
          enabled: true,
          priority: 20,
          models: [{ id: "fast-model", enabled: true, priority: 10, protocols: ["chat_completions"] }],
        },
      ],
      firstTokenTimeoutMs: 1000,
      totalTimeoutMs: 5000,
      cooldownMs: 60000,
      maxAttempts: 4,
    }));

    let text = "";
    const startedAt = Date.now();
    await pool.streamChat({
      messages: [{ role: "user", content: "hello" }],
      signal: new AbortController().signal,
      onDelta: (delta) => { text += delta; },
    });

    assert.equal(text, "fallback-ok");
    assert.ok(Date.now() - startedAt >= 900);
    const status = pool.getStatus();
    assert.equal(status.find((item) => item.providerId === "slow")?.failures, 1);
    assert.equal(status.find((item) => item.providerId === "fast")?.preferred, true);
  } finally {
    await close(server);
  }
});

test("provider pool parses Responses API streaming deltas", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/v1/responses") {
      writeSse(response, [
        { type: "response.created", response: { id: "test" } },
        { type: "response.output_text.delta", delta: "你好" },
        { type: "response.output_text.delta", delta: "世界" },
      ]);
      return;
    }
    response.writeHead(404).end();
  });
  const port = await listen(server);

  try {
    const pool = new LlmProviderPool(parseLlmProviderPool({
      providers: [{
        id: "responses",
        name: "Responses Relay",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: "responses-key",
        enabled: true,
        priority: 10,
        models: [{ id: "responses-model", enabled: true, priority: 10, protocols: ["responses"] }],
      }],
      firstTokenTimeoutMs: 2000,
      totalTimeoutMs: 5000,
      cooldownMs: 1000,
      maxAttempts: 1,
    }));

    let text = "";
    await pool.streamChat({
      messages: [{ role: "user", content: "hello" }],
      signal: new AbortController().signal,
      onDelta: (delta) => { text += delta; },
    });
    assert.equal(text, "你好世界");
  } finally {
    await close(server);
  }
});

test("HTTP 200 without text tokens is treated as a failed route", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/empty/v1/chat/completions") {
      writeSse(response, [{ choices: [{ delta: { role: "assistant" }, finish_reason: null }] }]);
      return;
    }
    if (request.url === "/ok/v1/chat/completions") {
      writeSse(response, [{ choices: [{ delta: { content: "real-output" }, finish_reason: null }] }]);
      return;
    }
    response.writeHead(404).end();
  });
  const port = await listen(server);

  try {
    const pool = new LlmProviderPool(parseLlmProviderPool({
      providers: [
        {
          id: "empty",
          name: "Empty Relay",
          baseUrl: `http://127.0.0.1:${port}/empty/v1`,
          apiKey: "empty-key",
          enabled: true,
          priority: 10,
          models: [{ id: "empty-model", enabled: true, priority: 10, protocols: ["chat_completions"] }],
        },
        {
          id: "ok",
          name: "OK Relay",
          baseUrl: `http://127.0.0.1:${port}/ok/v1`,
          apiKey: "ok-key",
          enabled: true,
          priority: 20,
          models: [{ id: "ok-model", enabled: true, priority: 10, protocols: ["chat_completions"] }],
        },
      ],
      firstTokenTimeoutMs: 2000,
      totalTimeoutMs: 5000,
      cooldownMs: 1000,
      maxAttempts: 4,
    }));

    let text = "";
    await pool.streamChat({
      messages: [{ role: "user", content: "hello" }],
      signal: new AbortController().signal,
      onDelta: (delta) => { text += delta; },
    });
    assert.equal(text, "real-output");
  } finally {
    await close(server);
  }
});
