# Progress

Fresh build in progress. Old repository source has NOT been imported or read.
Status words below are precise: "implemented + tested" means an automated test
exercises the behavior; "built, unverified live" means code exists but the live
system it integrates with was not available in the build environment.

## Phase 0 — validate starter and access (done 2026-11-01)
- Environment: Node v22.22.3, npm 10.9.8 (starter said Node 24; type stripping and
  `node:sqlite` both work on 22.22, so `engines` is now `>=22.18.0`).
- `npm install` ok (lockfile pinned: ts-morph 27.0.2, MCP SDK 1.32.2, zod 3.25.76, TS 5.9.3).
- Starter `npm run check`: typecheck clean, 11/11 tests passed. `npm run demo` ran.
- Transport smoke test (daemon + two independent stdio MCP clients) passes.
- Model access: no `MODEL_API_KEY` in the environment, no `.env`. Live Meta smoke test
  is BLOCKED; model work proceeds with mocked boundary tests only.
- Muse Code: NOT installed on this machine (no binary, no `~/.config/muse`). Official docs
  (dev.meta.ai, fetched 2026-11-01) confirm: user settings `~/.config/muse/settings.json`
  with `mcp_servers` block (`transport: "stdio"`, `command`, `args`, `env`), `MUSE_SESSION_ID`
  passed to stdio servers, project hooks in `.muse/hooks.json`, events SessionStart,
  UserPromptSubmit, PreToolUse, PostToolUse, PostToolBatch, PreLLMCall, PostLLMCall,
  SessionEnd. The hook stdin/stdout schema and exit-code semantics are NOT documented
  on those pages, so any hook adapter is "built to documented event names, unverified".
- Meta API facts used: `POST https://api.meta.ai/v1/chat/completions`, Bearer
  `MODEL_API_KEY`, structured output via `response_format: {type: "json_schema", json_schema:
  {name, schema}}`, error shape `{error:{message,type,param,code}}`, retry 429/500/503 with
  exponential backoff + jitter and `Retry-After`, never retry 400/401/404/413, don't retry 504.

## Phase 1 — persistence and workspaces (done 2026-11-01)
- `src/store/sqlite.ts` + `src/store/schema.ts`: built-in `node:sqlite` (no native module),
  WAL, busy timeout, versioned migrations, nested-safe `transaction()`.
- Full durable schema from ARCHITECTURE.md created (repositories, workspaces, sessions,
  intents, files, symbols, edges, proposals, contracts, contract_versions,
  acknowledgements, claims, events, verification_runs, analyses, journal).
- `Coordinator` rewritten over the store: repository identity by canonical root,
  workspaces (worktree dirs with base commit when git is present), session leases with
  lazy TTL expiry, per-session intent revisions (history kept), durable events, code
  revision counter, contract versions with exact-version acknowledgements, revise
  (clears acks), reject/cancel, stale on intent change / finish / expiry.
- Daemon: `HIVE_PROJECT_ROOT`, `HIVE_DATA_DIR` (default `<root>/.hive/hive.db`),
  `GET /events?after=`, new actions `revise`, `reject`. MCP adapter: 8 tools.
- Tests: 17/17 (restart preserves state; expired leases released after restart; worktree
  registration; v1 acks cannot satisfy v2; reject vs cancel; durable event query).
- Gate met: two clients share state (transport test), restart preserves it, expired
  sessions release scope.

## Phase 2 — compiler evidence (done 2026-11-02)
- `src/graph/index.ts` (`GraphIndex`): ts-morph program over the workspace tsconfig; symbols
  keyed `relative/path.ts#Qualified.name:kind` (functions, classes + members, interfaces +
  members, type aliases, enums + members, variables, namespaces); overload sets share one key
  with `meta.overloads`; normalized `meta.signature`; declaration hashes; file hashes.
- Edges resolved through the compiler: every identifier → symbol → aliased symbol → declaration,
  so imports, barrels (`export { x as y }`) and re-exports land on the original declaration.
  `export *` names no identifier and (correctly) yields no edge.
- Excluded files (tsconfig `exclude`) are not indexed. Incremental reindex keeps row IDs by
  logical key; an explicit `keyMap` carries an ID through a rename. `changes()` /
  `quickChanges()` detect direct edits by hash.
- Service layer (`src/service.ts`): lazy per-workspace index, cheap drift check before every
  snapshot/operation, `direct_edit` events + findings, compiler-backed `dependent_write`
  candidates (one session declares work on a symbol another session's files depend on).
- MCP: `hive_symbol` (signature, dependents, dependent files), `hive_reindex`.
- Tests: aliases/overloads/members/excluded fixture, dependents, stale detection, ID
  preservation, rename mapping, hash change. Gate met.

## Phase 3 — first real operations (done 2026-11-02)
- `src/ops/engine.ts`: preview stages the change in a fresh in-memory compiler project (disk
  untouched), computes baseline-relative new diagnostics, a unified diff, compiler-resolved
  callers with per-caller breakage notes, source hashes of edited + dependent files, and runs
  deterministic gates. Any new diagnostic or gate reason is an explicit rejection.
- Apply: in-process writer lock → recheck revision and source hashes → re-stage → durable
  journal row (`writing`) → write files → one DB transaction (reindex, revision bump, proposal
  result, journal `committed`). Failure restores files from the journal and reindexes; a
  journal left `writing` by a dead process is restored on the next start (`recover()`).
- `add_field`: interface, class, object-literal type alias (or intersection with one). Required
  fields that break existing literals are rejected naming the caller; nothing is invented.
- `change_signature`: non-overloaded functions/methods from a declaration string; removed
  parameters delete the matching argument at compiler-resolved call sites; new required
  parameters are never guessed (callers reported as unfixable); overload sets are refused.
- `rename_symbol` / `add_endpoint`: rejected explicitly as not implemented (stretch).
- Tests: unsupported ops, required/optional add_field, unfixable callers, call-site argument
  removal, overload refusal, injected failure after first write (files + DB + index restored),
  simulated crash recovered on restart, same-base concurrency (second apply stale), direct edit
  between preview and apply. Gate met.

## Phase 4 — Ghost Contracts and claims (done 2026-11-02)
- `src/contracts/overlay.ts`: declaration validation (single named ambient declaration, no body,
  no `any`, name must match the producer symbol); overlay check builds an isolated project where
  the producer file's declaration is replaced by the promise and type-checks consumer files;
  real check does the same without the overlay; `satisfies()` compares the declaration's shape
  with the indexed implementation (functions: exact signature; types: promised members present).
- `src/contracts/service.ts`: propose/revise validate and record the overlay result; status
  moves accepted → implemented only on compiler evidence; `verify` runs an allowlisted command
  (default prefixes `npm test`, `npm run`, `node --test`, `npx tsc`, `npx vitest`; no shell
  metacharacters; no shell) and records exit code, output, source hashes, revision; `verified`
  requires exit 0 AND real type-check AND implementation evidence. Later source changes drop
  verified → implemented until verification runs again. Agreement gate blocks a Hive operation
  on a producer symbol whose contract is proposed but not accepted.
- `src/contracts/claims.ts`: `field_required` claim; violations in current source are findings;
  staged operations that would break a claim are rejected.
- MCP: `hive_contract_check`, `hive_verify`, `hive_claim`; `hive_propose_contract` takes
  `producerSymbol` + `behaviorNotes`; `hive_revise_contract`, `hive_reject_contract`.
- Tests: validation, findings incl. compiler `dependent_write`, consumer builds against overlay
  while real check fails and nothing is verified, agreement gate → implemented → failing
  behavior test → passing behavior test → verified → downgrade on later edit, revision re-arms
  the gate, allowlist, claim violation + gate. Gate met.
- Fixture note: `fixtures/billing` now uses `.ts` import specifiers (allowImportingTsExtensions)
  so its behavior test `tests/pricing.test.ts` runs under Node without a build step.

## Phase 5 — Meta intelligence (built + mocked tests 2026-11-02; live smoke BLOCKED, no key)
- `src/intelligence/meta.ts` (`MetaAnalyzer`): `POST {HIVE_MODEL_BASE_URL|https://api.meta.ai/v1}/chat/completions`,
  model `HIVE_MODEL|muse-spark-1.3`, Bearer `MODEL_API_KEY`, `temperature: 0`, structured output via
  `response_format: {type: "json_schema", json_schema: {name: "HiveAnalysis", schema}}`, 30 s timeout,
  ≤ 3 attempts with exponential backoff + jitter and `Retry-After` on 429/500/503 and on
  timeouts; 400/401/403/404/413 and 504 are not retried. Output validated with zod; findings
  must cite a symbol key, file, assumption key or value from the bundle and name only known
  sessions; proposed declarations using `any` are dropped (dropped reasons are recorded).
- `src/intelligence/service.ts` (`AnalysisService`): bounded evidence (live intents, candidate
  findings, live contracts, ≤ 24 declarations with 40-line excerpts, ≤ 40 dependents); cache by
  input hash; no DB transaction across the call; input hash re-checked after the response
  (`stale` if moved); explicit states `ok | cached | unavailable | invalid | stale`; model id,
  latency and token usage recorded in `analyses`. Concurrent callers share one in-flight call.
- MCP `hive_analyze`; snapshot carries `analysis` and `model.configured`.
- Tests (injected fetch): no key → unavailable; bundle content and request shape; cache + recompute;
  malformed output → invalid; timeout retries → unavailable; 429 + Retry-After then ok; 400 and 504
  not retried; uncited/unknown-session/`any` findings dropped; mid-call change → stale.
- NOT done: real API smoke test (needs `MODEL_API_KEY` in `.env`), evaluation of harmless-overlap
  judgement quality (live only).

## Phase 6 — client checkpoint integration (built 2026-11-02; Muse Code unverified, not installed)
- `src/hooks/hook.ts`: events `session-start`, `prompt`, `pre-write`, `post-write`, `session-end`;
  Claude Code JSON output (`additionalContext`, `permissionDecision ask|deny`, exit 2), Muse plain
  text; raw stdin logged to `.hive/hook-log.jsonl`; daemon down → context note, never a block.
- Daemon token-only actions for hooks: `sync`, `hook_check`. Templates in `config/`.
- `docs/CLIENTS.md` states coverage precisely (what is gated, what is only observed).
- Test: real daemon + hook process: findings injected into context; `ask` on the producer file of
  a proposed contract; `deny` mode exit 2; gate clears after acceptance; post-write reindex emits
  `direct_edit`; daemon-down fallback.
- NOT done: two real independent Muse Code sessions altering their plans (needs an install and a
  human-driven session); the same with Claude Code is possible locally with the templates but was
  not run in this build (it spends the user's Claude usage). No capture of a live hook payload yet.

## Phase 7 — dashboard, scripted demo, evaluation (done 2026-11-02; real-agent run NOT done)
- `src/dashboard/index.html` served by the daemon at `/` and `/ui` without auth (static, secret-free,
  CSP); token pasted once into sessionStorage; polls `/snapshot` every 2 s; agent cards, selected
  finding with evidence and before/after, contract lifecycle with exact-version acknowledgements,
  verification evidence, event timeline; empty/offline/stale/model-unavailable states; green only
  with `evidence.verification.passed === true`; text nodes only. Read-only, polling only.
  Verified over HTTP and a fake DOM; not opened in a real browser here (extension unavailable).
- `demo/scenario.ts` (`npm run demo`): labelled scripted replay of the full path; exit 1 on any
  missed state. `demo/evaluate.ts` (`npm run evaluate`): ACCEPTANCE scenarios with Hive, no-Hive
  controls, no-conflict control, harmless overlap, direct edit, injected model timeout/malformed
  output; measured latency; results in `evaluation/`.
- Full suite: 47/47; typecheck clean.

## Remaining (human or access needed)
1. Put a real `MODEL_API_KEY` in `.env`, run `npm run demo` and `npm run evaluate -- --repeats 3`
   to produce the first live Muse Spark analyses; keep the written results (do not cherry-pick).
2. Install Muse Code, add the MCP server and hooks from `config/muse-code.settings.example.json`,
   run one session, read `.hive/hook-log.jsonl` to capture the real hook stdin schema, and adjust
   `src/hooks/hook.ts` output to the documented/observed contract.
3. Two-real-agent run (Muse Code, or Claude Code with the Claude templates): pricing agent +
   invoice agent + UI agent on a copy of `fixtures/billing`; record whether each agent changed its
   plan after a Hive message and which edit paths were not intercepted.
4. Record the 2–3 minute demo per ACCEPTANCE.md (dashboard at `/ui` alongside the two agents);
   label any replay as scripted.
5. Stretch only after that: `rename_symbol`, `add_endpoint`, more claim kinds, SSE for the dashboard.

