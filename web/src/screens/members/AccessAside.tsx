// Side panel: what each role can do, how tokens work, and a viewer preview for people who can manage access.
import { Link } from 'react-router-dom';
import { Switch } from '@/components/arc/switch/switch';
import { ROLE_DESCRIPTION, ROLE_LABEL, type Role } from '@/mock';
import { ROLE_ORDER } from './model';
import styles from './members.module.css';

interface AccessAsideProps {
  myRole: Role;
  previewViewer: boolean;
  onPreviewViewerChange: (next: boolean) => void;
}

export function AccessAside({ myRole, previewViewer, onPreviewViewerChange }: AccessAsideProps) {
  return (
    <aside className={styles.aside} aria-label="About access">
      <section className={styles.panel} aria-labelledby="roles-heading">
        <h2 id="roles-heading" className={styles.panelTitle}>Roles</h2>
        <dl className={styles.roles}>
          {ROLE_ORDER.map(role => (
            <div key={role} className={styles.role}>
              <dt>{ROLE_LABEL[role]}{role === myRole && <span className={styles.yours}>Your role</span>}</dt>
              <dd>{ROLE_DESCRIPTION[role]}</dd>
            </div>
          ))}
        </dl>
        {myRole !== 'viewer' && (
          <div className={styles.preview}>
            <Switch
              label="Preview as a viewer"
              checked={previewViewer}
              onCheckedChange={onPreviewViewerChange}
            />
            <p className={styles.panelNote}>See this page the way a viewer does. Nothing changes for anyone else.</p>
          </div>
        )}
      </section>

      <section className={styles.panel} aria-labelledby="how-heading">
        <h2 id="how-heading" className={styles.panelTitle}>How access works</h2>
        <ul className={styles.rules}>
          <li>A token is shown once, when it is created. Copy it into the client config then.</li>
          <li>The server keeps only a hash of each token and the short prefix you see here.</li>
          <li>Revoking a token stops it at once. Agents that used it lose access on their next request.</li>
          <li>Every invite, rename and revoke is recorded in the <Link to="/activity" className={styles.inlineLink}>activity log</Link>.</li>
          <li>The admin token that created this workspace is never shown in the app.</li>
        </ul>
      </section>
    </aside>
  );
}
