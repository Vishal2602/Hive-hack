import { useMemo, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Code, FileCode, History, PenLine, SquareTerminal, X } from 'lucide-react';
import { Alert, type AlertTone } from '@/components/arc/alert/alert';
import { Button } from '@/components/arc/button/button';
import { CodeBlock } from '@/components/arc/code-block/code-block';
import { EmptyState } from '@/components/arc/empty-state/empty-state';
import { SortableDataTable, type DataColumn } from '@/components/arc/sortable-data-table/sortable-data-table';
import { Stepper, type StepperStep } from '@/components/arc/stepper/stepper';
import { Timeline, type TimelineEvent } from '@/components/arc/timeline/timeline';
import { Page, formatClock, formatRelative, parseSymbolKey, useHive, useMediaQuery, useNow } from '@/shell';
import type { Contract, ContractStatus, HiveEvent, VerificationRun } from '@/mock';
import { SignatureList, SignatureMark } from './agreements/Participants';
import { StateBadge } from './agreements/StateBadge';
import { VerificationRuns } from './agreements/VerificationRuns';
import { useContractRuns } from './agreements/runs';
import {
  STATE_LABEL, VERDICT_TITLE, exitText, isOffTrack, latestAppliedRun, lifecycleIndex, runVerdict, runningRun, signatureFor, signedCount,
  signersOf, standingSentence, type Signature,
} from './agreements/model';
import styles from './agreements/agreements.module.css';

const BackLink = () => (
  <Link to="/agreements" className={styles.back}>
    <ArrowLeft aria-hidden="true" size={16} />
    All agreements
  </Link>
);

export default function AgreementDetail() {
  const { id } = useParams();
  const { snapshot, sessionName, readOnly } = useHive();
  const navigate = useNavigate();
  const contract = snapshot.contracts.find(c => c.id === id);
  // Every run Hive knows for this agreement; running ones are re-read every second until they finish.
  const runs = useContractRuns(id ?? '');
  // Tick every second while a run is going so its duration stays current.
  const now = useNow(runs.polling ? 1_000 : 15_000);

  if (!contract) {
    return (
      <Page title="Agreement not found" before={<BackLink />}>
        <EmptyState
          className={styles.empty}
          icon={<FileCode />}
          title="This agreement is not on this server"
          description="It may belong to another workspace, or the link is incomplete. The list shows every agreement Hive knows about."
          action={<Button variant="secondary" onClick={() => navigate('/agreements')}>Open the list</Button>}
        />
      </Page>
    );
  }

  return (
    <Detail contract={contract} runs={runs.list} polling={runs.polling} runError={runs.error} events={snapshot.events}
      sessionName={sessionName} now={now} readOnly={readOnly} />
  );
}

interface DetailProps {
  contract: Contract;
  runs: VerificationRun[];
  polling: boolean;
  runError: string | null;
  events: HiveEvent[];
  sessionName: (id: string) => string;
  now: number;
  readOnly: boolean;
}

function Detail({ contract, runs, polling, runError, events, sessionName, now, readOnly }: DetailProps) {
  const owner = sessionName(contract.ownerSessionId);
  const producer = contract.producerSymbol ? parseSymbolKey(contract.producerSymbol) : null;
  const applied = latestAppliedRun(runs);
  const inFlight = runningRun(runs);
  const signed = signedCount(contract);
  const total = contract.participants.length;
  const proven = contract.status === 'verified' || (applied ? runVerdict(applied) === 'proof' : false);
  // Below 640 px the horizontal stepper only captions the current step, so each label goes beside its own marker instead.
  const narrow = useMediaQuery('(max-width: 640px)');
  // The Arc table turns its header into a sort strip on phones; a labelled list reads better for a few participants.
  const phone = useMediaQuery('(max-width: 620px)');

  const steps = useMemo<StepperStep[]>(() => {
    const verifyError = !inFlight && applied && !applied.passed && contract.status !== 'verified'
      ? `${applied.command}: ${VERDICT_TITLE[runVerdict(applied)].toLowerCase()}, ${exitText(applied)} at revision ${applied.revision}`
      : undefined;
    return [
      { id: 'proposed', label: 'Proposed', description: 'Declaration on record' },
      { id: 'accepted', label: 'Accepted', description: signed === total ? 'Every participant signed this exact version' : `${signed} of ${total} signed this version` },
      { id: 'implemented', label: 'Implemented', description: 'Compiler found matching code' },
      { id: 'verified', label: 'Verified', description: inFlight ? `Running ${inFlight.command} now` : 'Tests passed on applied code', error: verifyError },
    ];
  }, [applied, inFlight, contract.status, signed, total]);

  return (
    <Page
      title={contract.title}
      before={<BackLink />}
      description={`Version ${contract.version}, owned by ${owner}. Updated ${formatRelative(contract.updatedAt, now)}.`}
    >
      <section className={styles.standing} aria-labelledby="standing-heading">
        <div className={styles.standingHead}>
          <h2 id="standing-heading" className={styles.sectionTitle}>Where it stands</h2>
          <StateBadge status={contract.status} size="lg" />
        </div>
        {!isOffTrack(contract.status) && <p className={styles.lead}>{standingSentence(contract, runs)}</p>}
        <Stepper
          steps={steps}
          current={lifecycleIndex(contract)}
          orientation={narrow ? 'vertical' : 'horizontal'}
          label="Agreement lifecycle"
          completeLabel="Verified on applied code"
        />
        {isOffTrack(contract.status) && <OffTrackNotice contract={contract} />}

        <div className={styles.split}>
          <div className={styles.splitCell} data-kind="agreement">
            <h3 className={styles.smallHeading}>Agreement</h3>
            <p>{signed === total ? `All ${total} participants signed version ${contract.version}.` : `${signed} of ${total} participants signed version ${contract.version}.`}</p>
            <p className={styles.muted}>A signature is a promise, not evidence that the code works.</p>
          </div>
          <div className={styles.splitCell} data-kind={proven ? 'proof' : 'unproven'}>
            <h3 className={styles.smallHeading}>Proof</h3>
            <p>
              {inFlight
                ? `${inFlight.command} is running at revision ${inFlight.revision}. No result yet.`
                : proven && applied
                  ? `${applied.command} exited 0 on applied code at revision ${applied.revision}.`
                  : applied
                    ? `Not verified. The latest run on applied code ${runVerdict(applied) === 'inconclusive' ? 'was inconclusive' : runVerdict(applied) === 'error' ? 'could not run' : 'failed'} (${exitText(applied)}).`
                    : 'Not verified. No test has run on applied code yet.'}
            </p>
            <p className={styles.muted}>Only a passing run on applied code counts.</p>
          </div>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="promise-heading">
        <header className={styles.sectionHead}>
          <h2 id="promise-heading" className={styles.sectionTitle}>The promise</h2>
          <p className={styles.muted}>
            {producer
              ? <>The interface <code>{producer.name}</code> in <code>{producer.file}</code> will match this declaration.</>
              : 'The declaration every participant signed.'}
          </p>
        </header>
        <CodeBlock code={contract.declaration} filename={producer?.file ?? 'Declaration'} language="ts" />
        <div className={styles.notes}>
          <h3 className={styles.smallHeading}>Behavior notes</h3>
          {contract.behaviorNotes.trim()
            ? <ul className={styles.noteList}>{contract.behaviorNotes.split('\n').filter(l => l.trim()).map((line, i) => <li key={i}>{line}</li>)}</ul>
            : <p className={styles.muted}>{readOnly ? 'Behavior notes are not shared with viewer tokens.' : 'No behavior notes for this version.'}</p>}
        </div>
      </section>

      <section className={styles.section} aria-labelledby="signatures-heading">
        <header className={styles.sectionHead}>
          <h2 id="signatures-heading" className={styles.sectionTitle}>Signatures</h2>
          <p className={styles.muted}>A signature counts only for the exact version it names. Any revision needs every participant to sign again.</p>
        </header>
        {phone
          ? <SignatureList contract={contract} sessionName={sessionName} now={now} />
          : <SignatureTable contract={contract} sessionName={sessionName} now={now} />}
        <EarlierVersions contract={contract} sessionName={sessionName} now={now} />
      </section>

      <section className={styles.section} aria-labelledby="evidence-heading">
        <header className={styles.sectionHead}>
          <h2 id="evidence-heading" className={styles.sectionTitle}>Evidence</h2>
          <p className={styles.muted}>What the compiler and the test runner observed in the repository.</p>
        </header>
        <ImplementationEvidence contract={contract} now={now} />
        <div className={styles.subsection}>
          <h3 className={styles.subTitle}>Verification runs</h3>
          <VerificationRuns runs={runs} now={now} polling={polling} error={runError} />
        </div>
      </section>

      <section className={styles.section} aria-labelledby="history-heading">
        <header className={styles.sectionHead}>
          <h2 id="history-heading" className={styles.sectionTitle}>History</h2>
          <p className={styles.muted}>Versions, signatures, checks and state changes, newest first.</p>
        </header>
        <Timeline events={historyEvents(contract, runs, events, sessionName)} now={now} label={`History of ${contract.title}`} headingLevel={3} />
      </section>
    </Page>
  );
}

const OFF_TRACK: Partial<Record<ContractStatus, { tone: AlertTone; title: string }>> = {
  stale: { tone: 'warning', title: 'This agreement is stale' },
  rejected: { tone: 'danger', title: 'This agreement was rejected' },
  cancelled: { tone: 'info', title: 'This agreement was cancelled' },
};

function OffTrackNotice({ contract }: { contract: Contract }) {
  const look = OFF_TRACK[contract.status];
  if (!look) return null;
  const body = contract.status === 'stale'
    ? `${contract.evidence.staleReason ?? 'The code or an intent changed after this version was signed.'} Participants need to sign version ${contract.version} again before anyone builds on it.`
    : contract.status === 'rejected'
      ? 'A participant declined this version. A revised version would need every participant to sign again.'
      : 'Nobody is bound by this agreement any more. The record stays for reference.';
  return <Alert tone={look.tone} title={look.title}>{body}</Alert>;
}

type SignatureRow = {
  id: string;
  participant: string;
  role: string;
  signature: string;
  signedAt: number | null;
  sig: Signature;
};

function SignatureTable({ contract, sessionName, now }: { contract: Contract; sessionName: (id: string) => string; now: number }) {
  const rows: SignatureRow[] = contract.participants.map(id => {
    const sig = signatureFor(contract, id);
    return {
      id,
      participant: sessionName(id),
      role: id === contract.ownerSessionId ? 'Owner' : 'Participant',
      signature: sig.kind,
      signedAt: sig.kind === 'pending' ? null : sig.at,
      sig,
    };
  });
  const columns: DataColumn<SignatureRow>[] = [
    { key: 'participant', label: 'Participant', sortable: true },
    { key: 'role', label: 'Role', sortable: true },
    { key: 'signature', label: `Signature on v${contract.version}`, sortable: true, render: (_v, row) => <SignatureMark sig={row.sig} /> },
    {
      key: 'signedAt', label: 'Signed', sortable: true, numeric: false,
      render: (_v, row) => (row.signedAt ? <span title={formatClock(row.signedAt)}>{formatRelative(row.signedAt, now)}</span> : <span className={styles.muted}>Not yet</span>),
    },
  ];
  return (
    <SortableDataTable
      rows={rows}
      columns={columns}
      rowKey="id"
      caption={`Signatures on version ${contract.version}`}
      emptyMessage="This agreement has no participants."
      itemName={{ one: 'participant', other: 'participants' }}
    />
  );
}

/** Signatures on every earlier version, so a reader can see who agreed to what before the latest revision. */
function EarlierVersions({ contract, sessionName, now }: { contract: Contract; sessionName: (id: string) => string; now: number }) {
  const earlier = contract.history.filter(v => v.version !== contract.version).sort((a, b) => b.version - a.version);
  if (!earlier.length) return null;
  return (
    <div className={styles.subsection}>
      <h3 className={styles.subTitle}>Earlier versions</h3>
      <p className={styles.muted}>These signatures do not count for version {contract.version}.</p>
      <ol className={styles.versions}>
        {earlier.map(v => {
          const signers = signersOf(contract, v.version);
          return (
            <li key={v.version} className={styles.versionItem}>
              <p className={styles.versionHead}>
                <strong>Version {v.version}</strong>
                <span className={styles.muted}>proposed {formatRelative(v.at, now)}</span>
                <span>{signers.length ? `Signed by ${signers.map(s => sessionName(s.sessionId)).join(', ')}` : 'Nobody signed it'}</span>
              </p>
              <pre className={styles.declaration}>{v.declaration}</pre>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function ImplementationEvidence({ contract, now }: { contract: Contract; now: number }) {
  const impl = contract.evidence.implemented;
  const overlay = contract.evidence.overlayCheck;
  return (
    <div className={styles.subsection}>
      <h3 className={styles.subTitle}>Compiler match</h3>
      {impl ? (
        <div className={styles.evidence}>
          <p>
            The compiler found <code>{parseSymbolKey(impl.symbol).name}</code> in <code>{impl.file || parseSymbolKey(impl.symbol).file}</code> with a matching
            signature at revision {impl.revision}, {formatRelative(impl.at, now)}.
          </p>
          {impl.declaration && <pre className={styles.declaration}>{impl.declaration}</pre>}
          {impl.declarationHash && <p className={styles.muted}>Declaration hash <code title={impl.declarationHash}>{impl.declarationHash}</code></p>}
        </div>
      ) : (
        <p className={styles.muted}>No code matches the declaration yet.</p>
      )}
      {overlay && (
        <p className={styles.muted}>
          {overlay.ok
            ? `A staged overlay check found no new diagnostics ${formatRelative(overlay.at, now)}.`
            : `A staged overlay check found ${overlay.diagnostics.length} new diagnostic${overlay.diagnostics.length === 1 ? '' : 's'} ${formatRelative(overlay.at, now)}.`}
        </p>
      )}
      {overlay && !overlay.ok && overlay.diagnostics.length > 0 && (
        <pre className={styles.output}>{overlay.diagnostics.join('\n')}</pre>
      )}
    </div>
  );
}

function historyEvents(contract: Contract, runs: VerificationRun[], events: HiveEvent[], sessionName: (id: string) => string): TimelineEvent[] {
  const owner = sessionName(contract.ownerSessionId);
  const out: TimelineEvent[] = [];
  const versionDetail = (declaration: string, notes: string): ReactNode => (
    <div className={styles.historyDetail}>
      <pre className={styles.declaration}>{declaration}</pre>
      {notes.trim() && <p className={styles.preLine}>{notes}</p>}
    </div>
  );

  for (const v of contract.history) {
    out.push({
      id: `version-${v.version}`,
      at: v.at,
      actor: owner,
      title: v.version === 1 ? 'proposed version 1' : `revised it to version ${v.version}`,
      meta: `${v.participants.length} participants asked to sign`,
      detail: versionDetail(v.declaration, v.behaviorNotes),
      icon: <PenLine />,
    });
  }
  for (const ack of contract.acknowledgementDetails) {
    out.push({
      id: `ack-${ack.sessionId}-${ack.version}`,
      at: ack.at,
      actor: sessionName(ack.sessionId),
      title: `signed version ${ack.version}`,
      meta: ack.intentRevision > 0 ? `Against intent revision ${ack.intentRevision}` : undefined,
      icon: <PenLine />,
    });
  }
  const impl = contract.evidence.implemented;
  if (impl) {
    out.push({
      id: `impl-${impl.revision}`,
      at: impl.at,
      actor: 'Compiler',
      title: `found matching code at revision ${impl.revision}`,
      meta: impl.file,
      icon: <Code />,
    });
  }
  for (const run of runs) {
    const verdict = runVerdict(run);
    out.push({
      id: `run-${run.id}`,
      at: run.at,
      actor: 'Test runner',
      title: verdict === 'running'
        ? `started ${run.command} at revision ${run.revision}, still running`
        : `ran ${run.command} at revision ${run.revision}${run.overlay ? ' on staged changes' : ''}: ${VERDICT_TITLE[verdict].toLowerCase()}, ${exitText(run)}`,
      meta: verdict === 'proof' ? 'Counts as verification'
        : verdict === 'overlay' ? 'Does not count as verification'
          : verdict === 'running' ? 'No result yet'
            : verdict === 'inconclusive' ? 'Code moved during the run; proves nothing either way'
              : run.reasons.join('; ') || 'Verification failed',
      tone: verdict === 'proof' ? 'success' : verdict === 'failed' || verdict === 'error' ? 'danger' : 'neutral',
      icon: <SquareTerminal />,
    });
  }
  // State changes the history above does not already cover.
  for (const e of events) {
    if (e.payload?.contractId !== contract.id) continue;
    if (e.type === 'contract.stale') {
      out.push({ id: `event-${e.seq}`, at: e.at, actor: 'Hive', title: 'marked it stale', meta: String(e.payload.reason ?? ''), icon: <History /> });
    } else if (e.type === 'contract.accepted') {
      out.push({ id: `event-${e.seq}`, at: e.at, actor: 'Hive', title: `marked version ${String(e.payload.version ?? contract.version)} accepted`, meta: 'Every participant signed the exact version', icon: <PenLine /> });
    } else if (e.type === 'contract.rejected' || e.type === 'contract.cancelled') {
      out.push({ id: `event-${e.seq}`, at: e.at, actor: 'Hive', title: `marked it ${STATE_LABEL[e.type === 'contract.rejected' ? 'rejected' : 'cancelled'].toLowerCase()}`, meta: e.detail, icon: <X />, tone: 'danger' });
    }
  }
  return orderForNewestFirst(out);
}

/** Causal rank inside one millisecond: a version is proposed, then signed, then accepted, then implemented and run. */
function causalRank(id: string): number {
  if (id.startsWith('version-')) return 0;
  if (id.startsWith('ack-')) return 1;
  if (id.startsWith('event-')) return 2;
  if (id.startsWith('impl-')) return 3;
  return 4;
}

/**
 * The timeline sorts newest first with a stable sort, so items sharing a timestamp keep the order given here.
 * Hand it the reverse causal order so a same-millisecond acceptance never renders below the signature that caused it.
 */
function orderForNewestFirst(items: TimelineEvent[]): TimelineEvent[] {
  const time = (e: TimelineEvent) => new Date(e.at).getTime();
  return [...items].sort((a, b) => time(b) - time(a) || causalRank(b.id) - causalRank(a.id));
}
