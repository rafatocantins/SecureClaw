# syntax=docker/dockerfile:1.7
# Tessera Gateway — multi-stage build, non-root UID 10001
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate

# ── deps stage: install all workspace deps ──────────────────────────────────
FROM base AS deps
WORKDIR /app
COPY .npmrc pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY packages/shared/package.json packages/shared/
COPY packages/gateway/package.json packages/gateway/
RUN pnpm install --frozen-lockfile --filter @tessera/gateway... && \
    mkdir -p /app/packages/shared/node_modules /app/packages/gateway/node_modules

# ── build stage ─────────────────────────────────────────────────────────────
FROM deps AS build
COPY packages/shared/ packages/shared/
COPY packages/gateway/ packages/gateway/
COPY tsconfig.base.json ./
RUN pnpm --filter @tessera/shared build && \
    pnpm --filter @tessera/gateway build

# ── runtime stage ───────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

# Create non-root user (UID 10001)
RUN addgroup -g 10001 tessera && \
    adduser -u 10001 -G tessera -s /bin/sh -D tessera

COPY --from=build --chown=10001:10001 /app/packages/shared/dist/ packages/shared/dist/
COPY --from=build --chown=10001:10001 /app/packages/shared/package.json packages/shared/
COPY --from=build --chown=10001:10001 /app/packages/gateway/dist/ packages/gateway/dist/
COPY --from=build --chown=10001:10001 /app/packages/gateway/package.json packages/gateway/
COPY --from=deps --chown=10001:10001 /app/node_modules/ node_modules/
COPY --from=deps --chown=10001:10001 /app/packages/shared/node_modules/ packages/shared/node_modules/
COPY --from=deps --chown=10001:10001 /app/packages/gateway/node_modules/ packages/gateway/node_modules/

USER 10001:10001

ENV NODE_ENV=production \
    GATEWAY_HOST=0.0.0.0 \
    GATEWAY_PORT=18789

EXPOSE 18789

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:18789/health || exit 1

CMD ["node", "packages/gateway/dist/index.js"]
