// Side panel: what each role can do and how tokens work, worded to match what the daemon does
// (src/server/tokens.ts, src/server/auth.ts). A viewer preview for people who can see more.
import { Link } from 'react-router-dom';
import { Switch } from '@/components/arc/switch/switch';
import { ROLE_LABEL, type Role } from '@/mock';
import styles from './members.module.css';

const ROLE_ORDER: Role[] = ['admin', 'member', 'viewer'];

const ROLE_RULES: Record<Role, string> = {
  admin: 'Invites people, renames and revokes any token, and can act for any agent.',
  member: 'Connects agents with their own token and acts only for the agents that token registered.',
  viewer: 'Reads the shared workspace view and activity. Cannot connect agents or change anything.',
};

interface AccessAsideProps {
  myRole: Role;
  previewViewer: boolean;
  onPreviewViewerChange: (next: boolean) => void;
  /** True when the activity log carries token events (invite, rename, revoke). */
  tokenEventsLogged: boolean;
}

export function AccessAside({ myRole, previewViewer, onPreviewViewerChange, tokenEventsLogged }: AccessAsideProps) {
  return (
    <aside className={styles.aside} aria-label="About access">
      <section className={styles.panel} aria-labelledby="roles-heading">
        <h2 id="roles-heading" className={styles.panelTitle}>Roles</h2>
        <dl className={styles.roles}>
          {ROLE_ORDER.map(role => (
            <div key={role} className={styles.role}>
              <dt>{ROLE_LABEL[role]}{role === myRole && <span className={styles.yours}>Your role</span>}</dt>
              <dd>{ROLE_RULES[role]}</dd>
            </div>
          ))}
        </dl>
        {myRole !== 'viewer' && (
          <div className={styles.preview}>
            <Switch label="Preview as a viewer" checked={previewViewer} onCheckedChange={onPreviewViewerChange} />
            <p className={styles.panelNote}>See this page the way a viewer does. Nothing changes for anyone else.</p>
          </div>
        )}
      </section>

      <section className={styles.panel} aria-labelledby="how-heading">
        <h2 id="how-heading" className={styles.panelTitle}>How access works</h2>
        <ul className={styles.rules}>
          <li>A token is shown once, when it is created. Copy it into the client config then.</li>
          <li>Hive stores only a SHA-256 hash of each token and its first 8 characters, the prefix you see here.</li>
          <li>Revoking takes effect at once. The next request with that token is refused, from an agent or from this app.</li>
          <li>Last used updates at most once a minute.</li>
          <li>
            {tokenEventsLogged
              ? <>Invites, renames and revokes are recorded in the <Link to="/activity" className={styles.inlineLink}>activity log</Link>.</>
              : <>Each agent that connects is recorded in the <Link to="/activity" className={styles.inlineLink}>activity log</Link> with the member it belongs to.</>}
          </li>
          <li>The admin token this workspace was started with is never shown in the app.</li>
        </ul>
      </section>
    </aside>
  );
}
