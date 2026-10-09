FROM oven/bun:1-slim

WORKDIR /app

# Workspace-aware install: root manifests + dep manifests for layer caching
COPY package.json bun.lock ./
COPY packages/db/package.json packages/db/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY apps/edge/package.json apps/edge/package.json
RUN bun install --frozen-lockfile

# Application sources
COPY packages/db packages/db
COPY packages/shared packages/shared
COPY apps/edge apps/edge

ENV NODE_ENV=production
EXPOSE 8080 53 53/udp

CMD ["bun", "run", "apps/edge/src/index.ts"]
