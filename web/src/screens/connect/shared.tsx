// Shared pieces for the Connect flow.
import type { ReactNode } from 'react';
import { CopyButton } from '@/components/arc/copy-button/copy-button';
import type { ClientId, Role } from '@/mock';
import styles from './Connect.module.css';

/** The token generated in step 2. The secret lives in component state only and is gone when the page unmounts. */
export interface Invite {
  secret: string;
  tokenId: string;
  memberName: string;
  role: Role;
}

export interface ConnectChoices {
  client: ClientId;
}

export const showDemoControls = () => import.meta.env.DEV || new URLSearchParams(window.location.search).has('demo');

/** Where each client's snippet goes, in one sentence. `name` is null when the token is for the signed-in person. */
export function whereToPaste(client: ClientId, name: string | null): string {
  const self = name === null;
  switch (client) {
    case 'claude-code':
      return self
        ? 'Run this once in a terminal, inside the repository folder you work in. Claude Code picks Hive up on its next start.'
        : `${name} runs this once in a terminal, inside the repository folder they work in. Claude Code picks Hive up on its next start.`;
    case 'muse-code':
      return self
        ? 'Open Muse Code settings, find MCP servers and paste this block. Muse Code reconnects on save.'
        : `${name} opens Muse Code settings, finds MCP servers and pastes this block. Muse Code reconnects on save.`;
    default:
      return `${self ? 'Add' : `${name} adds`} this to the client's MCP configuration, usually mcp.json. The client needs streamable HTTP with request headers.`;
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
