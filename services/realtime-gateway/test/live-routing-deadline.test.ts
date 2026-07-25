import assert from "node:assert/strict";
import test from "node:test";
import { applyLiveRoutingPolicy, liveFirstTokenDeadlineMs } from "../src/providers/llm-routing-policy.js";
import { parseLlmProviderPool } from "../src/providers/llm-provider-pool.js";

test("live conversation uses tighter first-token deadlines when fallback routes exist", () => {
  const config = parseLlmProviderPool({
    firstTokenTimeoutMs: 12_000,
    providers: [
      {
        id: "one",
        name: "One",
        baseUrl: "https://one.example.com/v1",
        apiKey: "key-one",
        enabled: true,
        models: [{ id: "model-one", enabled: true, protocols: ["responses"] }],
      },
      {
        id: "two",
        name: "Two",
        baseUrl: "https://two.example.com/v1",
        apiKey: "key-two",
        enabled: true,
        models: [{ id: "model-two", enabled: true, protocols: ["chat_completions"] }],
      },
    ],
  });

  const routed = applyLiveRoutingPolicy(config, "simple_answer", "latency_first");
  assert.equal(routed.firstTokenTimeoutMs, 2_600);
  assert.deepEqual(routed.providers.map((provider) => provider.firstTokenTimeoutMs), [2_600, 2_600]);
});

test("single-route installation keeps its configured timeout", () => {
  const config = parseLlmProviderPool({
    firstTokenTimeoutMs: 12_000,
    providers: [{
      id: "only",
      name: "Only",
      baseUrl: "https://only.example.com/v1",
      apiKey: "key-only",
      enabled: true,
      firstTokenTimeoutMs: 9_000,
      models: [{ id: "model-only", enabled: true, protocols: ["responses"] }],
    }],
  });

  const routed = applyLiveRoutingPolicy(config, "quick_chat", "latency_first");
  assert.equal(routed.firstTokenTimeoutMs, 12_000);
  assert.equal(routed.providers[0]?.firstTokenTimeoutMs, 9_000);
});

test("reasoning receives a longer deadline than quick chat", () => {
  assert.ok(
    liveFirstTokenDeadlineMs("reasoning", "balanced")
      > liveFirstTokenDeadlineMs("quick_chat", "balanced"),
  );
});
