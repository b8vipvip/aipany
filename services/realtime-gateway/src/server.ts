import { createServer, type IncomingMessage } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { clientControlEventSchema } from "@aipany/protocol";
import type { AppConfig } from "./config.js";
import { RealtimeSession } from "./session/realtime-session.js";

export function createGatewayServer(config: AppConfig) {
  const httpServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && url.pathname === "/health") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: true, service: "aipany-realtime-gateway", version: "0.2.0" }));
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "not_found" }));
  });

  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname !== "/v1/realtime") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    if (!authorized(request, url, config.server.token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });

  wss.on("connection", (ws) => {
    const session = new RealtimeSession(ws, config);
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
        case "speaker.enrollment.start":
          session.startSpeakerEnrollment({
            personName: event.personName,
            relation: event.relation,
            isOwner: event.isOwner,
          });
          break;
        case "speaker.enrollment.cancel":
          session.cancelSpeakerEnrollment(event.enrollmentId);
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

  return httpServer;
}

function authorized(request: IncomingMessage, url: URL, expectedToken?: string): boolean {
  if (!expectedToken) return true;
  const auth = request.headers.authorization;
  if (auth === `Bearer ${expectedToken}`) return true;
  return url.searchParams.get("token") === expectedToken;
}

function sendError(ws: WebSocket, code: string, message: string): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "error", code, message, retryable: false }));
}
