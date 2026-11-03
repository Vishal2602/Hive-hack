// Verification runs, newest first. Green appears only on a passing run against applied code.
// A running run says so and is re-read every second (see runs.ts) until it finishes.
import { useId, useState } from 'react';
import { CircleCheck, CircleDashed, CircleHelp, CircleX, Clock, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/arc/button/button';
import { formatClock, formatDuration, formatRelative, shortHash, useHive } from '@/shell';
import type { VerificationRun } from '@/mock';
import { VERDICT_TITLE, runVerdict, verdictNote, type RunVerdict } from './model';
import styles from './agreements.module.css';

const ICON: Record<RunVerdict, typeof CircleCheck> = {
  proof: CircleCheck, overlay: CircleDashed, failed: CircleX, running: Clock, inconclusive: CircleHelp, error: TriangleAlert,
};

export interface VerificationRunsProps {
  runs: VerificationRun[];
  now: number;
  /** True while a running run is being re-read. */
  polling?: boolean;
  /** Last status read error, if the re-read failed. */
  error?: string | null;
}

export function VerificationRuns({ runs, now, polling = false, error = null }: VerificationRunsProps) {
  if (runs.length === 0) {
    return (
      <p className={styles.muted}>
        No test runs yet. An agreement is verified when an allowlisted test command exits 0 on applied code.
      </p>
    );
  }
  const newestFirst = [...runs].sort((a, b) => b.at - a.at);
  const running = runs.some(r => r.status === 'running');
  return (
    <>
      <p className={`${styles.muted} ${styles.runStatus}`} role="status" aria-live="polite">
        {running
          ? polling ? 'A run is in progress. Hive checks its status every second until it finishes.' : 'A run is in progress. Its result appears with the next update.'
          : ''}
        {error ? ` The last status check failed: ${error}.` : ''}
      </p>
      <ol className={styles.runs}>
        {newestFirst.map(run => <RunItem key={run.id} run={run} now={now} />)}
      </ol>
    </>
  );
}

function RunItem({ run, now }: { run: VerificationRun; now: number }) {
  const { readOnly } = useHive();
  const [open, setOpen] = useState(false);
  const outputId = useId();
  const verdict = runVerdict(run);
  const Icon = ICON[verdict];
  const hashes = Object.entries(run.sourceHashes);
  const finished = run.finishedAt ?? null;
  return (
    <li className={styles.run} data-verdict={verdict}>
      <div className={styles.runHead}>
        <Icon className={styles.runIcon} aria-hidden="true" size={20} />
        <div className={styles.runTitleBlock}>
          <h4 className={styles.runTitle}>{VERDICT_TITLE[verdict]}</h4>
          <p className={styles.runNote}>{verdictNote(run)}</p>
        </div>
        <time className={styles.runTime} dateTime={new Date(run.at).toISOString()} title={formatClock(run.at)}>
          {formatRelative(run.at, now)}
        </time>
      </div>

      <dl className={styles.facts}>
        <div><dt>Command</dt><dd><code>{run.command}</code></dd></div>
        <div><dt>Status</dt><dd>{run.status}</dd></div>
        <div><dt>Exit code</dt><dd>{run.exitCode === null ? (verdict === 'running' ? 'Pending' : 'None') : run.exitCode}</dd></div>
        <div><dt>Revision</dt><dd>{run.revision}</dd></div>
        <div><dt>Version</dt><dd>v{run.version}</dd></div>
        <div><dt>Code</dt><dd>{run.overlay ? 'Staged, not applied' : 'Applied'}</dd></div>
        <div>
          <dt>{finished ? 'Took' : 'Running for'}</dt>
          <dd>{formatDuration(Math.max(0, (finished ?? now) - run.at))}</dd>
        </div>
      </dl>

      {run.reasons.length > 1 && (
        <ul className={styles.noteList} aria-label="Reasons">
          {run.reasons.map((reason, i) => <li key={i}>{reason}</li>)}
        </ul>
      )}

      {hashes.length > 0 && (
        <div className={styles.hashes}>
          <h5 className={styles.smallHeading}>Source hashes</h5>
          <dl>
            {hashes.map(([file, hash]) => (
              <div key={file}>
                <dt><code>{file}</code></dt>
                <dd><code title={hash}>{shortHash(hash, 12)}</code></dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {run.output ? (
        <div>
          <Button variant="ghost" size="sm" aria-expanded={open} aria-controls={outputId} onClick={() => setOpen(o => !o)}>
            {open ? 'Hide output' : 'Show output'}
          </Button>
          <pre id={outputId} hidden={!open} className={styles.output} tabIndex={open ? 0 : -1} aria-label={`Output of ${run.command}`}>
            {run.output}
          </pre>
        </div>
      ) : (
        <p className={styles.muted}>
          {verdict === 'running'
            ? 'Output appears when the command finishes.'
            : readOnly ? 'Test output and source hashes are not shared with viewer tokens.' : 'The command printed nothing.'}
        </p>
      )}
    </li>
  );
}
