# syntax=docker/dockerfile:1.7
# Tessera Agent Runtime — multi-stage build, non-root UID 10001
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate

FROM base AS deps
WORKDIR /app
COPY .npmrc pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY packages/shared/package.json packages/shared/
COPY packages/input-sanitizer/package.json packages/input-sanitizer/
COPY packages/agent-runtime/package.json packages/agent-runtime/
RUN pnpm install --frozen-lockfile --filter @tessera/agent-runtime... && \
    mkdir -p /app/packages/agent-runtime/node_modules

FROM deps AS build
COPY packages/shared/ packages/shared/
COPY packages/input-sanitizer/ packages/input-sanitizer/
COPY packages/agent-runtime/ packages/agent-runtime/
COPY tsconfig.base.json ./
RUN pnpm --filter @tessera/shared build && \
    pnpm --filter @tessera/input-sanitizer build && \
    pnpm --filter @tessera/agent-runtime build

FROM node:22-alpine AS runtime
WORKDIR /app

RUN addgroup -g 10001 tessera && \
    adduser -u 10001 -G tessera -s /bin/sh -D tessera

COPY --from=build --chown=10001:10001 /app/packages/shared/dist/ packages/shared/dist/
COPY --from=build --chown=10001:10001 /app/packages/shared/package.json packages/shared/
COPY --from=build --chown=10001:10001 /app/packages/input-sanitizer/dist/ packages/input-sanitizer/dist/
COPY --from=build --chown=10001:10001 /app/packages/input-sanitizer/package.json packages/input-sanitizer/
COPY --from=build --chown=10001:10001 /app/packages/agent-runtime/dist/ packages/agent-runtime/dist/
COPY --from=build --chown=10001:10001 /app/packages/agent-runtime/package.json packages/agent-runtime/
COPY --from=deps --chown=10001:10001 /app/node_modules/ node_modules/
COPY --from=deps --chown=10001:10001 /app/packages/agent-runtime/node_modules/ packages/agent-runtime/node_modules/

USER 10001:10001

ENV NODE_ENV=production

EXPOSE 19001

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const net=require('net');const c=net.connect(19001,'127.0.0.1',()=>{c.destroy();process.exit(0)});c.on('error',()=>process.exit(1));" || exit 1

CMD ["node", "packages/agent-runtime/dist/index.js"]
