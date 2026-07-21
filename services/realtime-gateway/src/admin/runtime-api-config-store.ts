import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { timingSafeEqual } from "node:crypto";
import {
  createLegacyLlmProviderPool,
  parseLlmProviderPool,
  type LlmProviderPoolConfig,
} from "../providers/llm-provider-pool.js";

export const MANAGED_RUNTIME_KEYS = [
  "DASHSCOPE_API_KEY",
  "DASHSCOPE_WORKSPACE_ID",
  "DASHSCOPE_ASR_WS_BASE_URL",
  "DASHSCOPE_TTS_WS_BASE_URL",
  "QWEN_ASR_MODEL",
  "QWEN_TTS_MODEL",
  "QWEN_TTS_VOICE",
  "QWEN_TTS_LANGUAGE",
  "QWEN_OMNI_API_KEY",
  "QWEN_OMNI_BASE_URL",
  "QWEN_OMNI_MODEL",
  "LLM_BASE_URL",
  "LLM_API_KEY",
  "LLM_MODEL",
  "CLOUD_AUDIO_INTELLIGENCE_ENABLED",
  "CLOUD_AUDIO_ENVIRONMENT_ENABLED",
  "CLOUD_AUDIO_DIARIZED_TRANSCRIPTION_ENABLED",
  "REMOTE_SEPARATION_ENABLED",
  "REMOTE_SEPARATION_BASE_URL",
  "REMOTE_SEPARATION_TOKEN",
  "REMOTE_SEPARATION_TIMEOUT_MS",
  "REMOTE_SEPARATION_TRIGGER",
] as const;

export type ManagedRuntimeKey = typeof MANAGED_RUNTIME_KEYS[number];
export type RuntimeApiConfig = Partial<Record<ManagedRuntimeKey, string>>;

const SECRET_KEYS = new Set<ManagedRuntimeKey>([
  "DASHSCOPE_API_KEY",
  "QWEN_OMNI_API_KEY",
  "LLM_API_KEY",
  "REMOTE_SEPARATION_TOKEN",
]);

const BOOLEAN_KEYS = new Set<ManagedRuntimeKey>([
  "CLOUD_AUDIO_INTELLIGENCE_ENABLED",
  "CLOUD_AUDIO_ENVIRONMENT_ENABLED",
  "CLOUD_AUDIO_DIARIZED_TRANSCRIPTION_ENABLED",
  "REMOTE_SEPARATION_ENABLED",
]);

export class RuntimeApiConfigStore {
  readonly filePath: string;
  private readonly adminToken?: string;
  private readonly baselineEnv: Partial<Record<ManagedRuntimeKey, string>>;
  private values: RuntimeApiConfig = {};
  private llmProviderPool?: LlmProviderPoolConfig;

  constructor(options: { filePath?: string; adminToken?: string } = {}) {
    this.filePath = options.filePath?.trim() || "/data/runtime-api-config.json";
    this.adminToken = options.adminToken?.trim() || undefined;
    this.baselineEnv = Object.fromEntries(
      MANAGED_RUNTIME_KEYS.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]]),
    ) as Partial<Record<ManagedRuntimeKey, string>>;
  }

  get enabled(): boolean {
    return Boolean(this.adminToken);
  }

  authenticate(candidate: string | undefined): boolean {
    if (!this.adminToken || !candidate) return false;
    const expected = Buffer.from(this.adminToken, "utf8");
    const actual = Buffer.from(candidate, "utf8");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  async loadAndApply(): Promise<void> {
    try {
      const content = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content) as Record<string, unknown>;
      this.values = sanitize(parsed);
      this.llmProviderPool = parsed.llmProviderPool === undefined ? undefined : parseLlmProviderPool(parsed.llmProviderPool);
      this.apply();
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") return;
      throw error;
    }
  }

  async update(patch: Record<string, unknown>) {
    const next = { ...this.values } as RuntimeApiConfig;
    let nextPool = this.llmProviderPool;

    for (const [rawKey, rawValue] of Object.entries(patch)) {
      if (rawKey === "llmProviderPool") continue;
      if (!MANAGED_RUNTIME_KEYS.includes(rawKey as ManagedRuntimeKey)) continue;
      const key = rawKey as ManagedRuntimeKey;
      if (rawValue === null) {
        delete next[key];
        continue;
      }
      if (typeof rawValue !== "string") throw new Error(`${key} 必须是字符串或 null`);
      const value = rawValue.trim();
      if (SECRET_KEYS.has(key) && value === "") continue;
      if (!value) delete next[key];
      else next[key] = validateValue(key, value);
    }

    if (patch.llmProviderPool !== undefined) {
      nextPool = mergeLlmProviderPoolSecrets(this.getLlmProviderPool(), patch.llmProviderPool);
    }

    this.values = next;
    this.llmProviderPool = nextPool;
    this.apply();
    await this.persist();
    return this.snapshot();
  }

  async replaceDocument(document: Record<string, unknown>) {
    this.values = sanitize(document);
    this.llmProviderPool = document.llmProviderPool === undefined
      ? undefined
      : parseLlmProviderPool(document.llmProviderPool);
    this.apply();
    await this.persist();
    return this.snapshot();
  }

  exportDocument(): Record<string, unknown> {
    return {
      ...this.values,
      llmProviderPool: this.getLlmProviderPool(),
    };
  }

  getLlmProviderPool(): LlmProviderPoolConfig {
    return this.llmProviderPool ?? createLegacyLlmProviderPool({
      baseUrl: process.env.LLM_BASE_URL?.trim() || "",
      apiKey: process.env.LLM_API_KEY?.trim() || "",
      model: process.env.LLM_MODEL?.trim() || "",
    });
  }

  snapshot() {
    const values: Record<string, string> = {};
    const secrets: Record<string, { configured: boolean }> = {};
    for (const key of MANAGED_RUNTIME_KEYS) {
      const value = process.env[key]?.trim() || "";
      if (SECRET_KEYS.has(key)) secrets[key] = { configured: Boolean(value) };
      else values[key] = value;
    }
    return {
      enabled: this.enabled,
      path: this.filePath,
      values,
      secrets,
      llmProviderPool: redactLlmProviderPool(this.getLlmProviderPool()),
    };
  }

  private apply(): void {
    for (const key of MANAGED_RUNTIME_KEYS) {
      const baseline = this.baselineEnv[key];
      if (baseline === undefined) delete process.env[key];
      else process.env[key] = baseline;
    }
    for (const [key, value] of Object.entries(this.values)) process.env[key] = value;
    if (this.llmProviderPool) process.env.LLM_PROVIDER_POOL_JSON = JSON.stringify(this.llmProviderPool);
    else delete process.env.LLM_PROVIDER_POOL_JSON;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    const document: Record<string, unknown> = { ...this.values };
    if (this.llmProviderPool) document.llmProviderPool = this.llmProviderPool;
    await writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temp, this.filePath);
  }
}

function sanitize(input: Record<string, unknown>): RuntimeApiConfig {
  const output: RuntimeApiConfig = {};
  for (const key of MANAGED_RUNTIME_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) output[key] = validateValue(key, value.trim());
  }
  return output;
}

function validateValue(key: ManagedRuntimeKey, value: string): string {
  if (BOOLEAN_KEYS.has(key) && value !== "true" && value !== "false") throw new Error(`${key} 只能是 true 或 false`);
  if (["DASHSCOPE_ASR_WS_BASE_URL", "DASHSCOPE_TTS_WS_BASE_URL", "QWEN_OMNI_BASE_URL", "LLM_BASE_URL", "REMOTE_SEPARATION_BASE_URL"].includes(key)) {
    try { new URL(value); } catch { throw new Error(`${key} 不是有效 URL`); }
  }
  if (key === "REMOTE_SEPARATION_TRIGGER" && !["overlap_only", "overlap_or_multi_speaker", "always_owner_focus"].includes(value)) {
    throw new Error(`${key} 的值无效`);
  }
  return value;
}

function mergeLlmProviderPoolSecrets(current: LlmProviderPoolConfig, raw: unknown): LlmProviderPoolConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("llmProviderPool 必须是对象");
  const input = raw as Record<string, unknown>;
  if (!Array.isArray(input.providers)) throw new Error("llmProviderPool.providers 必须是数组");
  const existing = new Map(current.providers.map((provider) => [provider.id, provider]));
  const providers = input.providers.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("LLM Provider 必须是对象");
    const provider = entry as Record<string, unknown>;
    const id = typeof provider.id === "string" ? provider.id.trim() : "";
    const previous = existing.get(id);
    const suppliedApiKey = typeof provider.apiKey === "string" ? provider.apiKey.trim() : "";
    return {
      ...provider,
      apiKey: suppliedApiKey || previous?.apiKey || "",
    };
  });
  return parseLlmProviderPool({ ...input, providers });
}

function redactLlmProviderPool(pool: LlmProviderPoolConfig) {
  return {
    ...pool,
    providers: pool.providers.map(({ apiKey, ...provider }) => ({
      ...provider,
      apiKey: "",
      apiKeyConfigured: Boolean(apiKey.trim()),
    })),
  };
}
