import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RuntimeApiConfigStore } from "../src/admin/runtime-api-config-store.js";

test("runtime api config persists, reloads and never exposes secret values", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aipany-runtime-config-"));
  const filePath = path.join(dir, "runtime-api-config.json");
  const keys = [
    "CHAT2API_LIVE_ENABLED",
    "CHAT2API_LIVE_BASE_URL",
    "CHAT2API_LIVE_API_KEY",
    "CHAT2API_LIVE_MODEL",
    "CHAT2API_LIVE_CLIENT_ID",
    "DASHSCOPE_API_KEY",
    "LLM_API_KEY",
    "LLM_BASE_URL",
    "LLM_MODEL",
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

  try {
    const store = new RuntimeApiConfigStore({ filePath, adminToken: "test-admin-token" });
    assert.equal(store.authenticate("test-admin-token"), true);
    assert.equal(store.authenticate("wrong-token"), false);

    const snapshot = await store.update({
      CHAT2API_LIVE_ENABLED: "true",
      CHAT2API_LIVE_BASE_URL: "https://chat2api.example.com",
      CHAT2API_LIVE_API_KEY: "chat2api-secret",
      CHAT2API_LIVE_MODEL: "gpt-live",
      CHAT2API_LIVE_CLIENT_ID: "voice-client-1",
      DASHSCOPE_API_KEY: "dashscope-secret",
      LLM_API_KEY: "llm-secret",
      LLM_BASE_URL: "https://example.com/v1",
      LLM_MODEL: "example-model",
    });

    assert.equal(snapshot.secrets.CHAT2API_LIVE_API_KEY?.configured, true);
    assert.equal(snapshot.secrets.DASHSCOPE_API_KEY?.configured, true);
    assert.equal(snapshot.secrets.LLM_API_KEY?.configured, true);
    assert.equal("CHAT2API_LIVE_API_KEY" in snapshot.values, false);
    assert.equal("DASHSCOPE_API_KEY" in snapshot.values, false);
    assert.equal(JSON.stringify(snapshot).includes("chat2api-secret"), false);
    assert.equal(JSON.stringify(snapshot).includes("dashscope-secret"), false);
    assert.equal(process.env.CHAT2API_LIVE_ENABLED, "true");
    assert.equal(process.env.CHAT2API_LIVE_MODEL, "gpt-live");
    assert.equal(process.env.LLM_BASE_URL, "https://example.com/v1");

    await store.update({ CHAT2API_LIVE_API_KEY: "" });
    assert.equal(process.env.CHAT2API_LIVE_API_KEY, "chat2api-secret");

    await assert.rejects(
      () => store.update({ CHAT2API_LIVE_MODEL: "not-a-live-model" }),
      /gpt-live/,
    );

    const fileMode = (await stat(filePath)).mode & 0o777;
    assert.equal(fileMode, 0o600);
    const persisted = await readFile(filePath, "utf8");
    assert.match(persisted, /CHAT2API_LIVE_MODEL/);
    assert.match(persisted, /LLM_MODEL/);

    for (const key of keys) delete process.env[key];

    const reloaded = new RuntimeApiConfigStore({ filePath, adminToken: "test-admin-token" });
    await reloaded.loadAndApply();
    assert.equal(process.env.CHAT2API_LIVE_ENABLED, "true");
    assert.equal(process.env.CHAT2API_LIVE_BASE_URL, "https://chat2api.example.com");
    assert.equal(process.env.CHAT2API_LIVE_API_KEY, "chat2api-secret");
    assert.equal(process.env.CHAT2API_LIVE_MODEL, "gpt-live");
    assert.equal(process.env.CHAT2API_LIVE_CLIENT_ID, "voice-client-1");
    assert.equal(process.env.DASHSCOPE_API_KEY, "dashscope-secret");
    assert.equal(process.env.LLM_API_KEY, "llm-secret");
    assert.equal(process.env.LLM_BASE_URL, "https://example.com/v1");
    assert.equal(process.env.LLM_MODEL, "example-model");
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});
