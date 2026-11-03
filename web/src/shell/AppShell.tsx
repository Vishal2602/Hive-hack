// Signed-in layout: Linear-style sidebar on desktop (>= 1024px), top bar + menu sheet below, content.
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { Button } from '@/components/arc/button/button';
import { MobileBar, Sidebar, useNavShortcuts, useSidebarCollapsed } from './Sidebar';
import { Standalone } from './Standalone';
import { useHive } from './store';
import { useMediaQuery } from './useMediaQuery';
import styles from './AppShell.module.css';

export function AppShell() {
  const { me, status, connection, error, refresh, signOut } = useHive();
  const location = useLocation();
  const desktop = useMediaQuery('(min-width: 1024px)');
  const [collapsed, toggle] = useSidebarCollapsed();
  useNavShortcuts(desktop ? toggle : undefined);

  if (status === 'signed-out' || !me && status !== 'loading') return <Navigate to="/signin" replace state={{ from: location.pathname }} />;

  if (status === 'loading') {
    const offline = connection === 'offline';
    return (
      <Standalone>
        <div className={styles.loading} role="status" aria-live="polite">
          <span className={styles.loadingTitle}>{offline ? 'Cannot reach Hive' : 'Connecting to Hive…'}</span>
          {offline && <p className={styles.loadingText}>{error ?? 'The server did not answer.'} Hive keeps retrying every 2 seconds.</p>}
          {offline && (
            <div className={styles.loadingActions}>
              <Button variant="secondary" onClick={() => { void refresh(); }}>Retry now</Button>
              <Button variant="ghost" onClick={signOut}>Use a different token</Button>
            </div>
          )}
        </div>
      </Standalone>
    );
  }

  return (
    <div className={[styles.shell, desktop ? styles.desktop : ''].join(' ')}>
      <a className={styles.skip} href="#main">Skip to content</a>
      {desktop ? <Sidebar collapsed={collapsed} onToggle={toggle} /> : <MobileBar />}
      <main id="main" className={styles.main} tabIndex={-1}>
        <div className={styles.content}>
          <Outlet />
        </div>
      </main>
    </div>
  );
}
