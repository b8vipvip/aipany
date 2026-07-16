# 手机 App

手机 App 是 Aipany 的第一款实时语音设备客户端。

## 初始技术栈

- React Native
- TypeScript
- 原生 WebRTC 集成
- 复用 `@aipany/protocol` 共享类型

## V1 职责

- 麦克风和 Audio Session 权限管理；
- 实时媒体连接；
- AI 远端语音播放；
- 用户打断时立即在本地停止或降低播放音量；
- Session 状态与连接状态 UI；
- 实时字幕渲染；
- 设备注册与 Capability 上报。

## 边界

手机 App 不负责长期记忆、Tool 业务逻辑，也不能保存永久的 AI 服务商 API Key，更不能承载服务商专属的核心编排逻辑。这些能力全部属于服务端。