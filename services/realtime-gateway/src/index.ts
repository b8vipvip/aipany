import { loadConfig } from "./config.js";
import { createGatewayServer } from "./server.js";

const config = loadConfig();
const server = createGatewayServer(config);

server.listen(config.server.port, config.server.host, () => {
  console.log(`[aipany] Realtime Gateway listening on http://${config.server.host}:${config.server.port}`);
  console.log("[aipany] WebSocket endpoint: /v1/realtime");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
