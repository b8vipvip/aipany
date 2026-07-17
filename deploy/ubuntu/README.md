# Ubuntu Docker 部署

本目录提供单机 Ubuntu 首版部署方案，包含 PostgreSQL、Redis、Admin API、Voice Session、Admin Web 和 Caddy。内部服务不暴露公网端口，公网仅开放 80/443。

## 步骤

```bash
cd /path/to/aipany
cp deploy/ubuntu/.env.example deploy/ubuntu/.env
# 编辑 .env，替换数据库密码、管理 Token、服务端 Provider Key 与加密密钥
docker compose -f deploy/ubuntu/docker-compose.yml up -d --build
```

## 路由

- `/admin/*`：管理后台前端。
- `/api/admin/*`：管理 API，Caddy 会去掉 `/api/admin` 前缀后转发到 Admin API。
- `/api/voice/*`：语音会话 API，Caddy 会去掉 `/api/voice` 前缀后转发到 Voice Session。

## 安全提醒

生产部署前必须启用 `ADMIN_API_TOKEN`，并在后续版本接入正式 Admin Authentication。永久 Provider API Key 只允许写入服务端数据库，写入前会使用 AES-256-GCM 加密；管理接口只返回是否已配置和掩码，不返回完整密钥。
