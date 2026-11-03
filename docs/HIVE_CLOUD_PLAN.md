# Hive cloud plan
Prepared for the hackathon from the November 2 implementation handoff. The handoff author inspected the working code and reported 47 passing tests and a clean type check. This plan has not been run against that repository or deployed.

## Decision
Use one Railway service for Hive and its working HTML dashboard, one persistent volume, the existing SQLite database, and one trusted billing playground checkout. Run the two demo coding sessions in that same environment against that checkout, with distinct files to edit. First prove that the chosen coding client can authenticate and run there. If its interactive login or runtime blocks the demo, use one private GitHub Codespace with the agents and daemon together, or record the working local setup. This choice assumes the goal is a hosted single-repository demonstration.

For a demonstration that specifically requires two laptops editing independent copies, build the worker architecture below. Pointing a local MCP adapter at a remote daemon is sufficient for exchanging intent messages but insufficient for checking or editing those laptops' source files.

## What to ship
| Part | Placement | Why |
|---|---|---|
| Dashboard | Existing /ui on Railway | Already displays live daemon data using same-origin requests. web/ was a mock-data prototype at inspection. |
| Coordination API and Muse Spark adapter | Same Railway Node process | Keeps the existing API, model evidence selection and MCP tools together. |
| State and recovery journal | /data/.hive/hive.db with single writer | Already implemented with node:sqlite. Use a volume, validate WAL and restart recovery. |
| Target source and dependencies | /data/repo | Compiler, edits and verification read this copy. Install target dependencies here separately from Hive's. |
| Coding clients and hooks | Same host and checkout for the first demo | Today's hooks and sync use the default workspace. Simultaneous sessions should edit distinct files. |
| Judge access | Read-only dashboard data for a sanitized demo project | Public judges must never receive the operator credential. |

## Implementation tasks in the real repository
1. **Establish a baseline.** Put the current Hive source under version control, inspect the ignore list, and record the source revision. Exclude credentials, .hive data, raw hook payloads and dependencies. Pin an available Node 22 patch at or above 22.18. The report used 22.22.3. Run npm ci, npm run typecheck and npm test. Run two actual client sessions on the playground before changing hosting. Confirm registration, a hook firing, conflict delivery and a revised agent action.
2. **Expose only a viewer surface.** The page is read-only today but the credential it requests can call /command. Add separate viewer and operator authentication, enforced on the server. Give judges only the viewer credential or a sanitized public demo view. Ensure a viewer cannot POST any command, impersonate an agent, trigger a model call or run verification. Return only presentation fields from a cheap read-only dashboard endpoint. Serve short task labels, affected symbols, agreement status and verification outcomes. Exclude private prompts, absolute paths, source excerpts and credentials. Never serve the .hive directory. Keep full operator access within the trusted demo team.
3. **Make the daemon hostable.** In src/server/daemon.ts retain loopback as the local default and allow an explicit host override. On Railway use 0.0.0.0 and Railway's PORT, with HIVE_PORT as the local fallback. Add GET /healthz that reports readiness after startup recovery and never calls sync. On SIGTERM stop accepting writes, drain active work, close SQLite and exit. Keep one instance. Polling the dashboard must read cached state without re-hashing the source tree. Avoid switching blindly to /events until its paging behavior is fixed.
4. **Separate tests from the request loop.** In src/contracts/service.ts replace blocking verification with an asynchronous child process. Return a run ID, enforce an exact server-owned executable and argument list, explicit working directory, timeout, bounded output and a minimal environment. Keep the snapshot and heartbeat routes responsive during verification. Test only the trusted fixture. A pass should reference the actual checked files and contract version. Keep evidence pending if those files change. Bind hooks and sync to the demo workspace or reject requests targeting any other workspace in demo mode.
5. **Package and persist.** Add a Dockerfile, .dockerignore, startup entrypoint and Railway service settings. Use npm ci and include the existing src/dashboard/index.html. Mount one volume at /data. At runtime initialize the trusted playground at its pinned revision if absent, install its dependencies and verify the lockfile. On restart preserve existing source and edits. Fail clearly on an unexpected checkout instead of resetting it. Confirm the playground revision reported in the handoff (1b97436) exists in the source you package. Keep the fixture runnable without fetching a private repo on every boot.
6. **Configure and rehearse.** Set HIVE_PROJECT_ROOT=/data/repo, HIVE_DATA_DIR=/data/.hive, HIVE_MODEL=muse-spark-1.3 and the new explicit host override. Supply HIVE_TOKEN, viewer credentials and MODEL_API_KEY through service secrets. Use the daemon's internal URL for colocated clients. Replace absolute laptop paths in MCP and hook configs. Give those helpers only their required connection credentials. Disable raw hook logging or redact it at the source. For separate live analysis requests, key in-flight work by the evidence hash, cap retry delays and reject stale results. Show pending/unavailable states accurately.

## Release checks
- Two real coding sessions register distinct identities in the chosen environment and receive evidence about the same source tree. An unrelated edit proceeds. Save a short redacted trace.
- A judge can open /ui and see the demo. Viewer and anonymous requests to write, apply, verify and analyze are refused. Browser assets contain no operator or model secret.
- On hosted storage, create an agreement, restart the service and show it persists. Exercise recovery on a disposable volume with a deliberately interrupted journal operation. Confirm file hashes and SQLite integrity. Enable a backup and rehearse restoration before depending on this deployment.
- Run a deliberately slow verification. The dashboard and health endpoint still respond and both 30-second agent heartbeats survive. The helper should retry transient heartbeat failures before abandoning its session.
- For the billing case, compare 1999 cents with an actual displayed invoice of $19.99. Remove the temporary type declaration before final verification. For this single-checkout demo label the result as verification of that checkout. Multiple separate branch results need a separate integration checkout and a test against the combined revision.
- Record a live Muse Spark result with its model ID and elapsed time. The handoff found earlier evaluation results with token usage but did not independently reproduce a live coding-session demo.

## When to add Vercel, PostgreSQL and workers
Vercel can host the frontend independently. Connect the current HTML page or finish connecting the React dashboard to live read-only data. Use a same-origin API proxy or an explicit API URL, CSP and CORS allowlist. Scope authentication per user or use a sanitized demo-only view.

Keep SQLite for this single writer. The handoff counts 91 store calls and 21 transactions affected by converting to async PostgreSQL. Postgres will be useful for a multi-project hosted coordinator but cannot sync uncommitted files, serialize filesystem writes on different hosts or verify the combined code by itself.

For real teams, run a Hive worker alongside each developer's checkout. Keep compilation, edits, journal recovery and local checks there. Send revisioned intents, symbol changes and results over authenticated outbound HTTPS to the coordinator. Identify the canonical repository, worktree, base revision and content hashes independently of absolute paths. Bind each member to their sessions. Verify multiple patches together on an isolated integration worker using the exact revisions being reported. Add this architecture when separate machines are a product requirement.

## Provider references
- Railway networking and port binding: https://docs.railway.com/networking/troubleshooting/application-failed-to-respond
- Railway volume setup and runtime mounting: https://docs.railway.com/volumes
- Volume limits, replica and deployment behavior: https://docs.railway.com/volumes/reference
- Vite on Vercel: https://vercel.com/docs/frameworks/frontend/vite
