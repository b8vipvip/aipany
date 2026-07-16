import { randomUUID } from "node:crypto";

import { VoiceSessionError } from "./errors.js";
import type {
  CreateVoiceSessionInput,
  RealtimeProvider,
  VoiceSessionBootstrap,
} from "./types.js";

export class VoiceSessionService {
  constructor(private readonly provider: RealtimeProvider) {}

  async createSession(input: CreateVoiceSessionInput): Promise<VoiceSessionBootstrap> {
    this.assertVoiceCapabilities(input);

    const sessionId = `vs_${randomUUID()}`;
    const providerSession = await this.provider.createSession({
      userId: input.userId,
      platformSessionId: sessionId,
      agentId: input.agentId,
      locale: input.locale,
    });

    return {
      sessionId,
      state: "created",
      provider: providerSession.provider,
      transport: providerSession.transport,
      expiresAt: providerSession.expiresAt,
      bootstrap: {
        clientSecret: providerSession.clientSecret,
        endpoint: providerSession.endpoint,
      },
      policy: {
        model: providerSession.model,
        voice: providerSession.voice,
        turnDetection: providerSession.turnDetection,
      },
      context: {
        userId: input.userId,
        agentId: input.agentId,
        deviceId: input.device.deviceId,
        productId: input.device.productId,
      },
    };
  }

  private assertVoiceCapabilities(input: CreateVoiceSessionInput): void {
    const capabilities = new Set(input.device.capabilities);
    const missing = ["audio_input", "audio_output"].filter(
      (capability) => !capabilities.has(capability as "audio_input" | "audio_output"),
    );

    if (missing.length > 0) {
      throw new VoiceSessionError(
        "MISSING_DEVICE_CAPABILITY",
        "当前设备不具备完整的实时语音输入输出能力",
        422,
        { missingCapabilities: missing },
      );
    }
  }
}