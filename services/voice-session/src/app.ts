import Fastify from "fastify";
import { z } from "zod";

import { VoiceSessionError } from "./errors.js";
import { VoiceSessionService } from "./service.js";

const deviceCapabilitySchema = z.enum([
  "audio_input",
  "audio_output",
  "screen",
  "camera",
  "location",
  "led",
  "motor",
  "button",
  "battery",
  "ota",
]);

const createSessionSchema = z.object({
  userId: z.string().min(1),
  agentId: z.string().min(1),
  device: z.object({
    deviceId: z.string().min(1),
    productId: z.string().min(1),
    deviceType: z.enum(["mobile", "web", "embedded", "speaker", "robot", "unknown"]),
    platform: z.string().min(1),
    appVersion: z.string().optional(),
    firmwareVersion: z.string().optional(),
    capabilities: z.array(deviceCapabilitySchema),
  }),
  locale: z.string().optional(),
  timezone: z.string().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});

export interface BuildAppOptions {
  service: VoiceSessionService;
  logger?: boolean;
}

export function buildApp(options: BuildAppOptions) {
  const app = Fastify({ logger: options.logger ?? false });

  app.get("/health", async () => ({
    ok: true,
    service: "voice-session",
  }));

  app.post("/v1/voice/sessions", async (request, reply) => {
    const parsed = createSessionSchema.safeParse(request.body);

    if (!parsed.success) {
      throw new VoiceSessionError(
        "INVALID_REQUEST",
        "创建语音会话的请求参数无效",
        400,
        {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      );
    }

    const session = await options.service.createSession(parsed.data);

    // 日志只记录平台标识，不记录临时凭证或请求中的敏感字段。
    request.log.info(
      {
        sessionId: session.sessionId,
        deviceId: session.context.deviceId,
        provider: session.provider,
      },
      "实时语音会话已创建",
    );

    return reply.code(201).send(session);
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof VoiceSessionError) {
      request.log.warn(
        {
          code: error.code,
          statusCode: error.statusCode,
          details: error.details,
        },
        error.message,
      );

      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      });
    }

    request.log.error({ error }, "Voice Session 服务发生未处理异常");

    return reply.code(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "服务器暂时无法创建实时语音会话",
      },
    });
  });

  return app;
}