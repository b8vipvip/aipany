import { createServer, type IncomingMessage } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import {
  InMemorySpeakerIdentityStore,
  KeyringPostgresSpeakerIdentityStore,
  PrivacyAwareSpeakerIdentityStore,
  type SpeakerIdentityStore,
} from "@aipany/audio-intelligence";
import { clientControlEventSchema } from "@aipany/protocol";
import { handleAdminConfigHttp } from "./admin/admin-config-http.js";
import { RuntimeApiConfigStore } from "./admin/runtime-api-config-store.js";
import { authenticateRequest, type AuthContext } from "./auth.js";
import { loadConfig, type AppConfig } from "./config.js";
import { getClientVoiceOptions } from "./mobile/client-capabilities.js";
import { createMobilePreviewIdentity, issueMobilePreviewJwt } from "./mobile/mobile-preview.js";
import { LowLatencyRealtimeSession } from "./session/low-latency-realtime-session.js";

export function createGatewayServer(
  config: AppConfig,
  runtimeApiConfigStore = new RuntimeApiConfigStore({
    filePath: process.env.AIPANY_RUNTIME_CONFIG_PATH,
    adminToken: process.env.AIPANY_ADMIN_TOKEN,
  }),
) {
  const identityStore = createSpeakerIdentityStore(config);
  const authContexts = new WeakMap<IncomingMessage, AuthContext>();
  const mobilePreviewRequests = new Map<string, number[]>();
  const httpServer = createServer(async (request, response) => {
    try {
      if (await handleAdminConfigHttp(request, response, runtimeApiConfigStore)) return;
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

      if (request.method === "GET" && url.pathname === "/v1/mobile/capabilities") {
        const runtimeConfig = loadConfig();
        respondJson(response, 200, {
          version: "0.4.7",
          previewEnabled: runtimeConfig.server.mobilePreview.enabled,
          websocketPath: "/v1/realtime",
          defaults: {
            outputVoice: runtimeConfig.qwen.ttsVoice,
            interactionMode: "auto",
            socialProactivity: 0.45,
            assistantAliases: ["Aipany", "小派"],
          },
          voices: getClientVoiceOptions(runtimeConfig.qwen.ttsModel, runtimeConfig.qwen.ttsVoice),
          interactionModes: ["auto", "owner_focus", "group"],
          features: {
            localEndpointCommit: true,
            bargeIn: true,
            realtimeTranscript: true,
            perSessionVoice: true,
            socialProactivity: true,
          },
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/mobile/bootstrap") {
        const runtimeConfig = loadConfig();
        if (!runtimeConfig.server.mobilePreview.enabled) {
          respondJson(response, 403, { error: "mobile_preview_disabled" });
          return;
        }
        const jwtSecret = runtimeConfig.server.auth.jwtSecret;
        if (!jwtSecret) {
          respondJson(response, 503, { error: "mobile_preview_requires_jwt" });
          return;
        }
        if (!allowMobilePreviewRequest(request, mobilePreviewRequests)) {
          respondJson(response, 429, { error: "rate_limited" });
          return;
        }
        const body = await readJsonBody(request);
        const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : "";
        if (deviceId.length < 8 || deviceId.length > 160) {
          respondJson(response, 400, { error: "invalid_device_id" });
          return;
        }
        const identity = createMobilePreviewIdentity(deviceId, runtimeConfig.server.mobilePreview.tenantId);
        const issued = issueMobilePreviewJwt(identity, {
          jwtSecret,
          jwtIssuer: runtimeConfig.server.auth.jwtIssuer,
          jwtAudience: runtimeConfig.server.auth.jwtAudience,
          ttlSeconds: runtimeConfig.server.mobilePreview.ttlSeconds,
          tenantId: identity.tenantId,
        });
        respondJson(response, 200, {
          token: issued.token,
          expiresAt: issued.expiresAt,
          tenantId: identity.tenantId,
          userId: identity.userId,
          websocketPath: "/v1/realtime",
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/health") {
        const snapshot = runtimeApiConfigStore.snapshot();
        const enabledLlmProviders = snapshot.llmProviderPool.providers.filter((provider) =>
          provider.enabled && provider.apiKeyConfigured && provider.models.some((model) => model.enabled),
        );
        respondJson(response, 200, {
          ok: true,
          service: "aipany-realtime-gateway",
          version: "0.4.7",
          speakerIdentityStore: config.speakerIdentity.store,
          audioFrontEnd: config.audioFrontEnd.enabled,
          mobilePreview: config.server.mobilePreview.enabled,
          runtimeApiConfig: {
            enabled: snapshot.enabled,
            dashscopeConfigured: Boolean(snapshot.secrets.DASHSCOPE_API_KEY?.configured),
            llmConfigured: enabledLlmProviders.length > 0,
            llmProviderCount: enabledLlmProviders.length,
          },
          auth: config.server.auth.jwtSecret ? "jwt" : config.server.auth.legacyToken ? "legacy_token" : "development_open",
        });
        return;
      }
      respondJson(response, 404, { error: "not_found" });
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      respondJson(response, 500, { error: "internal_error", message: error instanceof Error ? error.message : String(error) });
    }
  });

  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname !== "/v1/realtime") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    const authContext = authenticateRequest(request, url, config.server.auth);
    if (!authContext) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    authContexts.set(request, authContext);

    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });

  wss.on("connection", (ws, request) => {
    const authContext = authContexts.get(request) ?? {
      authenticated: false,
      legacy: false,
      scopes: new Set(["*"]),
    };
    let sessionConfig: AppConfig;
    try {
      sessionConfig = loadConfig();
    } catch (error) {
      sendError(ws, "RUNTIME_CONFIG_INVALID", error instanceof Error ? error.message : String(error));
      ws.close(1011, "runtime config invalid");
      return;
    }
    const session = new LowLatencyRealtimeSession(ws, sessionConfig, identityStore, authContext);
    let initialized = false;

    ws.on("message", (raw, isBinary) => {
      if (isBinary) {
        if (!initialized) {
          sendError(ws, "SESSION_NOT_STARTED", "请先发送 session.start 事件");
          return;
        }
        session.appendAudio(Buffer.from(raw as Buffer));
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(raw.toString());
      } catch {
        sendError(ws, "INVALID_JSON", "控制事件必须是合法 JSON");
        return;
      }

      const parsed = clientControlEventSchema.safeParse(payload);
      if (!parsed.success) {
        sendError(ws, "INVALID_EVENT", parsed.error.issues.map((issue) => issue.message).join("; "));
        return;
      }

      const event = parsed.data;
      switch (event.type) {
        case "session.start":
          if (initialized) {
            sendError(ws, "SESSION_ALREADY_STARTED", "当前连接已经启动会话");
            return;
          }
          initialized = true;
          void session.start(event).catch((error) => {
            sendError(ws, "SESSION_START_FAILED", error instanceof Error ? error.message : String(error));
            ws.close(1011, "session start failed");
          });
          break;
        case "input_audio_buffer.commit":
          session.commitAudio();
          break;
        case "response.cancel":
          session.cancelResponse();
          break;
        case "mode.set":
          session.setInteractionMode(event.mode, "manual");
          break;
        case "mode.suggestion.respond":
          session.respondToModeSuggestion(event.suggestionId, event.accepted);
          break;
        case "speaker.consent.grant":
          void session.setSpeakerConsent(true).catch((error) => {
            sendError(ws, "SPEAKER_CONSENT_FAILED", error instanceof Error ? error.message : String(error));
          });
          break;
        case "speaker.consent.revoke":
          void session.revokeSpeakerConsent(event.deleteExisting).catch((error) => {
            sendError(ws, "SPEAKER_CONSENT_FAILED", error instanceof Error ? error.message : String(error));
          });
          break;
        case "speaker.consent.status":
          void session.sendSpeakerConsentStatus().catch((error) => {
            sendError(ws, "SPEAKER_CONSENT_FAILED", error instanceof Error ? error.message : String(error));
          });
          break;
        case "speaker.enrollment.start":
          void session.startSpeakerEnrollment({
            personName: event.personName,
            relation: event.relation,
            isOwner: event.isOwner,
          }).catch((error) => {
            sendError(ws, "SPEAKER_ENROLLMENT_FAILED", error instanceof Error ? error.message : String(error));
          });
          break;
        case "speaker.enrollment.cancel":
          session.cancelSpeakerEnrollment(event.enrollmentId);
          break;
        case "speaker.identity.list":
          void session.listSpeakerIdentities().catch((error) => {
            sendError(ws, "SPEAKER_IDENTITY_LIST_FAILED", error instanceof Error ? error.message : String(error));
          });
          break;
        case "speaker.identity.delete":
          void session.deleteSpeakerIdentity(event.personId).catch((error) => {
            sendError(ws, "SPEAKER_IDENTITY_DELETE_FAILED", error instanceof Error ? error.message : String(error));
          });
          break;
        case "session.finish":
          session.close();
          ws.close(1000, "session finished");
          break;
        case "ping":
          ws.send(JSON.stringify({ type: "pong", timestamp: event.timestamp ?? Date.now() }));
          break;
      }
    });

    ws.on("close", () => session.close());
    ws.on("error", () => session.close());
  });

  httpServer.on("close", () => {
    void identityStore.close?.();
  });

  return httpServer;
}

function createSpeakerIdentityStore(config: AppConfig): SpeakerIdentityStore {
  if (config.speakerIdentity.store === "memory") {
    return new InMemorySpeakerIdentityStore();
  }

  const connectionString = config.speakerIdentity.connectionString;
  const encryptionKey = config.speakerIdentity.encryptionKey;
  if (!connectionString || !encryptionKey) {
    throw new Error("PostgreSQL Speaker Identity Store 缺少 DATABASE_URL 或 SPEAKER_IDENTITY_ENCRYPTION_KEY");
  }

  const delegate = new KeyringPostgresSpeakerIdentityStore({
    connectionString,
    encryptionKey,
    ssl: config.speakerIdentity.databaseSsl,
    maxPoolSize: config.speakerIdentity.poolMax,
    matchCandidateCount: config.speakerIdentity.matchCandidates,
  });
  return new PrivacyAwareSpeakerIdentityStore({
    delegate,
    connectionString,
    ssl: config.speakerIdentity.databaseSsl,
    maxPoolSize: Math.max(2, Math.min(8, config.speakerIdentity.poolMax)),
  });
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 16_384) throw new Error("request body too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid json body");
  return parsed as Record<string, unknown>;
}

function allowMobilePreviewRequest(request: IncomingMessage, state: Map<string, number[]>): boolean {
  const forwarded = request.headers["x-forwarded-for"];
  const ip = (typeof forwarded === "string" ? forwarded.split(",")[0]?.trim() : undefined)
    ?? request.socket.remoteAddress
    ?? "unknown";
  const now = Date.now();
  const cutoff = now - 60 * 60 * 1000;
  const recent = (state.get(ip) ?? []).filter((timestamp) => timestamp >= cutoff);
  if (recent.length >= 30) {
    state.set(ip, recent);
    return false;
  }
  recent.push(now);
  state.set(ip, recent);
  return true;
}

function respondJson(response: import("node:http").ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(payload));
}

function sendError(ws: WebSocket, code: string, message: string): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "error", code, message, retryable: false }));
}
