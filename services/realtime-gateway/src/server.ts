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
  const httpServer = createServer(async (request, response) => {
    try {
      if (await handleAdminConfigHttp(request, response, runtimeApiConfigStore)) return;
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (request.method === "GET" && url.pathname === "/health") {
        const snapshot = runtimeApiConfigStore.snapshot();
        const enabledLlmProviders = snapshot.llmProviderPool.providers.filter((provider) =>
          provider.enabled && provider.apiKeyConfigured && provider.models.some((model) => model.enabled),
        );
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({
          ok: true,
          service: "aipany-realtime-gateway",
          version: "0.4.6",
          speakerIdentityStore: config.speakerIdentity.store,
          audioFrontEnd: config.audioFrontEnd.enabled,
          runtimeApiConfig: {
            enabled: snapshot.enabled,
            dashscopeConfigured: Boolean(snapshot.secrets.DASHSCOPE_API_KEY?.configured),
            llmConfigured: enabledLlmProviders.length > 0,
            llmProviderCount: enabledLlmProviders.length,
          },
          auth: config.server.auth.jwtSecret ? "jwt" : config.server.auth.legacyToken ? "legacy_token" : "development_open",
        }));
        return;
      }
      response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "not_found" }));
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "internal_error", message: error instanceof Error ? error.message : String(error) }));
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

function sendError(ws: WebSocket, code: string, message: string): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "error", code, message, retryable: false }));
}
