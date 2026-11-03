// /connect: invite a teammate in three steps. Workspace, then a personal token and client config, then a live
// checklist that ticks when their first agent registers.
import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion, type HTMLMotionProps } from 'motion/react';
import { Lock } from 'lucide-react';
import { Button } from '@/components/arc/button/button';
import { EmptyState } from '@/components/arc/empty-state/empty-state';
import { motionTokens } from '@/components/arc/lib/motion-tokens';
import { Stepper } from '@/components/arc/stepper/stepper';
import { Page, useHive } from '@/shell';
import { InviteStep } from './connect/InviteStep';
import { WaitingStep } from './connect/WaitingStep';
import { WorkspaceStep } from './connect/WorkspaceStep';
import type { ConnectClientId } from './connect/logic';
import { useInviteProgress, type Invite } from './connect/shared';
import styles from './connect/Connect.module.css';

type Step = 0 | 1 | 2;

export default function Connect() {
  const { me } = useHive();
  const reduced = useReducedMotion() ?? false;
  const [step, setStep] = useState<Step>(0);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [client, setClient] = useState<ConnectClientId>('claude-code');

  const isAdmin = me?.role === 'admin';
  const isViewer = me?.role === 'viewer';
  const { registered } = useInviteProgress(invite);

  const steps = [
    { id: 'workspace', label: 'Workspace', description: 'Check the cloud link' },
    { id: 'invite', label: isAdmin ? 'Invite' : 'Your client', description: 'Token and client setup' },
    { id: 'waiting', label: 'First agent', description: 'Wait for it to register' },
  ];
  const current = step === 2 && registered ? 3 : step;

  function startOver() {
    setInvite(null);
    setStep(1);
  }

  const title = isAdmin ? 'Invite a teammate' : 'Connect an agent';
  const description = isAdmin
    ? 'Share the cloud link and a personal token. Their agent appears here the moment it registers, wherever they are working from.'
    : 'Point your own coding agent at this workspace with the ready-made config for your client.';

  if (isViewer) {
    return (
      <Page title="Connect an agent" width="narrow">
        <div className={styles.panel}>
          <EmptyState
            icon={<Lock size={20} />}
            title="Viewers cannot connect agents"
            description="Your token lets you read this workspace. Ask an admin for a member token if you want your agent to join."
          />
        </div>
      </Page>
    );
  }

  const enterEase = [...motionTokens.ease.enter] as [number, number, number, number];
  const exitEase = [...motionTokens.ease.exit] as [number, number, number, number];
  const motionProps: HTMLMotionProps<'div'> = reduced
    ? { initial: false, animate: { opacity: 1 }, exit: { opacity: 0, transition: { duration: 0 } } }
    : {
        initial: { opacity: 0, y: 8 },
        animate: { opacity: 1, y: 0, transition: { duration: motionTokens.duration.standard, ease: enterEase } },
        exit: { opacity: 0, y: -4, transition: { duration: motionTokens.duration.exit, ease: exitEase } },
      };

  return (
    <Page title={title} description={description} width="narrow">
      <div className={styles.flow}>
        <Stepper
          steps={steps}
          current={current}
          onStepSelect={(index) => setStep(index as Step)}
          details="current"
          label="Invite progress"
          completeLabel="Agent connected"
        />
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={step} {...motionProps}>
            {step === 0 && <WorkspaceStep canInvite={isAdmin} onContinue={() => setStep(1)} />}
            {step === 1 && (
              <InviteStep
                invite={invite}
                client={client}
                onClientChange={setClient}
                onCreated={setInvite}
                onStartOver={startOver}
                onBack={() => setStep(0)}
                onContinue={() => setStep(2)}
              />
            )}
            {step === 2 && (
              <WaitingStep invite={invite} client={client} onGoToInvite={() => setStep(1)} onInviteAnother={startOver} />
            )}
          </motion.div>
        </AnimatePresence>
        {step === 0 && invite && (
          <p className={styles.muted}>
            {invite.secret !== null ? `You have an unsent token for ${invite.memberName}. ` : 'Your client setup is still open. '}
            <Button variant="ghost" size="sm" onClick={() => setStep(1)}>Return to it</Button>
          </p>
        )}
      </div>
    </Page>
  );
}
