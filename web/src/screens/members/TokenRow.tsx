// One access token: label, safe prefix, client, dates, agents it created, and revoke for those allowed to.
import { KeyRound } from 'lucide-react';
import { ConfirmMorph } from '@/components/arc/confirm-morph/confirm-morph';
import { InlineEdit } from '@/components/arc/inline-edit/inline-edit';
import { useToastStack } from '@/components/arc/toast-stack/toast-stack';
import { formatDateTime, formatRelative, useMock } from '@/shell';
import type { AccessToken } from '@/mock';
import { agentRefs, clientName, countAgents } from './model';
import styles from './members.module.css';

interface TokenRowProps {
  token: AccessToken;
  manageable: boolean;
  offline: boolean;
  now: number;
}

const wait = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms));

export function TokenRow({ token, manageable, offline, now }: TokenRowProps) {
  const { revokeToken, renameToken, sessionName } = useMock();
  const { toast } = useToastStack();
  const revoked = token.revokedAt !== null;
  const agents = agentRefs(token.agentSessionIds, sessionName);

  const revoke = async () => {
    // Give the in-place "Revoking" face a moment before the row changes to its revoked state.
    await wait(600);
    revokeToken(token.id);
    toast({
      type: 'success',
      title: `Revoked ${token.label}`,
      description: agents.length
        ? `${countAgents(agents.length)} using it lose access on their next request.`
        : 'It can no longer be used to connect an agent.',
    });
  };

  return (
    <li className={[styles.token, revoked ? styles.tokenRevoked : ''].join(' ')}>
      <span className={styles.tokenIcon} aria-hidden="true"><KeyRound size={16} strokeWidth={1.75} /></span>

      <div className={styles.tokenMain}>
        <div className={styles.tokenTitle}>
          {manageable && !revoked && !offline ? (
            <InlineEdit
              value={token.label}
              label={`Token label for ${token.label}`}
              variant="body"
              as="span"
              validate={next => (next.trim() ? (next.trim().length > 48 ? 'Keep the label under 48 characters.' : null) : 'Give the token a label.')}
              onSave={next => renameToken(token.id, next)}
            />
          ) : (
            <span className={styles.tokenLabel}>{token.label}</span>
          )}
        </div>

        <p className={styles.tokenMeta}>
          <code className={styles.prefix} title="Only this prefix is kept. The full token was shown once.">{token.prefix}…</code>
          <span>{clientName(token.client)}</span>
          <span>Created {formatRelative(token.createdAt, now)}</span>
          {revoked ? (
            <span title={formatDateTime(token.revokedAt!)}>Revoked {formatRelative(token.revokedAt!, now)}</span>
          ) : (
            <span title={token.lastUsedAt ? formatDateTime(token.lastUsedAt) : undefined}>
              {token.lastUsedAt ? `Last used ${formatRelative(token.lastUsedAt, now)}` : 'Not used yet'}
            </span>
          )}
        </p>

        <p className={styles.tokenAgents}>
          {agents.length === 0
            ? 'No agents created with this token.'
            : `Created ${countAgents(agents.length)}: ${agents.map(a => a.name).join(', ')}.`}
        </p>
      </div>

      {manageable && !revoked && (
        <div className={styles.tokenAction}>
          <ConfirmMorph
            label="Revoke"
            prompt={`Revoke ${token.label}?`}
            confirmLabel="Hold to revoke"
            pendingLabel="Revoking"
            doneLabel="Revoked"
            confirmMode="hold"
            disabled={offline}
            onConfirm={revoke}
          />
        </div>
      )}
    </li>
  );
}
