// Derives each agent's progress through the six steps from snapshot data only.
import type { AgentStepKey, Contract, Finding, Intent, ServiceSnapshot, Session } from './types.ts';

export const AGENT_STEPS: { key: AgentStepKey; label: string; description: string }[] = [
  { key: 'registered', label: 'Registered', description: 'The agent connected with a member token.' },
  { key: 'intent', label: 'Intent declared', description: 'Task, files, symbols and assumptions are on record.' },
  { key: 'working', label: 'Working', description: 'Editing inside its declared scope.' },
  { key: 'contract_pending', label: 'Agreement pending', description: 'Waiting on an agreement or a finding that involves it.' },
  { key: 'implemented', label: 'Implemented', description: 'The compiler shows the code matches every agreement it signed.' },
  { key: 'verified', label: 'Verified', description: 'An allowlisted test command passed on applied code.' },
];

export interface AgentProgress {
  /** 1-based step number, 1 to 6. */
  step: number;
  key: AgentStepKey;
  label: string;
  /** Why the agent is at this step, in one sentence. */
  reason: string;
}

export interface AgentView {
  session: Session;
  intent: Intent | null;
  /** Person part of the session name ("Sanika" from "Sanika · pricing agent"). */
  memberName: string;
  /** Agent part of the session name ("pricing agent"). */
  agentName: string;
  contracts: Contract[];
  findings: Finding[];
  progress: AgentProgress;
}

const at = (key: AgentStepKey, reason: string): AgentProgress => {
  const index = AGENT_STEPS.findIndex(s => s.key === key);
  return { step: index + 1, key, label: AGENT_STEPS[index].label, reason };
};

export function splitSessionName(name: string): { memberName: string; agentName: string } {
  const [memberName, ...rest] = name.split(' · ');
  return { memberName: memberName.trim(), agentName: rest.join(' · ').trim() || 'agent' };
}

export function agentProgress(snapshot: ServiceSnapshot, sessionId: string): AgentProgress {
  const intent = snapshot.intents.find(i => i.sessionId === sessionId);
  if (!intent) return at('registered', 'Connected; no intent declared yet.');
  const contracts = snapshot.contracts.filter(c => c.participants.includes(sessionId) && !['rejected', 'cancelled'].includes(c.status));
  const blocking = snapshot.findings.filter(f => f.sessions.includes(sessionId) && f.severity !== 'info');
  if (!contracts.length && !blocking.length) return at('working', 'No agreements or conflicts involve this agent.');
  const open = contracts.filter(c => c.status === 'proposed' || c.status === 'accepted' || c.status === 'stale');
  if (open.length || blocking.length) {
    const reason = open.length
      ? `${open.length} agreement${open.length > 1 ? 's' : ''} not yet implemented or out of date.`
      : `${blocking.length} finding${blocking.length > 1 ? 's' : ''} to resolve.`;
    return at('contract_pending', reason);
  }
  if (contracts.every(c => c.status === 'verified')) return at('verified', 'Every agreement has passing verification on applied code.');
  return at('implemented', 'Code matches its agreements; verification has not passed yet.');
}

export function agentViews(snapshot: ServiceSnapshot): AgentView[] {
  return snapshot.sessions.map(session => ({
    session,
    intent: snapshot.intents.find(i => i.sessionId === session.id) ?? null,
    ...splitSessionName(session.name),
    contracts: snapshot.contracts.filter(c => c.participants.includes(session.id)),
    findings: snapshot.findings.filter(f => f.sessions.includes(session.id)),
    progress: agentProgress(snapshot, session.id),
  }));
}
