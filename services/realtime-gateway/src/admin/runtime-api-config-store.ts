import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { timingSafeEqual } from "node:crypto";

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
  private values: RuntimeApiConfig = {};

  constructor(options: { filePath?: string; adminToken?: string } = {}) {
    this.filePath = options.filePath?.trim() || "/data/runtime-api-config.json";
    this.adminToken = options.adminToken?.trim() || undefined;
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
      this.values = sanitize(JSON.parse(content) as Record<string, unknown>);
      this.apply();
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") return;
      throw error;
    }
  }

  async update(patch: Record<string, unknown>) {
    const next = { ...this.values } as RuntimeApiConfig;
    for (const [rawKey, rawValue] of Object.entries(patch)) {
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
    this.values = next;
    this.apply();
    await this.persist();
    return this.snapshot();
  }

  snapshot() {
    const values: Record<string, string> = {};
    const secrets: Record<string, { configured: boolean }> = {};
    for (const key of MANAGED_RUNTIME_KEYS) {
      const value = process.env[key]?.trim() || "";
      if (SECRET_KEYS.has(key)) secrets[key] = { configured: Boolean(value) };
      else values[key] = value;
    }
    return { enabled: this.enabled, path: this.filePath, values, secrets };
  }

  private apply(): void {
    for (const [key, value] of Object.entries(this.values)) process.env[key] = value;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(this.values, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
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
