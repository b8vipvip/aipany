import assert from "node:assert/strict";
import test from "node:test";
import type { AppConfig } from "../src/config.js";
import { isNativeLiveAvailable, resolveRealtimeEngine } from "../src/server.js";

function config(input: {
  engine: "auto" | "cascaded" | "omni_realtime";
  enabled?: boolean;
  apiKey?: string;
}): AppConfig {
  return {
    server: { realtimeEngine: input.engine },
    qwenOmniRealtime: {
      enabled: input.enabled ?? false,
      apiKey: input.apiKey ?? "",
    },
  } as AppConfig;
}

test("Auto 模式在 Native Live 已启用且有 Key 时优先使用 Omni Realtime", () => {
  const value = config({ engine: "auto", enabled: true, apiKey: "test-key" });
  assert.equal(isNativeLiveAvailable(value), true);
  assert.equal(resolveRealtimeEngine(value), "omni_realtime");
});

test("Auto 模式在 Native Live 未配置时安全回退 Cascaded", () => {
  const value = config({ engine: "auto", enabled: true, apiKey: "" });
  assert.equal(isNativeLiveAvailable(value), false);
  assert.equal(resolveRealtimeEngine(value), "cascaded");
});

test("管理员显式选择的引擎不会被 Auto 策略覆盖", () => {
  assert.equal(resolveRealtimeEngine(config({ engine: "cascaded", enabled: true, apiKey: "test-key" })), "cascaded");
  assert.equal(resolveRealtimeEngine(config({ engine: "omni_realtime", enabled: false, apiKey: "" })), "omni_realtime");
});
