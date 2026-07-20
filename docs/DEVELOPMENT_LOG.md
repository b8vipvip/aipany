# Aipany 开发记录

> 本文档用于记录每次新增的重要业务逻辑、框架、协议和架构决策。后续功能开发必须同步更新本文件，避免只改代码不留下设计上下文。

## 2026-07-20 · v0.2.2 Encrypted Speaker Identity Persistence

### 本次目标

解决 v0.2.1 的核心限制：人物声纹只存在于单个 `RealtimeSession` 的内存中，无法跨会话共享，更无法在 Gateway 重启后保留。

本次把身份链路升级为：

```text
Realtime Session
↓
AudioIntelligenceEngine（会话级 Mode / Social 状态）
↓
共享 SpeakerIdentityStore
├─ InMemorySpeakerIdentityStore
└─ PostgresSpeakerIdentityStore
   ↓
PostgreSQL + pgvector
```

### 修正身份 Store 生命周期

v0.2.1 在每个 `RealtimeSession.start()` 中创建新的 `AudioIntelligenceEngine`，而 Engine 内部又创建独立的 `InMemorySpeakerIdentityStore`。

这意味着即使服务器不重启，人物声纹也无法自然跨 WebSocket 会话复用。

v0.2.2 改为：

- Gateway 启动时创建一个共享 `SpeakerIdentityStore`；
- 每个实时会话继续拥有独立 `ModeManager`、`SocialConversationManager` 和 Enrollment 会话状态；
- 每个 Engine 使用自己的 `tenantId + userId` 身份作用域访问共享 Store；
- PostgreSQL Store 可以被多个 Gateway 实例共同使用。

### 统一异步 Speaker Identity Store

新增稳定接口：

```text
SpeakerIdentityStore
├─ createPerson
├─ getPerson
├─ listPeople
├─ getProfileByPerson
├─ addVoiceSample
├─ identify
├─ deletePerson
└─ close
```

数据库实现需要异步 I/O，因此 `AudioIntelligenceEngine.observeSpeaker()` 和 `ProgressiveVoiceEnrollmentManager` 的持久化相关路径已经升级为异步。

Speaker Provider 或 Identity Store 异常仍然不能成为 ASR → LLM → TTS 主链路的单点故障。Speaker 分析 Promise 的错误继续由 Realtime Session 捕获并降级。

### PostgreSQL 数据模型

新增初始化迁移：

```text
deploy/postgres/init/001_speaker_identity.sql
```

核心表：

```text
persons
├─ id
├─ tenant_id
├─ user_id
├─ name
├─ relation
├─ is_owner
├─ created_at
└─ updated_at

speaker_profiles
├─ id
├─ person_id
├─ status
├─ confidence
├─ centroid_encrypted
├─ centroid_search_embedding
├─ embedding_dimensions
├─ sample_count
├─ created_at
└─ updated_at

speaker_samples
├─ id
├─ profile_id
├─ encrypted_embedding
├─ quality
├─ environment
├─ proximity
├─ source_session_id
└─ created_at
```

`persons → speaker_profiles → speaker_samples` 使用级联删除，删除人物时会同时删除长期声纹数据。

### 声纹加密存储

Canonical Speaker Embedding 不直接明文写入数据库。

当前实现：

```text
Voice Sample / Centroid
↓
JSON 序列化
↓
AES-256-GCM
├─ 32-byte server key
├─ random 96-bit IV
├─ authentication tag
└─ AAD 绑定 tenant / user / profile / sample
↓
BYTEA
```

因此把某个租户的密文复制到另一个租户或人物上下文后，AAD 不一致会导致认证解密失败。

当前不默认保存注册原始录音，只保存声纹 embedding 及样本质量、环境、距离和来源会话等元数据。

### pgvector 候选召回策略

直接把 canonical embedding 放入 pgvector 会绕过应用层加密，因此 v0.2.2 不这样做。

当前使用：

```text
Canonical Embedding
↓
按 tenantId + userId 派生搜索投影上下文
↓
密钥派生 Signed Permutation 正交变换
↓
pgvector centroid_search_embedding
```

该变换保持 cosine similarity，因此 pgvector 可以先召回候选 Profile；最终身份评分仍会：

1. 解密候选 centroid；
2. 解密候选 Voice Samples；
3. 使用原有 top samples + centroid 评分逻辑做精确判断。

不同 tenant/user 作用域使用不同搜索投影，降低数据库泄露后跨作用域直接关联同一声音的风险。

注意：搜索投影仍属于敏感的派生生物识别模板，必须和数据库本身一起严格访问控制，不能视为匿名数据。

### 多租户 / 用户作用域

`session.start.session` 新增：

```json
{
  "tenantId": "tenant-a",
  "userId": "user-123"
}
```

`tenantId` 为兼容旧客户端提供 `default` 默认值。

所有人物读取、样本写入、身份识别和删除都强制带 `tenantId + userId` 条件，避免 Store 层跨作用域读取。

安全边界说明：当前 Gateway 仍主要使用共享 `AIPANY_GATEWAY_TOKEN`，因此生产多租户部署还需要把 tenant/user 身份和真正的认证凭证绑定，不能只信任客户端自报字段。v0.2.2 完成的是数据访问层隔离，不宣称已经完成完整 IAM。

### 删除能力

新增协议：

```text
speaker.identity.delete
speaker.identity.deleted
```

删除操作只能在当前会话的 `tenantId + userId` 作用域内执行。

PostgreSQL 外键使用 `ON DELETE CASCADE`，删除 Person 时其 Profile 和 Samples 一并删除。

### Docker Compose

新增：

```text
postgres
└─ pgvector/pgvector:pg16
```

并增加：

```text
postgres-data
```

持久卷。

全新数据库卷会自动执行 `deploy/postgres/init/001_speaker_identity.sql`。已有数据库或已有数据卷不会因为重新启动容器自动重复执行初始化脚本，升级部署必须显式执行迁移。

### 新环境变量

```text
SPEAKER_IDENTITY_STORE=memory|postgres
DATABASE_URL
SPEAKER_IDENTITY_ENCRYPTION_KEY
SPEAKER_IDENTITY_DATABASE_SSL
SPEAKER_IDENTITY_DB_POOL_MAX
SPEAKER_IDENTITY_MATCH_CANDIDATES
```

默认仍为 `memory`，避免未配置数据库和加密密钥时阻塞现有语音链路。

启用 `postgres` 时必须提供：

- `DATABASE_URL`
- 32 字节 Base64 或 64 位 Hex 的 `SPEAKER_IDENTITY_ENCRYPTION_KEY`

### 验证

新增测试覆盖：

- 多样本 Profile 从 `learning` 进入 `confirmed`；
- 低相似度不强行认人；
- tenant/user 作用域隔离；
- 删除人物同步删除内存 Voice Profile；
- AES-GCM 正确加解密；
- AAD 不一致时拒绝解密；
- 不同作用域使用不同搜索投影；
- 搜索投影保持 cosine similarity。

### 当前仍未完成

v0.2.2 仍不宣称完成：

- 完整用户授权 / IAM；
- 声纹密钥轮换和多版本 keyring；
- 声纹数据访问审计日志；
- Streaming Speaker Diarization；
- Overlap Detection / Speech Separation；
- Target Speaker Extraction；
- Environment Intelligence；
- AEC / NS / AGC / Dereverb / Beamforming。

下一阶段建议继续：

```text
Streaming Speaker Diarization
↓
Speaker-attributed Group Transcript
↓
Social Conversation Manager 完整实时接入
```

详细设计见：

- `docs/SPEAKER_INTELLIGENCE.md`
- `docs/SPEAKER_IDENTITY_PERSISTENCE.md`

---

## 2026-07-20 · v0.2.1 Speaker Intelligence Provider

### 本次目标

把 v0.2 中预留的 Speaker Intelligence 接口接入真实声纹模型，使实时音频产生可用于人物识别和渐进式学习的 Speaker Embedding。

新增链路：

```text
客户端持续 PCM
↓
Qwen Server VAD
↓
UtteranceSpeakerAnalyzer
├─ 350ms pre-roll
└─ 单轮语音缓存
↓
HttpSpeakerIntelligenceProvider
↓
services/speaker-intelligence
↓
SpeechBrain ECAPA-TDNN
↓
SessionSpeakerTracker
↓
SpeakerObservation
↓
Identity / Enrollment / Mode Manager
```

### 已完成

- 独立 Speaker Intelligence Python 服务；
- `speechbrain/spkrec-ecapa-voxceleb` Speaker Embedding；
- HTTP Provider 抽象；
- Qwen Server VAD 轮次边界复用；
- 约 350ms pre-roll；
- 会话级 `speaker_1 / speaker_2 / ...` 在线聚类；
- `speaker.identified` / `speaker.filtered`；
- 多人模式 Speaker Attribution；
- 专注模式只过滤已可靠确认的非主人；
- Speaker Provider 超时或失败时主语音链路继续。

### 能力边界

当前会话级聚类不是专业 Streaming Diarization，不能可靠解决两个人同时讲话，也没有 Speech Separation 或 Target Speaker Extraction。

---

## 2026-07-20 · v0.2 Audio Intelligence Foundation

### 架构升级

Aipany 从单纯的级联实时语音链路升级为：

```text
Audio Intelligence
↓
Social Intelligence
↓
Conversation Intelligence
```

新增 `@aipany/audio-intelligence`，核心模块包括：

- `AudioIntelligenceEngine`
- `ModeManager`
- `SpeakerIdentityStore`
- `ProgressiveVoiceEnrollmentManager`
- `SocialConversationManager`
- Speaker / Diarization / Environment Provider Interfaces

### 交互模式

支持：

- `owner_focus`
- `group`
- `auto`

模式可以通过 App/设备控制、自然语言命令和系统建议切换。

### 渐进式声纹记忆

人物身份采用：

```text
Person
↓
Voice Profile
↓
多个 Voice Sample
↓
加权 centroid + 多样本相似度
```

人物只有在样本数量和内部一致性达到阈值后才进入 `confirmed`。

### Social Conversation Manager

基础动作：

- `respond`
- `stay_silent`
- `intervene`

评分考虑是否明确叫 AI、是否直接提问、自然停顿、重叠讲话、价值、紧急程度、新颖程度、AI 最近插话频率和用户主动程度。

---

## 2026-07-20 · v0.1 Cascaded Realtime Voice

第一版从旧 OpenAI Realtime 专用实现切换为可控的级联实时语音链路：

```text
设备持续 PCM
↓
Qwen3 Realtime ASR
↓
OpenAI-compatible Text LLM
↓
Emotion Director
↓
Qwen3 Realtime TTS
↓
流式 PCM 播放
```

已建立：

- WebSocket 持续会话；
- Streaming ASR；
- Streaming LLM；
- Streaming TTS；
- Server VAD；
- Barge-in；
- LLM / TTS Cancel；
- 客户端播放队列清空协议；
- ASR 情绪 → TTS 表达控制；
- 上下文裁剪。

核心原则保持不变：客户端只依赖 Aipany 统一协议，不直接绑定 Qwen、OpenAI、SpeechBrain 或任何具体 Provider。
