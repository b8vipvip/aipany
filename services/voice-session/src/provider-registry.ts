import { createDecipheriv, createHash } from "node:crypto";

import pg from "pg";

import { VoiceSessionError } from "./errors.js";
import { OpenAIRealtimeProvider } from "./providers/openai-realtime-provider.js";
import type { RealtimeProvider } from "./types.js";

export interface RegistryConfig {
  databaseUrl?: string;
  encryptionKey?: string;
  fallback: ConstructorParameters<typeof OpenAIRealtimeProvider>[0];
}

interface ProviderPolicyRow {
  value?: {
    realtimeProviderId?: string | null;
  };
}

interface ProviderConfigRow {
  id: string;
  protocol: string;
  base_url: string;
  model: string;
  voice: string | null;
  api_key_ciphertext: string;
  api_key_iv: string;
  api_key_auth_tag: string;
}

function keyBytes(key: string): Buffer {
  const base64Key = Buffer.from(key, "base64");
  if (base64Key.length === 32) {
    return base64Key;
  }

  if (Buffer.byteLength(key) === 32) {
    return Buffer.from(key);
  }

  return createHash("sha256").update(key).digest();
}

function decryptApiKey(encryptionKey: string, row: ProviderConfigRow): string {
  const decipher = createDecipheriv("aes-256-gcm", keyBytes(encryptionKey), Buffer.from(row.api_key_iv, "base64"));
  decipher.setAuthTag(Buffer.from(row.api_key_auth_tag, "base64"));

  return Buffer.concat([decipher.update(Buffer.from(row.api_key_ciphertext, "base64")), decipher.final()]).toString("utf8");
}

export class ProviderRegistry {
  constructor(private readonly config: RegistryConfig) {}

  async getRealtimeProvider(): Promise<RealtimeProvider> {
    if (this.config.databaseUrl && this.config.encryptionKey) {
      const provider = await this.getDatabaseRealtimeProvider();
      if (provider) {
        return provider;
      }
    }

    return new OpenAIRealtimeProvider(this.config.fallback);
  }

  private async getDatabaseRealtimeProvider(): Promise<RealtimeProvider | null> {
    const pool = new pg.Pool({ connectionString: this.config.databaseUrl });

    try {
      const policyResult = await pool.query("SELECT value FROM system_settings WHERE key='provider_policy'");
      const policy = (policyResult.rows[0] as ProviderPolicyRow | undefined)?.value;
      if (!policy?.realtimeProviderId) {
        return null;
      }

      const providerResult = await pool.query("SELECT * FROM provider_configs WHERE id=$1 AND enabled=true", [
        policy.realtimeProviderId,
      ]);
      const row = providerResult.rows[0] as ProviderConfigRow | undefined;
      if (!row) {
        return null;
      }

      if (row.protocol !== "openai" && row.protocol !== "openai-compatible") {
        throw new VoiceSessionError("UNSUPPORTED_PROVIDER_PROTOCOL", "默认 Realtime Provider 的协议暂不支持", 422, {
          protocol: row.protocol,
        });
      }

      if (!this.config.encryptionKey) {
        return null;
      }

      return new OpenAIRealtimeProvider({
        apiKey: decryptApiKey(this.config.encryptionKey, row),
        baseUrl: row.base_url.replace(/\/$/, ""),
        model: row.model,
        voice: row.voice ?? "marin",
      });
    } finally {
      await pool.end();
    }
  }
}
