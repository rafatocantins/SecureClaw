# syntax=docker/dockerfile:1.7
# Tessera Credential Vault — multi-stage build, non-root UID 10001
# NOTE: keytar requires libsecret on Linux. In containers we use a
# file-based fallback encrypted with VAULT_MASTER_KEY env var.
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10 --activate && \
    apk add --no-cache libsecret

FROM base AS deps
WORKDIR /app
COPY .npmrc pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY packages/shared/package.json packages/shared/
COPY packages/credential-vault/package.json packages/credential-vault/
RUN pnpm install --frozen-lockfile --filter @tessera/credential-vault... && \
    mkdir -p /app/packages/shared/node_modules /app/packages/credential-vault/node_modules

FROM deps AS build
COPY packages/shared/ packages/shared/
COPY packages/credential-vault/ packages/credential-vault/
COPY tsconfig.base.json ./
RUN pnpm --filter @tessera/shared build && \
    pnpm --filter @tessera/credential-vault build

FROM node:22-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache libsecret

RUN addgroup -g 10001 tessera && \
    adduser -u 10001 -G tessera -s /bin/sh -D tessera

RUN mkdir -p /data/vault && chown -R 10001:10001 /data

COPY --from=build --chown=10001:10001 /app/packages/shared/dist/ packages/shared/dist/
COPY --from=build --chown=10001:10001 /app/packages/shared/package.json packages/shared/
COPY --from=build --chown=10001:10001 /app/packages/credential-vault/dist/ packages/credential-vault/dist/
COPY --from=build --chown=10001:10001 /app/packages/credential-vault/package.json packages/credential-vault/
COPY --from=deps --chown=10001:10001 /app/node_modules/ node_modules/
COPY --from=deps --chown=10001:10001 /app/packages/shared/node_modules/ packages/shared/node_modules/
COPY --from=deps --chown=10001:10001 /app/packages/credential-vault/node_modules/ packages/credential-vault/node_modules/

USER 10001:10001

ENV NODE_ENV=production
VOLUME ["/data/vault"]

EXPOSE 19002

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "const net=require('net');const c=net.connect(19002,'127.0.0.1',()=>{c.destroy();process.exit(0)});c.on('error',()=>process.exit(1));" || exit 1

CMD ["node", "packages/credential-vault/dist/index.js"]
