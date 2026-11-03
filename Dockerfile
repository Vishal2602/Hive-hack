# Hive: one daemon, one trusted repository on a persistent volume at /data.
# Build:  docker build -t hive .
# Run:    docker run -p 4317:4317 -v hive-data:/data -e HIVE_TOKEN=<random> hive
# See docs/DEPLOY.md. Node >= 22.18 runs the TypeScript sources directly (type stripping).

ARG NODE_IMAGE=node:22-bookworm-slim

# 1. All of Hive's dependencies (dev included: the web build type-checks against ../src).
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# 2. Web app build (Vite, base /ui/). Builds whatever web/ currently contains.
FROM deps AS web
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY web/package.json web/package-lock.json ./web/
RUN npm --prefix web ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
# WEB_TYPECHECK=0 skips "tsc -b" and runs only "vite build" (escape hatch while the web types
# and backend types are mid-change). Default is the full, type-checked build.
ARG WEB_TYPECHECK=1
RUN if [ "$WEB_TYPECHECK" = "0" ]; then cd web && npx vite build; else npm --prefix web run build; fi

# 3. Production-only node_modules for the daemon.
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# 4. Runtime.
FROM ${NODE_IMAGE} AS runtime
# git: the entrypoint commits the playground base revision; Hive reads it for base commits.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system hive \
 && useradd --system --gid hive --create-home --home-dir /home/hive --shell /usr/sbin/nologin hive \
 && mkdir -p /data \
 && chown hive:hive /data
WORKDIR /app
ENV HIVE_PROJECT_ROOT=/data/repo \
    HIVE_DATA_DIR=/data/.hive \
    HIVE_HOST=0.0.0.0 \
    HIVE_PORT=4317 \
    NPM_CONFIG_UPDATE_NOTIFIER=false
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY deploy ./deploy
COPY --from=web /app/web/dist ./web/dist
RUN chmod 0755 deploy/entrypoint.sh
USER hive
VOLUME ["/data"]
EXPOSE 4317
HEALTHCHECK --interval=15s --timeout=5s --start-period=120s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || process.env.HIVE_PORT || 4317) + '/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["/app/deploy/entrypoint.sh"]
