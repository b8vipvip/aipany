# Aipany Speaker Intelligence Provider

## 当前实现

Aipany v0.2.1 已接入第一版真实 Speaker Intelligence Provider：

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
Speaker_1 / Speaker_2 / Speaker_3
↓
SpeakerIdentityStore
↓
已知人物 Voice Profile 匹配
↓
Realtime Session / Mode Manager / Enrollment
```

## 为什么先做 utterance-level embedding

当前 Qwen Realtime ASR 提供 VAD 和转写，但不直接提供 Aipany 所需的长期人物声纹向量。第一阶段利用 Server VAD 切出的单轮语音，把 0.7 秒以上的语音片段送给独立 Speaker Intelligence 服务提取 embedding。

这种方式已经可以支持：

- 同一会话内区分轮流讲话的不同人；
- 将未知说话人稳定映射为 `speaker_1 / speaker_2 / ...`；
- 把声纹样本送入 Progressive Voice Enrollment；
- 已确认 Voice Profile 的人物身份匹配；
- 专注模式过滤“已可靠确认的非主人”；
- 多人模式把发言者标签带入 LLM 上下文。

## 当前不能解决的场景

### 多人同时讲话

单个 VAD utterance 可能包含多个重叠声音。一个整体 embedding 无法可靠代表其中每个人，因此当前版本不会宣称已经完成重叠语音分离。

下一阶段需要增加：

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

当前 `SessionSpeakerTracker` 是基于每个轮次 embedding 的在线聚类，不等价于专业 Streaming Diarization。

未来会接入可流式输出“谁在什么时候说话”的 Provider，例如独立部署的 diarization 模型，并继续复用现有 `SpeakerObservation` 领域协议。

## Speaker Intelligence 内部服务

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
packages/audio-intelligence/
  providers/http-speaker-intelligence-provider.ts
```

访问该服务，因此以后替换为 NeMo、商业 API、自建 GPU 服务时，不需要修改 Realtime Session 的上层业务语义。

## 实时延迟策略

声纹分析和 ASR 并行进行：

```text
speech_stopped
├─ ASR Final
└─ Speaker Embedding
```

Realtime Session 最多等待 `SPEAKER_ANALYSIS_WAIT_MS` 获取人物归属。若声纹服务超时，正常语音对话不会被阻塞；Speaker 分析任务仍可继续完成并下发 `speaker.identified` 事件。

因此 Speaker Intelligence 是增强能力，不是 ASR/LLM/TTS 主链路的单点故障。

## 专注模式过滤规则

第一版采用保守策略：

```text
已确认人物
+
Voice Profile 匹配达到阈值
+
该人物明确不是 Owner
↓
过滤，不进入 LLM
```

未知声音、低置信度声音不会直接被丢弃，避免把真正的主人误过滤。

后续 Target Speaker Extraction 完成后，专注模式可以从“识别后过滤”升级为“直接从混合声音中提取主人音轨”。

## 数据安全

Speaker embedding 属于敏感生物识别特征。当前 `InMemorySpeakerIdentityStore` 仍是 v0.2 的开发实现，只在进程内保存；跨重启的服务器持久化尚未在本次 Provider 接入中启用。

正式持久化必须同时完成：

- 明确的用户授权；
- 加密存储；
- 多租户隔离；
- 删除/撤销 Voice Profile；
- 审计记录；
- 不默认保存原始注册录音。

因此下一阶段会优先实现加密的持久化 Speaker Identity Store，再继续做 Streaming Diarization 和 Target Speaker Extraction。
