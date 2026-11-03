# Hive cloud deployment handoff

This document is for whoever moves Hive from one laptop into the cloud. Hive is a local coordination daemon. It lets several AI coding agents, such as Claude Code sessions, working on one TypeScript repository declare what they intend to change, agree on shared API "contracts", detect conflicts, and apply a small set of compiler-checked edits safely. This handoff describes what the code does today, how it runs, what it depends on, and what would have to change for each of three cloud layouts. It recommends no option and quotes no prices.

**Inspection date:** 2026-11-02

**How to read this:** The code under `<Hive>` (the Hive folder; `<playground>` below means the sibling `hive-playground` sample repo) was inspected directly, and the author of this handoff ran the test suite and type-check (section 10). `README.md`, `VERIFICATION.md`, `CLAUDE.md` and everything in `docs/` were treated as claims to check, not as facts. Where a doc and the code disagree, the code wins and the disagreement is listed. Line numbers are approximate (±2) and refer to the files as they were on the inspection date. Secret values were never read or printed; only environment variable *names* appear here. The `web/` folder is a React prototype that another process was building during the inspection. It uses mock data, the daemon does not serve it, and nothing below depends on its state. The dashboard the daemon actually serves is `src/dashboard/index.html`.

---

## 1. What currently works

### In plain language

Today Hive runs on one machine. A background HTTP server (the "daemon") watches one TypeScript repository. Each coding agent starts a small helper process that connects the agent to the daemon over MCP. Through it, agents register, state their intent (task, files, symbols, assumptions), and propose and acknowledge API contracts. They also receive conflict findings, preview and apply two kinds of compiler-checked edit, and record test runs as evidence that a contract is verified. A read-only web dashboard shows the state. Hook scripts let Claude Code ask Hive before each file write and report back afterwards. Everything is stored in a SQLite file. An optional model call to the Muse Spark model, through a Meta OpenAI-compatible endpoint, classifies candidate conflicts.

### Source control state
- **Hive is not a git repository.** `git rev-parse --is-inside-work-tree` fails with `fatal: not a git repository`. There is no branch, no commit and no record of uncommitted changes. There is a `.gitignore`, which excludes `node_modules/`, `dist/`, `.env`, `.hive/`, `coverage/`, `*.log` and `.DS_Store`.
- **The sibling sample repo `<playground>` is a git repository.** It is on branch `master` at commit `1b97436` ("hive-playground: sample billing app wired to Hive"), with a clean working tree.

### Implemented and covered by tests
(The test suite of 47 tests passed during this inspection; see section 10.)
- **SQLite persistence.** It uses Node's built-in `node:sqlite` with WAL, migrations and nested transactions (`src/store/sqlite.ts`, `src/store/schema.ts`). Tests show that sessions, intents, contracts, events and the revision survive a restart, and that expired leases are released after a restart (`tests/store.test.ts`).
- **Sessions, intents and contracts.** This covers session leases with a 120 s TTL, intent revisions, and acknowledgements tied to an exact contract version. `revise` clears earlier acknowledgements, and rejecting a contract is a different outcome from cancelling it (`src/domain/coordinator.ts`; `tests/coordination.test.ts`, `tests/store.test.ts`).
- **Deterministic findings.** `assumption_mismatch` is reported; overlapping symbols and overlapping files are reported for information only (`src/domain/detect.ts`).
- **Compiler-backed index.** It uses ts-morph and handles aliases, barrel files and overloads. It detects direct edits by comparing per-file sha256 hashes (`src/graph/index.ts`; `tests/graph.test.ts`). The finding `dependent_write` is computed from this index (`src/service.ts` `graphFindings`).
- **Two semantic edit operations: `add_field` and `change_signature`.** Each has a preview step. Diagnostics are compared with a baseline, and every write is journaled. A failed write is rolled back, an interrupted one is recovered after a crash, and an apply is refused if the revision or file hashes changed after the preview (`src/ops/engine.ts`, `src/ops/renderers.ts`; `tests/ops.test.ts`, 9 tests).
- **Ghost Contracts.** Consumer code can be type-checked against a proposed declaration before the producer writes it (the "overlay" check). There is also a real check without the overlay, an agreement gate, evidence of implementation, and a `verify` step that runs only allowlisted commands (`src/contracts/service.ts`, `src/contracts/overlay.ts`; `tests/contracts.test.ts`). A `field_required` claim is also tested (`src/contracts/claims.ts`).
- **Model analyzer.** It reports the states `unavailable`, `invalid`, `stale`, cached and retried (`src/intelligence/*`; `tests/intelligence.test.ts`, 8 tests). All of these tests use a fake `fetch`.
- **Hook adapter.** It injects context, asks for or denies permission before a write, reindexes after a write, and fails open when the daemon is down (`src/hooks/hook.ts`; `tests/hooks.test.ts`).
- **MCP transport.** Two real stdio MCP client processes share one daemon in the test (`tests/transport.test.ts`). There are **16** `hive_*` tools: `grep -c registerTool src/server/mcp.ts` returns 16.
- **Dashboard.** The page is served without auth and the data routes return 401 without the token. The page uses no `innerHTML` (`tests/dashboard.test.ts`).

### Partially implemented
- **Writer lock.** `OperationEngine.busy` is a flag inside one process (`src/ops/engine.ts:78,176-178`). Because `apply` is fully synchronous, what actually serializes writes is Node's single thread. Nothing coordinates two processes.
- **Authentication.** There is one shared `HIVE_TOKEN` and nothing else. The daemon actions `sync` and `hook_check` take no session at all (`src/server/schemas.ts` ~L39-41).
- **Session hint.** `hook_check` accepts a `clientSession` field, but no code ever reads it.
- **Dashboard updates.** `GET /events?after=` exists, but the dashboard only polls `/snapshot`.
- **Worktrees.** `register` accepts a `workspace` path and gives each one its own graph. However, hooks and `sync` always use the default workspace (section 5).

### Mocked or scripted
- **Demo and evaluation.** `demo/scenario.ts` and `demo/evaluate.ts` are labelled "SCRIPTED". They run Hive in-process on a temporary copy of `fixtures/billing`, with no real agents. In the evaluation, the model-timeout and malformed-output rows use an injected fake analyzer.
- **Analyzer tests.** All analyzer tests use a fake `fetch`.
- **`web/`.** This React/Vite prototype uses mock data and is not wired to the daemon. It was still being built during the inspection.

### Missing
- **Operations.** `rename_symbol` and `add_endpoint` throw `OperationError('unsupported')` in `OperationEngine.stage` (`src/ops/engine.ts:93-94`), before any renderer runs (`tests/ops.test.ts:26`). The matching cases in `src/ops/renderers.ts:37-38` are therefore unreachable for these kinds.
- **Identity and live updates.** There are no per-member tokens, roles or users, no SSE or WebSocket, no health endpoint, no TLS, and no way to bind to anything other than loopback.
- **Deployment.** There is no Dockerfile, no CI (`.github/` does not exist), and no deployed instance.
- **Combined-work verification.** There is no "integration checkout" that merges and verifies several agents' work together (section 5).
- **Live agent runs.** No test drives a real Claude Code or Muse Code session. `<Hive>/.hive` does not exist; only `<playground>/.hive` does, and it holds only `hive.db`, `hive.db-shm` and `hive.db-wal`. A `find` for `hook-log.jsonl` under the parent Project folder (depth 4) found none, so nothing shows that the playground hooks have ever fired.

### Where code and docs disagree
- **`CLAUDE.md` "Honest limitations" is stale.** It says persistence is memory, the model adapter is not wired up, and hooks are not configured. In the code, persistence defaults to a SQLite file and uses memory only when `HIVE_DB=:memory:`. `MetaAnalyzer` is wired in as the default (`src/service.ts` ~L66). Hooks are configured in `hive-playground/.claude/settings.json`.
- **The model docs are stale.** `README.md:69` says "No live Meta API call was made", `docs/PROGRESS.md:108` says the live smoke test is "BLOCKED, no key", and `VERIFICATION.md:26` (first bullet of "Not tested or not claimed") says "No real Meta/Muse Spark request (no credentials)". But `evaluation/results-2026-11-02T23-36-49-615Z.md:6` says "Model: configured (muse-spark-1.3)" and records real token counts (section 8).
- **`docs/PROGRESS.md` Phase 1** says there are 8 tools; there are 16.
- **The served dashboard is not React.** `docs/BUILD_PLAN.md` Phase 7 asks for a React/Vite UI, and `docs/CLOUD.md` row 10 says the daemon "Serves the React app". The daemon actually serves vanilla `src/dashboard/index.html` (`src/server/daemon.ts:52`).
- **The schema in `docs/ARCHITECTURE.md` is a subset of the real one.** The code adds the tables `files`, `contract_versions`, `analyses` and `journal`, and extra columns such as `sessions.client`, `symbols.meta_json`, `contracts.producer_symbol` and `verification_runs.passed`. `contracts.proposal_id` is never set by any caller.
- **Contract lifecycle.** The doc says that any relevant intent or code change makes a contract stale. In the code, only an intent change, a finished session or an expired session stales a contract. Code changes go through `ContractService.refresh()` instead (`src/contracts/service.ts` ~L118-137), which only looks at `accepted`, `implemented` and `verified` contracts (`LIVE`, L30). If implementation evidence is lost, any of these other than `accepted`, including `verified`, goes straight to `accepted` (L123-126). A `verified` contract goes to `implemented` only when the implementation still matches but the recorded verification hashes changed (L128-133). `Coordinator.staleContractsForFiles` (~L266) is never called. A `proposed` contract never becomes `implemented`, because `refresh()` only promotes `accepted` contracts.
- **`structural_incompatibility` is never produced.** It is declared as a finding kind, and the hook and dashboard read it, but no code creates one. Compiler breakage shows up only as a rejected preview.
- **Version numbers differ.** The MCP server reports version `0.2.0` (`src/server/mcp.ts` ~L7), while `package.json` says `0.1.0`.
- **`docs/CLOUD.md:48` says the container option (Fly/Railway/Render) works "Yes, unchanged".** The daemon is hard-coded to bind `127.0.0.1` (`src/server/daemon.ts:89`), and `docs/CLOUD.md:91` itself says binding beyond loopback is needed for the container path.
- **`docs/CLOUD.md:32` (row 8) says the model key is "Done (key verified live)".** This conflicts with `README.md:69` and `docs/PROGRESS.md:108`, and no repo file records a smoke-test run (section 8).

---

## 2. How everything runs

### In plain language
There is no build step. Node 22 runs the TypeScript files directly. You start one daemon per repository, and it must keep running. Each coding agent then starts its own MCP helper process and runs a hook script for each event. The browser loads the dashboard from the daemon.

### Runtime baseline
- **Node:** `package.json` sets `"engines": {"node": ">=22.18.0"}` and `"type": "module"`. The code relies on built-in type stripping and the built-in `node:sqlite` module. The inspection machine had Node v22.22.3 and npm 10.9.8. There is no `.nvmrc` or `.node-version`.
- **Package manager:** npm. The lockfile is `package-lock.json` (lockfileVersion 3).
- **Dependencies, as pinned in the lockfile:**
  - `ts-morph` 27.0.2
  - `@modelcontextprotocol/sdk` 1.32.2 (the range in `package.json` is ^1.29.0)
  - `zod` 3.25.76
  - dev only: `typescript` 5.9.3 and `@types/node` 24.19.2
- **No SQLite package.** Storage uses the built-in `node:sqlite`, which prints an ExperimentalWarning on load. The npm scripts suppress it with `--disable-warning=ExperimentalWarning`.
- **Environment file.** Most npm scripts pass `--env-file-if-exists=.env`; `test`, `test:core` and `typecheck` do not. The playground configs instead pass the strict `--env-file=<abs>/Hive/.env`, which fails if the file is missing.

### Commands

| Purpose | Command (run in the Hive folder) |
|---|---|
| Install | `npm install` (what `VERIFICATION.md:7` records; neither `npm install` nor `npm ci` was run in this inspection) |
| Target repo dependencies | install the target repository's own dependencies in `HIVE_PROJECT_ROOT`; `verify` runs its test command with `spawnSync` and `cwd: graph.root` (`src/contracts/service.ts:158-164`), so that repo's `node_modules` must exist |
| Build | none: the `.ts` files run directly |
| Type-check | `npm run typecheck` (`tsc --noEmit`) |
| Tests | `npm test` (`node --test tests/*.test.ts`) |
| Daemon | `HIVE_PROJECT_ROOT=<target repo> npm start` |
| MCP adapter (normally started by the client) | `npm run mcp` |
| Hook (started by the client per event) | `node --disable-warning=ExperimentalWarning --env-file=<Hive>/.env <Hive>/src/hooks/hook.ts <session-start\|prompt\|pre-write\|post-write\|session-end> --client claude\|muse` |
| Scripted demo | `npm run demo` (**makes a paid model call if `.env` holds a key**; see the note below) |
| Scripted evaluation | `npm run evaluate -- --repeats N` (same caution) |
| Model smoke test | `npm run smoke:model` (one paid call; not run in this inspection) |

### Processes

| # | Process | Network | Must stay running? |
|---|---|---|---|
| 1 | Daemon `src/server/daemon.ts` | `listen(HIVE_PORT ?? 4317, '127.0.0.1')`, hard-coded to loopback (`daemon.ts:88-89`) | **Yes.** Start it first. It has no SIGINT/SIGTERM handler and never calls `store.close()`. |
| 2 | MCP stdio adapter `src/server/mcp.ts`, one per agent session | HTTP out to `HIVE_URL ?? http://127.0.0.1:4317` (`src/server/client.ts:2`) | Lives as long as the agent session. Sends a heartbeat every 30 s. |
| 3 | Hook `src/hooks/hook.ts`, one process per event | HTTP to the daemon. Appends to `<HIVE_PROJECT_ROOT ?? cwd>/.hive/hook-log.jsonl`. | No: it runs once per event and exits. |
| 4-6 | Demo, evaluation, smoke test | In-process; they do not use the daemon. Only smoke, and demo/evaluate when a key is set, call the model API. | No: one-off runs. |
| 7 | `web/` Vite dev server (in progress) | Vite dev port. Ports 5187 and 5191 were seen in use during the inspection. | Not part of the served system. |

**Startup order:**
1. Install Hive's dependencies, and the target repository's own dependencies if `verify` will be used.
2. Start the daemon, with `HIVE_PROJECT_ROOT` set to the target repo and a non-default `HIVE_TOKEN`.
3. Each agent's client starts its own MCP adapter and runs hooks with the same token.
4. Open `http://127.0.0.1:4317/ui` in a browser and paste the token.

**Observed during inspection (point in time):** a daemon, PID 30884, was listening on 127.0.0.1:4317 (`lsof -iTCP -sTCP:LISTEN`). `ps -o command` showed `node --disable-warning=ExperimentalWarning --env-file-if-exists=.env src/server/daemon.ts`, and `lsof -d cwd` showed its working directory was `<Hive>`. `lsof` also showed `<playground>/.hive/hive.db` (with `-wal` and `-shm`) open, so its root or data directory pointed at the playground. How that was set was not established; the process environment was deliberately not read, because that would expose secret values.

**Important notes**
- **`npm start` alone indexes the wrong repo.** The Hive `.env` contains only the names `MODEL_API_KEY`, `HIVE_MODEL`, `HIVE_PORT`, `HIVE_URL` and `HIVE_TOKEN`; there is no `HIVE_PROJECT_ROOT`. Started from the Hive folder without that variable, the daemon indexes Hive itself.
- **The demo and evaluation make paid model calls.** `.env` contains a `MODEL_API_KEY` entry (value not read). `npm run demo` and `npm run evaluate` load `.env`, and `demo/lib.ts` `workspace()` builds a `HiveService` that defaults to `new MetaAnalyzer()`.
- **The running daemon can also make paid calls.** PID 30884 was started from `<Hive>` with `--env-file-if-exists=.env` (see above). `HiveService` defaults to `new MetaAnalyzer()` (`src/service.ts:66`), which reads `MODEL_API_KEY` (`src/intelligence/meta.ts:74`). If that value is non-empty, every `hive_analyze` call from a playground agent is a paid call. Whether it is non-empty is unknown without reading `.env`, which this inspection did not do.
- **The `session-end` hook does nothing.** It emits `{}` (`hook.ts:107`). The playground also configures no SessionEnd hook. A session ends only through `hive_finish` or when its 120 s lease expires.

### Architecture

```
 Developer machine (everything below runs here today)
 ┌──────────────────────────────────────────────────────────────────────┐
 │ Claude Code / Muse Code session (one per checkout)                   │
 │   │ stdio (MCP)                     │ hook events (stdin JSON)       │
 │   v                                 v                                │
 │ mcp.ts adapter (one per session)  hook.ts (one per event) ──> .hive/hook-log.jsonl
 │   │ HTTP + Bearer HIVE_TOKEN        │                                │
 │   └───────────────┬─────────────────┘                                │
 │                   v                                                  │
 │ daemon.ts  127.0.0.1:4317   /command  /snapshot  /events  /ui        │
 │   HiveService: coordinator | ts-morph graph | ops engine | contracts │
 │      │                 │                              │              │
 │      v                 v                              v HTTPS (only with key)
 │ SQLite <root>/.hive/hive.db   repo files under          Meta API <HIVE_MODEL_BASE_URL>
 │ (node:sqlite, WAL)            HIVE_PROJECT_ROOT          /chat/completions
 │                               (read, hashed, written,
 │                                tests spawned here)
 │ Browser ── GET /ui ── polls /snapshot every 2 s with the token       │
 └──────────────────────────────────────────────────────────────────────┘
 web/ (Vite prototype, mock data) is not connected.
```

---

## 3. Dashboard and backend

### In plain language
The backend is a small Node HTTP server written without a framework. The dashboard is one HTML file with inline JavaScript, served by that same server at `/ui`. The dashboard asks the server for a full state snapshot every 2 seconds. It only reads; it never changes anything. You paste the shared token into the page, and the page keeps it in the browser tab's session storage.

### Frontend
- **Framework:** none. It is vanilla JS with inline `<style>` and `<script>` in one file, `src/dashboard/index.html` (480 lines), with no build step and no external assets.
- **How it is served:** `GET /`, `/ui` and `/ui/` read the file from disk on every request with `readFileSync(new URL('../dashboard/index.html', import.meta.url))` (`daemon.ts` ~L52). There is no auth on these routes. The response sets a CSP (`default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'`), `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. If the read fails, the server returns 500 "Dashboard unavailable".
- **`web/`:** a React 19 / Vite prototype with its own `package.json`, still being built during the inspection, using mock data and not served. Nothing in `src/` references `web/`.

### Backend
- **Framework:** bare `node:http` (`src/server/daemon.ts`, 91 lines). Request bodies are validated with Zod in `src/server/schemas.ts`.
- **Endpoints, grouped by purpose:**

| Purpose | Method and path | Auth | Notes |
|---|---|---|---|
| UI | GET `/`, `/ui`, `/ui/` | none | Dashboard HTML |
| Read state | GET `/snapshot` | Bearer | `service.snapshot()`: coordinator state plus `graph`, `proposals` (20), `claims`, `analysis`, `model`. **Has side effects:** it calls `sync()`, which can trigger a reindex (`src/service.ts` ~L137-142, ~L199-200). |
| Event feed | GET `/events?after=N` | Bearer | `coordinator.events(after)`. Returns the **newest** 200 events after N (`ORDER BY seq DESC LIMIT 200`, then reversed; `coordinator.ts:120-123`). A client paging forward can therefore skip events. Nothing in `src/` calls it. |
| All commands | POST `/command` | Bearer | A Zod discriminated union with 18 actions: register, heartbeat, finish, intent, propose, acknowledge, revise, reject, reindex, symbol, preview, apply, contract_check, verify, claim, analyze, sync, hook_check. Each maps to a call in `execute()` (`daemon.ts:19-40`). |
| Anything else | — | Bearer | 404 `{error:'Not found'}`, or 401 without a token |

- **Errors:** every thrown error returns HTTP 400 with `{error: message}` (`daemon.ts` ~L83-85). This includes domain errors such as an unknown session, and raw Zod messages.
- **Limits:**
  - **Body size:** 64 KB, enforced while the body streams in (~L77-80).
  - **Request timeout:** `server.requestTimeout = 15_000` (L87). This limits receiving the request, not computing the response.
  - **Rate limiting:** none.

### How the dashboard reaches the backend
- **Same origin, relative path.** It calls `fetch('/snapshot')` with `Authorization: Bearer <token>`, `cache:'no-store'` and a 5 s `AbortController` timeout (`index.html` ~L443-445). There is no hard-coded host, port or URL in the dashboard.
- **Update mechanism:** **polling only**, with `POLL_MS = 2000`. The next poll is scheduled after the current one finishes, so polls never overlap. When the response text has changed, the page runs the full `renderAll()`; when it is unchanged, it still calls `renderTop()` and `renderAgents()` on every poll (`index.html:449-450`). There is no SSE (`text/event-stream` appears nowhere) and no WebSocket.
- **Reconnection and staleness:**
  - `STALE_MS = 10000`. A failed request that comes after more than 10 s without success shows a red "offline" banner.
  - A response older than 10 s with no current error shows an amber "stale" banner.
  - A 1 s interval re-evaluates the banner even while a request hangs (~L166-183, ~L474-475).
  - Polling continues after an error, so the page reconnects on its own.
- **401 handling:** the page clears the stored token, stops polling and shows the token form again (~L446, ~L459-463).
- **CORS:** none. There are no `Access-Control-*` headers anywhere in `src/server/`. In effect this blocks cross-origin reads from a browser, but as a side effect rather than a stated policy.
- **Health check:** none. Liveness can only be checked with an authenticated `/snapshot` request, which also runs `sync()`, or by reading the stderr startup line (`daemon.ts:90`).
- **Localhost dependencies:**
  - `daemon.ts:89` binds to `127.0.0.1`.
  - `daemon.ts:49,66` use `http://127.0.0.1` as the base URL for parsing request URLs.
  - `daemon.ts:90` prints the URL in the startup log line.
  - `client.ts:2` defaults to `http://127.0.0.1:4317`.
  - The client configs in `<playground>` (`.mcp.json`, `.claude/settings.json`, `.muse/hooks.json`) contain this laptop's absolute paths. The `config/*.example.json` files use the placeholder `/ABSOLUTE/PATH/Hive` instead.

---

## 4. Agents and MCP

### In plain language
Each AI coding session runs a small Hive helper on the developer's own machine. The session registers with the daemon and receives a session ID. It then sends a heartbeat every 30 s, and the session expires if no heartbeat arrives for 120 s. The agent edits files with its own tools. Hive notices those edits afterwards by comparing file hashes; it does not watch files continuously. Hooks let Claude Code consult Hive before and after writes. Today, agents on two different computers cannot share one daemon.

### Supported clients
- **Claude Code.** Configured in `hive-playground/.mcp.json` (MCP) and `hive-playground/.claude/settings.json`. The settings file has SessionStart and UserPromptSubmit hooks with no matcher (20 s each), and PreToolUse (20 s) and PostToolUse (60 s) hooks, which are the only two with the matcher `Edit|Write|MultiEdit|NotebookEdit`.
  - **Tested:** only through stand-ins. `tests/transport.test.ts` drives two real `mcp.ts` stdio processes with the MCP SDK's `StdioClientTransport`. `tests/hooks.test.ts` spawns `hook.ts` processes with synthetic stdin.
  - **Not tested:** no test runs Claude Code itself, and no `hook-log.jsonl` exists to show a live run (`docs/CLIENTS.md:40` says the same).
- **Muse Code.** There are configs in `config/muse-code.settings.example.json` and `hive-playground/.muse/hooks.json`, both marked UNVERIFIED. Muse Code is not installed on this machine. Its hook input and output format, whether it can block writes, and how it handles `MUSE_SESSION_ID` all come from docs. The `PreToolUse` entry in `<playground>/.muse/hooks.json` has no matcher field, so if Muse honours that file as written, `pre-write` would run for every tool call.
- **Client detection** (`mcp.ts` ~L20): `MUSE_SESSION_ID` means `muse-code`, otherwise `CLAUDE_CODE_ENTRYPOINT` means `claude-code`. The result is stored only as a label.

### Transport
- **MCP:** stdio only (`StdioServerTransport`, `mcp.ts` ~L75). The adapter forwards to the daemon over HTTP; there is no MCP-over-HTTP endpoint.
- **Config example** (placeholders only; based on `config/claude-code.mcp.example.json`):

```json
{
  "mcpServers": {
    "hive": {
      "command": "node",
      "args": ["--disable-warning=ExperimentalWarning", "--env-file=/ABSOLUTE/PATH/Hive/.env",
               "/ABSOLUTE/PATH/Hive/src/server/mcp.ts"]
    }
  }
}
```

  Claude Code also needs a hooks block in `<project>/.claude/settings.json` (placeholders only; based on `config/claude-code.settings.example.json`, which matches `<playground>/.claude/settings.json` apart from paths):

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "timeout": 20,
      "command": "node --disable-warning=ExperimentalWarning --env-file=<Hive>/.env <Hive>/src/hooks/hook.ts session-start --client claude" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "timeout": 20,
      "command": "node --disable-warning=ExperimentalWarning --env-file=<Hive>/.env <Hive>/src/hooks/hook.ts prompt --client claude" }] }],
    "PreToolUse": [{ "matcher": "Edit|Write|MultiEdit|NotebookEdit", "hooks": [{ "type": "command", "timeout": 20,
      "command": "node --disable-warning=ExperimentalWarning --env-file=<Hive>/.env <Hive>/src/hooks/hook.ts pre-write --client claude" }] }],
    "PostToolUse": [{ "matcher": "Edit|Write|MultiEdit|NotebookEdit", "hooks": [{ "type": "command", "timeout": 60,
      "command": "node --disable-warning=ExperimentalWarning --env-file=<Hive>/.env <Hive>/src/hooks/hook.ts post-write --client claude" }] }]
  }
}
```

  Muse Code (UNVERIFIED shape; based on `config/muse-code.settings.example.json`, which also declares the MCP server under `mcp_servers.hive` with `transport: "stdio"`):

```json
{
  "hooks": [
    { "event": "SessionStart", "command": "node --disable-warning=ExperimentalWarning --env-file=<Hive>/.env <Hive>/src/hooks/hook.ts session-start --client muse" },
    { "event": "PreLLMCall",   "command": "node ... <Hive>/src/hooks/hook.ts prompt --client muse" },
    { "event": "PreToolUse",   "command": "node ... <Hive>/src/hooks/hook.ts pre-write --client muse" },
    { "event": "PostToolUse",  "command": "node ... <Hive>/src/hooks/hook.ts post-write --client muse" },
    { "event": "SessionEnd",   "command": "node ... <Hive>/src/hooks/hook.ts session-end --client muse" }
  ]
}
```

  (`node ...` stands for the same flags as the first entry. The playground's `.muse/hooks.json` has no SessionEnd entry.)

  `.env` must provide `HIVE_TOKEN=<shared-token>` and optionally `HIVE_URL=<daemon-url>`. Note that `--env-file` also loads `MODEL_API_KEY` into every adapter and hook process, even though neither reads it.

### Where agents run and where edits happen
- **Agents and helpers:** the agent, the MCP adapter and the hook processes all run on the developer's machine.
- **Normal edits:** the agent's own tools write into the agent's own checkout.
- **Edits made by Hive:** only `hive_apply_operation` writes files from the daemon. It uses `writeFileSync` into the root of the session's workspace graph (`src/ops/engine.ts` ~L215-246), on the **daemon's** filesystem.

### Session lifecycle
- **Register:** `hive_register` takes `{name, workspace?}`. The adapter keeps one module-level `sessionId`, refuses a second register, and every other tool requires one.
- **Updates:** `hive_set_intent` (a new intent revision), contract tools, `hive_preview_operation`, `hive_apply_operation`, `hive_verify`, `hive_claim` and `hive_analyze`.
- **Heartbeat:** `setInterval(...,30_000).unref()` in `mcp.ts` ~L21-30. The lease is `ttl ?? 120_000` (`coordinator.ts` ~L65).
- **Expiry:** the session becomes `expired`, and a `session.expired` event is emitted. Contracts in which it is a participant and that are still `proposed`, `accepted` or `implemented` become `stale`; `verified` contracts stay `verified` (`coordinator.ts:12` `PENDING_CONTRACT`, L142, L258-263). This is unit-tested with a fake clock (`tests/coordination.test.ts:34`).
  - Note: if a heartbeat fails, for example because the daemon restarted, the adapter clears `sessionId` silently. The next tool call fails with "Call hive_register first" (`mcp.ts:26-27`).
  - Combined with `verify`: while one `verify` blocks the daemon for longer than 15 s (`spawnSync` timeout 120 000 ms, `src/contracts/service.ts:164`), every other adapter's heartbeat times out on the client's 15 s `AbortSignal` (`src/server/client.ts:7`). Each failed heartbeat clears that adapter's `sessionId` and timer, so every connected agent silently loses its session, and their next tool call fails. If the block lasts long enough, the daemon may also expire their leases.
- **Disconnect:** `hive_finish` marks the session `finished` and stales the same set of contracts as expiry (participant, `proposed`/`accepted`/`implemented` only; `coordinator.ts:182`). Closing the client only stops the adapter, and the lease then expires after 120 s.

### Automatic detection vs explicit reporting
- **Explicit:** intents, contracts, acknowledgements, claims and verification runs are reported by the agent through tools.
- **Automatic, after the fact:** `service.sync()` calls `graph.quickChanges()`, which re-hashes files already in the index. If any changed, `reindex()` runs and a `direct_edit` event is emitted.
  - **When it runs:** on snapshot, symbol, propose, preview and verify, and in the prompt and post-write hooks. There is no file watcher.
  - **Gap:** `quickChanges` reports `added: []`, so a **new** file is not seen until a full `hive_reindex`.
- **Pre-write gate (hook):** it applies only when the file being written is the producer file of a contract in `proposed` status. `HIVE_HOOK_GATE` can be `ask` (the default), `deny` (exit 2) or `warn`.
  - `hookCheck` always uses the daemon's default workspace graph (`src/service.ts` ~L73-82). If the daemon is unreachable, the hook fails open: it exits 0 and prints "Coordination is OFF" (`hook.ts:113-116`).

### Two agents on different computers today
**Not possible without code changes:**
- **Loopback only.** The daemon binds `127.0.0.1` (`daemon.ts:89`) and has no option to change the host.
- **No TLS.** The token would travel over plain HTTP.
- **Workspace paths resolve on the daemon host.** `register({workspace})` calls `realpathSync` and `statSync` there (`coordinator.ts` ~L156-160), so a remote agent's path either fails or points at the wrong directory.
- **The daemon cannot see remote files.** It indexes and checks only the files on its own disk, so edits on another computer are invisible to it.

### Parts that need direct local filesystem access
- **On the daemon host:**
  - the ts-morph graph index (`addSourceFilesAtPaths`)
  - drift hashing in `quickChanges`
  - staging, journaling and writing in the operation engine
  - `contract_check` overlay and real type-checks
  - `verify` (`spawnSync` with `cwd: graph.root`)
  - path resolution in `hookCheck`
  - evidence excerpts for the model (`readFileSync`)
  - the SQLite file
- **On the client host:** the hook log.

---

## 5. Repository access and code checking

### In plain language
One daemon serves exactly one repository, located by a folder path on the daemon's own disk. Hive does not use git to read code. It reads the working files directly, including uncommitted changes. It runs the TypeScript compiler in-process. For `verify`, it runs the repo's own test command as a child process. Nothing is sandboxed. Hive cannot yet build and test the combined work of several agents.

### How the target repo is selected and identified
- **Selection:** the root is `HIVE_PROJECT_ROOT`, or the daemon's working directory if that is unset. It goes through `realpathSync` and is stored as `repositories.canonical_root` (UNIQUE) (`daemon.ts:10`; `coordinator.ts` ~L67-86; `schema.ts`).
- **Default workspace:** a default workspace row records `base_commit`, taken from `git -C root rev-parse HEAD` with a 5 s timeout, or `null` if that fails (`coordinator.ts` ~L43-44). This is the only use of git. The row is inserted with `ON CONFLICT DO NOTHING`, so it is never updated later.

### Branches, worktrees, multiple repos, multiple users
- **Branches:** no support. No code reads branch names or does any merge or diff.
- **Worktrees:** an agent may pass `workspace` to `hive_register`. The path is realpath'd, checked to be a directory, and given its own `GraphIndex` (the `HiveService.graphs` Map). The MCP adapter does not send a workspace automatically.
  - Nothing checks that the path belongs to the same repository. `/`, `$HOME` or another repo are all accepted.
  - `HIVE_TSCONFIG` applies only to the default workspace.
  - `hookCheck` and `sync` use the default workspace even for sessions registered in another worktree.
  - `revision` is counted per repository, so an edit in any worktree makes every pending proposal stale.
- **Multiple repositories:** not supported. Every query is scoped to `this.repositoryId`, so a second repo needs a second daemon with its own port and data directory.
- **Multiple users:** not supported. There is no identity model beyond the shared token.

### Where indexing, edits and tests run
All three run inside the daemon process, on the daemon host.
- **Indexing:** ts-morph `Project` from `<root>/tsconfig.json` if present. Otherwise it uses the glob `**/*.ts, **/*.tsx`, excluding `node_modules`, `*.d.ts` and `.hive`. Files whose realpath falls outside the root are dropped (`src/graph/index.ts` ~L47-75).
- **Edits:** `graph.abs(path)` under the workspace root (`engine.ts` ~L215-218).
- **Tests:** `spawnSync` with `cwd: graph.root` of the verifying session's workspace (`src/contracts/service.ts` ~L158-164).

### How uncommitted changes reach Hive
Hive reads the working tree directly and keeps a sha256 hash per file. Git commits play no part. Changes to files already indexed are picked up by `sync()`; new files are picked up only by a full reindex (`src/graph/index.ts` ~L78-112; `src/service.ts` ~L118-142).

### If the backend's checkout differs from the agent's
There is no mechanism to synchronize the two. If an agent edits a checkout the daemon cannot read:
- Hive indexes, checks and writes the daemon's copy.
- Findings describe symbols as they exist in the daemon's copy.
- `apply` writes into the daemon's copy, not the agent's.
- `base_commit` can describe an old HEAD.

**This is the central obstacle for any hosted backend** (section 9).

### Does Hive execute repo code, install scripts, tests or shell commands?
- **apply:** no execution. It writes TypeScript text produced by the ts-morph renderers, to the target file plus any caller files it edits (`src/ops/renderers.ts`). It never runs `npm install`.
- **Overlay and real checks:** in-process type-checking only, with `getPreEmitDiagnostics` (`src/contracts/overlay.ts`).
- **verify: yes, it runs repository code.**
  - **Allowed commands:** the prefix allowlist `DEFAULT_ALLOW` is `npm test`, `npm run`, `node --test`, `npx tsc` and `npx vitest` (`contracts/service.ts:28`). `HIVE_VERIFY_ALLOW` can override it.
  - **Validation:** the command must match `/^[A-Za-z0-9 ._/:*=@-]+$/`. It is split on whitespace and run with `spawnSync` without a shell.
  - **Child environment:** a copy of the daemon's environment, with `HIVE_TOKEN` and `MODEL_API_KEY` blanked and `NODE_TEST_CONTEXT` and `NODE_OPTIONS` removed. Every other variable is passed through.
  - **Limits:** 120 000 ms timeout, and only the last 8000 characters of output are kept.
  - **Gaps:**
    - `npm run <anything>` runs any `package.json` script, including `pre`/`post` scripts.
    - `node --test /abs/path` can run files outside the repo.
    - `npx` may download packages from the registry.
    - `spawnSync` blocks the single-threaded daemon for up to 120 s, stalling every client. The client gives up after 15 s, while the run continues. Other adapters' heartbeats time out during the block too, which silently drops their sessions (section 4, Session lifecycle).

### Isolation, restrictions, timeouts, concurrency
- **Isolation:** none. There is no container, no CPU or memory limit, and no network restriction for `verify`.
- **Apply re-checks everything.** It confirms the same session, `previewed` status, `baseRevision` equal to the current revision, and per-file hashes. It then re-stages, compares diagnostics with the baseline, and runs the gates again (`engine.ts` ~L175-267).
- **Concurrency:** the `busy` flag inside one process, plus SQLite `BEGIN IMMEDIATE` with `busy_timeout` 10000.
- **Write-path checks:** none for real paths or symlinks at write time, and no `.env` deny-list in the engine. Containment relies on index filtering (realpath must stay inside the root, `node_modules` is excluded).
  - **Unknown:** whether `tsconfig` `include` paths pointing outside the root could reach the renderers. Touched files come from `staged.getSourceFiles()` without that filter (`engine.ts` ~L109). A test with an out-of-root include would settle it.

### What is needed to verify combined work
- **Not in code.** `docs/PRODUCT.md` describes "validate the combined result in a disposable integration checkout", but nothing in `src/` does this.
- **Today's `verified` mixes trees.** The test exit code comes from the verifying session's workspace, while the type-checks in `real()` and `implementation()` use the producer's workspace (`contracts/service.ts` ~L51-52, ~L82-95). A third mismatch: `verify` records `run.sourceHashes` from the verifying session's graph (`contracts/service.ts:158,171`), but `refresh()` compares those hashes against the producer's workspace graph (L130-133), so verification can be demoted, or kept, against the wrong tree. So `verified` can combine results from different trees, and none is a merged result.
- **What a real check would need:**
  - a disposable directory holding a merge of all participants' trees;
  - a reindex and type-check there;
  - the allowlisted test command run there;
  - the hashes or SHAs of every input tree recorded with the result.

---

## 6. Database and files

### In plain language
All coordination state lives in one SQLite file, `<repo>/.hive/hive.db`, plus its `-wal` and `-shm` side files. The repository files themselves are the other half of the state, because Hive edits them. Only one daemon process may use a given database and repository at a time. There is no backup. Moving to PostgreSQL means rewriting the storage layer from synchronous calls to asynchronous ones, and it would not remove the need for a disk holding the repository.

### Engine and schema
- **Driver:** built-in `node:sqlite` `DatabaseSync`, wrapped in the synchronous `Store` class (`src/store/sqlite.ts`). There is no ORM.
- **Settings:** `busy_timeout=10000`, WAL (file databases only), and `foreign_keys=ON`. `synchronous` is left at the default.
- **Transactions:** `transaction()` uses `BEGIN IMMEDIATE`. A nested call joins the outer transaction through a depth counter, without savepoints (~L39-56).
- **Migrations:** `migrations[]` indexed by `PRAGMA user_version` (`src/store/schema.ts`). Migration 0 creates the base schema; migration 1 is `ALTER TABLE symbols ADD COLUMN meta_json ...`. There are no down-migrations.
- **Tables (16):** repositories, workspaces, sessions, intents, files, symbols, edges, proposals, contracts, contract_versions, acknowledgements, claims, events (`seq INTEGER PRIMARY KEY AUTOINCREMENT`), verification_runs, analyses, journal.
- **Indexes and keys:** 3 explicit indexes and only 3 foreign keys (workspaces→repositories, sessions→workspaces, intents→sessions).

### Path and connection configuration
- **Database path:** `${HIVE_DATA_DIR ?? <root>/.hive}/hive.db`. `HIVE_DB=:memory:` gives a non-persistent database with no WAL (`daemon.ts:10-13`).
- **Indexing exclusion:** the graph indexer excludes only `.hive/**`. If `HIVE_DATA_DIR` points to another folder inside the root, that folder is not excluded. In practice this has no effect: the data directory holds only `hive.db*` files (`daemon.ts:11-12`), and the indexer picks up only `**/*.ts` and `**/*.tsx`, or the tsconfig include list (`src/graph/index.ts:64-75`).
- **Hook log location:** the hook log ignores `HIVE_DATA_DIR` and always writes to `${HIVE_PROJECT_ROOT ?? cwd}/.hive/hook-log.jsonl` (`hook.ts` ~L31-33).

### What must survive a restart
| Path | Why |
|---|---|
| `<data dir>/hive.db`, `hive.db-wal`, `hive.db-shm` | All coordination state. In the playground, the main file is 4 KB and the WAL 284 KB, because the WAL has not been checkpointed. |
| The repository checkout at `HIVE_PROJECT_ROOT`, and any registered worktrees | Hive edits these files, and `journal.entries_json` holds full original file text that recovery writes back. |
| `<root>/.hive/hook-log.jsonl` | Raw hook payloads, including prompts and file contents. Needed only as an audit record; it is also sensitive. |
| `evaluation/results-*` | Generated output that can be recreated; not needed at runtime. |

**Persistent disk:** yes. Any host needs a persistent volume holding both the data directory and the repository checkout, and the two must stay in step.

### Locking, rollback, crash recovery, backup
- **Apply sequence** (`engine.ts` ~L181-267):
  1. Validate the proposal.
  2. Re-stage the edit.
  3. Insert a journal row with status `writing` and the original file contents.
  4. `writeFileSync` each file, outside any DB transaction and without fsync.
  5. In one transaction: reindex, bump the revision, mark the proposal `applied`, set the journal row to `committed`, and emit an event.
- **On error:** the originals are restored (a newly created file is unlinked), the graph is reindexed, the journal row becomes `rolled_back`, and the proposal becomes `failed`.
- **Crash recovery:** on startup, `recover()` (`engine.ts:88`) restores every journal row still marked `writing`. It overwrites those files blindly, so user edits made between the crash and the restart are lost.
- **Backup:** none. There is no `VACUUM`, checkpoint or export code, no signal handler, and no `store.close()`.

### Multiple backend instances
**Not safe.** SQLite itself stays consistent, but the files on disk do not:
- **Recovery can clobber live work.** A second instance's `recover()` can restore files from an apply that is still running in the first.
- **The revision and hash checks happen outside the write transaction.** Two processes can both pass validation and both write files.
- **State lives in each process.** The `busy` flag, the `graphs` and `lastSync` Maps, and the in-flight analysis promise are per process.
- **Port clash.** Both instances default to port 4317.
- **Recovery and proposals are not scoped to the repository.** `recover()` selects every journal row with `status = 'writing'` (`engine.ts:252`) and `proposals()` selects from all proposals (`engine.ts:138`), with no repository filter. If one data directory or DB were shared between repositories, `recover()` would call `graphFor()` with another repository's `workspace_id`, `coordinator.workspace()` would throw "Unknown workspace" (`coordinator.ts:107-110`), and the daemon would fail at startup. `/snapshot` would also list other repositories' proposals.

### Replacing SQLite with PostgreSQL: specific changes
1. **Make storage asynchronous.** `Store.run/get/all/transaction` are synchronous, and the code relies on that (`coordinator.ts` ~L50-51 states it). There are **91** `this.store.` call sites in `src/`: coordinator 46, graph 19, engine 14, intelligence 5, contracts 3, claims 3, service 1. There are **21** `transaction(` call sites. All of them, and their callers up to the MCP and HTTP layers, must become async. Transactions need a per-transaction client instead of the depth counter, and savepoints for nesting: `graph.reindex()` runs inside the apply transaction.
2. **Translate the SQL dialect:**
   - `INSERT OR IGNORE` (`graph/index.ts` ~L253, `coordinator.ts` ~L313) becomes `ON CONFLICT DO NOTHING`.
   - `excluded.` is fine but conventionally written `EXCLUDED`.
   - `AUTOINCREMENT` plus `lastInsertRowid` (`coordinator.ts:118`) becomes an identity column with `RETURNING seq`.
   - `rowid` ordering (`coordinator.ts` ~L188,226; `intelligence/service.ts` ~L82,86) needs an explicit tie-break column.
   - `PRAGMA user_version` migrations become a migrations table.
   - INTEGER booleans become boolean, epoch-millisecond INTEGERs become BIGINT, and `*_json` TEXT can become jsonb.
3. **Fix the LIKE lookup.** `graph/index.ts:280` escapes `%` and `_` with a backslash but has no `ESCAPE` clause. The escape is applied to the whole reference, so in SQLite today a `file#name` reference with `_` or `%` anywhere, in the path or in the symbol name (for example `file#get_price`), never resolves through this fallback. The inspector reproduced it with `node:sqlite`: the pattern `src/my\_file.ts#foo:%` matched 0 rows for the key `src/my_file.ts#foo:function`. Postgres treats backslash as the default escape character, so behaviour would change. Add an explicit `ESCAPE '\'` in both databases.
4. **Rewrite the tests and demo code that use the store.** Raw SQL appears only in `tests/ops.test.ts`, but `tests/store`, `contracts`, `graph`, `intelligence` and `ops` test files all construct `Store` and call the synchronous service APIs (`grep -lE 'new Store|store\.(get|run|all)' tests/*.ts`), as does `demo/lib.ts:50-51`. An async port touches all of them.
5. **Keep the disk.** PostgreSQL does not remove the need for a persistent repository checkout and its journal of file originals.

---

## 7. Authentication and secrets

### In plain language
There is one shared password, `HIVE_TOKEN`. Anyone who has it can do everything, including acting as any session and running allowlisted test commands. There are no users, roles or per-project permissions. That is acceptable on one trusted laptop where the server listens only on loopback. It is not acceptable on the internet.

### Current controls
- **Startup check:** the daemon throws at startup if `HIVE_TOKEN` is empty or still equals the `.env.example` placeholder (`daemon.ts:8-9`). There is no length or entropy check.
- **Token check:** every route except `/`, `/ui` and `/ui/` requires `authorization === "Bearer <token>"`. The comparison is plain `!==`, which is not constant-time (`daemon.ts` ~L62).
- **Session identity:** sessions are identified by a UUID `sessionId` alone (`schemas.ts`). The token is not bound to a session.
- **Dashboard token storage:** the dashboard stores the pasted token in `sessionStorage['hive.token']`, and the HTML never contains it (tested). The CSP allows `'unsafe-inline'` scripts, so any injected script could read the token. The page builds the DOM only with `textContent` and `createElement`.
- **Transport and limits:** plain HTTP on loopback. There is no TLS, no CORS, no Origin or Host check, no rate limit and no lockout. The missing Origin/Host check means no explicit DNS-rebinding defence, but the practical exposure on loopback is limited: every data route needs the Bearer token (`daemon.ts:62-64`), and the dashboard keeps it in per-origin `sessionStorage` (`index.html:121,129-130`), which a rebinding origin cannot read. Only the static `/ui` page is reachable without the token (`daemon.ts:50-58`).
- **Error bodies:** they return `error.message`, which can reveal internal paths.

### Trusted local vs remote
- **Local:** fit for trusted single-user local use.
- **Remote:** not fit. A remote `HIVE_URL` would send the token in cleartext, because `client.ts` does not enforce https.

### Environment variable names
(Values were not read. `.env.example` lists only `MODEL_API_KEY`, `HIVE_MODEL`, `HIVE_PORT`, `HIVE_URL` and `HIVE_TOKEN`.)

| Name | Purpose | Required? | Default | Read by |
|---|---|---|---|---|
| `HIVE_TOKEN` | Shared Bearer secret | Required by the daemon; clients send `''` if unset and get 401 | none (placeholder rejected) | daemon, MCP adapter, hook |
| `HIVE_PORT` | Listen port | Optional | 4317 | daemon |
| `HIVE_URL` | Daemon base URL | Optional | `http://127.0.0.1:4317` | MCP adapter, hook (`client.ts`) |
| `HIVE_PROJECT_ROOT` | Repo root; also the hook-log location | Optional (effectively required) | cwd | daemon, hook |
| `HIVE_DATA_DIR` | State directory | Optional | `<root>/.hive` | daemon |
| `HIVE_DB` | Only `:memory:` is recognised | Optional | file DB | daemon |
| `HIVE_TSCONFIG` | tsconfig path for the default workspace | Optional | none | daemon |
| `HIVE_VERIFY_ALLOW` | Comma-separated verify command prefixes | Optional | `DEFAULT_ALLOW` | daemon |
| `HIVE_REQUIRE_AGREEMENT` | `1` = dependents must agree before apply | Optional | off | daemon |
| `HIVE_HOOK_GATE` | `ask` / `deny` / `warn` (not validated) | Optional | `ask` | hook |
| `HIVE_MODEL` | Model id | Optional | `muse-spark-1.3` | daemon, smoke, demo and evaluate (all via `MetaAnalyzer`, `meta.ts:75`; demo/evaluate through `demo/lib.ts:52`); evaluate also reads it directly |
| `HIVE_MODEL_BASE_URL` | Model endpoint (not validated; it receives the key) | Optional | `https://api.meta.ai/v1` | daemon, smoke, demo, evaluate (via `MetaAnalyzer`, `meta.ts:76`) |
| `MODEL_API_KEY` | Model credential | Optional; analysis is `unavailable` without it | none | daemon, smoke, demo, evaluate |
| `MUSE_SESSION_ID` | Set by the Muse client; used to detect it | Optional | — | MCP adapter, hook |
| `CLAUDE_CODE_ENTRYPOINT` | Set by Claude Code; used to detect it | Optional | — | MCP adapter |

**Public vs server-side:** nothing is public. The dashboard reads no build-time or environment configuration. `HIVE_TOKEN` and `MODEL_API_KEY` are secrets and must stay server-side. `HIVE_MODEL_BASE_URL` and `HIVE_VERIFY_ALLOW` must also be server-controlled, because they decide where the key is sent and what gets executed.

### Other secret-handling observations
- **Hook processes load the whole `.env`.** The playground configs pass `--env-file=<Hive>/.env`, which loads every variable, including `MODEL_API_KEY`, into each MCP adapter and hook process.
- **`verify` uses a denylist.** Its child process gets the daemon's full environment minus two variables. Any cloud credentials in the daemon's environment would reach test scripts.
- **The hook log is not redacted.** `hook-log.jsonl` stores raw prompts and file contents (`hook.ts` ~L28-34).

### Missing controls before any public exposure
1. **Transport security:** TLS, and https enforced in `HIVE_URL`.
2. **Identity:** a token or identity per user, bound to `sessionId`.
3. **Authorization:** checks per project or workspace.
4. **Token management:** rotation and expiry, a minimum-entropy check, and a constant-time compare (`crypto.timingSafeEqual`).
5. **Request controls:** an explicit CORS decision, Origin and Host checks, and rate limits with lockout.
6. **Logging:** request and audit logging.
7. **Hardening:** a CSP without `'unsafe-inline'`, and generic error bodies.
8. **Child-process and file hygiene:** an environment allowlist for `verify`, scoped env files for the adapter and hooks, and redaction and retention rules for the hook log.
9. **Model endpoint:** validate `HIVE_MODEL_BASE_URL`.

CSRF does not apply, because authentication uses a Bearer header and no cookies.

---

## 8. AI integration

### In plain language
Hive can optionally ask one model, Muse Spark through a Meta endpoint that is compatible with OpenAI's chat completions API, to judge whether overlapping work is a real conflict. The model only gives an opinion. Deterministic code checks the answer and throws away anything that is not grounded in the evidence. Nothing the model says is executed or applied. Without a key, the analysis is shown as "unavailable", never as "no conflict".

### Provider, model, SDK, endpoint
- **Adapter and SDK:** `MetaAnalyzer` (`src/intelligence/meta.ts`). It uses no SDK, only native `fetch`.
- **Model and endpoint:**
  - Model: `HIVE_MODEL`, default `muse-spark-1.3`.
  - Base URL: `HIVE_MODEL_BASE_URL`, default `https://api.meta.ai/v1`.
  - Call: `POST <base>/chat/completions`.
  - Auth: `Authorization: Bearer <MODEL_API_KEY>`.
- **Request:** `temperature: 0`, a fixed system prompt, and one user message holding the JSON evidence bundle. It asks for `response_format: {type:'json_schema', ...HiveAnalysis}`. It sends no `max_tokens` and does not stream.

### What the model does
- **Output:** it sorts candidate conflicts into `semantic_conflict`, `structural_conflict`, `harmless_overlap` or `needs_clarification`. It may also suggest a `proposedDeclaration` and `behaviorNotes`.
- **Validation:** Zod checks both the API envelope and the content. Hive then drops:
  - findings that name sessions it does not know;
  - findings whose evidence cites nothing in the bundle;
  - declarations containing `any`.

  Drop reasons are recorded. No intelligence code applies anything.

### What context is sent
`buildEvidence` (`src/intelligence/service.ts` ~L45-73) sends:
- the revision and input hash;
- all live intents (task text, files, symbols, assumptions);
- the coordinator's candidate findings, except `direct_edit`;
- contracts that are proposed, accepted, implemented or verified;
- up to **24** symbols, each with a **40-line source excerpt** read from disk;
- up to **40** dependents in total.

The whole request is capped at **200 000 bytes**; above that, no call is made and the analysis is `unavailable`. Source code excerpts do leave the machine.

### Real vs mocked
- **Real:** the adapter is wired as the default analyzer (`src/service.ts` ~L66) and is reached through `hive_analyze`.
- **Mocked:** all 8 tests use a fake `fetch`.
- **Fake analyzers:** the evaluation injects them for the timeout and malformed-output rows.

### Timeouts, retries, rate limits, background work
- **Timeout:** 30 000 ms per attempt.
- **Attempts:** up to 3.
- **What is retried:** network errors and timeouts, and HTTP 429, 500 and 503.
- **What is not retried:** every other status, including 400, 502 and 504.
- **Backoff:** `min(500·2^(n−1), 8000)` ms plus up to 999 ms of jitter. A `Retry-After` header is honoured only as numeric seconds, with no cap.
- **Rate limiting:** no limiter on Hive's side and no token budget.
- **Caching:** successful results are cached by input hash.
- **In-flight sharing:** concurrent callers share **one** in-flight promise, which is a single field and not keyed by input. A caller with a different bundle, or with `force`, can receive the earlier caller's result.
- **Background work:** none. The `analyze` request waits for the model inside the HTTP request. The adapter allows 120 s for `analyze` (`client.ts`), and a large `Retry-After` could outlast that.
- **Stale check:** after the response arrives, the bundle is rebuilt; if its hash changed, the result is recorded as `stale`. This check does not call `sync()` first.

### Evidence of live testing
- **First evaluation, no model.** `evaluation/results-2026-11-02T22-01-15-370Z.md` says the model was not configured and no calls were made.
- **Second evaluation, model configured.** `evaluation/results-2026-11-02T23-36-49-615Z.md` says "Model: configured (muse-spark-1.3)". Its three unit-mismatch rows show status `ok` with real token usage:

  | Run | Total tokens | Prompt | Completion | Attempts |
  |---|---|---|---|---|
  | 1 | 4806 | 1346 | 3460 | 2 |
  | 2 | 4509 | 1342 | 3167 | 1 |
  | 3 | 4472 | 1355 | 3117 | 2 |

  Runs 1 and 3 took about 62 s against about 31 s for run 2, which suggests the first attempt hit the 30 s timeout. This is an inference; the file does not record per-attempt errors.
- **This is recorded evidence, not reproduced.** This inspection did not rerun the evaluation, so the results are a claim on record, not a reproduced result. The docs that say no live call was made (`README.md:69`, `docs/PROGRESS.md:108`, `VERIFICATION.md:26`) are stale.
- **Smoke test: unknown.** No saved output of `npm run smoke:model` exists in `evaluation/` or anywhere else in the repo; the script prints its result to stdout/stderr and writes no file (`scripts/smoke-model.ts`). A saved smoke-test output file would establish whether it has passed.
- **Without credentials:** only the `unavailable` path is exercised.
- **Unknown:**
  - **Whether the endpoint enforces `json_schema`:** needs the provider's docs or a negative live test.
  - **Provider rate limits and pricing:** need the provider account.

---

## 9. Existing deployment setup

### In plain language
Hive has never been deployed. There is no container file, no compose file, no platform config, no CI and no public URL. `docs/CLOUD.md` is a plan; it says itself that "Nothing here is deployed yet."

### What exists
- **Deployment files:** none. A search of the Hive folder, excluding `node_modules`, found no Dockerfile, `docker-compose*`, `fly.toml`, `railway.json`, `render.yaml`, `vercel.json`, `netlify.toml`, `Procfile`, `nixpacks*`, `.dockerignore`, `.nvmrc` or `.node-version`, and no `.github/workflows`.
- **Runtime pin:** only the Node version range in `package.json` `engines`.
- **`config/`:** example client configs only (`claude-code.mcp.example.json`, `claude-code.settings.example.json`, `muse-code.settings.example.json`). None of them is a deployment config.
- **Deployed URLs:** none. The only non-loopback URL in the code is the model endpoint default.
- **`docs/CLOUD.md`, which is a plan, not a deployment.** It ranks four options: Codespaces port-forward, Cloudflare quick tunnel, a Railway/Fly/Render container, and Vercel/Netlify/Workers ("needs a redesign"). Its open items are member tokens and roles ("not started") and binding beyond loopback.
- **Unknown:** whether a hosted copy exists outside this folder. The user, or `gh repo list`, would settle it.

### Option A: Railway backend + existing dashboard + SQLite volume
- **Works unchanged:**
  - The daemon serves the dashboard at `/ui`, and the dashboard calls `/snapshot` by relative path. Same origin means no CORS work is needed.
  - The token check and token form work as they are.
  - SQLite on a mounted volume needs no code change (set `HIVE_DATA_DIR`), **but only if the volume supports SQLite WAL shared-memory locking** (see "Needs checking"). `src/store/sqlite.ts:23` enables WAL for file databases, and the playground's `.hive` holds `hive.db-wal` and `hive.db-shm`.
  - The test suite runs on Node ≥ 22.18 without a build step.
- **Required changes:**
  1. **Make the bind address configurable** (`daemon.ts:89` is hard-coded to `127.0.0.1`), and decide how the port is supplied. Whether Railway injects a `PORT` variable, and what it is called, needs to be checked against Railway's docs.
  2. **Add a Dockerfile or build config** pinned to Node 22.18 or later, running `npm ci` and `npm start`.
  3. **Add an unauthenticated health route** that does not call `sync()`.
  4. **Add a SIGTERM handler** that closes the HTTP server and calls `store.close()`.
  5. **Put a checkout of the target repository on the volume** and set `HIVE_PROJECT_ROOT` to it. The target repo's dependencies must be installed there if `verify` is to run.
  6. **Point MCP adapters and hooks at the HTTPS URL** through `HIVE_URL`.
  7. **Harden at least the essentials from section 7:** constant-time compare, a strong token, and generic errors.
  8. **Pin exactly one replica.**
- **Blockers:**
  - **Agents' edits never reach the server.** Agents edit on their laptops, while the hosted daemon indexes, checks, applies and verifies its own copy on the volume, and the code has no way to sync the two (section 5). So findings and `apply` would be about the wrong tree, unless agents also run on the server or a sync mechanism is built.
  - **Workspace paths are wrong.** `register({workspace})` paths would be resolved on the server.
  - **`verify` stalls everyone.** It would run repository code inside the server with the server's environment, and block the event loop for up to 120 s.
- **Needs checking with Railway:**
  - whether volumes are local block storage suitable for SQLite WAL (shared memory), rather than a network filesystem;
  - whether a deploy briefly runs the old and new instances together, which is dangerous given `recover()`;
  - TLS termination;
  - replica settings.

### Option B: Vercel dashboard + Railway backend + PostgreSQL
- **Works unchanged:** very little.
  - The dashboard HTML could be hosted as a static file, but it fetches the relative path `/snapshot`, so it needs a configurable API base URL.
  - `web/` is a mock-data prototype and not a ready replacement.
- **Required changes:**
  - **Everything in option A.**
  - **CORS:** an explicit policy plus an Origin allowlist on the backend, because the dashboard would then be cross-origin. The token would be sent cross-origin from the browser.
  - **The PostgreSQL port in section 6:** async conversion of 91 store calls and 21 transactions, dialect fixes, savepoints and a new migrations table.
  - **Tests:** updated tests and a Postgres instance in the test setup.
- **Blockers:**
  - **Postgres does not remove the disk.** The backend still needs a persistent disk holding the repository checkout and must still be a single instance, because `recover()`, the file writes and the `busy` flag are tied to one process and one filesystem.
  - **The checkout gap remains.** The same problem as in option A applies.
  - **Hosting the daemon on Vercel is doubtful and unconfirmed.** In code, the daemon is a stateful, long-running process that uses `spawnSync` (up to 120 s) and keeps ts-morph projects in memory. Whether Vercel can run that has not been checked; `docs/CLOUD.md:49` asserts specific Vercel limits ("default 300 s per function, 800 s with Fluid Compute on paid plans") but cites no source.
- **Needs checking:**
  - **Vercel:** whether static hosting is all that is used there; and, before ruling the daemon in or out, Vercel's current maximum function duration, whether any persistent disk is available, and whether long-lived processes are supported.
  - **Railway:** whether its Postgres offering and private networking fit.

### Option C: hosted dashboard/coordinator + local Hive workers beside developers' repositories
- **Works unchanged:** everything that needs the filesystem already runs locally, which is today's topology. It is tested only with synthetic clients (for example, `tests/transport.test.ts:38-51` calls only `hive_register`, `hive_set_intent`, `hive_context` and `hive_symbol`); real Claude Code and Muse Code behaviour, the playground wiring, and heartbeat, finish and preview/apply/verify through MCP are inspection-only (section 10). This covers the ts-morph index, drift hashing, the ops engine with its journal and recovery, overlay and real type-checks, `verify`, hooks and the MCP adapter. On each developer machine, today's daemon is effectively a "worker".
- **Required changes:**
  1. **Split `HiveService`** (`src/service.ts`), which currently holds the coordinator, graph, ops and analysis together in one process with one synchronous store. The hosted part would hold sessions, intents, contracts, acknowledgements, events and the dashboard. The local workers would hold the graph, ops and verify.
  2. **Add a protocol** for workers to push graph facts (symbols and dependents) and findings to the coordinator. Today `dependent_write` and `assumption_mismatch` are computed in the same process as the graph.
  3. **Define cross-machine identity:**
     - map `repository_id` to something like a remote URL instead of a local `realpath`;
     - make workspaces per machine;
     - stop resolving `register({workspace})` with `realpathSync` on the coordinator.
  4. **Rethink `revision`, which is per repository today,** for multiple writers, along with how stale apply decisions are signalled.
  5. **Add identity:** per-user tokens bound to sessions, plus TLS.
  6. **Decide where combined-work verification runs**, for example a separate integration worker.
  7. **Decide where model analysis runs:** the hosted coordinator holds the key, but the evidence excerpts come from workers.
- **Blockers:**
  - **None of this split exists in code.** It is the largest change of the three, though it is the only option that matches where agents actually edit.
  - **The hosted store would still need either SQLite on a volume with a single instance, or the Postgres port.**
- **Needs checking:** the latency budget for hooks. PreToolUse has a 20 s timeout in the playground settings, and every pre-write check would then make a network round trip.

---

## 10. Verification and next decisions

### Commands run during this inspection (2026-11-02, in `<Hive>`)

| Command | Exit | Result |
|---|---|---|
| `node --version` / `npm --version` | 0 | v22.22.3 / 10.9.8 |
| `git rev-parse --is-inside-work-tree` | 128 | `fatal: not a git repository` |
| `git -C ../hive-playground log --oneline -1` | 0 | `1b97436 hive-playground: sample billing app wired to Hive`; branch `master`; clean |
| `env -u MODEL_API_KEY -u HIVE_TOKEN npm test` | 0 | `# tests 47 # pass 47 # fail 0 # skipped 0`, about 8.3 s. Run twice by the handoff's authors (once by an inspector, once by the synthesizer); same result. A later read-only fact-check did not re-run it; it only confirmed the static count (`grep -c '^test(' tests/*.test.ts` sums to 7+9+2+4+1+8+9+6+1 = 47). |
| `env -u MODEL_API_KEY npm run typecheck` | 0 | no errors |
| `grep -c registerTool src/server/mcp.ts` | 0 | 16 |

**Not run, and why:**
- **Paid model calls:** `npm run demo`, `npm run evaluate` and `npm run smoke:model` were not run, because each can make a paid model call (`.env` contains a `MODEL_API_KEY` entry).
- **Live client runs:** no real Claude Code or Muse Code session was run.
- **Read-only limits:** no authenticated request was made against the running daemon, because that needs the token. No kill-during-apply test, no outside-root tsconfig test, no oversized-body test and no browser render of `/ui` were done.
- **`web/`:** not assessed.

### Test-verified vs inspection-only
- **Test-verified, with synthetic clients:**
  - SQLite restart persistence and lease expiry;
  - the coordination rules;
  - `add_field` and `change_signature`, including rollback, crash recovery and stale-apply rejection;
  - overlay and real checks, the agreement gate and the `verify` allowlist;
  - the model adapter's state handling, with a fake `fetch`;
  - the hook gate and its fail-open behaviour;
  - two stdio MCP clients sharing one daemon;
  - dashboard auth and the no-`innerHTML` rule.
- **Inspection only, not test-verified:**
  - the live model call;
  - real Claude Code or Muse Code behaviour;
  - the playground wiring;
  - heartbeat, finish and preview/apply/verify through MCP;
  - the 64 KB limit, and the 404 and 400 paths;
  - the dashboard's polling, stale and offline behaviour in a browser;
  - `/events` paging;
  - behaviour on SIGTERM;
  - any cloud setup;
  - `rename_symbol` and `add_endpoint` beyond "unsupported".

### Smallest remaining decisions
1. **Where agents' code lives relative to Hive.** Either agents and the daemon share one host (A/B), or local workers sit beside each repository (C). Every other choice follows from this.
2. **For the near-term demo:** whether to accept a single-host deployment, either the daemon plus agents on one cloud box or a tunnel to a laptop as `docs/CLOUD.md` suggests, instead of building option C now.
3. **One repository per deployment?** The code supports exactly one per daemon.
4. **Whether `verify` is allowed on a hosted machine at all, and with which allowlist.** Dropping `npm run` and `npx` is the smallest tightening.
5. **Whether model analysis runs hosted,** which means the key and source excerpts leave developer machines, or stays local.
6. **SQLite on a single instance vs a Postgres port.** Postgres is a large async rewrite and does not remove the disk.
7. **The identity minimum before exposure:** one strong token over TLS, or per-user tokens.
8. **Whether the hook log** (raw prompts and file contents) is kept on a shared host.

### Five most important deployment risks (tied to code)
1. **A hosted daemon checks and edits the wrong copy of the code.** Indexing, hashing, type-checks, `apply` writes and `verify` all act on the daemon host's disk (`src/graph/index.ts` ~L47-112, `src/ops/engine.ts` ~L215-246, `src/contracts/service.ts` ~L158-164). Workspace paths are resolved there with `realpathSync` (`src/domain/coordinator.ts` ~L156-160). Agents editing elsewhere would get findings and edits for a tree they are not using.
2. **One shared token controls everything, including running code.** `daemon.ts` ~L62 is a plain string compare over plain HTTP with a loopback bind. The token is not bound to `sessionId` (`schemas.ts`). Any token holder can act as any session and trigger `verify`, which runs `npm run <any script>` or `npx` with the daemon's environment minus two variables (`contracts/service.ts:28`, ~L140-183).
3. **`verify` and `analyze` block or outlast requests.** `spawnSync` blocks the single-threaded daemon for up to 120 s, freezing every client and the dashboard, while `requestTimeout` is 15 s (`daemon.ts:87`) and the client aborts after 15 s (`client.ts:7`). During such a block every other adapter's 30 s heartbeat times out, and its `.catch` clears `sessionId` and the timer (`mcp.ts:26-27`), so every connected agent silently loses its session; a long enough block may also expire their leases. `analyze` waits for the model inside the request, and `Retry-After` has no cap (`intelligence/meta.ts` ~L98-131).
4. **More than one instance, or an overlapping deploy, can corrupt the repository.** On startup `recover()` (`engine.ts:88`) blindly restores the originals of any journal row marked `writing`. A second or new instance could do this during an apply still running in the old one. The writer lock is an in-process flag (`engine.ts:176-178`). There is no SIGTERM handler and no `store.close()` (`daemon.ts`), and no backup.
5. **Polling `/snapshot` does real work, and there is no health check.** Each authenticated `/snapshot` runs `sync()`, which re-hashes indexed files and can trigger a full reindex (`src/service.ts` ~L137-142, ~L199-200). Every open dashboard does this every 2 s (`index.html` `POLL_MS`). With no health route, a platform health check would either hit 401 or add more of this load. `/events` paging can also skip events (`coordinator.ts:120-123`), so it cannot simply replace polling.
