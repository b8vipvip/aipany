// Aipany 跨设备协议版本。发生不兼容变更时必须升级版本。
export const PROTOCOL_VERSION = "2026-07-16" as const;

// 设备类型只描述终端形态，后端业务逻辑不应针对手机写死特殊分支。
export type DeviceType =
  | "mobile"
  | "web"
  | "embedded"
  | "speaker"
  | "robot"
  | "unknown";

// Capability 用于声明设备真实具备的能力，Tool 执行设备命令前必须进行校验。
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

// 所有客户端统一使用 DeviceIdentity 接入平台，手机与未来 ESP32 使用同一套模型。
export interface DeviceIdentity {
  deviceId: string;
  productId: string;
  deviceType: DeviceType;
  platform: string;
  appVersion?: string;
  firmwareVersion?: string;
  capabilities: DeviceCapability[];
}

// 所有平台事件的统一信封格式，便于追踪、审计和跨传输协议复用。
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

// 统一用户和 AI 的语音状态，供应商原生事件必须先映射为这些平台事件。
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

// AI Brain 通过统一设备命令控制不同终端，客户端自行实现具体硬件动作。
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