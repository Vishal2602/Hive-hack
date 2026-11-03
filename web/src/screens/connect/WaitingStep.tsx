// Step 3: a live checklist that follows the token until an agent registers with it. Live data only: the store
// polls /snapshot every 2 s, and a session whose tokenId equals the followed token ticks the last step.
// The simulate control exists only with ?mock=1 (prototype data).
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Hourglass } from 'lucide-react';
import { Alert } from '@/components/arc/alert/alert';
import { Button } from '@/components/arc/button/button';
import { EmptyState } from '@/components/arc/empty-state/empty-state';
import { Stepper, type StepperStep } from '@/components/arc/stepper/stepper';
import { formatClock, useHive, useLastPoll } from '@/shell';
import { clientById, type ConnectClientId } from './logic';
import { useInviteProgress, type Invite } from './shared';
import styles from './Connect.module.css';

interface WaitingStepProps {
  invite: Invite | null;
  client: ConnectClientId;
  onGoToInvite: () => void;
  onInviteAnother: () => void;
}

/** Admins refresh token metadata (last used, revoked) this often while waiting, instead of every 10 s. */
const ACCESS_REFRESH_WHILE_WAITING_MS = 4000;
/** Delay between the simulated client handshake and the agent registering, so each row visibly ticks. */
const SIMULATED_REGISTER_DELAY_MS = 1400;

export function WaitingStep({ invite, client, onGoToInvite, onInviteAnother }: WaitingStepProps) {
  const { connection, registerAgent, sessionName, me, mode, canSimulateAgents, refresh } = useHive();
  const { lastPollAt } = useLastPoll();
  const navigate = useNavigate();
  const progress = useInviteProgress(invite);
  const [handshakeAt, setHandshakeAt] = useState<number | null>(null);
  const timer = useRef<number | null>(null);
  const isAdmin = me?.role === 'admin';
  const waiting = Boolean(invite) && !progress.registered && !progress.revoked;

  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);

  useEffect(() => {
    if (mode !== 'live' || !isAdmin || !waiting) return;
    void refresh({ access: true });
    const id = window.setInterval(() => { void refresh({ access: true }); }, ACCESS_REFRESH_WHILE_WAITING_MS);
    return () => window.clearInterval(id);
  }, [mode, isAdmin, waiting, refresh]);

  if (!invite) {
    return (
      <div className={styles.panel}>
        <EmptyState
          icon={<Hourglass size={20} />}
          title="Nothing to wait for yet"
          description="Set up a token on the previous step first. This page then follows the first agent that uses it."
          action={<Button onClick={onGoToInvite}>Go to the token step</Button>}
        />
      </div>
    );
  }

  const clientName = clientById(client).name;
  const offline = connection === 'offline';
  const firstSessionId = progress.sessionIds[0];
  const agentName = firstSessionId ? sessionName(firstSessionId) : null;
  const clientSeenAt = progress.clientSeenAt ?? handshakeAt;
  const self = invite.own;
  const possessive = self ? 'your' : `${invite.memberName}'s`;
  const untracked = invite.tokenId === null;

  const reachable = !offline;
  const agentDone = reachable && progress.registered;
  // A new token's first use is visible to admins (token_list lastUsedAt). Your own token is used by this page
  // too, so for it the client row ticks together with the agent.
  const clientDone = reachable && (agentDone || (invite.secret !== null && clientSeenAt !== null));
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
      description: clientDone && clientSeenAt !== null && invite.secret !== null
        ? `The token was first used at ${formatClock(clientSeenAt)}.`
        : clientDone
          ? `${clientName} reached Hive with the token.`
          : invite.secret !== null
            ? `Ticks the first time ${clientName} uses the new token.`
            : `Ticks when ${clientName} registers an agent, since this page also uses your token.`,
    },
    {
      id: 'agent',
      label: 'First agent registered',
      description: agentDone && agentName ? `${agentName} registered.` : 'Ticks when an agent registers with this token and starts its lease.',
    },
  ];

  function simulate() {
    if (offline || timer.current !== null || !invite?.tokenId) return;
    const tokenId = invite.tokenId;
    setHandshakeAt(Date.now());
    timer.current = window.setTimeout(() => {
      timer.current = null;
      registerAgent(tokenId, `${clientName} agent`, client);
    }, SIMULATED_REGISTER_DELAY_MS);
  }

  return (
    <div className={styles.panel}>
      <div className={styles.waitHead}>
        <h2 className={styles.waitTitle}>
          {agentDone ? `${self ? 'Your' : `${invite.memberName}'s`} agent is connected` : `Waiting for ${possessive} agent`}
        </h2>
        {!agentDone && !progress.revoked && (
          <p className={styles.live} role="status">
            {!offline && <span className={styles.pulse} aria-hidden="true" />}
            {offline ? 'Paused while Hive is unreachable.' : 'This page updates on its own. You can leave it open while they set up.'}
          </p>
        )}
      </div>

      {untracked && (
        <Alert tone="info" title="This token cannot be followed">
          You are signed in with the operator token, which has no token record. Agents using it still appear on the overview.
        </Alert>
      )}

      {progress.revoked ? (
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

      {!agentDone && !progress.revoked && canSimulateAgents && mode === 'mock' && invite.tokenId && (
        <div className={styles.devBox}>
          <div className={styles.devText}>
            <span className={styles.devTitle}>Prototype data</span>
            <span className={styles.muted}>Pretends the client uses the token, then registers an agent a moment later.</span>
          </div>
          <Button variant="secondary" size="sm" onClick={simulate} disabled={offline || handshakeAt !== null}>
            Simulate agent registering
          </Button>
        </div>
      )}

      <div className={styles.actions}>
        {!progress.revoked ? <Button variant="ghost" onClick={onInviteAnother}>{isAdmin ? 'Invite someone else' : 'Start over'}</Button> : <span />}
        <div className={styles.actionsEnd}>
          {progress.revoked
            ? <Button onClick={onInviteAnother}>Create a new token</Button>
            : <Button variant={agentDone ? 'primary' : 'secondary'} onClick={() => navigate('/')}>Go to overview</Button>}
        </div>
      </div>
    </div>
  );
}
