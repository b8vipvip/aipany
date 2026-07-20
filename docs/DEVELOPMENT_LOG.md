# Aipany 开发记录

> 本文档用于记录每次新增的重要业务逻辑、框架、协议和架构决策。后续功能开发必须同步更新本文件，避免只改代码不留下设计上下文。

## 2026-07-20 · v0.4 Hybrid Cloud Audio Intelligence

### 本次目标

将 v0.3 中需要在单台服务器本地运行的重型 Audio Intelligence 模型拆分为三层：

```text
                    Aipany Audio Intelligence
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
    Local Realtime       Cloud Intelligence    Remote GPU
          │                   │                   │
     ECAPA 声纹           Qwen Omni            SepFormer
     基础 Diarization     Environment           Speech Separation
     Overlap Hints        Audio Event           Target Speaker
     AEC / NS / AGC       Understanding         Extraction
          │                   │
          │                   └─ Cloud Diarized Transcription
          │
          └─────────────── Hybrid Merge ───────────────┘
                              │
                       Realtime Session
```

目标不是删除 v0.3 能力，而是让能力可以根据部署资源被放置到最合理的计算位置。

### 1. Hybrid Audio Intelligence Provider

新增：

```text
HybridAudioIntelligenceProvider
```

职责：

1. Local Provider 负责低延迟 Speaker Embedding、基础 Diarization、Proximity 和本地 overlap hints；
2. Cloud Provider 按需补充 Environment Intelligence 和 Diarized Transcription；
3. Remote GPU Provider 按策略调用 SepFormer Target Speaker Extraction；
4. 云端 transcript 按时间重叠区间合并回本地 diarization segment；
5. 本地 segment embedding 必须保留，以便继续执行长期 Person / Owner Identity 匹配；
6. 任一 Cloud / Remote 增强调用失败都 fail-open，返回已有本地结果。

核心原则：

```text
增强能力失败
≠
Realtime Voice 主链路失败
```

### 2. Gateway 默认入口保持向后兼容

v0.3 Gateway 仍然通过：

```text
HttpSpeakerIntelligenceProvider
```

创建 Audio Intelligence Provider。

v0.4 在包根导出层将该名称映射到：

```text
AutoHybridSpeakerIntelligenceProvider
```

因此现有 `RealtimeSession` 不需要重写，旧构造参数仍然兼容。

自动混合入口根据环境变量决定是否组装：

```text
Local HTTP Provider
+
Qwen Omni Cloud Provider
+
Remote Target Speaker Provider
```

Cloud / Remote 全部关闭时，行为等价于 v0.3 本地 HTTP Provider。

### 3. Qwen Omni Cloud Audio Provider

新增：

```text
QwenOmniCloudAudioProvider
```

采用阿里云百炼 Qwen-Omni OpenAI-compatible Chat API。

输入：

```text
PCM utterance
↓
WAV container
↓
Base64 input_audio
```

输出统一解析为：

```json
{
  "environment": {
    "scene": "street",
    "sceneConfidence": 0.9,
    "noiseLevel": "medium",
    "events": []
  },
  "segments": [
    {
      "speakerId": "speaker_1",
      "startMs": 0,
      "endMs": 1200,
      "confidence": 0.9,
      "overlap": false,
      "transcript": "..."
    }
  ]
}
```

Provider 使用 SSE streaming 响应并只收集文本 delta。

Cloud Intelligence 是非实时增强支路，不替代 Qwen Realtime ASR；普通单人聊天的主 transcript 仍来自低延迟实时 ASR。

### 4. Cloud Diarized Transcription 合并策略

云端说话人标签不能直接替代本地身份标签，因为云端通常没有 Aipany 长期 Voice Profile embedding。

因此采用：

```text
Local Diarization
speaker + embedding + time range
             │
             ├──── Time-overlap alignment ────┐
             │                                │
Cloud Diarized Transcript                     │
cloud speaker + transcript + time range       │
             │                                │
             └────────────────────────────────┘
                              ↓
Local stable speaker ID
+
Local embedding
+
Cloud transcript
```

这样 `SessionSpeakerTracker`、Owner Voice Profile、Person Identity 和 Group Transcript 都继续工作。

### 5. Remote GPU SepFormer

新增：

```text
HttpRemoteTargetSpeakerProvider
```

不新增专有远程协议，而是复用现有：

```text
POST /v1/analyze
```

远端只要部署兼容 Aipany Audio Intelligence API 的 GPU Worker，即可运行 SepFormer。

这意味着 Remote GPU 可以部署在：

- 腾讯云 GPU / Serverless GPU；
- 阿里云 GPU；
- 独立 GPU 服务器；
- 其他兼容 HTTP 网络环境。

Gateway 不关心底层 GPU 厂商。

### 6. Remote Separation Trigger

支持三种远程 GPU 触发策略：

```text
overlap_only
overlap_or_multi_speaker
always_owner_focus
```

默认：

```text
overlap_or_multi_speaker
```

理由：关闭本地 SepFormer 后，本地精确 overlap detection 能力会降低，因此当一个 VAD utterance 内基础 Diarization 已出现多个说话人时，也允许触发 Remote GPU。

对于噪声复杂、Owner Focus 要求非常严格的部署，可以使用：

```text
always_owner_focus
```

用成本换取更稳定的主人音轨提取。

### 7. Gateway 能力请求与本地模型加载解耦

v0.4 明确区分两组开关。

Gateway 请求能力：

```text
AUDIO_DIARIZATION_ENABLED
AUDIO_SEPARATION_ENABLED
AUDIO_ENVIRONMENT_ENABLED
AUDIO_SEGMENT_TRANSCRIPTION_ENABLED
```

本地 Python 模型加载能力：

```text
DIARIZATION_ENABLED
SPEECH_SEPARATION_ENABLED
ENVIRONMENT_INTELLIGENCE_ENABLED
SEGMENT_TRANSCRIPTION_ENABLED
```

因此低配服务器可以配置：

```text
Gateway:
  AUDIO_SEPARATION_ENABLED=true
  AUDIO_ENVIRONMENT_ENABLED=true
  AUDIO_SEGMENT_TRANSCRIPTION_ENABLED=true

Local Service:
  SPEECH_SEPARATION_ENABLED=false
  ENVIRONMENT_INTELLIGENCE_ENABLED=false
  SEGMENT_TRANSCRIPTION_ENABLED=false
```

含义是“系统需要这些能力”，但能力由 Cloud / Remote Provider 满足，而不是在本机加载重模型。

### 8. 低配 Ubuntu 推荐部署

对于 4 vCPU / 4 GB RAM / 无 GPU：

本地保留：

- Realtime Gateway；
- PostgreSQL + pgvector；
- ECAPA Speaker Embedding；
- 基础 Diarization；
- Audio Front-End；
- Social Conversation Manager。

迁移到 Cloud：

- Environment Intelligence；
- Audio Event Understanding；
- Diarized Transcription。

迁移到 Remote GPU：

- SepFormer Speech Separation；
- Target Speaker Extraction。

### 9. 新增环境变量

```text
CLOUD_AUDIO_INTELLIGENCE_ENABLED
CLOUD_AUDIO_ENVIRONMENT_ENABLED
CLOUD_AUDIO_DIARIZED_TRANSCRIPTION_ENABLED
CLOUD_AUDIO_TIMEOUT_MS
QWEN_OMNI_API_KEY
QWEN_OMNI_BASE_URL
QWEN_OMNI_MODEL

REMOTE_SEPARATION_ENABLED
REMOTE_SEPARATION_BASE_URL
REMOTE_SEPARATION_TOKEN
REMOTE_SEPARATION_TIMEOUT_MS
REMOTE_SEPARATION_TRIGGER
```

`QWEN_OMNI_API_KEY` 留空时复用 `DASHSCOPE_API_KEY`。

`QWEN_OMNI_BASE_URL` 留空时：

- 有 `DASHSCOPE_WORKSPACE_ID`：自动生成北京地域 Workspace 专属 OpenAI-compatible URL；
- 无 Workspace ID：使用 DashScope compatible-mode 地址。

### 10. 隐私和数据边界

Cloud Audio Intelligence 会把当前短 utterance 发送给配置的云 Provider。

长期声纹数据仍遵循 v0.3 规则：

- 不向 Qwen Omni 发送 Voice Profile centroid；
- 不向 Cloud Diarized Transcription Provider 发送长期人物数据库；
- Owner embedding 只在需要 Remote Target Speaker Extraction 时发送给用户配置的 Remote GPU Worker；
- 长期 Voice Profile 继续由 PostgreSQL 加密存储和租户隔离保护。

后续生产部署应在隐私政策中明确云端音频处理范围。

### 11. 测试策略

新增回归测试覆盖：

- Local identity segment 与 Cloud transcript 的时间对齐；
- Cloud Environment 结果覆盖本地增强结果；
- 多说话人提示触发 Remote Target Speaker；
- Remote Target 命中后标记 overlap；
- Cloud Provider 故障时 fail-open；
- Qwen Omni SSE 文本解析；
- PCM → WAV 输入封装。

---

## 2026-07-20 · v0.3 Complete Social Voice Architecture

### 核心完成

v0.3 建立完整 Social Voice 基线：

- ECAPA Speaker Embedding；
- 在线 Diarization；
- SepFormer overlap / separation；
- Target Speaker Extraction；
- faster-whisper 分段转写；
- AST Environment Intelligence；
- Streaming Audio Front-End：Beamforming / AEC / NS / AGC / Dereverb；
- `auto / owner_focus / group` 模式；
- Social Conversation Manager 实时决策；
- Group Transcript；
- Environment risk 主动提醒；
- HS256 JWT 多租户 IAM；
- Speaker Consent / Delete / Audit；
- PostgreSQL + pgvector 长期身份；
- AES-256-GCM Keyring 和在线密钥轮换。

v0.3 的重模型全部保留为可用本地实现；v0.4 只是增加更适合生产部署的混合计算位置。

---

## 2026-07-20 · v0.2.2 Encrypted Speaker Identity Persistence

### 核心完成

- Speaker Identity Store 提升为 Gateway 共享依赖；
- PostgreSQL + pgvector；
- Person / Voice Profile / Voice Sample；
- AES-256-GCM canonical embedding 加密；
- tenant/user 隔离；
- keyed orthogonal search projection；
- 人物和声纹删除协议。

---

## 2026-07-20 · v0.2.1 Speaker Intelligence Provider

### 核心完成

- 独立 Speaker Intelligence Service；
- SpeechBrain ECAPA-TDNN；
- `HttpSpeakerIntelligenceProvider`；
- Qwen Server VAD 轮次缓存；
- Session Speaker Tracker；
- Speaker Attribution；
- Owner Focus 保守过滤；
- Provider 故障不阻断主语音链路。

---

## 2026-07-20 · v0.2 Audio Intelligence Foundation

建立：

```text
Audio Intelligence
↓
Social Intelligence
↓
Conversation Intelligence
```

并新增 Mode Manager、Progressive Enrollment、Social Conversation Manager 与 Provider 抽象。

---

## 2026-07-20 · v0.1 Cascaded Realtime Voice

建立最初实时链路：

```text
Device PCM
↓
Qwen Realtime ASR
↓
OpenAI-compatible LLM
↓
Emotion Director
↓
Qwen Realtime TTS
↓
Streaming PCM
```

支持 WebSocket、Server VAD、Barge-in、Cancel 和统一 Aipany Protocol。
