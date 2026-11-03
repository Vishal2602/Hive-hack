# Deploying Hive

Hive is a plain Node 22 program: there is no container image. Locally you run it with `npm start`;
a host only needs Node >= 22.18, git, and a persistent disk. Nothing has been deployed yet.

Docker packaging (Dockerfile, entrypoint, bundled playground snapshot, container test) was removed
on 2026-11-03. The sample billing repo now lives outside this repo at `../hive-playground`.

## Run locally
```bash
npm install
npm run build:web          # builds the dashboard into web/dist (served at /ui)
HIVE_PROJECT_ROOT=../hive-playground npm start
# dashboard: http://127.0.0.1:4317/ui  (sign in with HIVE_TOKEN from .env)
```

## Railway (not performed)
`railway.json` builds with Railway's Node builder (`npm ci && npm run build:web`) and starts with
`npm run start:prod` (env comes from the platform, not `.env`). One replica, health check `/healthz`.

1. New service from this repository. Add a volume mounted at `/data`.
2. Set service variables:
   - `HIVE_TOKEN`: long random value (admin credential). The daemon refuses to start without it.
   - `HIVE_HOST=0.0.0.0` (the daemon binds loopback by default). Railway sets `PORT`.
   - `RAILPACK_DEPLOY_APT_PACKAGES=git`: Railway's Node image has no `git`; Hive needs it to clone the repo and read its base commit.
   - `HIVE_PROJECT_ROOT=/data/repo` and `HIVE_DATA_DIR=/data/.hive`.
   - `HIVE_REPO_URL`: the team's Git repository (for a private repo, an HTTPS URL with a read-only token).
     On first boot Hive clones it into `/data/repo` and runs `npm ci --ignore-scripts`; an existing
     `/data/repo` is never touched. Optional `HIVE_REPO_BRANCH`.
   - Optional: `MODEL_API_KEY`, `HIVE_MODEL`, `HIVE_PUBLIC_URL`, `HIVE_VERIFY_ALLOW`.
3. Generate a domain, open `<domain>/ui`, sign in with `HIVE_TOKEN`, create a member token per person.
4. Each person runs the Connect screen's one-line setup inside their own clone of the repo:
   `curl -fsSL <domain>/connect.mjs -o hive-connect.mjs && node hive-connect.mjs <token> && rm hive-connect.mjs`.

## Laptop sync (how remote members are checked)
- `/connect.mjs` (public, no secrets) installs `.hive/hive-hook.mjs` (from `/hook.mjs`), adds Claude Code hooks and
  `HIVE_URL`/`HIVE_TOKEN` to `.claude/settings.local.json`, adds both to `.git/info/exclude`, and runs
  `claude mcp add --scope local` for the `/mcp` endpoint.
- The hook sends changed `.ts`/`.tsx` files (vs Hive's base commit, plus untracked files) at session start and
  each prompt, and each edited file after a write. Before a write it sends the file as it will look and Hive
  type-checks base + every member's changes + this edit in memory. If the edit adds errors in a file another
  member is changing, the write is gated (`HIVE_HOOK_GATE`: ask by default). Pushed files live in SQLite only;
  the hub checkout is never written.
- Model analysis receives bounded diffs of every member's changes, so Muse Spark can flag a units mismatch
  that type-checks.
- **Laptop relay for the model.** From our Railway service (US East and US West) the Meta Model API returned an
  empty model list for a key that lists every model from a laptop (docs: "Model availability can vary by
  country"). `node .hive/hive-hook.mjs analyze` on a member's laptop asks Hive for the exact request
  (`analysis_relay_request`), sends it with the laptop's `MODEL_API_KEY`, and posts the raw response back
  (`analysis_relay_submit`); Hive parses and validates it exactly as a direct call and records it, labelled as
  relayed. Setup stores `MODEL_API_KEY` in `.claude/settings.local.json` when it is set while running `connect.mjs`.
- Limits: only TypeScript type errors are found deterministically; edits made outside Claude Code's
  Edit/Write tools are picked up at the next prompt (full sync), not gated; the hub base is not pulled
  automatically, so after merging, redeploy or recreate `/data/repo` to move the base forward.

## Environment variables
| Variable | Required | Meaning |
|---|---|---|
| `HIVE_TOKEN` | **yes** | Operator (admin) credential. Never shown in the UI; the placeholder value is rejected. |
| `MODEL_API_KEY` | no | Muse Spark key. Without it analysis reports "unavailable". Every analysis with a key is a paid call. |
| `HIVE_MODEL` / `HIVE_MODEL_BASE_URL` | no | Default `muse-spark-1.3` at `https://api.meta.ai/v1`. |
| `HIVE_REPO_URL` / `HIVE_REPO_BRANCH` | no | Cloned into `HIVE_PROJECT_ROOT` on first boot when that folder is missing or empty. |
| `HIVE_PROJECT_ROOT` | no | The repository Hive indexes, edits and verifies (default: current directory). |
| `HIVE_DATA_DIR` | no | SQLite state and recovery journal (default `<project root>/.hive`). |
| `HIVE_HOST` | no | Bind address, default `127.0.0.1`. Set `0.0.0.0` only on a host behind TLS. |
| `PORT` / `HIVE_PORT` | no | Listen port, default 4317. |
| `HIVE_PUBLIC_URL` | no | Public base URL used in the Connect screen snippets. |
| `HIVE_VERIFY_ALLOW` | no | Command prefixes `verify` may run. Default: `npm test, npm run, node --test, npx tsc, npx vitest`. |
| `HIVE_HOOK_GATE` | no | Hook behaviour before an unagreed shared write: `ask` (default), `deny`, `warn`. |
| `HIVE_REQUIRE_AGREEMENT` | no | `1` makes dependent writes require an agreed contract. |

## Honest limits
- **Single instance.** One daemon owns the SQLite file and the checkout; do not scale replicas.
- **Back up the volume** (Railway volume backups). SQLite runs in WAL mode.
- **Verification runs on the host.** `verify` runs tests against `/data/repo`, not against laptop changes.
  Type checks of laptop changes happen in memory (see Laptop sync).
- **No TLS in Hive.** The host terminates TLS.
