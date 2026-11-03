# Build in this order

## Phase 0 — validate starter and access
Run npm install, npm run check, npm run demo. Pin resolved dependencies in lockfile.
Check Node version. Start daemon; connect two independent MCP clients; confirm one
shared snapshot. Smoke-test Meta access only when MODEL_API_KEY is supplied. Verify
actual installed Muse Code configuration/hooks against official documentation.
Gate: live transport smoke tests, no claims of model success without credentials.

## Phase 1 — persistence and workspaces
Replace in-memory maps with SQLite behind a store interface. Add repository and
worktree identities, base commit, intent revisions, durable events, TTL expiry and
restart recovery. Do not use a DB inside each isolated worktree as separate truth.
Gate: two clients share state, restart preserves it, expired sessions release scope.

## Phase 2 — compiler evidence
Extend graph/index.ts to resolve symbols/references via compiler, aliases and barrels.
Canonical keys must include repository-relative path + declaration scope/kind and
handle overloads. Preserve IDs across incremental reindex using explicit mappings.
Detect direct edits with file hashes and reindex before checking a proposal.
Gate: fixture with aliases and overloads, stale-source detection, ignored files.

## Phase 3 — first real operations
Implement add_field and change_signature behind OperationEngine. Begin with clearly
documented supported declarations; reject unsupported cases explicitly. Never guess
arguments for new required parameters. Preview diffs and report affected callers.
Implement writer serialization, staging, diagnostic comparison and rollback journal.
Gate: tests inject a failure after first file write and confirm all files + DB restore;
concurrent proposals from the same base cannot both apply unchecked.

## Phase 4 — Ghost Contracts and claims
Replace string-only contracts with validated declaration overlays and version history.
Add exact-version acknowledgements, behavior notes and real implementation evidence.
Add a minimal field_required claim as an enforceable deterministic example; naming
and dependency rules can follow. Never automatically accept for another agent.
Gate: consumer builds while producer pending; final check without overlay fails if
producer missing; revising contract invalidates prior acknowledgements.

## Phase 5 — Meta intelligence
Wire MetaAnalyzer into an explicit hive_analyze or async proposal analysis event.
First select relevant graph neighborhood/intents, cache by input revision/hash, and
validate model output. Store evidence references, model ID, latency and token usage
when returned. Revalidate input version after model response. API timeouts/429s are
visible 'analysis unavailable'; do not convert failure into 'no conflict'. Use small
bounded retry with backoff only for transient errors. No unlimited retry loops.
Gate: mocked boundary tests + separately documented real API smoke test. Evaluate
harmless overlaps alongside true semantic conflicts. Start with Spark only.

## Phase 6 — real agent checkpoint integration
Add a client adapter using verified Muse Code hooks. Register at task start, refresh
context before supported writes/next model call, reindex after direct edits, and
finish/heartbeat reliably. Capture the actual response showing delivery into agent
context. If push/hook unavailable, explicit polling is a supported fallback, labelled.
Gate: two real independent sessions alter their plans after a Hive message. Record
any edit paths not intercepted. No claim of universal pre-write enforcement.

## Phase 7 — local dashboard and evaluation
Add small local React/Vite UI: agent cards, conflict details, before/after interface,
contract states and verification timeline. Backend provides snapshots/events; keep
credentials server-side. Authenticated same-origin UI route or documented local auth.
Do not embed the shared token into a public frontend bundle. Polling is fine first.
Run scenarios in ACCEPTANCE.md from clean fixtures with and without Hive; hold task,
model/settings and initial revision constant. Repeat, save results, don't cherry-pick.
Gate: full flow demonstrated with real agents; replay mode clearly labelled.

## Stretch only after gates pass
rename_symbol, add_endpoint, deeper claim types, second client integration, remote
team hosting, advanced visualization. Do not sacrifice the working demo for these.
