// Top bar: wordmark, workspace, cloud link, connection status, demo switcher, theme, account.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Settings, Users } from 'lucide-react';
import { Badge } from '@/components/arc/badge/badge';
import { CopyButton } from '@/components/arc/copy-button/copy-button';
import { DropdownMenu } from '@/components/arc/dropdown-menu/dropdown-menu';
import { ThemeSwitch } from '@/components/arc/theme-switch/theme-switch';
import { UserMenu } from '@/components/arc/user-menu/user-menu';
import { ROLE_LABEL } from '@/mock';
import { SettingsDialog } from './SettingsDialog';
import { useLastPoll, useMock, type Theme } from './store';
import { usePrefersReducedMotion } from './useMediaQuery';
import styles from './AppShell.module.css';

function ConnectionBadge() {
  const { connection } = useMock();
  const { stale } = useLastPoll();
  if (connection === 'offline') return <Badge tone="danger" dot>Offline</Badge>;
  if (connection === 'stale' || stale) return <Badge tone="warning" dot>Delayed</Badge>;
  return <Badge tone="success" dot>Live</Badge>;
}

/** Dev-only switcher for demonstrating every required UI state. */
function DemoStateMenu() {
  const { setConnection, setModel, setDataset, signOut } = useMock();
  return (
    <DropdownMenu
      label="Demo state"
      items={[
        { label: 'Live connection', onSelect: () => setConnection('online') },
        { label: 'Updates delayed', onSelect: () => setConnection('stale') },
        { label: 'Offline', onSelect: () => setConnection('offline') },
        { label: 'Model available', onSelect: () => setModel('available'), separatorBefore: true },
        { label: 'Model unavailable', onSelect: () => setModel('unavailable') },
        { label: 'Model not configured', onSelect: () => setModel('not_configured') },
        { label: 'Billing scenario', onSelect: () => setDataset('scenario'), separatorBefore: true },
        { label: 'Empty workspace', onSelect: () => setDataset('empty') },
        { label: 'Sign out', onSelect: signOut, separatorBefore: true },
      ]}
    />
  );
}

const showDemoControls = () => import.meta.env.DEV || new URLSearchParams(window.location.search).has('demo');

export function Header() {
  const { workspace, theme, setTheme, me, signOut } = useMock();
  const navigate = useNavigate();
  const reduced = usePrefersReducedMotion();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const linkHost = workspace.cloudLink.replace(/^https:\/\//, '');

  const changeTheme = (next: Theme) => {
    const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
    if (!reduced && doc.startViewTransition) doc.startViewTransition(() => setTheme(next));
    else setTheme(next);
  };

  return (
    <header className={styles.header}>
      <div className={styles.brand}>
        <Link to="/" className={styles.wordmark}>Hive</Link>
        <span className={styles.slash} aria-hidden="true">/</span>
        <span className={styles.workspace}>{workspace.name}</span>
      </div>

      <div className={styles.cloud}>
        <span className={styles.cloudLabel}>Cloud link</span>
        <a className={styles.cloudLink} href={workspace.cloudLink} onClick={e => e.preventDefault()} title={workspace.cloudLink}>{linkHost}</a>
        <CopyButton value={workspace.cloudLink} label="Copy cloud link" iconOnly variant="plain" />
      </div>

      <div className={styles.tools}>
        <ConnectionBadge />
        {showDemoControls() && <div className={styles.demo}><DemoStateMenu /></div>}
        <ThemeSwitch theme={theme} iconOnly onThemeChange={changeTheme} />
        {me && (
          <UserMenu
            user={{ name: me.name, email: me.email || `${ROLE_LABEL[me.role]} in ${workspace.name}`, plan: ROLE_LABEL[me.role] }}
            showName
            showTheme={false}
            items={[
              { label: 'Members and tokens', icon: <Users size={16} />, onSelect: () => navigate('/members') },
              { label: 'Settings', icon: <Settings size={16} />, onSelect: () => setSettingsOpen(true) },
            ]}
            onSignOut={() => { signOut(); navigate('/signin'); }}
          />
        )}
      </div>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </header>
  );
}
