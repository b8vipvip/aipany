import { RuntimeApiConfigStore } from "./admin/runtime-api-config-store.js";
import { loadConfig } from "./config.js";
import { createGatewayServer } from "./server.js";

const runtimeApiConfigStore = new RuntimeApiConfigStore({
  filePath: process.env.AIPANY_RUNTIME_CONFIG_PATH,
  adminToken: process.env.AIPANY_ADMIN_TOKEN,
});
await runtimeApiConfigStore.loadAndApply();

const config = loadConfig();
const server = createGatewayServer(config, runtimeApiConfigStore);

server.listen(config.server.port, config.server.host, () => {
  console.log(`[aipany] Realtime Gateway listening on http://${config.server.host}:${config.server.port}`);
  console.log("[aipany] WebSocket endpoint: /v1/realtime");
  console.log("[aipany] Admin config page: /admin/config");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
