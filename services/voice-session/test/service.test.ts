import { describe, expect, it } from "vitest";

import { VoiceSessionService } from "../src/service.js";
import type { RealtimeProvider } from "../src/types.js";

const fakeProvider: RealtimeProvider = {
  name: "openai",
  async createSession() {
    return {
      provider: "openai",
      transport: "webrtc",
      clientSecret: "ephemeral_test_secret",
      expiresAt: "2026-07-16T12:00:00.000Z",
      endpoint: "https://api.openai.com/v1/realtime/calls",
      model: "gpt-realtime-2.1",
      voice: "marin",
      turnDetection: {
        type: "semantic_vad",
        eagerness: "low",
        createResponse: true,
        interruptResponse: true,
      },
    };
  },
};

describe("VoiceSessionService", () => {
  it("为具备完整语音能力的设备创建统一会话启动数据", async () => {
    const service = new VoiceSessionService(fakeProvider);

    const result = await service.createSession({
      userId: "user_001",
      agentId: "agent_default",
      device: {
        deviceId: "device_001",
        productId: "aipany-mobile",
        deviceType: "mobile",
        platform: "ios",
        capabilities: ["audio_input", "audio_output", "screen"],
      },
    });

    expect(result.sessionId).toMatch(/^vs_/);
    expect(result.provider).toBe("openai");
    expect(result.bootstrap.clientSecret).toBe("ephemeral_test_secret");
    expect(result.context.deviceId).toBe("device_001");
  });

  it("拒绝缺少音频输出能力的设备", async () => {
    const service = new VoiceSessionService(fakeProvider);

    await expect(
      service.createSession({
        userId: "user_001",
        agentId: "agent_default",
        device: {
          deviceId: "device_001",
          productId: "aipany-mobile",
          deviceType: "mobile",
          platform: "ios",
          capabilities: ["audio_input"],
        },
      }),
    ).rejects.toMatchObject({
      code: "MISSING_DEVICE_CAPABILITY",
      statusCode: 422,
    });
  });
});