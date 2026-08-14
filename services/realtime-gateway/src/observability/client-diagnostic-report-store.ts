import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ClientDiagnosticReportSummary {
  id: string;
  receivedAtMs: number;
  generatedAtMs: number;
  generatedAt: string;
  appVersion: string;
  versionCode: number;
  manufacturer: string;
  model: string;
  androidSdk: number;
  diagnosisLayer: string;
  severity: string;
  confidence: number;
  title: string;
  sizeBytes: number;
}

const REPORT_SCHEMA = "aipany-live-diagnostics-v1";
const MAX_REPORT_BYTES = 256 * 1024;
const DEFAULT_MAX_REPORTS = 100;
const REPORT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ClientDiagnosticReportStore {
  readonly directory: string;
  private readonly maxReports: number;

  constructor(options: { directory?: string; maxReports?: number } = {}) {
    this.directory = options.directory?.trim() || process.env.AIPANY_CLIENT_DIAGNOSTICS_DIR?.trim() || "/data/client-diagnostics";
    this.maxReports = Math.max(10, Math.min(500, options.maxReports ?? DEFAULT_MAX_REPORTS));
  }

  async save(input: unknown): Promise<ClientDiagnosticReportSummary> {
    const report = sanitizeDiagnosticReport(input);
    const content = `${JSON.stringify(report, null, 2)}\n`;
    const sizeBytes = Buffer.byteLength(content, "utf8");
    if (sizeBytes > MAX_REPORT_BYTES) throw new Error("客户端诊断报告超过 256 KiB 限制");

    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const filePath = this.pathFor(id);
    await writeFile(filePath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const receivedAtMs = (await stat(filePath)).mtimeMs;
    await this.prune();
    return summarize(id, receivedAtMs, report, sizeBytes);
  }

  async list(limit = 50): Promise<ClientDiagnosticReportSummary[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.directory, { withFileTypes: true });
    const candidates = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && REPORT_ID.test(entry.name.slice(0, -5)))
      .map((entry) => ({ id: entry.name.slice(0, -5), path: join(this.directory, entry.name) }));

    const loaded = await Promise.all(candidates.map(async (candidate) => {
      try {
        const [metadata, content] = await Promise.all([stat(candidate.path), readFile(candidate.path, "utf8")]);
        const parsed = JSON.parse(content) as unknown;
        const report = sanitizeDiagnosticReport(parsed);
        return summarize(candidate.id, metadata.mtimeMs, report, Buffer.byteLength(content, "utf8"));
      } catch {
        return undefined;
      }
    }));

    return loaded
      .filter((item): item is ClientDiagnosticReportSummary => Boolean(item))
      .sort((a, b) => b.receivedAtMs - a.receivedAtMs)
      .slice(0, Math.max(1, Math.min(200, Math.round(limit))));
  }

  async read(id: string): Promise<Record<string, unknown>> {
    const cleanId = normalizeId(id);
    const content = await readFile(this.pathFor(cleanId), "utf8");
    return sanitizeDiagnosticReport(JSON.parse(content) as unknown);
  }

  private async prune(): Promise<void> {
    const entries = await readdir(this.directory, { withFileTypes: true });
    const files = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && REPORT_ID.test(entry.name.slice(0, -5)))
      .map(async (entry) => {
        const path = join(this.directory, entry.name);
        try {
          return { path, mtimeMs: (await stat(path)).mtimeMs };
        } catch {
          return undefined;
        }
      }));
    const stale = files
      .filter((item): item is { path: string; mtimeMs: number } => Boolean(item))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(this.maxReports);
    await Promise.all(stale.map((item) => unlink(item.path).catch(() => undefined)));
  }

  private pathFor(id: string): string {
    return join(this.directory, `${normalizeId(id)}.json`);
  }
}

export const clientDiagnosticReportStore = new ClientDiagnosticReportStore();

export function sanitizeDiagnosticReport(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("客户端诊断报告必须是 JSON 对象");
  const source = input as Record<string, unknown>;
  if (source.schema !== REPORT_SCHEMA) throw new Error(`客户端诊断报告 schema 必须是 ${REPORT_SCHEMA}`);
  const sanitized = sanitizeValue(source, 0);
  if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) throw new Error("客户端诊断报告格式无效");
  return sanitized as Record<string, unknown>;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > 12) return "<max-depth>";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return redactString(value).slice(0, 4_000);
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => sanitizeValue(item, depth + 1));
  if (typeof value !== "object") return undefined;

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>).slice(0, 300)) {
    if (isSensitiveKey(key)) continue;
    const sanitized = sanitizeValue(nested, depth + 1);
    if (sanitized !== undefined) output[key.slice(0, 120)] = sanitized;
  }
  return output;
}

function isSensitiveKey(key: string): boolean {
  const compact = key.trim().toLowerCase().replace(/[-_]/g, "");
  if (["authorization", "apikey", "token", "accesstoken", "refreshtoken", "secret", "password", "deviceid", "jwt"].includes(compact)) return true;
  return /(?:apikey|token|secret|password|deviceid)$/.test(compact) && !compact.endsWith("included");
}

function redactString(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1<redacted>")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, "$1<redacted>")
    .replace(/([?&](?:token|api_key|apikey|key|secret)=)[^&\s]+/gi, "$1<redacted>")
    .replace(/https?:\/\/[^\s\"']+/gi, "<redacted-url>")
    .replace(/wss?:\/\/[^\s\"']+/gi, "<redacted-url>");
}

function summarize(
  id: string,
  receivedAtMs: number,
  report: Record<string, unknown>,
  sizeBytes: number,
): ClientDiagnosticReportSummary {
  const app = objectValue(report.app);
  const device = objectValue(report.device);
  const diagnosis = objectValue(report.diagnosis);
  return {
    id,
    receivedAtMs: Math.round(receivedAtMs),
    generatedAtMs: numberValue(report.generatedAtMs),
    generatedAt: stringValue(report.generatedAt),
    appVersion: stringValue(app.version),
    versionCode: numberValue(app.versionCode),
    manufacturer: stringValue(device.manufacturer),
    model: stringValue(device.model),
    androidSdk: numberValue(device.androidSdk),
    diagnosisLayer: stringValue(diagnosis.layer),
    severity: stringValue(diagnosis.severity),
    confidence: numberValue(diagnosis.confidence),
    title: stringValue(diagnosis.title),
    sizeBytes,
  };
}

function normalizeId(value: string): string {
  const clean = value.trim();
  if (!REPORT_ID.test(clean)) throw new Error("诊断报告 ID 无效");
  return clean;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 500) : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
