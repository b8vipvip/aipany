import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { OpenAIRealtimeProvider } from "./providers/openai-realtime-provider.js";
import { VoiceSessionService } from "./service.js";

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