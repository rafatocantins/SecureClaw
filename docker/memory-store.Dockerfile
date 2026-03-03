# syntax=docker/dockerfile:1.7
# Tessera Memory Store — multi-stage build, non-root UID 10001
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate

FROM base AS deps
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY packages/shared/package.json packages/shared/
COPY packages/memory-store/package.json packages/memory-store/
RUN pnpm install --frozen-lockfile --filter @tessera/memory-store... && \
    mkdir -p /app/packages/memory-store/node_modules

FROM deps AS build
COPY packages/shared/ packages/shared/
COPY packages/memory-store/ packages/memory-store/
COPY tsconfig.base.json ./
RUN pnpm --filter @tessera/shared build && \
    pnpm --filter @tessera/memory-store build

FROM node:22-alpine AS runtime
WORKDIR /app

RUN addgroup -g 10001 tessera && \
    adduser -u 10001 -G tessera -s /bin/sh -D tessera && \
    mkdir -p /data/memory && chown 10001:10001 /data/memory

COPY --from=build --chown=10001:10001 /app/packages/shared/dist/ packages/shared/dist/
COPY --from=build --chown=10001:10001 /app/packages/shared/src/proto/ packages/shared/src/proto/
COPY --from=build --chown=10001:10001 /app/packages/shared/package.json packages/shared/
COPY --from=build --chown=10001:10001 /app/packages/memory-store/dist/ packages/memory-store/dist/
COPY --from=build --chown=10001:10001 /app/packages/memory-store/package.json packages/memory-store/
COPY --from=deps --chown=10001:10001 /app/node_modules/ node_modules/
COPY --from=deps --chown=10001:10001 /app/packages/memory-store/node_modules/ packages/memory-store/node_modules/

USER 10001:10001

ENV NODE_ENV=production
ENV MEMORY_DATA_DIR=/data/memory

VOLUME ["/data/memory"]
EXPOSE 19006

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const net=require('net');const c=net.connect(19006,'127.0.0.1',()=>{c.destroy();process.exit(0)});c.on('error',()=>process.exit(1));" || exit 1

CMD ["node", "packages/memory-store/dist/index.js"]
