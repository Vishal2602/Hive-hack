// Narrow-width navigation: a segmented control on tablets, a menu on phones.
import { useLocation, useNavigate } from 'react-router-dom';
import SegmentedControl from '@/components/arc/segmented-control/segmented-control';
import { DropdownMenu } from '@/components/arc/dropdown-menu/dropdown-menu';
import { SECTIONS, sectionForPath } from './sections';
import { useMediaQuery } from './useMediaQuery';
import styles from './AppShell.module.css';

export function TopNav() {
  const location = useLocation();
  const navigate = useNavigate();
  const current = sectionForPath(location.pathname);
  const phone = useMediaQuery('(max-width: 639px)');

  return (
    <nav className={styles.topNav} aria-label="Sections">
      {phone ? (
        <DropdownMenu
          label={current.title}
          items={SECTIONS.map(s => ({ label: s.title, onSelect: () => navigate(s.path) }))}
        />
      ) : (
        <SegmentedControl
          label="Sections"
          value={current.id}
          onValueChange={id => navigate(SECTIONS.find(s => s.id === id)?.path ?? '/')}
          options={SECTIONS.map(s => ({ value: s.id, label: s.title }))}
        />
      )}
    </nav>
  );
}
