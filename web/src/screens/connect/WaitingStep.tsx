// Step 3: a live checklist that follows the new token until its first agent registers.
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Hourglass } from 'lucide-react';
import { Alert } from '@/components/arc/alert/alert';
import { Button } from '@/components/arc/button/button';
import { EmptyState } from '@/components/arc/empty-state/empty-state';
import { Stepper, type StepperStep } from '@/components/arc/stepper/stepper';
import { CLIENTS, type ClientId } from '@/mock';
import { formatClock, useLastPoll, useMock } from '@/shell';
import { showDemoControls, type Invite } from './shared';
import styles from './Connect.module.css';

interface WaitingStepProps {
  invite: Invite | null;
  client: ClientId;
  onGoToInvite: () => void;
  onInviteAnother: () => void;
}

/** Delay between the simulated client handshake and the agent registering, so each row visibly ticks. */
const SIMULATED_REGISTER_DELAY_MS = 1400;

export function WaitingStep({ invite, client, onGoToInvite, onInviteAnother }: WaitingStepProps) {
  const { tokens, connection, registerAgent, sessionName, me } = useMock();
  const { lastPollAt } = useLastPoll();
  const navigate = useNavigate();
  const [handshakeAt, setHandshakeAt] = useState<number | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);

  if (!invite) {
    return (
      <div className={styles.panel}>
        <EmptyState
          icon={<Hourglass size={20} />}
          title="Nothing to wait for yet"
          description="Generate a token on the invite step first. This page then follows the first agent that uses it."
          action={<Button onClick={onGoToInvite}>Create a token</Button>}
        />
      </div>
    );
  }

  const token = tokens.find(t => t.id === invite.tokenId);
  const clientName = CLIENTS.find(c => c.id === client)?.name ?? 'MCP client';
  const offline = connection === 'offline';
  const firstSessionId = token?.agentSessionIds[0];
  const agentName = firstSessionId ? sessionName(firstSessionId) : null;
  const clientSeenAt = token?.lastUsedAt ?? handshakeAt;
  const revoked = Boolean(token?.revokedAt);
  const isSelf = invite.memberName === me?.name;
  const possessive = isSelf ? 'your' : `${invite.memberName}'s`;

  const reachable = !offline;
  const clientDone = reachable && clientSeenAt !== null;
  const agentDone = clientDone && Boolean(agentName);
  const current = !reachable ? 0 : !clientDone ? 1 : !agentDone ? 2 : 3;

  const steps: StepperStep[] = [
    {
      id: 'server',
      label: 'Server reachable',
      description: reachable ? `Hive answered at ${formatClock(lastPollAt)}.` : 'Checking the cloud link.',
      error: offline ? 'Hive is not answering on its cloud link. Waiting resumes when it is back.' : undefined,
    },
    {
      id: 'client',
      label: `${clientName} configured`,
      description: clientDone && clientSeenAt !== null
        ? `The token was first used at ${formatClock(clientSeenAt)}.`
        : `Ticks the first time ${clientName} uses the new token.`,
    },
    {
      id: 'agent',
      label: 'First agent registered',
      description: agentDone && agentName ? `${agentName} registered.` : 'Ticks when an agent registers and starts its lease.',
    },
  ];

  function simulate() {
    if (offline || timer.current !== null || !token) return;
    setHandshakeAt(Date.now());
    const agent = `${clientName} agent`;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      registerAgent(token.id, agent, client);
    }, SIMULATED_REGISTER_DELAY_MS);
  }

  return (
    <div className={styles.panel}>
      <div className={styles.waitHead}>
        <h2 className={styles.waitTitle}>
          {agentDone ? `${isSelf ? 'Your' : `${invite.memberName}'s`} agent is connected` : `Waiting for ${possessive} agent`}
        </h2>
        {!agentDone && !revoked && (
          <p className={styles.live} role="status">
            {!offline && <span className={styles.pulse} aria-hidden="true" />}
            {offline ? 'Paused while Hive is unreachable.' : 'This page updates on its own. You can leave it open while they set up.'}
          </p>
        )}
      </div>

      {revoked ? (
        <Alert tone="danger" title="This token was revoked">
          No agent can register with it. Create a new token to try again.
        </Alert>
      ) : (
        <Stepper
          orientation="vertical"
          steps={steps}
          current={current}
          label={`Connection checklist for ${possessive} agent`}
          completeLabel="Agent connected"
        />
      )}

      {agentDone && (
        <Alert tone="success" title={`${agentName ?? 'The agent'} is on the overview`}>
          Its intent, progress and lease show up there. Hive starts checking its work against everyone else's from now on.
        </Alert>
      )}

      {!agentDone && !revoked && showDemoControls() && (
        <div className={styles.devBox}>
          <div className={styles.devText}>
            <span className={styles.devTitle}>Prototype only</span>
            <span className={styles.muted}>Pretends the client uses the token, then registers an agent a moment later.</span>
          </div>
          <Button variant="secondary" size="sm" onClick={simulate} disabled={offline || handshakeAt !== null}>
            Simulate agent registering
          </Button>
        </div>
      )}

      <div className={styles.actions}>
        {!revoked ? <Button variant="ghost" onClick={onInviteAnother}>{me?.role === 'admin' ? 'Invite someone else' : 'Create another token'}</Button> : <span />}
        <div className={styles.actionsEnd}>
          {revoked
            ? <Button onClick={onInviteAnother}>Create a new token</Button>
            : <Button variant={agentDone ? 'primary' : 'secondary'} onClick={() => navigate('/')}>Go to overview</Button>}
        </div>
      </div>
    </div>
  );
}
