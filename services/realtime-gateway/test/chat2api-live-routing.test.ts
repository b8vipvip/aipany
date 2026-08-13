import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { getRealtimeExperienceDefinitions } from "../src/mobile/realtime-experience.js";

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

test("Chat2API-only deployment keeps disabled Qwen modes on cascaded fallback", async () => {
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
    const modes = getRealtimeExperienceDefinitions(config);
    const chatgpt = modes.find((item) => item.id === "chat2api_live");
    const qwenFlash = modes.find((item) => item.id === "native_flash");
    const qwenPlus = modes.find((item) => item.id === "native_plus");

    assert.equal(chatgpt?.engine, "omni_realtime");
    assert.equal(qwenFlash?.engine, "cascaded");
    assert.equal(qwenPlus?.engine, "cascaded");
  });
});

test("Qwen-only deployment keeps disabled Chat2API mode on cascaded fallback", async () => {
  await withEnvironment({
    AIPANY_REALTIME_ENGINE: "auto",
    CHAT2API_LIVE_ENABLED: "false",
    CHAT2API_LIVE_API_KEY: "",
    CHAT2API_LIVE_BASE_URL: "https://chat2api.example.test",
    CHAT2API_LIVE_MODEL: "gpt-live",
    QWEN_OMNI_REALTIME_ENABLED: "true",
    QWEN_OMNI_API_KEY: "test-qwen-key",
    DASHSCOPE_API_KEY: "",
    SPEAKER_IDENTITY_STORE: "memory",
  }, () => {
    const config = loadConfig();
    const modes = getRealtimeExperienceDefinitions(config);
    const chatgpt = modes.find((item) => item.id === "chat2api_live");
    const qwenFlash = modes.find((item) => item.id === "native_flash");
    const qwenPlus = modes.find((item) => item.id === "native_plus");

    assert.equal(chatgpt?.engine, "cascaded");
    assert.equal(qwenFlash?.engine, "omni_realtime");
    assert.equal(qwenPlus?.engine, "omni_realtime");
  });
});
