import type { ProviderCategory, ProviderConfigDto, ProviderPolicyDto, ProviderProtocol } from "@aipany/provider-types";

export interface ProviderConfigRow {
  id: string;
  name: string;
  category: ProviderCategory;
  protocol: ProviderProtocol;
  enabled: boolean;
  base_url: string;
  model: string;
  voice: string | null;
  api_key_ciphertext: string | null;
  api_key_iv: string | null;
  api_key_auth_tag: string | null;
  priority: number;
  settings: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export type ProviderConfigInput = Omit<
  ProviderConfigDto,
  "id" | "apiKeyConfigured" | "apiKeyMasked" | "createdAt" | "updatedAt" | "isDefault"
> & {
  apiKey?: string | null;
};

export type ProviderPolicy = ProviderPolicyDto;
