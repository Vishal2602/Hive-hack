// Verification runs for the agreement and activity screens.
// The snapshot carries only the latest finished run per agreement, and a run that is still going is
// visible only through its `contract.verification_started` event. Members and admins can read any run
// with `verify_status` (read-only, no session needed), so the screens collect run ids from the event
// log and ask the daemon for each one, polling every second while a run is `running` and stopping as
// soon as it finishes. Viewers cannot send commands: they get the last five runs from /api/view,
// which the store already polls every two seconds.
import { useEffect, useMemo, useState } from 'react';
import { useHive } from '@/shell';
import type { VerificationRun } from '@/mock';
import { isFinished, mergeRuns, runIdsFromEvents } from './runModel';

export { mergeRuns, preferRun, runIdsFromEvents, unfinishedRunIds } from './runModel';

export const RUN_POLL_MS = 1_000;
/** Give up on a run id after this many failed status reads in a row (unknown id, revoked access). */
const MAX_FAILURES = 3;

type Entry = { run: VerificationRun | null; failures: number; error: string | null };

// Finished runs never change, so they are cached for the life of the page. Running ones are re-read.
const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();
const notify = () => { for (const listener of [...listeners]) listener(); };

export interface RunStatus {
  /** Runs read from the daemon, by id. */
  runs: Record<string, VerificationRun>;
  /** True while at least one requested run is still running and being polled. */
  polling: boolean;
  /** Last status read error, human readable. */
  error: string | null;
}

/**
 * Reads each run id with verify_status and keeps re-reading the ones still running every second.
 * Disabled (returns nothing) for viewers and in mock mode.
 */
export function useRunStatus(runIds: string[]): RunStatus {
  const { client, readOnly, mode, status } = useHive();
  const enabled = mode === 'live' && !readOnly && status === 'ready';
  const key = runIds.join(',');
  // Bumped on every cache change so the derived view below recomputes.
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const listener = () => setVersion(v => v + 1);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);

  useEffect(() => {
    if (!enabled || !key) return;
    const ids = key.split(',');
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      const due = ids.filter(id => {
        const entry = cache.get(id);
        return !entry || (!isFinished(entry.run) && entry.failures < MAX_FAILURES);
      });
      if (!due.length) return;
      await Promise.all(due.map(async id => {
        const previous = cache.get(id);
        try {
          const run = await client.verifyStatus(id);
          cache.set(id, { run, failures: 0, error: null });
        } catch (error) {
          cache.set(id, { run: previous?.run ?? null, failures: (previous?.failures ?? 0) + 1, error: error instanceof Error ? error.message : 'Status read failed' });
        }
      }));
      if (cancelled) return;
      notify();
      const again = ids.some(id => {
        const entry = cache.get(id);
        return !entry || (!isFinished(entry.run) && entry.failures < MAX_FAILURES);
      });
      if (again) timer = setTimeout(() => { void tick(); }, RUN_POLL_MS);
    };
    void tick();
    return () => { cancelled = true; if (timer !== null) clearTimeout(timer); };
  }, [enabled, key, client]);

  return useMemo<RunStatus>(() => {
    const runs: Record<string, VerificationRun> = {};
    let polling = false;
    let error: string | null = null;
    if (enabled) {
      for (const id of key ? key.split(',') : []) {
        const entry = cache.get(id);
        if (entry?.run) runs[id] = entry.run;
        if (!entry || (!isFinished(entry.run) && entry.failures < MAX_FAILURES)) polling = true;
        if (entry?.error) error = entry.error;
      }
    }
    return { runs, polling, error };
    // runIds is represented by key; version changes whenever the shared cache does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key, version]);
}

/** Every verification run Hive knows for one agreement, oldest first, with running ones kept fresh. */
export function useContractRuns(contractId: string): RunStatus & { list: VerificationRun[] } {
  const { runsFor, events, snapshot } = useHive();
  const contract = snapshot.contracts.find(c => c.id === contractId);
  const recorded = contract?.evidence.verification ?? null;
  const ids = useMemo(() => {
    const fromEvents = runIdsFromEvents(events, contractId);
    return recorded && !fromEvents.includes(recorded.id) ? [...fromEvents, recorded.id] : fromEvents;
  }, [events, contractId, recorded]);
  const status = useRunStatus(ids);
  const base = runsFor(contractId);
  const list = useMemo(() => mergeRuns(base, recorded ? [recorded] : [], Object.values(status.runs)), [base, recorded, status.runs]);
  return { ...status, list };
}
