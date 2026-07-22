import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test, { type TestContext } from "node:test";
import WebSocket from "ws";
import type { SessionStartEvent } from "@aipany/protocol";
import type { AuthContext } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import type { SessionObservability } from "../src/observability/realtime-observability.js";
import { QwenOmniRealtimeClient } from "../src/providers/qwen-omni-realtime.js";
import { QwenOmniLiveSession } from "../src/session/qwen-omni-live-session.js";

class FakeOmniProvider extends EventEmitter {
  readonly appended: Buffer[] = [];
  closed = false;

  constructor(private readonly connectError?: Error) {
    super();
  }

  async connect(): Promise<void> {
    if (this.connectError) throw this.connectError;
  }

  appendAudio(audio: Buffer): void {
    this.appended.push(Buffer.from(audio));
  }

  cancelResponse(): void {}
  updateInstructions(_instructions: string): void {}
  close(): void { this.closed = true; }
}

function createClient() {
  const sent: Array<string | Buffer> = [];
  const closes: Array<{ code?: number; reason?: string }> = [];
  const client = {
    readyState: WebSocket.OPEN,
    send(data: string | Buffer) {
      sent.push(Buffer.isBuffer(data) ? Buffer.from(data) : data);
      return true;
    },
    close(code?: number, reason?: string) {
      closes.push({ code, reason });
      this.readyState = WebSocket.CLOSED;
    },
  };
  return { client: client as unknown as WebSocket, sent, closes };
}

function createTelemetry() {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const telemetry = {
    event(event: string, data: Record<string, unknown> = {}) {
      events.push({ event, data });
    },
  } as unknown as SessionObservability;
  return { telemetry, events };
}

function sessionStartEvent(): SessionStartEvent {
  return {
    type: "session.start",
    session: {
      tenantId: "tenant-test",
      userId: "user-test",
      agentId: "default-agent",
      locale: "zh-CN",
      assistantAliases: ["Aipany", "小派"],
      interactionMode: "auto",
      socialProactivity: 0.45,
      inputAudio: { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 },
      device: {
        deviceId: "device-test",
        productId: "android-preview",
        deviceType: "mobile",
        platform: "android",
        appVersion: "0.3.0",
      },
    },
  };
}

function withNativeEnv(t: TestContext): void {
  const keys = [
    "AIPANY_REALTIME_ENGINE",
    "DASHSCOPE_API_KEY",
    "QWEN_OMNI_REALTIME_ENABLED",
    "QWEN_OMNI_REALTIME_MODEL",
    "QWEN_OMNI_REALTIME_VOICE",
  ] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.AIPANY_REALTIME_ENGINE = "omni_realtime";
  process.env.DASHSCOPE_API_KEY = "dashscope-test-key";
  process.env.QWEN_OMNI_REALTIME_ENABLED = "true";
  process.env.QWEN_OMNI_REALTIME_MODEL = "qwen3.5-omni-plus-realtime";
  process.env.QWEN_OMNI_REALTIME_VOICE = "Tina";
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("Native Live transparently reconnects upstream and replays audio buffered during recovery", async (t) => {
  withNativeEnv(t);
  const providers: FakeOmniProvider[] = [];
  const providerFactory = () => {
    const provider = new FakeOmniProvider();
    providers.push(provider);
    return provider as unknown as QwenOmniRealtimeClient;
  };
  const { client, sent, closes } = createClient();
  const { telemetry, events } = createTelemetry();
  const authContext: AuthContext = { authenticated: true, legacy: false, scopes: new Set(["*"]) };
  const session = new QwenOmniLiveSession(
    client,
    loadConfig(),
    authContext,
    telemetry,
    "native-test-session",
    providerFactory,
  );

  await session.start(sessionStartEvent());
  assert.equal(providers.length, 1);
  const initialSessionCreatedCount = sent.filter((item) => typeof item === "string" && item.includes('"type":"session.created"')).length;
  assert.equal(initialSessionCreatedCount, 1);

  providers[0]!.emit("close", 1007, "Response stream timeout (timeout_seconds=300)");
  const bufferedAudio = Buffer.alloc(3200, 7);
  session.appendAudio(bufferedAudio);
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(providers.length, 2);
  assert.equal(closes.length, 0, "client WebSocket should stay open when first upstream recovery succeeds");
  assert.equal(Buffer.concat(providers[1]!.appended).length, bufferedAudio.length);
  assert.equal(sent.filter((item) => typeof item === "string" && item.includes('"type":"session.created"')).length, 1);
  assert.equal(sent.some((item) => typeof item === "string" && item.includes("OMNI_REALTIME_CLOSED")), false);
  assert.equal(events.some((item) => item.event === "omni.recovery.started"), true);
  assert.equal(events.some((item) => item.event === "omni.recovered" && item.data.contextReset === true), true);

  session.close();
});
