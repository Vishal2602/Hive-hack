// Shared pieces for the Connect flow.
import { useMemo, type ReactNode } from 'react';
import { CopyButton } from '@/components/arc/copy-button/copy-button';
import type { Role } from '@/mock';
import { useHive } from '@/shell';
import { inviteProgress, type ConnectClientId, type InviteProgress } from './logic';
import styles from './Connect.module.css';

/**
 * What step 3 follows. Either a token created in step 2 (`secret` is set, shown once, kept in component
 * state only) or, for members who cannot create tokens, their own signed-in token (`secret` is null).
 */
export interface Invite {
  secret: string | null;
  tokenId: string | null;
  memberName: string;
  role: Role;
  /** The token belongs to the signed-in person. */
  own: boolean;
  /** Sessions already registered with this token when the invite was made; they do not count as new. */
  baselineSessionIds: string[];
}

/** Live progress of an invite, recomputed on every poll. */
export function useInviteProgress(invite: Invite | null): InviteProgress {
  const { snapshot, tokenRecords, tokens, mode } = useHive();
  return useMemo(() => {
    if (!invite) return { sessionIds: [], clientSeenAt: null, registered: false, revoked: false };
    const record = tokenRecords.find(t => t.id === invite.tokenId)
      ?? (mode === 'mock' ? tokens.find(t => t.id === invite.tokenId) ?? null : null);
    const extra = mode === 'mock' ? tokens.find(t => t.id === invite.tokenId)?.agentSessionIds ?? [] : [];
    return inviteProgress({
      tokenId: invite.tokenId, baselineSessionIds: invite.baselineSessionIds, sessions: snapshot.sessions,
      record: record ? { id: record.id, lastUsedAt: record.lastUsedAt, revokedAt: record.revokedAt } : null,
      newToken: invite.secret !== null, extraSessionIds: extra,
    });
  }, [invite, snapshot.sessions, tokenRecords, tokens, mode]);
}

/** Where each client's snippet goes, in one sentence. `name` is null when the token is for the signed-in person. */
export function whereToPaste(client: ConnectClientId, name: string | null): string {
  const self = name === null;
  switch (client) {
    case 'claude-code':
      return self
        ? 'Run this once in a terminal, inside the repository folder you work in. Claude Code picks Hive up on its next start.'
        : `${name} runs this once in a terminal, inside the repository folder they work in. Claude Code picks Hive up on its next start.`;
    case 'muse-code':
      return self
        ? 'Add this block to the MCP servers section of your Muse Code configuration, then reconnect.'
        : `${name} adds this block to the MCP servers section of their Muse Code configuration, then reconnects.`;
    default:
      return `${self ? 'Point' : `${name} points`} any MCP client that supports streamable HTTP with request headers at this URL, sending this header on every request.`;
  }
}

export function CopyRow({ value, label, large = false, children }: { value: string; label: string; large?: boolean; children?: ReactNode }) {
  return (
    <div className={styles.valueRow}>
      <span className={[styles.value, large ? styles.valueLarge : ''].join(' ')}>{children ?? value}</span>
      <CopyButton value={value} label={label} />
    </div>
  );
}

export function StatusDot({ tone }: { tone: 'success' | 'warning' | 'danger' | 'neutral' }) {
  return <span className={styles.dot} data-tone={tone} aria-hidden="true" />;
}
