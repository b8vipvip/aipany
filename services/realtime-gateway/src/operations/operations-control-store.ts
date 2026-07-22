import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface AdminAccessConfig {
  passwordEnabled: boolean;
  passwordHash: string;
  passwordSalt: string;
  passwordUpdatedAt?: number;
}

export interface ObservabilityGitHubSyncConfig {
  enabled: boolean;
  repository: string;
  branch: string;
  path: string;
  token: string;
  allowPublicRepository: boolean;
  batchSeconds: number;
}

interface OperationsControlDocument {
  adminAccess: AdminAccessConfig;
  observabilityGitHub: ObservabilityGitHubSyncConfig;
}

export interface OperationsControlSnapshot {
  path: string;
  adminAccess: {
    passwordEnabled: boolean;
    passwordConfigured: boolean;
    passwordUpdatedAt?: number;
  };
  observabilityGitHub: Omit<ObservabilityGitHubSyncConfig, "token"> & {
    tokenConfigured: boolean;
  };
}

const DEFAULT_REPOSITORY = "b8vipvip/aipany";
const DEFAULT_BRANCH = "main";
const DEFAULT_PATH = "ops/observability";

export class OperationsControlStore {
  readonly filePath: string;
  private loaded = false;
  private document: OperationsControlDocument = defaultDocument();

  constructor(options: { filePath?: string } = {}) {
    this.filePath = resolveOperationsControlPath(options.filePath);
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.document = await readOperationsControlDocument(this.filePath);
    this.loaded = true;
  }

  async snapshot(): Promise<OperationsControlSnapshot> {
    await this.load();
    const github = this.document.observabilityGitHub;
    return {
      path: this.filePath,
      adminAccess: {
        passwordEnabled: this.document.adminAccess.passwordEnabled,
        passwordConfigured: Boolean(this.document.adminAccess.passwordHash && this.document.adminAccess.passwordSalt),
        passwordUpdatedAt: this.document.adminAccess.passwordUpdatedAt,
      },
      observabilityGitHub: {
        enabled: github.enabled,
        repository: github.repository,
        branch: github.branch,
        path: github.path,
        allowPublicRepository: github.allowPublicRepository,
        batchSeconds: github.batchSeconds,
        tokenConfigured: Boolean(github.token),
      },
    };
  }

  async isPasswordEnabled(): Promise<boolean> {
    await this.load();
    return this.document.adminAccess.passwordEnabled;
  }

  async verifyPassword(candidate: string | undefined): Promise<boolean> {
    await this.load();
    if (!candidate || !this.document.adminAccess.passwordHash || !this.document.adminAccess.passwordSalt) return false;
    const expected = Buffer.from(this.document.adminAccess.passwordHash, "base64");
    const actual = scryptSync(candidate, Buffer.from(this.document.adminAccess.passwordSalt, "base64"), expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  async updateAdminAccess(input: Record<string, unknown>): Promise<OperationsControlSnapshot> {
    await this.load();
    const current = this.document.adminAccess;
    const enabled = input.passwordEnabled === undefined
      ? current.passwordEnabled
      : requireBoolean(input.passwordEnabled, "passwordEnabled");
    const newPassword = typeof input.newPassword === "string" ? input.newPassword : "";

    let passwordHash = current.passwordHash;
    let passwordSalt = current.passwordSalt;
    let passwordUpdatedAt = current.passwordUpdatedAt;

    if (newPassword) {
      validatePassword(newPassword);
      const salt = randomBytes(16);
      passwordSalt = salt.toString("base64");
      passwordHash = scryptSync(newPassword, salt, 32).toString("base64");
      passwordUpdatedAt = Date.now();
    }

    if (enabled && (!passwordHash || !passwordSalt)) {
      throw new Error("首次开启控制面板密码保护时必须设置新密码");
    }

    this.document = {
      ...this.document,
      adminAccess: {
        passwordEnabled: enabled,
        passwordHash,
        passwordSalt,
        passwordUpdatedAt,
      },
    };
    await this.persist();
    return this.snapshot();
  }

  async updateObservabilityGitHub(input: Record<string, unknown>): Promise<OperationsControlSnapshot> {
    await this.load();
    const current = this.document.observabilityGitHub;
    const next: ObservabilityGitHubSyncConfig = {
      enabled: input.enabled === undefined ? current.enabled : requireBoolean(input.enabled, "enabled"),
      repository: input.repository === undefined ? current.repository : validateRepository(requireString(input.repository, "repository")),
      branch: input.branch === undefined ? current.branch : validateBranch(requireString(input.branch, "branch")),
      path: input.path === undefined ? current.path : validateRepoPath(requireString(input.path, "path")),
      token: current.token,
      allowPublicRepository: input.allowPublicRepository === undefined
        ? current.allowPublicRepository
        : requireBoolean(input.allowPublicRepository, "allowPublicRepository"),
      batchSeconds: input.batchSeconds === undefined
        ? current.batchSeconds
        : validateBatchSeconds(input.batchSeconds),
    };

    if (input.token === null) next.token = "";
    else if (typeof input.token === "string" && input.token.trim()) next.token = input.token.trim();
    else if (input.token !== undefined && typeof input.token !== "string") throw new Error("token 必须是字符串或 null");

    if (next.enabled && !next.token) throw new Error("开启 GitHub 日志同步前必须配置 GitHub Token");

    this.document = { ...this.document, observabilityGitHub: next };
    await this.persist();
    return this.snapshot();
  }

  async getObservabilityGitHubConfig(): Promise<ObservabilityGitHubSyncConfig> {
    await this.load();
    return { ...this.document.observabilityGitHub };
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(this.document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temp, this.filePath);
  }
}

export function resolveOperationsControlPath(value?: string): string {
  return value?.trim()
    || process.env.AIPANY_OPERATIONS_CONTROL_PATH?.trim()
    || "/data/operations-control.json";
}

export async function readObservabilityGitHubSyncConfig(filePath?: string): Promise<ObservabilityGitHubSyncConfig> {
  const document = await readOperationsControlDocument(resolveOperationsControlPath(filePath));
  return { ...document.observabilityGitHub };
}

async function readOperationsControlDocument(filePath: string): Promise<OperationsControlDocument> {
  try {
    const content = await readFile(filePath, "utf8");
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return defaultDocument();
    return normalizeDocument(parsed as Record<string, unknown>);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") {
      return defaultDocument();
    }
    throw error;
  }
}

function normalizeDocument(input: Record<string, unknown>): OperationsControlDocument {
  const defaults = defaultDocument();
  const admin = asRecord(input.adminAccess);
  const github = asRecord(input.observabilityGitHub);
  return {
    adminAccess: {
      passwordEnabled: typeof admin.passwordEnabled === "boolean" ? admin.passwordEnabled : defaults.adminAccess.passwordEnabled,
      passwordHash: typeof admin.passwordHash === "string" ? admin.passwordHash : "",
      passwordSalt: typeof admin.passwordSalt === "string" ? admin.passwordSalt : "",
      passwordUpdatedAt: typeof admin.passwordUpdatedAt === "number" && Number.isFinite(admin.passwordUpdatedAt)
        ? admin.passwordUpdatedAt
        : undefined,
    },
    observabilityGitHub: {
      enabled: typeof github.enabled === "boolean" ? github.enabled : defaults.observabilityGitHub.enabled,
      repository: typeof github.repository === "string" && github.repository.trim()
        ? validateRepository(github.repository.trim())
        : defaults.observabilityGitHub.repository,
      branch: typeof github.branch === "string" && github.branch.trim()
        ? validateBranch(github.branch.trim())
        : defaults.observabilityGitHub.branch,
      path: typeof github.path === "string" && github.path.trim()
        ? validateRepoPath(github.path.trim())
        : defaults.observabilityGitHub.path,
      token: typeof github.token === "string" ? github.token.trim() : "",
      allowPublicRepository: typeof github.allowPublicRepository === "boolean"
        ? github.allowPublicRepository
        : defaults.observabilityGitHub.allowPublicRepository,
      batchSeconds: typeof github.batchSeconds === "number"
        ? validateBatchSeconds(github.batchSeconds)
        : defaults.observabilityGitHub.batchSeconds,
    },
  };
}

function defaultDocument(): OperationsControlDocument {
  return {
    adminAccess: {
      passwordEnabled: false,
      passwordHash: "",
      passwordSalt: "",
    },
    observabilityGitHub: {
      enabled: false,
      repository: DEFAULT_REPOSITORY,
      branch: DEFAULT_BRANCH,
      path: DEFAULT_PATH,
      token: "",
      allowPublicRepository: false,
      batchSeconds: 60,
    },
  };
}

function validatePassword(value: string): void {
  if (value.length < 10 || value.length > 128) throw new Error("控制面板密码长度必须为 10 到 128 个字符");
}

function validateRepository(value: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) throw new Error("repository 必须使用 owner/repo 格式");
  return value;
}

function validateBranch(value: string): string {
  if (!value || value.length > 200 || value.includes("..") || value.startsWith("/") || value.endsWith("/") || /[~^:?*[\\\s]/.test(value)) {
    throw new Error("branch 不是有效的 Git 分支名");
  }
  return value;
}

function validateRepoPath(value: string): string {
  const normalized = value.replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
  if (!normalized || normalized.length > 300 || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("path 不是有效的仓库目录");
  }
  return normalized;
}

function validateBatchSeconds(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number) || number < 30 || number > 3600) throw new Error("batchSeconds 必须是 30 到 3600 的整数");
  return number;
}

function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} 必须是布尔值`);
  return value;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} 不能为空`);
  return value.trim();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
