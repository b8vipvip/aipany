export interface Chat2ApiLiveRuntimeConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: "gpt-live" | "gpt-live-mini";
  clientId?: string;
}

export function loadChat2ApiLiveConfig(): Chat2ApiLiveRuntimeConfig {
  const modelValue = (process.env.CHAT2API_LIVE_MODEL || "gpt-live").trim().toLowerCase();
  const model = modelValue === "gpt-live-mini" ? "gpt-live-mini" : "gpt-live";
  return {
    enabled: /^(1|true|yes|on)$/i.test((process.env.CHAT2API_LIVE_ENABLED || "false").trim()),
    baseUrl: (process.env.CHAT2API_LIVE_BASE_URL || "https://chat2api.mv3.cn").trim().replace(/\/$/, ""),
    apiKey: (process.env.CHAT2API_LIVE_API_KEY || "").trim(),
    model,
    clientId: (process.env.CHAT2API_LIVE_CLIENT_ID || "").trim() || undefined,
  };
}

export function isChat2ApiLiveAvailable(): boolean {
  const config = loadChat2ApiLiveConfig();
  return config.enabled && Boolean(config.apiKey);
}
