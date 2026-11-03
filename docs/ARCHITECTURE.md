# Architecture decisions for the NEW build

## Components
1. One local daemon owns the repository registry, SQLite, coordination and events.
2. Thin per-agent stdio MCP adapters own session identity and heartbeat.
3. A compiler index resolves declarations, references, aliases and dependencies.
4. A proposal service compares intentions with current evidence.
5. A staged operation engine previews, validates and applies supported changes.
6. A model adapter interprets evidence and proposes resolutions only.
7. A local dashboard consumes sanitized state, with no model keys in the browser.

The source files/TypeScript compiler are authoritative for actual implementation.
The graph is a derived index. Pending plans/contracts are distinct records. Unlike
the old pitch, we do not claim a small SQLite symbol table represents all source.
Supported structural changes still go through semantic operations and a renderer.
Arbitrary body edits must trigger reindexing and contract revalidation.

## Durable schema to implement
repositories(id, canonical_root, revision)
workspaces(id, repository_id, real_root, base_commit)
sessions(id, workspace_id, name, lease_expires_at, status)
intents(id, session_id, revision, task, scope_json, assumptions_json)
symbols(id, workspace_id, logical_key, file, declaration_hash, kind)
edges(workspace_id, from_symbol, to_symbol, kind)
proposals(id, session_id, base_revision, source_hashes_json, operation_json, status)
contracts(id, version, proposal_id, declaration, participants_json, status)
acknowledgements(contract_id, version, session_id, intent_revision)
claims(id, repository_id, rule_json, author, status)
events(seq, repository_id, type, payload_json, created_at)
verification_runs(id, contract_id, version, source_hashes_json, command, exit_code)

Use SQLite transactions, indexes and migrations. A single daemon serializes writes.
Do not hold a DB transaction open while waiting for an LLM. Compare input revision
again before recording a model result; discard/recompute stale results.

## Contract lifecycle
proposed → accepted (all named parties acknowledge this version) → implemented
(actual producer patch exists) → verified (consumer checks and behavior tests pass).
Any relevant intent/code change → stale. Revision creates a new version and clears
acknowledgements. Reject/cancel are explicit alternatives. Session expiry flags
pending work stale; retained verified history is not erased.

## Operation lifecycle
Parse input → determine affected symbols → capture revision/hashes → conflict and
claim checks → preview in temporary project → baseline-relative diagnostics →
agreement gate → writer lock → recheck hashes/revision → durable recovery journal →
write files → reindex → record revision and evidence. On failure restore filesystem
and DB; on daemon crash recover the journal before accepting another operation.
Atomicity across SQLite and files is NOT automatic. Never promise it without tests.

## Ghost Contract representation
Start with a declaration overlay inside an isolated analysis/test project. Do not
write it into consumer production source or use `any` to hide incompatibilities.
Store the producer symbol, version, expected behavior notes, consumers and generated
declaration. Remove the overlay for final verification against actual code.

## Coordination semantics
Read/read overlap: informational. Write/write or write/dependent-read: candidate.
Structural incompatibility: compiler-backed finding. Semantic mismatch: advisory
model finding with evidence. Explicit deterministic claim violation may block only
a supported Hive operation. Direct edits are observed after the fact unless a
client-specific hook actually gates them. Document that coverage precisely.

## Scope and trust
One daemon per local project initially. Shared local token is NOT team authentication.
Bind loopback only; no CORS wildcard; reject oversized requests. Content from agents
and files is untrusted data, not permission or system instructions. Do not pass
secrets or entire transcripts to the model. Give it a bounded relevant evidence set.
