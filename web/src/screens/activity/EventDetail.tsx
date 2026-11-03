// The selected event: who, when, what, and the evidence body (diff or test output) as plain text.
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { motion, useReducedMotion } from 'motion/react';
import { Badge, type BadgeProps } from '@/components/arc/badge/badge';
import { motionTokens } from '@/components/arc/lib/motion-tokens';
import { formatClock, formatDateTime, formatLease, formatRelative, parseSymbolKey, shortHash, useMock } from '@/shell';
import type { HiveEvent } from '@/mock';
import { ParticipantList } from '../agreements/Participants';
import { VERDICT_TITLE, runVerdict, verdictNote } from '../agreements/model';
import type { EventTone, EventView } from './describe';
import styles from './activity.module.css';

const TONE: Record<EventTone, Pick<BadgeProps, 'tone' | 'color'>> = {
  neutral: { tone: 'neutral' },
  accent: { color: 'amber' },
  warning: { tone: 'warning' },
  danger: { tone: 'danger' },
  success: { tone: 'success' },
};

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
          {view.revision !== null && <div><dt>Revision</dt><dd>{view.revision}</dd></div>}
        </dl>
      </header>
      <EventBody view={view} now={now} />
    </motion.article>
  );
}

function EventBody({ view, now }: { view: EventView; now: number }) {
  const { snapshot, runsFor, sessionName } = useMock();
  const { event } = view;
  const p = event.payload ?? {};
  const contract = view.contractId ? snapshot.contracts.find(c => c.id === view.contractId) ?? null : null;
  const agreementLink = contract && (
    <p><Link className={styles.link} to={`/agreements/${encodeURIComponent(contract.id)}`}>Open {contract.title}</Link></p>
  );

  switch (event.type) {
    case 'operation.applied': {
      const proposal = snapshot.proposals.find(pr => pr.id === p.proposalId);
      if (!proposal?.preview) return <div className={styles.body}><RawDetail event={event} /></div>;
      const preview = proposal.preview;
      return (
        <div className={styles.body}>
          <Block title="Diff">
            <DiffText diff={preview.diff} />
          </Block>
          {preview.callers.length > 0 && (
            <Block title="Callers updated">
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
    case 'contract.verification_failed':
    case 'contract.verified': {
      const run = view.contractId ? runsFor(view.contractId).find(r => r.id === p.runId) : undefined;
      if (!run) return <div className={styles.body}><RawDetail event={event} />{agreementLink}</div>;
      const verdict = runVerdict(run);
      return (
        <div className={styles.body}>
          <p className={styles.verdict} data-verdict={verdict}>{VERDICT_TITLE[verdict]}. {verdictNote(run)}</p>
          <dl className={styles.facts}>
            <div><dt>Command</dt><dd><code>{run.command}</code></dd></div>
            <div><dt>Exit code</dt><dd>{run.exitCode}</dd></div>
            <div><dt>Revision</dt><dd>{run.revision}</dd></div>
            <div><dt>Code</dt><dd>{run.overlay ? 'Staged, not applied' : 'Applied'}</dd></div>
          </dl>
          <Block title="Test output">
            <pre className={styles.pre} tabIndex={0} aria-label={`Output of ${run.command}`}>{run.output}</pre>
          </Block>
          <SourceHashes hashes={run.sourceHashes} />
          {agreementLink}
        </div>
      );
    }
    case 'contract.proposed': {
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
          {agreementLink}
        </div>
      );
    }
    case 'contract.accepted':
      if (!contract) return <RawDetail event={event} />;
      return (
        <div className={styles.body}>
          <Block title="Signatures today">
            <ParticipantList contract={contract} sessionName={sessionName} />
          </Block>
          <p className={styles.muted}>Accepted means every participant agreed to the exact text. It is not evidence that the code works.</p>
          {agreementLink}
        </div>
      );
    case 'contract.stale':
      return (
        <div className={styles.body}>
          <Block title="Reason"><p>{typeof p.reason === 'string' ? p.reason : event.detail}</p></Block>
          <p className={styles.muted}>Participants need to sign again before anyone builds on this agreement.</p>
          {agreementLink}
        </div>
      );
    case 'direct_edit': {
      const files = Array.isArray(p.files) ? p.files.filter((f): f is string => typeof f === 'string') : [];
      return (
        <div className={styles.body}>
          <Block title="Changed files">
            <ul className={styles.plainList}>{files.map(f => <li key={f}><code>{f}</code></li>)}</ul>
          </Block>
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
      if (!session) return <RawDetail event={event} />;
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
