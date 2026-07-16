import { resolve } from "node:path";

import { config as loadDotEnv } from "dotenv";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { OpenAIRealtimeProvider } from "./providers/openai-realtime-provider.js";
import { VoiceSessionService } from "./service.js";

// pnpm / Turborepo 通常会在当前 package 目录执行脚本，因此同时尝试当前目录和仓库根目录。
loadDotEnv({ path: resolve(process.cwd(), ".env") });
loadDotEnv({ path: resolve(process.cwd(), "../../.env"), override: false });

async function main(): Promise<void> {
  const config = loadConfig();

  const provider = new OpenAIRealtimeProvider({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    voice: config.voice,
    eagerness: "low",
  });

  const service = new VoiceSessionService(provider);
  const app = buildApp({ service, logger: true });

  await app.listen({
    host: config.host,
    port: config.port,
  });
}

main().catch((error: unknown) => {
  // 启动失败时立即退出，避免服务处于看似在线但实际不可用的状态。
  console.error("Voice Session 服务启动失败", error);
  process.exit(1);
});