FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages/provider-types packages/provider-types
COPY apps/admin-web apps/admin-web

# 源码复制完成后再安装 workspace 依赖，避免后续 COPY 覆盖包级 node_modules 链接。
RUN pnpm install --filter @aipany/admin-web...

ARG VITE_ADMIN_API_BASE_URL=/api/admin
ENV VITE_ADMIN_API_BASE_URL=$VITE_ADMIN_API_BASE_URL
RUN pnpm --filter @aipany/admin-web... build

FROM caddy:2-alpine
COPY --from=build /app/apps/admin-web/dist /usr/share/caddy
