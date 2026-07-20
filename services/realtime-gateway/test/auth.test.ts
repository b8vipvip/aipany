import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { assertSessionIdentity, authenticateRequest, requireScope } from "../src/auth.js";

function jwt(payload: Record<string, unknown>, secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

function request(token: string): IncomingMessage {
  return { headers: { authorization: `Bearer ${token}` } } as IncomingMessage;
}

test("JWT tenant/sub 会绑定到 session identity 并解析 scopes", () => {
  const secret = "unit-test-secret";
  const token = jwt({
    sub: "user-1",
    tenant_id: "tenant-1",
    scope: "realtime speaker:read speaker:write",
    exp: Math.floor(Date.now() / 1000) + 60,
  }, secret);
  const context = authenticateRequest(request(token), new URL("http://localhost/v1/realtime"), { jwtSecret: secret });
  assert.ok(context);
  assert.equal(context.tenantId, "tenant-1");
  assert.equal(context.userId, "user-1");
  assert.doesNotThrow(() => requireScope(context, "speaker:write"));
  assert.doesNotThrow(() => assertSessionIdentity(context, { tenantId: "tenant-1", userId: "user-1" }));
  assert.throws(() => assertSessionIdentity(context, { tenantId: "tenant-2", userId: "user-1" }));
});

test("篡改 JWT 会被拒绝", () => {
  const secret = "unit-test-secret";
  const token = jwt({ sub: "user-1", tenant_id: "tenant-1" }, secret);
  const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
  assert.equal(authenticateRequest(request(tampered), new URL("http://localhost/v1/realtime"), { jwtSecret: secret }), undefined);
});

test("legacy token 继续兼容且拥有通配 scope", () => {
  const context = authenticateRequest(request("legacy"), new URL("http://localhost/v1/realtime"), { legacyToken: "legacy" });
  assert.ok(context);
  assert.equal(context.legacy, true);
  assert.doesNotThrow(() => requireScope(context, "speaker:write"));
});
