import type { DeviceIdentity } from "@aipany/protocol";

export interface VoiceSessionBootstrap {
  sessionId: string;
  state: "created" | "connecting" | "active" | "ended" | "failed";
  provider: string;
  transport: "webrtc";
  expiresAt: string;
  bootstrap: {
    clientSecret: string;
    endpoint: string;
  };
  policy: {
    model: string;
    voice: string;
    turnDetection: {
      type: "semantic_vad";
      eagerness: "low" | "medium" | "high" | "auto";
      createResponse: boolean;
      interruptResponse: boolean;
    };
  };
}

interface CreateVoiceSessionInput {
  apiBaseUrl: string;
  userId: string;
  agentId: string;
  device: DeviceIdentity;
}

export async function createVoiceSession(
  input: CreateVoiceSessionInput,
): Promise<VoiceSessionBootstrap> {
  const response = await fetch(`${input.apiBaseUrl.replace(/\/$/, "")}/v1/voice/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      userId: input.userId,
      agentId: input.agentId,
      device: input.device,
      locale: "zh-CN",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }),
  });

  const payload = (await response.json()) as VoiceSessionBootstrap | {
    error?: { message?: string };
  };

  if (!response.ok) {
    const message = "error" in payload ? payload.error?.message : undefined;
    throw new Error(message ?? `创建实时语音会话失败（HTTP ${response.status}）`);
  }

  return payload as VoiceSessionBootstrap;
}
