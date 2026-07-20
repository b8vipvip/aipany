# Aipany

Aipany 是面向 App、ESP32、智能音箱、AI 玩具和机器人的实时 AI 语音平台。

当前第二版架构从单纯的级联实时语音升级为：

```text
Audio Intelligence
↓
Social Intelligence
↓
Conversation Intelligence
↓
Expressive Voice
```

## 当前主链路

```text
设备持续 PCM 音频
   ↓
Aipany Realtime Gateway
   ↓
Qwen3 Realtime ASR
   ↓ 文字 + 基础情绪
Audio / Social Intelligence
   ↓
OpenAI-compatible 中转站 LLM
   ↓ Streaming Token
Emotion Director
   ↓
Qwen3 Realtime TTS
   ↓ Streaming PCM
设备连续播放
```

这不是传统的“录完一句再请求”。客户端保持长连接，ASR、LLM、TTS 全部流式工作，并支持用户在 AI 播放过程中插话打断。

## v0.2 新增能力

新增 `@aipany/audio-intelligence`：

- `auto / owner_focus / group` 三种交互模式。
- App/设备手动切换模式。
- 通过自然语言直接切换模式，例如“大家一起聊吧”“只听我说话”。
- 多人场景自动模式建议框架。
- 多人聊天 Social Conversation Manager，决定回答、保持安静或主动插话。
- 渐进式 Voice Profile，一个人物保存多个不同环境下的声纹样本。
- 多次样本一致后才把人物从 `learning` 提升为 `confirmed`。
- 声纹注册、模式建议和模式切换的统一 Realtime 协议。
- 为 Speaker Diarization、Voice Embedding、环境声音分析预留可插拔 Provider 接口。

当前千问实时 ASR 本身不提供说话人分离和声纹向量，因此 v0.2 已先完成 Audio Intelligence 领域内核、协议和 Gateway 接入。真实 Speaker Provider 将作为下一阶段模型适配器接入，不会伪造“已经能识别人”的效果。

## 仓库结构

```text
packages/
  protocol/                    客户端与 Gateway 统一协议
  audio-intelligence/          音频智能、声纹记忆、模式和多人社交决策

services/
  realtime-gateway/            持续实时语音核心服务
    src/providers/             Qwen ASR/TTS、中转站 LLM
    src/pipeline/              情绪导演、流式文本切片
    src/session/               会话、打断和 Audio Intelligence 集成

docs/
  architecture.md              v0.1 实时语音架构
  DEVELOPMENT_LOG.md           持续开发记录，后续架构变化必须同步维护

deploy/
  docker-compose.yml
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

## 会话启动

```json
{
  "type": "session.start",
  "session": {
    "userId": "user-001",
    "agentId": "default-agent",
    "locale": "zh-CN",
    "interactionMode": "auto",
    "socialProactivity": 0.45,
    "device": {
      "deviceId": "mobile-001",
      "productId": "aipany-mobile",
      "deviceType": "mobile",
      "platform": "android"
    }
  }
}
```

收到 `session.ready` 后持续发送二进制音频：

```text
输入：PCM S16LE / 16000 Hz / Mono
输出：PCM S16LE / 24000 Hz / Mono
```

收到 `response.interrupted` 后，客户端必须立即停止播放并清空尚未播放的音频缓冲，才能实现真正的 Barge-in。

## 模式控制

手动切换：

```json
{
  "type": "mode.set",
  "mode": "group"
}
```

也可以直接对 Aipany 说：

```text
“大家一起聊吧”
“接下来只听我说话”
“以后你自动判断”
```

## 开发记录规则

从 v0.2 开始，所有新增的重要逻辑、框架、协议和架构决策都必须同步更新：

```text
docs/DEVELOPMENT_LOG.md
```

这份文档作为后续持续开发的架构记忆来源。
