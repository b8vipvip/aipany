export type VoiceSessionErrorCode =
  | "INVALID_REQUEST"
  | "MISSING_DEVICE_CAPABILITY"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_REJECTED"
  | "UNSUPPORTED_PROVIDER_PROTOCOL"
  | "CONFIGURATION_ERROR";

export class VoiceSessionError extends Error {
  constructor(
    public readonly code: VoiceSessionErrorCode,
    message: string,
    public readonly statusCode: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "VoiceSessionError";
  }
}
