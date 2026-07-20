import type { IncomingMessage, ServerResponse } from "node:http";
import { ADMIN_CONFIG_PAGE } from "./admin-config-page.js";
import { RuntimeApiConfigStore } from "./runtime-api-config-store.js";

export async function handleAdminConfigHttp(
  request: IncomingMessage,
  response: ServerResponse,
  store: RuntimeApiConfigStore,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (request.method === "GET" && (url.pathname === "/admin/config" || url.pathname === "/admin/config/")) {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
    });
    response.end(ADMIN_CONFIG_PAGE);
    return true;
  }

  if (!url.pathname.startsWith("/admin/api/config")) return false;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");

  if (!store.enabled) {
    response.writeHead(503);
    response.end(JSON.stringify({ error: "admin_config_disabled", message: "请先在 .env 配置 AIPANY_ADMIN_TOKEN" }));
    return true;
  }

  const token = readBearerToken(request.headers.authorization);
  if (!store.authenticate(token)) {
    response.writeHead(401, { "WWW-Authenticate": "Bearer" });
    response.end(JSON.stringify({ error: "unauthorized" }));
    return true;
  }

  if (request.method === "GET" && url.pathname === "/admin/api/config") {
    response.writeHead(200);
    response.end(JSON.stringify(store.snapshot()));
    return true;
  }

  if (request.method === "PUT" && url.pathname === "/admin/api/config") {
    try {
      const payload = await readJsonBody(request, 256 * 1024);
      const result = await store.update(payload);
      response.writeHead(200);
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(400);
      response.end(JSON.stringify({ error: "invalid_config", message: error instanceof Error ? error.message : String(error) }));
    }
    return true;
  }

  response.writeHead(405, { Allow: "GET, PUT" });
  response.end(JSON.stringify({ error: "method_not_allowed" }));
  return true;
}

function readBearerToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1]?.trim();
}

async function readJsonBody(request: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error("请求体过大");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("请求体必须是 JSON 对象");
  return parsed as Record<string, unknown>;
}
