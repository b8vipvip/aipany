# Aipany Speaker Intelligence

## 当前实现

Aipany v0.2.2 的 Speaker Intelligence 主链路：

```text
客户端 PCM 16k
↓
Qwen Server VAD
↓
UtteranceSpeakerAnalyzer
├─ 350ms pre-roll
├─ 单轮语音缓存
└─ 最小时长过滤
↓
HTTP Speaker Intelligence Provider
↓
SpeechBrain ECAPA-TDNN
↓
Speaker Embedding
↓
SessionSpeakerTracker
↓
speaker_1 / speaker_2 / speaker_3
↓
AudioIntelligenceEngine
↓
SpeakerIdentityStore
├─ InMemory
└─ PostgreSQL + pgvector + encrypted embeddings
↓
Realtime Session / Mode Manager / Enrollment
```

## Utterance-level Speaker Embedding

当前 Qwen Realtime ASR 提供 VAD 和转写，但不直接提供 Aipany 所需的 Speaker Diarization / Voice Embedding。

第一阶段利用 Server VAD 切出的单轮语音，把满足最小时长要求的 PCM 送到独立 Speaker Intelligence 服务提取 embedding。

当前已经支持：

- 同一会话内区分轮流讲话的不同人；
- 未知说话人稳定映射为 `speaker_1 / speaker_2 / ...`；
- Progressive Voice Enrollment；
- 已确认 Voice Profile 的跨会话人物匹配；
- 专注模式过滤已可靠确认的非主人；
- 多人模式将说话人标签带入 LLM 上下文。

## Speaker Intelligence 模型服务

目录：

```text
services/speaker-intelligence/
```

当前默认模型：

```text
speechbrain/spkrec-ecapa-voxceleb
```

接口：

```text
GET  /health
GET  /v1/capabilities
POST /v1/embedding
```

Gateway 通过：

```text
packages/audio-intelligence/src/providers/http-speaker-intelligence-provider.ts
```

访问该服务，因此未来替换 NeMo、商业 API、自建 GPU 服务时，不需要重写上层身份和多人业务语义。

## 实时延迟与容错

声纹分析和 ASR 并行：

```text
speech_stopped
├─ ASR Final
└─ Speaker Embedding
   ↓
   Identity Store
```

Realtime Session 最多等待 `SPEAKER_ANALYSIS_WAIT_MS` 获取人物归属。

若 Speaker Intelligence 或持久化 Identity Store 暂时失败：

- ASR → LLM → TTS 主链路继续；
- 当前轮次可能没有人物 Attribution；
- 客户端会收到可重试错误；
- 不因为增强能力故障中断基本语音聊天。

## Identity Store 生命周期

v0.2.1 的 Store 跟随单个 `RealtimeSession` 创建，无法真正跨会话记住人物。

v0.2.2 改为 Gateway 级共享 Store：

```text
Gateway
↓
Shared SpeakerIdentityStore
├─ Session A: tenant-a / user-1
├─ Session B: tenant-a / user-1
└─ Session C: tenant-b / user-8
```

Mode、Social 和 Enrollment 状态仍属于各自实时会话；长期人物身份数据由共享 Store 管理。

## Speaker Identity Persistence

启用 PostgreSQL 后：

```text
Person
↓
Voice Profile
↓
Voice Samples
```

长期保存：

- 人物名称和关系；
- Owner 标记；
- Profile 状态和置信度；
- 加密 centroid；
- 加密 sample embeddings；
- 样本质量；
- 环境标签；
- 相对距离；
- 来源会话。

不默认保存：

- 原始注册录音；
- 整段实时会话音频。

完整设计见 `docs/SPEAKER_IDENTITY_PERSISTENCE.md`。

## 专注模式过滤规则

当前采用保守策略：

```text
已确认人物
+
Voice Profile 匹配达到阈值
+
该人物明确不是 Owner
↓
过滤，不进入 LLM
```

未知声音和低置信度声音不会直接丢弃，避免把真正主人误过滤。

后续 Target Speaker Extraction 完成后，专注模式可从“识别后过滤”升级为“直接从混合声音中提取主人音轨”。

## 当前不能解决的场景

### 多人同时讲话

单个 VAD utterance 可能包含多个重叠声音。一个整体 embedding 无法可靠代表其中每个人。

需要：

```text
Overlap Detection
↓
Speech Separation / Target Speaker Extraction
↓
Per-speaker Audio Track
↓
Per-speaker ASR + Embedding
```

### 真正 Streaming Diarization

当前 `SessionSpeakerTracker` 是基于每个完整语音轮次 embedding 的在线聚类，不等价于专业 Streaming Diarization。

未来会接入能够持续输出：

```text
speaker A: 0.0s - 2.7s
speaker B: 2.8s - 5.2s
speaker A: 5.3s - 7.1s
```

的独立 Provider，并继续复用 `SpeakerObservation` 和身份记忆层。

## 数据安全

Speaker Embedding 属于敏感生物识别特征。

v0.2.2 已完成：

- canonical embedding AES-256-GCM 应用层加密；
- tenantId + userId Store 层隔离；
- AAD 绑定身份作用域；
- 不默认保存原始录音；
- 删除 Person 时级联删除 Profile / Samples；
- pgvector 不直接保存 canonical embedding。

仍需后续补齐：

- 正式 IAM，把 tenant/user 身份和可信认证凭证绑定；
- keyring 和密钥轮换；
- 数据访问与删除审计；
- 更完整的用户授权和撤销 UX。
