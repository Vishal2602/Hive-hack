// Laptop sync: which members' uncommitted files Hive is type-checking together right now.
import type { ServiceSnapshot } from '@/api/types';
import styles from './overview.module.css';

const LIMIT = 6;

function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export function LocalChanges({ remote, now }: { remote: ServiceSnapshot['remote']; now: number }) {
  const members = remote?.members ?? [];
  return (
    <section className={styles.rail} aria-labelledby="local-changes-title">
      <div className={styles.sectionHead}>
        <h2 id="local-changes-title" className={styles.sectionTitle}>Laptop changes</h2>
        {remote?.baseCommit && <span className={styles.muted}>Shared base {remote.baseCommit.slice(0, 8)}</span>}
      </div>
      {members.length === 0 ? (
        <p className={styles.muted}>No uncommitted changes synced yet. Each member's Claude hook sends the TypeScript files it edits, and Hive checks them together.</p>
      ) : (
        <ul className={styles.railList}>
          {members.map(m => {
            const latest = Math.max(...m.files.map(f => f.updatedAt));
            return (
              <li key={m.member} className={styles.railItem}>
                <span className={styles.railTitle}>{m.member}</span>
                <span className={styles.railMeta}>
                  <span>{m.files.length} {m.files.length === 1 ? 'file' : 'files'}</span>
                  <span aria-hidden="true">·</span>
                  <span>updated {ago(latest, now)}</span>
                </span>
                <span className={styles.muted}>
                  {m.files.slice(0, LIMIT).map(f => f.deleted ? `${f.path} (deleted)` : f.path).join(', ')}
                  {m.files.length > LIMIT ? ` and ${m.files.length - LIMIT} more` : ''}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
