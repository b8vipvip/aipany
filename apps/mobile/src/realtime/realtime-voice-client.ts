import {
  MediaStream,
  RTCPeerConnection,
  RTCSessionDescription,
  mediaDevices,
} from "react-native-webrtc";

import type { VoiceSessionBootstrap } from "../api/voice-session";

export type RealtimeVoiceConnectionState =
  | "idle"
  | "requesting_microphone"
  | "connecting"
  | "connected"
  | "failed"
  | "closed";

export interface RealtimeVoiceEvent {
  type: string;
  [key: string]: unknown;
}

export interface RealtimeVoiceClientHandlers {
  onStateChange?: (state: RealtimeVoiceConnectionState) => void;
  onEvent?: (event: RealtimeVoiceEvent) => void;
  onError?: (error: Error) => void;
}

/**
 * 手机端实时语音传输客户端。
 *
 * 该类只负责设备侧 WebRTC 生命周期：
 * - 获取麦克风音频；
 * - 建立 RTCPeerConnection；
 * - 使用 Voice Session 服务返回的短期凭证完成 SDP 交换；
 * - 通过 DataChannel 收发实时事件；
 * - 在结束会话时释放所有原生音频和 WebRTC 资源。
 *
 * Agent、长期记忆、Tool 和永久供应商密钥都不属于客户端职责。
 */
export class RealtimeVoiceClient {
  private peerConnection: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private dataChannel: ReturnType<RTCPeerConnection["createDataChannel"]> | null = null;
  private handlers: RealtimeVoiceClientHandlers = {};
  private currentState: RealtimeVoiceConnectionState = "idle";

  get state(): RealtimeVoiceConnectionState {
    return this.currentState;
  }

  async connect(
    session: VoiceSessionBootstrap,
    handlers: RealtimeVoiceClientHandlers = {},
  ): Promise<void> {
    if (this.peerConnection) {
      throw new Error("实时语音连接已经存在，请先结束当前会话");
    }

    this.handlers = handlers;

    try {
      this.setState("requesting_microphone");
      this.localStream = await mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });

      this.setState("connecting");

      const peerConnection = new RTCPeerConnection({});
      this.peerConnection = peerConnection;

      this.bindPeerConnectionEvents(peerConnection);

      for (const track of this.localStream.getAudioTracks()) {
        peerConnection.addTrack(track, this.localStream);
      }

      // Realtime 非音频事件通过 DataChannel 传输，例如会话状态、字幕和 Tool Call。
      const dataChannel = peerConnection.createDataChannel("oai-events");
      this.dataChannel = dataChannel;
      this.bindDataChannelEvents(dataChannel);

      const offer = await peerConnection.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: false,
      });

      await peerConnection.setLocalDescription(offer);
      await this.waitForIceGathering(peerConnection);

      const localSdp = peerConnection.localDescription?.sdp ?? offer.sdp;
      if (!localSdp) {
        throw new Error("无法生成 WebRTC SDP Offer");
      }

      const answerSdp = await this.exchangeSdp(session, localSdp);

      await peerConnection.setRemoteDescription(
        new RTCSessionDescription({
          type: "answer",
          sdp: answerSdp,
        }),
      );

      // connectionstatechange 会在底层真正连通后切换为 connected。
      // 某些设备事件顺序较慢，因此此处不提前伪造“已连接”状态。
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error("建立实时语音连接失败");
      this.setState("failed");
      this.handlers.onError?.(normalized);
      this.disconnect();
      throw normalized;
    }
  }

  setMuted(muted: boolean): void {
    for (const track of this.localStream?.getAudioTracks() ?? []) {
      track.enabled = !muted;
    }
  }

  sendEvent(event: RealtimeVoiceEvent): void {
    if (!this.dataChannel || this.dataChannel.readyState !== "open") {
      throw new Error("Realtime DataChannel 尚未连接");
    }

    this.dataChannel.send(JSON.stringify(event));
  }

  /**
   * 主动停止当前 AI 语音输出。
   * 自动 Barge-in 由服务端 Turn Detection 负责，客户端仍保留显式中断能力。
   */
  interruptAssistant(): void {
    if (!this.dataChannel || this.dataChannel.readyState !== "open") return;

    this.sendEvent({ type: "response.cancel" });
    this.sendEvent({ type: "output_audio_buffer.clear" });
  }

  disconnect(): void {
    try {
      this.dataChannel?.close();
    } catch {
      // 清理阶段忽略已经关闭的 DataChannel。
    }
    this.dataChannel = null;

    for (const track of this.localStream?.getTracks() ?? []) {
      track.stop();
    }
    this.localStream = null;

    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }

    if (this.currentState !== "failed") {
      this.setState("closed");
    }
  }

  private bindPeerConnectionEvents(peerConnection: RTCPeerConnection): void {
    peerConnection.addEventListener("connectionstatechange", () => {
      const state = peerConnection.connectionState;

      if (state === "connected") {
        this.setState("connected");
        return;
      }

      if (state === "failed") {
        const error = new Error("WebRTC PeerConnection 连接失败");
        this.setState("failed");
        this.handlers.onError?.(error);
        return;
      }

      if (state === "closed") {
        this.setState("closed");
      }
    });

    peerConnection.addEventListener("iceconnectionstatechange", () => {
      if (peerConnection.iceConnectionState === "failed") {
        this.handlers.onError?.(new Error("WebRTC ICE 连接失败"));
      }
    });
  }

  private bindDataChannelEvents(
    dataChannel: ReturnType<RTCPeerConnection["createDataChannel"]>,
  ): void {
    dataChannel.addEventListener("message", (message) => {
      if (typeof message.data !== "string") return;

      try {
        const event = JSON.parse(message.data) as RealtimeVoiceEvent;
        this.handlers.onEvent?.(event);
      } catch {
        this.handlers.onEvent?.({
          type: "aipany.unparsed_event",
          raw: message.data,
        });
      }
    });
  }

  private async exchangeSdp(session: VoiceSessionBootstrap, offerSdp: string): Promise<string> {
    const response = await fetch(session.bootstrap.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.bootstrap.clientSecret}`,
        "Content-Type": "application/sdp",
      },
      body: offerSdp,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `实时语音供应商拒绝 WebRTC 建连（HTTP ${response.status}）：${body.slice(0, 200)}`,
      );
    }

    const answerSdp = await response.text();
    if (!answerSdp.trim()) {
      throw new Error("实时语音供应商没有返回 SDP Answer");
    }

    return answerSdp;
  }

  private async waitForIceGathering(peerConnection: RTCPeerConnection): Promise<void> {
    if (peerConnection.iceGatheringState === "complete") return;

    await new Promise<void>((resolve) => {
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        peerConnection.removeEventListener("icegatheringstatechange", handleStateChange);
        resolve();
      };

      const handleStateChange = () => {
        if (peerConnection.iceGatheringState === "complete") {
          finish();
        }
      };

      // 移动网络环境下 ICE Gathering 可能不会及时进入 complete，避免无限等待。
      const timeout = setTimeout(finish, 2_500);
      peerConnection.addEventListener("icegatheringstatechange", handleStateChange);
    });
  }

  private setState(state: RealtimeVoiceConnectionState): void {
    this.currentState = state;
    this.handlers.onStateChange?.(state);
  }
}
