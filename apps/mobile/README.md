# 手机 App

手机 App 是 Aipany 的第一款实时语音设备客户端，也是未来 ESP32、智能音箱和机器人客户端的参考实现。

## 当前技术栈

- Expo SDK 55；
- React Native；
- TypeScript；
- `react-native-webrtc`；
- Expo Development Build；
- `@aipany/protocol` 共享设备与会话协议。

## 当前已实现

- 将手机 App 作为统一 `Device` 建模并上报 Capability；
- 调用 Aipany `POST /v1/voice/sessions` 创建安全实时语音会话；
- 从服务端获取短期 Realtime 会话凭证；
- 请求麦克风并创建本地 Audio Track；
- 创建 `RTCPeerConnection`；
- 创建 Realtime DataChannel；
- 生成 SDP Offer 并完成会话建连流程；
- 监听实时会话事件并映射为“正在听 / 正在思考 / 正在回复”等 UI 状态；
- 支持麦克风静音、结束会话和 WebRTC 资源释放；
- 为后续 Barge-in、字幕和延迟指标预留客户端事件入口。

## 当前待验证

WebRTC 主链路代码已经接入，但仍需要在 Android / iOS Development Build 真机或模拟器环境完成端到端验证，重点确认：

- 麦克风权限和 Audio Session；
- SDP 交换与 PeerConnection 建连；
- AI 远端音频是否正确从系统扬声器播放；
- DataChannel 事件顺序；
- 结束会话后的麦克风和 WebRTC 资源是否完全释放；
- 蓝牙耳机、听筒和扬声器等音频路由。

详细运行步骤请阅读 `DEVELOPMENT.md`。

## V1 后续职责

- 稳定的 Barge-in 用户打断；
- 实时字幕；
- 连接与弱网恢复；
- 语音延迟指标；
- 音频路由与后台 / 前台切换处理；
- 将供应商原生实时事件转换为 Aipany 统一协议事件。

## 客户端边界

手机 App 不负责长期记忆、Tool 业务逻辑、复杂模型路由，也不能保存永久 AI 服务商 API Key。Agent、Memory、Tools、Provider 路由和私有业务逻辑全部属于 Aipany 服务端。
