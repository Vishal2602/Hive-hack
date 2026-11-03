# Hive — local coordinator for AI coding agents (fresh build, November 2026)

Hive helps several AI coding agents working on one TypeScript repository agree on shared
interfaces before incompatible work spreads. Agents register what they intend to do; Hive finds
candidate conflicts with deterministic rules and the TypeScript compiler, proposes a versioned
**Ghost Contract** (a pending interface declaration consumers can type-check against while the
producer is still working), records exact-version acknowledgements, stages supported semantic
edits safely, and only calls an agreement *verified* when real code passes a real test command.

This is a clean rebuild from a starter kit. It is a working hackathon build, not a product.
`docs/PROGRESS.md` says precisely what is implemented and tested, `VERIFICATION.md` what was run.

## Requirements
Node 22.18 or newer (built and tested on v22.22.3; native TypeScript execution and the built-in
`node:sqlite`). No native modules. `npm install` pulls ts-morph, the MCP SDK and zod.

## Run
```bash
npm install
npm run check          # root typecheck + 105 tests (about a minute; spawns daemons and node --test children)
npm run build:web      # builds the React dashboard into web/dist (the daemon serves it at /ui)
npm start              # the one shared daemon (loopback by default), dashboard at http://127.0.0.1:4317/ui
npm run demo           # SCRIPTED REPLAY of the full flow on a temp copy of fixtures/billing (exit 0 = all states reached)
npm run evaluate -- --repeats 3   # ACCEPTANCE.md scenarios with/without Hive -> evaluation/results-<timestamp>.{json,md}

# Seeded live dashboard (billing scenario on a temp copy of ../hive-playground; no model call):
node --disable-warning=ExperimentalWarning scripts/seed-demo.ts --port 4318 [--keep]
# prints http://127.0.0.1:4318/ui/ and a throwaway admin token to stderr (or uses $HIVE_TOKEN without printing it)
```
`.env` holds `HIVE_TOKEN` (the operator/admin token; generate one with
`node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`) and
optionally `MODEL_API_KEY` for Muse Spark analysis. Never commit `.env`.

Daemon settings: `HIVE_PROJECT_ROOT` (default: current directory; use the repository you want
coordinated), `HIVE_DATA_DIR` (default `<root>/.hive`, SQLite file `hive.db`), `HIVE_HOST`
(default `127.0.0.1`; `0.0.0.0` only behind TLS), `PORT` then `HIVE_PORT` (4317), `HIVE_PUBLIC_URL`
(public base URL used in the dashboard's connect snippets), `HIVE_WEB_DIST` (alternative web build
folder), `HIVE_TSCONFIG`, `HIVE_VERIFY_ALLOW` (comma-separated command prefixes allowed for
`hive_verify`; default `npm test,npm run,node --test,npx tsc,npx vitest`),
`HIVE_REQUIRE_AGREEMENT=1` (also gate operations on symbols other sessions depend on),
`HIVE_HOOK_GATE=ask|deny|warn` (pre-write hook behavior).

### Dashboard, roles and tokens
Open `/ui` and sign in with a token (kept in the tab's sessionStorage, never in the page or bundle).
- **admin**: `HIVE_TOKEN` (the operator) or an admin token. Everything, including `token_create`,
  `token_list`, `token_rename`, `token_revoke` (Members page).
- **member**: a token per person/laptop. Registers agents and runs session commands only on sessions
  registered with its own token; can use `/mcp`.
- **viewer**: read-only (for judges). Only `GET /api/view`, `/me`, `/events` (scrubbed) and `/healthz`;
  every POST, `/snapshot` and `/mcp` is refused with 403.

Token values are shown once when created and stored hashed. `GET /healthz` needs no token.

## Connect a coding client
Each client starts its own stdio adapter, or connects over HTTP MCP; all of them talk to the same
daemon. Do not launch a separate daemon per agent. Stdio templates (replace `/ABSOLUTE/PATH/Hive`):
- Claude Code: `config/claude-code.mcp.example.json` (MCP) and `config/claude-code.settings.example.json` (hooks).
- Muse Code: `config/muse-code.settings.example.json` — MCP fields follow the official docs; the hooks
  block is a best guess because the hook stdin/stdout contract is not documented and Muse Code was
  not available on the build machine. See `docs/CLIENTS.md` for exactly what is gated vs observed.

HTTP MCP (Streamable HTTP at `/mcp`, member or admin token; placeholders, not real values):
```bash
claude mcp add --transport http hive https://<your-hive-host>/mcp --header "Authorization: Bearer <member-token>"
```
or in `.mcp.json`: `{"mcpServers": {"hive": {"type": "http", "url": "https://<your-hive-host>/mcp",
"headers": {"Authorization": "Bearer <member-token>"}}}}`. The dashboard's Connect page generates these
with your host filled in. Caveat: a remote daemon checks and edits **its own** checkout
(`HIVE_PROJECT_ROOT`), not the files on the agent's laptop; see `docs/CLIENTS.md`.

MCP tools: `hive_register`, `hive_set_intent`, `hive_context`, `hive_symbol`, `hive_reindex`,
`hive_preview_operation`, `hive_apply_operation`, `hive_propose_contract`, `hive_acknowledge`,
`hive_revise_contract`, `hive_reject_contract`, `hive_contract_check`, `hive_verify`, `hive_claim`,
`hive_analyze`, `hive_finish`.

## Laptop sync (each teammate on their own machine)
Hive keeps each member's uncommitted `.ts`/`.tsx` changes (sent by their Claude Code hook) and type-checks them
together, so an edit that would break a teammate's in-progress code is caught before it is written. Setup is one
command from the Connect screen. Details and limits: `docs/DEPLOY.md` (Laptop sync).

## Deploying
Hive runs as a plain Node program (no Docker). Hosting steps for Railway's Node builder are in
`docs/DEPLOY.md` (`railway.json`, one volume at `/data`). **Nothing has been deployed.**

## Implemented and tested (see docs/PROGRESS.md for detail)
- One daemon, SQLite durability (`node:sqlite`, WAL, migrations), repositories/workspaces
  (worktrees), session leases, intent revisions, durable events, restart recovery.
- Compiler index (ts-morph): symbols keyed `path#Qualified.name:kind`, references resolved
  through aliases/barrels/re-exports, overload sets, excluded files, hash-based direct-edit detection.
- Findings: assumption mismatch (deterministic), compiler `dependent_write`, informational
  overlaps, `direct_edit` after the fact, `claim_violation`; unrelated work stays unwarned.
- Staged operations `add_field` and `change_signature`: preview with baseline-relative
  diagnostics, diff and callers; apply under a writer lock with revision + hash recheck, durable
  journal, rollback and crash recovery. Required arguments/fields are never invented.
- Ghost Contracts: validated declarations, overlay type-check for consumers, real check without
  overlay, exact-version acknowledgements, revise clears acks, agreement gate, `implemented`
  from compiler evidence, `verified` only from an allowlisted test command exit 0 + real
  type-check + implementation evidence; later edits downgrade the evidence.
- Muse Spark analyzer: bounded evidence, structured output, validated/cited findings, cache,
  bounded retry, explicit `unavailable`/`invalid`/`stale` states (mock-tested only, see below).
- Client hook adapter (Claude Code JSON contract; Muse plain text + raw payload capture),
  scripted demo, evaluation harness.
- Cloud build (2026-11-02/03): admin/member/viewer tokens, hostable daemon (`/healthz`, graceful
  SIGTERM, cached snapshot, paged events), asynchronous verification, HTTP MCP at `/mcp`,
  Railway config (Docker packaging removed 2026-11-03), React dashboard at `/ui`. Local release checks: `VERIFICATION.md`.

## Not done / not verified
- Live model: `evaluation/results-2026-11-02T23-36-49-615Z.md` records a configured `muse-spark-1.3`
  with token usage in a scripted evaluation; no live Muse Spark result was recorded for the cloud build
  or in a live coding-session demo.
- Muse Code was not installed: its hook schema and MCP loading are unverified live.
- Not deployed: no Railway (or other hosted) run yet.
- No run with two real independent agents yet (Claude Code can serve as a client with the
  templates; the demo and evaluation are scripted replays and labelled as such).
- `rename_symbol` and `add_endpoint` are rejected explicitly, not implemented.
- Direct edits are observed afterwards; only the client's own hooked tool calls can be gated.

## Why a local daemon?
One coordinator with thin adapters avoids separate in-memory worlds per agent, centralizes
writer serialization and gives the dashboard one event source. It defaults to loopback on one
trusted machine; hosting it adds per-member tokens and roles, but it still serves one trusted
repository checkout and runs that repository's allowlisted tests without sandboxing.

See `docs/SOURCES.md` for the documentation checked while building.
