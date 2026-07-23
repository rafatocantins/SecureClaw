# syntax=docker/dockerfile:1.7
# Tessera Sandbox Runtime — multi-stage build, non-root UID 10001
# This service manages Docker containers (gVisor runsc), so it needs
# access to the Docker socket. In production this should be via
# Docker-in-Docker or a Docker proxy with minimal permissions.
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10 --activate

FROM base AS deps
WORKDIR /app
COPY .npmrc pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY packages/shared/package.json packages/shared/
COPY packages/sandbox-runtime/package.json packages/sandbox-runtime/
RUN pnpm install --frozen-lockfile --filter @tessera/sandbox-runtime... && \
    mkdir -p /app/packages/shared/node_modules /app/packages/sandbox-runtime/node_modules

FROM deps AS build
COPY packages/shared/ packages/shared/
COPY packages/sandbox-runtime/ packages/sandbox-runtime/
COPY tsconfig.base.json ./
RUN pnpm --filter @tessera/shared build && \
    pnpm --filter @tessera/sandbox-runtime build

FROM node:22-alpine AS runtime
WORKDIR /app

# sandbox-runtime needs the docker group to access the socket.
# DOCKER_GID varies per host (e.g. 998 on Alpine, 999 on Ubuntu, 1001 on GHA).
# Build with: docker build --build-arg DOCKER_GID=$(stat -c '%g' /var/run/docker.sock) ...
# When running via docker compose, use group_add instead of build-time GID.
ARG DOCKER_GID=998
RUN addgroup -g ${DOCKER_GID} docker 2>/dev/null || true && \
    addgroup -g 10001 tessera && \
    adduser -u 10001 -G tessera -s /bin/sh -D tessera && \
    adduser tessera docker

COPY --from=build --chown=10001:10001 /app/packages/shared/dist/ packages/shared/dist/
COPY --from=build --chown=10001:10001 /app/packages/shared/src/proto/ packages/shared/src/proto/
COPY --from=build --chown=10001:10001 /app/packages/shared/package.json packages/shared/
COPY --from=build --chown=10001:10001 /app/packages/sandbox-runtime/dist/ packages/sandbox-runtime/dist/
COPY --from=build --chown=10001:10001 /app/packages/sandbox-runtime/package.json packages/sandbox-runtime/
COPY --from=deps --chown=10001:10001 /app/node_modules/ node_modules/
COPY --from=deps --chown=10001:10001 /app/packages/shared/node_modules/ packages/shared/node_modules/
COPY --from=deps --chown=10001:10001 /app/packages/sandbox-runtime/node_modules/ packages/sandbox-runtime/node_modules/

USER 10001

ENV NODE_ENV=production

EXPOSE 19004

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "const net=require('net');const c=net.connect(19004,'127.0.0.1',()=>{c.destroy();process.exit(0)});c.on('error',()=>process.exit(1));" || exit 1

CMD ["node", "packages/sandbox-runtime/dist/index.js"]
