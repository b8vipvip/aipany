import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { policySchema, providerInputSchema, providerUpdateSchema } from "./provider-config.schema.js";
import type { ProviderConfigService } from "./provider-config.service.js";

const idParamsSchema = z.object({ id: z.string().uuid() });

export function registerProviderRoutes(app: FastifyInstance, service: ProviderConfigService): void {
  app.get("/v1/admin/providers", () => service.list());

  app.post("/v1/admin/providers", async (request, reply) => {
    const provider = await service.create(providerInputSchema.parse(request.body));
    return reply.code(201).send(provider);
  });

  app.get("/v1/admin/providers/:id", (request) => service.get(idParamsSchema.parse(request.params).id));

  app.put("/v1/admin/providers/:id", (request) =>
    service.update(idParamsSchema.parse(request.params).id, providerUpdateSchema.parse(request.body)),
  );

  app.delete("/v1/admin/providers/:id", async (request, reply) => {
    await service.delete(idParamsSchema.parse(request.params).id);
    return reply.code(204).send();
  });

  app.post("/v1/admin/providers/:id/test", (request) => service.test(idParamsSchema.parse(request.params).id));
  app.get("/v1/admin/provider-policy", () => service.getPolicy());
  app.put("/v1/admin/provider-policy", (request) => service.setPolicy(policySchema.parse(request.body)));
}
