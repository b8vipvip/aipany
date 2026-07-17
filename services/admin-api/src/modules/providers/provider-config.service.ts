import type { ProviderCategory, ProviderConfigDto } from "@aipany/provider-types";

import { maskSecret, SecretCrypto } from "../../security/secret-crypto.js";
import type { ProviderConfigRepository } from "./provider-config.repository.js";
import type { ProviderConfigInput, ProviderConfigRow, ProviderPolicy } from "./provider-config.types.js";

interface ProviderTestResult {
  success: boolean;
  latencyMs: number;
  message: string;
}

const policyKeyByCategory: Record<ProviderCategory, keyof ProviderPolicy> = {
  realtime: "realtimeProviderId",
  text: "textProviderId",
  asr: "asrProviderId",
  tts: "ttsProviderId",
};

export class ProviderConfigService {
  constructor(
    private readonly repo: ProviderConfigRepository,
    private readonly crypto: SecretCrypto,
  ) {}

  async list(): Promise<ProviderConfigDto[]> {
    const [rows, policy] = await Promise.all([this.repo.list(), this.repo.getPolicy()]);
    return rows.map((row) => this.toDto(row, policy));
  }

  async get(id: string): Promise<ProviderConfigDto> {
    const row = await this.repo.get(id);
    if (!row) {
      throw new Error("Provider 不存在");
    }

    return this.toDto(row, await this.repo.getPolicy());
  }

  async create(input: ProviderConfigInput): Promise<ProviderConfigDto> {
    const encrypted = input.apiKey ? this.crypto.encrypt(input.apiKey) : null;
    const row = await this.repo.create({
      ...this.toRow(input),
      api_key_ciphertext: encrypted?.ciphertext,
      api_key_iv: encrypted?.iv,
      api_key_auth_tag: encrypted?.authTag,
    });

    return this.toDto(row, await this.repo.getPolicy());
  }

  async update(id: string, input: Partial<ProviderConfigInput>): Promise<ProviderConfigDto> {
    const encrypted = input.apiKey ? this.crypto.encrypt(input.apiKey) : null;
    const row = await this.repo.update(id, {
      ...this.toRow(input),
      ...(encrypted
        ? {
            api_key_ciphertext: encrypted.ciphertext,
            api_key_iv: encrypted.iv,
            api_key_auth_tag: encrypted.authTag,
          }
        : {}),
    });

    if (!row) {
      throw new Error("Provider 不存在");
    }

    return this.toDto(row, await this.repo.getPolicy());
  }

  async delete(id: string): Promise<void> {
    await this.repo.delete(id);
  }

  async getPolicy(): Promise<ProviderPolicy> {
    return this.repo.getPolicy();
  }

  async setPolicy(policy: ProviderPolicy): Promise<ProviderPolicy> {
    const rows = await this.repo.list();

    for (const [category, key] of Object.entries(policyKeyByCategory) as [ProviderCategory, keyof ProviderPolicy][]) {
      const providerId = policy[key];
      if (!providerId) {
        continue;
      }

      const row = rows.find((provider) => provider.id === providerId);
      if (!row || !row.enabled || row.category !== category) {
        throw new Error(`默认 ${category} Provider 必须已启用且类别匹配`);
      }
    }

    return this.repo.setPolicy(policy);
  }

  async test(id: string): Promise<ProviderTestResult> {
    const row = await this.repo.get(id);
    if (!row) {
      throw new Error("Provider 不存在");
    }

    if (row.category !== "realtime") {
      return { success: false, latencyMs: 0, message: "暂未实现该类型 Provider 的自动测试" };
    }

    if (row.protocol !== "openai" && row.protocol !== "openai-compatible") {
      return { success: false, latencyMs: 0, message: "暂不支持该协议的 Realtime 自动测试" };
    }

    if (!row.api_key_ciphertext || !row.api_key_iv || !row.api_key_auth_tag) {
      return { success: false, latencyMs: 0, message: "Provider 尚未配置 API Key" };
    }

    const apiKey = this.crypto.decrypt({
      ciphertext: row.api_key_ciphertext,
      iv: row.api_key_iv,
      authTag: row.api_key_auth_tag,
    });
    const startedAt = Date.now();
    const response = await fetch(`${row.base_url.replace(/\/$/, "")}/realtime/client_secrets`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session: {
          type: "realtime",
          model: row.model,
          audio: {
            output: {
              voice: row.voice ?? "marin",
            },
          },
        },
      }),
    });

    return {
      success: response.ok,
      latencyMs: Date.now() - startedAt,
      message: response.ok ? "Realtime Provider 测试通过" : `Realtime Provider 测试失败，状态码 ${response.status}`,
    };
  }

  private toRow(input: Partial<ProviderConfigInput>): Partial<ProviderConfigRow> {
    return {
      name: input.name,
      category: input.category,
      protocol: input.protocol,
      enabled: input.enabled,
      base_url: input.baseUrl,
      model: input.model,
      voice: input.voice ?? undefined,
      priority: input.priority,
      settings: input.settings,
    };
  }

  private toDto(row: ProviderConfigRow, policy: ProviderPolicy): ProviderConfigDto {
    let decryptedKey: string | null = null;
    if (row.api_key_ciphertext && row.api_key_iv && row.api_key_auth_tag) {
      try {
        decryptedKey = this.crypto.decrypt({
          ciphertext: row.api_key_ciphertext,
          iv: row.api_key_iv,
          authTag: row.api_key_auth_tag,
        });
      } catch {
        decryptedKey = null;
      }
    }

    return {
      id: row.id,
      name: row.name,
      category: row.category,
      protocol: row.protocol,
      enabled: row.enabled,
      baseUrl: row.base_url,
      model: row.model,
      voice: row.voice,
      priority: row.priority,
      settings: row.settings ?? {},
      apiKeyConfigured: Boolean(row.api_key_ciphertext),
      apiKeyMasked: maskSecret(decryptedKey),
      isDefault: this.isDefault(row.category, row.id, policy),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private isDefault(category: ProviderCategory, id: string, policy: ProviderPolicy): boolean {
    return policy[policyKeyByCategory[category]] === id;
  }
}
