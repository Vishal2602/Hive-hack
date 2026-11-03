// Small settings dialog: appearance and accent. Stored per viewer in localStorage.
import { Dialog, DialogClose, DialogContent } from '@/components/arc/dialog/dialog';
import { Button } from '@/components/arc/button/button';
import SegmentedControl from '@/components/arc/segmented-control/segmented-control';
import { MorphSelect } from '@/components/arc/morph-select/morph-select';
import { useMock, type Accent, type Theme } from './store';
import styles from './AppShell.module.css';

const ACCENTS: { value: Accent; label: string }[] = [
  { value: 'amber', label: 'Amber' },
  { value: 'neutral', label: 'Neutral' },
  { value: 'blue', label: 'Blue' },
  { value: 'green', label: 'Green' },
  { value: 'violet', label: 'Violet' },
];

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { theme, setTheme, accent, setAccent } = useMock();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Settings" description="These apply to this browser only.">
        <div className={styles.settings}>
          <div className={styles.settingRow}>
            <span className={styles.settingLabel}>Appearance</span>
            <SegmentedControl
              label="Appearance"
              value={theme}
              onValueChange={v => setTheme(v as Theme)}
              options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]}
            />
          </div>
          <div className={styles.settingRow}>
            <MorphSelect
              label="Accent"
              items={ACCENTS}
              value={accent}
              onValueChange={v => v && setAccent(v as Accent)}
            />
          </div>
          <div className={styles.settingActions}>
            <DialogClose asChild><Button variant="secondary">Done</Button></DialogClose>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
