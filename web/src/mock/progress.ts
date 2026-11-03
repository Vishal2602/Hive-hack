// Derives each agent's progress through the six steps from snapshot data only.
// Relative imports to the backend types (no "@hive" alias), so the backend test suite can run this file under Node.
import type { Contract, Finding, Intent, Session } from '../../../src/domain/types.ts';
import type { ServiceSnapshot } from '../../../src/service.ts';

/** Same union as AgentStepKey in ./types.ts, kept local so this file does not depend on the alias. */
type AgentStepKey = 'registered' | 'intent' | 'working' | 'contract_pending' | 'implemented' | 'verified';

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
  /** Set when the next step was attempted and failed, such as a failing check on implemented code. */
  failure?: string;
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

/** "src/pricing.ts#getPrice" from "src/pricing.ts#getPrice:unit": an assumption key and a symbol key name the same code. */
const symbolBase = (key: string) => key.replace(/:[^:#/]*$/, '');
const fileOf = (key: string) => key.split('#')[0] ?? key;

/** Agreement states in which both sides have signed, so a warning about the same code is handled by the agreement. */
const SIGNED: Contract['status'][] = ['accepted', 'implemented', 'verified'];
/** Broken claims and code that does not compile stay blocking even under a signed agreement. */
const NEVER_COVERED: Finding['kind'][] = ['claim_violation', 'structural_incompatibility'];

/**
 * A warning finding is covered when a signed agreement includes every agent in the finding and names the same
 * code: the finding's symbols match the agreement's producer symbol, or its files include the agreement's file.
 * The daemon keeps findings after an agreement is signed, so without this an agent could never pass step 4.
 */
export function coveredBy(finding: Finding, contracts: Contract[]): Contract | null {
  if (finding.severity !== 'warning' || NEVER_COVERED.includes(finding.kind)) return null;
  return contracts.find(c => {
    if (!SIGNED.includes(c.status) || !finding.sessions.every(s => c.participants.includes(s))) return false;
    const symbols = [c.producerSymbol, c.evidence.implemented?.symbol].filter((k): k is string => Boolean(k));
    const files = new Set([...symbols.map(fileOf), ...(c.evidence.implemented?.file ? [c.evidence.implemented.file] : [])]);
    const bases = new Set(symbols.map(symbolBase));
    return (finding.symbols ?? []).some(k => bases.has(symbolBase(k))) || (finding.files ?? []).some(f => files.has(f));
  }) ?? null;
}

/** "npm test failed, exit 1 at revision 3" for an applied run that did not pass, or null. Overlay runs never count. */
export function failedCheck(contract: Contract): string | null {
  const run = contract.evidence.verification;
  if (!run || run.overlay || run.passed || run.status === 'running') return null;
  if (run.status === 'inconclusive') return `${run.command} was inconclusive at revision ${run.revision}`;
  if (run.exitCode === null) return `${run.command} did not finish at revision ${run.revision}`;
  return `${run.command} failed, exit ${run.exitCode} at revision ${run.revision}`;
}

export function agentProgress(snapshot: ServiceSnapshot, sessionId: string): AgentProgress {
  const intent = snapshot.intents.find(i => i.sessionId === sessionId);
  if (!intent) return at('registered', 'Connected; no intent declared yet.');
  const contracts = snapshot.contracts.filter(c => c.participants.includes(sessionId) && !['rejected', 'cancelled'].includes(c.status));
  const blocking = snapshot.findings.filter(f => f.sessions.includes(sessionId) && f.severity !== 'info' && !coveredBy(f, contracts));
  if (!contracts.length && !blocking.length) return at('working', 'No agreements or conflicts involve this agent.');
  const open = contracts.filter(c => c.status === 'proposed' || c.status === 'accepted' || c.status === 'stale');
  if (open.length || blocking.length) {
    const reason = open.length
      ? `${open.length} agreement${open.length > 1 ? 's' : ''} not yet implemented or out of date.`
      : `${blocking.length} finding${blocking.length > 1 ? 's' : ''} to resolve.`;
    return at('contract_pending', reason);
  }
  if (contracts.every(c => c.status === 'verified')) return at('verified', 'Every agreement has passing verification on applied code.');
  const failing = contracts.filter(c => c.status === 'implemented').map(failedCheck).find((f): f is string => f !== null);
  if (failing) return { ...at('implemented', `Agreement implemented; ${failing}.`), failure: 'Check failing' };
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
