// One agent: who runs it, what it is doing, where it is in the six steps, and its lease.
// The card opens into a quick look with the declared intent, since that is real extra content.
import { Avatar } from '@/components/arc/avatar/avatar';
import { Card } from '@/components/arc/card/card';
import { Progress } from '@/components/arc/progress/progress';
import { Stepper, type StepperStep } from '@/components/arc/stepper/stepper';
import { AGENT_STEPS, CLIENTS, type AgentStepKey, type AgentView } from '@/mock';
import { formatRelative, parseSymbolKey, useMediaQuery } from '@/shell';
import { STATE_LABEL } from './derive';
import styles from './overview.module.css';

const sentence = (text: string) => (text ? text[0].toUpperCase() + text.slice(1) : text);

/** Short names that fit under six markers side by side. The full label stays in the status line. */
const SHORT_LABEL: Record<AgentStepKey, string> = {
  registered: 'Registered',
  intent: 'Intent',
  working: 'Working',
  contract_pending: 'Agreement',
  implemented: 'Implemented',
  verified: 'Verified',
};

/** Minutes only, so the rolling status changes at most once a minute. */
function leaseText(expiresAt: number, now: number): string {
  const left = expiresAt - now;
  if (left <= 0) return 'lease expired';
  if (left < 60_000) return 'lease ends in under a minute';
  return `${Math.ceil(left / 60_000)} min left on lease`;
}

export function AgentCard({ agent, workspaceName, sessionName, now }: {
  agent: AgentView;
  workspaceName: string;
  sessionName: (id: string) => string;
  now: number;
}) {
  const { session, intent, progress, memberName, agentName } = agent;
  const client = CLIENTS.find(c => c.id === session.client)?.name ?? session.client ?? 'Unknown client';
  const verified = progress.key === 'verified';
  const conflict = agent.findings.find(f => f.severity === 'error');
  const others = conflict ? conflict.sessions.filter(id => id !== session.id).map(sessionName) : [];

  // Step names sit under the markers from 820 px; below that a single line says where the agent is.
  const wide = useMediaQuery('(min-width: 820px)');
  const inConflict = progress.key === 'contract_pending' && Boolean(conflict);
  const steps: StepperStep[] = AGENT_STEPS.map((step, index) => ({
    id: step.key,
    label: SHORT_LABEL[step.key],
    error: index === progress.step - 1 && inConflict ? 'Conflict' : undefined,
  }));

  const title = sentence(agentName);
  const position = `Step ${progress.step} of ${AGENT_STEPS.length}: ${progress.label.toLowerCase()}`;

  return (
    <Card
      className={styles.agentCard}
      title={title}
      description={intent?.task ?? 'No intent declared yet.'}
      avatar={<Avatar name={memberName} size="sm" />}
      meta={`${memberName} · ${client}`}
      status={`${workspaceName} · ${leaseText(session.expiresAt, now)}`}
      details={<AgentDetails agent={agent} client={client} workspaceName={workspaceName} now={now} />}
    >
      <div className={styles.agentSteps}>
        {wide ? (
          <Stepper
            steps={steps}
            current={verified ? AGENT_STEPS.length : progress.step - 1}
            label={`${title} progress`}
            completeLabel="Verified"
          />
        ) : (
          <Progress value={progress.step} max={AGENT_STEPS.length} label={position} />
        )}
        <p className={styles.stepStatus}>
          {wide && <span className={styles.stepPosition}>{position}. </span>}
          {progress.reason}
          {inConflict && <span className={styles.stepConflict}> In conflict with {others.join(' and ') || 'another agent'}.</span>}
        </p>
      </div>
    </Card>
  );
}

function AgentDetails({ agent, client, workspaceName, now }: { agent: AgentView; client: string; workspaceName: string; now: number }) {
  const { intent, progress, contracts, findings, session } = agent;
  return (
    <dl className={styles.facts}>
      <div>
        <dt>Step {progress.step} of {AGENT_STEPS.length}: {progress.label}</dt>
        <dd>{progress.reason}</dd>
      </div>
      <div>
        <dt>Intent</dt>
        <dd>{intent ? `Revision ${intent.revision}, declared ${formatRelative(intent.at, now)}.` : 'Not declared yet.'}</dd>
      </div>
      {intent && intent.files.length > 0 && (
        <div>
          <dt>Files</dt>
          <dd><ul className={styles.codeList}>{intent.files.map(f => <li key={f}><code>{f}</code></li>)}</ul></dd>
        </div>
      )}
      {intent && intent.symbols.length > 0 && (
        <div>
          <dt>Symbols</dt>
          <dd><ul className={styles.codeList}>{intent.symbols.map(s => { const p = parseSymbolKey(s); return <li key={s}><code>{p.name}</code> in <code>{p.file}</code></li>; })}</ul></dd>
        </div>
      )}
      {intent && intent.assumptions.length > 0 && (
        <div>
          <dt>Assumptions</dt>
          <dd><ul className={styles.codeList}>{intent.assumptions.map(a => <li key={a.key}><code>{a.key}</code> is <code>{a.value}</code></li>)}</ul></dd>
        </div>
      )}
      <div>
        <dt>Agreements</dt>
        <dd>{contracts.length ? contracts.map(c => `${c.title} (${STATE_LABEL[c.status].toLowerCase()})`).join(', ') : 'None yet.'}</dd>
      </div>
      <div>
        <dt>Findings</dt>
        <dd>{findings.length ? `${findings.length} involve this agent; ${findings.filter(f => f.severity !== 'info').length} need attention.` : 'None.'}</dd>
      </div>
      <div>
        <dt>Session</dt>
        <dd>{client} in {workspaceName}. <code>{session.id.slice(0, 8)}</code></dd>
      </div>
    </dl>
  );
}
