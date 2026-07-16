# syntax=docker/dockerfile:1.7
# Tessera Slack Channel — multi-stage build, non-root UID 10001
# Outbound-only adapter using Socket Mode (no EXPOSE, no data volume)
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10 --activate

FROM base AS deps
WORKDIR /app
COPY .npmrc pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY packages/channels/slack/package.json packages/channels/slack/
RUN pnpm install --frozen-lockfile --filter @tessera/channel-slack && \
    mkdir -p /app/packages/channels/slack/node_modules

FROM deps AS build
COPY packages/channels/slack/ packages/channels/slack/
COPY tsconfig.base.json ./
RUN pnpm --filter @tessera/channel-slack build

FROM node:22-alpine AS runtime
WORKDIR /app

RUN addgroup -g 10001 tessera && \
    adduser -u 10001 -G tessera -s /bin/sh -D tessera

COPY --from=build --chown=10001:10001 /app/packages/channels/slack/dist/ packages/channels/slack/dist/
COPY --from=build --chown=10001:10001 /app/packages/channels/slack/package.json packages/channels/slack/
COPY --from=deps --chown=10001:10001 /app/node_modules/ node_modules/
COPY --from=deps --chown=10001:10001 /app/packages/channels/slack/node_modules/ packages/channels/slack/node_modules/

USER 10001:10001

ENV NODE_ENV=production

CMD ["node", "packages/channels/slack/dist/index.js"]
