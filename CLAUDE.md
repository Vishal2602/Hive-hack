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
Current persistence is memory. Contracts are declaration strings, not typed holes.
The model adapter is not wired up. Hooks are not configured. Do not portray any of
these as completed. In an unavailable-credentials environment keep implementing
and testing locally, and report the precise blocked live validation step.
