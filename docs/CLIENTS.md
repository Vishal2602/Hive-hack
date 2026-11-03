# Client integration: what Hive sees, gates, and only observes

Hive is one local daemon plus thin per-client adapters. Coverage differs by client and by
path. This page states it precisely; nothing here claims universal pre-write enforcement.

## Paths into Hive

| Path | Mechanism | Status on the build machine (2026-11-02) |
|---|---|---|
| MCP tools (`hive_*`) | stdio adapter `src/server/mcp.ts`, one session per connection | Verified: transport test drives two independent stdio clients against one daemon |
| MCP tools over HTTP | Streamable HTTP at `/mcp` on the daemon (`src/server/mcpHttp.ts`), member/admin Bearer token | Verified in `tests/mcp-http.test.ts` against a real daemon; not yet used by a real Claude Code or Muse Code session |
| Client hooks | `src/hooks/hook.ts <event>` reads the client's JSON on stdin, calls the daemon over HTTP | Verified end-to-end against a real daemon with Claude Code's hook JSON shape (`tests/hooks.test.ts`); Muse Code shape unverified (not installed) |
| Direct file edits by anyone | Hash drift detected on the next read/operation; reindex; `direct_edit` event + finding | Verified in tests; detection is after the fact, never a block |

## MCP tools (both clients)

`hive_register`, `hive_set_intent`, `hive_context`, `hive_symbol`, `hive_reindex`,
`hive_preview_operation`, `hive_apply_operation`, `hive_propose_contract`, `hive_acknowledge`,
`hive_revise_contract`, `hive_reject_contract`, `hive_contract_check`, `hive_verify`,
`hive_claim`, `hive_analyze`, `hive_finish`.

Polling with `hive_context` before dependent work is the supported baseline for every client.
Push into the agent's context exists only where a hook delivers it (below).

## Claude Code (installed here, v2.1.309)

Config templates: `config/claude-code.mcp.example.json` (MCP server) and
`config/claude-code.settings.example.json` (hooks). Replace `/ABSOLUTE/PATH/Hive`.

| Event | What the hook does | Gate? |
|---|---|---|
| `SessionStart`, `UserPromptSubmit` | `sync` (drift check) then injects a compact summary of findings, contracts and model status as `additionalContext` | No |
| `PreToolUse` on `Edit|Write|MultiEdit|NotebookEdit` | `hook_check` on `tool_input.file_path`: if the file is the producer file of a *proposed, not yet accepted* Ghost Contract → `permissionDecision: ask` (default; `HIVE_HOOK_GATE=deny` exits 2 and denies, `warn` only adds context). Adds context when the file is in another session's declared scope or its symbols are used by another session's files | Yes, for these four tools only |
| `PostToolUse` on the same tools | `sync` → reindex → reports the direct edit, new revision and any claim violations as context | No |

Not intercepted: `Bash` edits (`sed`, `git apply`, scripts), edits from other programs, edits in
worktrees the daemon does not know. These are detected afterwards by hash drift.

Hook output format used: stdout JSON `{"hookSpecificOutput": {"hookEventName", "additionalContext",
"permissionDecision", "permissionDecisionReason"}}`; exit code 2 + stderr to deny. This is the
Claude Code 2.x hook contract as understood at build time; `tests/hooks.test.ts` verifies our side
of it, not Claude Code itself.

## Muse Code (first demo client; NOT installed on the build machine)

Documented facts (dev.meta.ai/docs/muse-code/extending and /configuration, fetched 2026-11-01):
user settings at `~/.config/muse/settings.json` with `"schema_version": 1`; MCP servers under
`mcp_servers` with `transport: "stdio"`, `command`, `args`, `env`, `mode`; `MUSE_SESSION_ID`
is passed to stdio servers; project hooks in `<project>/.muse/hooks.json` (only after the
folder is trusted); events `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`PostToolBatch`, `PreLLMCall`, `PostLLMCall`, `SessionEnd` (observational), …

Not documented on those pages, therefore unverified: the hook stdin JSON, the stdout/exit-code
contract, whether `PreToolUse` can block, and the exact `hooks` entry format.
`config/muse-code.settings.example.json` is a best-guess template and says so.

What the adapter does for Muse until that is verified: `--client muse` prints plain text on
stdout (context or reason) and exits 2 when it wants to block; every raw stdin payload is
appended to `<project>/.hive/hook-log.jsonl` so the real schema can be captured from one live
session and the adapter adjusted. Session messaging (`/docs/muse-code/session-messaging`) is
agent-to-agent plain text (≤ 8192 bytes) requested in natural language; it is not an API a hook
can call, so Hive does not use it.

## HTTP transport (added 2026-11-02/03)

Connect a client to a running daemon without a local adapter (placeholders; use a **member** token,
one per person or laptop; viewers are refused with 403):

```bash
claude mcp add --transport http hive https://<your-hive-host>/mcp --header "Authorization: Bearer <member-token>"
```

Same 16 `hive_*` tools as stdio. One MCP session is one Hive session: `hive_register` binds them,
every request on that MCP session heartbeats the Hive session, an open GET stream keeps it alive,
and DELETE `/mcp` finishes it. An MCP session can only be used with the token that created it, and
a member can only drive sessions registered with its own token. The dashboard's Connect page
produces this snippet with the host from `HIVE_PUBLIC_URL` (or the page origin). Use HTTPS for
anything but loopback; the daemon itself does not terminate TLS.

**Remote-agent caveat.** The daemon type-checks, edits (`hive_apply_operation`) and verifies
(`hive_verify`) only its own checkout at `HIVE_PROJECT_ROOT` on its own disk. An agent on another
laptop connected over HTTP MCP exchanges intents, findings and agreements, but Hive does not see
that laptop's files, and its hooks still run locally (they need `HIVE_URL` and a token). For a
hosted demo, run the agents in the same environment as the daemon against that checkout, with
distinct files to edit. Separate machines with independent checkouts need the worker architecture
in `docs/HIVE_CLOUD_PLAN.md`, which is not built.

## Fallback when hooks are unavailable

Explicit polling: agents call `hive_context` (and `hive_contract_check` when they participate
in a contract) before dependent work. The dashboard (`/ui`) shows the same state to the human.

## Session identity and expiry

Each stdio adapter owns one session and heartbeats every 30 s; the daemon lease is 120 s. A
client that exits without `hive_finish` is expired by lease; pending contracts it participated
in become stale, verified history is kept. Hooks are stateless and authenticate with a token
only (`HIVE_TOKEN` or a member token); they never impersonate a session.
