# Sources and provenance

User input: 08-project-overview-2026-11.md (overview only, not original source).
This kit is fresh code inspired by shared intentions, semantic operations and Ghost
Contracts. No old implementation, benchmark or research assertion was copied as proof.

Official documentation consulted November 1, 2026:
- https://dev.meta.ai/docs/overview — API base URL and configurable model identifiers.
- https://dev.meta.ai/docs/muse-code/extending — documented MCP and lifecycle hooks.
- https://dev.meta.ai/docs/muse-code/session-messaging — client messaging context.
- https://github.com/modelcontextprotocol/typescript-sdk — SDK reference for follow-up.

Provider docs describe muse-spark-1.3 and muse-wonder-1.0. Starter defaults to Spark;
availability, account access and actual endpoint responses still require a live test.
Package version ranges originate from the prior overview where noted. Do not assert
latest versions. Install and commit a lockfile on the build machine.

## Build-time documentation checks (2026-11-01 / 2026-11-02)
- https://dev.meta.ai/docs/overview — base URL `https://api.meta.ai/v1`, `MODEL_API_KEY`, model ids
  (`muse-spark-1.3`, `muse-wonder-1.0`, …), chat completions = OpenAI-compatible messages endpoint.
- https://dev.meta.ai/docs/structured-output — `response_format: {type: "json_schema", json_schema: {name, schema}}`;
  limits (10 nesting levels, 5,000 properties, 1,000 enum values); `strict` defaults to false.
- https://dev.meta.ai/docs/error-handling — error shape `{error: {message, type, param, code}}`; retry 429/500/503 with
  exponential backoff + jitter and `Retry-After`; do not retry 400/401/402/403/404/413; 504 usually repeats.
- https://dev.meta.ai/docs/pricing-rate-limits — muse-spark-1.3: 3,000 RPM / 4M TPM; $1.25 in / $4.25 out per 1M tokens
  (used only for the cost column description; no dollar estimates are computed).
- https://dev.meta.ai/docs/muse-code/extending — `mcp_servers` block fields, `MUSE_SESSION_ID`, hook event names,
  `.muse/hooks.json`; hook stdin/stdout contract NOT documented there.
- https://dev.meta.ai/docs/muse-code/configuration — user settings `~/.config/muse/settings.json`, `schema_version: 1`.
- https://dev.meta.ai/docs/muse-code/session-messaging — agent-to-agent plain-text messages; no external injection API.
- Reference material supplied by the user on 2026-11-02: `~/Documents/Project/HIVE - old` (docs + prior source).
  Ideas reused: change_signature call-site argument removal and "never invent required arguments"; add_field on
  object-literal/intersection type aliases; claims as deterministic rules. No code was copied verbatim; none of the old
  repository's launch or benchmark claims are inherited.
