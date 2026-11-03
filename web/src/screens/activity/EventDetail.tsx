// The selected event: who, when, what, the evidence body (diff or test output) and every payload field,
// all rendered as plain text. Verification events read their run with verify_status (members and admins)
// and keep re-reading it every second while it is still running.
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { motion, useReducedMotion } from 'motion/react';
import { Badge, type BadgeProps } from '@/components/arc/badge/badge';
import { motionTokens } from '@/components/arc/lib/motion-tokens';
import { formatClock, formatDateTime, formatDuration, formatLease, formatRelative, parseSymbolKey, shortHash, useHive } from '@/shell';
import type { HiveEvent, VerificationRun } from '@/mock';
import { ParticipantList } from '../agreements/Participants';
import { VERDICT_TITLE, exitText, runVerdict, signersOf, verdictNote } from '../agreements/model';
import { preferRun, useRunStatus } from '../agreements/runs';
import { fieldText, type EventTone, type EventView } from './describe';
import styles from './activity.module.css';

const TONE: Record<EventTone, Pick<BadgeProps, 'tone' | 'color'>> = {
  neutral: { tone: 'neutral' },
  accent: { color: 'amber' },
  warning: { tone: 'warning' },
  danger: { tone: 'danger' },
  success: { tone: 'success' },
};

const VERIFICATION_EVENTS = new Set(['contract.verification_started', 'contract.verification_failed', 'contract.verification_inconclusive', 'contract.verified']);

export function EventDetail({ view, position, total, now }: { view: EventView; position: number; total: number; now: number }) {
  const reduced = useReducedMotion() ?? false;
  const { event } = view;
  return (
    <motion.article
      key={event.seq}
      className={styles.card}
      aria-labelledby={`event-${event.seq}-title`}
      initial={reduced ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduced ? { duration: 0 } : { duration: motionTokens.duration.standard, ease: [...motionTokens.ease.enter] }}
    >
      <header className={styles.cardHead}>
        <div className={styles.cardChips}>
          <Badge {...TONE[view.tone]}>{view.kind}</Badge>
          <span className={styles.position}>Event {position} of {total}</span>
        </div>
        <h2 id={`event-${event.seq}-title`} className={styles.cardTitle}>{view.title}</h2>
        <p className={styles.cardLead}>{view.summary}</p>
        <dl className={styles.meta}>
          <div><dt>When</dt><dd><time dateTime={new Date(event.at).toISOString()} title={formatDateTime(event.at)}>{formatClock(event.at)}</time>, {formatRelative(event.at, now)}</dd></div>
          <div><dt>Actor</dt><dd>{view.actor}</dd></div>
          <div><dt>Kind</dt><dd><code>{event.type}</code></dd></div>
          <div><dt>Sequence</dt><dd>{event.seq}</dd></div>
          {view.revision !== null && <div><dt>Revision</dt><dd>{view.revision}</dd></div>}
        </dl>
      </header>
      <EventBody view={view} now={now} />
      <PayloadFields event={event} />
    </motion.article>
  );
}

function EventBody({ view, now }: { view: EventView; now: number }) {
  const { snapshot, runsFor, sessionName } = useHive();
  const { event } = view;
  const p = event.payload ?? {};
  const contract = view.contractId ? snapshot.contracts.find(c => c.id === view.contractId) ?? null : null;
  const runId = VERIFICATION_EVENTS.has(event.type) && typeof p.runId === 'string' ? p.runId : null;
  // Hooks run on every render; the id is null for events that are not about a run.
  const status = useRunStatus(runId ? [runId] : []);
  const agreementLink = contract && (
    <p><Link className={styles.link} to={`/agreements/${encodeURIComponent(contract.id)}`}>Open {contract.title}</Link></p>
  );

  switch (event.type) {
    case 'operation.applied':
    case 'proposal.previewed':
    case 'proposal.rejected':
    case 'proposal.stale':
    case 'proposal.failed': {
      const proposal = snapshot.proposals.find(pr => pr.id === p.proposalId);
      if (!proposal?.preview) return <div className={styles.body}><RawDetail event={event} /></div>;
      const preview = proposal.preview;
      return (
        <div className={styles.body}>
          <dl className={styles.facts}>
            <div><dt>Operation</dt><dd><code>{proposal.operation.kind}</code></dd></div>
            <div><dt>Proposal status now</dt><dd>{proposal.status}</dd></div>
            <div><dt>Base revision</dt><dd>{proposal.baseRevision}</dd></div>
            {proposal.result && <div><dt>Applied at revision</dt><dd>{proposal.result.revision}</dd></div>}
          </dl>
          {preview.diff
            ? <Block title="Diff"><DiffText diff={preview.diff} /></Block>
            : <p className={styles.muted}>This proposal has no diff.</p>}
          {preview.rejections.length > 0 && (
            <Block title="Why Hive refused it">
              <ul className={styles.plainList}>{preview.rejections.map((r, i) => <li key={i}>{r}</li>)}</ul>
            </Block>
          )}
          {preview.newDiagnostics.length > 0 && (
            <Block title="New compiler diagnostics">
              <pre className={styles.pre}>{preview.newDiagnostics.map(d => `${d.file}:${d.line} TS${d.code} ${d.message}`).join('\n')}</pre>
            </Block>
          )}
          {preview.callers.length > 0 && (
            <Block title="Callers">
              <ul className={styles.plainList}>
                {preview.callers.map(c => (
                  <li key={`${c.from}-${c.line}`}><code>{parseSymbolKey(c.from).name}</code> in <code>{c.file}:{c.line}</code>{c.note ? `: ${c.note}` : ''}</li>
                ))}
              </ul>
            </Block>
          )}
          {proposal.result && <SourceHashes hashes={proposal.result.sourceHashes} />}
        </div>
      );
    }
    case 'contract.verification_started':
    case 'contract.verification_failed':
    case 'contract.verification_inconclusive':
    case 'contract.verified': {
      const known = contract ? runsFor(contract.id) : [];
      const recorded = contract?.evidence.verification ?? null;
      // contract.verified carries no run id: the agreement's recorded verification is that run.
      const candidate = runId
        ? preferRun(known.find(r => r.id === runId) ?? (recorded?.id === runId ? recorded : undefined), status.runs[runId])
        : event.type === 'contract.verified' && recorded?.passed ? recorded : undefined;
      if (!candidate) {
        return (
          <div className={styles.body}>
            <RawDetail event={event} />
            {status.polling && <p className={styles.muted} role="status">Reading this run from Hive.</p>}
            {status.error && <p className={styles.muted}>Could not read the run: {status.error}</p>}
            {agreementLink}
          </div>
        );
      }
      return <div className={styles.body}><RunBody run={candidate} now={now} polling={status.polling} />{agreementLink}</div>;
    }
    case 'contract.proposed':
    case 'contract.revised': {
      const version = contract?.history.find(h => h.version === p.version) ?? null;
      if (!contract || !version) return <div className={styles.body}><RawDetail event={event} />{agreementLink}</div>;
      return (
        <div className={styles.body}>
          <Block title={`Declaration, version ${version.version}`}>
            <pre className={styles.pre}>{version.declaration}</pre>
          </Block>
          {version.behaviorNotes.trim() && (
            <Block title="Behavior notes"><p className={styles.preLine}>{version.behaviorNotes}</p></Block>
          )}
          <Block title="Asked to sign">
            <ul className={styles.plainList}>{version.participants.map(id => <li key={id}>{sessionName(id)}</li>)}</ul>
          </Block>
          {agreementLink}
        </div>
      );
    }
    case 'contract.acknowledged':
    case 'contract.accepted': {
      if (!contract) return <div className={styles.body}><RawDetail event={event} /></div>;
      const version = typeof p.version === 'number' ? p.version : contract.version;
      const signers = signersOf(contract, version);
      return (
        <div className={styles.body}>
          <Block title={`Signatures on version ${version}`}>
            {signers.length
              ? <ul className={styles.plainList}>{signers.map(s => <li key={s.sessionId}>{sessionName(s.sessionId)}, {formatClock(s.at)}{s.intentRevision > 0 ? `, against intent revision ${s.intentRevision}` : ''}</li>)}</ul>
              : <p className={styles.muted}>No signatures on record for this version.</p>}
          </Block>
          {version !== contract.version && <p className={styles.muted}>The agreement is now on version {contract.version}; these signatures do not count for it.</p>}
          <Block title="Participants today"><ParticipantList contract={contract} sessionName={sessionName} /></Block>
          <p className={styles.muted}>A signature means the agent agreed to the exact text. It is not evidence that the code works.</p>
          {agreementLink}
        </div>
      );
    }
    case 'contract.implemented': {
      const impl = contract?.evidence.implemented ?? null;
      return (
        <div className={styles.body}>
          {impl ? (
            <Block title="Compiler match on record">
              <p>
                <code>{parseSymbolKey(impl.symbol).name}</code> in <code>{impl.file || parseSymbolKey(impl.symbol).file}</code> matches the declaration at revision {impl.revision}.
              </p>
              {impl.declaration && <pre className={styles.pre}>{impl.declaration}</pre>}
            </Block>
          ) : <RawDetail event={event} />}
          <p className={styles.muted}>Implemented is not verified. Only a passing test run on applied code verifies an agreement.</p>
          {agreementLink}
        </div>
      );
    }
    case 'contract.stale':
    case 'contract.rejected':
    case 'contract.cancelled':
      return (
        <div className={styles.body}>
          <Block title="Reason"><p>{typeof p.reason === 'string' ? p.reason : event.detail}</p></Block>
          {event.type === 'contract.stale' && <p className={styles.muted}>Participants need to sign again before anyone builds on this agreement.</p>}
          {agreementLink}
        </div>
      );
    case 'direct_edit': {
      const files = Array.isArray(p.files) ? p.files.filter((f): f is string => typeof f === 'string') : [];
      return (
        <div className={styles.body}>
          {files.length > 0 && (
            <Block title="Changed files">
              <ul className={styles.plainList}>{files.map(f => <li key={f}><code>{f}</code></li>)}</ul>
            </Block>
          )}
          <p className={styles.muted}>Hive found these changes by comparing source hashes after they happened. It did not stage or check them, and agreements that cover these files go stale.</p>
        </div>
      );
    }
    case 'intent.updated': {
      const intent = snapshot.intents.find(i => i.sessionId === view.sessionId);
      const rev = typeof p.revision === 'number' ? p.revision : null;
      if (!intent || intent.revision !== rev) {
        return (
          <div className={styles.body}>
            <RawDetail event={event} />
            {intent && <p className={styles.muted}>Hive keeps only the latest intent. This was revision {rev}; the current one is revision {intent.revision}.</p>}
          </div>
        );
      }
      return (
        <div className={styles.body}>
          <Block title="Task"><p>{intent.task}</p></Block>
          <Block title="Files">
            {intent.files.length ? <ul className={styles.plainList}>{intent.files.map(f => <li key={f}><code>{f}</code></li>)}</ul> : <p className={styles.muted}>None declared.</p>}
          </Block>
          <Block title="Symbols">
            {intent.symbols.length ? <ul className={styles.plainList}>{intent.symbols.map(s => <li key={s}><code>{parseSymbolKey(s).name}</code> in <code>{parseSymbolKey(s).file}</code></li>)}</ul> : <p className={styles.muted}>None declared.</p>}
          </Block>
          <Block title="Assumptions">
            {intent.assumptions.length
              ? <ul className={styles.plainList}>{intent.assumptions.map(a => <li key={a.key}><code>{a.key}</code> is <strong>{a.value}</strong></li>)}</ul>
              : <p className={styles.muted}>None declared.</p>}
          </Block>
        </div>
      );
    }
    case 'session.registered': {
      const session = snapshot.sessions.find(s => s.id === view.sessionId);
      if (!session) return <div className={styles.body}><RawDetail event={event} /></div>;
      return (
        <div className={styles.body}>
          <dl className={styles.facts}>
            <div><dt>Agent</dt><dd>{session.name}</dd></div>
            <div><dt>Status</dt><dd>{session.status === 'active' ? 'Active' : session.status === 'finished' ? 'Finished' : 'Expired'}</dd></div>
            <div><dt>Lease</dt><dd>{formatLease(session.expiresAt, now)}</dd></div>
          </dl>
        </div>
      );
    }
    default:
      return <div className={styles.body}><RawDetail event={event} /></div>;
  }
}

/** One verification run: verdict, facts, reasons, output and hashes. Still-running runs say so. */
function RunBody({ run, now, polling }: { run: VerificationRun; now: number; polling: boolean }) {
  const { readOnly } = useHive();
  const verdict = runVerdict(run);
  return (
    <>
      <p className={styles.verdict} data-verdict={verdict} role={verdict === 'running' ? 'status' : undefined}>
        {VERDICT_TITLE[verdict]}. {verdictNote(run)}
        {verdict === 'running' && polling ? ' Hive checks its status every second.' : ''}
      </p>
      <dl className={styles.facts}>
        <div><dt>Command</dt><dd><code>{run.command}</code></dd></div>
        <div><dt>Status</dt><dd>{run.status}</dd></div>
        <div><dt>Exit code</dt><dd>{run.exitCode === null ? (verdict === 'running' ? 'Pending' : 'None') : run.exitCode}</dd></div>
        <div><dt>Revision</dt><dd>{run.revision}</dd></div>
        <div><dt>Version</dt><dd>v{run.version}</dd></div>
        <div><dt>Code</dt><dd>{run.overlay ? 'Staged, not applied' : 'Applied'}</dd></div>
        <div><dt>{run.finishedAt ? 'Took' : 'Running for'}</dt><dd>{formatDuration(Math.max(0, (run.finishedAt ?? now) - run.at))}</dd></div>
      </dl>
      {run.reasons.length > 0 && (
        <Block title="Reasons">
          <ul className={styles.plainList}>{run.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
        </Block>
      )}
      <Block title="Test output">
        {run.output
          ? <pre className={styles.pre} tabIndex={0} aria-label={`Output of ${run.command}, ${exitText(run)}`}>{run.output}</pre>
          : <p className={styles.muted}>{verdict === 'running' ? 'Output appears when the command finishes.' : readOnly ? 'Test output is not shared with viewer tokens.' : 'The command printed nothing.'}</p>}
      </Block>
      <SourceHashes hashes={run.sourceHashes} />
    </>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.block}>
      <h3 className={styles.blockTitle}>{title}</h3>
      {children}
    </section>
  );
}

/** The server's own detail string, unchanged. */
function RawDetail({ event }: { event: HiveEvent }) {
  return (
    <Block title="Server detail">
      <pre className={styles.pre}>{event.detail}</pre>
    </Block>
  );
}

/** Every field the server sent with the event, as text. Viewers receive no payload at all. */
function PayloadFields({ event }: { event: HiveEvent }) {
  const { readOnly } = useHive();
  const entries = Object.entries(event.payload ?? {});
  if (!entries.length) {
    return readOnly
      ? <p className={styles.muted}>Viewer tokens receive the event type and a shortened detail only, without its fields.</p>
      : null;
  }
  return (
    <Block title="Event fields">
      <dl className={styles.fields}>
        {entries.map(([key, value]) => {
          const text = fieldText(value);
          return (
            <div key={key}>
              <dt><code>{key}</code></dt>
              <dd>{text.includes('\n') ? <pre className={styles.fieldPre}>{text}</pre> : <code>{text}</code>}</dd>
            </div>
          );
        })}
      </dl>
    </Block>
  );
}

function SourceHashes({ hashes }: { hashes: Record<string, string> }) {
  const entries = Object.entries(hashes);
  if (!entries.length) return null;
  return (
    <Block title="Source hashes">
      <dl className={styles.hashes}>
        {entries.map(([file, hash]) => (
          <div key={file}><dt><code>{file}</code></dt><dd><code title={hash}>{shortHash(hash, 12)}</code></dd></div>
        ))}
      </dl>
    </Block>
  );
}

type DiffKind = 'file' | 'hunk' | 'add' | 'del' | 'ctx';
const diffKind = (line: string): DiffKind => {
  if (line.startsWith('+++') || line.startsWith('---')) return 'file';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
};

/** Unified diff as text. Each line is a text node; additions and removals also carry a screen reader prefix. */
function DiffText({ diff }: { diff: string }) {
  const lines = diff.split('\n');
  return (
    <pre className={styles.diff} tabIndex={0} aria-label="Unified diff">
      {lines.map((line, i) => {
        const kind = diffKind(line);
        return (
          <span key={i} className={styles.diffLine} data-kind={kind}>
            {kind === 'add' && <span className="visually-hidden">Added: </span>}
            {kind === 'del' && <span className="visually-hidden">Removed: </span>}
            {line || ' '}
            {'\n'}
          </span>
        );
      })}
    </pre>
  );
}
