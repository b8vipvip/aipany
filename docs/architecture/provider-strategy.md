# AI 供应商与中转站接入策略

## 1. 目标

Aipany 不绑定单一 AI 供应商。平台从一开始把不同能力拆成独立 Provider，允许按租户、产品、Agent 或环境选择不同服务。

## 2. 能力拆分

建议长期保持四类独立接口：

```text
RealtimeVoiceProvider  实时双向语音，负责低延迟连续对话
TextModelProvider      文本生成、复杂推理、Agent 深度任务
SpeechToTextProvider   语音转文字，供非 Realtime 降级链路使用
TextToSpeechProvider   文字转语音，供非 Realtime 降级链路使用
```

因此可以出现如下组合：

```text
实时对话：OpenAI Realtime
复杂推理：第三方 OpenAI-Compatible 中转站 / 其他大模型
知识库：自建 Embedding / Rerank
备用语音：第三方 ASR + 第三方 LLM + 第三方 TTS
```

## 3. 第三方 API 与中转站

### 文本模型

只要中转站提供稳定的 HTTP API，就可以通过独立的 `TextModelProvider` 接入。若兼容 OpenAI Responses 或 Chat Completions 协议，可以复用 OpenAI-Compatible Adapter；若协议不同，则增加独立 Adapter。

### 实时语音

实时语音不能只看“是否兼容 OpenAI 文本接口”。一个中转站若要直接替代当前 Realtime Provider，至少需要兼容当前客户端实际使用的实时会话流程，例如：

- 创建短期客户端会话凭证；
- WebRTC 或 WebSocket 实时双向音频；
- 会话建立和 SDP / Signaling 流程；
- 实时事件；
- 用户打断与回复取消；
- 供应商支持时的 Semantic VAD；
- Tool Call / Data Channel 或等价机制。

仅支持 `/chat/completions` 或 `/responses` 的普通中转站，不能直接替代 Speech-to-Speech Realtime 链路，但仍然可以作为 AI Brain 的文本或深度推理模型。

## 4. 两种语音架构

### 方案 A：原生 Realtime Speech-to-Speech

```text
客户端
  ↓ WebRTC / WebSocket
RealtimeVoiceProvider
  ↓
实时音频回复
```

优势是延迟低、打断自然、连续对话体验好。Aipany V1 优先使用这一方案。

### 方案 B：可组合级联语音

```text
客户端音频
  ↓
SpeechToTextProvider
  ↓
TextModelProvider
  ↓
TextToSpeechProvider
  ↓
客户端播放
```

优势是供应商选择更多、成本和模型可自由组合；缺点是通常更难做到与原生 Realtime 同等的低延迟和自然打断。

Aipany 后续会同时支持两种模式，并由 Agent / Product Policy 选择。

## 5. 配置原则

客户端永远只请求 Aipany 的统一 Session API，不直接配置供应商地址和永久密钥。

```text
Mobile / ESP32
    ↓
Aipany Voice Session API
    ↓
Provider Registry
    ├── OpenAI Realtime
    ├── OpenAI-Compatible Realtime Gateway
    ├── Gemini Live Adapter
    ├── 自建 Realtime Adapter
    └── Cascaded Voice Pipeline
```

Provider 的 API Key、Base URL、模型名称、超时、重试和路由策略全部保存在服务端。

## 6. 当前实现状态

当前 `OpenAIRealtimeProvider` 已经通过 `baseUrl` 配置隔离供应商地址，因此兼容同一 Realtime 会话协议的代理服务可以通过服务端配置接入。

但“OpenAI-Compatible”不代表一定兼容 Realtime。对第三方中转站必须单独检查其 Realtime 会话创建接口、WebRTC / WebSocket 支持及事件协议，不能因为文本接口兼容就直接假定语音接口兼容。

下一阶段会增加统一 Provider Registry，并把文本推理 Provider 与实时语音 Provider 完全分开。