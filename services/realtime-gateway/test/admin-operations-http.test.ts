import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGatewayServer } from "../src/server.js";
import { RuntimeApiConfigStore } from "../src/admin/runtime-api-config-store.js";
import { loadConfig } from "../src/config.js";
import { RealtimeObservabilityStore } from "../src/observability/realtime-observability.js";

async function listen(server: ReturnType<typeof createGatewayServer>["httpServer"]): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

test("operations auth status is public and admin APIs are directly accessible by default", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aipany-admin-ops-http-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));

  const previousControlPath = process.env.AIPANY_OPERATIONS_CONTROL_PATH;
  process.env.AIPANY_OPERATIONS_CONTROL_PATH = join(directory, "operations-control.json");
  t.after(() => {
    if (previousControlPath === undefined) delete process.env.AIPANY_OPERATIONS_CONTROL_PATH;
    else process.env.AIPANY_OPERATIONS_CONTROL_PATH = previousControlPath;
  });

  const runtimeStore = new RuntimeApiConfigStore({ filePath: join(directory, "runtime.json"), adminToken: "root-admin-token" });
  const observability = new RealtimeObservabilityStore({ filePath: join(directory, "events.jsonl") });
  const gateway = createGatewayServer(loadConfig(), runtimeStore, observability);
  t.after(() => gateway.httpServer.close());
  const base = await listen(gateway.httpServer);

  const statusResponse = await fetch(`${base}/admin/api/operations/auth-status`);
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json() as { passwordEnabled: boolean };
  assert.equal(status.passwordEnabled, false);

  const configResponse = await fetch(`${base}/admin/api/config`);
  assert.equal(configResponse.status, 200);

  const enableResponse = await fetch(`${base}/admin/api/operations/admin-access`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passwordEnabled: true, newPassword: "console-password-123" }),
  });
  assert.equal(enableResponse.status, 200);

  const blockedResponse = await fetch(`${base}/admin/api/config`);
  assert.equal(blockedResponse.status, 401);

  const passwordResponse = await fetch(`${base}/admin/api/config`, {
    headers: { Authorization: "Bearer console-password-123" },
  });
  assert.equal(passwordResponse.status, 200);

  const rootTokenResponse = await fetch(`${base}/admin/api/config`, {
    headers: { Authorization: "Bearer root-admin-token" },
  });
  assert.equal(rootTokenResponse.status, 200);
});
