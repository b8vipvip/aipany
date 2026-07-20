# Aipany

Aipany 是面向 App、ESP32、智能音箱、AI 玩具、机器人和第三方硬件厂商的实时 AI 语音平台。

当前架构：

```text
Audio Intelligence
↓
Social Intelligence
↓
Conversation Intelligence
↓
Expressive Voice
```

## v0.3 完整实时链路

```text
Device PCM 16k / 1-8ch
        │
        ▼
Aipany Realtime Gateway
        │
        ├─ Audio Front-End
        │  ├─ Beamforming
        │  ├─ AEC
        │  ├─ Noise Suppression
        │  ├─ AGC
        │  └─ Dereverb
        │
        ├──────────────→ Qwen3 Realtime ASR
        │
        └─ Raw Analysis Audio
               ↓
          Audio Intelligence Service
          ├─ ECAPA Speaker Embedding
          ├─ Online Speaker Diarization
          ├─ SepFormer Speech Separation
          ├─ Overlap Detection
          ├─ Target Speaker Extraction
          ├─ faster-whisper Segment Transcript
          └─ AudioSet AST Environment Intelligence
               ↓
          Identity / Mode Manager
               ↓
          Social Conversation Manager
          ├─ respond
          ├─ stay_silent
          └─ intervene
               ↓
          OpenAI-compatible Text LLM
               ↓
          Emotion Director
               ↓
          Qwen Realtime TTS
               ↓
          Streaming PCM
```

客户端只连接 Aipany，不直接绑定 Qwen、OpenAI、SpeechBrain、Whisper 或其它具体模型供应商。

## 当前能力

### 实时语音

- WebSocket 长连接；
- Streaming ASR / LLM / TTS；
- Server VAD；
- Barge-in；
- LLM / TTS Cancel；
- 客户端播放 Buffer 清空协议；
- 用户情绪到 TTS 表达指令。

### Audio Intelligence

- ECAPA Speaker Embedding；
- 轮次内在线 Speaker Diarization；
- 跨轮次稳定 `speaker_1 / speaker_2 / ...`；
- 双人重叠语音检测和 SepFormer 分离；
- Owner Target Speaker Extraction；
- 多人分说话人 transcript；
- AudioSet 环境声音分类；
- 相对 proximity 分类；
- 多麦 Delay-and-Sum Beamforming；
- 服务端 AEC / NS / AGC / Dereverb。

### Social Intelligence

- `auto / owner_focus / group`；
- 自然语言模式切换；
- 多人场景模式建议；
- `respond / stay_silent / intervene`；
- 被叫名/直接提问识别；
- helpfulness / urgency / novelty；
- 自然停顿；
- 最近 AI 插话频率；
- Environment risk 主动提醒。

### Long-term Speaker Identity

- Person → Voice Profile → 多 Voice Samples；
- Progressive Enrollment；
- PostgreSQL + pgvector；
- AES-256-GCM canonical embedding 加密；
- tenant/user 隔离；
- keyed orthogonal pgvector projection；
- keyring 和在线密钥轮换；
- Consent 授权/撤销；
- 删除权；
- 安全审计日志；
- 不默认保存原始注册音频。

### IAM

生产环境支持 HS256 JWT：

- `tenant_id`；
- `sub / user_id`；
- `scope / scopes`；
- `iss / aud / exp / nbf`。

Session 中声明的 tenant/user 必须与 JWT claims 一致。

## 仓库结构

```text
packages/
  protocol/                      Aipany Realtime Protocol
  audio-intelligence/            Audio/Social Intelligence 领域层

services/
  realtime-gateway/
    src/audio/                   Audio Front-End
    src/auth.ts                  JWT / Legacy Auth
    src/providers/               ASR / LLM / TTS
    src/session/                 实时会话编排
    src/social/                  Social Turn Evaluator
    src/speaker/                 Utterance Audio Analysis
    src/tools/                   Key Rotation 工具

  speaker-intelligence/
    app/audio_engine.py          Speaker/Diarization/Separation/Environment

deploy/
  docker-compose.yml
  postgres/init/

docs/
  DEVELOPMENT_LOG.md
  SPEAKER_INTELLIGENCE.md
  SPEAKER_IDENTITY_PERSISTENCE.md
```

## 启动

要求：Node.js 22+、Docker Compose。

```bash
cp .env.example .env
```

至少填写：

```text
DASHSCOPE_API_KEY
LLM_BASE_URL
LLM_API_KEY
LLM_MODEL
```

生产部署建议同时配置：

```text
AIPANY_JWT_SECRET
SPEAKER_IDENTITY_STORE=postgres
DATABASE_URL
SPEAKER_IDENTITY_ENCRYPTION_KEY
```

启动：

```bash
docker compose --env-file .env -f deploy/docker-compose.yml up -d --build
```

模型首次使用时会下载到 `speaker-models` Docker Volume。ECAPA 启动时加载；SepFormer、Whisper、AST 按需懒加载。

Gateway：

```text
GET http://127.0.0.1:3000/health
WS  ws://127.0.0.1:3000/v1/realtime
```

生产环境建议通过反向代理暴露 `wss://`。

## 会话启动

```json
{
  "type": "session.start",
  "session": {
    "tenantId": "tenant-001",
    "userId": "user-001",
    "agentId": "default-agent",
    "locale": "zh-CN",
    "assistantAliases": ["Aipany", "小派"],
    "interactionMode": "auto",
    "socialProactivity": 0.45,
    "inputAudio": {
      "encoding": "pcm_s16le",
      "sampleRate": 16000,
      "channels": 1
    },
    "device": {
      "deviceId": "mobile-001",
      "productId": "aipany-mobile",
      "deviceType": "mobile",
      "platform": "android"
    }
  }
}
```

多麦设备可以发送交错 PCM，并配置：

```json
{
  "channels": 4,
  "beamformingDelaysSamples": [0, 2, -1, 1]
}
```

收到 `session.ready` 后持续发送二进制 PCM。

输出仍为：

```text
PCM S16LE / 24000 Hz / Mono
```

收到 `response.interrupted` 后，客户端必须立即停止播放并清空本地播放 Buffer。

## 声纹授权

默认要求授权后才保存/识别长期人物声纹：

```json
{ "type": "speaker.consent.grant" }
```

撤销并删除现有长期身份：

```json
{
  "type": "speaker.consent.revoke",
  "deleteExisting": true
}
```

列出人物：

```json
{ "type": "speaker.identity.list" }
```

## 密钥轮换

兼容单密钥：

```text
SPEAKER_IDENTITY_ENCRYPTION_KEY=<32-byte-base64>
```

Keyring：

```json
{
  "active": "v2",
  "search": "<stable-search-key>",
  "keys": {
    "v2": "<new-encryption-key>",
    "v1": "<old-encryption-key>"
  }
}
```

设置新 active key 后构建 Gateway，然后执行：

```bash
npm --workspace @aipany/realtime-gateway run speaker:rotate-keys
```

历史密文重写完成后可以移除不再需要的数据解密 key；`search` key 必须保持稳定。

## 重要工程原则

```text
Device
↓
Aipany Protocol
↓
Aipany Gateway
↓
Provider Abstraction
├─ ASR
├─ LLM
├─ TTS
├─ Speaker Intelligence
├─ Environment Intelligence
└─ Audio Processing
```

模型、供应商和部署方式都隐藏在 Aipany Server 后面。App 是一种 Device，ESP32 也是一种 Device。

所有重要架构变更必须同步更新 `docs/DEVELOPMENT_LOG.md`。
