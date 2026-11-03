#!/bin/sh
# Hive container entrypoint (see docs/DEPLOY.md).
# - First boot: initialise /data/repo from the bundled playground snapshot (git init + commit,
#   npm ci). It is built in a temporary directory and moved into place only when complete.
# - Later boots: never touch an existing /data/repo; only warn if its lockfile has drifted.
# - Then exec the daemon as PID 1 so SIGTERM reaches it.
# All output goes to stderr; nothing here prints secret values.
set -eu

log() { echo "hive-entrypoint: $*" >&2; }
fail() { log "ERROR: $*"; exit 1; }

APP_DIR=${HIVE_APP_DIR:-/app}
DATA_ROOT=${HIVE_DATA_ROOT:-/data}
SNAPSHOT=${HIVE_PLAYGROUND_SNAPSHOT:-$APP_DIR/deploy/playground}
REPO=$DATA_ROOT/repo

# Railway mounts volumes owned by root. If started as root (RAILWAY_RUN_UID=0), hand /data to
# the unprivileged hive user and re-exec as that user. The daemon never runs as root.
if [ "$(id -u)" = "0" ]; then
  id hive >/dev/null 2>&1 || fail "running as root but the hive user does not exist"
  mkdir -p "$DATA_ROOT"
  chown hive:hive "$DATA_ROOT"
  [ -d "$REPO" ] && [ "$(stat -c %u "$REPO")" = "0" ] && chown -R hive:hive "$REPO"
  [ -d "$DATA_ROOT/.hive" ] && chown -R hive:hive "$DATA_ROOT/.hive"
  log "dropping root; continuing as user hive"
  exec setpriv --reuid=hive --regid=hive --init-groups env HOME=/home/hive "$0" "$@"
fi

[ -d "$DATA_ROOT" ] || fail "$DATA_ROOT does not exist; mount a volume at $DATA_ROOT"
[ -w "$DATA_ROOT" ] || fail "$DATA_ROOT is not writable by uid $(id -u). On Railway set RAILWAY_RUN_UID=0 (the entrypoint drops to the hive user) or fix the volume owner."
[ -n "${HIVE_TOKEN:-}" ] || fail "HIVE_TOKEN is not set; set a long random value as a service secret"
[ -f "$SNAPSHOT/package.json" ] || fail "playground snapshot missing at $SNAPSHOT"

if [ ! -e "$REPO" ]; then
  log "initialising $REPO from the bundled playground snapshot"
  STAGE=$DATA_ROOT/.repo-init.$$
  rm -rf "$DATA_ROOT"/.repo-init.*
  mkdir -p "$STAGE"
  cp -R "$SNAPSHOT/." "$STAGE/"
  git -C "$STAGE" init -q -b main
  git -C "$STAGE" add -A
  git -C "$STAGE" -c user.name="Hive" -c user.email="hive@localhost" -c commit.gpgsign=false \
    commit -q -m "playground snapshot"
  (cd "$STAGE" && npm ci --include=dev --no-audit --no-fund --loglevel=error >&2) || { rm -rf "$STAGE"; fail "npm ci failed in the playground"; }
  mv "$STAGE" "$REPO"
  log "initialised $REPO at $(git -C "$REPO" rev-parse --short HEAD)"
elif [ ! -d "$REPO" ]; then
  fail "$REPO exists but is not a directory; refusing to touch it"
else
  log "using existing $REPO (left untouched)"
  if [ ! -f "$REPO/package-lock.json" ]; then
    log "WARNING: $REPO has no package-lock.json; it is not the bundled playground"
  elif ! cmp -s "$REPO/package-lock.json" "$SNAPSHOT/package-lock.json"; then
    log "WARNING: $REPO/package-lock.json differs from the bundled snapshot; dependencies may not match this image"
  fi
  [ -d "$REPO/node_modules" ] || log "WARNING: $REPO/node_modules is missing; verify commands may fail (run npm ci there)"
fi

mkdir -p "$DATA_ROOT/.hive"
export HIVE_PROJECT_ROOT="$REPO"
export HIVE_DATA_DIR="$DATA_ROOT/.hive"
export HIVE_HOST="${HIVE_HOST:-0.0.0.0}"
# Railway injects PORT; keep HIVE_PORT in step for the daemon and the healthcheck.
if [ -n "${PORT:-}" ]; then export HIVE_PORT="$PORT"; fi

cd "$APP_DIR"
exec node --disable-warning=ExperimentalWarning src/server/daemon.ts
