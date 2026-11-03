// Step 1: the workspace a teammate is joining, read from GET /me and the latest snapshot.
import { Users } from 'lucide-react';
import { Button } from '@/components/arc/button/button';
import { EmptyState } from '@/components/arc/empty-state/empty-state';
import { Skeleton } from '@/components/arc/skeleton/skeleton';
import { formatRelative, useHive, useLastPoll } from '@/shell';
import { mcpUrl } from './logic';
import { CopyRow, StatusDot } from './shared';
import styles from './Connect.module.css';

export function WorkspaceStep({ onContinue, canInvite }: { onContinue: () => void; canInvite: boolean }) {
  const { workspace, snapshot, connection, members, identity, mode, status } = useHive();
  const { lastPollAt, ageMs } = useLastPoll();
  const activeSessions = snapshot.sessions.filter(s => s.status === 'active');
  const graph = snapshot.graph;
  const loading = status === 'loading';
  const live = mode === 'live';
  // Live: /me.publicUrl (HIVE_PUBLIC_URL) when set, else this page's origin.
  const fromOrigin = live && !identity?.publicUrl;
  const repository = workspace.repository || workspace.name || 'Unknown';
  const root = identity?.workspace.root ?? (live ? null : workspace.serverPath || null);
  const baseCommit = snapshot.workspaces[0]?.baseCommit ?? null;

  const server = connection === 'offline'
    ? { tone: 'danger' as const, label: 'Unreachable', note: `No answer since ${formatRelative(lastPollAt)}. Hive keeps retrying.` }
    : connection === 'stale' || ageMs > 10_000
      ? { tone: 'warning' as const, label: 'Slow to answer', note: `Last answer ${Math.round(ageMs / 1000)} seconds ago.` }
      : { tone: 'success' as const, label: 'Reachable', note: identity ? `Version ${identity.version}. Answering every two seconds.` : 'Answering every two seconds.' };

  const indexTone = !graph.indexed ? 'warning' as const : 'success' as const;

  return (
    <div className={styles.panel}>
      <section className={styles.section} aria-labelledby="ws-link">
        <div className={styles.sectionHead}>
          <h2 id="ws-link" className={styles.sectionTitle}>Cloud link</h2>
          <p className={styles.secondary}>Teammates connect to this address from wherever they work. A token decides who gets in.</p>
        </div>
        <CopyRow value={workspace.cloudLink} label="Copy link" large />
        <p className={styles.muted}>
          {fromOrigin
            ? 'HIVE_PUBLIC_URL is not set, so this is the address this page was opened on. Teammates on other machines need an address they can reach.'
            : `Agents connect to ${mcpUrl(workspace.cloudLink)}.`}
        </p>
      </section>

      <section className={styles.section} aria-labelledby="ws-facts">
        <h2 id="ws-facts" className="visually-hidden">Workspace details</h2>
        <dl className={styles.facts} aria-busy={loading || undefined}>
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
              {repository}
              {root && <span className={styles.factNote}>Checked out at <code>{root}</code></span>}
              {!root && workspace.branch && <span className={styles.factNote}>{`Branch ${workspace.branch}${workspace.region ? `, hosted in ${workspace.region}` : ''}`}</span>}
            </dd>
          </div>
          <div className={styles.fact}>
            <dt>Revision</dt>
            <dd>
              {loading ? <Skeleton lines={1} label="Loading revision" /> : snapshot.repository.revision}
              <span className={styles.factNote}>
                {baseCommit ? <>Based on commit <code>{baseCommit.slice(0, 12)}</code></> : 'No base commit recorded'}
              </span>
            </dd>
          </div>
          <div className={styles.fact}>
            <dt>Compiler index</dt>
            <dd>
              {loading ? <Skeleton lines={1} label="Loading index status" /> : (
                <span className={styles.status}>
                  <StatusDot tone={indexTone} />
                  {graph.indexed ? 'Ready' : 'Not indexed yet'}
                </span>
              )}
              <span className={styles.factNote}>{`${graph.files} files, ${graph.symbols} symbols, ${graph.edges} references`}</span>
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
            {`${members.length} ${members.length === 1 ? 'person has' : 'people have'} access, and ${activeSessions.length} ${activeSessions.length === 1 ? 'agent is' : 'agents are'} working right now.`}
          </p>
        )}
      </section>

      <div className={styles.actions}>
        <span className={styles.muted}>{canInvite ? 'Next, create a token for the person you are inviting.' : 'Next, set up your own agent.'}</span>
        <div className={styles.actionsEnd}>
          <Button onClick={onContinue}>{canInvite ? 'Continue to invite' : 'Continue'}</Button>
        </div>
      </div>
    </div>
  );
}
