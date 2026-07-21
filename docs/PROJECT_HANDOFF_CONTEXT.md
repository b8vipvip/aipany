# Aipany 项目完整交接上下文

> 用途：供新的 ChatGPT / Codex 开发会话直接继续，不需要重新回顾整段历史。
>
> 仓库：`b8vipvip/aipany`
>
> 当前代码基线：Aipany `v0.5.0`，Android `v0.3.0`
>
> v0.5 功能合并基线：PR #23，Merge Commit `93a7912af407722e5fbc36b56f9da5f41c3748fb`

---

## 1. 新聊天接手时必须先知道的原则

1. 后续开发只基于 `main`，不要回到旧架构分支。
2. PR #11 到 #23 的有效开发内容都已经合入 `main`。
3. PR #7、#8、#10 是旧架构重复分支，已经明确关闭，不应重新合并。
4. 生产服务器存在本地低配/中国网络构建覆盖文件，可能没有提交到 GitHub，绝对不要用 `git reset --hard`、`git clean -fd` 或其它会删除本地文件的方式更新服务器。
5. 生产部署始终保留并叠加：

```bash
-f deploy/docker-compose.yml \
-f deploy/docker-compose.cn-lite.yml
```

6. 不要要求用户在聊天中粘贴 Admin Token、API Key、JWT Secret、数据库密码或声纹加密密钥。
7. API Key、LLM 中转站、DashScope 和 Native Live 参数应尽量通过服务端控制台管理；启动级 Secret 继续留在服务器 `.env`。
8. 当前最重要目标不是继续堆功能，而是把实时语音体验做成接近 ChatGPT Live：低首响、自然连续对话、可靠 Barge-in、弱网自动恢复，并能用服务端日志量化判断是否达标。

---

## 2. 当前产品目标

Aipany 是一个面向 App、ESP32/智能硬件和未来机器人设备的实时 AI 语音平台。

当前目标分两条主线：

### 2.1 实时语音体验

实现接近真人/ChatGPT Live 的体验：

- App 启动后自动连接，不要求用户配置 API 或服务器地址；
- 用户持续自然说话；
- AI 尽快开始回应，而不是明显的“一问一答等待”；
- AI 说话期间用户可以立即插话；
- 上一轮音频必须真正停止，不能 flush 后又把旧 PCM 播回来；
- 网络抖动、上游 API 断线时自动恢复；
- 后续支持正式账号登录替代 Preview Bootstrap；
- 手机端稳定后保持协议兼容，继续接 ESP32 等硬件。

### 2.2 服务端可观测与控制面板

需要通过域名直接进入统一运维后台，完成：

- API/模型/中转站配置；
- Native Live / Cascaded 引擎配置；
- LLM Provider Pool 与 Failover 状态；
- 真实 E2E 诊断；
- 实时在线会话；
- WebSocket 断线原因；
- P50/P95 首响延迟；
- Barge-in / 错误 / 重连统计；
- 结构化日志查询；
- 配置加密备份与恢复。

---

## 3. 当前代码架构

```text
Android / Web / ESP32
        │
        │ Aipany WebSocket Protocol
        │ 16 kHz PCM16 mono input
        │ JSON control/events
        │ 24 kHz PCM16 output
        ▼
Realtime Gateway
        │
        ├── Engine = omni_realtime
        │      │
        │      └── Qwen Omni Realtime
        │             ├── Native speech-to-speech
        │             ├── Server/Semantic VAD
        │             ├── Streaming transcript
        │             ├── Streaming audio
        │             └── Native barge-in
        │
        └── Engine = cascaded
               │
               ├── Audio Front-End
               │      ├── AEC
               │      ├── Noise Suppression
               │      ├── AGC
               │      ├── Dereverb
               │      └── Beamforming
               │
               ├── Qwen Realtime ASR
               │
               ├── Audio Intelligence
               │      ├── Local ECAPA / Speaker Tracking
               │      ├── Basic Diarization
               │      ├── Cloud Qwen Omni Intelligence
               │      └── Optional Remote GPU SepFormer
               │
               ├── Social Conversation Manager
               │
               ├── LLM Provider Pool
               │      ├── Multi relay
               │      ├── Multi model
               │      ├── Responses API
               │      ├── Chat Completions
               │      └── First-token failover
               │
               └── Qwen Realtime TTS
```

### Engine 选择

运行时支持：

```text
auto
omni_realtime
cascaded
```

`auto`：Native Live 可用时优先 `omni_realtime`；Native Live 初始化失败时自动回退到 `cascaded`。

注意：如果 Native Live 已经启动后中途上游断开，当前实现不会在同一 WebSocket 内无缝切成 Cascaded，而是关闭客户端连接（1011），让 Android 自动重连；下一次连接再尝试 Native Live 或初始化阶段回退 Cascaded。

---

## 4. 已完成的重要版本演进

### v0.3

完成完整 Audio Intelligence / Social Intelligence / Speaker Identity 基线：

- ECAPA Speaker Embedding；
- Session Speaker Tracking；
- 基础 Diarization；
- PostgreSQL + pgvector；
- Person / Voice Profile / Samples；
- Speaker Consent；
- AES-256-GCM Keyring；
- JWT tenant/user/scope 绑定；
- `auto / owner_focus / group`；
- Social Turn Evaluator；
- Audio Front-End；
- Speaker Identity Key Rotation。

### v0.4

重型 Audio Intelligence 改为混合架构：

- Local Realtime：ECAPA、基础 diarization；
- Cloud Intelligence：Qwen Omni 环境理解、音频事件、多人转写；
- Remote GPU：SepFormer / Target Speaker Extraction；
- 低配服务器不需要本机长期加载 Whisper、AST、SepFormer。

### v0.4.1

增加运行时 API 配置存储与 Web 控制台：

- `/data/runtime-api-config.json`；
- 密钥不回显明文；
- 保存后新 WebSocket 会话使用新配置；
- 不需要重新构建镜像。

### v0.4.2+

完成 LLM Provider Pool 与后续迭代：

- 多中转站；
- 多模型；
- 每模型支持 `chat_completions` / `responses`；
- 首 Token 超时；
- 总超时；
- Cooldown；
- Max Attempts；
- 失败自动切换；
- 只有在尚未向用户输出任何文本时才自动切换，避免重复回答；
- Last-successful route 短期优先；
- Relay 自动模型发现与协议测速；
- LLM 路由请求链、Failover 状态和测速结果可视化；
- 配置 AES-256-GCM 加密备份/恢复；
- E2E ASR → LLM → TTS 测试；
- 首响时间线优化。

### Android v0.2 / Aipany v0.4.7

第一版真正可用的 Android 客户端：

- 启动自动连接；
- App 内不暴露 API Key / Gateway Token / LLM 中转站设置；
- Preview Bootstrap 自动签发短期 realtime-only JWT；
- Voice Orb 状态；
- 本地 Endpoint Detection；
- 自动 `input_audio_buffer.commit`；
- Barge-in；
- Voice / Interaction Mode / Proactivity 设置；
- 16 kHz PCM 输入；
- 24 kHz PCM 输出；
- 延迟显示。

### v0.5.0 / Android v0.3.0

本轮最新代码：

#### Native Live

- 新增 `QwenOmniRealtimeClient`；
- 新增 `QwenOmniLiveSession`；
- `auto / omni_realtime / cascaded`；
- Native Live 初始化失败自动回退 Cascaded；
- Qwen3.5 Omni Realtime 默认音色 `Tina`；
- Native Live 与 Cascaded 分离音色目录；
- 上游 Native Live 中途死亡时关闭客户端连接触发自动重连。

#### Android 实时体验

- OkHttp WebSocket Ping；
- 应用级 Ping/Pong；
- 45 秒无 Pong 主动断开；
- 1 / 2 / 4 / 8 / 15 秒指数退避自动重连；
- Android `AcousticEchoCanceler`；
- `NoiseSuppressor`；
- `AutomaticGainControl`；
- Low Latency `AudioTrack`；
- PCM Playback Generation 失效机制，确保 Barge-in 后旧音频任务不会恢复播放；
- AI 播放期间使用独立插话检测阈值；
- Client Telemetry：endpoint、barge-in、first audio、heartbeat RTT。

#### Observability

- JSONL 结构化日志；
- WebSocket 连接/关闭码/原因；
- Engine 选择与 fallback；
- ASR/LLM/TTS/Omni/Audio/Client/Auth 分类；
- 设备 ID 先哈希再记录；
- 默认不记录用户对话正文；
- Session 轮次、打断、错误数；
- `Speech End → ASR Final`；
- `ASR Final → First Text`；
- `First Text → First Audio`；
- `Speech End → First Audio`；
- P50/P95/Max；
- 日志自动轮转。

#### Operations Console

`/admin` 直接进入控制台，现有页面包括：

- 实时质量；
- 会话；
- 结构化日志；
- 总览；
- DashScope；
- Qwen Omni；
- Native Live；
- Text LLM Provider Pool；
- LLM Failover 路由状态；
- Remote GPU；
- 诊断测试；
- 配置备份。

---

## 5. 关键代码文件

### Gateway / Engine

- `services/realtime-gateway/src/server.ts`
  - HTTP API；
  - `/health`；
  - `/v1/mobile/bootstrap`；
  - `/v1/mobile/capabilities`；
  - `/v1/realtime` WebSocket；
  - Engine 选择；
  - Native Live → Cascaded 初始化 fallback；
  - WebSocket observability。

- `services/realtime-gateway/src/config.ts`
  - 启动和运行时环境变量解析；
  - Native Live 参数；
  - Speaker / Audio Front-End / JWT 配置。

- `services/realtime-gateway/src/session/realtime-session.ts`
  - 稳定 Cascaded 核心会话。

- `services/realtime-gateway/src/session/low-latency-realtime-session.ts`
  - Cascaded 低延迟覆盖层；
  - Explicit ASR commit；
  - 未授权声纹时 Owner Focus 不等待无效分析；
  - per-session TTS voice。

- `services/realtime-gateway/src/session/qwen-omni-live-session.ts`
  - Native Live 会话桥接；
  - 上游事件映射到 Aipany Protocol；
  - Native barge-in；
  - 上游断线后触发客户端 reconnect。

- `services/realtime-gateway/src/providers/qwen-omni-realtime.ts`
  - Qwen Omni Realtime 原生 WebSocket Provider；
  - PCM Base64 输入；
  - text/audio streaming；
  - Server/Semantic VAD。

### LLM Provider Pool

- `services/realtime-gateway/src/providers/llm-provider-pool.ts`
  - Route candidate；
  - provider/model/protocol priority；
  - First-token / total timeout；
  - Cooldown；
  - Preferred route；
  - Request trace；
  - Failover。

### Admin / Runtime Config

- `services/realtime-gateway/src/admin/runtime-api-config-store.ts`
  - `/data/runtime-api-config.json`；
  - Runtime API Keys；
  - Secret redaction；
  - LLM Provider Pool persistence。

- `services/realtime-gateway/src/admin/admin-config-http.ts`
  - Admin 页面/API 路由；
  - 配置、诊断、日志、导出等入口。

- `services/realtime-gateway/src/admin/admin-live-config-ui.ts`
  - Native Live 配置 UI。

- `services/realtime-gateway/src/admin/admin-observability-ui.ts`
  - 实时质量 / 会话 / 日志 UI。

- `services/realtime-gateway/src/admin/admin-failover-ui.ts`
  - LLM Failover 路由状态与请求链 UI。

### Observability

- `services/realtime-gateway/src/observability/realtime-observability.ts`
  - JSONL 日志；
  - SessionReport；
  - 延迟聚合；
  - 断线统计；
  - Rotation。

### Android

- `apps/android/app/src/main/java/cn/mv3/aipany/MainActivity.kt`
  - 自动 Bootstrap；
  - UI 状态；
  - Voice / Mode 设置；
  - 延迟显示。

- `apps/android/app/src/main/java/cn/mv3/aipany/RealtimeClient.kt`
  - WebSocket；
  - Session Start；
  - Heartbeat；
  - 自动重连；
  - Client Telemetry。

- `apps/android/app/src/main/java/cn/mv3/aipany/AudioEngine.kt`
  - 录音；
  - Android AEC / NS / AGC；
  - 低延迟播放；
  - Barge-in 清队列。

- `apps/android/app/src/main/java/cn/mv3/aipany/EndpointDetector.kt`
  - 本地 Endpoint Detection；
  - 普通说话与 AI 播放期间不同检测阈值。

### Protocol / Audio Intelligence

- `packages/protocol/src/index.ts`
  - Aipany Realtime Protocol；
  - `client.telemetry`；
  - session / transcript / response / speaker / social 事件。

- `packages/audio-intelligence/`
  - Speaker Identity；
  - Hybrid Provider；
  - Cloud / Remote Audio Intelligence。

- `services/speaker-intelligence/`
  - Python ECAPA / Diarization 服务；
  - 可选本地重模型能力。

### Deployment / CI

- `deploy/docker-compose.yml`
- `deploy/postgres/init/`
- `.github/workflows/ci.yml`
- `.github/workflows/android-apk.yml`

---

## 6. 当前协议和音频格式

客户端 → Gateway：

```text
WebSocket /v1/realtime
PCM signed 16-bit little-endian
16 kHz
mono（协议支持更多声道，Android 当前 mono）
```

Gateway → 客户端：

```text
PCM signed 16-bit little-endian
24 kHz
mono
```

重要控制事件：

```text
session.start
input_audio_buffer.commit
response.cancel
session.finish
ping
client.telemetry
mode.set
speaker.consent.*
speaker.identity.*
speaker.enrollment.*
```

主要服务端事件：

```text
session.created
session.ready
input_audio_buffer.speech_started
input_audio_buffer.speech_stopped
transcript.partial
transcript.final
response.created
response.text.delta
response.audio.started
[BINARY PCM]
response.audio.done
response.interrupted
response.done
error
pong
```

---

## 7. LLM Provider Pool 已确认行为

默认配置：

```text
firstTokenTimeoutMs = 12000
totalTimeoutMs = 60000
cooldownMs = 60000
maxAttempts = 8
```

行为：

1. provider priority 越小越优先；
2. model priority 越小越优先；
3. 每个模型可支持 Responses / Chat Completions；
4. 最近成功路由会短期优先；
5. 失败路由进入 cooldown；
6. HTTP 错误、连接错误、首 Token 超时、总超时、空流都可切换；
7. 一旦已经向客户端输出任何文本，再发生错误时不切换，避免用户收到重复回答。

旧单一 `LLM_BASE_URL/API_KEY/MODEL` 会自动映射为 Legacy Provider，直到新 Provider Pool 保存。

---

## 8. 安全与配置边界

运行时控制台允许管理云 API / Provider 配置，但以下启动级秘密不应通过网页修改：

- `AIPANY_ADMIN_TOKEN`
- `AIPANY_JWT_SECRET`
- `DATABASE_URL`
- `POSTGRES_PASSWORD`
- `SPEAKER_IDENTITY_ENCRYPTION_KEY`

运行时配置默认：

```text
/data/runtime-api-config.json
```

Observability 默认：

```text
/data/observability/events.jsonl
```

Secret 读取只返回 `configured=true/false`，不回显明文。

---

## 9. 当前生产部署约束

已知生产环境：

- Ubuntu 24.04；
- 约 4 vCPU；
- 约 4 GB RAM；
- 无 GPU；
- Docker / Docker Compose；
- Gateway 仅映射 `127.0.0.1:3000`；
- 外部通过 Nginx/宝塔和域名反代。

生产仓库路径历史使用：

```text
/opt/aipany
```

生产域名历史使用：

```text
aipany.mv3.cn
```

本地生产覆盖文件必须保留：

```text
services/speaker-intelligence/requirements-lite.txt
services/speaker-intelligence/Dockerfile.cn-lite
deploy/docker-compose.cn-lite.yml
```

部署命令必须叠加两份 Compose：

```bash
cd /opt/aipany

docker compose \
  --env-file .env \
  -f deploy/docker-compose.yml \
  -f deploy/docker-compose.cn-lite.yml \
  build realtime-gateway

docker compose \
  --env-file .env \
  -f deploy/docker-compose.yml \
  -f deploy/docker-compose.cn-lite.yml \
  up -d --no-deps --force-recreate realtime-gateway
```

低配服务器当前推荐继续关闭本地重模型：

```text
SPEECH_SEPARATION_ENABLED=false
TARGET_SPEAKER_EXTRACTION_ENABLED=false
SEGMENT_TRANSCRIPTION_ENABLED=false
ENVIRONMENT_INTELLIGENCE_ENABLED=false
```

不要在没有远程 GPU Worker 的情况下开启 Remote SepFormer。

GitHub 网络曾出现 TLS 中断，服务器上已经使用过：

```bash
git config --global http.version HTTP/1.1
```

更新代码时建议 retry，不要用破坏本地覆盖文件的 reset/clean。

---

## 10. 已验证过的关键链路

Cascaded E2E 曾完整通过：

```text
TTS 生成测试语音
→ 16k PCM
→ Gateway
→ Qwen Realtime ASR
→ transcript.final
→ LLM Provider Pool
→ response.text.delta
→ Qwen Realtime TTS
→ 24k PCM 回传
```

已观察到一次成功指标：

```text
LLM 首 Token：约 1796 ms
完整测试耗时：约 11 s
```

注意：完整测试耗时不是用户等待 11 秒，因为文字和音频是流式返回。

LLM Failover 设计和测试覆盖已经完成；Provider Pool 支持在首 Token 之前自动切换。

CI 当前已验证：

- TypeScript typecheck；
- 完整 Node test suite；
- Python compileall；
- Production build；
- Android Endpoint Detector tests；
- Android `assembleDebug`。

---

## 11. 已确认的问题 / 当前限制

### 11.1 v0.5 生产环境仍需要正式验收

仓库 `main` 已是 v0.5.0，但新的 Native Live + Observability + 控制面板必须在生产服务器部署后再做真实长时间真机验收。

不要仅凭 CI 宣称已经达到 ChatGPT Live 体验。

### 11.2 Native Live 目前不支持 Speaker Identity 管理

`QwenOmniLiveSession` 当前对以下操作会拒绝：

- 声纹写入；
- 声纹列表；
- 声纹注册；
- 声纹删除。

需要这些高级声纹功能时暂时使用 Cascaded；后续要设计 Native Live 与本地 Speaker Intelligence 的旁路融合。

### 11.3 Native Live 中途失败不是同连接无缝 fallback

当前行为：

```text
Omni upstream dies
→ Gateway sends retryable error
→ Gateway closes client WS with 1011
→ Android reconnect
→ New session Auto retries Native / may startup-fallback Cascaded
```

后续可以评估是否值得做同一客户端会话内的透明 engine migration。

### 11.4 Android 401 不会自动重新 Bootstrap

`RealtimeClient` 自动重连复用原 JWT。

如果握手返回 401：

- 自动重连停止；
- UI 提示身份过期；
- 当前需要用户点击“重新连接”，Activity 再走 Bootstrap。

正式账号系统上线前，建议把 `401/token expired → 自动重新 bootstrap → 新 JWT → reconnect` 做掉。

### 11.5 Observability Session Summary 不会跨 Gateway 重启恢复

当前 JSONL 原始事件会持久化并在启动时重新读取；但是 `sessions` / `activeSessions` / `lastDeviceSession` 这些聚合 Map 没有从历史事件重建。

结果：

- 原始日志还在；
- Gateway 重启后“会话列表 / 24h Session 聚合 / P50/P95”只从本进程重新开始积累。

这是控制面板下一阶段最重要的数据正确性问题之一。

### 11.6 reconnectLikely 只是启发式

目前依据同一 `deviceIdHash` 在 60 秒内重新出现判断“疑似重连”，不是显式 reconnect chain。

后续应增加：

- `clientConnectionId`；
- `previousSessionId`；
- reconnect reason；
- reconnect attempt；
- token refresh reason。

### 11.7 README 已过时

当前 `README.md` 标题和大部分说明仍停留在 v0.4.1，尚未完整反映：

- Android v0.3；
- Native Live；
- Operations Console；
- Observability；
- 新 `/admin` 入口。

需要尽快更新。

### 11.8 双重 AEC 需要真机评估

Android 端已经启用系统 AEC，Cascaded Gateway 也有 Audio Front-End AEC。

需要用真实外放场景测试：

- 是否产生过度处理；
- 是否影响用户声音；
- 是否应由 Client Capability 告诉 Gateway“客户端已做 AEC”，从而动态关闭服务端 AEC。

### 11.9 App Capability 运行中更新问题

Android 启动时获取 Voice / Engine Capabilities。

如果管理员在控制台运行中切换 Engine 或 Voice Model，已运行 App 的 capability cache 可能暂时过期，通常要重新 fetch / reconnect 才会刷新。

---

## 12. 当前未完成任务

按优先级：

### P0：部署与真实质量验收

1. 把 `main` v0.5.0 部署到生产 Gateway；
2. 检查 `/health`；
3. 打开 `/admin`；
4. Native Live 先用 `Auto`；
5. 运行真实 Android 长时间对话；
6. 收集断线、P50/P95 首响、Barge-in 数据。

### P0：定位“经常自动断线”真实根因

必须用新日志判断具体属于：

- 手机网络；
- Nginx / WSS；
- JWT；
- Gateway；
- DashScope ASR/TTS；
- Native Live；
- LLM Relay；
- 心跳超时。

不要在没有日志证据时继续猜原因。

### P0：Native Live 真机协议验证

重点验证：

- Session 初始化；
- 16 kHz PCM 输入；
- 24 kHz PCM 输出；
- Server VAD；
- Semantic VAD；
- Tina / Cindy 音色；
- Barge-in；
- 上游掉线 reconnect；
- Auto startup fallback。

### P1：Observability 持久聚合

从 JSONL 重建历史 Session Report，或改用 PostgreSQL/SQLite 做结构化 Session / Turn / Event 存储。

目标是 Gateway 重启后 24h 指标不丢。

### P1：自动 JWT Refresh / Re-bootstrap

Preview 阶段：

```text
401
→ MobileApi.bootstrap
→ new JWT
→ reconnect
```

正式阶段替换成账户 Refresh Token。

### P1：质量指标完善

增加：

- Connection success rate；
- Reconnect success rate；
- Time to reconnect；
- Barge-in detect → playback stop；
- Barge-in detect → upstream cancel；
- First microphone packet → upstream；
- Native Live First Audio；
- Cascaded First Audio；
- 按 App Version / Engine / Network 分组。

### P1：README / 部署文档更新

把 README 从 v0.4.1 更新到当前 v0.5.0 架构。

### P2：正式账号系统

替代 Mobile Preview Bootstrap：

```text
Register/Login
→ Access Token
→ Refresh Token
→ realtime JWT/session ticket
```

保持客户端只连接 Aipany，不向 App 暴露第三方 Provider Secret。

### P2：Native Live + Speaker Identity 融合

让 Native Live 作为主语音模型时，本地 ECAPA 仍可旁路处理用户输入，用于：

- Owner recognition；
- 家庭成员；
- 多人场景；
- Speaker memory。

### P2：ESP32 / Embedded Client

Android 稳定后复用现有 `/v1/realtime` 协议接入 ESP32。

### P2：生产安全加固

- Admin IP allowlist / 二次认证；
- Rate limit；
- 更完整审计；
- 正式账号 RBAC；
- 日志 retention；
- 数据导出与删除策略。

### P2：把 cn-lite 正式纳入仓库

目前生产低配构建依赖本地未提交覆盖文件。

后续应在不包含 Secret 的前提下，把它们整理成正式可维护的部署 profile，避免服务器和 GitHub 长期漂移。

---

## 13. 推荐下一步执行顺序

新的开发会话建议严格按下面顺序继续：

### 第一步：确认仓库和服务器版本

仓库：

```bash
git log -1 --oneline
cat package.json | grep version
```

服务器：

```bash
curl -sS http://127.0.0.1:3000/health
curl -sS https://aipany.mv3.cn/health
```

如果生产不是 v0.5.0，先升级，不要先继续改代码。

### 第二步：打开控制台

```text
https://aipany.mv3.cn/admin
```

确认：

- 实时质量；
- 会话；
- 日志；
- Native Live 配置；
- LLM Routing；
- E2E 诊断。

### 第三步：Native Live 使用 Auto

建议首轮：

```text
AIPANY_REALTIME_ENGINE=auto
QWEN_OMNI_REALTIME_ENABLED=true
QWEN_OMNI_REALTIME_MODEL=qwen3.5-omni-plus-realtime
QWEN_OMNI_REALTIME_VOICE=Tina
QWEN_OMNI_REALTIME_TURN_DETECTION=server_vad
QWEN_OMNI_REALTIME_VAD_THRESHOLD=0.2
QWEN_OMNI_REALTIME_SILENCE_MS=350
```

### 第四步：做真实测试矩阵

至少测试：

- 连续 30 分钟对话；
- 100+ turns；
- AI 回答中插话；
- 快速连续追问；
- Wi-Fi ↔ 5G；
- 临时断网；
- App 前后台切换；
- 上游 API 故障；
- Native Live startup fallback。

### 第五步：只根据日志修真实瓶颈

优先修：

1. 异常断线率；
2. Speech End → First Audio P95；
3. Barge-in stop latency；
4. reconnect time；
5. API Provider errors。

---

## 14. 新聊天可直接使用的接手提示

```text
请继续开发 GitHub 项目 b8vipvip/aipany。

先读取 main 分支的 docs/PROJECT_HANDOFF_CONTEXT.md，并以当前 main 为唯一代码基线。不要回到旧 PR/旧架构分支。

当前目标是把 Aipany 的 Android 实时语音体验优化到接近 ChatGPT Live：低首响、连续自然对话、可靠即时插话、弱网自动恢复，同时使用服务端 Operations Console 和结构化日志判断真实质量。

重要部署约束：生产服务器在 /opt/aipany，存在本地未提交的 cn-lite 覆盖文件，绝对不要 git reset --hard 或 git clean。Docker Compose 必须同时使用 deploy/docker-compose.yml 和 deploy/docker-compose.cn-lite.yml。不要要求我粘贴任何 Secret。

开始前先检查：
1. GitHub main 当前版本和提交；
2. 生产 /health 当前实际部署版本；
3. /admin 实时质量、会话、日志是否正常；
4. Native Live 是否已经在生产 Auto 模式真实跑通。

然后根据日志和真实测试数据继续，不要在没有证据时猜断线原因。
```

---

## 15. 最终状态摘要

当前代码已经从最初的单一级联语音 Demo，发展为：

```text
Aipany v0.5
├── Native Live Speech-to-Speech
├── Stable Cascaded Fallback
├── Multi-provider LLM Failover
├── Hybrid Audio Intelligence
├── Persistent Speaker Identity
├── Social Conversation Manager
├── Android Realtime Voice Client
├── Runtime Configuration Console
├── Operations / Quality Console
└── Structured Realtime Observability
```

下一阶段成功与否不应以“功能是否存在”判断，而应以真实生产数据判断：

```text
异常断线率是否足够低
P50/P95 首响是否达标
Barge-in 是否足够快
自动重连是否可靠
Native Live 是否稳定
Cascaded fallback 是否真正兜底
```

这就是接下来开发的主线。