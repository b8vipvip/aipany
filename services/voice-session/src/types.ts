import type { DeviceIdentity } from "@aipany/protocol";

export type RealtimeProviderName = "openai";
export type RealtimeTransport = "webrtc";
export type VoiceSessionState = "created" | "connecting" | "active" | "ended" | "failed";
export type TurnDetectionEagerness = "low" | "medium" | "high" | "auto";

export interface CreateVoiceSessionInput {
  userId: string;
  agentId: string;
  device: DeviceIdentity;
  locale?: string;
  timezone?: string;
  metadata?: Record<string, string>;
}

export interface ProviderSessionRequest {
  userId: string;
  platformSessionId: string;
  agentId: string;
  locale?: string;
}

export interface ProviderSessionBootstrap {
  provider: RealtimeProviderName;
  transport: RealtimeTransport;
  clientSecret: string;
  expiresAt: string;
  endpoint: string;
  model: string;
  voice: string;
  turnDetection: {
    type: "semantic_vad";
    eagerness: TurnDetectionEagerness;
    createResponse: boolean;
    interruptResponse: boolean;
  };
}

export interface VoiceSessionBootstrap {
  sessionId: string;
  state: VoiceSessionState;
  provider: RealtimeProviderName;
  transport: RealtimeTransport;
  expiresAt: string;
  bootstrap: {
    clientSecret: string;
    endpoint: string;
  };
  policy: {
    model: string;
    voice: string;
    turnDetection: ProviderSessionBootstrap["turnDetection"];
  };
  context: {
    userId: string;
    agentId: string;
    deviceId: string;
    productId: string;
  };
}

export interface RealtimeProvider {
  readonly name: RealtimeProviderName;
  createSession(input: ProviderSessionRequest): Promise<ProviderSessionBootstrap>;
}