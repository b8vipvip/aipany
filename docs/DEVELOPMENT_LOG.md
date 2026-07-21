# Aipany 开发记录

> 本文档记录重要业务逻辑、框架、协议和架构决策。后续涉及架构、协议或核心运行逻辑的修改必须同步更新本文件。

## 2026-07-21 · v0.4.3 Admin Console v2 & Provider Diagnostics

### 目标

将 `/admin/config` 从单页长表单升级为分页面运维控制台，并将生产部署后的三类高频操作内置到 Gateway：

1. 完整 ASR → LLM → TTS E2E 自检；
2. LLM 中转站自动模型发现、双协议兼容测试与首 Token 测速；
3. 运行时 API 配置和密钥的加密导出 / 恢复。

客户端 Realtime Protocol 不发生变化，所有能力仍属于服务端管理面。

### 路由化管理控制台

管理界面拆分为独立路径：

```text
/admin/config
/admin/config/dashscope
/admin/config/omni
/admin/config/llm
/admin/config/remote
/admin/config/diagnostics
/admin/config/backup
```

服务端仍使用同一管理 Token 鉴权模型。浏览器端使用 History API 在页面间切换，Gateway 对 `/admin/config/*` 统一返回管理控制台 Shell，因此不需要额外 Web Server 路由规则。

### LLM 中转站自动测试

新增 `Relay Model Tester`，将原独立中转站测试工具的核心检测逻辑内置到 Gateway，并针对实时语音增加流式首 Token 延迟指标。

测试流程：

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

- 只有 `Responses API` 与 `Chat Completions` 都成功并实际返回文本 Token 的模型，才会自动进入 Provider 模型池；
- Legacy Completions 不属于 Aipany 运行时请求方式，因此不作为自动入池条件；
- 模型评分为两种协议首 Token 延迟的平均值；
- 模型按评分从快到慢生成 `priority = 10, 20, 30...`；
- 每个模型的 `protocols` 按各协议实测首 Token 延迟自动排序；
- Provider / 中转站优先级仍由管理员手动配置；
- 管理界面不再为每个模型创建独立配置卡，每个 Provider 只保留一个统一模型输入框和一张测试结果表。

新增接口：

```text
POST /admin/api/config/relay-test
```

请求可以包含多个 `providerIds`，用于批量测试勾选的中转站。测试完成后，符合条件的模型列表和协议顺序会写回运行时 Provider Pool。

### 管理面 E2E 自检

新增：

```text
POST /admin/api/config/e2e-test
```

完整链路：

```text
Qwen TTS 生成测试语音
↓
24 kHz PCM → 16 kHz PCM
↓
内部 WebSocket Realtime Session
↓
Qwen Realtime ASR
↓
LLM Provider Pool
↓
Qwen Realtime TTS
↓
Binary PCM 返回
```

管理页会展示：

- 输入 TTS 生成字节数和耗时；
- ASR Final 文本；
- LLM 最终文本；
- LLM 首 Token 延迟；
- 返回 TTS PCM 字节数；
- 完整测试总耗时。

自检使用独立 `deployment-test` 会话，不修改用户声纹、会话历史或设备协议。当前内部自检依赖 `AIPANY_GATEWAY_TOKEN` 作为 Legacy Realtime Token。

### 加密配置导出与恢复

新增：

```text
POST /admin/api/config/export
POST /admin/api/config/import
```

普通 `GET /admin/api/config` 仍然只返回密钥是否已配置，不返回明文。

需要完整导出运行时 API 配置时，管理员提供备份密码，服务端使用：

```text
KDF: scrypt
Cipher: AES-256-GCM
```

对完整运行时配置文档加密后返回浏览器下载。

备份包含：

- DashScope / Qwen Omni 运行时 API 配置；
- LLM Provider Pool 和 Provider API Key；
- Remote GPU 运行时配置和 Token。

备份不包含启动级秘密：

- `AIPANY_ADMIN_TOKEN`；
- JWT Secret；
- 数据库密码；
- Speaker Identity Encryption Key。

导入时使用相同密码解密并验证 GCM Authentication Tag，再原子写回运行时配置文件。

`RuntimeApiConfigStore` 同时增加启动环境 baseline：每次应用完整运行时文档前先恢复 `.env` 基线，再叠加运行时值，从而保证导入或删除配置项时不会残留旧的 `process.env` 值。

### 测试

新增回归覆盖：

- 自动模型发现；
- 只保留同时通过 Responses 与 Chat Completions 的模型；
- 根据首 Token 延迟自动生成模型排序和协议顺序；
- 加密备份中不出现 API Key 明文；
- 正确密码可以完整恢复运行时配置；
- 错误密码无法解密备份。

---

## 2026-07-21 · v0.4.2 LLM Provider Pool & Failover

### 背景

v0.4.1 之前 Gateway 只支持单个：

```text
LLM_BASE_URL
LLM_API_KEY
LLM_MODEL
```

真实部署中，中转站可能出现首 Token 延迟异常、请求超时、HTTP 200 但返回非标准内容、同一模型的 Chat Completions / Responses 协议稳定性不同等问题。

v0.4.2 将文本 LLM 层升级为可热更新的 Provider Pool：

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

### 配置模型

运行时配置新增结构化 `llmProviderPool`：

- 一个 Pool 可以包含多个 Provider / 中转站；
- 每个 Provider 可以配置多个模型；
- 每个模型可以启用 `chat_completions`、`responses` 或两者；
- Provider 和 Model 都有独立优先级，数字越小越先尝试；
- 协议数组顺序代表同模型的协议优先级；
- Provider 可以覆盖全局首 Token 超时和总超时。

全局策略：

```text
firstTokenTimeoutMs
  首个有效文本 Token 的等待上限

totalTimeoutMs
  单条路由完整请求的总时间上限

cooldownMs
  失败路由进入冷却的时间

maxAttempts
  单次用户请求最多尝试的路由组合数量
```

### Failover 规则

路由顺序按以下信号综合排序：

1. 未处于冷却的路由优先；
2. 上一次成功路由在健康时优先复用；
3. Provider priority；
4. Model priority；
5. 模型配置中的协议顺序。

以下情况视为路由失败，可以自动切换到下一条路由：

- 首 Token 超时；
- 总请求超时；
- HTTP 非 2xx；
- 流式响应体缺失；
- SSE 结束但没有任何有效文本 Token；
- 连接或协议解析错误。

重要边界：

```text
在尚未向用户输出任何文本 Token 之前失败
→ 允许自动切换

已经向用户输出文本后中途失败
→ 不重新调用下一模型
→ 避免重复回答或上下文分叉
```

### 多协议支持

`LlmProviderPool` 原生支持：

```text
POST /chat/completions
stream=true
→ choices[0].delta.content

POST /responses
stream=true
→ response.output_text.delta
```

因此同一个模型可以配置：

```text
首选 Responses
↓ 失败
备用 Chat Completions
```

也可以反过来。

### 运行时配置与兼容迁移

`RuntimeApiConfigStore` 新增结构化 Provider Pool 持久化。

旧版单中转配置不会失效：

```text
如果还没有 llmProviderPool
↓
自动读取 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
↓
构造 Legacy Provider
```

用户第一次在管理页面保存 Provider Pool 后，新建 WebSocket 会话自动使用新的多路由配置，不需要重新构建 Docker 镜像。

Provider API Key 的读取接口只返回：

```text
apiKeyConfigured: true / false
```

不会将已保存密钥返回浏览器；页面中 Provider ID 保持不变且 Key 输入框留空时，服务端保留原密钥。

### 管理页面

`/admin/config` 的单 LLM 配置升级为可视化 Provider Pool：

- 添加 / 删除中转站；
- 添加 / 删除模型；
- Provider / Model 优先级；
- 首选请求协议；
- 同模型第二协议备用；
- 全局首 Token 超时；
- 全局总超时；
- 冷却时间；
- 最大尝试次数；
- Provider 独立超时覆盖。

新增服务端测试接口：

```text
POST /admin/api/config/llm-test
```

可以从管理页面直接测试指定：

```text
Provider + Model + Protocol
```

### 测试

新增回归覆盖：

- 第一条路由首 Token 超时后切换到下一 Provider；
- Responses API `response.output_text.delta` 流式解析；
- HTTP 200 但无文本 Token 时继续 Failover；
- Provider Pool API Key snapshot 脱敏；
- Provider Key 留空更新时保留原密钥；
- Provider Pool 持久化并在进程环境中热应用。

---

## 2026-07-20 · v0.4.1 Server Runtime Configuration Console

### 目标

将 AI Provider 配置从“部署前必须手工编辑 `.env`”调整为两层配置模型：

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

这样生产服务器可以先完成 Docker 部署，再通过浏览器配置或更换 AI Provider，不需要重新构建镜像。

### 服务端管理入口

新增页面：

```text
GET /admin/config
```

新增管理 API：

```text
GET /admin/api/config
PUT /admin/api/config
```

管理 API 由 `AIPANY_ADMIN_TOKEN` 保护。

页面可配置：

- DashScope Key、Workspace、ASR/TTS 地址和模型；
- Qwen Omni Key、地址、模型及 Cloud Audio 开关；
- OpenAI-compatible LLM 地址、Key 和模型；
- Remote GPU 地址、Token、超时和触发策略。

数据库、JWT、声纹加密密钥等启动级配置不允许通过页面修改。

### RuntimeApiConfigStore

新增 `RuntimeApiConfigStore`，负责：

1. 只接受白名单中的运行时配置项；
2. 启动时从持久化文件恢复配置；
3. 将恢复或新保存的配置注入当前进程环境；
4. 使用临时文件加 rename 的方式原子写入；
5. 持久化文件权限设置为 `0600`；
6. 对读取接口隐藏 API 密钥具体值，只返回是否已经配置。

默认文件：

```text
/data/runtime-api-config.json
```

可通过 `AIPANY_RUNTIME_CONFIG_PATH` 覆盖。

Docker Compose 新增独立卷：

```text
runtime-config:/data
```

因此容器重建后运行时配置仍然保留。

### 配置热更新边界

Gateway 启动级配置仍在进程启动时固定：

- 监听端口；
- Gateway / JWT 鉴权；
- PostgreSQL；
- Speaker Identity Store。

AI Provider 配置则按新的 WebSocket 连接重新执行 `loadConfig()`。

因此页面保存后：

```text
保存运行时配置
↓
process.env 更新
↓
新建 WebSocket 连接
↓
读取最新 DashScope / LLM / Cloud / Remote 参数
```

不需要重新构建镜像。

### 空 API 配置启动

v0.4.1 放宽启动校验：

- `DASHSCOPE_API_KEY` 可以为空；
- `LLM_API_KEY` 可以为空；
- 空字符串形式的可选 URL 会被视为未配置，而不是非法 URL。

这样 Gateway 可以先启动管理页面，再完成 AI Provider 配置。

### 安全边界

- `AIPANY_ADMIN_TOKEN` 只存在于服务端启动环境；
- 管理 API 使用 Bearer Token；
- Token 比较使用 timing-safe comparison；
- 已保存的 API 密钥不会通过 GET 接口返回浏览器；
- 密码输入框留空表示保留现有值；
- Runtime 配置文件依赖宿主机权限和 Docker Volume 隔离保护，安全边界与传统服务器 `.env` 类似；
- 数据库、JWT、声纹加密主密钥继续只允许由 `.env` / Secret Manager 提供。

### 新增环境变量

```text
AIPANY_ADMIN_TOKEN
AIPANY_RUNTIME_CONFIG_PATH
```

### 测试

新增回归覆盖：

- Admin Token 正确/错误认证；
- Runtime 配置写入与重新加载；
- API 密钥不出现在公开 snapshot；
- 配置文件权限为 `0600`；
- 测试完成后恢复被修改的环境变量。

---

## 2026-07-20 · v0.4 Hybrid Cloud Audio Intelligence

### 架构

v0.4 将重型 Audio Intelligence 拆分为：

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

### Hybrid Provider

新增 `HybridAudioIntelligenceProvider`：

- Local Provider 负责 Speaker Embedding、基础 Diarization 和身份相关数据；
- Cloud Provider 负责 Environment Intelligence 与 Diarized Transcription；
- Remote GPU Provider 负责按策略调用 SepFormer / Target Speaker Extraction；
- Cloud transcript 按时间区间合并回本地 diarization segment；
- Local embedding 始终保留，继续支持 Person / Owner Identity。

Gateway 继续使用兼容名称 `HttpSpeakerIntelligenceProvider`，包根将其映射到 `AutoHybridSpeakerIntelligenceProvider`，因此 RealtimeSession 不需要大规模重写。

### Qwen Omni Cloud Audio

新增 `QwenOmniCloudAudioProvider`：

```text
PCM utterance
↓
WAV
↓
Base64 input_audio
↓
Qwen Omni
↓
Environment + Audio Events + Diarized Transcript
```

Cloud Intelligence 是增强支路，不替代低延迟 Qwen Realtime ASR。

### Remote GPU

新增 `HttpRemoteTargetSpeakerProvider`，复用：

```text
POST /v1/analyze
```

支持：

```text
overlap_only
overlap_or_multi_speaker
always_owner_focus
```

默认 `overlap_or_multi_speaker`。

### 低配服务器部署

对于 4 vCPU / 4 GB RAM / 无 GPU：

本地保留：

- Realtime Gateway；
- PostgreSQL + pgvector；
- ECAPA；
- 基础 Diarization；
- Audio Front-End；
- Social Conversation Manager。

云端承担：

- Environment Intelligence；
- Audio Event Understanding；
- Diarized Transcription。

Remote GPU 承担：

- SepFormer Speech Separation；
- Target Speaker Extraction。

Gateway 能力请求开关和本地模型加载开关从 v0.4 起正式解耦。

---

## 2026-07-20 · v0.3 Complete Social Voice Architecture

v0.3 建立完整 Social Voice 基线：

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
