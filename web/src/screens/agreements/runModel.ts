// Pure helpers for verification runs. No runtime imports, so the backend test suite can import this file under Node.
import type { Event as HiveEvent, VerificationRun } from '../../../../src/domain/types.ts';

export const isFinished = (run: VerificationRun | null | undefined) => !!run && run.status !== 'running';

/** Run ids named by verification events for one agreement (or every agreement), oldest first. */
export function runIdsFromEvents(events: HiveEvent[], contractId?: string): string[] {
  const ids: string[] = [];
  for (const event of events) {
    const p = event.payload;
    if (!p || typeof p.runId !== 'string') continue;
    if (contractId && p.contractId !== contractId) continue;
    if (!ids.includes(p.runId)) ids.push(p.runId);
  }
  return ids;
}

/**
 * Runs that started but have no finishing event yet, newest first. `contract.verified` carries no run id,
 * so a run also counts as finished when it is the agreement's recorded verification.
 */
export function unfinishedRunIds(events: HiveEvent[], contractId: string, recordedRunId: string | null): string[] {
  const started: string[] = [];
  const finished = new Set<string>();
  for (const event of events) {
    const p = event.payload;
    if (!p || p.contractId !== contractId || typeof p.runId !== 'string') continue;
    if (event.type === 'contract.verification_started') started.push(p.runId);
    else finished.add(p.runId);
  }
  return started.filter(id => !finished.has(id) && id !== recordedRunId).reverse();
}

/** Prefers the most complete copy of a run: finished over running, then the one with output. */
export function preferRun(a: VerificationRun | undefined, b: VerificationRun | undefined): VerificationRun | undefined {
  if (!a) return b;
  if (!b) return a;
  if (isFinished(a) !== isFinished(b)) return isFinished(a) ? a : b;
  if (!!a.output !== !!b.output) return a.output ? a : b;
  return (b.finishedAt ?? 0) >= (a.finishedAt ?? 0) ? b : a;
}

/** Merges run lists by id, oldest first. */
export function mergeRuns(...lists: (VerificationRun | null | undefined)[][]): VerificationRun[] {
  const byId = new Map<string, VerificationRun>();
  for (const list of lists) for (const run of list) if (run) byId.set(run.id, preferRun(byId.get(run.id), run)!);
  return [...byId.values()].sort((a, b) => a.at - b.at);
}
