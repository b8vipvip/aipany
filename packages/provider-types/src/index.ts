export const providerCategories = ["realtime", "text", "asr", "tts"] as const;
export const providerProtocols = ["openai", "openai-compatible", "gemini", "custom"] as const;
export type ProviderCategory = (typeof providerCategories)[number];
export type ProviderProtocol = (typeof providerProtocols)[number];

export interface ProviderConfigDto {
  id: string;
  name: string;
  category: ProviderCategory;
  protocol: ProviderProtocol;
  enabled: boolean;
  baseUrl: string;
  model: string;
  voice?: string | null;
  priority: number;
  settings: Record<string, unknown>;
  apiKeyConfigured: boolean;
  apiKeyMasked?: string | null;
  isDefault?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderPolicyDto {
  realtimeProviderId?: string | null;
  textProviderId?: string | null;
  asrProviderId?: string | null;
  ttsProviderId?: string | null;
}

