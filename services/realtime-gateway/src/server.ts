import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import {
  InMemorySpeakerIdentityStore,
  KeyringPostgresSpeakerIdentityStore,
  PrivacyAwareSpeakerIdentityStore,
  type SpeakerIdentityStore,
} from "@aipany/audio-intelligence";
import {
  clientControlEventSchema,
  type InteractionMode,
  type SessionStartEvent,
} from "@aipany/protocol";
import { handleAdminConfigHttp } from "./admin/admin-config-http.js";
import { RuntimeApiConfigStore } from "./admin/runtime-api-config-store.js";
import { authenticateRequest, requireScope, type AuthContext } from "./auth.js";
import { loadConfig, type AppConfig } from "./config.js";
import {
  defaultVoiceForModel,
  getClientExperienceModeOptions,
  getClientNativeModelOptions,
  getClientVoiceOptions,
} from "./mobile/client-capabilities.js";
import { createMobilePreviewIdentity, issueMobilePreviewJwt } from "./mobile/mobile-preview.js";
import { NativeVoicePreviewService } from "./mobile/native-voice-preview.js";
import { resolveExperienceDefinition } from "./mobile/realtime-experience.js";
import {
  RealtimeObservabilityStore,
  type RealtimeEngine,
  type SessionObservability,
} from "./observability/realtime-observability.js";
import { LowLatencyRealtimeSession } from "./session/low-latency-realtime-session.js";
import { QwenOmniLiveSession } from "./session/qwen-omni-live-session.js";

interface GatewaySession {
  readonly id: string;
  start(event: SessionStartEvent): Promise<void>;
  appendAudio(audio: Buffer): void;
  commitAudio(): void;
  cancelResponse(): void;
  setInteractionMode(mode: InteractionMode, source: "manual" | "voice_command" | "auto"): void;
  respondToModeSuggestion(suggestionId: string, accepted: boolean): void;
  setSpeakerConsent(granted: boolean): Promise<void>;
  revokeSpeakerConsent(deleteExisting: boolean): Promise<void>;
  sendSpeakerConsentStatus(): Promise<void>;
  listSpeakerIdentities(): Promise<void>;
  startSpeakerEnrollment(input: { personName: string; relation?: string; isOwner?: boolean }): Promise<void>;
  cancelSpeakerEnrollment(enrollmentId: string): void;
  deleteSpeakerIdentity(personId: string): Promise<void>;
  close(): void;
}

export function createGatewayServer(
  config: AppConfig,
  runtimeApiConfigStore = new RuntimeApiConfigStore({
    filePath: process.env.AIPANY_RUNTIME_CONFIG_PATH,
    adminToken: process.env.AIPANY_ADMIN_TOKEN,
  }),
  observability = new RealtimeObservabilityStore({ filePath: config.observability.filePath }),
) {
  const identityStore = createSpeakerIdentityStore(config);
  const authContexts = new WeakMap<IncomingMessage, AuthContext>();
  const mobilePreviewRequests = new Map<string, number[]>();
  const voicePreviewRequests = new Map<string, number[]>();
  const voicePreviewService = new NativeVoicePreviewService();
  const httpServer = createServer(async (request, response) => {
    try {
      if (await handleAdminConfigHttp(request, response, runtimeApiConfigStore, observability)) return;
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

      if (request.method === "GET" && url.pathname === "/v1/mobile/capabilities") {
        const runtimeConfig = loadConfig();
        const selectedEngine = resolveRealtimeEngine(runtimeConfig);
        respondJson(response, 200, {
          version: "0.5.0",
          previewEnabled: runtimeConfig.server.mobilePreview.enabled,
          websocketPath: "/v1/realtime",
          realtimeEngine: selectedEngine,
          nativeLiveAvailable: isNativeLiveAvailable(runtimeConfig),
          defaults: {
            experienceMode: "native_plus",
            outputVoice: selectedEngine === "omni_realtime"
              ? runtimeConfig.qwenOmniRealtime.voice
              : runtimeConfig.qwen.ttsVoice,
            interactionMode: "auto",
            socialProactivity: 0.45,
            assistantAliases: ["Aipany", "小派"],
          },
          voices: getClientVoiceOptions(
            selectedEngine === "omni_realtime" ? runtimeConfig.qwenOmniRealtime.model : runtimeConfig.qwen.ttsModel,
            selectedEngine === "omni_realtime" ? runtimeConfig.qwenOmniRealtime.voice : runtimeConfig.qwen.ttsVoice,
          ),
          experienceModes: getClientExperienceModeOptions(runtimeConfig),
          nativeModels: getClientNativeModelOptions(),
          interactionModes: ["auto", "owner_focus", "group"],
          features: {
            localEndpointCommit: selectedEngine === "cascaded",
            nativeTurnDetection: selectedEngine === "omni_realtime",
            bargeIn: true,
            realtimeTranscript: true,
            perSessionVoice: true,
            perSessionExperienceMode: true,
            nativeVoicePreview: true,
            socialProactivity: true,
            automaticReconnect: true,
            clientTelemetry: true,
          },
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/mobile/bootstrap") {
        const runtimeConfig = loadConfig();
        if (!runtimeConfig.server.mobilePreview.enabled) {
          observability.record({ level: "warn", category: "auth", event: "mobile.bootstrap.disabled" });
          respondJson(response, 403, { error: "mobile_preview_disabled" });
          return;
        }
        const jwtSecret = runtimeConfig.server.auth.jwtSecret;
        if (!jwtSecret) {
          observability.record({ level: "error", category: "auth", event: "mobile.bootstrap.jwt_missing" });
          respondJson(response, 503, { error: "mobile_preview_requires_jwt" });
          return;
        }
        if (!allowRateLimitedRequest(request, mobilePreviewRequests, 30)) {
          observability.record({ level: "warn", category: "auth", event: "mobile.bootstrap.rate_limited" });
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

      if (request.method === "POST" && url.pathname === "/v1/mobile/voice-preview") {
        const runtimeConfig = loadConfig();
        const authContext = authenticateRequest(request, url, runtimeConfig.server.auth);
        if (!authContext) {
          respondJson(response, 401, { error: "unauthorized" });
          return;
        }
        try {
          requireScope(authContext, "realtime");
        } catch (error) {
          respondJson(response, 403, { error: "forbidden", message: formatError(error) });
          return;
        }
        if (!allowRateLimitedRequest(request, voicePreviewRequests, 24)) {
          respondJson(response, 429, { error: "voice_preview_rate_limited" });
          return;
        }
        const body = await readJsonBody(request);
        const model = typeof body.model === "string" ? body.model.trim() : "";
        const voice = typeof body.voice === "string" ? body.voice.trim() : "";
        try {
          const startedAt = Date.now();
          const audio = await voicePreviewService.render({
            apiKey: runtimeConfig.qwenOmniRealtime.apiKey,
            workspaceId: runtimeConfig.qwenOmniRealtime.workspaceId,
            baseUrl: runtimeConfig.qwenOmniRealtime.baseUrl,
            model,
            voice,
          });
          observability.record({
            level: "info",
            category: "mobile",
            event: "voice_preview.generated",
            data: { model, voice, bytes: audio.length, durationMs: Date.now() - startedAt },
          });
          response.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Cache-Control": "private, max-age=1800",
            "X-Aipany-Audio-Encoding": "pcm_s16le",
            "X-Aipany-Audio-Sample-Rate": "24000",
            "X-Aipany-Audio-Channels": "1",
          });
          response.end(audio);
        } catch (error) {
          observability.record({
            level: "warn",
            category: "mobile",
            event: "voice_preview.failed",
            data: { model, voice, message: formatError(error) },
          });
          respondJson(response, 400, { error: "voice_preview_failed", message: formatError(error) });
        }
        return;
      }

      if (request.method === "GET" && url.pathname === "/health") {
        const snapshot = runtimeApiConfigStore.snapshot();
        const runtimeConfig = loadConfig();
        const enabledLlmProviders = snapshot.llmProviderPool.providers.filter((provider) =>
          provider.enabled && provider.apiKeyConfigured && provider.models.some((model) => model.enabled),
        );
        respondJson(response, 200, {
          ok: true,
          service: "aipany-realtime-gateway",
          version: "0.5.0",
          speakerIdentityStore: config.speakerIdentity.store,
          audioFrontEnd: config.audioFrontEnd.enabled,
          mobilePreview: config.server.mobilePreview.enabled,
          realtimeEngine: resolveRealtimeEngine(runtimeConfig),
          nativeLiveAvailable: isNativeLiveAvailable(runtimeConfig),
          observability: true,
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
      observability.record({
        level: "error",
        category: "http",
        event: "http.request.error",
        data: { message: error instanceof Error ? error.message : String(error), path: request.url ?? "" },
      });
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
      observability.record({
        level: "warn",
        category: "auth",
        event: "websocket.auth.rejected",
        data: { remoteAddress: request.socket.remoteAddress ?? "" },
      });
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    authContexts.set(request, authContext);

    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });

  wss.on("connection", (ws, request) => {
    const connectionId = randomUUID();
    const authContext = authContexts.get(request) ?? {
      authenticated: false,
      legacy: false,
      scopes: new Set(["*"]),
    };
    let session: GatewaySession | undefined;
    let telemetry: SessionObservability | undefined;
    let initialized = false;
    let sessionStarting = false;

    instrumentOutgoingWebSocket(ws, () => telemetry);
    observability.record({
      level: "info",
      category: "connection",
      event: "websocket.connected",
      connectionId,
      data: {
        remoteAddress: request.socket.remoteAddress ?? "",
        userAgent: request.headers["user-agent"] ?? "",
      },
    });

    ws.on("message", (raw, isBinary) => {
      if (isBinary) {
        if (!initialized || !session) {
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
        case "session.start": {
          if (initialized || sessionStarting) {
            sendError(ws, "SESSION_ALREADY_STARTED", "当前连接已经启动会话");
            return;
          }
          sessionStarting = true;
          let sessionConfig: AppConfig;
          try {
            sessionConfig = loadConfig();
          } catch (error) {
            sendError(ws, "RUNTIME_CONFIG_INVALID", error instanceof Error ? error.message : String(error));
            ws.close(1011, "runtime config invalid");
            return;
          }

          const experience = resolveExperienceDefinition(sessionConfig, event.session.experienceMode);
          const nativeAvailable = isNativeLiveAvailable(sessionConfig);
          const requestedEngine = experience?.engine ?? resolveRealtimeEngine(sessionConfig);
          const initialEngine = requestedEngine === "omni_realtime" && !nativeAvailable ? "cascaded" : requestedEngine;
          const nativeModel = initialEngine === "omni_realtime" ? experience?.model : undefined;
          const nativeTurnDetection = initialEngine === "omni_realtime" ? experience?.recommendedTurnDetection : undefined;
          const allowFallback = Boolean(experience) || sessionConfig.server.realtimeEngine === "auto";

          telemetry = observability.beginSession({
            sessionId: connectionId,
            connectionId,
            engine: initialEngine,
            tenantId: event.session.tenantId,
            userId: event.session.userId,
            deviceId: event.session.device.deviceId,
            deviceType: event.session.device.deviceType,
            platform: event.session.device.platform,
            appVersion: event.session.device.appVersion,
            remoteAddress: request.socket.remoteAddress,
            userAgent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : undefined,
          });
          telemetry.event("engine.selected", {
            requested: sessionConfig.server.realtimeEngine,
            requestedExperience: event.session.experienceMode ?? "legacy_default",
            selected: initialEngine,
            selectedModel: nativeModel ?? (initialEngine === "cascaded" ? sessionConfig.qwen.ttsModel : sessionConfig.qwenOmniRealtime.model),
            nativeLiveAvailable: nativeAvailable,
            fallbackBeforeStart: requestedEngine !== initialEngine,
          }, "info", "engine");

          void startGatewaySession({
            ws,
            event,
            config: sessionConfig,
            identityStore,
            authContext,
            initialEngine,
            nativeModel,
            nativeTurnDetection,
            allowFallback,
            telemetry,
          }).then((started) => {
            session = started.session;
            telemetry!.report.engine = started.engine;
            initialized = true;
            sessionStarting = false;
          }).catch((error) => {
            sessionStarting = false;
            telemetry?.event("session.start.error", { message: formatError(error) }, "error", "session");
            sendError(ws, "SESSION_START_FAILED", formatError(error));
            ws.close(1011, "session start failed");
          });
          break;
        }
        case "input_audio_buffer.commit":
          session?.commitAudio();
          break;
        case "response.cancel":
          session?.cancelResponse();
          break;
        case "mode.set":
          session?.setInteractionMode(event.mode, "manual");
          break;
        case "mode.suggestion.respond":
          session?.respondToModeSuggestion(event.suggestionId, event.accepted);
          break;
        case "client.telemetry":
          telemetry?.event(`client.${event.name}`, {
            valueMs: event.valueMs,
            ...(event.details ? { details: event.details } : {}),
          }, "info", "client");
          break;
        case "speaker.consent.grant":
          void session?.setSpeakerConsent(true).catch((error) => {
            sendError(ws, "SPEAKER_CONSENT_FAILED", formatError(error));
          });
          break;
        case "speaker.consent.revoke":
          void session?.revokeSpeakerConsent(event.deleteExisting).catch((error) => {
            sendError(ws, "SPEAKER_CONSENT_FAILED", formatError(error));
          });
          break;
        case "speaker.consent.status":
          void session?.sendSpeakerConsentStatus().catch((error) => {
            sendError(ws, "SPEAKER_CONSENT_FAILED", formatError(error));
          });
          break;
        case "speaker.enrollment.start":
          void session?.startSpeakerEnrollment({
            personName: event.personName,
            relation: event.relation,
            isOwner: event.isOwner,
          }).catch((error) => {
            sendError(ws, "SPEAKER_ENROLLMENT_FAILED", formatError(error));
          });
          break;
        case "speaker.enrollment.cancel":
          session?.cancelSpeakerEnrollment(event.enrollmentId);
          break;
        case "speaker.identity.list":
          void session?.listSpeakerIdentities().catch((error) => {
            sendError(ws, "SPEAKER_IDENTITY_LIST_FAILED", formatError(error));
          });
          break;
        case "speaker.identity.delete":
          void session?.deleteSpeakerIdentity(event.personId).catch((error) => {
            sendError(ws, "SPEAKER_IDENTITY_DELETE_FAILED", formatError(error));
          });
          break;
        case "session.finish":
          session?.close();
          ws.close(1000, "session finished");
          break;
        case "ping":
          ws.send(JSON.stringify({ type: "pong", timestamp: event.timestamp ?? Date.now() }));
          break;
      }
    });

    ws.on("close", (code, reason) => {
      session?.close();
      telemetry?.end(code, reason.toString());
      if (!telemetry) {
        observability.record({
          level: code === 1000 ? "info" : "warn",
          category: "connection",
          event: "websocket.closed.before_session",
          connectionId,
          data: { code, reason: reason.toString() },
        });
      }
    });
    ws.on("error", (error) => {
      telemetry?.event("websocket.error", { message: error.message }, "error", "connection");
      if (!telemetry) {
        observability.record({
          level: "error",
          category: "connection",
          event: "websocket.error.before_session",
          connectionId,
          data: { message: error.message },
        });
      }
      session?.close();
    });
  });

  httpServer.on("close", () => {
    void identityStore.close?.();
  });

  return httpServer;
}

export function resolveRealtimeEngine(config: AppConfig): RealtimeEngine {
  if (config.server.realtimeEngine === "cascaded") return "cascaded";
  if (config.server.realtimeEngine === "omni_realtime") return "omni_realtime";
  return isNativeLiveAvailable(config) ? "omni_realtime" : "cascaded";
}

export function isNativeLiveAvailable(config: AppConfig): boolean {
  return config.qwenOmniRealtime.enabled && Boolean(config.qwenOmniRealtime.apiKey.trim());
}

async function startGatewaySession(input: {
  ws: WebSocket;
  event: SessionStartEvent;
  config: AppConfig;
  identityStore: SpeakerIdentityStore;
  authContext: AuthContext;
  initialEngine: RealtimeEngine;
  nativeModel?: string;
  nativeTurnDetection?: "server_vad" | "smart_turn" | "semantic_vad";
  allowFallback: boolean;
  telemetry: SessionObservability;
}): Promise<{ session: GatewaySession; engine: RealtimeEngine }> {
  if (input.initialEngine === "omni_realtime") {
    const model = input.nativeModel ?? input.config.qwenOmniRealtime.model;
    const nativeConfig = {
      ...input.config,
      qwenOmniRealtime: {
        ...input.config.qwenOmniRealtime,
        model,
        voice: defaultVoiceForModel(model),
        turnDetection: input.nativeTurnDetection ?? input.config.qwenOmniRealtime.turnDetection,
      },
    } as AppConfig;
    const live = new QwenOmniLiveSession(input.ws, nativeConfig, input.authContext, input.telemetry);
    try {
      await live.start(input.event);
      return { session: live, engine: "omni_realtime" };
    } catch (error) {
      live.close();
      if (!input.allowFallback) throw error;
      input.telemetry.event("engine.fallback", {
        from: "omni_realtime",
        to: "cascaded",
        model,
        reason: formatError(error),
      }, "warn", "engine");
    }
  }

  const cascaded = new LowLatencyRealtimeSession(input.ws, input.config, input.identityStore, input.authContext);
  await cascaded.start(input.event);
  return { session: cascaded, engine: "cascaded" };
}

function instrumentOutgoingWebSocket(ws: WebSocket, getTelemetry: () => SessionObservability | undefined): void {
  const originalSend = ws.send.bind(ws) as (...args: unknown[]) => boolean;
  let activeResponseId: string | undefined;
  const firstTextSeen = new Set<string>();
  const firstAudioSeen = new Set<string>();

  (ws as unknown as { send: (...args: unknown[]) => boolean }).send = (...args: unknown[]): boolean => {
    const data = args[0];
    const telemetry = getTelemetry();
    if (telemetry) {
      if (typeof data === "string") {
        try {
          const event = JSON.parse(data) as Record<string, unknown>;
          const type = typeof event.type === "string" ? event.type : "";
          if (type === "session.created") {
            telemetry.event("session.created", { clientSessionId: event.sessionId }, "info", "session");
          } else if (type === "session.ready") {
            telemetry.event("session.ready", {}, "info", "session");
          } else if (type === "input_audio_buffer.speech_started") {
            telemetry.event("speech.started", {}, "info", "audio");
          } else if (type === "input_audio_buffer.speech_stopped") {
            telemetry.event("speech.stopped", {}, "info", "audio");
          } else if (type === "transcript.final") {
            const text = typeof event.text === "string" ? event.text : "";
            telemetry.event("transcript.final", { textChars: text.length }, "info", "asr");
          } else if (type === "response.created") {
            activeResponseId = typeof event.responseId === "string" ? event.responseId : undefined;
            if (activeResponseId) {
              firstTextSeen.delete(activeResponseId);
              firstAudioSeen.delete(activeResponseId);
            }
            telemetry.event("response.created", { responseId: activeResponseId }, "info", "pipeline");
          } else if (type === "response.text.delta" && activeResponseId && !firstTextSeen.has(activeResponseId)) {
            firstTextSeen.add(activeResponseId);
            telemetry.event("response.first_text", { responseId: activeResponseId }, "info", "pipeline");
          } else if (type === "response.interrupted") {
            telemetry.event("response.interrupted", {
              responseId: event.responseId,
              reason: event.reason,
            }, "info", "pipeline");
            if (event.responseId === activeResponseId) activeResponseId = undefined;
          } else if (type === "response.done") {
            telemetry.event("response.done", { responseId: event.responseId }, "info", "pipeline");
            if (event.responseId === activeResponseId) activeResponseId = undefined;
          } else if (type === "error") {
            const code = typeof event.code === "string" ? event.code : "UNKNOWN";
            telemetry.event("pipeline.error", {
              code,
              message: typeof event.message === "string" ? event.message : "",
              retryable: event.retryable,
            }, "error", errorCategory(code));
          }
        } catch {
          // Non-JSON text frames are ignored by observability.
        }
      } else if (Buffer.isBuffer(data) && activeResponseId && !firstAudioSeen.has(activeResponseId)) {
        firstAudioSeen.add(activeResponseId);
        telemetry.event("response.first_audio", { responseId: activeResponseId, bytes: data.length }, "info", "audio");
      }
    }
    return originalSend(...args);
  };
}

function errorCategory(code: string): string {
  if (code.startsWith("ASR")) return "asr";
  if (code.startsWith("TTS")) return "tts";
  if (code.startsWith("LLM") || code.startsWith("PIPELINE")) return "llm";
  if (code.startsWith("OMNI")) return "omni";
  if (code.startsWith("SPEAKER")) return "speaker";
  return "realtime";
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

function allowRateLimitedRequest(request: IncomingMessage, state: Map<string, number[]>, limit: number): boolean {
  const forwarded = request.headers["x-forwarded-for"];
  const ip = (typeof forwarded === "string" ? forwarded.split(",")[0]?.trim() : undefined)
    ?? request.socket.remoteAddress
    ?? "unknown";
  const now = Date.now();
  const cutoff = now - 60 * 60 * 1000;
  const recent = (state.get(ip) ?? []).filter((timestamp) => timestamp >= cutoff);
  if (recent.length >= limit) {
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

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
