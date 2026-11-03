// Signed-in layout: header, section navigation (rail on desktop, segmented control or menu below 1024px), content.
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { Header } from './Header';
import { SideNav } from './SideNav';
import { TopNav } from './TopNav';
import { useMock } from './store';
import { useMediaQuery } from './useMediaQuery';
import styles from './AppShell.module.css';

export function AppShell() {
  const { me } = useMock();
  const location = useLocation();
  const desktop = useMediaQuery('(min-width: 1024px)');

  if (!me) return <Navigate to="/signin" replace state={{ from: location.pathname }} />;

  return (
    <div className={styles.shell}>
      <a className={styles.skip} href="#main">Skip to content</a>
      <Header />
      {!desktop && <TopNav />}
      <div className={styles.body}>
        {desktop && <SideNav />}
        <main id="main" className={styles.main} tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
