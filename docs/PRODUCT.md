# Product brief

## Plain language
Several coding agents work on one app. Each is individually capable, but an agent
can change an interface another agent relies on. Hive records their intentions,
spots incompatible assumptions, and helps them agree before integration fails.

## Main feature: Ghost Contract
A versioned promise describing a future interface. A consumer can type-check its
work against a temporary declaration while the producer implements the real code.
The temporary declaration must not ship, mask a missing implementation, or make
runtime verification pass. It is visibly pending until actual code is checked.

## Users and scope
A developer running 2–3 agents locally on a TypeScript repository. Start with
separate worktrees, a shared coordinator and explicit project identity. The starter
has no worktree awareness yet: add it before real file mutation. Remote teams,
multiple languages, autonomous architecture authority and universal editor support
are later work. Never expose this trusted-local starter to a network.

## Product loop
Register task → identify dependencies → detect a risk → propose an agreement →
record exact-version acknowledgements → implement in isolated worktrees → validate
the combined result in a disposable integration checkout → show evidence.

## First demo
A pricing agent wants integer cents; an invoice agent assumes dollars; a UI agent
changes a label. Renamed/explicit APIs and unit documentation make the agreement
clear. A TypeScript number alone does not encode dollars vs cents: behavioral tests
must verify the unit conversion. The model must cite actual assumptions or code.

## Required outcomes
- Catch a changed signature affecting another agent.
- Catch a unit mismatch even when different files are edited and TS types still pass.
- Leave harmless overlap and unrelated work unblocked.
- Explain the exact issue and proposed next step in simple language.
- Show accepted agreement separately from passing integration evidence.

## Non-goals
No custom coding agent, whole-repo autonomous rewrite, cloud auth system, broad
agent chat product, unlimited tool support, training/fine-tuning, or benchmark claims.
