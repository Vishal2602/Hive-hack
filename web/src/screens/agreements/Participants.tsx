// Participants of an agreement with their exact-version signature mark.
import { Check, CircleDashed, History } from 'lucide-react';
import { Avatar } from '@/components/arc/avatar/avatar';
import { formatClock, formatRelative } from '@/shell';
import type { Contract } from '@/mock';
import { signatureFor, signatureText, type Signature } from './model';
import styles from './agreements.module.css';

export const personOf = (sessionName: string) => sessionName.split(' · ')[0] ?? sessionName;

export function SignatureMark({ sig }: { sig: Signature }) {
  const Icon = sig.kind === 'signed' ? Check : sig.kind === 'outdated' ? History : CircleDashed;
  return (
    <span className={styles.mark} data-kind={sig.kind}>
      <Icon aria-hidden="true" size={14} strokeWidth={2.25} />
      {signatureText(sig)}
    </span>
  );
}

export function ParticipantList({ contract, sessionName }: { contract: Contract; sessionName: (id: string) => string }) {
  return (
    <ul className={styles.participants} aria-label="Participants">
      {contract.participants.map(id => {
        const name = sessionName(id);
        return (
          <li key={id} className={styles.participant}>
            <Avatar name={personOf(name)} size="sm" aria-hidden="true" />
            <span className={styles.participantName}>{name}</span>
            <SignatureMark sig={signatureFor(contract, id)} />
          </li>
        );
      })}
    </ul>
  );
}

/** Phone layout for the signatures section: one labelled block per participant instead of a table. */
export function SignatureList({ contract, sessionName, now }: { contract: Contract; sessionName: (id: string) => string; now: number }) {
  if (contract.participants.length === 0) return <p className={styles.muted}>This agreement has no participants.</p>;
  return (
    <ul className={styles.sigList} aria-label={`Signatures on version ${contract.version}`}>
      {contract.participants.map(id => {
        const name = sessionName(id);
        const sig = signatureFor(contract, id);
        return (
          <li key={id} className={styles.sigItem}>
            <div className={styles.sigWho}>
              <Avatar name={personOf(name)} size="sm" aria-hidden="true" />
              <span className={styles.participantName}>{name}</span>
            </div>
            <dl className={styles.sigFacts}>
              <div>
                <dt>Role</dt>
                <dd>{id === contract.ownerSessionId ? 'Owner' : 'Participant'}</dd>
              </div>
              <div>
                <dt>Signature on v{contract.version}</dt>
                <dd><SignatureMark sig={sig} /></dd>
              </div>
              <div>
                <dt>Signed</dt>
                <dd>{sig.kind === 'pending' ? <span className={styles.muted}>Not yet</span> : <span title={formatClock(sig.at)}>{formatRelative(sig.at, now)}</span>}</dd>
              </div>
            </dl>
          </li>
        );
      })}
    </ul>
  );
}
