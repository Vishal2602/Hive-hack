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
npm run check          # typecheck + 47 tests (about a minute; spawns daemons and node --test children)
npm run demo           # SCRIPTED REPLAY of the full flow on a temp copy of fixtures/billing (exit 0 = all states reached)
npm run evaluate -- --repeats 3   # ACCEPTANCE.md scenarios with/without Hive -> evaluation/results-<timestamp>.{json,md}
npm start              # the one shared local daemon (loopback only), dashboard at http://127.0.0.1:4317/ui
```
`.env` holds `HIVE_TOKEN` (a random local token shared by daemon, adapters and hooks; generate one
with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`) and
optionally `MODEL_API_KEY` for Muse Spark analysis. Never commit `.env`.

Daemon settings: `HIVE_PROJECT_ROOT` (default: current directory; use the repository you want
coordinated), `HIVE_DATA_DIR` (default `<root>/.hive`, SQLite file `hive.db`), `HIVE_PORT`
(4317), `HIVE_TSCONFIG`, `HIVE_VERIFY_ALLOW` (comma-separated command prefixes allowed for
`hive_verify`; default `npm test,npm run,node --test,npx tsc,npx vitest`),
`HIVE_REQUIRE_AGREEMENT=1` (also gate operations on symbols other sessions depend on),
`HIVE_HOOK_GATE=ask|deny|warn` (pre-write hook behavior).

## Connect a coding client
Each client starts its own stdio adapter; all adapters talk to the same daemon. Do not launch a
separate daemon per agent. Templates (replace `/ABSOLUTE/PATH/Hive`):
- Claude Code: `config/claude-code.mcp.example.json` (MCP) and `config/claude-code.settings.example.json` (hooks).
- Muse Code: `config/muse-code.settings.example.json` — MCP fields follow the official docs; the hooks
  block is a best guess because the hook stdin/stdout contract is not documented and Muse Code was
  not available on the build machine. See `docs/CLIENTS.md` for exactly what is gated vs observed.

MCP tools: `hive_register`, `hive_set_intent`, `hive_context`, `hive_symbol`, `hive_reindex`,
`hive_preview_operation`, `hive_apply_operation`, `hive_propose_contract`, `hive_acknowledge`,
`hive_revise_contract`, `hive_reject_contract`, `hive_contract_check`, `hive_verify`, `hive_claim`,
`hive_analyze`, `hive_finish`.

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
  read-only dashboard at `/ui`, scripted demo, evaluation harness.

## Not done / not verified
- No live Meta API call was made (no `MODEL_API_KEY` on the build machine).
- Muse Code was not installed: its hook schema and MCP loading are unverified live.
- No run with two real independent agents yet (Claude Code can serve as a client with the
  templates; the demo and evaluation are scripted replays and labelled as such).
- `rename_symbol` and `add_endpoint` are rejected explicitly, not implemented.
- The dashboard was verified over HTTP and against a fake DOM, not opened in a real browser here.
- Direct edits are observed afterwards; only the client's own hooked tool calls can be gated.

## Why a local daemon?
One local coordinator with thin stdio adapters avoids separate in-memory worlds per agent,
centralizes writer serialization and gives the dashboard one event source. It is a trusted
single-machine design: shared token, loopback only, no team authentication.

See `docs/SOURCES.md` for the documentation checked while building.
