import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OperationsControlStore } from "../src/operations/operations-control-store.js";

async function withStore(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "aipany-operations-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const filePath = join(directory, "operations-control.json");
  return { store: new OperationsControlStore({ filePath }), filePath };
}

test("operations control defaults to direct admin access and disabled github sync", async (t) => {
  const { store } = await withStore(t);
  const snapshot = await store.snapshot();

  assert.equal(snapshot.adminAccess.passwordEnabled, false);
  assert.equal(snapshot.adminAccess.passwordConfigured, false);
  assert.equal(snapshot.observabilityGitHub.enabled, false);
  assert.equal(snapshot.observabilityGitHub.repository, "b8vipvip/aipany");
  assert.equal(snapshot.observabilityGitHub.tokenConfigured, false);
});

test("admin password is hashed, can be verified, changed, and disabled", async (t) => {
  const { store, filePath } = await withStore(t);

  await assert.rejects(
    () => store.updateAdminAccess({ passwordEnabled: true }),
    /必须设置新密码/,
  );

  await store.updateAdminAccess({ passwordEnabled: true, newPassword: "first-password-123" });
  assert.equal(await store.isPasswordEnabled(), true);
  assert.equal(await store.verifyPassword("first-password-123"), true);
  assert.equal(await store.verifyPassword("wrong-password"), false);

  const persisted = await readFile(filePath, "utf8");
  assert.equal(persisted.includes("first-password-123"), false);

  await store.updateAdminAccess({ passwordEnabled: true, newPassword: "second-password-456" });
  assert.equal(await store.verifyPassword("first-password-123"), false);
  assert.equal(await store.verifyPassword("second-password-456"), true);

  await store.updateAdminAccess({ passwordEnabled: false });
  assert.equal(await store.isPasswordEnabled(), false);
  assert.equal((await store.snapshot()).adminAccess.passwordConfigured, true);
});

test("github token is persisted server-side but redacted from snapshots", async (t) => {
  const { store } = await withStore(t);

  const result = await store.updateObservabilityGitHub({
    enabled: true,
    repository: "example/private-observability",
    branch: "main",
    path: "ops/observability",
    token: "github-test-token",
    allowPublicRepository: false,
    batchSeconds: 90,
  });

  assert.equal(result.observabilityGitHub.enabled, true);
  assert.equal(result.observabilityGitHub.tokenConfigured, true);
  assert.equal("token" in result.observabilityGitHub, false);

  const config = await store.getObservabilityGitHubConfig();
  assert.equal(config.token, "github-test-token");
  assert.equal(config.batchSeconds, 90);

  await store.updateObservabilityGitHub({
    enabled: true,
    repository: "example/private-observability",
    branch: "main",
    path: "ops/observability",
    token: "",
    allowPublicRepository: false,
    batchSeconds: 120,
  });
  assert.equal((await store.getObservabilityGitHubConfig()).token, "github-test-token");
});
