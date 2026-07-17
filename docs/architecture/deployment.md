# 部署架构

首版 Ubuntu 部署采用单机 Docker Compose，组件包括 PostgreSQL、Redis、Admin API、Voice Session、Admin Web 与 Caddy。Caddy 是唯一公网入口，开放 80/443；其他容器只在 Docker 内网通信。

## 反向代理

- `/admin/*` → `admin-web`
- `/api/admin/*` → `admin-api`
- `/api/voice/*` → `voice-session`

## 持久化

PostgreSQL 使用 `postgres-data` volume 保存 Provider 配置和系统策略。Redis 启用 AOF，并使用 `redis-data` volume。

## 部署命令

```bash
cp deploy/ubuntu/.env.example deploy/ubuntu/.env
docker compose -f deploy/ubuntu/docker-compose.yml up -d --build
```

生产环境必须替换 `.env` 中所有示例值，并在公开前增加正式 Admin Authentication。
