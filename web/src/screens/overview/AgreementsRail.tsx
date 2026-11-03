// Compact list of agreements: title, version, state and signatures. Each row links to its detail page.
import { Link } from 'react-router-dom';
import { Badge } from '@/components/arc/badge/badge';
import type { Contract } from '@/mock';
import { STATE_LABEL, STATE_TONE, signatureCount } from './derive';
import styles from './overview.module.css';

const ORDER: Record<Contract['status'], number> = { stale: 0, proposed: 1, accepted: 2, implemented: 3, verified: 4, rejected: 5, cancelled: 6 };
const LIMIT = 5;

export function AgreementsRail({ contracts }: { contracts: Contract[] }) {
  const sorted = [...contracts].sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.updatedAt - a.updatedAt);
  const shown = sorted.slice(0, LIMIT);

  return (
    <section className={styles.rail} aria-labelledby="agreements-rail-title">
      <div className={styles.sectionHead}>
        <h2 id="agreements-rail-title" className={styles.sectionTitle}>Agreements</h2>
        <Link to="/agreements" className={styles.textLink}>View all</Link>
      </div>
      {shown.length === 0 ? (
        <p className={styles.muted}>No agreements yet. Agents propose one when they need to promise an interface to each other.</p>
      ) : (
        <ul className={styles.railList}>
          {shown.map(c => {
            const { signed, total } = signatureCount(c);
            return (
              <li key={c.id}>
                <Link to={`/agreements/${c.id}`} className={styles.railItem}>
                  <span className={styles.railTitle}>{c.title}</span>
                  <span className={styles.railMeta}>
                    <Badge tone={STATE_TONE[c.status]} size="sm">{STATE_LABEL[c.status]}</Badge>
                    <span>Version {c.version}</span>
                    <span aria-hidden="true">·</span>
                    <span>{signed} of {total} signed</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {sorted.length > LIMIT && <p className={styles.muted}>{sorted.length - LIMIT} more on the agreements page.</p>}
    </section>
  );
}
