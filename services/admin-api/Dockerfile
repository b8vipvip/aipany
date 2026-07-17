FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages/provider-types/package.json packages/provider-types/package.json
COPY services/admin-api/package.json services/admin-api/package.json
RUN pnpm install --filter @aipany/admin-api... --prod=false
FROM deps AS build
COPY packages/provider-types packages/provider-types
COPY services/admin-api services/admin-api
RUN pnpm --filter @aipany/admin-api build
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
EXPOSE 3100
CMD ["node","services/admin-api/dist/server.js"]
