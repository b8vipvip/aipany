# 手机 App 开发说明

## 当前阶段

当前分支已经接入第一版真实 WebRTC 实时语音链路：

```text
手机 App
  ↓ POST /v1/voice/sessions
Aipany Voice Session Service
  ↓
返回短期 Realtime 会话凭证
  ↓
手机获取麦克风 Audio Track
  ↓
RTCPeerConnection + DataChannel
  ↓ SDP 交换
Realtime Voice Provider
  ↓
持续双向实时语音
```

手机端不会保存永久 AI 供应商 API Key。永久密钥只存在于 Aipany 服务端，客户端只在单次会话中使用短期凭证。

## 技术栈

- Expo SDK 55
- React Native 0.83
- TypeScript
- `react-native-webrtc`
- Expo Development Build
- pnpm Monorepo

`react-native-webrtc` 包含原生代码，因此不能使用普通 Expo Go 运行实时语音功能，必须创建包含该原生模块的 Development Build。

## 1. 安装依赖

在仓库根目录执行：

```bash
pnpm install
```

## 2. 配置后端

复制根目录：

```text
.env.example
```

为：

```text
.env
```

至少配置：

```text
AI_REALTIME_API_KEY=你的服务端密钥
OPENAI_REALTIME_MODEL=gpt-realtime-2.1
OPENAI_REALTIME_VOICE=marin
```

启动 Voice Session 后端：

```bash
pnpm --filter @aipany/voice-session dev
```

默认监听：

```text
http://localhost:3000
```

## 3. 配置手机端后端地址

复制：

```text
apps/mobile/.env.example
```

为：

```text
apps/mobile/.env
```

配置：

```text
EXPO_PUBLIC_API_BASE_URL=http://你的后端地址:3000
```

常见地址：

- Android 模拟器访问电脑本机通常使用 `http://10.0.2.2:3000`；
- iOS 模拟器通常可以使用 `http://localhost:3000`；
- 手机真机需要使用电脑在同一局域网中的 IP，例如 `http://192.168.1.100:3000`；
- 真机无法使用电脑的 `localhost` 访问后端。

## 4. 创建 Development Build

由于项目加入了原生 WebRTC 模块，首次运行以及原生依赖发生变化后必须重新构建 Development Build。

### 本地 Android

```bash
pnpm --filter @aipany/mobile android
```

### 本地 iOS

需要 macOS 和 Xcode：

```bash
pnpm --filter @aipany/mobile ios
```

### EAS Build

在 `apps/mobile` 目录配置 Expo / EAS 项目后，可以使用：

```bash
eas build --profile development --platform android
```

或：

```bash
eas build --profile development --platform ios
```

`eas.json` 已包含 development profile。

## 5. 启动 JavaScript 开发服务器

Development Build 安装到模拟器或真机后：

```bash
pnpm --filter @aipany/mobile start
```

## 当前实时语音流程

用户点击“开始语音会话”后：

1. App 创建当前 Device Identity；
2. App 调用 Aipany `/v1/voice/sessions`；
3. 后端检查设备是否具备 `audio_input` 和 `audio_output` Capability；
4. 后端向当前 Realtime Provider 申请短期凭证；
5. App 请求麦克风权限并获取 Audio Track；
6. App 创建 `RTCPeerConnection`；
7. App 将麦克风 Track 加入 PeerConnection；
8. App 创建 `oai-events` DataChannel；
9. App 生成 SDP Offer；
10. App 使用短期凭证完成 SDP 交换；
11. 设置 SDP Answer 后建立持续双向实时音频连接；
12. Realtime 事件通过 DataChannel 返回 App；
13. 结束会话时停止麦克风 Track、关闭 DataChannel 和 PeerConnection。

## 当前 UI 状态

Voice 页面可以显示：

```text
准备开始对话
正在创建安全语音会话
正在启用麦克风
正在建立实时语音连接
已连接，可以直接说话
我在听
正在思考
正在回复
连接失败
```

并提供：

- 开始实时语音会话；
- 麦克风静音 / 恢复；
- 结束会话；
- 最近 Realtime Event 调试显示。

## 下一阶段

下一阶段重点处理真人感和稳定性：

- 验证 Android / iOS 真机音频路由；
- 自动 Barge-in 打断和本地快速停止播放；
- 实时字幕；
- 首包音频和打断延迟指标；
- 断线重连；
- 弱网处理；
- 蓝牙耳机和扬声器路由；
- 将供应商原生事件进一步转换为 `@aipany/protocol` 统一事件。
