// Step 1: the workspace a teammate is joining, reachable from anywhere on its cloud link.
import { Button } from '@/components/arc/button/button';
import { EmptyState } from '@/components/arc/empty-state/empty-state';
import { Users } from 'lucide-react';
import { formatRelative, useLastPoll, useMock } from '@/shell';
import { CopyRow, StatusDot } from './shared';
import styles from './Connect.module.css';

export function WorkspaceStep({ onContinue, canInvite }: { onContinue: () => void; canInvite: boolean }) {
  const { workspace, snapshot, connection, members } = useMock();
  const { lastPollAt, ageMs } = useLastPoll();
  const activeSessions = snapshot.sessions.filter(s => s.status === 'active');
  const graph = snapshot.graph;

  const server = connection === 'offline'
    ? { tone: 'danger' as const, label: 'Unreachable', note: `No answer since ${formatRelative(lastPollAt)}. Hive keeps retrying.` }
    : connection === 'stale' || ageMs > 10_000
      ? { tone: 'warning' as const, label: 'Slow to answer', note: `Last answer ${Math.round(ageMs / 1000)} seconds ago.` }
      : { tone: 'success' as const, label: 'Reachable', note: 'Answering every two seconds.' };

  return (
    <div className={styles.panel}>
      <section className={styles.section} aria-labelledby="ws-link">
        <div className={styles.sectionHead}>
          <h2 id="ws-link" className={styles.sectionTitle}>Cloud link</h2>
          <p className={styles.secondary}>Teammates connect to this address from wherever they work. A token decides who gets in.</p>
        </div>
        <CopyRow value={workspace.cloudLink} label="Copy link" large />
      </section>

      <section className={styles.section} aria-labelledby="ws-facts">
        <h2 id="ws-facts" className="visually-hidden">Workspace details</h2>
        <dl className={styles.facts}>
          <div className={styles.fact}>
            <dt>Server</dt>
            <dd>
              <span className={styles.status}><StatusDot tone={server.tone} />{server.label}</span>
              <span className={styles.factNote}>{server.note}</span>
            </dd>
          </div>
          <div className={styles.fact}>
            <dt>Repository</dt>
            <dd>
              {workspace.repository}
              <span className={styles.factNote}>Branch {workspace.branch}, hosted in {workspace.region}</span>
            </dd>
          </div>
          <div className={styles.fact}>
            <dt>Revision</dt>
            <dd>
              {snapshot.repository.revision}
              <span className={styles.factNote}>Based on commit <code>{snapshot.workspaces[0]?.baseCommit ?? 'unknown'}</code></span>
            </dd>
          </div>
          <div className={styles.fact}>
            <dt>Compiler index</dt>
            <dd>
              <span className={styles.status}>
                <StatusDot tone={graph.indexed ? 'success' : 'warning'} />
                {graph.indexed ? 'Ready' : 'Indexing'}
              </span>
              <span className={styles.factNote}>{graph.files} files, {graph.symbols} symbols, {graph.edges} references</span>
            </dd>
          </div>
        </dl>
      </section>

      <section className={styles.section} aria-labelledby="ws-people">
        <h2 id="ws-people" className={styles.sectionTitle}>Who is here</h2>
        {activeSessions.length === 0 ? (
          <EmptyState
            icon={<Users size={20} />}
            title="No agents connected yet"
            description="Invite a teammate or connect your own agent. Agents appear on the overview as soon as they register."
          />
        ) : (
          <p className={styles.secondary}>
            {members.length} {members.length === 1 ? 'person has' : 'people have'} access, and {activeSessions.length} {activeSessions.length === 1 ? 'agent is' : 'agents are'} working right now.
          </p>
        )}
      </section>

      <div className={styles.actions}>
        <span className={styles.muted}>{canInvite ? 'Next, create a token for the person you are inviting.' : 'Next, create a token for your own agent.'}</span>
        <div className={styles.actionsEnd}>
          <Button onClick={onContinue}>{canInvite ? 'Continue to invite' : 'Continue'}</Button>
        </div>
      </div>
    </div>
  );
}
