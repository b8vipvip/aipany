import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { getClientVoiceOptions, resolveRequestedVoice } from "../src/mobile/client-capabilities.js";
import { createMobilePreviewIdentity, issueMobilePreviewJwt } from "../src/mobile/mobile-preview.js";

test("mobile preview identity is deterministic without exposing raw device id", () => {
  const first = createMobilePreviewIdentity("android-device-123456", "mobile-preview");
  const second = createMobilePreviewIdentity("android-device-123456", "mobile-preview");
  assert.equal(first.userId, second.userId);
  assert.equal(first.tenantId, "mobile-preview");
  assert.ok(!first.userId.includes("android-device"));
});

test("mobile preview jwt is valid HS256 with realtime-only scope", () => {
  const identity = createMobilePreviewIdentity("android-device-123456", "mobile-preview");
  const issued = issueMobilePreviewJwt(identity, {
    jwtSecret: "test-secret",
    jwtIssuer: "aipany",
    jwtAudience: "mobile",
    ttlSeconds: 3600,
    tenantId: "mobile-preview",
  }, 1_000);

  const [header, payload, signature] = issued.token.split(".");
  assert.ok(header && payload && signature);
  const expected = createHmac("sha256", "test-secret").update(`${header}.${payload}`).digest("base64url");
  assert.equal(signature, expected);
  const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
  assert.equal(claims.scope, "realtime");
  assert.equal(claims.tenant_id, "mobile-preview");
  assert.equal(claims.exp, 4_600);
});

test("qwen3 instruct realtime exposes multiple selectable voices", () => {
  const voices = getClientVoiceOptions("qwen3-tts-instruct-flash-realtime", "Cherry");
  assert.ok(voices.length >= 10);
  assert.ok(voices.some((voice) => voice.id === "Cherry"));
  assert.ok(voices.some((voice) => voice.id === "Kai"));
});

test("unsupported client voice safely falls back to configured voice", () => {
  assert.equal(
    resolveRequestedVoice("qwen3-tts-instruct-flash-realtime", "Cherry", "not-a-real-voice"),
    "Cherry",
  );
  assert.equal(
    resolveRequestedVoice("qwen3-tts-instruct-flash-realtime", "Cherry", "Serena"),
    "Serena",
  );
});
