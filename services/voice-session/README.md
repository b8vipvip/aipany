# Voice Session 服务

该服务负责创建 Aipany 平台的实时语音会话，并把具体 AI 供应商的会话协议封装在 Provider Adapter 内部。

## 当前职责

- 提供 `POST /v1/voice/sessions`；
- 校验设备是否具备实时语音所需 Capability；
- 生成 Aipany 平台级 `sessionId`；
- 通过服务端永久 API Key 向实时语音供应商申请短期客户端凭证；
- 返回统一的 WebRTC 启动参数；
- 对供应商错误进行统一转换；
- 确保日志不记录永久 API Key 或临时客户端凭证。

## 本地运行

在仓库根目录准备环境变量：

```bash
cp .env.example .env
```

至少填写：

```text
AI_REALTIME_API_KEY=你的服务端APIKey
```

安装依赖并启动：

```bash
pnpm install
pnpm --filter @aipany/voice-session dev
```

默认监听 `http://localhost:3000`。

健康检查：

```bash
curl http://localhost:3000/health
```

## 创建实时语音会话

```bash
curl -X POST http://localhost:3000/v1/voice/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user_dev_001",
    "agentId": "agent_default",
    "device": {
      "deviceId": "device_mobile_001",
      "productId": "aipany-mobile",
      "deviceType": "mobile",
      "platform": "ios",
      "capabilities": ["audio_input", "audio_output", "screen"]
    },
    "locale": "zh-CN",
    "timezone": "Asia/Shanghai"
  }'
```

成功后会返回平台 Session ID、短期 `clientSecret`、WebRTC endpoint 和本次会话策略。手机端后续只使用短期凭证建立实时连接，永久 API Key 始终留在服务端。

## 当前安全边界

V1 开发阶段的 `userId` 暂时由请求传入，正式接入账号系统后必须由服务端认证上下文注入，不能继续信任客户端自行声明的用户身份。

## Provider Adapter

当前实现：

```text
OpenAIRealtimeProvider
```

后续新增其他实时语音供应商时，应实现同一个 `RealtimeProvider` 接口，而不是修改手机 App 的业务协议。