# Aipany 开发记录

> 本文档用于记录每次新增的重要业务逻辑、框架、协议和架构决策。后续功能开发必须同步更新本文件，避免只改代码不留下设计上下文。

## 2026-07-20 · v0.3 Complete Social Voice Architecture

### 本次目标

完成 v0.2.x 架构中尚未落地的核心能力，使 Aipany 从“单轮声纹增强的实时语音链路”升级为可实际运行的完整 Social Voice Architecture：

```text
Raw / Multi-channel PCM
        │
        ├─────────────── 原始分析支路 ───────────────────────┐
        │                                                    │
        ▼                                                    ▼
Audio Front-End                                      Audio Intelligence Service
Beamforming                                          ├─ Speaker Embedding
AEC                                                  ├─ Online Diarization
Noise Suppression                                    ├─ Overlap Detection
AGC                                                  ├─ Speech Separation
Dereverb                                             ├─ Target Speaker Extraction
        │                                            ├─ Segment Transcription
        ▼                                            └─ Environment Intelligence
Qwen Realtime ASR                                             │
        │                                                     │
        └──────────────────────┬──────────────────────────────┘
                               ▼
                      Identity + Mode Manager
                               ▼
                    Social Conversation Manager
                  respond / stay_silent / intervene
                               ▼
                      Conversation Brain (LLM)
                               ▼
                        Emotion Director
                               ▼
                      Expressive Realtime TTS
```

### 1. 轮次内在线 Speaker Diarization

`services/speaker-intelligence/app/audio_engine.py` 新增基于 ECAPA embedding 的在线说话人分段：

1. 从 VAD 轮次中检测有效语音区域；
2. 使用滑动时间窗提取 Speaker Embedding；
3. 在线聚类为 `speaker_1 / speaker_2 / ...`；
4. Gateway 再通过 `SessionSpeakerTracker` 将轮次内标签映射到跨轮次稳定 Session Speaker ID；
5. 每个分段可以携带自己的 embedding 和 transcript。

这使多人模式不再只能给“一整个 VAD 轮次”分配一个说话人。

### 2. Overlap Detection + Speech Separation

新增可选 SepFormer 分离链路：

```text
Mixed Audio
↓
SepFormer
↓
Source A / Source B
↓
Energy Validation
+
Per-source Speaker Embedding
↓
Overlap Detection
```

如果第二音源具有足够能量，并且两个音源的 Speaker Embedding 明显不同，则将该轮标记为重叠讲话。

增强模型采用懒加载。SepFormer 加载或推理失败时，系统自动降级到普通 diarization，不阻断实时 ASR / LLM / TTS。

### 3. Target Speaker Extraction

专注模式现在支持目标主人提取：

```text
混合多人声音
+
已确认 Owner Voice Profile centroid
↓
Speech Separation
↓
逐音轨 Speaker Similarity
↓
选择最接近 Owner 的音轨
↓
独立转写 Owner Audio
```

当检测到重叠讲话，并且目标主人匹配达到置信阈值时，Conversation Brain 使用主人音轨的独立 transcript，而不是混合 ASR transcript。

如果无法可靠提取主人，系统采用保守策略过滤该轮，避免把旁人的混合内容误认为主人指令。

### 4. Group Conversation Transcript

Realtime Protocol 新增：

```text
transcript.group
```

每个 segment 包含：

- `startMs / endMs`
- `speaker`
- `text`
- `overlap`
- `confidence`

多人模式进入 LLM 的上下文可以变成：

```text
[主人] 明天八点出发吧
[小王] 会不会太早
[小李] 机场比较远
```

如果人物身份未知，则保留稳定的 `speaker_n` 标签。

### 5. Social Conversation Manager 完整实时接入

此前 Social Manager 只有领域规则，本版本已经接入真实会话状态。

实时输入信号包括：

- 是否明确叫到 Aipany；
- 是否直接向 AI 提问；
- 当前是否存在人类重叠讲话；
- 自然停顿长度；
- 当前内容的 helpfulness / urgency / novelty；
- 最近 AI 主动插话频率；
- 距离 AI 上一次发言的时间；
- 用户配置的 `socialProactivity`；
- Environment Intelligence 的安全风险事件。

输出：

```text
respond
stay_silent
intervene
```

新增 `social.decision` 协议事件，方便客户端和调试系统观察场控决策。

高置信度安全风险允许在自然停顿后触发 `urgent_intervention`，但不会在人类仍重叠讲话时抢话。

### 6. Environment Intelligence

Audio Intelligence Service 新增 AudioSet AST 环境声音分类，默认模型：

```text
MIT/ast-finetuned-audioset-10-10-0.4593
```

输出：

- scene；
- scene confidence；
- noise level；
- top environment events。

AST 不可用时自动降级到基于音频能量的环境估计。

环境结果通过：

```text
environment.updated
```

下发，并作为概率上下文提供给 Conversation Brain。低置信度环境事件不能被当作确定事实；只有高风险事件可以影响主动插话。

### 7. Streaming Audio Front-End

Gateway 新增：

```text
StreamingAudioFrontEnd
```

服务端基础链路包括：

- Delay-and-Sum 多麦 Beamforming；
- AEC：使用服务器实际播放的 TTS PCM 作为 far-end reference；
- Noise Suppression；
- AGC；
- 轻量 Dereverb；
- Soft Limiter。

严格保留双支路：

```text
Beamformed Raw Audio
├─ 原始支路 → Speaker / Environment Intelligence
└─ 增强支路 → AEC / NS / AGC / Dereverb → ASR
```

客户端协议允许声明 1-8 声道 PCM，并可以提供每个麦克风的 `beamformingDelaysSamples`。

说明：服务端实现是通用可运行的基础 DSP，不宣称替代设备侧 WebRTC APM 或专业阵列 DSP。支持这些能力的 App / 硬件仍应优先在本地做低延迟前处理。

### 8. 多租户 IAM

新增 HS256 JWT 鉴权：

- `tenant_id` 绑定 Tenant；
- `sub / user_id` 绑定 User；
- `scope / scopes` 控制 `realtime`、`speaker:read`、`speaker:write`；
- 支持 `iss / aud / exp / nbf` 校验；
- `session.start` 中客户端声明的 tenant/user 必须和 JWT claims 一致。

旧 `AIPANY_GATEWAY_TOKEN` 继续作为兼容模式。

### 9. 声纹授权、撤销和审计

新增协议：

```text
speaker.consent.grant
speaker.consent.revoke
speaker.consent.status
speaker.identity.list
```

默认 `SPEAKER_CONSENT_REQUIRED=true`。

未授权时：

- 可以继续普通实时对话；
- 可以继续匿名 Session Speaker 跟踪和多人模式建议；
- 不进行长期人物身份匹配；
- 不允许开始长期声纹 Enrollment。

撤销授权时可以选择立即删除当前用户全部 Person / Voice Profile / Voice Samples。

PostgreSQL 新增：

```text
speaker_consents
speaker_audit_log
```

审计只记录操作元数据，不记录原始音频和 embedding。

### 10. Speaker Identity Keyring 与密钥轮换

v0.3 新增 `KeyringPostgresSpeakerIdentityStore`。

密文格式升级到 v2：

```text
version
+
key id
+
AES-256-GCM iv
+
auth tag
+
ciphertext
```

能力：

- active key 负责所有新写入；
- keyring 中历史 key 继续解密旧数据；
- v0.2 legacy v1 单密钥密文仍可读取；
- pgvector search key 与数据加密 key 独立；
- 更换 active encryption key 不改变搜索投影空间。

提供：

```bash
npm --workspace @aipany/realtime-gateway run speaker:rotate-keys
```

用于把历史 Profile / Samples 在线重加密到 active key。

### 11. 新增/升级协议

新增：

```text
transcript.group
environment.updated
social.decision
speaker.target.extracted
audio.frontend.metrics
speaker.consent.*
speaker.identity.list
```

`session.start` 新增：

- `assistantAliases`
- `inputAudio.channels`
- `inputAudio.beamformingDelaysSamples`

### 12. 容错原则

完整架构继续遵守：

```text
增强能力失败
≠
核心语音链路失败
```

- Speaker Embedding 失败：继续 ASR / LLM / TTS；
- Diarization 失败：退回单轮 Speaker Embedding；
- SepFormer 失败：退回普通 diarization；
- AST 失败：退回轻量 Environment 估计；
- Whisper segment transcription 失败：退回 Qwen 主 transcript；
- Audio Front-End 单帧异常：记录错误并继续音频输入。

### 13. 验证

新增测试覆盖：

- 多麦波束合成；
- AGC；
- AEC reference；
- Social Turn signals；
- Environment urgency；
- JWT tenant/user 绑定和 scope；
- Keyring v2 加密；
- legacy v1 解密；
- 稳定 search projection；
- AAD 防跨作用域解密。

CI 现在执行：

```text
python3 -m compileall services/speaker-intelligence/app
npm install
npm run typecheck
npm test
npm run build
```

---

## 2026-07-20 · v0.2.2 Encrypted Speaker Identity Persistence

### 核心完成

- 将 `SpeakerIdentityStore` 从单个 `RealtimeSession` 生命周期提升为 Gateway 共享依赖；
- 抽象同步/异步统一 Store 接口；
- 新增 PostgreSQL + pgvector 持久化；
- 数据模型：`persons / speaker_profiles / speaker_samples`；
- canonical centroid / sample embedding 使用 AES-256-GCM 应用层加密；
- AAD 绑定 tenant / user / profile / sample 上下文；
- pgvector 只保存 keyed orthogonal search projection；
- `tenantId + userId` 数据层隔离；
- 新增人物/声纹删除协议；
- PostgreSQL 级联删除 Profile / Samples；
- 默认保留 Memory Store 作为开发和降级实现。

详细设计见 `docs/SPEAKER_IDENTITY_PERSISTENCE.md`。

---

## 2026-07-20 · v0.2.1 Speaker Intelligence Provider

### 核心完成

- 独立 `services/speaker-intelligence` 服务；
- SpeechBrain ECAPA-TDNN Speaker Embedding；
- `HttpSpeakerIntelligenceProvider`；
- Qwen Server VAD 轮次缓存；
- 约 350ms pre-roll；
- 会话级 `SessionSpeakerTracker`；
- `speaker.identified / speaker.filtered`；
- 多人模式 Speaker Attribution；
- 专注模式保守过滤已确认非主人；
- Provider 超时/失败不阻断核心实时语音链路。

---

## 2026-07-20 · v0.2 Audio Intelligence Foundation

### 核心完成

建立三层架构：

```text
Audio Intelligence
↓
Social Intelligence
↓
Conversation Intelligence
```

新增：

- `@aipany/audio-intelligence`；
- `AudioIntelligenceEngine`；
- `ModeManager`；
- `ProgressiveVoiceEnrollmentManager`；
- `SocialConversationManager`；
- `auto / owner_focus / group`；
- Speaker / Diarization / Environment Provider 抽象；
- 多样本 Voice Profile；
- 渐进式人物声纹学习。

---

## 2026-07-20 · v0.1 Cascaded Realtime Voice

### 核心架构

```text
Device PCM
↓
Qwen3 Realtime ASR
↓
OpenAI-compatible Text LLM
↓
Emotion Director
↓
Qwen Realtime TTS
↓
Streaming PCM
```

### 已建立能力

- WebSocket 长连接；
- Streaming ASR / LLM / TTS；
- Server VAD；
- Barge-in；
- LLM / TTS Cancel；
- 客户端播放队列清空协议；
- ASR 情绪到 TTS 表达指令；
- 统一 Aipany Protocol；
- 设备不直接绑定具体 AI Provider。
