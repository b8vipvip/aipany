import { Platform } from "react-native";

import type { DeviceIdentity } from "@aipany/protocol";

function createDevelopmentDeviceId(): string {
  // V1 暂时使用开发环境设备 ID。接入账号与设备注册服务后应替换为持久化设备身份。
  return `dev_mobile_${Platform.OS}`;
}

export function getCurrentDevice(): DeviceIdentity {
  return {
    deviceId: createDevelopmentDeviceId(),
    productId: "aipany-mobile",
    deviceType: "mobile",
    platform: Platform.OS,
    appVersion: "0.1.0",
    capabilities: ["audio_input", "audio_output", "screen"],
  };
}
