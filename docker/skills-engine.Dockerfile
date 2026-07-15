# syntax=docker/dockerfile:1.7
# Tessera Skills Engine — multi-stage build, non-root UID 10001
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10 --activate

FROM base AS deps
WORKDIR /app
COPY .npmrc pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY packages/shared/package.json packages/shared/
COPY packages/skills-engine/package.json packages/skills-engine/
RUN pnpm install --frozen-lockfile --filter @tessera/skills-engine... && \
    mkdir -p /app/packages/skills-engine/node_modules

FROM deps AS build
COPY packages/shared/ packages/shared/
COPY packages/skills-engine/ packages/skills-engine/
COPY tsconfig.base.json ./
RUN pnpm --filter @tessera/shared build && \
    pnpm --filter @tessera/skills-engine build

FROM node:22-alpine AS runtime
WORKDIR /app

RUN addgroup -g 10001 tessera && \
    adduser -u 10001 -G tessera -s /bin/sh -D tessera && \
    mkdir -p /data/skills && chown 10001:10001 /data/skills

COPY --from=build --chown=10001:10001 /app/packages/shared/dist/ packages/shared/dist/
COPY --from=build --chown=10001:10001 /app/packages/shared/src/proto/ packages/shared/src/proto/
COPY --from=build --chown=10001:10001 /app/packages/shared/package.json packages/shared/
COPY --from=build --chown=10001:10001 /app/packages/skills-engine/dist/ packages/skills-engine/dist/
COPY --from=build --chown=10001:10001 /app/packages/skills-engine/package.json packages/skills-engine/
COPY --from=deps --chown=10001:10001 /app/node_modules/ node_modules/
COPY --from=deps --chown=10001:10001 /app/packages/skills-engine/node_modules/ packages/skills-engine/node_modules/

USER 10001:10001

ENV NODE_ENV=production
ENV SKILLS_REGISTRY_PATH=/data/skills/registry.json

VOLUME ["/data/skills"]
EXPOSE 19005

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const net=require('net');const c=net.connect(19005,'127.0.0.1',()=>{c.destroy();process.exit(0)});c.on('error',()=>process.exit(1));" || exit 1

CMD ["node", "packages/skills-engine/dist/index.js"]
