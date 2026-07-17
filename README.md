# Aipany

Aipany 是一个以移动端为起点的实时 AI 语音平台，未来将扩展为可复用的 AI 语音云服务，为 ESP32-S3、智能音箱、AI 玩具、机器人以及第三方智能硬件提供统一接入能力。

> 当前阶段：V1 已合并到 `main`，正在进行云端编译与真机链路验证。

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

当前 `main` 已包含：

- pnpm + Turborepo Monorepo 配置；
- 统一的严格 TypeScript 配置；
- `@aipany/protocol` 跨设备会话、语音、工具和设备命令协议；
- Voice Session 安全会话启动服务；
- OpenAI Realtime 第一版 Provider Adapter；
- 手机端 Expo + React Native + WebRTC 客户端；
- 第三方 API、中转站和多 Provider 扩展架构；
- ESP32 后续接入边界；
- GitHub Actions 自动类型检查、测试和 Android Release APK 云端编译。

## 云端编译

仓库已经配置 GitHub Actions：

- `代码检查`：在 Ubuntu Runner 中安装依赖、执行 TypeScript 类型检查和测试；
- `Android APK 云端编译`：自动执行 Expo Prebuild，并在 Ubuntu Runner 中编译 Android Release APK；
- 编译成功后，APK 会作为 GitHub Actions Artifact 保存 14 天；
- 可在 GitHub 仓库变量中配置 `AIPANY_API_BASE_URL`，将正式后端地址写入构建产物。

Android 编译不要求本地 Windows 开发环境。iOS 原生应用仍需要 macOS 构建环境，后续可以选择 GitHub macOS Runner 或 Expo EAS Build 云服务。

## 从这里开始

平台总体设计请阅读 `docs/architecture/system-overview.md`，实施顺序请阅读 `docs/roadmap/v1.md`。

## 安全要求

禁止在手机 App 或嵌入式设备中写入永久的 AI 服务商 API Key。客户端只能从 Aipany 服务端获取短期会话凭证。真实密钥必须存放在服务端的密钥管理环境中，并且绝不能提交到本仓库。
