import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { benchmarkRelayProvider } from "../src/admin/relay-model-tester.js";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function sse(response: import("node:http").ServerResponse, payloads: unknown[], delayMs = 0): void {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  setTimeout(() => {
    for (const payload of payloads) response.write(`data: ${JSON.stringify(payload)}\n\n`);
    response.end("data: [DONE]\n\n");
  }, delayMs);
}

test("relay benchmark keeps only models that pass both protocols and sorts by latency", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/v1/models") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "fast-model" }, { id: "partial-model" }, { id: "slow-model" }] }));
      return;
    }

    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const model = JSON.parse(body || "{}").model;
      if (request.url === "/v1/chat/completions") {
        if (model === "partial-model") {
          response.writeHead(404, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: "unsupported" }));
          return;
        }
        sse(response, [{ choices: [{ delta: { content: "OK" } }] }], model === "fast-model" ? 10 : 40);
        return;
      }
      if (request.url === "/v1/responses") {
        sse(response, [{ type: "response.output_text.delta", delta: "OK" }], model === "fast-model" ? 5 : 30);
        return;
      }
      response.writeHead(404).end();
    });
  });
  const port = await listen(server);

  try {
    const result = await benchmarkRelayProvider({
      id: "relay",
      name: "Relay",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "test-key",
      enabled: true,
      priority: 10,
      models: [{ id: "placeholder", enabled: false, priority: 100, protocols: ["chat_completions"] }],
    }, { firstTokenTimeoutMs: 1000, totalTimeoutMs: 3000, concurrency: 2 });

    assert.equal(result.discoveredModels, 3);
    assert.deepEqual(result.eligibleModels.map((item) => item.id), ["fast-model", "slow-model"]);
    assert.deepEqual(result.eligibleModels[0]?.protocols, ["responses", "chat_completions"]);
    assert.equal(result.eligibleModels[0]?.priority, 10);
    assert.equal(result.eligibleModels[1]?.priority, 20);
    assert.equal(result.results.find((item) => item.model === "partial-model")?.eligible, false);
  } finally {
    await close(server);
  }
});
