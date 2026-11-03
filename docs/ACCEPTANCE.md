# Acceptance and demo checklist

## Starter checks
- Assumption mismatch across different files is caught.
- Overlap alone stays informational.
- Unrelated agent is not warned.
- Every participant accepts exact version; stale and outsider acknowledgements fail.
- Expired sessions disappear from live detection.
- Unimplemented operation path throws, never reports success.

## Full product checks (not yet implemented)
1. Two independent stdio clients use the same daemon and durable project state.
2. Intent changes or direct file edits invalidate relevant cached conclusions.
3. A rename through aliases/barrels changes all supported references or rejects safely.
4. Required parameter change reports unfixable callers rather than inventing values.
5. Invalid op leaves filesystem and DB unchanged, including after injected crash.
6. Two concurrent same-base proposals: at most one unchecked commit succeeds.
7. Contract v2 cannot reuse v1 acknowledgements; consumer sees v2 before continuing.
8. Producer missing: no final 'verified', even if overlay type-check succeeds.
9. Actual price 19.99 dollars becomes 1999 cents; invoice remains $19.99, not $1999.00.
10. Model timeout/malformed JSON produces an explicit unavailable/error state.
11. Unrelated UI work proceeds; no global pause for every analysis.
12. A direct edit that bypasses Hive is labelled as detected afterwards.

## Demo recording, approximately 2–3 minutes
Show initial tasks and shared code dependency. Start agents. Reveal real conflict
with evidence. Show proposed Ghost Contract and both acknowledgements. Show continued
work. Run combined behavior test against actual code without overlay. End on measured
result and an honest limitation. A scripted replay must be labelled throughout.

## Evaluation table to fill, do not invent numbers
Scenario | Mode | Run | Detected? | False alert? | Integration passed? | Latency | Cost
Use 3+ repeats where feasible. Include a no-conflict control. Store original prompts,
model IDs, revision, logs and test outputs. Judge success by behavior, not agent claims.

## Event submission provenance
The user has an earlier Hive implementation. Record original concept/code lineage,
what was reused, and exactly what was built during this event. Rewriting source does
not by itself establish compliance with an event's pre-existing-work rule. Check the
actual participant rules before submission; do not claim eligibility here.
