FROM node:22-alpine AS build
WORKDIR /app
COPY package.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY services/realtime-gateway/package.json services/realtime-gateway/package.json
RUN npm install
COPY packages ./packages
COPY services ./services
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY services/realtime-gateway/package.json services/realtime-gateway/package.json
RUN npm install --omit=dev
COPY --from=build /app/packages/protocol/dist packages/protocol/dist
COPY --from=build /app/services/realtime-gateway/dist services/realtime-gateway/dist
EXPOSE 3000
CMD ["node", "services/realtime-gateway/dist/index.js"]
