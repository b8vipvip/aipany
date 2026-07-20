# Aipany

Aipany 第一版已经切换为**级联实时语音架构**：

```text
设备持续音频
   ↓
千问 qwen3-asr-flash-realtime
   ↓ 文字 + 用户情绪
OpenAI 兼容中转站 LLM
   ↓ 流式 Token
Aipany Emotion Director
   ↓ 情绪/语气指令
千问 qwen3-tts-instruct-flash-realtime
   ↓ 流式 PCM
设备连续播放
```

这不是“录完一句再请求”的传统一问一答。客户端只建立一次长连接，麦克风持续上行；ASR、LLM、TTS 全部流式工作，并支持用户在 AI 播放过程中随时插话打断。

## 当前能力

- 长连接持续语音会话
- 千问实时 ASR
- ASR Partial / Final 转写
- ASR 基础情绪识别
- 服务端 VAD
- OpenAI-compatible 中转站 LLM 流式输出
- 千问实时 TTS
- 基于用户情绪的 TTS 语气指令
- Barge-in：用户插话立即取消 LLM/TTS
- 统一客户端事件协议
- 会话上下文裁剪
- 健康检查与 Docker 部署骨架

## 目录

```text
packages/protocol/             客户端与网关统一协议
services/realtime-gateway/     级联实时语音核心服务
  src/providers/               千问 ASR/TTS、中转站 LLM 适配器
  src/pipeline/                情绪导演、流式文本切片
  src/session/                 持续会话、上下文、打断控制
docs/architecture.md           架构与时序
deploy/docker-compose.yml      第一版部署文件
```

## 启动

Node.js 22+：

```bash
cp .env.example .env
# 填写 DASHSCOPE_API_KEY、LLM_API_KEY、LLM_BASE_URL、LLM_MODEL
npm install
npm run dev
```

健康检查：

```bash
curl http://127.0.0.1:3000/health
```

WebSocket：

```text
ws://127.0.0.1:3000/v1/realtime
```

生产环境建议通过 Nginx/Caddy 暴露 `wss://`。

## 客户端协议

连接成功后先发送：

```json
{
  "type": "session.start",
  "session": {
    "userId": "user-001",
    "agentId": "default-agent",
    "locale": "zh-CN",
    "device": {
      "deviceId": "mobile-001",
      "productId": "aipany-mobile",
      "deviceType": "mobile",
      "platform": "android"
    }
  }
}
```

收到 `session.ready` 后，持续发送**二进制 PCM 音频帧**：

```text
PCM S16LE
16000 Hz
Mono
```

服务端下行：

- JSON：`transcript.partial`、`transcript.final`、`response.text.delta`、`response.interrupted` 等控制事件。
- Binary：AI TTS 的 `PCM S16LE / 24000 Hz / Mono` 音频块。

收到 `response.interrupted` 后，客户端必须立即停止播放并清空尚未播放的音频缓冲，才能实现真正的 Barge-in。

## 情绪链路

千问 ASR 当前可返回基础情绪标签，第一版 Emotion Director 会按用户情绪选择回复的声音方向：

```text
sad       → 温暖轻柔
fearful   → 安心稳定
angry     → 冷静克制
happy     → 轻快开心
surprised → 惊喜好奇
neutral   → 自然亲切
```

TTS 默认使用 `qwen3-tts-instruct-flash-realtime`，因为它支持 `instructions`，更适合做拟人化语气控制。模型与声音均可通过环境变量替换。

## 重要说明

第一版先打通核心实时链路，尚未恢复旧版 Admin、数据库、计费、移动 App 和 ESP32 SDK。后续会在这个新内核上重新建设，而不是把旧的 OpenAI Realtime 专用实现继续叠加进去。

架构细节见 `docs/architecture.md`。
