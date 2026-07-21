# Aipany 开发记录

> 本文档记录重要业务逻辑、框架、协议、安全边界和架构决策。后续涉及这些内容的修改必须同步更新本文件。

## 2026-07-21 · v0.4.7 Android Realtime Client & Preview Bootstrap

### 目标

将 Aipany 从“服务器端链路验证”推进到可安装的 Android 实时语音客户端，同时保持未来账号系统的可迁移性。

客户端目标体验：

```text
安装 App
→ 授予麦克风权限
→ 自动获得临时 Realtime JWT
→ 自动建立 WSS
→ 直接说话
→ 本地 Endpoint Detection 自动 commit
→ ASR → LLM → TTS
→ 手机扬声器实时播放
```

客户端不显示 Gateway 地址、Token、Tenant ID 或 User ID。API Key、LLM Provider、DashScope Key 等运维配置仍只属于服务端管理面。

### Preview JWT Bootstrap

无账号测试阶段新增：

```text
GET  /v1/mobile/capabilities
POST /v1/mobile/bootstrap
```

`/v1/mobile/bootstrap` 仅在：

```env
AIPANY_MOBILE_PREVIEW_ENABLED=true
```

时启用。

Preview 身份规则：

- 根据设备 ID 的 SHA-256 摘要生成稳定的匿名 Preview User ID，不返回原始设备 ID；
- 服务器使用现有 `AIPANY_JWT_SECRET` 签发短期 HS256 JWT；
- Scope 固定为 `realtime`；
- 不授予 Admin、Speaker Identity Read/Write 等权限；
- 默认有效期 6 小时；
- Bootstrap 进行基础 IP 频率限制；
- 正式账号登录上线后关闭 Preview 模式，并将 Bootstrap 替换为登录换 JWT，Realtime WebSocket 协议无需重写。

相关启动配置：

```env
AIPANY_MOBILE_PREVIEW_ENABLED=false
AIPANY_MOBILE_PREVIEW_TOKEN_TTL_SECONDS=21600
AIPANY_MOBILE_PREVIEW_TENANT=mobile-preview
```

### 服务端能力发现与会话级音色

`GET /v1/mobile/capabilities` 根据当前服务器 TTS 模型返回客户端可用能力，包括：

- 当前兼容音色列表；
- 默认音色；
- 支持的交互模式；
- Local Endpoint Commit；
- Barge-in；
- Realtime Transcript；
- Social Proactivity；
- Per-session Voice。

Realtime Protocol 的 `session.start.session` 新增可选字段：

```text
outputVoice
```

服务端只接受当前 TTS 模型能力表中的音色；非法或不兼容音色自动回退到服务器默认音色。客户端不能通过该字段修改全局 Runtime API 配置。

### Android v0.2 客户端

原 v0.1 测试工具界面改为语音助手界面：

```text
Header / 设置
状态 Pill
实时动态 Voice Orb
小派回答
用户实时转写（可隐藏）
首响延迟
暂停聆听 / 重新连接
```

App 启动后自动连接，不再要求用户输入接口地址或 Token。

设置页当前提供：

- 服务端当前 TTS 模型支持的输出音色；
- `auto / owner_focus / group` 交互模式；
- Social Proactivity；
- Assistant Aliases / 唤醒名；
- Endpoint Detection：快速 / 平衡 / 稳健；
- 本地 Barge-in 开关；
- 实时转写显示开关。

这些设置只涉及用户体验。API Key、LLM 中转站、数据库、JWT Secret 和 Admin Token 不进入客户端。

### Client Endpoint Detection

Android 采集：

```text
16 kHz / mono / PCM16
20 ms frame
```

端点检测：

```text
动态噪声底
→ 连续语音帧确认开始
→ 短静音窗口确认说完
→ input_audio_buffer.commit
```

三档 Profile 只调整静音窗口：

- Fast：更快提交；
- Balanced：默认推荐；
- Stable：更耐自然停顿和噪声。

用户在 AI 播放期间重新开口时，本地 Barge-in 优先清空 AudioTrack 并发送 `response.cancel`。

### Android Audio

输入：

```text
AudioRecord
VOICE_COMMUNICATION
16 kHz PCM16 mono
```

输出：

```text
AudioTrack
USAGE_VOICE_COMMUNICATION
24 kHz PCM16 mono
```

App 继续展示：

```text
Local Endpoint → ASR Final
ASR Final → LLM First Token
LLM First Token → First PCM
Local Endpoint → First PCM
```

### 安全边界

- APK 不内置 Gateway Legacy Token；
- APK 不包含 Admin Token 或 AI Provider API Key；
- Preview JWT 权限仅为 `realtime`；
- Preview 模式是账号系统上线前的临时部署模式，默认关闭；
- 声纹注册、长期人物身份等隐私能力不会通过 Preview JWT 自动开放；
- 正式账号系统上线后使用用户登录签发的 JWT 继承现有 Realtime Protocol。

### 测试与构建

新增：

- Mobile Preview JWT 签名与 Scope 回归测试；
- Preview Device Identity 哈希化测试；
- TTS Voice Capability / fallback 测试；
- Android Endpoint Detection 测试；
- Android WebSocket URL 测试；
- GitHub Actions Android 单元测试与 Debug APK Artifact 构建。

---

## 2026-07-21 · v0.4.6 Realtime Endpoint Fast Path

### Consent-aware Speaker Intelligence 等待

Owner Focus：

```text
需要授权且未授权
→ Speaker Analysis blocking wait = 0ms
→ ASR 主链路立即进入 LLM

已授权
→ 保留 SPEAKER_ANALYSIS_WAIT_MS
→ 继续支持主人 / 非主人过滤
```

Group 模式继续使用 `GROUP_ANALYSIS_WAIT_MS`。

Speaker Intelligence Promise 不取消，仅移除无法合法使用身份结果时的同步阻塞。

### 显式 Endpoint Commit

`input_audio_buffer.commit` 正式接入 `QwenAsrRealtimeClient.commit()`：

```text
App / Web / ESP32 Endpoint Detection
→ input_audio_buffer.commit
→ Gateway
→ Qwen Realtime ASR commit
```

客户端采用：

```text
优先：本地 Endpoint Detection
兜底：Qwen Server VAD
```

---

## 2026-07-21 · v0.4.5 Realtime First-Audio Latency & Compact LLM Console

### 首响 KPI

```text
Speech End
→ Server VAD Speech Stopped
→ Transcript Final
→ LLM First Token
→ First PCM Audio
```

核心 KPI：

```text
Speech End → First PCM Audio
```

管理面 E2E 记录各阶段时间差，测试尾静音从 1.5 秒缩短到 0.8 秒。

### TTS 首段低延迟切块

第一段更早在自然停顿处进入 TTS，后续保持较大常规切块，降低：

```text
LLM First Token → First PCM Audio
```

### 文本 LLM 控制台

Provider 改为紧凑单行列表：

```text
选择 | 名称 | Base URL | 模型 | Provider 优先级 | 启用开关 | 操作
```

Relay Benchmark 改为逐站执行并显示进度、当前 Provider、完成数和已用时间。

---

## 2026-07-21 · v0.4.4 LLM Failover Latency & Observability

Provider Pool 使用不包含秘密的配置指纹隔离运行状态：

- Preferred Route 只在相同配置指纹内生效；
- Preferred TTL 5 分钟；
- 配置保存、测速、导入后清空 preferred / health；
- 最近请求 Trace 用于诊断。

最近 24 小时存在协议测速时：

```text
adaptiveTimeout = max(4000ms, benchmarkFirstToken * 3 + 1000ms)
effectiveTimeout = min(configuredTimeout, adaptiveTimeout)
```

每次 LLM 请求记录 Provider、Model、Protocol、尝试顺序、首 Token、超时、失败原因和最终命中路由。

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

Relay Model Tester：

```text
/models 自动发现
→ Responses API stream test
→ Chat Completions stream test
→ 双协议均返回文本
→ 首 Token 评分
→ 自动生成 Model priority / protocol order
```

新增：

```text
POST /admin/api/config/relay-test
POST /admin/api/config/e2e-test
```

运行时 AI 配置使用 `scrypt + AES-256-GCM` 加密导出和恢复，不包含 Admin Token、JWT Secret、数据库密码和 Speaker Identity Encryption Key。

---

## 2026-07-21 · v0.4.2 LLM Provider Pool & Failover

文本 LLM 从单 Provider 升级为多 Provider / 多 Model / 多协议路由池。

支持：

- Provider / Model priority；
- Responses / Chat Completions；
- 首 Token / 总超时；
- 失败冷却；
- 最大尝试路由数；
- Provider 独立超时覆盖。

Failover 只允许在尚未向用户输出任何文本前发生，避免重复回答和上下文分叉。

旧 `LLM_BASE_URL / LLM_API_KEY / LLM_MODEL` 自动兼容为 Legacy Provider。Provider API Key 的管理读取只返回配置状态，不返回明文。

---

## 2026-07-20 · v0.4.1 Server Runtime Configuration Console

配置分为：

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

运行时配置持久化到 `/data/runtime-api-config.json`，原子写入、权限 `0600`。新 WebSocket 会话重新执行 `loadConfig()`，因此 AI Provider 热更新不要求重建镜像。

---

## 2026-07-20 · v0.4 Hybrid Cloud Audio Intelligence

```text
Local Realtime
├─ ECAPA
├─ 基础 Diarization
└─ Audio Front-End

Cloud Intelligence
├─ Environment
├─ Audio Events
└─ Diarized Transcript

Remote GPU
├─ SepFormer
└─ Target Speaker Extraction
```

核心原则：增强能力失败不能阻断实时语音主链路。

低配服务器保留 Gateway、PostgreSQL、ECAPA、基础 Diarization、Audio Front-End 与 Social Manager，重型能力迁移到 Cloud / Remote GPU。

---

## 2026-07-20 · v0.3 Complete Social Voice Architecture

建立：

- ECAPA Speaker Embedding；
- 在线 Diarization；
- SepFormer overlap / separation；
- Target Speaker Extraction；
- Beamforming / AEC / NS / AGC / Dereverb；
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

Speaker Identity Store 持久化到 PostgreSQL + pgvector，支持 Person / Voice Profile / Voice Sample、租户隔离、AES-256-GCM embedding 加密和 keyed orthogonal search projection。

### v0.2.1

引入 Speaker Intelligence Service、SpeechBrain ECAPA-TDNN、Session Speaker Tracker、Speaker Attribution 与 Owner Focus 保守过滤。Provider 故障不阻断主语音链路。

### v0.2

建立：

```text
Audio Intelligence
→ Social Intelligence
→ Conversation Intelligence
```

加入 Mode Manager、Progressive Enrollment、Social Conversation Manager 与 Provider 抽象。

---

## 2026-07-20 · v0.1 Cascaded Realtime Voice

```text
Device PCM
→ Qwen Realtime ASR
→ OpenAI-compatible LLM
→ Emotion Director
→ Qwen Realtime TTS
→ Streaming PCM
```

支持 WebSocket、Server VAD、Barge-in、Cancel 与统一 Aipany Protocol。
