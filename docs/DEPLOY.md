# Deploying Hive (container and Railway)

This is the packaging for the single-service plan in `docs/HIVE_CLOUD_PLAN.md`. Nothing here has
been deployed: the files build and run locally, and the Railway steps below are instructions, not a
record of a deployment.

## What is in the image

| Path in the image | What it is |
|---|---|
| `/app/src` | Hive daemon and adapters, run directly by Node 22 (type stripping, no build) |
| `/app/web/dist` | The React web app, built by Vite in the image build (`npm --prefix web run build`) |
| `/app/deploy/playground` | Snapshot of the `hive-playground` billing repo (from commit `1b97436`, without `node_modules`, `.git` and `.hive`; client configs point at `/app` instead of laptop paths) |
| `/app/deploy/entrypoint.sh` | Start script (below) |

Build stages: `deps` (all Hive deps) → `web` (web build, type-checks against `../src`) →
`prod-deps` (`npm ci --omit=dev`) → `runtime` (`node:22-bookworm-slim`, `git`, user `hive`,
`HEALTHCHECK` on `/healthz` using Node `fetch`). `.dockerignore` keeps `.env`, `.hive`,
`node_modules`, `web/screenshots`, `superdesign`, `evaluation` and doc images out of the build context.

Build argument `WEB_TYPECHECK=0` builds the web app with `vite build` only (no `tsc -b`). Use it only
while web and backend types are mid-change; the default is the type-checked build.

## The volume at /data

Mount one persistent volume at **`/data`**. Everything that must survive a restart lives there:

- `/data/repo`: the trusted checkout Hive indexes, edits and verifies (`HIVE_PROJECT_ROOT`).
- `/data/.hive/hive.db`: SQLite state and the recovery journal (`HIVE_DATA_DIR`).

The entrypoint (`deploy/entrypoint.sh`):

1. If started as root (Railway volumes are root-owned; set `RAILWAY_RUN_UID=0`), it gives `/data` to
   the `hive` user and re-executes itself as `hive` with `setpriv`. The daemon never runs as root.
2. Refuses to start without `HIVE_TOKEN`, or when `/data` is missing or not writable.
3. **`/data/repo` absent:** copies the snapshot into a temporary directory, `git init`, commits
   "playground snapshot", runs `npm ci` (dev deps included: the playground's `tsc` is a dev dep), then
   moves it to `/data/repo`. An interrupted first boot leaves no half-initialised repo.
4. **`/data/repo` present:** leaves it untouched (no reset, no checkout, no install). It only warns if
   `package-lock.json` differs from the snapshot or `node_modules` is missing.
5. Exports `HIVE_PROJECT_ROOT=/data/repo`, `HIVE_DATA_DIR=/data/.hive`, `HIVE_HOST=0.0.0.0`, copies
   Railway's `PORT` into `HIVE_PORT`, and `exec`s `node src/server/daemon.ts` so SIGTERM reaches the daemon.

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `HIVE_TOKEN` | **yes** | Operator (admin) credential. Long random value, set as a service secret. Never shown in the UI. The entrypoint exits without it; the daemon rejects the placeholder value. |
| `MODEL_API_KEY` | no | Key for the model endpoint. Without it analysis reports "unavailable"; everything else works. Every analysis with a key is a paid call. |
| `HIVE_MODEL` | no | Model ID, default `muse-spark-1.3`. `HIVE_MODEL_BASE_URL` overrides the endpoint (default `https://api.meta.ai/v1`). |
| `HIVE_PUBLIC_URL` | no | Public base URL (e.g. the Railway domain). The web app uses it in connect snippets; otherwise the browser origin. |
| `HIVE_VERIFY_ALLOW` | no | Comma-separated command prefixes `verify` may run. Default: `npm test, npm run, node --test, npx tsc, npx vitest`. Narrow it for a public demo, e.g. `npm test`. |
| `HIVE_HOOK_GATE` | no | Hook behaviour before a write that touches an unagreed contract: `ask` (default), `deny` or `warn`. Read by the hook process, so set it where the coding client runs. |
| `PORT` / `HIVE_PORT` | no | Listen port. Railway sets `PORT`; the image default is `HIVE_PORT=4317`. |
| `HIVE_HOST` | no | Bind address; the image sets `0.0.0.0` (local `npm start` keeps `127.0.0.1`). |
| `HIVE_REQUIRE_AGREEMENT` | no | `1` makes dependent writes require an agreed contract. |
| `RAILWAY_RUN_UID` | Railway | Set `0` so the entrypoint can fix volume ownership, then drop to `hive`. |
| `HIVE_URL` | clients | For co-located coding clients (MCP adapter, hooks): `http://127.0.0.1:$PORT`. |

`HIVE_PROJECT_ROOT` and `HIVE_DATA_DIR` are fixed by the entrypoint; do not set them on the service.

## Commands

```bash
npm run build:web                               # web/ install + build into web/dist
npm run start:prod                              # daemon without --env-file (env from the platform)
docker build -t hive .                          # image (add --build-arg WEB_TYPECHECK=0 if needed)
docker run --rm -p 4317:4317 -v hive-data:/data -e HIVE_TOKEN="$(openssl rand -hex 24)" hive
curl -s http://127.0.0.1:4317/healthz           # readiness
node --test tests/container.test.ts             # build + boot on a temp volume (skips without Docker)
HIVE_SKIP_CONTAINER_TEST=1 npm test             # fast loop without the container build
```

## Railway (not performed by this build)

1. New service from this repository; Railway reads `railway.json` (Dockerfile builder, one replica,
   `requiredMountPath` `/data`, healthcheck `/healthz` with 300 s timeout for the first-boot
   `npm ci`, restart `ON_FAILURE`, 30 s draining).
2. Add a volume mounted at `/data`. Set `HIVE_TOKEN`, `RAILWAY_RUN_UID=0`, and optionally
   `MODEL_API_KEY`, `HIVE_PUBLIC_URL`, `HIVE_VERIFY_ALLOW`.
3. Generate a domain, open `<domain>/ui`, sign in with the operator token and create member/viewer
   tokens from the dashboard. Give judges viewer tokens only.

## Release checks (from HIVE_CLOUD_PLAN.md)

Run against a local container first (`docker run ... -p 4317:4317 -v hive-data:/data --name hive hive`),
then repeat on the Railway service with its domain in place of `127.0.0.1:4317`.

- [ ] **Two real coding sessions** register distinct identities, see evidence about the same tree, and an
  unrelated edit proceeds; save a short redacted trace. The image contains no coding client. Locally:
  `HIVE_PROJECT_ROOT=../hive-playground npm start`, then two Claude Code sessions in the playground.
  Automated proxy: `node --test tests/transport.test.ts` plus the HTTP MCP test in `npm test`.
- [ ] **Judge view is read-only.** `curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:4317/command`
  → 401; repeat with `-H "Authorization: Bearer <viewer token>"` is refused (401/403) for apply, verify and analyze.
  Bundle has no secrets: `docker run --rm --entrypoint sh hive -c 'grep -rlE "hive_(adm|mem|vie)_|MODEL_API_KEY" /app/web/dist || echo clean'`.
- [ ] **State persists across restart.** Create an agreement, `docker restart hive`, confirm it in
  `/snapshot`. `node --test tests/container.test.ts` checks the checkout and edits survive a restart.
- [ ] **Recovery on a disposable volume.** `node --test tests/ops.test.ts` (interrupted journal recovery), then
  integrity and hashes on the container:
  `docker exec hive node -e "const {DatabaseSync}=require('node:sqlite');console.log(new DatabaseSync('/data/.hive/hive.db').prepare('PRAGMA integrity_check').get())"`
  and `docker exec hive sh -c 'cd /data/repo && git status --porcelain && sha256sum src/*.ts'`.
- [ ] **Backup and restore rehearsed.** Stop the service, then
  `docker run --rm -v hive-data:/data -v "$PWD":/backup debian:bookworm-slim tar czf /backup/hive-data.tgz -C / data`;
  restore into a new volume with `tar xzf` and boot on it. On Railway enable volume backups and restore one.
- [ ] **Slow verification does not block.** Start a long `verify`, and meanwhile
  `while true; do curl -s -o /dev/null -w '%{http_code} ' http://127.0.0.1:4317/healthz; sleep 1; done`
  stays 200 and both agents' 30 s heartbeats survive. Automated: the async verify tests in `npm test`.
- [ ] **Billing case.** 1999 cents vs an invoice showing $19.99; remove the temporary declaration first,
  then `docker exec hive sh -c 'cd /data/repo && npm test && npx tsc --noEmit'`. Label it verification of
  this single checkout.
- [ ] **Live model result** with model ID and elapsed time: `npm run smoke:model` (one paid call, needs
  `MODEL_API_KEY`), and an analysis from the dashboard on the hosted service.

## Honest limits

- **Single instance.** One daemon owns the SQLite file and the checkout; do not scale replicas.
  Railway volumes attach to one replica, and a redeploy has a short stop/start gap.
- **SQLite on the volume.** WAL mode on local volume storage; no Postgres. Back up the volume.
- **Agents co-located for compiler checks.** Edits, compiler checks and verification run against
  `/data/repo` inside the service. Remote agents over the cloud link coordinate intents and agreements
  only; they cannot have their own laptops' files checked.
- **No coding client in the image.** Running Claude Code / Muse Code next to the daemon needs a derived
  image or a Codespace (see the plan's fallback).
- **No TLS in the container.** Railway terminates TLS at its edge.
- **Playground snapshot is static.** Updating it means rebuilding the image; an existing `/data/repo` is
  never replaced automatically (delete it deliberately to re-initialise).
