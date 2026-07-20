# Aipany

Aipany 是面向 App、ESP32、智能音箱、AI 玩具和机器人的实时 AI 语音平台。

当前第二版架构：

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
   ├─ Qwen3 Realtime ASR
   └─ Speaker Intelligence Provider
          ↓
      ECAPA Speaker Embedding
          ↓
      Session Speaker Tracking
          ↓
      Voice Profile Matching
   ↓
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

客户端保持长连接，ASR、LLM、TTS 全部流式工作，并支持用户在 AI 播放过程中插话打断。Speaker Intelligence 与 ASR 并行运行，声纹服务异常不会阻断正常语音对话。

## v0.2 / v0.2.1 新增能力

新增 `@aipany/audio-intelligence`：

- `auto / owner_focus / group` 三种交互模式。
- App/设备手动切换模式。
- 自然语言模式命令，例如“大家一起聊吧”“只听我说话”。
- 多人场景自动模式建议框架。
- Social Conversation Manager：回答、保持安静或主动插话。
- 渐进式 Voice Profile，一个人物保存多个不同环境下的声纹样本。
- 多次样本一致后才把人物从 `learning` 提升为 `confirmed`。
- 声纹注册、模式建议和模式切换的统一 Realtime 协议。
- 真实 HTTP Speaker Intelligence Provider。
- SpeechBrain ECAPA-TDNN Speaker Embedding 服务。
- 基于语音轮次 embedding 的会话级 Speaker 聚类。
- `speaker.identified` 与 `speaker.filtered` 事件。
- 专注模式可过滤已经可靠确认的非主人。
- 多人模式可把 `[人物名]` 或 `[speaker_x]` 带入 LLM 对话上下文。

当前已实现真实 Speaker Embedding，但尚未实现多人同时讲话的 Speech Separation、Target Speaker Extraction 和专业 Streaming Diarization。详细边界见 `docs/SPEAKER_INTELLIGENCE.md`。

## 仓库结构

```text
packages/
  protocol/                    客户端与 Gateway 统一协议
  audio-intelligence/          音频智能、声纹记忆、模式和多人社交决策
    src/providers/             Speaker Intelligence Provider 适配层

services/
  realtime-gateway/            持续实时语音核心服务
    src/providers/             Qwen ASR/TTS、中转站 LLM
    src/pipeline/              情绪导演、流式文本切片
    src/session/               会话、打断和 Audio Intelligence 集成
    src/speaker/               VAD 语音轮次声纹分析
  speaker-intelligence/        独立声纹模型服务

docs/
  architecture.md              v0.1 实时语音架构
  SPEAKER_INTELLIGENCE.md      Speaker Provider 架构与能力边界
  DEVELOPMENT_LOG.md           持续开发记录

deploy/
  docker-compose.yml
```

## 启动

Node.js 22+。Speaker Intelligence 通过 Docker Compose 一起启动：

```bash
cp .env.example .env
# 填写 DASHSCOPE_API_KEY、LLM_API_KEY、LLM_BASE_URL、LLM_MODEL

docker compose \
  --env-file .env \
  -f deploy/docker-compose.yml \
  up -d --build
```

Speaker Intelligence 模型首次启动需要下载模型文件，因此第一次启动时间会更长；模型文件缓存在 Docker volume 中。

Gateway 健康检查：

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

## Speaker 事件

识别到一个语音轮次的 Speaker 后：

```json
{
  "type": "speaker.identified",
  "speaker": {
    "sessionSpeakerId": "speaker_2",
    "personName": "小王",
    "isOwner": false,
    "confident": true,
    "similarity": 0.91,
    "observationConfidence": 0.88
  }
}
```

专注模式下，已经可靠确认的非主人会收到：

```json
{
  "type": "speaker.filtered",
  "sessionSpeakerId": "speaker_2",
  "personName": "小王",
  "reason": "owner_focus_non_owner"
}
```

未知或低置信度声音不会直接被过滤，避免误伤真正的设备主人。

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
