// A member: identity, role, status, the agents their tokens created, and the tokens themselves.
import { Avatar } from '@/components/arc/avatar/avatar';
import { Badge } from '@/components/arc/badge/badge';
import { formatDateTime, formatRelative } from '@/shell';
import { ROLE_LABEL } from '@/mock';
import { countAgents, type MemberRow } from './model';
import { TokenRow } from './TokenRow';
import styles from './members.module.css';

interface MemberSectionProps {
  row: MemberRow;
  isMe: boolean;
  manageable: boolean;
  offline: boolean;
  now: number;
  /** Shown when the member has no listed tokens because they signed in with the bootstrap token. */
  bootstrap?: boolean;
}

function statusText(row: MemberRow, now: number): string {
  if (row.status === 'no-access') return 'No active tokens';
  if (row.lastActiveAt === null) return 'Not active yet';
  return row.status === 'active' ? `Active ${formatRelative(row.lastActiveAt, now)}` : `Last active ${formatRelative(row.lastActiveAt, now)}`;
}

export function MemberSection({ row, isMe, manageable, offline, now, bootstrap = false }: MemberSectionProps) {
  const { member, tokens, agents } = row;
  const headingId = `member-${member.id}`;
  const active = row.status === 'active';

  return (
    <article className={styles.member} aria-labelledby={headingId}>
      <header className={styles.memberHeader}>
        <Avatar name={member.name} size="lg" status={active ? 'online' : undefined} />
        <div className={styles.identity}>
          <h2 id={headingId} className={styles.memberName}>
            {member.name}
            {isMe && <span className={styles.you}>You</span>}
          </h2>
          <p className={styles.memberMeta}>
            {member.email && <span>{member.email}</span>}
            <span title={formatDateTime(member.joinedAt)}>Joined {formatRelative(member.joinedAt, now)}</span>
          </p>
        </div>
        <div className={styles.memberSide}>
          <Badge>{ROLE_LABEL[member.role]}</Badge>
          <span className={[styles.status, active ? styles.statusActive : ''].join(' ')}>{statusText(row, now)}</span>
        </div>
      </header>

      <dl className={styles.facts}>
        <div className={styles.fact}>
          <dt>Agents</dt>
          <dd>{agents.length === 0 ? 'None yet' : `${countAgents(agents.length)}: ${agents.map(a => a.name).join(', ')}`}</dd>
        </div>
        <div className={styles.fact}>
          <dt>Active tokens</dt>
          <dd>{row.activeTokenCount}</dd>
        </div>
      </dl>

      <section className={styles.tokens} aria-label={`Tokens for ${member.name}`}>
        <h3 className={styles.tokensTitle}>Tokens</h3>
        {tokens.length > 0 ? (
          <ul className={styles.tokenList}>
            {tokens.map(token => (
              <TokenRow key={token.id} token={token} manageable={manageable} offline={offline} now={now} />
            ))}
          </ul>
        ) : (
          <p className={styles.noTokens}>
            {bootstrap
              ? 'You signed in with the admin token that created this workspace. It is never listed here.'
              : 'No tokens yet. Invite them again to generate one.'}
          </p>
        )}
      </section>
    </article>
  );
}
