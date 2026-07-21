import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RuntimeApiConfigStore } from "../src/admin/runtime-api-config-store.js";

test("runtime config preserves provider secrets while returning only configured state", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aipany-llm-pool-"));
  const filePath = path.join(dir, "runtime-api-config.json");
  const previousPool = process.env.LLM_PROVIDER_POOL_JSON;
  const previousLegacyKey = process.env.LLM_API_KEY;
  const previousLegacyUrl = process.env.LLM_BASE_URL;
  const previousLegacyModel = process.env.LLM_MODEL;

  try {
    process.env.LLM_API_KEY = "legacy-secret";
    process.env.LLM_BASE_URL = "https://legacy.example/v1";
    process.env.LLM_MODEL = "legacy-model";

    const store = new RuntimeApiConfigStore({ filePath, adminToken: "admin" });
    const snapshot = await store.update({
      llmProviderPool: {
        providers: [{
          id: "relay-one",
          name: "Relay One",
          baseUrl: "https://relay.example/v1",
          apiKey: "relay-secret",
          enabled: true,
          priority: 10,
          models: [{ id: "model-a", enabled: true, priority: 10, protocols: ["responses", "chat_completions"] }],
        }],
        firstTokenTimeoutMs: 8000,
        totalTimeoutMs: 30000,
        cooldownMs: 60000,
        maxAttempts: 4,
      },
    });

    assert.equal(snapshot.llmProviderPool.providers[0]?.apiKeyConfigured, true);
    assert.equal(JSON.stringify(snapshot).includes("relay-secret"), false);
    assert.match(process.env.LLM_PROVIDER_POOL_JSON ?? "", /relay-one/);

    const preserved = await store.update({
      llmProviderPool: {
        providers: [{
          id: "relay-one",
          name: "Relay One Updated",
          baseUrl: "https://relay.example/v1",
          apiKey: "",
          enabled: true,
          priority: 10,
          models: [{ id: "model-b", enabled: true, priority: 20, protocols: ["chat_completions"] }],
        }],
        firstTokenTimeoutMs: 9000,
        totalTimeoutMs: 35000,
        cooldownMs: 45000,
        maxAttempts: 3,
      },
    });
    assert.equal(preserved.llmProviderPool.providers[0]?.apiKeyConfigured, true);
    assert.equal(store.getLlmProviderPool().providers[0]?.apiKey, "relay-secret");
    assert.equal(store.getLlmProviderPool().providers[0]?.models[0]?.id, "model-b");

    delete process.env.LLM_PROVIDER_POOL_JSON;
    const reloaded = new RuntimeApiConfigStore({ filePath, adminToken: "admin" });
    await reloaded.loadAndApply();
    assert.equal(reloaded.getLlmProviderPool().providers[0]?.apiKey, "relay-secret");
    assert.equal(reloaded.getLlmProviderPool().firstTokenTimeoutMs, 9000);
  } finally {
    if (previousPool === undefined) delete process.env.LLM_PROVIDER_POOL_JSON;
    else process.env.LLM_PROVIDER_POOL_JSON = previousPool;
    if (previousLegacyKey === undefined) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = previousLegacyKey;
    if (previousLegacyUrl === undefined) delete process.env.LLM_BASE_URL;
    else process.env.LLM_BASE_URL = previousLegacyUrl;
    if (previousLegacyModel === undefined) delete process.env.LLM_MODEL;
    else process.env.LLM_MODEL = previousLegacyModel;
    await rm(dir, { recursive: true, force: true });
  }
});
