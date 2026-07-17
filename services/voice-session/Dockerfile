FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY services/voice-session/package.json services/voice-session/package.json
RUN pnpm install --filter @aipany/voice-session... --prod=false
FROM deps AS build
COPY packages/protocol packages/protocol
COPY services/voice-session services/voice-session
RUN pnpm --filter @aipany/voice-session build
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
EXPOSE 3000
CMD ["node","services/voice-session/dist/server.js"]
