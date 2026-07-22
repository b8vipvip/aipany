import { RuntimeApiConfigStore } from "./admin/runtime-api-config-store.js";
import { loadConfig } from "./config.js";
import { setGlobalRealtimeObservabilityStore } from "./observability/global-observability.js";
import { getNativeLiveCapabilityDiagnostic } from "./observability/native-live-diagnostics.js";
import { RealtimeObservabilityStore } from "./observability/realtime-observability.js";
import { createGatewayServer } from "./server.js";

const runtimeApiConfigStore = new RuntimeApiConfigStore({
  filePath: process.env.AIPANY_RUNTIME_CONFIG_PATH,
  adminToken: process.env.AIPANY_ADMIN_TOKEN,
});
await runtimeApiConfigStore.loadAndApply();

const config = loadConfig();
const observability = new RealtimeObservabilityStore({ filePath: config.observability.filePath });
await observability.load();
setGlobalRealtimeObservabilityStore(observability);

let lastNativeLiveCapabilitySignature = "";
function recordNativeLiveCapability(reason: "startup" | "config_changed"): void {
  const runtimeConfig = loadConfig();
  const diagnostic = getNativeLiveCapabilityDiagnostic(runtimeConfig);
  const signature = JSON.stringify(diagnostic);
  if (signature === lastNativeLiveCapabilitySignature) return;
  lastNativeLiveCapabilitySignature = signature;
  observability.record({
    level: diagnostic.status === "ready" ? "info" : "warn",
    category: "engine",
    event: "native_live.capability",
    data: {
      ...diagnostic,
      reason,
    },
  });
}

recordNativeLiveCapability("startup");
const nativeLiveCapabilityTimer = setInterval(() => {
  try {
    recordNativeLiveCapability("config_changed");
  } catch (error) {
    observability.record({
      level: "error",
      category: "engine",
      event: "native_live.capability.error",
      data: { message: error instanceof Error ? error.message : String(error) },
    });
  }
}, 30_000);
nativeLiveCapabilityTimer.unref?.();

const server = createGatewayServer(config, runtimeApiConfigStore, observability);

server.listen(config.server.port, config.server.host, () => {
  console.log(`[aipany] Realtime Gateway listening on http://${config.server.host}:${config.server.port}`);
  console.log("[aipany] WebSocket endpoint: /v1/realtime");
  console.log("[aipany] Operations console: /admin");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    clearInterval(nativeLiveCapabilityTimer);
    setGlobalRealtimeObservabilityStore(undefined);
    server.close(() => process.exit(0));
  });
}
