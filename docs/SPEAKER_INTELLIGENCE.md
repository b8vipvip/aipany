# Aipany Speaker / Audio Intelligence

## 当前实现：v0.3

Aipany 的 Speaker Intelligence 已经从“单轮 ECAPA embedding”升级为完整的 Audio Intelligence 分析服务。

```text
客户端 PCM 16k（1-8 ch）
        │
        ▼
StreamingAudioFrontEnd
├─ Beamforming Raw Mono ───────────────────────────────┐
└─ AEC / NS / AGC / Dereverb ──→ Qwen Realtime ASR   │
                                                       ▼
                                         Audio Intelligence Service
                                         ├─ ECAPA Speaker Embedding
                                         ├─ Online Diarization
                                         ├─ SepFormer Separation
                                         ├─ Overlap Detection
                                         ├─ Target Speaker Extraction
                                         ├─ faster-whisper Segment ASR
                                         └─ AudioSet AST Environment AI
                                                       │
                                                       ▼
                                           SessionSpeakerTracker
                                                       │
                                                       ▼
                                             Identity / Mode / Social
```

## Speaker Embedding

默认：

```text
speechbrain/spkrec-ecapa-voxceleb
```

ECAPA 在服务启动时加载，是 Speaker Identity 的基础能力。

用途：

- 会话内说话人聚类；
- 长期 Person Voice Profile 匹配；
- Progressive Enrollment；
- 分离音轨身份判断；
- Owner Target Speaker Extraction。

## Online Diarization

每个 Server VAD 语音轮次内部继续切分有效语音区域，然后以滑动时间窗提取 embedding 并在线聚类。

```text
VAD Utterance
↓
Speech Regions
↓
Sliding ECAPA Windows
↓
Online Clustering
↓
Per-speaker Segments
```

Gateway 使用 `SessionSpeakerTracker` 把模型服务返回的轮次内 Speaker 映射为跨轮次稳定的：

```text
speaker_1
speaker_2
speaker_3
```

因此系统可以处理：

```text
A 说话 → B 说话 → A 再说话
```

也可以在一个较长 VAD 轮次内部输出多个 Speaker Segment。

## Overlap Detection / Speech Separation

默认可选模型：

```text
speechbrain/sepformer-wsj02mix
```

处理流程：

```text
Mixed Audio
↓
SepFormer
↓
Source Tracks
↓
Energy Validation
↓
Per-source ECAPA
↓
Distinct Speaker Check
↓
Overlap Detected
```

如果增强模型加载失败，系统退回普通 diarization，不影响核心语音对话。

当前默认 SepFormer 是双源分离模型，主要解决常见“两个人同时说话”场景；更复杂的 3+ 人完全重叠仍属于未来可替换 Provider 的能力边界。

## Target Speaker Extraction

当 `owner_focus` 模式存在已确认 Owner Voice Profile 时：

```text
Mixed Audio
+
Owner centroid
↓
Separated Sources
↓
Cosine Similarity
↓
Best Owner Track
↓
Independent Transcript
```

只有匹配达到阈值时才把目标音轨 transcript 送给 Conversation Brain。

匹配不可靠时保守过滤，避免把旁人内容当成主人命令。

## Group Transcript

多人模式可以输出：

```text
transcript.group
```

每个 segment 包含：

- 时间范围；
- Speaker Attribution；
- transcript；
- overlap；
- confidence。

进入 LLM 历史的文本可以是：

```text
[主人] 明天八点出发吧
[小王] 会不会太早
[小李] 机场比较远
```

分段转写默认使用 `faster-whisper`，加载失败时退回 Qwen 主转写。

## Environment Intelligence

默认模型：

```text
MIT/ast-finetuned-audioset-10-10-0.4593
```

输出：

- scene；
- sceneConfidence；
- noiseLevel；
- environment events。

模型不可用时使用轻量音频能量分析作为 fallback。

环境事件属于概率信号。系统只会在高置信度安全风险事件下提升 Social Manager 的 urgency，不会把普通低置信度分类直接当成事实。

## Audio Front-End 双支路

设计继续遵守：

```text
原始/波束合成音频 → Environment / Speaker Intelligence
增强音频          → ASR
```

原因：

- Noise Suppression 可能删除键盘、交通、施工等环境线索；
- AEC/AGC 后音频更适合 ASR；
- 声纹和环境模型应该尽量看到更接近原始声场的信号。

服务端当前包含：

- Delay-and-Sum Beamforming；
- AEC；
- Noise Suppression；
- AGC；
- Dereverb；
- Soft Limiter。

支持本地 WebRTC APM / 硬件 DSP 的设备仍建议优先设备侧处理。

## Speaker Identity Privacy

长期声纹默认要求：

```text
speaker.consent.grant
```

未授权时：

- 不做长期人物识别；
- 不允许 Enrollment；
- 仍允许匿名 Session Speaker 跟踪；
- 普通语音对话继续工作。

撤销授权可以同时删除所有已保存身份。

PostgreSQL 保存：

```text
persons
speaker_profiles
speaker_samples
speaker_consents
speaker_audit_log
```

不默认保存原始注册音频。

## 加密和 Key Rotation

canonical embedding 使用 AES-256-GCM。

v0.3 keyring 密文带 key id：

```text
active encryption key → 新数据
historical keys       → 旧数据解密
stable search key     → pgvector keyed projection
```

因此数据加密 key 可以轮换，而 pgvector 搜索空间保持稳定。

历史数据重加密：

```bash
npm --workspace @aipany/realtime-gateway run speaker:rotate-keys
```

## API

模型服务：

```text
GET  /health
GET  /v1/capabilities
POST /v1/embedding
POST /v1/analyze
```

`/v1/analyze` 一次语音轮次可以同时返回：

- utterance embedding；
- quality / proximity；
- diarization segments；
- overlapDetected；
- separated speaker transcripts；
- targetSpeaker；
- environment context。

Gateway 始终通过 Provider 接口访问模型服务，不直接耦合 SpeechBrain、Whisper 或 Transformers。

## 容错

Audio Intelligence 是增强层，不是核心语音链路单点故障：

```text
模型服务异常
↓
Speaker / Environment 能力降级
↓
ASR → LLM → TTS 继续运行
```

这条原则后续替换为 GPU 集群、NeMo、商业 API 或自研模型时继续保持。
