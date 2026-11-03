// Overview: agents and their progress, the one conflict that needs a person, and the agreements on record.
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { CircleCheck, PlugZap } from 'lucide-react';
import { Button } from '@/components/arc/button/button';
import { EmptyState } from '@/components/arc/empty-state/empty-state';
import { ModelNotice, Page, useHive, useNow } from '@/shell';
import { AgentCard } from './overview/AgentCard';
import { AgreementsRail } from './overview/AgreementsRail';
import { ConflictCard } from './overview/ConflictCard';
import { currentConflict } from './overview/derive';
import styles from './overview/overview.module.css';

export default function Overview() {
  const { snapshot, view, agents, workspace, sessionName, runsFor, readOnly } = useHive();
  const navigate = useNavigate();
  const now = useNow(1000);
  // Viewers poll /api/view: the same layout, without intent details, leases, excerpts or model findings.
  const viewer = view !== null;
  const viewerAnalysis = view?.analysis?.findings ?? 0;
  const conflict = useMemo(
    () => currentConflict(snapshot, sessionName, runsFor, viewer ? { analysisFindings: viewerAnalysis } : null),
    [snapshot, sessionName, runsFor, viewer, viewerAnalysis],
  );

  const revision = snapshot.repository.revision;
  const active = agents.filter(a => a.session.status === 'active').length;
  const description = agents.length
    ? `${active} ${active === 1 ? 'agent is' : 'agents are'} working in ${workspace.name} at revision ${revision}.`
    : `${workspace.name} is indexed at revision ${revision}: ${snapshot.graph.files} files and ${snapshot.graph.symbols} symbols. No agents have registered yet.`;

  if (agents.length === 0) {
    return (
      <Page title="Overview" description={description}>
        <EmptyState
          className={styles.empty}
          label="No agents"
          icon={<PlugZap />}
          title="No agents have registered yet"
          description={readOnly
            ? 'Agents show up here as soon as a member connects a coding tool and it registers.'
            : 'Members can already sign in. Connect a coding tool with a member token and its agent shows up here as soon as it registers.'}
          action={readOnly ? undefined : <Button variant="primary" onClick={() => navigate('/connect')}>Connect an agent</Button>}
        />
      </Page>
    );
  }

  const agentsSection = (
    <section aria-labelledby="agents-title" className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 id="agents-title" className={styles.sectionTitle}>Agents</h2>
        <span className={styles.muted}>{agents.length} registered</span>
      </div>
      <ul className={styles.agentGrid}>
        {agents.map(agent => (
          <li key={agent.session.id}>
            <AgentCard agent={agent} workspaceName={workspace.name} sessionName={sessionName} now={now} viewer={viewer} />
          </li>
        ))}
      </ul>
    </section>
  );

  return (
    <Page
      title="Overview"
      description={description}
      actions={readOnly ? undefined : <Button variant="secondary" onClick={() => navigate('/connect')}>Connect an agent</Button>}
    >
      <ModelNotice />

      {conflict ? (
        <>
          {/* The conflict comes first. Wide screens put agreements beside it; narrow screens list agents before agreements. */}
          <div className={styles.conflictLayout}>
            <div className={styles.areaHero}><ConflictCard conflict={conflict} now={now} /></div>
            <div className={styles.areaRail}><AgreementsRail contracts={snapshot.contracts} /></div>
            <div className={styles.areaAgents}>{agentsSection}</div>
          </div>
        </>
      ) : (
        <>
          {agentsSection}
          <div className={styles.split}>
            <EmptyState
              className={styles.calm}
              label="No conflicts"
              icon={<CircleCheck />}
              title="No conflicts right now"
              description="Hive checks every intent and write against the compiler index. Shared files that need nothing from you are listed in Activity."
            />
            <AgreementsRail contracts={snapshot.contracts} />
          </div>
        </>
      )}
    </Page>
  );
}
