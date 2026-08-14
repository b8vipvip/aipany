import type { IncomingMessage, ServerResponse } from "node:http";
import { authenticateRequest, requireScope } from "../auth.js";
import { loadConfig } from "../config.js";
import { clientDiagnosticReportStore } from "../observability/client-diagnostic-report-store.js";
import type { RealtimeObservabilityStore } from "../observability/realtime-observability.js";

const MAX_BODY_BYTES = 256 * 1024;
const uploadRequests = new Map<string, number[]>();

export async function handleMobileDiagnosticReportHttp(
  request: IncomingMessage,
  response: ServerResponse,
  observability?: RealtimeObservabilityStore,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (url.pathname !== "/v1/mobile/diagnostics") return false;

  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  if (request.method !== "POST") {
    response.writeHead(405, { Allow: "POST" });
    response.end(JSON.stringify({ error: "method_not_allowed" }));
    return true;
  }

  const runtimeConfig = loadConfig();
  const authContext = authenticateRequest(request, url, runtimeConfig.server.auth);
  if (!authContext) {
    response.writeHead(401);
    response.end(JSON.stringify({ error: "unauthorized" }));
    return true;
  }
  try {
    requireScope(authContext, "realtime");
  } catch (error) {
    response.writeHead(403);
    response.end(JSON.stringify({ error: "forbidden", message: formatError(error) }));
    return true;
  }

  if (!allowRateLimitedRequest(request, 30)) {
    response.writeHead(429);
    response.end(JSON.stringify({ error: "client_diagnostics_rate_limited" }));
    return true;
  }

  try {
    const report = await readJsonBody(request, MAX_BODY_BYTES);
    const summary = await clientDiagnosticReportStore.save(report);
    observability?.record({
      level: summary.severity === "error" ? "warn" : "info",
      category: "client-diagnostics",
      event: "client_diagnostics.uploaded",
      data: {
        reportId: summary.id,
        appVersion: summary.appVersion,
        diagnosisLayer: summary.diagnosisLayer,
        severity: summary.severity,
        confidence: summary.confidence,
        sizeBytes: summary.sizeBytes,
      },
    });
    response.writeHead(201);
    response.end(JSON.stringify({
      ok: true,
      id: summary.id,
      receivedAtMs: summary.receivedAtMs,
    }));
  } catch (error) {
    observability?.record({
      level: "warn",
      category: "client-diagnostics",
      event: "client_diagnostics.rejected",
      data: { message: formatError(error).slice(0, 240) },
    });
    response.writeHead(400);
    response.end(JSON.stringify({ error: "invalid_client_diagnostics", message: formatError(error) }));
  }
  return true;
}

async function readJsonBody(request: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error("客户端诊断报告请求体过大");
    chunks.push(buffer);
  }
  if (!chunks.length) throw new Error("客户端诊断报告不能为空");
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("客户端诊断报告必须是 JSON 对象");
  return parsed as Record<string, unknown>;
}

function allowRateLimitedRequest(request: IncomingMessage, limit: number): boolean {
  const forwarded = request.headers["x-forwarded-for"];
  const ip = (typeof forwarded === "string" ? forwarded.split(",")[0]?.trim() : undefined)
    ?? request.socket.remoteAddress
    ?? "unknown";
  const now = Date.now();
  const cutoff = now - 60 * 60 * 1000;
  const recent = (uploadRequests.get(ip) ?? []).filter((timestamp) => timestamp >= cutoff);
  if (recent.length >= limit) {
    uploadRequests.set(ip, recent);
    return false;
  }
  recent.push(now);
  uploadRequests.set(ip, recent);
  return true;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
