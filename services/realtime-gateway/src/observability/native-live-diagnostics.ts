import type { AppConfig } from "../config.js";

export type NativeLiveCapabilityStatus = "ready" | "disabled" | "missing_api_key";

export interface NativeLiveCapabilityDiagnostic {
  status: NativeLiveCapabilityStatus;
  enabled: boolean;
  apiKeyConfigured: boolean;
  dedicatedApiKeyConfigured: boolean;
  dashscopeApiKeyConfigured: boolean;
  workspaceConfigured: boolean;
  realtimeBaseUrlConfigured: boolean;
  model: string;
  protocol: string;
  vadThreshold: number;
  silenceMs: number;
  requested: string;
}

export function getNativeLiveCapabilityDiagnostic(config: AppConfig): NativeLiveCapabilityDiagnostic {
  const dedicatedApiKeyConfigured = Boolean(process.env.QWEN_OMNI_API_KEY?.trim());
  const dashscopeApiKeyConfigured = Boolean(process.env.DASHSCOPE_API_KEY?.trim());
  const apiKeyConfigured = Boolean(config.qwenOmniRealtime.apiKey.trim());
  const status: NativeLiveCapabilityStatus = !config.qwenOmniRealtime.enabled
    ? "disabled"
    : !apiKeyConfigured
      ? "missing_api_key"
      : "ready";

  return {
    status,
    enabled: config.qwenOmniRealtime.enabled,
    apiKeyConfigured,
    dedicatedApiKeyConfigured,
    dashscopeApiKeyConfigured,
    workspaceConfigured: Boolean(config.qwenOmniRealtime.workspaceId?.trim()),
    realtimeBaseUrlConfigured: Boolean(process.env.QWEN_OMNI_REALTIME_BASE_URL?.trim()),
    model: config.qwenOmniRealtime.model,
    protocol: config.qwenOmniRealtime.turnDetection,
    vadThreshold: config.qwenOmniRealtime.vadThreshold,
    silenceMs: config.qwenOmniRealtime.silenceMs,
    requested: config.server.realtimeEngine,
  };
}
