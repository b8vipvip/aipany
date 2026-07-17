# Provider 配置后台架构

Aipany 的客户端（手机 App、未来 ESP32）只依赖统一 Voice Session API，不包含任何供应商业务逻辑或永久 API Key。服务端通过 Admin API 管理 Provider 配置，并由 Voice Session 在创建会话时动态选择默认 Realtime Provider。

## 类型与分类

`@aipany/provider-types` 定义四类能力：`realtime`、`text`、`asr`、`tts`，以及 `openai`、`openai-compatible`、`gemini`、`custom` 协议。DTO 只允许暴露 `apiKeyConfigured` 和 `apiKeyMasked`。

## 数据库

`provider_configs` 保存名称、类别、协议、Base URL、模型、声音、优先级、settings，以及 API Key 的 AES-256-GCM 密文、IV 和认证标签。`system_settings` 保存 `provider_policy`，用于记录默认 Realtime/Text/ASR/TTS Provider。

## API Key 安全

Admin API 使用 `AIPANY_CONFIG_ENCRYPTION_KEY` 派生 AES-256-GCM 256 位密钥。创建或更新 Provider 时，非空 `apiKey` 会先加密再入库；更新时省略或传空会保留旧 Key。GET/List 接口不会返回完整 Key。

## 动态 Realtime 选择

Voice Session 工作流：读取 `system_settings.provider_policy` → 查询默认 Realtime Provider → 解密 API Key → 根据协议创建 Adapter。目前 `openai` 与明确兼容 Realtime 会话流程的 `openai-compatible` 复用 `OpenAIRealtimeProvider`；不支持协议返回明确错误。若数据库未配置默认 Realtime Provider，则保留旧环境变量 fallback，保证现有开发环境可继续运行。
