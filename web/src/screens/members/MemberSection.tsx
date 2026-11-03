// A member: name, role, last activity, the agents their tokens registered, and the tokens themselves.
import { Avatar } from '@/components/arc/avatar/avatar';
import { Badge } from '@/components/arc/badge/badge';
import { formatDateTime, formatRelative } from '@/shell';
import { ROLE_LABEL } from '@/mock';
import type { MemberRow } from './access';
import { clientName } from './model';
import { TokenRow } from './TokenRow';
import styles from './members.module.css';

interface MemberSectionProps {
  row: MemberRow;
  manageable: boolean;
  offline: boolean;
  now: number;
}

function statusText(row: MemberRow, now: number): string {
  if (row.isMe) return 'Signed in now';
  if (row.status === 'no-access') return 'No active tokens';
  if (row.lastActiveAt === null) return 'Not active yet';
  return row.status === 'active' ? `Active ${formatRelative(row.lastActiveAt, now)}` : `Last active ${formatRelative(row.lastActiveAt, now)}`;
}

function emptyTokensText(row: MemberRow): string {
  if (row.bootstrap) return 'You signed in with the admin token this workspace was started with. It is never listed or shown here.';
  if (row.name === 'operator') return 'Agents started with the workspace admin token. That token is never listed or shown here.';
  return 'No tokens listed. Invite them again to generate one.';
}

export function MemberSection({ row, manageable, offline, now }: MemberSectionProps) {
  const headingId = `member-${row.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  const active = row.status === 'active';

  return (
    <article className={styles.member} aria-labelledby={headingId}>
      <header className={styles.memberHeader}>
        <Avatar name={row.name} size="lg" status={active ? 'online' : undefined} />
        <div className={styles.identity}>
          <h2 id={headingId} className={styles.memberName}>
            {row.name}
            {row.isMe && <span className={styles.you}>You</span>}
          </h2>
          <p className={styles.memberMeta}>
            {row.joinedAt !== null && <span title={formatDateTime(row.joinedAt)}>First token {formatRelative(row.joinedAt, now)}</span>}
            {row.bootstrap && <span>Workspace admin token</span>}
          </p>
        </div>
        <div className={styles.memberSide}>
          <Badge>{ROLE_LABEL[row.role]}</Badge>
          <span className={[styles.status, active ? styles.statusActive : ''].join(' ')}>{statusText(row, now)}</span>
        </div>
      </header>

      <dl className={styles.facts}>
        <div className={styles.fact}>
          <dt>Agents connected</dt>
          <dd>
            {row.agents.length === 0 ? 'None right now' : (
              <ul className={styles.agentList}>
                {row.agents.map(agent => (
                  <li key={agent.id}>
                    <span className={styles.agentName}>{agent.name}</span>
                    <span className={styles.agentClient}>{clientName(agent.client)}</span>
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
        <div className={styles.fact}>
          <dt>Active tokens</dt>
          <dd>{row.bootstrap && row.activeTokenCount === 0 ? 'Admin token' : row.activeTokenCount}</dd>
        </div>
      </dl>

      <section className={styles.tokens} aria-label={`Tokens for ${row.name}`}>
        <h3 className={styles.tokensTitle}>Tokens</h3>
        {row.tokens.length > 0 ? (
          <ul className={styles.tokenList}>
            {row.tokens.map(token => (
              <TokenRow key={token.id} token={token} manageable={manageable} offline={offline} now={now} />
            ))}
          </ul>
        ) : (
          <p className={styles.noTokens}>{emptyTokensText(row)}</p>
        )}
      </section>
    </article>
  );
}
