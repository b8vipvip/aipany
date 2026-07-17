import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";

import { createVoiceSession, type VoiceSessionBootstrap } from "./api/voice-session";
import { getCurrentDevice } from "./device";

type VoiceUiState = "idle" | "connecting" | "ready" | "error";

function getDefaultApiBaseUrl(): string {
  const configured = process.env.EXPO_PUBLIC_API_BASE_URL;
  if (configured) return configured;

  // Android 模拟器访问宿主机 localhost 需要使用 10.0.2.2。
  return Platform.OS === "android" ? "http://10.0.2.2:3000" : "http://localhost:3000";
}

export function App() {
  const device = useMemo(() => getCurrentDevice(), []);
  const [state, setState] = useState<VoiceUiState>("idle");
  const [session, setSession] = useState<VoiceSessionBootstrap | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const startSession = async () => {
    setState("connecting");
    setErrorMessage(null);

    try {
      const nextSession = await createVoiceSession({
        apiBaseUrl: getDefaultApiBaseUrl(),
        userId: "dev-user",
        agentId: "agent-default",
        device,
      });

      setSession(nextSession);
      setState("ready");
    } catch (error) {
      setSession(null);
      setErrorMessage(error instanceof Error ? error.message : "创建会话失败");
      setState("error");
    }
  };

  const endSession = () => {
    // 当前版本只清理本地启动数据。WebRTC 接入后这里会关闭 PeerConnection 和音频资源。
    setSession(null);
    setState("idle");
    setErrorMessage(null);
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="light" />
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.brand}>Aipany</Text>
          <Text style={styles.caption}>实时 AI 语音陪伴</Text>
        </View>

        <View style={styles.voiceStage}>
          <View style={[styles.orb, state === "ready" && styles.orbReady]}>
            {state === "connecting" ? (
              <ActivityIndicator size="large" />
            ) : (
              <Text style={styles.orbText}>{state === "ready" ? "已连接" : "AI"}</Text>
            )}
          </View>

          <Text style={styles.statusTitle}>
            {state === "idle" && "准备开始对话"}
            {state === "connecting" && "正在创建安全语音会话…"}
            {state === "ready" && "会话已准备，下一步接入 WebRTC"}
            {state === "error" && "连接失败"}
          </Text>

          <Text style={styles.statusDetail}>
            {errorMessage ??
              (session
                ? `Provider: ${session.provider} · ${session.policy.model}`
                : "手机 App 只连接 Aipany 后端，永久模型密钥不会保存到客户端。")}
          </Text>
        </View>

        <View style={styles.deviceCard}>
          <Text style={styles.cardTitle}>当前设备</Text>
          <Text style={styles.cardText}>{device.deviceId}</Text>
          <Text style={styles.cardText}>{device.capabilities.join(" · ")}</Text>
        </View>

        {state === "ready" ? (
          <Pressable style={[styles.button, styles.endButton]} onPress={endSession}>
            <Text style={styles.buttonText}>结束会话</Text>
          </Pressable>
        ) : (
          <Pressable
            style={[styles.button, state === "connecting" && styles.buttonDisabled]}
            disabled={state === "connecting"}
            onPress={startSession}
          >
            <Text style={styles.buttonText}>开始语音会话</Text>
          </Pressable>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#090b10",
  },
  container: {
    flex: 1,
    paddingHorizontal: 24,
    paddingVertical: 20,
  },
  header: {
    alignItems: "center",
  },
  brand: {
    color: "#ffffff",
    fontSize: 28,
    fontWeight: "700",
  },
  caption: {
    color: "#8d95a5",
    fontSize: 14,
    marginTop: 6,
  },
  voiceStage: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  orb: {
    width: 150,
    height: 150,
    borderRadius: 75,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#242936",
    borderWidth: 1,
    borderColor: "#41495b",
  },
  orbReady: {
    backgroundColor: "#26392f",
  },
  orbText: {
    color: "#ffffff",
    fontSize: 22,
    fontWeight: "600",
  },
  statusTitle: {
    color: "#ffffff",
    fontSize: 20,
    fontWeight: "600",
    marginTop: 30,
    textAlign: "center",
  },
  statusDetail: {
    color: "#8d95a5",
    fontSize: 14,
    lineHeight: 21,
    marginTop: 12,
    textAlign: "center",
  },
  deviceCard: {
    backgroundColor: "#121620",
    borderRadius: 16,
    padding: 16,
    marginBottom: 18,
  },
  cardTitle: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "600",
    marginBottom: 8,
  },
  cardText: {
    color: "#8d95a5",
    fontSize: 12,
    lineHeight: 19,
  },
  button: {
    minHeight: 56,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#ffffff",
  },
  endButton: {
    backgroundColor: "#332026",
  },
  buttonDisabled: {
    opacity: 0.55,
  },
  buttonText: {
    color: "#090b10",
    fontSize: 16,
    fontWeight: "700",
  },
});
