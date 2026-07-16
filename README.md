# Aipany

Aipany 是一个以移动端为起点的实时 AI 语音平台，未来将扩展为可复用的 AI 语音云服务，为 ESP32-S3、智能音箱、AI 玩具、机器人以及第三方智能硬件提供统一接入能力。

> 当前阶段：完成平台架构初始化，进入 V1 实时语音能力开发。

第一阶段产品目标是在手机端实现低延迟、可自然打断、可连续交流的 AI 语音陪伴体验。后端从一开始就保持设备无关，使未来的嵌入式设备可以直接复用同一套 Agent、Memory、Tool、Device 和 Usage 基础设施。

## 产品方向

- 低延迟、可自然打断的实时语音对话
- 先支持手机 App，后续无缝扩展 ESP32
- 可配置的 Agent 人设与声音
- 用户长期记忆
- 工具调用、知识检索与复杂任务委派
- 多设备统一会话与能力模型
- 面向硬件厂商的多租户 AI 语音云平台

## 核心架构原则

**手机 App 也是一种 Device，而不是后端中的特殊客户端。**

所有客户端都通过统一的 Device + Session 抽象接入平台，并上报自身能力。手机、Web、ESP32、智能音箱和机器人可以使用不同的音频传输方式，但共享同一个 AI Brain 和平台服务。

## 仓库结构

```text
apps/
  mobile/             # 第一款实时语音客户端
  admin-web/          # 后续的平台管理后台

clients/
  esp32-sdk/          # 预留的嵌入式设备 SDK 边界

firmware/
  esp32/              # 后续 ESP32-S3 参考固件

services/             # 按业务领域划分的后端服务

packages/
  protocol/           # 跨设备共享、带版本号的协议定义

docs/
  architecture/       # 系统架构设计
  roadmap/            # 开发路线图
```

## 当前基础能力

基础分支已经建立：

- pnpm + Turborepo Monorepo 配置；
- 统一的严格 TypeScript 配置；
- `@aipany/protocol` 跨设备会话、语音、工具和设备命令协议；
- 手机端与 ESP32 的统一架构边界；
- 实时语音层与 AI Brain 的分层设计；
- V1 分阶段开发路线图。

## 从这里开始

平台总体设计请阅读 `docs/architecture/system-overview.md`，实施顺序请阅读 `docs/roadmap/v1.md`。

## 安全要求

禁止在手机 App 或嵌入式设备中写入永久的 AI 服务商 API Key。客户端只能从 Aipany 服务端获取短期会话凭证。真实密钥必须存放在服务端的密钥管理环境中，并且绝不能提交到本仓库。