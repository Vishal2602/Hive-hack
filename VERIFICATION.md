# Verification performed for this build

Environment: macOS, Node v22.22.3, npm 10.9.8. Build dates: 2026-11-01 and 2026-11-02.
The folder is not a git repository (no revision to cite).

## Run and passed
- `npm install`: ok. Pinned: ts-morph 27.0.2, @modelcontextprotocol/sdk 1.32.2, zod 3.25.76, typescript 5.9.3.
- `npm run typecheck`: clean (strict TypeScript over src, tests, demo).
- `npm test`: 47 tests, 47 passed, 0 failed (final clean run after all edits; earlier
  intermittent failures came from a nondeterministic ordering tie that was fixed with a rowid tiebreaker).
  Files: coordination, store, graph, ops, contracts, intelligence, hooks, transport, dashboard.
- `npm run demo`: scripted replay reached every expected state and exited 0 (findings, contract,
  overlay vs real check, agreement gate, apply, failing verification 19.99 !== 1999, passing
  verification exit 0, contract verified at revision 4 with source hashes).
- `npm run evaluate -- --repeats 1`: wrote `evaluation/results-2026-11-02T22-01-15-370Z.{json,md}`;
  all rows matched their expectations. Cost column is "0 (no model call)" everywhere because no key was available.
- Transport: real daemon + two independent stdio MCP clients; unauthenticated HTTP rejected (401).
- Hooks: real daemon + hook process using Claude Code's hook JSON shape; `ask`/`deny` gate on a
  proposed contract's producer file; post-write reindex; daemon-down fallback.
- Dashboard: `/ui` served without auth with CSP; data routes stay 401 without the token; page
  contains no token and no `innerHTML`; render logic exercised against a fake DOM by the builder.
- Daemon smoke: seeded three sessions, a contract and an analysis request over HTTP on port 4318;
  snapshot showed assumption_mismatch + dependent_write, contract proposed, analysis `unavailable`.

## Not tested or not claimed
- No real Meta/Muse Spark request (no credentials). Analyzer behavior is proven only against an
  injected fetch (timeouts, 429/400/504, malformed output, uncited findings, stale inputs).
- No Muse Code session (not installed). The Muse template and plain-text hook output are unverified.
- No Claude Code session was driven end to end either (it would spend the user's usage); only the
  hook contract from Hive's side is tested.
- The dashboard was not opened in a real browser from this environment (Chrome extension not connected).
- Atomicity across SQLite and files is not automatic; it is approximated by journal-first writes,
  rollback and startup recovery, each covered by a test with an injected failure or simulated crash.
