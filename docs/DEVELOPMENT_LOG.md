# Aipany 开发记录

> 本文档记录重要业务逻辑、框架、协议和架构决策。后续涉及架构、协议或核心运行逻辑的修改必须同步更新本文件。

## 2026-07-21 · v0.4.6 Realtime Endpoint Fast Path

### 目标

v0.4.5 已能精确量化：

```text
Speech End
→ Server VAD Speech Stopped
→ Transcript Final
→ LLM First Token
→ First PCM Audio
```

进一步分析发现，Owner Focus 在 `transcript.final` 对外发送前可能等待 Speaker Intelligence。默认 `SPEAKER_ANALYSIS_WAIT_MS=700`，即使用户尚未授权长期声纹识别，主链路仍可能等待一份当前轮次无法用于身份过滤的分析结果。

v0.4.6 引入独立 `LowLatencyRealtimeSession`，在不重写稳定核心 Session 的前提下增加低延迟策略。

### Consent-aware Speaker Intelligence 等待

规则：

```text
Owner Focus
├─ 需要授权，且当前未授权
│  └─ Speaker Analysis blocking wait = 0ms
│     主 ASR → LLM 链路立即继续
│
├─ 已授权
│  └─ 保留配置的 SPEAKER_ANALYSIS_WAIT_MS
│     继续支持已知人物 / 非主人过滤
│
└─ 部署本身不要求授权
   └─ 保留配置的等待时间
```

Group 模式仍使用 `GROUP_ANALYSIS_WAIT_MS`，不受该优化影响。

Speaker Intelligence Promise 本身不会取消。即使主链路不等待，它仍可在后台完成并继续发送环境、说话人和诊断事件。该策略只移除“无法合法使用身份结果时”的同步阻塞，不关闭增强能力。

当会话中执行：

```text
speaker.consent.grant
speaker.consent.revoke
speaker.consent.status
```

低延迟 Session 会实时重新计算 Owner Focus 的等待策略：授权后恢复原配置等待，撤销后重新进入非阻塞路径。

### 显式 Endpoint Commit

Realtime Protocol 原本已经定义：

```text
input_audio_buffer.commit
```

旧 Gateway 为兼容 Server VAD 保留该事件，但 `commitAudio()` 实际是空操作。

v0.4.6 将其正式接通到 `QwenAsrRealtimeClient.commit()`：

```text
App / Web / ESP32 本地端点检测
→ 判断用户已经说完
→ input_audio_buffer.commit
→ Gateway
→ Qwen Realtime ASR input_audio_buffer.commit
```

因此客户端可以采用双路径：

```text
优先：本地 Endpoint Detection → commit
兜底：Qwen Server VAD
```

这为后续移动端和嵌入式设备降低 `Speech End → ASR Final` 提供协议级快速路径，同时保持现有只发送 PCM 的客户端兼容。

### 实现边界

- 稳定的 `RealtimeSession` 核心逻辑保持不变；
- Gateway 新连接改为实例化 `LowLatencyRealtimeSession`；
- 低延迟层只覆盖 Consent-aware wait 和显式 ASR commit；
- 已授权 Owner Focus 的身份过滤语义不改变；
- Group Social Intelligence 的多人等待策略不改变；
- 未发送 commit 的客户端仍完全依赖 Server VAD，行为与旧版本一致。

### 测试

新增回归覆盖：

- 需要授权但未授权时 Owner Focus 等待为 0；
- 授权后恢复原配置等待；
- 不要求授权的部署保留原等待；
- `input_audio_buffer.commit` 会真实转发到 ASR Provider。

---

## 2026-07-21 · v0.4.5 Realtime First-Audio Latency & Compact LLM Console

### 首响 KPI

实时语音核心指标明确为：

```text
Speech End
→ Server VAD Speech Stopped
→ Transcript Final
→ LLM First Token
→ First PCM Audio
```

首要 KPI：

```text
Speech End → First PCM Audio
```

管理面 E2E 自检记录测试语音长度、VAD endpoint、ASR Final、LLM 首 Token、TTS Audio Started、First PCM 以及各阶段差值。

E2E 尾部静音从 1.5 秒缩短到 0.8 秒，减少测试脚本自身引入的等待。

### TTS 首段低延迟切块

`StreamingTextChunker` 采用两阶段策略：

```text
第一段
→ 4 字后允许自然停顿切分
→ 最多约 18 字强制送入 TTS

后续
→ 使用较大的常规切块
```

目标是降低：

```text
LLM First Token → First PCM Audio
```

### 文本 LLM 控制台

Provider 改为单行紧凑列表：

```text
选择 | 名称 | Base URL | 模型 | Provider 优先级 | 启用开关 | 操作
```

- 模型使用逗号分隔的单行输入；
- API Key 与 Provider 独立超时进入展开编辑区；
- 模型优先级与协议顺序继续由测速生成；
- Provider 优先级由管理员手动设置。

“测试勾选中转站”改为逐站执行并显示当前 Provider、完成数、总数、已用时间和进度条。

---

## 2026-07-21 · v0.4.4 LLM Failover Latency & Observability

### 路由状态隔离

Provider Pool 使用不包含秘密的配置指纹隔离运行时状态：

- Preferred Route 只在相同配置指纹内生效；
- Preferred TTL 为 5 分钟；
- 配置保存、测速和导入后清空 preferred / health；
- 最近请求 Trace 保留用于诊断。

### 自适应首 Token 超时

测速结果持久化：

```text
benchmarkAt
benchmarkScoreMs
protocolLatencyMs
```

最近 24 小时存在对应协议测速时：

```text
adaptiveTimeout = max(4000ms, benchmarkFirstToken * 3 + 1000ms)
effectiveTimeout = min(configuredTimeout, adaptiveTimeout)
```

### Failover Trace

每次真实 LLM 请求记录 Provider、Model、Protocol、尝试顺序、首 Token、超时、失败原因和最终命中路由。

新增：

```text
GET /admin/api/config/llm-routing
```

---

## 2026-07-21 · v0.4.3 Admin Console v2 & Provider Diagnostics

管理控制台拆分为：

```text
/admin/config
/admin/config/dashscope
/admin/config/omni
/admin/config/llm
/admin/config/remote
/admin/config/diagnostics
/admin/config/backup
```

### Relay Model Tester

```text
Provider
→ /models 自动发现
→ Responses API stream test
→ Chat Completions stream test
→ 双协议均返回有效文本
→ 首 Token 评分
→ 自动生成 Model priority / protocol order
```

新增：

```text
POST /admin/api/config/relay-test
```

### 管理面 E2E

新增：

```text
POST /admin/api/config/e2e-test
```

链路：

```text
Qwen TTS 测试语音
→ 24k PCM 转 16k PCM
→ Gateway Realtime Session
→ Qwen ASR
→ LLM Provider Pool
→ Qwen TTS
→ Binary PCM
```

### 配置备份

运行时 AI 配置使用 `scrypt + AES-256-GCM` 加密导出和恢复。备份不包含 Admin Token、JWT Secret、数据库密码和 Speaker Identity Encryption Key。

---

## 2026-07-21 · v0.4.2 LLM Provider Pool & Failover

文本 LLM 从单 Provider 升级为多 Provider / 多 Model / 多协议路由池。

支持：

- Provider 与 Model priority；
- Responses / Chat Completions 协议顺序；
- 首 Token / 总超时；
- 失败冷却；
- 最大尝试路由数；
- Provider 独立超时覆盖。

Failover 只允许发生在尚未向用户输出任何文本之前。已经开始输出后不重新调用下一模型，避免重复回答和上下文分叉。

旧的 `LLM_BASE_URL / LLM_API_KEY / LLM_MODEL` 自动兼容为 Legacy Provider。

Provider API Key 的管理读取只返回 `apiKeyConfigured`，不返回明文。

---

## 2026-07-20 · v0.4.1 Server Runtime Configuration Console

配置分为两层：

```text
启动级配置 (.env)
├─ Gateway / JWT
├─ PostgreSQL
├─ Speaker Identity Encryption
└─ Admin Token

运行时 AI 配置 (/admin/config)
├─ DashScope ASR / TTS
├─ Qwen Omni
├─ LLM Provider
└─ Remote GPU
```

新增：

```text
GET /admin/config
GET /admin/api/config
PUT /admin/api/config
```

运行时配置默认持久化到：

```text
/data/runtime-api-config.json
```

写入采用临时文件 + rename，权限 `0600`。新 WebSocket 会话重新执行 `loadConfig()`，因此 AI Provider 配置热更新不要求重建镜像。

---

## 2026-07-20 · v0.4 Hybrid Cloud Audio Intelligence

### 架构

```text
                    Aipany Audio Intelligence
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
    Local Realtime       Cloud Intelligence    Remote GPU
          │                   │                   │
     ECAPA 声纹           Qwen Omni            SepFormer
     基础 Diarization     Environment           Speech Separation
     Overlap Hints        Audio Events          Target Speaker
     AEC / NS / AGC       Diarized Transcript   Extraction
          │                   │                   │
          └───────────────────┴───────────────────┘
                              ↓
                       Realtime Session
```

核心原则：增强能力失败不能阻断实时语音主链路。

低配服务器保留 Realtime Gateway、PostgreSQL、ECAPA、基础 Diarization、Audio Front-End 与 Social Manager；重型环境理解和多人转写交给云端，可选 SepFormer 交给远程 GPU。

---

## 2026-07-20 · v0.3 Complete Social Voice Architecture

建立完整 Social Voice 基线：

- ECAPA Speaker Embedding；
- 在线 Diarization；
- SepFormer overlap / separation；
- Target Speaker Extraction；
- Streaming Audio Front-End：Beamforming / AEC / NS / AGC / Dereverb；
- `auto / owner_focus / group`；
- Social Conversation Manager；
- Group Transcript；
- Environment risk 主动提醒；
- HS256 JWT 多租户 IAM；
- Speaker Consent / Delete / Audit；
- PostgreSQL + pgvector；
- AES-256-GCM Keyring 与在线密钥轮换。

---

## 2026-07-20 · v0.2.x Audio & Speaker Intelligence Foundation

### v0.2.2

Speaker Identity Store 持久化到 PostgreSQL + pgvector，支持 Person / Voice Profile / Voice Sample、租户隔离、AES-256-GCM canonical embedding 加密和 keyed orthogonal search projection。

### v0.2.1

引入独立 Speaker Intelligence Service、SpeechBrain ECAPA-TDNN、Session Speaker Tracker、Speaker Attribution 和 Owner Focus 保守过滤。Provider 故障不阻断主语音链路。

### v0.2

建立：

```text
Audio Intelligence
→ Social Intelligence
→ Conversation Intelligence
```

并加入 Mode Manager、Progressive Enrollment、Social Conversation Manager 与 Provider 抽象。

---

## 2026-07-20 · v0.1 Cascaded Realtime Voice

初始实时链路：

```text
Device PCM
→ Qwen Realtime ASR
→ OpenAI-compatible LLM
→ Emotion Director
→ Qwen Realtime TTS
→ Streaming PCM
```

支持 WebSocket、Server VAD、Barge-in、Cancel 和统一 Aipany Protocol。
