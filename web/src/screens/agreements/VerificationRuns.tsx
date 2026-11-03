// Verification runs, newest first. Green appears only on a passing run against applied code.
import { useId, useState } from 'react';
import { CircleCheck, CircleDashed, CircleX } from 'lucide-react';
import { Button } from '@/components/arc/button/button';
import { formatClock, formatRelative, shortHash } from '@/shell';
import type { VerificationRun } from '@/mock';
import { VERDICT_TITLE, runVerdict, verdictNote } from './model';
import styles from './agreements.module.css';

const ICON = { proof: CircleCheck, overlay: CircleDashed, failed: CircleX } as const;

export function VerificationRuns({ runs, now }: { runs: VerificationRun[]; now: number }) {
  if (runs.length === 0) {
    return (
      <p className={styles.muted}>
        No test runs yet. An agreement is verified when an allowlisted test command exits 0 on applied code.
      </p>
    );
  }
  const newestFirst = [...runs].sort((a, b) => b.at - a.at);
  return (
    <ol className={styles.runs}>
      {newestFirst.map(run => <RunItem key={run.id} run={run} now={now} />)}
    </ol>
  );
}

function RunItem({ run, now }: { run: VerificationRun; now: number }) {
  const [open, setOpen] = useState(false);
  const outputId = useId();
  const verdict = runVerdict(run);
  const Icon = ICON[verdict];
  const hashes = Object.entries(run.sourceHashes);
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
        <div><dt>Exit code</dt><dd>{run.exitCode}</dd></div>
        <div><dt>Revision</dt><dd>{run.revision}</dd></div>
        <div><dt>Version</dt><dd>v{run.version}</dd></div>
        <div><dt>Code</dt><dd>{run.overlay ? 'Staged, not applied' : 'Applied'}</dd></div>
      </dl>

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

      <div>
        <Button variant="ghost" size="sm" aria-expanded={open} aria-controls={outputId} onClick={() => setOpen(o => !o)}>
          {open ? 'Hide output' : 'Show output'}
        </Button>
        <pre id={outputId} hidden={!open} className={styles.output} tabIndex={open ? 0 : -1} aria-label={`Output of ${run.command}`}>
          {run.output}
        </pre>
      </div>
    </li>
  );
}
