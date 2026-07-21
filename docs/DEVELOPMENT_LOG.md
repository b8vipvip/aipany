# Aipany 开发记录

> 本文档记录重要业务逻辑、框架、协议和架构决策。后续涉及架构、协议或核心运行逻辑的修改必须同步更新本文件。

## 2026-07-21 · v0.4.5 Realtime First-Audio Latency & Compact LLM Console

### 目标

生产 E2E 已证明完整 `ASR → LLM → TTS` 链路可用，但原先只展示“完整测试总耗时”，容易把测试语音播放时间和整段 TTS 生成时间误认为用户等待时间。

v0.4.5 将实时语音体验的核心指标明确为：

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

即用户真正说完后，到 AI 第一段可播放音频返回的时间。

### E2E 首响时间轴

管理面 E2E 自检新增以下时间点和分段指标：

- 测试输入语音实际时长；
- 客户端 Speech End；
- Server VAD Speech Stopped；
- VAD endpoint latency；
- Transcript Final；
- Speech End → Transcript Final；
- VAD Stopped → Transcript Final；
- Transcript Final → LLM First Token；
- response.audio.started；
- First binary PCM Audio；
- LLM First Token → First PCM Audio；
- Speech End → First PCM Audio；
- 完整测试总耗时。

注意：当前 Gateway 的公开 `transcript.final` 事件在必要的 Speaker Intelligence 等待之后发送，因此 `VAD Stopped → Transcript Final` 可能同时包含 ASR 收尾和必要的声纹/说话人分析等待。v0.4.5 先精确量化该区间，再根据生产实测决定是否调整 Owner Focus 身份判断的等待策略，避免为了低延迟破坏已注册主人的安全过滤语义。

E2E 测试尾部静音从 1.5 秒缩短为 0.8 秒。该静音仍高于默认 500 ms Qwen Server VAD 静音窗口，但减少了测试脚本自身造成的无意义等待。

### TTS 首段低延迟切块

原 `StreamingTextChunker` 默认等待较完整的 8–32 字文本块再送入 TTS。对于实时对话，这可能造成 LLM 已开始流式输出，但 TTS 仍等待更多文字。

v0.4.5 采用两阶段策略：

```text
第一段
→ 4 字后允许在自然停顿标点切分
→ 最多约 18 字强制送入 TTS

后续段落
→ 继续使用较大的常规切块
→ 保持语音自然度和请求效率
```

第一段支持在中文/英文逗号、句号、问号、感叹号、分号、顿号、冒号等自然停顿处分块，从而降低 `LLM First Token → First PCM Audio`。

### 文本 LLM 控制台紧凑列表

原 Provider Card 默认展开全部配置，一个中转站会占用大量纵向空间。

v0.4.5 改为默认单行列表：

```text
选择 | 名称 | Base URL | 模型 | Provider 优先级 | 启用开关 | 操作
```

规则：

- 每个中转站默认只占一行；
- 启用状态改为左右 Switch；
- 模型使用一个单行输入框，以逗号分隔；
- 模型顺序继续代表自动测速后的优先顺序；
- API Key、Provider 独立首 Token 超时、总超时进入“编辑”展开区；
- 测速结果表仅在展开详情中显示；
- Provider 优先级仍由管理员手动控制；
- Model priority 和协议顺序仍由测速自动生成。

### 中转站测速进度

“测试勾选中转站”不再以一个长时间无反馈的批量请求执行。

浏览器改为按中转站顺序逐个调用现有 Relay Test API，并实时显示：

- 当前第几个 / 总数；
- 当前正在测试的中转站；
- 已用时间；
- 总体进度条；
- 当前测试阶段说明；
- 每个中转站完成后的模型可用状态。

单个中转站内部仍执行：

```text
/models 自动发现
→ Responses API 流式测试
→ Chat Completions 流式测试
→ 只保留双协议均成功的模型
→ 按首 Token 延迟排序
```

### 测试

新增回归覆盖：

- PCM 时长计算；
- 首个 TTS 文本块在自然停顿处提前输出；
- 首段无标点时达到低延迟阈值后强制输出；
- 原有长文本切块行为继续有效。

---

## 2026-07-21 · v0.4.4 LLM Failover Latency & Observability

### 背景

生产 E2E 曾出现中转站独立测速首 Token 约 1–2 秒，但完整链路的 LLM 首 Token 偶发达到 14 秒以上。根因之一是旧 `preferredRouteKey` 为进程级全局状态且没有 TTL，配置重新测速或优先级变化后旧成功路由仍可能继续优先。

### 路由状态隔离

- Provider Pool 生成不包含秘密的配置指纹；
- 首选路由只在相同配置指纹内生效；
- 首选路由 TTL 为 5 分钟；
- 配置保存、Relay Benchmark 或配置导入后主动清空 preferred / health；
- 最近请求 Trace 保留用于诊断。

### 自适应首 Token 超时

Relay Model Tester 持久化：

```text
benchmarkAt
benchmarkScoreMs
protocolLatencyMs
```

最近 24 小时存在协议测速时：

```text
adaptiveTimeout = max(4000ms, benchmarkFirstToken * 3 + 1000ms)
effectiveTimeout = min(configuredTimeout, adaptiveTimeout)
```

普通管理页保存 Provider Pool 时保留 benchmark metadata，避免浏览器未显式回传测速字段时丢失自适应超时依据。

### Failover Trace

每次 LLM 请求记录：

- Provider / Model / Protocol；
- 实际尝试顺序；
- 首 Token 超时阈值；
- 实际首 Token；
- 单路由耗时；
- 成功 / 失败 / 取消；
- 失败原因；
- 最终命中路由。

新增：

```text
GET /admin/api/config/llm-routing
```

文本 LLM 页面展示实时路由健康、Preferred TTL、自适应超时、测速延迟、失败次数和冷却状态；诊断页面展示完整 Failover 请求链。

---

## 2026-07-21 · v0.4.3 Admin Console v2 & Provider Diagnostics

### 路由化管理控制台

管理界面拆分为：

```text
/admin/config
/admin/config/dashscope
/admin/config/omni
/admin/config/llm
/admin/config/remote
/admin/config/diagnostics
/admin/config/backup
```

服务端仍使用同一 `AIPANY_ADMIN_TOKEN` 鉴权。Gateway 对 `/admin/config/*` 统一返回控制台 Shell。

### LLM 中转站自动测试

新增 Relay Model Tester：

```text
Provider
↓
/models 自动发现
↓
Responses API stream test
↓
Chat Completions stream test
↓
两种 Aipany 请求方式全部通过
↓
计算首 Token 延迟评分
↓
自动生成 Model priority / protocol order
```

自动配置规则：

- 只有 Responses 与 Chat Completions 都实际返回文本 Token 的模型进入池；
- Legacy Completions 不属于 Aipany 运行时协议，不作为入池条件；
- 模型按两种协议首 Token 平均值排序；
- 每个模型的协议顺序按各协议实测首 Token 延迟排序；
- Provider 优先级由管理员手动设置。

新增：

```text
POST /admin/api/config/relay-test
```

### 管理面 E2E 自检

新增：

```text
POST /admin/api/config/e2e-test
```

链路：

```text
Qwen TTS 生成测试语音
→ 24 kHz PCM 转 16 kHz PCM
→ 内部 WebSocket Realtime Session
→ Qwen Realtime ASR
→ LLM Provider Pool
→ Qwen Realtime TTS
→ Binary PCM 返回
```

自检使用独立 `deployment-test` 会话，不修改用户声纹、会话历史或设备协议。

### 加密配置导出与恢复

新增：

```text
POST /admin/api/config/export
POST /admin/api/config/import
```

普通 `GET /admin/api/config` 只返回密钥是否已配置，不返回明文。完整运行时配置使用：

```text
KDF: scrypt
Cipher: AES-256-GCM
```

加密导出。

备份包含 AI Provider 运行时配置及其密钥，但不包含：

- `AIPANY_ADMIN_TOKEN`；
- JWT Secret；
- 数据库密码；
- Speaker Identity Encryption Key。

---

## 2026-07-21 · v0.4.2 LLM Provider Pool & Failover

### 架构

文本 LLM 从单一：

```text
LLM_BASE_URL
LLM_API_KEY
LLM_MODEL
```

升级为：

```text
Realtime Session
      ↓
OpenAiCompatibleLlm
      ↓
LlmProviderPool
      ↓
Provider A
  ├─ Model A / Responses
  ├─ Model A / Chat Completions
  └─ Model B / Chat Completions
      ↓ failover
Provider B
  ├─ Model C / Responses
  └─ Model D / Chat Completions
```

配置支持：

- 多 Provider；
- 每个 Provider 多 Model；
- `chat_completions` / `responses` 双协议；
- Provider / Model priority；
- 协议顺序；
- 全局及 Provider 独立首 Token / 总超时；
- 失败冷却；
- 单次最大尝试数。

### Failover 边界

以下情况在尚未向用户输出文字前允许切换：

- 首 Token 超时；
- 总请求超时；
- HTTP 非 2xx；
- 流式响应体缺失；
- SSE 结束但没有文本 Token；
- 连接或协议解析错误。

重要规则：

```text
尚未输出任何文字
→ 可以 Failover

已经输出文字后中途失败
→ 不重新调用另一模型
→ 避免重复回答和上下文分叉
```

旧单中转配置会自动迁移为 Legacy Provider。Provider API Key 的公开 snapshot 只返回 `apiKeyConfigured`。

---

## 2026-07-20 · v0.4.1 Server Runtime Configuration Console

### 两层配置模型

```text
启动级配置（.env）
├─ Gateway / JWT
├─ PostgreSQL
├─ Speaker Identity Encryption
└─ Admin Token

运行时 AI 配置（/admin/config）
├─ DashScope ASR / TTS
├─ Qwen Omni
├─ OpenAI-compatible LLM
└─ Remote GPU / SepFormer
```

新增：

```text
GET /admin/config
GET /admin/api/config
PUT /admin/api/config
```

运行时配置由 `RuntimeApiConfigStore` 管理：

- 白名单字段；
- 启动恢复；
- 注入 `process.env`；
- 临时文件 + rename 原子写入；
- 文件权限 `0600`；
- API 密钥读取脱敏。

默认持久化路径：

```text
/data/runtime-api-config.json
```

Docker 使用独立 `runtime-config:/data` 卷，因此容器重建后配置保留。

启动级数据库、JWT、声纹加密密钥不能通过网页修改。

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

`HybridAudioIntelligenceProvider`：

- Local Provider：Speaker Embedding、基础 Diarization、Identity；
- Cloud Provider：Environment Intelligence、Diarized Transcription；
- Remote GPU Provider：SepFormer、Target Speaker Extraction。

Qwen Omni 云端支路使用 PCM → WAV → Base64 input_audio 进行环境、事件和多人转写增强，不替代低延迟 Qwen Realtime ASR。

低配 4 vCPU / 4 GB / 无 GPU 部署原则：

- 本地保留 Gateway、PostgreSQL + pgvector、ECAPA、基础 Diarization、Audio Front-End、Social Conversation Manager；
- 云端承担 Environment、Audio Events、Diarized Transcription；
- Remote GPU 承担 SepFormer / Target Speaker Extraction。

---

## 2026-07-20 · v0.3 Complete Social Voice Architecture

建立完整 Social Voice 基线：

- ECAPA Speaker Embedding；
- 在线 Diarization；
- SepFormer overlap / separation；
- Target Speaker Extraction；
- faster-whisper 分段转写；
- AST Environment Intelligence；
- Streaming Audio Front-End：Beamforming / AEC / NS / AGC / Dereverb；
- `auto / owner_focus / group`；
- Social Conversation Manager；
- Group Transcript；
- Environment risk 主动提醒；
- HS256 JWT 多租户 IAM；
- Speaker Consent / Delete / Audit；
- PostgreSQL + pgvector；
- AES-256-GCM Keyring 和在线密钥轮换。

---

## 2026-07-20 · v0.2.2 Encrypted Speaker Identity Persistence

- Speaker Identity Store 提升为 Gateway 共享依赖；
- PostgreSQL + pgvector；
- Person / Voice Profile / Voice Sample；
- AES-256-GCM canonical embedding 加密；
- tenant/user 隔离；
- keyed orthogonal search projection；
- 人物和声纹删除协议。

---

## 2026-07-20 · v0.2.1 Speaker Intelligence Provider

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

建立：

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
