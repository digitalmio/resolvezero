FROM oven/bun:1-slim

# App entrypoint override (fly.toml build-args; defaults to the edge)
ARG ENTRY=apps/edge/src/index.ts
# ARG values are build-time only; ENV makes the entrypoint resolvable at RUN
# (CMD shell form expands $ENTRY at container start).
ENV APP_ENTRY=$ENTRY

WORKDIR /app

# Workspace-aware install: root manifests + dep manifests for layer caching
COPY package.json bun.lock ./
COPY packages/db/package.json packages/db/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY apps/edge/package.json apps/edge/package.json
COPY apps/control/package.json apps/control/package.json
RUN bun install --frozen-lockfile

# Application sources
COPY packages/db packages/db
COPY packages/shared packages/shared
COPY apps/edge apps/edge
COPY apps/control apps/control

ENV NODE_ENV=production
EXPOSE 8080 53 53/udp

CMD ["sh", "-c", "exec bun run $APP_ENTRY"]

# Privileges: start as root only to bind privileged port 53, then the app
# calls dropPrivileges() immediately after binding and runs as UID/GID 1000.
# Override with DROP_UID/DROP_GID; DROP_PRIVILEGES=0 keeps root (not
# recommended). Home is writable by the unprivileged runtime user.
ENV HOME=/tmp

# Same path for edge and control (control aliases /healthz alongside /api/healthz).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
