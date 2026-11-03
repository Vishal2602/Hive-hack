import type { ReactNode } from 'react';
import styles from './AppShell.module.css';

/** Centered full-page layout without header or navigation, for sign in and invite links. */
export function Standalone({ children }: { children: ReactNode }) {
  return <main id="main" className={styles.standalone}>{children}</main>;
}
