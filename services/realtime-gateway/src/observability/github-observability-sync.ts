import { createHash, randomUUID } from "node:crypto";
import {
  readObservabilityGitHubSyncConfig,
  type ObservabilityGitHubSyncConfig,
} from "../operations/operations-control-store.js";

export interface SyncableObservabilityEvent {
  timestamp: number;
  level: string;
  category: string;
  event: string;
  sessionId?: string;
  engine?: string;
  data?: Record<string, unknown>;
}

interface SanitizedObservabilityEvent {
  timestamp: number;
  level: string;
  category: string;
  event: string;
  sessionHash?: string;
  engine?: string;
  data?: Record<string, unknown>;
}

type FetchLike = typeof fetch;

const SAFE_STRING_KEYS = new Set([
  "reason",
  "message",
  "requested",
  "selected",
  "model",
  "providerId",
  "providerName",
  "protocol",
  "status",
  "networkType",
  "appVersion",
  "deviceType",
  "platform",
  "closeReason",
  "errorType",
  "fallbackReason",
]);

const SENSITIVE_KEY = /(transcript|text|content|prompt|answer|response|audio|authorization|api.?key|token|secret|password|tenant|user.?id|device.?id|remote.?address|user.?agent|cookie)/i;

export class GitHubObservabilitySync {
  private readonly configPath?: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly buffer: SanitizedObservabilityEvent[] = [];
  private timer?: NodeJS.Timeout;
  private scheduling?: Promise<void>;
  private flushPromise?: Promise<void>;
  private verifiedRepository?: { key: string; checkedAt: number; isPrivate: boolean };

  constructor(options: { configPath?: string; fetchImpl?: FetchLike; now?: () => number } = {}) {
    this.configPath = options.configPath;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  enqueue(event: SyncableObservabilityEvent): void {
    this.buffer.push(sanitizeEvent(event));
    if (this.buffer.length > 2000) this.buffer.splice(0, this.buffer.length - 2000);
    if (!this.timer && !this.scheduling) {
      this.scheduling = this.scheduleFromCurrentConfig().finally(() => {
        this.scheduling = undefined;
      });
    }
  }

  async flushNow(): Promise<void> {
    if (this.flushPromise) return this.flushPromise;
    this.flushPromise = this.flush().finally(() => {
      this.flushPromise = undefined;
    });
    return this.flushPromise;
  }

  async testConnection(config?: ObservabilityGitHubSyncConfig): Promise<{ ok: true; private: boolean; repository: string; branch: string }> {
    const resolved = config ?? await readObservabilityGitHubSyncConfig(this.configPath);
    validateEnabledConfig(resolved, false);
    const metadata = await this.fetchRepository(resolved);
    if (!metadata.isPrivate && !resolved.allowPublicRepository) {
      throw new Error("目标 GitHub 仓库是公开仓库。请改用私有仓库，或显式开启“允许同步到公开仓库”。");
    }
    return { ok: true, private: metadata.isPrivate, repository: resolved.repository, branch: resolved.branch };
  }

  private async scheduleFromCurrentConfig(): Promise<void> {
    const config = await readObservabilityGitHubSyncConfig(this.configPath);
    if (!config.enabled) {
      this.buffer.length = 0;
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flushNow();
    }, config.batchSeconds * 1000);
    this.timer.unref?.();
  }

  private async flush(): Promise<void> {
    const config = await readObservabilityGitHubSyncConfig(this.configPath);
    if (!config.enabled) {
      this.buffer.length = 0;
      return;
    }
    validateEnabledConfig(config, true);
    if (!this.buffer.length) return;

    await this.ensureRepositoryAllowed(config);
    const events = this.buffer.splice(0, Math.min(this.buffer.length, 1000));
    const generatedAt = this.now();
    const stamp = new Date(generatedAt).toISOString().replace(/[:.]/g, "-");
    const day = new Date(generatedAt).toISOString().slice(0, 10);
    const filePath = `${trimSlashes(config.path)}/${day}/${stamp}-${randomUUID()}.json`;
    const payload = {
      schemaVersion: 1,
      generatedAt,
      source: {
        service: "aipany-realtime-gateway",
        version: "0.5.0",
      },
      privacy: {
        conversationContentIncluded: false,
        directIdentifiersIncluded: false,
        sessionIdsHashed: true,
      },
      events,
    };

    try {
      const response = await this.fetchImpl(
        `https://api.github.com/repos/${encodeRepository(config.repository)}/contents/${filePath.split("/").map(encodeURIComponent).join("/")}`,
        {
          method: "PUT",
          headers: githubHeaders(config.token),
          body: JSON.stringify({
            message: `ops: upload sanitized observability batch ${stamp}`,
            branch: config.branch,
            content: Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8").toString("base64"),
          }),
        },
      );
      if (!response.ok) throw new Error(`GitHub observability upload failed: HTTP ${response.status} ${truncate(await response.text(), 500)}`);
    } catch (error) {
      this.buffer.unshift(...events);
      if (this.buffer.length > 2000) this.buffer.splice(2000);
      throw error;
    } finally {
      if (this.buffer.length) await this.scheduleFromCurrentConfig();
    }
  }

  private async ensureRepositoryAllowed(config: ObservabilityGitHubSyncConfig): Promise<void> {
    const key = `${config.repository}|${config.token.slice(-8)}`;
    const cached = this.verifiedRepository;
    if (cached && cached.key === key && this.now() - cached.checkedAt < 10 * 60 * 1000) {
      if (!cached.isPrivate && !config.allowPublicRepository) {
        throw new Error("目标 GitHub 仓库是公开仓库，已阻止自动上传生产诊断日志");
      }
      return;
    }
    const metadata = await this.fetchRepository(config);
    this.verifiedRepository = { key, checkedAt: this.now(), isPrivate: metadata.isPrivate };
    if (!metadata.isPrivate && !config.allowPublicRepository) {
      throw new Error("目标 GitHub 仓库是公开仓库，已阻止自动上传生产诊断日志");
    }
  }

  private async fetchRepository(config: ObservabilityGitHubSyncConfig): Promise<{ isPrivate: boolean }> {
    if (!config.token) throw new Error("GitHub Token 未配置");
    const response = await this.fetchImpl(`https://api.github.com/repos/${encodeRepository(config.repository)}`, {
      headers: githubHeaders(config.token),
    });
    if (!response.ok) throw new Error(`GitHub repository check failed: HTTP ${response.status} ${truncate(await response.text(), 500)}`);
    const payload = await response.json() as { private?: unknown };
    return { isPrivate: payload.private === true };
  }
}

export function sanitizeObservabilityEvent(event: SyncableObservabilityEvent): SanitizedObservabilityEvent {
  return sanitizeEvent(event);
}

function sanitizeEvent(event: SyncableObservabilityEvent): SanitizedObservabilityEvent {
  const data = sanitizeRecord(event.data ?? {});
  return {
    timestamp: event.timestamp,
    level: truncate(event.level, 32),
    category: truncate(event.category, 64),
    event: truncate(event.event, 120),
    sessionHash: event.sessionId ? createHash("sha256").update(event.sessionId).digest("hex").slice(0, 16) : undefined,
    engine: event.engine ? truncate(event.engine, 64) : undefined,
    data: Object.keys(data).length ? data : undefined,
  };
}

function sanitizeRecord(input: Record<string, unknown>, depth = 0): Record<string, unknown> {
  if (depth > 3) return {};
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SENSITIVE_KEY.test(key)) continue;
    if (value === null || typeof value === "boolean") {
      output[key] = value;
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      output[key] = value;
      continue;
    }
    if (typeof value === "string") {
      if (SAFE_STRING_KEYS.has(key)) output[key] = redactSecrets(truncate(value, 300));
      continue;
    }
    if (Array.isArray(value)) {
      const safe = value.slice(0, 20).flatMap((item) => {
        if (typeof item === "number" && Number.isFinite(item)) return [item];
        if (typeof item === "boolean") return [item];
        if (item && typeof item === "object" && !Array.isArray(item)) return [sanitizeRecord(item as Record<string, unknown>, depth + 1)];
        return [];
      });
      if (safe.length) output[key] = safe;
      continue;
    }
    if (value && typeof value === "object") {
      const nested = sanitizeRecord(value as Record<string, unknown>, depth + 1);
      if (Object.keys(nested).length) output[key] = nested;
    }
  }
  return output;
}

function redactSecrets(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
    .replace(/((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}

function validateEnabledConfig(config: ObservabilityGitHubSyncConfig, requireEnabled: boolean): void {
  if (requireEnabled && !config.enabled) throw new Error("GitHub 日志同步未开启");
  if (!config.repository || !config.branch || !config.path || !config.token) throw new Error("GitHub 日志同步配置不完整");
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "Aipany-Observability-Sync",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function encodeRepository(repository: string): string {
  return repository.split("/").map(encodeURIComponent).join("/");
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
