import { z } from "zod";

const envSchema = z.object({
  ADMIN_API_HOST: z.string().default("0.0.0.0"),
  ADMIN_API_PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  DATABASE_URL: z.string().min(1),
  AIPANY_CONFIG_ENCRYPTION_KEY: z.string().min(32),
  ADMIN_API_TOKEN: z.string().optional(),
  NODE_ENV: z.string().default("development"),
});

export type AdminApiConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AdminApiConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => issue.message).join("；");
    throw new Error(`Admin API 配置无效：${message}`);
  }

  return parsed.data;
}
