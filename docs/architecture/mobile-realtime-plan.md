# 手机端实时语音接入计划

## 当前完成

手机 App 已经能够：

- 作为统一 `Device` 上报能力；
- 请求 Aipany Voice Session API；
- 获取平台 Session ID 和短期实时语音启动数据；
- 在客户端不保存永久模型密钥；
- 展示 Session 创建和错误状态。

## 下一步 WebRTC 闭环

```text
用户点击开始
  ↓
请求 Aipany Voice Session API
  ↓
获取短期 client secret + realtime endpoint
  ↓
申请麦克风权限
  ↓
创建 RTCPeerConnection
  ↓
加入本地麦克风 Audio Track
  ↓
创建 SDP Offer
  ↓
使用短期凭证交换 SDP Answer
  ↓
建立持续双向音频
  ↓
监听 Data Channel / Realtime Events
  ↓
用户结束或异常时统一释放资源
```

## 客户端边界

手机端只负责：

- 音频采集与播放；
- WebRTC 媒体连接；
- 本地立即打断播放；
- UI 状态；
- 将供应商事件转换为 Aipany 客户端状态。

手机端不负责：

- 永久 API Key；
- Agent 核心 Prompt；
- 长期记忆；
- Tool 业务逻辑；
- 模型供应商路由策略。

## 原生模块策略

WebRTC 需要原生能力，因此正式实时语音开发使用 Expo Development Build，而不是把 Expo Go 当作生产运行环境。

第一版计划使用 `react-native-webrtc` 实现 WebRTC。媒体层后续应继续封装为 Aipany 的 `RealtimeTransport`，避免页面组件直接依赖具体 WebRTC 实现。
