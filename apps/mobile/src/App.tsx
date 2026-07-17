import { useEffect, useMemo, useRef, useState } from "react";
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
import {
  RealtimeVoiceClient,
  type RealtimeVoiceConnectionState,
  type RealtimeVoiceEvent,
} from "./realtime/realtime-voice-client";

type VoiceUiState =
  | "idle"
  | "creating_session"
  | "requesting_microphone"
  | "connecting_webrtc"
  | "active"
  | "error";

type ConversationState = "waiting" | "listening" | "thinking" | "speaking";

function getDefaultApiBaseUrl(): string {
  const configured = process.env.EXPO_PUBLIC_API_BASE_URL;
  if (configured) return configured;

  // Android 模拟器访问宿主机 localhost 需要使用 10.0.2.2。
  return Platform.OS === "android" ? "http://10.0.2.2:3000" : "http://localhost:3000";
}

function mapConnectionState(state: RealtimeVoiceConnectionState): VoiceUiState | null {
  if (state === "requesting_microphone") return "requesting_microphone";
  if (state === "connecting") return "connecting_webrtc";
  if (state === "connected") return "active";
  if (state === "failed") return "error";
  return null;
}

function getStatusTitle(state: VoiceUiState, conversationState: ConversationState): string {
  if (state === "idle") return "准备开始对话";
  if (state === "creating_session") return "正在创建安全语音会话…";
  if (state === "requesting_microphone") return "正在启用麦克风…";
  if (state === "connecting_webrtc") return "正在建立实时语音连接…";
  if (state === "error") return "连接失败";

  if (conversationState === "listening") return "我在听";
  if (conversationState === "thinking") return "正在思考";
  if (conversationState === "speaking") return "正在回复";
  return "已连接，可以直接说话";
}

export function App() {
  const device = useMemo(() => getCurrentDevice(), []);
  const voiceClientRef = useRef<RealtimeVoiceClient | null>(null);
  const [state, setState] = useState<VoiceUiState>("idle");
  const [conversationState, setConversationState] = useState<ConversationState>("waiting");
  const [session, setSession] = useState<VoiceSessionBootstrap | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastEventType, setLastEventType] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    return () => {
      voiceClientRef.current?.disconnect();
      voiceClientRef.current = null;
    };
  }, []);

  const handleRealtimeEvent = (event: RealtimeVoiceEvent) => {
    setLastEventType(event.type);

    switch (event.type) {
      case "input_audio_buffer.speech_started":
        setConversationState("listening");
        break;
      case "input_audio_buffer.speech_stopped":
        setConversationState("thinking");
        break;
      case "output_audio_buffer.started":
        setConversationState("speaking");
        break;
      case "output_audio_buffer.stopped":
      case "response.done":
        setConversationState("waiting");
        break;
      case "error":
        setErrorMessage("Realtime 会话返回错误，请查看开发日志");
        break;
      default:
        break;
    }
  };

  const startSession = async () => {
    voiceClientRef.current?.disconnect();
    voiceClientRef.current = null;

    setState("creating_session");
    setConversationState("waiting");
    setErrorMessage(null);
    setLastEventType(null);
    setMuted(false);

    try {
      const nextSession = await createVoiceSession({
        apiBaseUrl: getDefaultApiBaseUrl(),
        userId: "dev-user",
        agentId: "agent-default",
        device,
      });

      setSession(nextSession);

      const voiceClient = new RealtimeVoiceClient();
      voiceClientRef.current = voiceClient;

      await voiceClient.connect(nextSession, {
        onStateChange: (connectionState) => {
          const nextUiState = mapConnectionState(connectionState);
          if (nextUiState) setState(nextUiState);
        },
        onEvent: handleRealtimeEvent,
        onError: (error) => {
          setErrorMessage(error.message);
          setState("error");
        },
      });
    } catch (error) {
      voiceClientRef.current?.disconnect();
      voiceClientRef.current = null;
      setSession(null);
      setErrorMessage(error instanceof Error ? error.message : "创建实时语音连接失败");
      setState("error");
    }
  };

  const endSession = () => {
    voiceClientRef.current?.disconnect();
    voiceClientRef.current = null;
    setSession(null);
    setState("idle");
    setConversationState("waiting");
    setErrorMessage(null);
    setLastEventType(null);
    setMuted(false);
  };

  const toggleMuted = () => {
    const nextMuted = !muted;
    voiceClientRef.current?.setMuted(nextMuted);
    setMuted(nextMuted);
  };

  const isBusy =
    state === "creating_session" ||
    state === "requesting_microphone" ||
    state === "connecting_webrtc";
  const isSessionStarted = isBusy || state === "active";

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="light" />
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.brand}>Aipany</Text>
          <Text style={styles.caption}>实时 AI 语音陪伴</Text>
        </View>

        <View style={styles.voiceStage}>
          <View
            style={[
              styles.orb,
              state === "active" && styles.orbActive,
              conversationState === "speaking" && styles.orbSpeaking,
            ]}
          >
            {isBusy ? (
              <ActivityIndicator size="large" />
            ) : (
              <Text style={styles.orbText}>{state === "active" ? "LIVE" : "AI"}</Text>
            )}
          </View>

          <Text style={styles.statusTitle}>{getStatusTitle(state, conversationState)}</Text>

          <Text style={styles.statusDetail}>
            {errorMessage ??
              (session
                ? `${session.provider} · ${session.policy.model} · ${session.policy.voice}`
                : "手机端通过 Aipany 获取短期凭证，永久模型密钥只保存在服务端。")}
          </Text>

          {state === "active" && lastEventType ? (
            <Text style={styles.eventText}>最近事件：{lastEventType}</Text>
          ) : null}
        </View>

        <View style={styles.deviceCard}>
          <Text style={styles.cardTitle}>当前设备</Text>
          <Text style={styles.cardText}>{device.deviceId}</Text>
          <Text style={styles.cardText}>{device.capabilities.join(" · ")}</Text>
        </View>

        {state === "active" ? (
          <View style={styles.activeControls}>
            <Pressable style={styles.secondaryButton} onPress={toggleMuted}>
              <Text style={styles.secondaryButtonText}>{muted ? "打开麦克风" : "静音"}</Text>
            </Pressable>
            <Pressable style={[styles.button, styles.endButton]} onPress={endSession}>
              <Text style={styles.endButtonText}>结束会话</Text>
            </Pressable>
          </View>
        ) : isSessionStarted ? (
          <Pressable style={[styles.button, styles.endButton]} onPress={endSession}>
            <Text style={styles.endButtonText}>取消连接</Text>
          </Pressable>
        ) : (
          <Pressable style={styles.button} onPress={startSession}>
            <Text style={styles.buttonText}>{state === "error" ? "重新连接" : "开始语音会话"}</Text>
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
  orbActive: {
    backgroundColor: "#26392f",
  },
  orbSpeaking: {
    transform: [{ scale: 1.06 }],
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
  eventText: {
    color: "#657086",
    fontSize: 11,
    marginTop: 10,
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
  activeControls: {
    gap: 10,
  },
  button: {
    minHeight: 56,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#ffffff",
  },
  secondaryButton: {
    minHeight: 48,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#171c27",
  },
  secondaryButtonText: {
    color: "#dbe1ec",
    fontSize: 14,
    fontWeight: "600",
  },
  endButton: {
    backgroundColor: "#332026",
  },
  buttonText: {
    color: "#090b10",
    fontSize: 16,
    fontWeight: "700",
  },
  endButtonText: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "700",
  },
});
