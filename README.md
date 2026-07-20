# Aipany v0.4.1

Aipany 是面向 App、智能硬件和实时语音产品的 Social Voice / Audio Intelligence 平台。

v0.4 将重型 Audio Intelligence 从“必须和 Gateway 部署在同一台机器”升级为混合计算架构；v0.4.1 新增服务端运行时配置控制台，使云端 API 与 Remote GPU 参数可以在部署完成后通过网页管理。

```text
                    Aipany Audio Intelligence
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
    Local Realtime       Cloud Intelligence    Remote GPU
          │                   │                   │
     ECAPA 声纹           Qwen Omni            SepFormer
     基础 Diarization     Environment           Speech Separation
     Speaker Tracking     Audio Events          Target Speaker
     AEC / NS / AGC       Diarized Transcript   Extraction
          │                   │                   │
          └───────────────────┴───────────────────┘
                              ↓
                    Social Conversation Manager
                              ↓
                         LLM / Realtime TTS
```

## 核心能力

### Realtime Voice

- Qwen Realtime ASR；
- OpenAI-compatible LLM；
- Qwen Realtime TTS；
- Server VAD；
- Barge-in；
- Streaming Audio Front-End；
- AEC / Noise Suppression / AGC / Dereverb；
- 1–8 声道输入和基础 Beamforming。

### Local Realtime Audio Intelligence

- SpeechBrain ECAPA Speaker Embedding；
- Session Speaker Tracking；
- 基础 Diarization；
- Person / Owner 长期声纹身份；
- PostgreSQL + pgvector；
- AES-256-GCM Keyring；
- Speaker Consent / Delete / Audit。

### Cloud Intelligence

`QwenOmniCloudAudioProvider` 负责按需增强：

- Environment Understanding；
- Audio Event Understanding；
- Cloud Diarized Transcription。

Cloud transcript 会按时间区间合并到本地 diarization segment，因此本地 Speaker Embedding 和长期身份匹配不会丢失。

### Remote GPU

`HttpRemoteTargetSpeakerProvider` 复用 Aipany `/v1/analyze` 协议。

可以把 SepFormer Worker 部署到任意 GPU 环境：

- 腾讯云 GPU / Serverless GPU；
- 阿里云 GPU；
- 独立 GPU 服务器；
- 其他可访问的兼容服务。

支持触发策略：

```text
overlap_only
overlap_or_multi_speaker
always_owner_focus
```

默认使用 `overlap_or_multi_speaker`。

## 低配服务器推荐架构

对于约 4 vCPU / 4 GB RAM / 无 GPU 的 Ubuntu 服务器：

```text
本地：
Gateway
PostgreSQL + pgvector
ECAPA
基础 Diarization
AEC / NS / AGC
Social Conversation Manager

云端：
Qwen Omni Environment
Cloud Diarized Transcription

远程 GPU：
SepFormer
Target Speaker Extraction
```

这样核心服务不需要本机 GPU，也不需要常驻加载 Whisper、AST 和 SepFormer。

## 仓库结构

```text
packages/
  protocol/                       Aipany Realtime Protocol
  audio-intelligence/
    src/providers/
      http-speaker-intelligence-provider.ts
      auto-hybrid-speaker-intelligence-provider.ts
      hybrid-audio-intelligence-provider.ts
      qwen-omni-cloud-audio-provider.ts
      http-remote-target-speaker-provider.ts

services/
  realtime-gateway/
    src/admin/                    服务端运行时配置控制台
  speaker-intelligence/           本地 ECAPA / Diarization / 可选重模型

deploy/
  docker-compose.yml
  postgres/init/

docs/
  DEVELOPMENT_LOG.md
  SPEAKER_INTELLIGENCE.md
  SPEAKER_IDENTITY_PERSISTENCE.md
```

## 启动要求

- Node.js 22+；
- Docker Compose；
- 阿里云百炼账号；
- 一个 OpenAI-compatible LLM API。

复制环境变量：

```bash
cp .env.example .env
```

v0.4.1 中，DashScope、Qwen Omni、LLM 和 Remote GPU 的运行时参数可以先留空，Gateway 仍可启动，之后进入：

```text
https://your-domain/admin/config
```

在页面中填写。

生产环境仍必须在 `.env` 配置启动级参数：

```text
AIPANY_ADMIN_TOKEN
AIPANY_JWT_SECRET
SPEAKER_IDENTITY_STORE=postgres
DATABASE_URL
POSTGRES_PASSWORD
SPEAKER_IDENTITY_ENCRYPTION_KEY
```

推荐生成管理 Token：

```bash
openssl rand -hex 32
```

## 服务端运行时配置控制台

管理页面：

```text
GET /admin/config
```

管理 API：

```text
GET /admin/api/config
PUT /admin/api/config
```

管理 API 使用：

```text
Authorization: Bearer <AIPANY_ADMIN_TOKEN>
```

可管理：

- DashScope API Key / Workspace / ASR / TTS；
- Qwen Omni Cloud Audio；
- OpenAI-compatible LLM；
- Remote GPU / SepFormer Worker；
- Cloud Intelligence 与 Remote Separation 开关。

安全和运行规则：

1. 管理 Token 只来自服务器 `.env`，不会由页面生成或读取；
2. API 密钥读取接口只返回“是否已配置”，不会把已保存的明文密钥返回浏览器；
3. 密码输入框留空表示保留已有值；
4. 运行时配置保存在独立 Docker Volume 中，文件权限为 `0600`；
5. 保存后新建立的 WebSocket 连接使用最新配置，不需要重新构建 Docker 镜像；
6. 数据库密码、JWT、声纹加密密钥等启动级秘密不允许通过该页面修改。

默认持久化位置：

```text
/data/runtime-api-config.json
```

可通过：

```text
AIPANY_RUNTIME_CONFIG_PATH
```

覆盖。

## v0.4 Cloud Intelligence

默认 `.env.example` 使用：

```text
CLOUD_AUDIO_INTELLIGENCE_ENABLED=true
CLOUD_AUDIO_ENVIRONMENT_ENABLED=true
CLOUD_AUDIO_DIARIZED_TRANSCRIPTION_ENABLED=true
QWEN_OMNI_MODEL=qwen3.5-omni-flash
```

`QWEN_OMNI_API_KEY` 留空时复用：

```text
DASHSCOPE_API_KEY
```

如果配置了：

```text
DASHSCOPE_WORKSPACE_ID
```

Qwen Omni 会自动使用北京地域 Workspace 专属 OpenAI-compatible 地址；也可以通过 `QWEN_OMNI_BASE_URL` 显式覆盖。

## v0.4 Local Heavy Models

低配服务器推荐：

```text
SPEECH_SEPARATION_ENABLED=false
SEGMENT_TRANSCRIPTION_ENABLED=false
ENVIRONMENT_INTELLIGENCE_ENABLED=false
TARGET_SPEAKER_EXTRACTION_ENABLED=false
```

注意 Gateway 的能力请求开关仍可以保持：

```text
AUDIO_SEPARATION_ENABLED=true
AUDIO_ENVIRONMENT_ENABLED=true
AUDIO_SEGMENT_TRANSCRIPTION_ENABLED=true
```

这表示系统仍然需要这些能力，但由 Cloud / Remote Provider 提供，而不是本机模型提供。

## Remote SepFormer

准备好 GPU Worker 后可以直接在 `/admin/config` 配置，也可以继续使用环境变量：

```text
REMOTE_SEPARATION_ENABLED=true
REMOTE_SEPARATION_BASE_URL=https://your-gpu-worker.example.com
REMOTE_SEPARATION_TOKEN=your-token
REMOTE_SEPARATION_TIMEOUT_MS=30000
REMOTE_SEPARATION_TRIGGER=overlap_or_multi_speaker
```

远端服务需要兼容 Aipany Audio Intelligence：

```text
GET  /health
GET  /v1/capabilities
POST /v1/analyze
```

现有 `services/speaker-intelligence` 可以直接作为远程 GPU Worker 镜像使用，只需要在 GPU 环境启用 SepFormer。

## Docker Compose 启动

```bash
docker compose --env-file .env -f deploy/docker-compose.yml up -d --build
```

模型首次运行会下载到 Docker Volume。v0.4 低配模式下本地主要加载 ECAPA；SepFormer、Whisper、AST 可以保持关闭。

Gateway：

```text
GET http://127.0.0.1:3000/health
GET http://127.0.0.1:3000/admin/config
WS  ws://127.0.0.1:3000/v1/realtime
```

生产环境建议通过 Nginx / 宝塔反向代理暴露：

```text
https://your-domain/health
https://your-domain/admin/config
wss://your-domain/v1/realtime
```

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

收到 `session.ready` 后持续发送二进制 PCM。

输出：

```text
PCM S16LE / 24000 Hz / Mono
```

收到 `response.interrupted` 后客户端必须立即停止播放并清空本地播放 Buffer。

## 声纹授权

默认要求用户授权后才进行长期人物身份学习：

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

## 设计原则

```text
Cloud Intelligence 失败
Remote GPU 失败
Local Enhancement 失败

都不能阻断：
ASR → LLM → TTS
```

Aipany 的设备协议和 Realtime Session 不绑定具体云厂商。Cloud / GPU Provider 可以持续替换，而不会要求客户端跟着修改协议。
