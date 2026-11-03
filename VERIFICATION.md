# Verification performed for this build

Environment: macOS, Node v22.22.3, npm 10.9.8. Build dates: 2026-11-01 and 2026-11-02 (sections
below the cloud section). The folder became a git repository during the cloud build; the cloud
release checks ran on the tree at commit `46bf54d` plus documentation edits.

## Cloud build release checks (run 2026-11-03, locally; nothing deployed)
- `npm run typecheck`: clean. `npm test`: **107 tests, 107 passed, 0 failed** (~20 s; the 47 earlier
  tests kept). `cd web && npm run typecheck && npm run build`: clean (Vite warns that the single JS
  chunk is ~904 kB minified; not split).
- **(a) Restart persistence** (scratch script; daemon on a copy of `fixtures/billing`, file DB in a temp
  `HIVE_DATA_DIR`, throwaway admin token): `token_create` (member) → two agents registered with that
  token, intents → `propose` (status `proposed`) → SIGTERM: exit 0, "Hive daemon stopped" logged →
  restart on the same DB: the token is still listed and `/me` with it returns 200 `role=member`;
  the contract is present with status `proposed` and its title. PASS.
- **(b) Slow verification stays off the request loop** (seeded daemon,
  `scripts/seed-demo.ts --port 4318 --keep`; a 5 s sleeping test file added to the seed's temp
  checkout; verify `npm test` on the seeded agreement as admin): `verify` answered 200 `running` in
  4 ms; the run finished after 5.4 s (`failed`, exit 1: the seed's invoice test fails by design).
  During it, 25 rounds of parallel probes: `/healthz` max 2 ms, `/snapshot` max 3 ms, `heartbeat`
  max 4 ms (all 200, all < 500 ms). PASS.
- **(c) Viewer refusal** (same daemon, viewer token from `token_create`): `POST /command` (`sync`) 403,
  `POST /command` (`verify`) 403, `GET /snapshot` 403, `POST /mcp` 403, `GET /api/view` 200; anonymous
  `POST /command` 401. All 4 files in `web/dist` scanned for the admin and the viewer token values:
  0 matches. PASS.
- **(d) Journal recovery**: `node --test tests/ops.test.ts` 9/9, including "a simulated crash
  mid-apply is recovered from the durable journal on restart" and "injected failure after the
  first file write restores every file and the database". PASS (in-process simulation, not a killed
  container on a real volume).
- **(e) Docker** (Docker 29.5.2, linux/aarch64): `docker build -t hive-local .` succeeded (type-checked
  web build). `docker run` with a temp named volume on `/data` and a throwaway `HIVE_TOKEN`: the
  entrypoint initialised `/data/repo` from the bundled playground snapshot (`npm ci`, git commit),
  daemon listened on `0.0.0.0:4317`; `/healthz` 200 `{"ok":true,"indexed":true,...}`, `/ui/` 200
  (`<title>Hive</title>`), `/snapshot` 401 without token and 200 with it. Container and volume
  stopped and removed afterwards.
- Earlier in the cloud build (F0 report, not rerun here): headless Chrome against the seeded `/ui`
  signed in with the admin token with no console or HTTP errors; viewer revocation sent the page
  back to sign-in.

Not run for the cloud build: any Railway or other hosted deployment, a restart on hosted storage,
a backup restore, a live Muse Spark call, a Muse Code session, two real agents over HTTP MCP.

## Earlier build (2026-11-01/02)

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
- No real Meta/Muse Spark request in the 2026-11-01/02 checks above (a later scripted evaluation,
  `evaluation/results-2026-11-02T23-36-49-615Z.md`, records a configured model with token usage). Analyzer behavior is proven only against an
  injected fetch (timeouts, 429/400/504, malformed output, uncited findings, stale inputs).
- No Muse Code session (not installed). The Muse template and plain-text hook output are unverified.
- No Claude Code session was driven end to end either (it would spend the user's usage); only the
  hook contract from Hive's side is tested.
- The old single-file dashboard was not opened in a real browser (it has since been replaced by `web/`).
- Atomicity across SQLite and files is not automatic; it is approximated by journal-first writes,
  rollback and startup recovery, each covered by a test with an injected failure or simulated crash.
