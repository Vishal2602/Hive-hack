# Hive cloud app: design spec (approved direction, 2026-11-02)

Inputs: user direction (React app, generated-token connect flow, Linear-style sidebar, zanwei table-of-content
rail for the activity timeline only, Arc UI components, equal weight for developer / teammate / judge),
HIVE_CLOUD_HANDOFF.md (code-verified state), HIVE_CLOUD_PLAN.md (single Railway service, viewer/operator split,
hostable daemon, async verification, container + volume, release checks). Deadline: Nov 4, 9 PM ET.

## Goals
1. One hosted Hive service (daemon + React dashboard) on Railway with a persistent volume and the existing SQLite.
2. People connect from anywhere over the cloud link with a generated token; roles decide what they can do.
3. The dashboard is progress-first and honest: agreement accepted, implemented, verified are distinct; green only
   with passing evidence on applied code.
4. Judges get a read-only view that never exposes operator or model credentials.

## Roles and tokens (backend)
- Bootstrap: `HIVE_TOKEN` stays the operator credential (admin). Never shown in the UI.
- `tokens` table: id, label, member name, role (admin | member | viewer), sha256 hash, prefix, created_by,
  created_at, last_used_at, revoked_at. Token string format `hive_<role3>_<base62>`; shown once at creation.
- Auth on every request: Bearer value matches HIVE_TOKEN (admin) or an active token (role attached). Viewers may
  only GET `/api/view`, `/me`, `/healthz`, `/events`. Members may use session commands only for sessions created
  with their own token (session.token_id). Admins may create/list/rename/revoke tokens.
- Sessions record token_id and member name; the dashboard shows "Member · agent name".

## Hostable daemon (backend)
- `HIVE_HOST` override (default 127.0.0.1); `PORT` honoured (Railway) with `HIVE_PORT` fallback.
- `GET /healthz` (unauthenticated): `{ok, revision, indexed, recovered, uptimeMs}`; never calls sync.
- SIGTERM/SIGINT: stop accepting writes, wait for in-flight apply/verify up to 10 s, close SQLite, exit 0.
- Cached snapshot: computed on every state change and on a 5 s timer that runs the cheap drift check; `/snapshot`
  and `/api/view` serve the cache; `?fresh=1` (member/admin) forces sync.
- `/events?after=N&limit=M` returns ascending seq > N without skipping.
- `/api/view` (viewer-safe): sessions (member, agent name, task ≤ 120 chars, step), findings (kind, severity,
  evidence ≤ 300 chars, repo-relative symbols/files), contracts (title, version, status, producer symbol,
  participants, signatures per version, verification outcomes: command, exit code, revision, passed), events
  (type, detail ≤ 200 chars), analysis (status, summary, model, latency), model.configured. No absolute paths,
  no source excerpts, no hook payloads, no token values, no diffs.

## Asynchronous verification (backend)
- `verify` spawns (not spawnSync) the allowlisted command with explicit cwd, minimal env, 120 s timeout, output
  capped at 64 KB; inserts a run with status `running`; returns `{runId, status}` immediately.
- On exit: record exit code, hashes of producer + consumer files, revision; recompute contract status; emit events.
  If any of those files changed during the run, the run is recorded as `inconclusive`, never `passed`.
- `GET /command verify_status {runId}`; the MCP tool `hive_verify` waits up to 90 s for completion, then returns
  the run (pending runs are reported as pending, not as failures).
- Heartbeats keep working during verification because nothing blocks the event loop; the stdio adapter retries a
  failed heartbeat 3 times (5 s apart) before dropping its session.

## MCP over HTTP (backend)
- `POST/GET/DELETE /mcp` using the SDK's Streamable HTTP transport, Bearer member or admin token required.
  One MCP session = one Hive session; `hive_register` binds them; the server heartbeats on each request.
- Tool definitions move to `src/server/tools.ts` and are shared by stdio and HTTP adapters.
- Remote agents coordinate intents and agreements only; code checks run against the service's own checkout.
  The Connect flow says so in one sentence.

## Container and Railway
- `Dockerfile` (node:22-bookworm-slim, npm ci, web build, non-root), `.dockerignore`, `deploy/entrypoint.sh`:
  if `/data/repo` is absent, initialise it from the bundled `deploy/playground/` snapshot (git init + commit),
  run `npm ci` there; never reset an existing checkout; then start the daemon with HIVE_PROJECT_ROOT=/data/repo,
  HIVE_DATA_DIR=/data/.hive, HIVE_HOST=0.0.0.0.
- `railway.json`: Dockerfile build, healthcheck `/healthz`, restart policy; `docs/DEPLOY.md` lists env vars and
  the release checks from HIVE_CLOUD_PLAN.md. No deployment is performed by the build.

## Web app (React, Vite, Arc UI; served by the daemon at /ui)
- Build output `web/dist` with base `/ui/`; daemon serves it with SPA fallback; replaces `src/dashboard/index.html`.
- Navigation: Linear-style sidebar: 240 px, collapsible to a 56 px icon rail (state in localStorage), workspace
  header (Hive · workspace, cloud link with copy), items Overview, Connect, Agreements, Activity, Members with
  counts, keyboard shortcuts (g o, g c, g a, g t, g m), footer with server status, theme and user menu. Below
  1024 px: top bar with a menu sheet. Icons from an inline SVG set (no icon dependency unless Arc ships one).
- Activity: the vendored table-of-content web component as the event scrubber + event detail pane. Nowhere else.
- Screens as in the approved prototype (sign-in, /join#token, Connect 3 steps, Overview, Agreements list/detail,
  Members), now wired to live data: `/me` for role and workspace, `/api/view` for viewers, `/snapshot` for
  members/admins, `/events?after` for incremental timeline, admin token actions, real config snippets using the
  public URL from `/me.publicUrl` (set via `HIVE_PUBLIC_URL`, else window.location.origin).
- States: empty, offline, stale, model unavailable, viewer read-only, revoked token (401 → sign-in).
- Untrusted strings as text; CSP from the daemon; no secrets in the bundle.

## Tests (must pass; `npm test` and web typecheck/build)
- tokens: create/revoke/roles; viewer cannot POST commands or read `/snapshot`; member cannot act for another
  member's session; admin bootstrap works.
- hostable: healthz, HIVE_HOST/PORT, SIGTERM drains and closes, cached snapshot served without sync, events paging.
- async verify: returns running; completes; heartbeat during a slow verify survives; file change → inconclusive.
- HTTP MCP: two HTTP clients register, exchange a finding, one acknowledges a contract.
- container: Dockerfile builds locally if Docker is available; entrypoint initialises /data/repo on a temp volume.
- web: component tests light; design-manager screenshot review of every screen against a live seeded daemon.

## Out of scope this week
SSO, multi-repository coordinator, hub + local workers, Postgres, Vercel frontend hosting, Muse Code live
capture (unless installed), rename_symbol/add_endpoint.
