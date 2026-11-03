// One access token: label, safe prefix, dates, the agents it registered, and rename / revoke for admins.
// Labels, member and agent names come from people and agents: rendered as text only.
import { KeyRound } from 'lucide-react';
import { ConfirmMorph } from '@/components/arc/confirm-morph/confirm-morph';
import { InlineEdit } from '@/components/arc/inline-edit/inline-edit';
import { useToastStack } from '@/components/arc/toast-stack/toast-stack';
import { formatDateTime, formatRelative } from '@/shell';
import { countAgents, validateLabel, type TokenView } from './access';
import { useTokenActions } from './model';
import styles from './members.module.css';

interface TokenRowProps {
  token: TokenView;
  manageable: boolean;
  offline: boolean;
  now: number;
}

const errorText = (error: unknown) => (error instanceof Error && error.message ? error.message : 'Hive did not accept the change.');

export function TokenRow({ token, manageable, offline, now }: TokenRowProps) {
  const { revoke, rename } = useTokenActions();
  const { toast } = useToastStack();
  const revoked = token.revokedAt !== null;
  const editable = manageable && !revoked && !offline;

  const confirmRevoke = async () => {
    try {
      await revoke(token.id);
    } catch (error) {
      toast({ type: 'error', title: `Could not revoke ${token.label}`, description: errorText(error) });
      throw error;
    }
    toast({
      type: 'success',
      title: `Revoked ${token.label}`,
      description: token.current
        ? 'This was your sign-in token. You will be signed out on the next refresh.'
        : token.agents.length
          ? `${countAgents(token.agents.length)} using it lose access on their next request.`
          : 'It can no longer be used to connect an agent or sign in.',
    });
  };

  const saveLabel = async (next: string) => {
    try {
      await rename(token.id, next);
    } catch (error) {
      toast({ type: 'error', title: 'Could not rename the token', description: errorText(error) });
      throw error;
    }
  };

  return (
    <li className={[styles.token, revoked ? styles.tokenRevoked : ''].join(' ')}>
      <span className={styles.tokenIcon} aria-hidden="true"><KeyRound size={16} strokeWidth={1.75} /></span>

      <div className={styles.tokenMain}>
        <div className={styles.tokenTitle}>
          {editable ? (
            <InlineEdit
              value={token.label}
              label={`Token label for ${token.label}`}
              variant="body"
              as="span"
              validate={validateLabel}
              onSave={saveLabel}
            />
          ) : (
            <span className={styles.tokenLabel}>{token.label}</span>
          )}
          {token.current && <span className={styles.current}>Signed in here</span>}
        </div>

        <p className={styles.tokenMeta}>
          {token.prefix && (
            <code className={styles.prefix} title="Only this prefix is kept. The full token was shown once.">{token.prefix}…</code>
          )}
          {token.createdAt !== null && (
            <span title={formatDateTime(token.createdAt)}>Created {formatRelative(token.createdAt, now)}</span>
          )}
          {revoked ? (
            <span title={formatDateTime(token.revokedAt!)}>Revoked {formatRelative(token.revokedAt!, now)}</span>
          ) : !token.detailsKnown ? (
            <span>In use now</span>
          ) : (
            <span title={token.lastUsedAt !== null ? formatDateTime(token.lastUsedAt) : undefined}>
              {token.lastUsedAt !== null ? `Last used ${formatRelative(token.lastUsedAt, now)}` : 'Not used yet'}
            </span>
          )}
        </p>

        <p className={styles.tokenAgents}>
          {token.agents.length === 0
            ? revoked ? 'No agents connected with it.' : 'No agents connected with this token right now.'
            : `${countAgents(token.agents.length)} connected: ${token.agents.map(a => a.name).join(', ')}.`}
        </p>
      </div>

      {manageable && !revoked && (
        <div className={styles.tokenAction}>
          <ConfirmMorph
            label="Revoke"
            prompt={token.current ? 'Revoke your own sign-in token?' : `Revoke ${token.label}?`}
            confirmLabel="Hold to revoke"
            pendingLabel="Revoking"
            doneLabel="Revoked"
            errorLabel="Not revoked"
            confirmMode="hold"
            disabled={offline}
            onConfirm={confirmRevoke}
          />
        </div>
      )}
    </li>
  );
}
