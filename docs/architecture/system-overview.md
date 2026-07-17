# Aipany 系统架构

## 1. 目标

Aipany 是一个与设备形态解耦的实时 AI 语音平台。第一款客户端是手机 App，未来可以继续接入 ESP32-S3、智能音箱、AI 玩具、机器人和其他嵌入式设备，而不需要替换 AI 后端。

平台重点优化以下能力：

- 低延迟全双工实时语音交互；
- 用户打断时立即停止和取消当前回复；
- 对不同实时语音模型供应商进行统一抽象；
- Agent、长期记忆、工具和知识库可跨设备复用；
- API Key 和业务逻辑只由服务端安全控制；
- 为未来硬件厂商多租户平台预留扩展能力。

## 2. 核心架构

```text
手机 App / Web / ESP32 / 机器人
              |
              | 统一设备会话协议
              v
          API 与会话网关
              |
       +------+-------+
       |              |
       v              v
 实时语音层         AI Brain
 Transport          Orchestrator
       |              |
       |              +--> Agent 人设与配置
       |              +--> 长期记忆
       |              +--> 知识库 / RAG
       |              +--> Tools / MCP / 业务 API
       |              +--> 深度任务模型
       |              +--> 安全与策略控制
       |              +--> 用量统计
       |
       v
 实时语音模型供应商
```

实时语音供应商必须是可替换的。设备端不持有供应商的长期业务密钥。服务端负责创建或代理短期会话凭证；供应商支持时，服务端还可以通过控制通道或 Sideband 连接保持对同一个实时会话的控制。

## 3. 核心规则：App 也是一种 Device

后端不能假设实时会话一定来自手机。所有客户端都使用 `DeviceIdentity` 注册自身身份和能力。

手机示例：

```json
{
  "deviceId": "dev_mobile_123",
  "productId": "aipany-mobile",
  "deviceType": "mobile",
  "platform": "ios",
  "capabilities": ["audio_input", "audio_output", "screen", "camera", "location"]
}
```

ESP32 示例：

```json
{
  "deviceId": "dev_esp32_456",
  "productId": "toy-v1",
  "deviceType": "embedded",
  "platform": "esp32-s3",
  "capabilities": ["audio_input", "audio_output", "led", "button", "ota"]
}
```

Agent 和工具在执行设备动作前，必须先检查设备是否具备对应能力。

## 4. 实时对话主链路

```text
1. 客户端向 Aipany 完成身份认证。
2. 客户端注册或刷新 DeviceIdentity。
3. 客户端请求创建 Voice Session。
4. Voice Session Service 选择实时语音供应商、模型策略、Agent 和声音。
5. 服务端返回短期会话启动数据。
6. 客户端建立实时音频连接。
7. 供应商支持时，服务端建立控制通道 / Sideband 连接。
8. 用户音频持续流式发送。
9. 实时语音模型负责自然的对话节奏和语音响应。
10. 复杂任务委派给 AI Brain 的工具或更强的推理模型。
11. 任务结果返回实时语音层，由语音模型自然表达给用户。
12. 会话事件和用量数据异步持久化。
```

## 5. 打断模型

Barge-in（用户打断）是平台级状态转换，而不是一个单纯的 UI 功能。

当 AI 正在播放语音，而系统检测到用户开始讲话时：

```text
user.speech.started
        |
        +--> 客户端立即停止或降低本地播放音量
        +--> 取消当前正在生成的 AI 回复
        +--> 供应商支持时截断用户未听到的 AI 上下文
        +--> 标记 assistant.speech.interrupted
        +--> 继续接收用户的新语音
```

手机端应优先执行本地停止播放，不应先等待一次服务端网络往返。

## 6. 服务边界

### API Gateway

负责认证、限流、请求路由，以及 Tenant / Product / Device 上下文解析。

### Device Service

负责设备注册、能力管理、产品关联、在线状态，以及未来固件和 OTA 元数据。

### Voice Session Service

负责实时语音供应商抽象、短期凭证创建、会话生命周期、传输元数据、打断状态和字幕事件。

### Agent Service

负责人设、系统指令、声音配置、回复风格、主动程度、记忆策略和可用工具。

### Memory Service

负责用户资料、偏好、人物关系、项目、事件记忆、对话摘要、记忆检索和遗忘策略。

### Tool Service

负责工具注册与执行，包括搜索、知识库、MCP、业务 API 和设备控制命令。

### Usage & Billing Service

负责会话时长、供应商用量、模型用量、Tenant / Product 归属、配额和未来计费。

## 7. 数据模型方向

初始核心实体：

- User
- Tenant
- Product
- Device
- Agent
- VoiceSession
- Conversation
- ConversationTurn
- Memory
- ToolDefinition
- ToolExecution
- UsageRecord

第一阶段可以让 `Tenant` 只代表 Aipany 自身，但数据库从一开始保留 Tenant 维度，这样未来支持多个硬件厂商时不需要重新设计核心数据模型。

## 8. 实时语音供应商抽象

不要让供应商原生事件名称散落到整个业务代码中。所有事件应转换为 `@aipany/protocol` 定义的统一事件。

建议接口：

```text
RealtimeProvider
  createSession()
  attachControlChannel()
  updateSession()
  cancelResponse()
  truncateResponse()
  sendToolResult()
  closeSession()
```

每个 Provider Adapter 只负责把供应商的接口和原生事件转换成 Aipany 平台协议。

## 9. V1 暂不实现

第一版暂不实现：

- ESP32 正式固件；
- 硬件厂商正式计费；
- 生产级 OTA 基础设施；
- 公共 SDK 市场；
- 所有实时语音模型供应商适配。

架构会保留这些扩展路径，但 V1 的第一目标是先把手机端的实时语音交互体验做到优秀。