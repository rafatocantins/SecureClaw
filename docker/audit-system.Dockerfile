# syntax=docker/dockerfile:1.7
# Tessera Audit System — multi-stage build, non-root UID 10001
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10 --activate

FROM base AS deps
WORKDIR /app
COPY .npmrc pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY packages/shared/package.json packages/shared/
COPY packages/audit-system/package.json packages/audit-system/
RUN pnpm install --frozen-lockfile --filter @tessera/audit-system... && \
    mkdir -p /app/packages/audit-system/node_modules

FROM deps AS build
COPY packages/shared/ packages/shared/
COPY packages/audit-system/ packages/audit-system/
COPY tsconfig.base.json ./
RUN pnpm --filter @tessera/shared build && \
    pnpm --filter @tessera/audit-system build

FROM node:22-alpine AS runtime
WORKDIR /app

RUN addgroup -g 10001 tessera && \
    adduser -u 10001 -G tessera -s /bin/sh -D tessera

RUN mkdir -p /data/audit && chown -R 10001:10001 /data

COPY --from=build --chown=10001:10001 /app/packages/shared/dist/ packages/shared/dist/
COPY --from=build --chown=10001:10001 /app/packages/shared/package.json packages/shared/
COPY --from=build --chown=10001:10001 /app/packages/audit-system/dist/ packages/audit-system/dist/
COPY --from=build --chown=10001:10001 /app/packages/audit-system/package.json packages/audit-system/
COPY --from=deps --chown=10001:10001 /app/node_modules/ node_modules/
COPY --from=deps --chown=10001:10001 /app/packages/shared/node_modules/ packages/shared/node_modules/
COPY --from=deps --chown=10001:10001 /app/packages/audit-system/node_modules/ packages/audit-system/node_modules/

USER 10001:10001

ENV NODE_ENV=production
VOLUME ["/data/audit"]

EXPOSE 19003

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "const net=require('net');const c=net.connect(19003,'127.0.0.1',()=>{c.destroy();process.exit(0)});c.on('error',()=>process.exit(1));" || exit 1

CMD ["node", "packages/audit-system/dist/index.js"]
