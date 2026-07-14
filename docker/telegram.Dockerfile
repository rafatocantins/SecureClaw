# syntax=docker/dockerfile:1.7
# Tessera Telegram Channel — multi-stage build, non-root UID 10001
# Outbound-only adapter (no EXPOSE, no data volume)
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate

FROM base AS deps
WORKDIR /app
COPY .npmrc pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY packages/channels/telegram/package.json packages/channels/telegram/
RUN pnpm install --frozen-lockfile --filter @tessera/channel-telegram && \
    mkdir -p /app/packages/channels/telegram/node_modules

FROM deps AS build
COPY packages/channels/telegram/ packages/channels/telegram/
COPY tsconfig.base.json ./
RUN pnpm --filter @tessera/channel-telegram build

FROM node:22-alpine AS runtime
WORKDIR /app

RUN addgroup -g 10001 tessera && \
    adduser -u 10001 -G tessera -s /bin/sh -D tessera

COPY --from=build --chown=10001:10001 /app/packages/channels/telegram/dist/ packages/channels/telegram/dist/
COPY --from=build --chown=10001:10001 /app/packages/channels/telegram/package.json packages/channels/telegram/
COPY --from=deps --chown=10001:10001 /app/node_modules/ node_modules/
COPY --from=deps --chown=10001:10001 /app/packages/channels/telegram/node_modules/ packages/channels/telegram/node_modules/

USER 10001:10001

ENV NODE_ENV=production

CMD ["node", "packages/channels/telegram/dist/index.js"]
