# Aipany 开发记录

> 本文档用于记录每次新增的重要业务逻辑、框架、协议和架构决策。后续功能开发必须同步更新本文件，避免只改代码不留下设计上下文。

## 2026-07-20 · v0.2.1 Speaker Intelligence Provider

### 本次目标

把 v0.2 中预留的 Speaker Intelligence 接口接入真实声纹模型，使实时音频开始产生可用于人物识别和渐进式学习的 Speaker Embedding。

新增链路：

```text
客户端持续 PCM
↓
Qwen Server VAD
↓
UtteranceSpeakerAnalyzer
↓
HTTP Speaker Intelligence Provider
↓
SpeechBrain ECAPA-TDNN
↓
Speaker Embedding
↓
SessionSpeakerTracker
↓
SpeakerObservation
↓
Identity / Enrollment / Mode Manager
```

### 新增独立模型服务

新增：

```text
services/speaker-intelligence/
```

第一版默认使用 `speechbrain/spkrec-ecapa-voxceleb` 提取 Speaker Embedding。

模型服务接口：

- `GET /health`
- `GET /v1/capabilities`
- `POST /v1/embedding`

当前输入为 `PCM S16LE / 16kHz`。输出包括归一化 embedding、语音时长、模型名称、向量维度和轻量样本质量评分。

模型第一次启动时下载到 Docker 持久卷，Gateway 只通过内部 HTTP 访问模型服务。

### Provider 解耦

新增：

```text
HttpSpeakerIntelligenceProvider
```

Realtime Gateway 不直接依赖 SpeechBrain SDK，而是只依赖统一的 `SpeakerEmbeddingProvider`。

因此未来可以替换为：

- NVIDIA NeMo / TitaNet；
- Streaming Sortformer；
- 商业 Speaker API；
- 自研 GPU 推理服务；
- 其他声纹模型。

上层 Conversation / Mode / Identity 逻辑不需要因为模型变化而重写。

### 实时语音轮次声纹分析

新增：

```text
UtteranceSpeakerAnalyzer
```

它利用现有 Qwen Server VAD：

1. 持续维护约 350ms pre-roll，避免 VAD 事件网络延迟导致句首声纹丢失。
2. `speech_started` 后开始收集当前语音轮次。
3. `speech_stopped` 后异步调用 Speaker Provider。
4. 短于最小时长的片段不送模型，避免无意义推理。
5. Speaker 分析和 ASR Final 并行执行，不阻塞主音频链路。

Realtime Session 只等待有限的 `SPEAKER_ANALYSIS_WAIT_MS`。如果 Speaker Provider 慢或暂时不可用，ASR → LLM → TTS 仍然继续工作。

### 会话级未知说话人追踪

新增：

```text
SessionSpeakerTracker
```

它根据每个语音轮次的 embedding 做会话内在线聚类，将未知声音稳定映射为：

```text
speaker_1
speaker_2
speaker_3
```

该能力解决“同一会话中谁在轮流讲话”的基础问题，但它不是专业 Streaming Diarization，也不能可靠解决多人同时重叠讲话。

### Realtime 协议升级

新增 Speaker Attribution：

```text
sessionSpeakerId
personId
personName
isOwner
confident
similarity
observationConfidence
```

新增事件：

```text
speaker.identified
speaker.filtered
```

`transcript.final` 也可以携带 Speaker Attribution。

多人模式下，进入 LLM 历史的文本会变成：

```text
[小王] 我觉得吃火锅吧
[小李] 我不能吃辣
```

如果还不知道真实名字，则使用：

```text
[speaker_2] ...
```

### 专注模式第一版真实过滤

当满足全部条件时：

```text
Voice Profile 已确认
+
当前 embedding 与该人物匹配达到阈值
+
该人物明确不是 Owner
```

该语音轮次会产生：

```text
speaker.filtered
```

并不会进入 LLM。

为了降低误杀，未知说话人或低置信度匹配不会直接被过滤。

### 渐进式声纹学习开始获得真实样本

v0.2 的 `ProgressiveVoiceEnrollmentManager` 现在可以接收到真实 ECAPA embedding。

注册流程变为：

```text
speaker.enrollment.start
↓
用户/朋友连续说多个语音轮次
↓
每轮提取 embedding
↓
SessionSpeakerTracker 确保样本来自同一会话 Speaker
↓
Voice Profile 累积多个 Voice Sample
↓
内部一致性和样本数量达到阈值
↓
confirmed
```

### 当前明确边界

本版本已经是真实 Speaker Embedding，不再是纯接口占位，但仍未实现：

- Streaming Speaker Diarization；
- 多人同时讲话 Speech Separation；
- Target Speaker Extraction；
- 麦克风阵列 DOA/Beamforming；
- 环境声音分类；
- 跨服务器重启的加密 Voice Profile 持久化。

当前长期人物数据仍使用 `InMemorySpeakerIdentityStore`。这是开发阶段刻意保留的边界，因为声纹属于敏感生物识别数据，不能为了“先保存下来”而直接落明文数据库。

下一优先级：实现加密的持久化 Speaker Identity Store，然后接入真正的 Streaming Diarization / Target Speaker Extraction。

详细设计见：

```text
docs/SPEAKER_INTELLIGENCE.md
```

---

## 2026-07-20 · v0.2 Audio Intelligence Foundation

### 本次目标

Aipany 从单纯的“级联实时语音链路”升级为三层能力模型：

```text
Audio Intelligence
↓
Social Intelligence
↓
Conversation Intelligence
```

现有 `Qwen ASR → LLM → Qwen TTS` 主链路继续保留，新增的音频智能层位于 ASR/Conversation Brain 前后作为会话策略和人物身份基础设施。

### 新增 `@aipany/audio-intelligence`

新增独立工作区包，避免声纹、多人模式和社交逻辑直接耦合到 Realtime Gateway。

当前模块：

- `AudioIntelligenceEngine`：领域统一入口。
- `ModeManager`：管理 `auto / owner_focus / group` 三种交互模式。
- `InMemorySpeakerIdentityStore`：多样本 Voice Profile、声纹聚类基础和身份匹配。
- `ProgressiveVoiceEnrollmentManager`：渐进式声纹学习，不使用“一次录音永久认定”的策略。
- `SocialConversationManager`：决定多人场景下 AI 是回答、保持安静还是主动插话。
- Provider 接口：预留声纹向量、Speaker Diarization、环境声音分析的真实模型实现。

### 交互模式

新增三种用户可配置模式：

1. `owner_focus`：专注模式，目标是只和设备主人交流。
2. `group`：多人聊天模式，允许多人参与，AI 根据场控策略决定是否发言。
3. `auto`：自动模式，Audio Intelligence 根据场景生成模式切换建议。

模式切换支持：

- App/设备发送 `mode.set` 手动设置。
- 用户直接说“大家一起聊吧”“只听我说话”“自动判断”等自然语言命令。
- Speaker Intelligence 检测到稳定多人场景后生成 `mode.suggestion`，由用户确认是否切换。

为了避免频繁打扰，`ModeManager` 内置稳定说话人阈值、观察窗口和建议冷却时间。

### 多人聊天场控

新增 `SocialConversationManager`，目标不是“有人说一句 AI 就回一句”，而是模拟真人参与群聊。

当前评分信号包括：

- 是否明确叫到 AI。
- 是否直接向 AI 提问。
- 当前是否有人类重叠讲话。
- 当前是否存在自然停顿。
- AI 能提供的信息价值、紧急程度和新颖程度。
- AI 最近主动插话次数。
- 距离 AI 上次发言的时间。
- 用户配置的主动参与程度。

输出动作：

- `respond`
- `stay_silent`
- `intervene`

v0.2 先采用透明、可测试的规则评分；后续可以替换成专用策略模型。

### 渐进式声纹记忆

人物身份不再设计为“一个人 = 一个声纹向量”，而是：

```text
Person
↓
Voice Profile
↓
多个 Voice Sample
↓
加权 centroid + 多样本相似度
```

每个样本可记录：

- 环境场景。
- 说话距离。
- 样本质量。
- 来源会话。

人物状态：

- `unknown`
- `learning`
- `confirmed`

只有累计足够样本且内部一致性达到阈值后才进入 `confirmed`。识别新声音时，会同时参考多个历史样本和 profile centroid，降低偶然误认。

### 渐进式人物介绍

新增声纹注册控制协议：

```text
speaker.enrollment.start
speaker.enrollment.started
speaker.enrollment.updated
speaker.enrollment.cancel
speaker.enrollment.cancelled
```

预期完整流程：

```text
主人：这是小王，让他说两句
↓
创建 Person + learning Voice Profile
↓
Speaker Provider 持续提交同一 Speaker 的高质量 embedding
↓
多次样本一致
↓
confirmed
```

当前 Qwen 实时 ASR 不提供 speaker diarization/voice embedding，因此 v0.2 已完成领域接口和 Gateway 闭环，真实声纹样本将在下一阶段接入独立 Speaker Provider 后进入该流程。

### Realtime Gateway 集成

`RealtimeSession` 已接入 `AudioIntelligenceEngine`：

- 会话启动时初始化模式状态。
- 客户端可手动切换模式。
- ASR Final 文本可直接识别自然语言模式命令。
- 模式状态会通过 `mode.changed` 下发。
- 预留 `observeSpeaker()` 统一入口，未来 Diarization/Voiceprint Provider 可直接提交标准化 `SpeakerObservation`。
- Speaker Observation 可同时驱动身份识别、自动模式建议和渐进式声纹学习。

### 尚未实现的真实模型能力

本版本不伪造以下能力：

- 真正的实时 Speaker Diarization。
- Speaker Verification / Identification 神经网络推理。
- Target Speaker Extraction。
- 多人重叠 Speech Separation。
- 环境声音分类模型。

它们已经有 Provider 接口和领域接入点，但需要下一阶段选择本地模型、GPU 服务或第三方 API 后实现。

### 隐私与安全决策

声纹属于高度敏感的生物识别数据。后续持久化实现必须遵循：

- 明确授权后才注册长期声纹。
- 优先保存 embedding，不保存无必要的原始录音。
- 数据库静态加密。
- 多租户严格隔离。
- 支持用户删除人物和声纹数据。
- 声纹身份只作为概率证据，不在低置信度时强行认人。

---

## 2026-07-20 · v0.1 Cascaded Realtime Voice

### 核心架构

第一版从旧的 OpenAI Realtime 专用实现切换为可控的级联实时语音链路：

```text
设备持续 PCM
↓
Qwen3 Realtime ASR
↓
OpenAI-compatible 中转站 LLM
↓
Emotion Director
↓
Qwen3 Realtime TTS
↓
流式 PCM 播放
```

### 已建立能力

- WebSocket 持续会话。
- Streaming ASR。
- Streaming LLM。
- Streaming TTS。
- Server VAD。
- Barge-in 打断。
- ASR 基础情绪 → TTS 语气指令。
- 统一客户端控制事件。
- 上下文裁剪。

### 架构原则

客户端只依赖 Aipany 的统一实时协议，不直接依赖某一家模型厂商。App、Web、ESP32、智能音箱和机器人后续共享同一会话语义。
