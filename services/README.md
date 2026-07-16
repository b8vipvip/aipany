# 后端服务

Aipany 后端按照业务领域划分，而不是按照客户端平台划分。

计划中的服务模块：

- `api-gateway` —— 认证、Tenant / Product / Device 上下文、限流和路由；
- `voice-session` —— 实时语音 Provider 适配、Session 生命周期和打断状态；
- `agent` —— 人设、系统指令、声音和对话策略；
- `memory` —— 长期记忆提取、检索、修改、删除和对话摘要；
- `tools` —— Tool Registry、执行、MCP、知识检索和业务 API；
- `device` —— 设备注册、Capability、在线状态和未来 OTA 元数据；
- `billing` —— 用量归属、配额和未来的 Tenant 计费。

V1 初期可以把多个模块部署在同一个后端进程中，但代码边界仍然必须遵循这些领域划分，方便未来按需拆分，而不需要重写核心协议。