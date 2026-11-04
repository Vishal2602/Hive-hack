# Rules for building Hive

This is a fresh implementation starter, not a migration. Reuse ideas and carefully
selected old code only if the user later supplies it. Do not fetch the private old
repo, invent its contents, or inherit its old "launch-ready" claims.

Read docs/PRODUCT.md, ARCHITECTURE.md, BUILD_PLAN.md and ACCEPTANCE.md in order.
Implement phases; do not stop after planning. Keep docs/PROGRESS.md current.
The user wants a working hackathon build; choose routine details without asking.

## Engineering boundaries
- TypeScript only. One trusted local repository, one daemon, multiple stdio clients.
- Model output proposes; deterministic code validates and executes.
- Never execute a model's proposed shell command or declaration as arbitrary code.
- Exact file overlap is not a proven semantic conflict. Separate candidates from findings.
- Proposed, accepted, implemented and verified are different states.
- No console.log on MCP stdout. Log to stderr.
- A stale revision or changed source hash must invalidate an apply decision.
- Serialize validation + mutation, not merely the last file write.
- Stage changes first, reject new diagnostics by comparing baseline diagnostics,
  then journal file originals before applying. Restore files AND graph on failure.
- Preserve user edits, comments and unrelated formatting. No repo-wide reset.
- All file mutation stays in the operation engine. Constrain real paths to project
  root, including symlinks. Never modify node_modules or secrets.
- Tests must verify behavior and failures, not just mirror implementation.
- Never mock model output in the real demo. A clearly labelled scripted demo is fine.
- Require evidence for 'verified': test command, exit code, source hashes and revision.
- Do not claim no prior art, formal correctness, or performance gains without evidence.
- Never print keys or commit .env. No publish/deploy action is part of this build task.

## Scope
Ship the end-to-end path before polishing UI. Begin semantic writes with add_field
and change_signature. Implement rename_symbol and add_endpoint only after core demo
works. Keep four operations as the desired ceiling, not a reason to miss the demo.
Approved dependency families: TypeScript, ts-morph, MCP SDK, Zod; SQLite adapter,
React/Vite for the final local dashboard, and test tooling if needed. Prefer fewer.
No need to ask about routine dependencies within this scope. Explain additions.

## Honest limitations
Persistence is SQLite (.hive/hive.db; HIVE_DB=:memory: for tests). Contracts are
declaration strings, not typed holes. The Meta model adapter exists, but the hosted
Railway server cannot reach Meta's API; it works from a laptop (directly when Hive runs
locally, or via `node .hive/hive-hook.mjs analyze` relay). Client hooks are generated
from src/hooks/hook.ts and served at /hook.mjs; Connect (/connect.mjs) installs them.
In an unavailable-credentials environment keep implementing and testing locally, and
report the precise blocked live validation step.

## Current work (hackathon finish, uncommitted)
Problem: Ghost Contract signing needed manual back-and-forth. A consumer agent only learned
a signature was pending when its developer sent another prompt. Claude Code sessions cannot
be woken from outside, so the design must not depend on an idle agent.

Changes made (all tests pass, typecheck clean, NOT committed, NOT yet tested with two live agents):
- src/contracts/service.ts `autoAcknowledge`: on propose/revise, Hive signs for the proposer, and
  for each other participant whose declared files get no new overlay type errors AND who stated no
  assumption whose key starts with the producer file (`src/pricing.ts#...`). Emits
  `contract.auto_acknowledged`. Otherwise the participant must sign.
- src/contracts/service.ts `inbox(member)`: proposed contracts waiting on that member's sessions.
- src/server/daemon.ts + schemas.ts: new hook action `hook_inbox` (member from the token).
- src/hooks/hook.ts: `inboxText()` adds "HIVE ACTION REQUIRED NOW ... hive_acknowledge / hive_reject_contract"
  to prompt, pre-write and post-write context, plus a new `inbox` event (PostToolUse after
  Read|Grep|Glob|mcp__hive__.*). The producer's pre-write still gates (ask) while a staked participant is missing.
- src/domain/coordinator.ts: a repeat acknowledgement returns early (no duplicate event).
- src/hooks/connect.ts: adds the inbox hook; fixes mergeSettings dropping earlier Hive entries when
  one event has several Hive hooks.
- tests/contracts.test.ts: updated 2 tests for proposer auto-sign; added an auto-signing/inbox test.

Known gaps: auto-sign relies on agents declaring assumptions; the file-level stake check is broad
(errs toward asking); Meta analysis is not part of the auto-sign decision (too slow for a hook).

Local run for the demo (from a normal terminal; a Claude session's own HIVE_TOKEN env overrides .env):
  HIVE_PROJECT_ROOT=~/Documents/Projects/hive-server-repo npm start   # a separate clone of hive-playground
  Dashboard http://127.0.0.1:4317/ui (admin = HIVE_TOKEN in .env); create member tokens; run the
  Connect command in each playground folder. For two laptops: `cloudflared tunnel --url http://localhost:4317`
  and set HIVE_PUBLIC_URL to the tunnel URL.
Test plan: two playground folders (hive-playground, hive-playground-vishal) with two member tokens.
  1) UI-label task + getPriceCents task -> contract accepted immediately.
  2) buildReceipt (assumes dollars) + getPriceCents -> proposer gets one approval prompt; the receipt
     agent sees HIVE ACTION REQUIRED at its next step and signs/rejects on its own.
