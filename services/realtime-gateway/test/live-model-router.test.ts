import assert from "node:assert/strict";
import test from "node:test";
import { LiveModelRouter, assignLiveRoutingVariant } from "../src/pipeline/live-model-router.js";
import { applyLiveRoutingPolicy } from "../src/providers/llm-routing-policy.js";
import type { LlmProviderPoolConfig } from "../src/providers/llm-provider-pool.js";

const basePool: LlmProviderPoolConfig = {
  active: true,
  preferredRouteTtlMs: 60_000,
  providers: [
    {
      id: "p1",
      name: "Primary",
      baseUrl: "https://example.com/v1",
      apiKey: "test",
      enabled: true,
      priority: 100,
      cooldownSeconds: 10,
      protocols: ["chat_completions"],
      models: [
        { id: "fast-flash", enabled: true, priority: 100, benchmarkScoreMs: 240 },
        { id: "reasoning-plus-72b", enabled: true, priority: 100, benchmarkScoreMs: 950 },
        { id: "super-coder-pro", enabled: true, priority: 100, benchmarkScoreMs: 800 },
      ],
    },
  ],
};

function messages(text: string) {
  return [{ role: "user" as const, content: text }];
}

test("live model router classifies quick chat coding and reasoning locally", () => {
  const router = new LiveModelRouter();
  assert.equal(router.decide(messages("哈哈，谢谢"), "session-a").routeClass, "quick_chat");
  assert.equal(router.decide(messages("帮我排查这个 TypeScript WebSocket 代码为什么报错"), "session-a").routeClass, "coding");
  assert.equal(router.decide(messages("请深入分析这个商业方案的长期风险和利弊"), "session-a").routeClass, "reasoning");
});

test("routing experiment variant is stable for the same session seed", () => {
  const first = assignLiveRoutingVariant("stable-session-id");
  for (let index = 0; index < 20; index += 1) {
    assert.equal(assignLiveRoutingVariant("stable-session-id"), first);
  }
});

test("latency-first quick chat strongly prefers measured fast models", () => {
  const routed = applyLiveRoutingPolicy(basePool, "quick_chat", "latency_first");
  const models = routed.providers[0]?.models ?? [];
  const fast = models.find((model) => model.id === "fast-flash");
  const reasoning = models.find((model) => model.id === "reasoning-plus-72b");
  assert.ok(fast && reasoning);
  assert.ok(fast.priority < reasoning.priority);
});

test("coding route prefers coder capability over generic flash speed", () => {
  const routed = applyLiveRoutingPolicy(basePool, "coding", "balanced");
  const models = routed.providers[0]?.models ?? [];
  const coder = models.find((model) => model.id === "super-coder-pro");
  const fast = models.find((model) => model.id === "fast-flash");
  assert.ok(coder && fast);
  assert.ok(coder.priority < fast.priority);
});
