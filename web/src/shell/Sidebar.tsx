// Linear-style navigation. Desktop (>= 1024px): a 240px sidebar that collapses to a 56px icon rail
// ("[" or the footer button; remembered in localStorage). Below 1024px: a top bar with a menu sheet.
// Shortcuts: "g" then o/c/a/t/m jumps to Overview/Connect/Agreements/Activity/Members.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import * as SheetPrimitive from '@radix-ui/react-dialog';
import { Settings, Users } from 'lucide-react';
import { CopyButton } from '@/components/arc/copy-button/copy-button';
import { DropdownMenu } from '@/components/arc/dropdown-menu/dropdown-menu';
import { ThemeSwitch } from '@/components/arc/theme-switch/theme-switch';
import { Tooltip } from '@/components/arc/tooltip/tooltip';
import { UserMenu } from '@/components/arc/user-menu/user-menu';
import { ROLE_LABEL } from '@/mock';
import { ActivityIcon, AgreementsIcon, CloseIcon, ConnectIcon, HiveMark, MembersIcon, MenuIcon, OverviewIcon, PanelLeftIcon } from './icons';
import { SECTIONS, sectionForPath, type Section } from './sections';
import { SettingsDialog } from './SettingsDialog';
import { useHive, useNow, useVisibleAccess, type Theme } from './store';
import { usePrefersReducedMotion } from './useMediaQuery';
import styles from './Sidebar.module.css';

const COLLAPSED_KEY = 'hive.sidebar.collapsed';
const ICONS: Record<Section['id'], (props: { size?: number }) => ReactNode> = {
  overview: OverviewIcon, connect: ConnectIcon, agreements: AgreementsIcon, activity: ActivityIcon, members: MembersIcon,
};

/** Collapsed state of the desktop sidebar, persisted per browser. */
export function useSidebarCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => {
    try { return window.localStorage.getItem(COLLAPSED_KEY) === '1'; } catch { return false; }
  });
  const toggle = useCallback(() => setCollapsed(value => {
    const next = !value;
    try { window.localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0'); } catch { /* per-tab only */ }
    return next;
  }), []);
  return [collapsed, toggle];
}

const isTypingTarget = (target: EventTarget | null) => target instanceof HTMLElement
  && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

/** Global keyboard shortcuts: g o / g c / g a / g t / g m, and "[" to collapse (when onToggle is given). */
export function useNavShortcuts(onToggle?: () => void) {
  const navigate = useNavigate();
  useEffect(() => {
    let armedAt = 0;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (armedAt && Date.now() - armedAt < 1500) {
        armedAt = 0;
        const section = SECTIONS.find(s => s.key === key);
        if (section) { event.preventDefault(); navigate(section.path); }
        return;
      }
      armedAt = 0;
      if (key === 'g' && !event.shiftKey) { armedAt = Date.now(); return; }
      if (event.key === '[' && onToggle) { event.preventDefault(); onToggle(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, onToggle]);
}

/** Live counts beside each item. Connect has none. */
function useCounts(): Partial<Record<Section['id'], number>> {
  const { snapshot, events } = useHive();
  const { members } = useVisibleAccess();
  return useMemo(() => ({
    overview: snapshot.sessions.length,
    agreements: snapshot.contracts.filter(c => c.status !== 'rejected' && c.status !== 'cancelled').length,
    activity: events.length,
    members: members.length,
  }), [snapshot, events, members]);
}

const countLabel: Record<Section['id'], (n: number) => string> = {
  overview: n => `${n} active agent${n === 1 ? '' : 's'}`,
  connect: () => '',
  agreements: n => `${n} agreement${n === 1 ? '' : 's'}`,
  activity: n => `${n} event${n === 1 ? '' : 's'}`,
  members: n => `${n} member${n === 1 ? '' : 's'}`,
};

function NavItems({ collapsed = false, onNavigate }: { collapsed?: boolean; onNavigate?: () => void }) {
  const location = useLocation();
  const current = sectionForPath(location.pathname);
  const counts = useCounts();
  return (
    <ul className={styles.items}>
      {SECTIONS.map(section => {
        const Icon = ICONS[section.id];
        const count = counts[section.id];
        const active = section.id === current.id;
        const shortcut = `G then ${section.key.toUpperCase()}`;
        const link = (
          <NavLink
            to={section.path}
            end={section.path === '/'}
            onClick={onNavigate}
            className={[styles.item, active ? styles.active : ''].join(' ')}
            aria-current={active ? 'page' : undefined}
            aria-label={collapsed ? `${section.title}${count !== undefined ? `, ${countLabel[section.id](count)}` : ''}` : undefined}
            aria-keyshortcuts={`g ${section.key}`}
            title={collapsed ? undefined : `${section.title} (${shortcut})`}
          >
            <span className={styles.icon}><Icon /></span>
            <span className={styles.label}>{section.title}</span>
            {count !== undefined && count > 0 && <span className={styles.count} aria-label={countLabel[section.id](count)}>{count}</span>}
          </NavLink>
        );
        return (
          <li key={section.id}>
            {collapsed ? <Tooltip content={`${section.title} · ${shortcut}`} side="right">{link}</Tooltip> : link}
          </li>
        );
      })}
    </ul>
  );
}

function WorkspaceHeader({ collapsed = false }: { collapsed?: boolean }) {
  const { workspace, mode } = useHive();
  const host = workspace.cloudLink.replace(/^https?:\/\//, '');
  return (
    <div className={styles.workspace}>
      <div className={styles.brand}>
        <span className={styles.mark}><HiveMark size={18} /></span>
        <span className={styles.brandText}>
          <span className={styles.wordmark}>Hive</span>
          <span className={styles.dot} aria-hidden="true">·</span>
          <span className={styles.wsName} title={workspace.name}>{workspace.name || 'Workspace'}</span>
        </span>
        {mode === 'mock' && !collapsed && <span className={styles.mockTag} title="Prototype data (?mock=1). Remove ?mock or use ?mock=0 for live data.">Mock</span>}
      </div>
      {!collapsed && (
        <div className={styles.cloud}>
          <span className={styles.cloudHost} title={workspace.cloudLink}>{host}</span>
          <CopyButton value={workspace.cloudLink} label="Copy cloud link" iconOnly variant="plain" />
        </div>
      )}
    </div>
  );
}

/** Live / Delayed / Offline with the time since the last poll and the daemon's cache age. */
export function ServerStatus({ compact = false }: { compact?: boolean }) {
  const { connection, lastPollAt, cacheAgeMs, mode, status } = useHive();
  const now = useNow(1000);
  const tone = connection === 'offline' ? 'offline' : connection === 'stale' ? 'stale' : status === 'loading' ? 'connecting' : 'live';
  const label = { offline: 'Offline', stale: 'Delayed', connecting: 'Connecting', live: 'Live' }[tone];
  const age = lastPollAt !== null ? Math.max(0, Math.round((now - lastPollAt) / 1000)) : null;
  const detail = mode === 'mock'
    ? 'Prototype data; nothing is polled.'
    : [age !== null ? `Updated ${age}s ago` : 'Waiting for the first update', cacheAgeMs !== null ? `cache ${Math.round(cacheAgeMs / 100) / 10}s` : null].filter(Boolean).join(' · ');
  const pill = (
    <span className={[styles.status, styles[`status_${tone}`], compact ? styles.statusCompact : ''].join(' ')} role="status" aria-label={`Server ${label}. ${detail}`}>
      <span className={styles.statusDot} aria-hidden="true" />
      {!compact && <span className={styles.statusLabel}>{label}</span>}
      {!compact && <span className={styles.statusDetail} aria-hidden="true">{detail}</span>}
    </span>
  );
  return compact ? <Tooltip content={`${label} · ${detail}`} side="right">{pill}</Tooltip> : pill;
}

/** Dev-only switcher for demonstrating every UI state. Rendered only in mock mode (?mock=1). */
function DemoStateMenu() {
  const { setConnection, setModel, setDataset } = useHive();
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
      ]}
    />
  );
}

function useThemeChange() {
  const { setTheme } = useHive();
  const reduced = usePrefersReducedMotion();
  return (next: Theme) => {
    const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
    if (!reduced && doc.startViewTransition) doc.startViewTransition(() => setTheme(next));
    else setTheme(next);
  };
}

function AccountMenu({ showName }: { showName: boolean }) {
  const { me, workspace, signOut, theme } = useHive();
  const navigate = useNavigate();
  const [settingsOpen, setSettingsOpen] = useState(false);
  if (!me) return null;
  return (
    <>
      <UserMenu
        user={{ name: me.name, email: `${ROLE_LABEL[me.role]} in ${workspace.name || 'this workspace'}`, plan: ROLE_LABEL[me.role] }}
        showName={showName}
        showTheme={false}
        theme={theme}
        align="start"
        items={[
          { label: 'Members and tokens', icon: <Users size={16} />, onSelect: () => navigate('/members') },
          { label: 'Settings', icon: <Settings size={16} />, onSelect: () => setSettingsOpen(true) },
        ]}
        onSignOut={() => { signOut(); navigate('/signin'); }}
      />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </>
  );
}

/** Desktop sidebar. */
export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { theme, mode } = useHive();
  const changeTheme = useThemeChange();
  const toggleLabel = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  return (
    <aside className={[styles.sidebar, collapsed ? styles.collapsed : ''].join(' ')} aria-label="Workspace">
      <WorkspaceHeader collapsed={collapsed} />
      <nav className={styles.nav} aria-label="Sections">
        <NavItems collapsed={collapsed} />
      </nav>
      <div className={styles.footer}>
        {mode === 'mock' && !collapsed && <div className={styles.demo}><DemoStateMenu /></div>}
        <ServerStatus compact={collapsed} />
        <div className={styles.footerRow}>
          <div className={styles.account}><AccountMenu showName={!collapsed} /></div>
          {!collapsed && <ThemeSwitch theme={theme} iconOnly onThemeChange={changeTheme} />}
          <Tooltip content={`${toggleLabel} · [`} side={collapsed ? 'right' : 'top'}>
            <button type="button" className={styles.iconButton} onClick={onToggle} aria-label={toggleLabel} aria-expanded={!collapsed} aria-keyshortcuts="[">
              <PanelLeftIcon />
            </button>
          </Tooltip>
        </div>
      </div>
    </aside>
  );
}

/** Below 1024px: a top bar with the workspace, status and account, and a menu sheet with the sections. */
export function MobileBar() {
  const { theme, mode } = useHive();
  const changeTheme = useThemeChange();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const current = sectionForPath(location.pathname);
  useEffect(() => { setOpen(false); }, [location.pathname]);
  return (
    <header className={styles.topbar}>
      <SheetPrimitive.Root open={open} onOpenChange={setOpen}>
        <SheetPrimitive.Trigger asChild>
          <button type="button" className={styles.iconButton} aria-label="Open navigation"><MenuIcon /></button>
        </SheetPrimitive.Trigger>
        <SheetPrimitive.Portal>
          <SheetPrimitive.Overlay className={styles.sheetOverlay} />
          <SheetPrimitive.Content className={styles.sheet} aria-describedby={undefined}>
            <div className={styles.sheetHead}>
              <SheetPrimitive.Title className={styles.srOnly}>Navigation</SheetPrimitive.Title>
              <WorkspaceHeader />
              <SheetPrimitive.Close asChild>
                <button type="button" className={styles.iconButton} aria-label="Close navigation"><CloseIcon /></button>
              </SheetPrimitive.Close>
            </div>
            <nav className={styles.nav} aria-label="Sections">
              <NavItems onNavigate={() => setOpen(false)} />
            </nav>
            <div className={styles.footer}>
              {mode === 'mock' && <div className={styles.demo}><DemoStateMenu /></div>}
              <ServerStatus />
              <div className={styles.footerRow}>
                <ThemeSwitch theme={theme} iconOnly onThemeChange={changeTheme} />
              </div>
            </div>
          </SheetPrimitive.Content>
        </SheetPrimitive.Portal>
      </SheetPrimitive.Root>
      <div className={styles.topTitle}>
        <span className={styles.mark}><HiveMark size={18} /></span>
        <span className={styles.topSection}>{current.title}</span>
      </div>
      <ServerStatus compact />
      <AccountMenu showName={false} />
    </header>
  );
}
