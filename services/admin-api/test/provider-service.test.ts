import { describe, expect, it } from "vitest";

import { ProviderConfigService } from "../src/modules/providers/provider-config.service.js";
import { SecretCrypto } from "../src/security/secret-crypto.js";

const now = new Date();

function createRepositoryStub() {
  let rows: any[] = [];
  let policy: any = {};

  return {
    list: async () => rows,
    get: async (id: string) => rows.find((row) => row.id === id) ?? null,
    create: async (value: any) => {
      const row = {
        id: "00000000-0000-4000-8000-000000000001",
        created_at: now,
        updated_at: now,
        ...value,
      };
      rows.push(row);
      return row;
    },
    update: async (id: string, value: any) => {
      const row = rows.find((item) => item.id === id);
      Object.assign(row, value, { updated_at: now });
      return row;
    },
    delete: async (id: string) => {
      rows = rows.filter((row) => row.id !== id);
    },
    getPolicy: async () => policy,
    setPolicy: async (value: any) => {
      policy = value;
      return policy;
    },
  } as any;
}

describe("ProviderConfigService", () => {
  it("创建后不回显完整 API Key", async () => {
    const service = new ProviderConfigService(
      createRepositoryStub(),
      new SecretCrypto("12345678901234567890123456789012"),
    );

    const dto = await service.create({
      name: "OpenAI",
      category: "realtime",
      protocol: "openai",
      enabled: true,
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-realtime-2.1",
      voice: "marin",
      priority: 1,
      settings: {},
      apiKey: "sk-secretabcd",
    });

    expect(dto.apiKeyConfigured).toBe(true);
    expect(JSON.stringify(dto)).not.toContain("sk-secretabcd");
  });

  it("默认策略只允许启用且类别匹配", async () => {
    const repository = createRepositoryStub();
    const service = new ProviderConfigService(
      repository,
      new SecretCrypto("12345678901234567890123456789012"),
    );

    const dto = await service.create({
      name: "OpenAI",
      category: "realtime",
      protocol: "openai",
      enabled: true,
      baseUrl: "https://api.openai.com/v1",
      model: "m",
      priority: 1,
      settings: {},
    });

    await expect(service.setPolicy({ realtimeProviderId: dto.id })).resolves.toEqual({
      realtimeProviderId: dto.id,
    });
    await expect(service.setPolicy({ textProviderId: dto.id })).rejects.toThrow(/类别匹配/);
  });
});
