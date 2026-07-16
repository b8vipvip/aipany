export const PROTOCOL_VERSION = "2026-07-16" as const;

export type DeviceType =
  | "mobile"
  | "web"
  | "embedded"
  | "speaker"
  | "robot"
  | "unknown";

export type DeviceCapability =
  | "audio_input"
  | "audio_output"
  | "screen"
  | "camera"
  | "location"
  | "led"
  | "motor"
  | "button"
  | "battery"
  | "ota";

export interface DeviceIdentity {
  deviceId: string;
  productId: string;
  deviceType: DeviceType;
  platform: string;
  appVersion?: string;
  firmwareVersion?: string;
  capabilities: DeviceCapability[];
}

export interface ProtocolEnvelope<TType extends string, TPayload> {
  version: typeof PROTOCOL_VERSION;
  eventId: string;
  timestamp: string;
  deviceId: string;
  sessionId?: string;
  type: TType;
  payload: TPayload;
}

export type SessionStartEvent = ProtocolEnvelope<
  "session.start",
  {
    agentId: string;
    locale?: string;
    timezone?: string;
    metadata?: Record<string, string>;
  }
>;

export type SessionEndEvent = ProtocolEnvelope<
  "session.end",
  {
    reason: "user" | "timeout" | "network" | "server" | "error";
  }
>;

export type SpeechStateEvent = ProtocolEnvelope<
  | "user.speech.started"
  | "user.speech.stopped"
  | "assistant.speech.started"
  | "assistant.speech.stopped"
  | "assistant.speech.interrupted",
  {
    turnId?: string;
  }
>;

export type ToolCallEvent = ProtocolEnvelope<
  "tool.call",
  {
    callId: string;
    tool: string;
    arguments: Record<string, unknown>;
  }
>;

export type ToolResultEvent = ProtocolEnvelope<
  "tool.result",
  {
    callId: string;
    ok: boolean;
    result?: unknown;
    error?: string;
  }
>;

export type DeviceCommandEvent = ProtocolEnvelope<
  "device.command",
  {
    command: string;
    arguments?: Record<string, unknown>;
  }
>;

export type DeviceStatusEvent = ProtocolEnvelope<
  "device.status",
  {
    online: boolean;
    batteryPercent?: number;
    attributes?: Record<string, unknown>;
  }
>;

export type AipanyProtocolEvent =
  | SessionStartEvent
  | SessionEndEvent
  | SpeechStateEvent
  | ToolCallEvent
  | ToolResultEvent
  | DeviceCommandEvent
  | DeviceStatusEvent;
