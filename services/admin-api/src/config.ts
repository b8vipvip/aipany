import { z } from "zod";
const schema=z.object({ADMIN_API_HOST:z.string().default("0.0.0.0"),ADMIN_API_PORT:z.coerce.number().default(3100),DATABASE_URL:z.string().min(1),AIPANY_CONFIG_ENCRYPTION_KEY:z.string().min(32),ADMIN_API_TOKEN:z.string().optional(),NODE_ENV:z.string().default("development")});
export type AdminApiConfig=z.infer<typeof schema>;
export function loadConfig(env:NodeJS.ProcessEnv=process.env):AdminApiConfig{const p=schema.safeParse(env);if(!p.success)throw new Error(`Admin API 配置无效：${p.error.issues.map(i=>i.message).join("；")}`);return p.data;}
