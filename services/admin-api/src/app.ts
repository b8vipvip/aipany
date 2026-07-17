import Fastify from "fastify";

import type { AdminApiConfig } from "./config.js";
import { registerProviderRoutes } from "./modules/providers/provider-config.controller.js";
import type { ProviderConfigService } from "./modules/providers/provider-config.service.js";

export function buildApp(
  config: Pick<AdminApiConfig, "ADMIN_API_TOKEN" | "NODE_ENV">,
  providers: ProviderConfigService,
) {
  const app = Fastify({ logger: true });

  app.get("/health", async () => ({ ok: true, service: "admin-api" }));

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/v1/admin") || !config.ADMIN_API_TOKEN) {
      return;
    }

    if (request.headers.authorization !== `Bearer ${config.ADMIN_API_TOKEN}`) {
      await reply.code(401).send({
        error: {
          code: "UNAUTHORIZED",
          message: "缺少或错误的 Admin Bearer Token",
        },
      });
    }
  });

  registerProviderRoutes(app, providers);

  app.setErrorHandler((error, request, reply) => {
    request.log.warn({ message: error.message }, "Admin API 请求失败");
    return reply.code(400).send({
      error: {
        code: "BAD_REQUEST",
        message: error.message,
      },
    });
  });

  return app;
}
