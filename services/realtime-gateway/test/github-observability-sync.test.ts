import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { GitHubObservabilitySync } from "../src/observability/github-observability-sync.js";
import { OperationsControlStore } from "../src/operations/operations-control-store.js";

async function createConfig(t: TestContext, allowPublicRepository = false) {
  const directory = await mkdtemp(join(tmpdir(), "aipany-observability-sync-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const filePath = join(directory, "operations-control.json");
  const store = new OperationsControlStore({ filePath });
  await store.updateObservabilityGitHub({
    enabled: true,
    repository: "example/observability-private",
    branch: "main",
    path: "ops/observability",
    token: "github-test-token",
    allowPublicRepository,
    batchSeconds: 60,
  });
  return filePath;
}

test("github observability sync uploads every diagnostic event in sanitized batches", async (t) => {
  const configPath = await createConfig(t);
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (!init?.method || init.method === "GET") {
      return new Response(JSON.stringify({ private: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ content: { path: "ok" } }), { status: 201, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  const sync = new GitHubObservabilitySync({ configPath, fetchImpl, now: () => 1_800_000_000_000 });
  sync.enqueue({
    timestamp: 1_800_000_000_000,
    level: "info",
    category: "client",
    event: "barge_in_detected",
    sessionId: "raw-session-id-must-not-leak",
    engine: "omni_realtime",
    data: {
      transcript: "这是用户的私密对话正文",
      responseText: "这是 AI 的私密回答",
      userId: "private-user",
      deviceIdHash: "private-device-hash",
      remoteAddress: "203.0.113.10",
      speechEndToFirstAudioMs: 420,
      responseCreatedToFirstAudioMs: 180,
      bargeInDetectToPlaybackStopMs: 55,
      heartbeatRttMs: 32,
      networkType: "wifi",
      appVersion: "0.3.0",
      message: "upstream failed token=super-secret-value",
    },
  });

  await sync.flushNow();

  assert.equal(calls.length, 2);
  assert.match(calls[0]!.url, /api\.github\.com\/repos\/example\/observability-private$/);
  const upload = calls[1]!;
  assert.equal(upload.init?.method, "PUT");
  assert.match(upload.url, /\/contents\/ops\/observability\/2027-/);

  const body = JSON.parse(String(upload.init?.body)) as { content: string };
  const uploaded = Buffer.from(body.content, "base64").toString("utf8");
  const payload = JSON.parse(uploaded) as {
    privacy: Record<string, unknown>;
    events: Array<{ sessionHash?: string; data?: Record<string, unknown> }>;
  };

  assert.equal(payload.privacy.conversationContentIncluded, false);
  assert.equal(payload.events.length, 1);
  assert.equal(payload.events[0]!.sessionHash?.length, 16);
  assert.equal(uploaded.includes("raw-session-id-must-not-leak"), false);
  assert.equal(uploaded.includes("私密对话正文"), false);
  assert.equal(uploaded.includes("私密回答"), false);
  assert.equal(uploaded.includes("private-user"), false);
  assert.equal(uploaded.includes("private-device-hash"), false);
  assert.equal(uploaded.includes("203.0.113.10"), false);
  assert.equal(uploaded.includes("super-secret-value"), false);
  assert.equal(payload.events[0]!.data?.speechEndToFirstAudioMs, 420);
  assert.equal(payload.events[0]!.data?.responseCreatedToFirstAudioMs, 180);
  assert.equal(payload.events[0]!.data?.bargeInDetectToPlaybackStopMs, 55);
  assert.equal(payload.events[0]!.data?.heartbeatRttMs, 32);
  assert.equal(payload.events[0]!.data?.networkType, "wifi");
});

test("github observability sync blocks public repositories unless explicitly allowed", async (t) => {
  const configPath = await createConfig(t, false);
  let uploadAttempted = false;
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "PUT") uploadAttempted = true;
    return new Response(JSON.stringify({ private: false }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  const sync = new GitHubObservabilitySync({ configPath, fetchImpl });
  sync.enqueue({
    timestamp: Date.now(),
    level: "warn",
    category: "connection",
    event: "session.ended",
    data: { code: 1011, reason: "upstream disconnected" },
  });

  await assert.rejects(() => sync.flushNow(), /公开仓库/);
  assert.equal(uploadAttempted, false);
});
