import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { getNativeLiveCapabilityDiagnostic } from "../src/observability/native-live-diagnostics.js";

const MANAGED_KEYS = [
  "AIPANY_REALTIME_ENGINE",
  "DASHSCOPE_API_KEY",
  "DASHSCOPE_WORKSPACE_ID",
  "QWEN_OMNI_API_KEY",
  "QWEN_OMNI_REALTIME_ENABLED",
  "QWEN_OMNI_REALTIME_BASE_URL",
  "QWEN_OMNI_REALTIME_MODEL",
  "QWEN_OMNI_REALTIME_TURN_DETECTION",
  "QWEN_OMNI_REALTIME_VAD_THRESHOLD",
  "QWEN_OMNI_REALTIME_SILENCE_MS",
] as const;

function withEnv(t: test.TestContext, values: Partial<Record<(typeof MANAGED_KEYS)[number], string | undefined>>): void {
  const previous = new Map<string, string | undefined>();
  for (const key of MANAGED_KEYS) previous.set(key, process.env[key]);
  for (const key of MANAGED_KEYS) {
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("native live diagnostic reports disabled even when DashScope key is reusable", (t) => {
  withEnv(t, {
    AIPANY_REALTIME_ENGINE: "auto",
    DASHSCOPE_API_KEY: "dashscope-test-key",
    QWEN_OMNI_REALTIME_ENABLED: "false",
  });

  const diagnostic = getNativeLiveCapabilityDiagnostic(loadConfig());
  assert.equal(diagnostic.status, "disabled");
  assert.equal(diagnostic.enabled, false);
  assert.equal(diagnostic.apiKeyConfigured, true);
  assert.equal(diagnostic.dedicatedApiKeyConfigured, false);
  assert.equal(diagnostic.dashscopeApiKeyConfigured, true);
});

test("native live diagnostic reports missing api key when enabled without either key", (t) => {
  withEnv(t, {
    AIPANY_REALTIME_ENGINE: "auto",
    QWEN_OMNI_REALTIME_ENABLED: "true",
  });

  const diagnostic = getNativeLiveCapabilityDiagnostic(loadConfig());
  assert.equal(diagnostic.status, "missing_api_key");
  assert.equal(diagnostic.enabled, true);
  assert.equal(diagnostic.apiKeyConfigured, false);
});

test("native live diagnostic reports ready and safe runtime details", (t) => {
  withEnv(t, {
    AIPANY_REALTIME_ENGINE: "auto",
    DASHSCOPE_API_KEY: "dashscope-test-key",
    DASHSCOPE_WORKSPACE_ID: "workspace-test",
    QWEN_OMNI_REALTIME_ENABLED: "true",
    QWEN_OMNI_REALTIME_MODEL: "qwen3.5-omni-plus-realtime",
    QWEN_OMNI_REALTIME_TURN_DETECTION: "server_vad",
    QWEN_OMNI_REALTIME_VAD_THRESHOLD: "0.2",
    QWEN_OMNI_REALTIME_SILENCE_MS: "350",
  });

  const diagnostic = getNativeLiveCapabilityDiagnostic(loadConfig());
  assert.deepEqual(diagnostic, {
    status: "ready",
    enabled: true,
    apiKeyConfigured: true,
    dedicatedApiKeyConfigured: false,
    dashscopeApiKeyConfigured: true,
    workspaceConfigured: true,
    realtimeBaseUrlConfigured: false,
    model: "qwen3.5-omni-plus-realtime",
    protocol: "server_vad",
    vadThreshold: 0.2,
    silenceMs: 350,
    requested: "auto",
  });
});
