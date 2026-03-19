# syntax=docker/dockerfile:1.7
# tessera/web-search — Search the web via SerpAPI.
# Non-root UID 10001; read-only filesystem; no shell.
FROM node:22-alpine AS runtime

RUN addgroup -g 10001 tessera && \
    adduser -u 10001 -G tessera -s /bin/sh -D tessera

WORKDIR /app

COPY --chown=10001:10001 src/index.mjs ./

USER 10001:10001

ENV NODE_ENV=production

# Input:  TOOL_INPUT env var (JSON: { "query": "...", "serpapi-key": "<injected>" })
# Output: JSON to stdout
CMD ["node", "index.mjs"]
