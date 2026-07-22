import type { IncomingMessage, ServerResponse } from "node:http";
import { ADMIN_CONFIG_PAGE } from "./admin-config-page.js";
import { ADMIN_FAILOVER_UI } from "./admin-failover-ui.js";
import { ADMIN_OBSERVABILITY_UI } from "./admin-observability-ui.js";
import { ADMIN_OPERATIONS_UI } from "./admin-operations-ui.js";
import { decryptConfigBackup, encryptConfigBackup } from "./config-backup.js";
import { runAdminE2eTest } from "./e2e-test-runner.js";
import { benchmarkRelayProvider } from "./relay-model-tester.js";
import { RuntimeApiConfigStore } from "./runtime-api-config-store.js";
import { GitHubObservabilitySync } from "../observability/github-observability-sync.js";
import type { RealtimeObservabilityStore } from "../observability/realtime-observability.js";
import { OperationsControlStore } from "../operations/operations-control-store.js";
import {
  getLlmRoutingSnapshot,
  llmProtocolSchema,
  resetLlmRoutingState,
  testLlmRoute,
} from "../providers/llm-provider-pool.js";

const operationsControlStore = new OperationsControlStore();

export async function handleAdminConfigHttp(
  request: IncomingMessage,
  response: ServerResponse,
  store: RuntimeApiConfigStore,
  observability?: RealtimeObservabilityStore,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  await operationsControlStore.load();

  if (request.method === "GET" && (url.pathname === "/admin" || url.pathname === "/admin/")) {
    response.writeHead(302, { Location: "/admin/config/quality", "Cache-Control": "no-store" });
    response.end();
    return true;
  }

  if (request.method === "GET" && url.pathname === "/admin/failover-ui.js") {
    response.writeHead(200, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(ADMIN_FAILOVER_UI);
    return true;
  }

  if (request.method === "GET" && url.pathname === "/admin/observability-ui.js") {
    response.writeHead(200, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(ADMIN_OBSERVABILITY_UI);
    return true;
  }

  if (request.method === "GET" && url.pathname === "/admin/operations-ui.js") {
    response.writeHead(200, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(ADMIN_OPERATIONS_UI);
    return true;
  }

  if (request.method === "GET" && (url.pathname === "/admin/config" || url.pathname.startsWith("/admin/config/"))) {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
    });
    response.end(ADMIN_CONFIG_PAGE.replace(
      "</body>",
      '<script src="/admin/failover-ui.js"></script><script src="/admin/observability-ui.js"></script><script src="/admin/operations-ui.js"></script></body>',
    ));
    return true;
  }

  const isConfigApi = url.pathname.startsWith("/admin/api/config");
  const isObservabilityApi = url.pathname.startsWith("/admin/api/observability");
  const isOperationsApi = url.pathname.startsWith("/admin/api/operations");
  if (!isConfigApi && !isObservabilityApi && !isOperationsApi) return false;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");

  if (request.method === "GET" && url.pathname === "/admin/api/operations/auth-status") {
    const snapshot = await operationsControlStore.snapshot();
    response.writeHead(200);
    response.end(JSON.stringify(snapshot.adminAccess));
    return true;
  }

  const token = readBearerToken(request.headers.authorization);
  const passwordEnabled = await operationsControlStore.isPasswordEnabled();
  const authorized = !passwordEnabled
    || store.authenticate(token)
    || await operationsControlStore.verifyPassword(token);
  if (!authorized) {
    response.writeHead(401, { "WWW-Authenticate": "Bearer" });
    response.end(JSON.stringify({ error: "unauthorized" }));
    return true;
  }

  if (isOperationsApi) {
    if (request.method === "GET" && url.pathname === "/admin/api/operations") {
      response.writeHead(200);
      response.end(JSON.stringify(await operationsControlStore.snapshot()));
      return true;
    }

    if (request.method === "PUT" && url.pathname === "/admin/api/operations/admin-access") {
      try {
        const payload = await readJsonBody(request, 64 * 1024);
        const result = await operationsControlStore.updateAdminAccess(payload);
        response.writeHead(200);
        response.end(JSON.stringify(result));
      } catch (error) {
        response.writeHead(400);
        response.end(JSON.stringify({ error: "admin_access_update_failed", message: formatError(error) }));
      }
      return true;
    }

    if (request.method === "PUT" && url.pathname === "/admin/api/operations/github-sync") {
      try {
        const payload = await readJsonBody(request, 64 * 1024);
        const result = await operationsControlStore.updateObservabilityGitHub(payload);
        response.writeHead(200);
        response.end(JSON.stringify(result));
      } catch (error) {
        response.writeHead(400);
        response.end(JSON.stringify({ error: "github_sync_update_failed", message: formatError(error) }));
      }
      return true;
    }

    if (request.method === "POST" && url.pathname === "/admin/api/operations/github-sync/test") {
      try {
        const sync = new GitHubObservabilitySync();
        const result = await sync.testConnection(await operationsControlStore.getObservabilityGitHubConfig());
        response.writeHead(200);
        response.end(JSON.stringify(result));
      } catch (error) {
        response.writeHead(502);
        response.end(JSON.stringify({ error: "github_sync_test_failed", message: formatError(error) }));
      }
      return true;
    }

    response.writeHead(405, { Allow: "GET, PUT, POST" });
    response.end(JSON.stringify({ error: "method_not_allowed" }));
    return true;
  }

  if (isObservabilityApi) {
    if (!observability) {
      response.writeHead(503);
      response.end(JSON.stringify({ error: "observability_unavailable" }));
      return true;
    }

    if (request.method === "GET" && url.pathname === "/admin/api/observability/overview") {
      response.writeHead(200);
      response.end(JSON.stringify(observability.overview()));
      return true;
    }

    if (request.method === "GET" && url.pathname === "/admin/api/observability/sessions") {
      const limit = parseLimit(url.searchParams.get("limit"), 100, 500);
      response.writeHead(200);
      response.end(JSON.stringify({ sessions: observability.listSessions(limit) }));
      return true;
    }

    if (request.method === "GET" && url.pathname === "/admin/api/observability/events") {
      const limit = parseLimit(url.searchParams.get("limit"), 200, 1000);
      response.writeHead(200);
      response.end(JSON.stringify({
        events: observability.listEvents({
          limit,
          level: url.searchParams.get("level") || undefined,
          category: url.searchParams.get("category") || undefined,
          sessionId: url.searchParams.get("sessionId") || undefined,
          query: url.searchParams.get("q") || undefined,
        }),
      }));
      return true;
    }

    if (request.method === "GET" && url.pathname === "/admin/api/observability/export") {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      response.writeHead(200, {
        "Content-Disposition": `attachment; filename="aipany-observability-${stamp}.json"`,
      });
      response.end(JSON.stringify({
        exportedAt: Date.now(),
        overview: observability.overview(),
        sessions: observability.listSessions(500),
        events: observability.listEvents({ limit: 1000 }),
      }, null, 2));
      return true;
    }

    response.writeHead(405, { Allow: "GET" });
    response.end(JSON.stringify({ error: "method_not_allowed" }));
    return true;
  }

  if (request.method === "GET" && url.pathname === "/admin/api/config") {
    response.writeHead(200);
    response.end(JSON.stringify(store.snapshot()));
    return true;
  }

  if (request.method === "GET" && url.pathname === "/admin/api/config/llm-routing") {
    response.writeHead(200);
    response.end(JSON.stringify(getLlmRoutingSnapshot(store.getLlmProviderPool(), 20)));
    return true;
  }

  if (request.method === "PUT" && url.pathname === "/admin/api/config") {
    try {
      const payload = await readJsonBody(request, 512 * 1024);
      const result = await store.update(payload);
      if (payload.llmProviderPool !== undefined) resetLlmRoutingState();
      response.writeHead(200);
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(400);
      response.end(JSON.stringify({ error: "invalid_config", message: formatError(error) }));
    }
    return true;
  }

  if (request.method === "POST" && url.pathname === "/admin/api/config/llm-test") {
    try {
      const payload = await readJsonBody(request, 64 * 1024);
      const providerId = requireString(payload.providerId, "providerId");
      const modelId = requireString(payload.modelId, "modelId");
      const protocol = llmProtocolSchema.parse(payload.protocol);
      const pool = store.getLlmProviderPool();
      const provider = pool.providers.find((item) => item.id === providerId);
      if (!provider) throw new Error(`未找到 LLM Provider：${providerId}`);
      const model = provider.models.find((item) => item.id === modelId);
      if (!model) throw new Error(`未找到模型：${modelId}`);
      if (!model.protocols.includes(protocol)) throw new Error(`模型 ${modelId} 未启用协议 ${protocol}`);
      const result = await testLlmRoute({
        provider,
        model,
        protocol,
        firstTokenTimeoutMs: provider.firstTokenTimeoutMs ?? pool.firstTokenTimeoutMs,
        totalTimeoutMs: provider.totalTimeoutMs ?? pool.totalTimeoutMs,
      });
      response.writeHead(200);
      response.end(JSON.stringify({ ok: true, ...result }));
    } catch (error) {
      response.writeHead(400);
      response.end(JSON.stringify({ error: "llm_test_failed", message: formatError(error) }));
    }
    return true;
  }

  if (request.method === "POST" && url.pathname === "/admin/api/config/relay-test") {
    try {
      const payload = await readJsonBody(request, 64 * 1024);
      const providerIds = requireStringArray(payload.providerIds, "providerIds");
      const pool = store.getLlmProviderPool();
      const providers = pool.providers.map((provider) => ({
        ...provider,
        models: provider.models.map((model) => ({ ...model, protocols: [...model.protocols] })),
      }));
      const results: Array<Record<string, unknown>> = [];

      for (const providerId of providerIds) {
        const provider = providers.find((item) => item.id === providerId);
        if (!provider) {
          results.push({ providerId, ok: false, error: `未找到 LLM Provider：${providerId}` });
          continue;
        }
        try {
          const benchmark = await benchmarkRelayProvider(provider, {
            firstTokenTimeoutMs: Math.min(provider.firstTokenTimeoutMs ?? pool.firstTokenTimeoutMs, 15000),
            totalTimeoutMs: Math.min(provider.totalTimeoutMs ?? pool.totalTimeoutMs, 30000),
            concurrency: 3,
          });
          if (benchmark.eligibleModels.length) {
            provider.baseUrl = benchmark.testedBaseUrl;
            provider.models = benchmark.eligibleModels;
          }
          results.push({
            ok: benchmark.eligibleModels.length > 0,
            ...benchmark,
            error: benchmark.eligibleModels.length ? undefined : "没有模型同时通过 Responses API 与 Chat Completions",
          });
        } catch (error) {
          results.push({ providerId, providerName: provider.name, ok: false, error: formatError(error) });
        }
      }

      const updated = await store.update({ llmProviderPool: { ...pool, providers } });
      resetLlmRoutingState();
      response.writeHead(200);
      response.end(JSON.stringify({ ok: results.some((item) => item.ok === true), results, config: updated }));
    } catch (error) {
      response.writeHead(400);
      response.end(JSON.stringify({ error: "relay_test_failed", message: formatError(error) }));
    }
    return true;
  }

  if (request.method === "POST" && url.pathname === "/admin/api/config/e2e-test") {
    try {
      const result = await runAdminE2eTest();
      response.writeHead(result.ok ? 200 : 502);
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(502);
      response.end(JSON.stringify({ error: "e2e_test_failed", message: formatError(error) }));
    }
    return true;
  }

  if (request.method === "POST" && url.pathname === "/admin/api/config/export") {
    try {
      const payload = await readJsonBody(request, 64 * 1024);
      const passphrase = requireString(payload.passphrase, "passphrase");
      const backup = encryptConfigBackup(store.exportDocument(), passphrase);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      response.writeHead(200);
      response.end(JSON.stringify({ ok: true, filename: `aipany-config-backup-${stamp}.json`, backup }));
    } catch (error) {
      response.writeHead(400);
      response.end(JSON.stringify({ error: "config_export_failed", message: formatError(error) }));
    }
    return true;
  }

  if (request.method === "POST" && url.pathname === "/admin/api/config/import") {
    try {
      const payload = await readJsonBody(request, 2 * 1024 * 1024);
      const passphrase = requireString(payload.passphrase, "passphrase");
      const document = decryptConfigBackup(payload.backup, passphrase);
      const result = await store.replaceDocument(document);
      resetLlmRoutingState();
      response.writeHead(200);
      response.end(JSON.stringify({ ok: true, config: result }));
    } catch (error) {
      response.writeHead(400);
      response.end(JSON.stringify({ error: "config_import_failed", message: formatError(error) }));
    }
    return true;
  }

  response.writeHead(405, { Allow: "GET, PUT, POST" });
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

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} 不能为空`);
  return value.trim();
}

function requireStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${name} 必须是数组`);
  const output = value
    .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    .map((item) => item.trim());
  if (!output.length) throw new Error(`请至少选择一个${name === "providerIds" ? "中转站" : name}`);
  return [...new Set(output)];
}

function parseLimit(raw: string | null, fallback: number, maximum: number): number {
  const value = raw ? Number(raw) : fallback;
  return Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.round(value))) : fallback;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
