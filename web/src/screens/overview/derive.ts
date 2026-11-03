// Pure derivations for the Overview screen. Everything here reads snapshot data and returns plain values;
// rendering decides how to show them. Strings from agents and the model stay strings and render as text.
import { splitSessionName, type Analysis, type Contract, type ContractStatus, type Finding, type FindingKind, type ModelFinding, type ServiceSnapshot, type VerificationRun } from '@/mock';
import { parseSymbolKey } from '@/shell/format';

/** A run of prose where some pieces are code (symbol names, paths) and render in monospace. */
export type Part = string | { code: string };

export interface EvidenceItem {
  id: string;
  label: string;
  /** Where the evidence came from, in plain words. */
  source: string;
  parts: Part[];
}

export interface AffectedSymbol { key: string; name: string; file: string }

export interface ConflictView {
  primary: Finding;
  /** Session ids involved, in a stable order. */
  sessionIds: string[];
  tone: 'danger' | 'warning';
  chip: string;
  title: string;
  /** Deterministic explanation built from intents, findings and runs. Used when the model has nothing. */
  summary: string;
  evidence: EvidenceItem[];
  symbols: AffectedSymbol[];
  files: string[];
  contract: Contract | null;
  /** Latest verification run on applied code (overlay runs never count). */
  appliedRun: VerificationRun | null;
  /** Latest passing overlay run, shown only as context. */
  overlayPass: VerificationRun | null;
  model: ModelView;
}

export type ModelView =
  | { kind: 'ok'; analysis: Analysis; finding: ModelFinding; stale: boolean }
  | { kind: 'nothing'; analysis: Analysis }
  | { kind: 'unavailable'; analysis: Analysis }
  | { kind: 'invalid'; analysis: Analysis }
  | { kind: 'pending' }
  | { kind: 'not_configured' };

export const KIND_LABEL: Record<FindingKind, string> = {
  assumption_mismatch: 'Incompatible assumption',
  dependent_write: 'Dependent write',
  file_overlap: 'Shared file',
  symbol_overlap: 'Shared symbol',
  direct_edit: 'Direct edit',
  claim_violation: 'Claim violation',
  structural_incompatibility: 'Does not compile',
};

const SOURCE_LABEL: Record<Finding['source'], string> = {
  deterministic: 'From declared intents',
  compiler: 'From the compiler index',
  model: 'From Muse Spark',
};

export const STATE_LABEL: Record<ContractStatus, string> = {
  proposed: 'Proposed',
  accepted: 'Accepted',
  implemented: 'Implemented',
  verified: 'Verified',
  stale: 'Stale',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

/** Green only for verified evidence, amber for attention, neutral for everything else. */
export const STATE_TONE: Record<ContractStatus, 'success' | 'warning' | 'neutral'> = {
  proposed: 'neutral',
  accepted: 'neutral',
  implemented: 'neutral',
  verified: 'success',
  stale: 'warning',
  rejected: 'neutral',
  cancelled: 'neutral',
};

const unique = <T,>(items: T[]) => [...new Set(items)];
const SESSION_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** "Sanika's pricing agent" from "Sanika · pricing agent". */
export function possessiveName(sessionName: string): string {
  const { memberName, agentName } = splitSessionName(sessionName);
  return `${memberName}'s ${agentName}`;
}

/** Signatures on the contract's current version. */
export function signatureCount(contract: Contract): { signed: number; total: number } {
  const signedNow = new Set(contract.acknowledgementDetails.filter(a => a.version === contract.version).map(a => a.sessionId));
  return { signed: contract.participants.filter(p => signedNow.has(p)).length, total: contract.participants.length };
}

/** First assertion-looking line of test output, such as "19.99 !== 1999". */
function failureLine(output: string): string | null {
  const lines = output.split('\n').map(l => l.trim()).filter(Boolean);
  return lines.find(l => /!==|===|expected|assert/i.test(l) && !/^Expected values/.test(l)) ?? null;
}

interface Dependency { symbol: string; file: string; line: number | null }

/** Reads the depending symbol out of a dependent_write finding's evidence, if it is there. */
function dependencyOf(finding: Finding): Dependency | null {
  const match = /depends on it: (\S+#\S+?)(?: \((\S+?):(\d+)\))?$/.exec(finding.evidence);
  if (!match) return null;
  const parsed = parseSymbolKey(match[1]);
  return { symbol: match[1], file: match[2] ?? parsed.file, line: match[3] ? Number(match[3]) : null };
}

interface Disagreement { key: string; name: string; attribute: string; values: { sessionId: string; value: string }[] }

/** The assumption key on which the given sessions declared different values. */
function disagreementOf(snapshot: ServiceSnapshot, finding: Finding): Disagreement | null {
  const byKey = new Map<string, { sessionId: string; value: string }[]>();
  for (const intent of snapshot.intents) {
    if (!finding.sessions.includes(intent.sessionId)) continue;
    for (const a of intent.assumptions) byKey.set(a.key, [...(byKey.get(a.key) ?? []), { sessionId: intent.sessionId, value: a.value }]);
  }
  const symbolNames = new Set((finding.symbols ?? []).map(s => { const p = parseSymbolKey(s); return `${p.file}#${p.name}`; }));
  const candidates = [...byKey.entries()].filter(([, values]) => new Set(values.map(v => v.value)).size > 1);
  const [key, values] = candidates.find(([k]) => { const p = parseSymbolKey(k); return symbolNames.has(`${p.file}#${p.name}`); }) ?? candidates[0] ?? [];
  if (!key || !values) return null;
  const parsed = parseSymbolKey(key);
  return { key, name: parsed.name, attribute: parsed.kind || 'value', values };
}

function modelViewFor(snapshot: ServiceSnapshot, sessionIds: string[]): ModelView {
  if (!snapshot.model.configured) return { kind: 'not_configured' };
  const analysis = snapshot.analysis;
  if (!analysis) return { kind: 'pending' };
  if (analysis.status === 'unavailable') return { kind: 'unavailable', analysis };
  if (analysis.status === 'invalid') return { kind: 'invalid', analysis };
  const finding = analysis.findings.find(f => f.sessionIds.some(id => sessionIds.includes(id)));
  if (!finding) return { kind: 'nothing', analysis };
  return { kind: 'ok', analysis, finding, stale: analysis.status === 'stale' || analysis.revision !== snapshot.repository.revision };
}

/**
 * The one conflict the Overview leads with: the first error finding, else the first warning.
 * Informational overlaps never become the hero; they are candidates, not proven conflicts.
 */
export function currentConflict(
  snapshot: ServiceSnapshot,
  sessionName: (id: string) => string,
  runsFor: (contractId: string) => VerificationRun[],
): ConflictView | null {
  const primary = snapshot.findings.find(f => f.severity === 'error') ?? snapshot.findings.find(f => f.severity === 'warning');
  if (!primary) return null;

  const sessionIds = unique(primary.sessions);
  const touches = (f: Finding) => f.sessions.some(s => sessionIds.includes(s));
  const related = snapshot.findings.filter(f => f !== primary && f.severity !== 'info' && touches(f));
  const all = [primary, ...related];

  const disagreement = primary.kind === 'assumption_mismatch' ? disagreementOf(snapshot, primary) : null;
  const dependentFinding = all.find(f => f.kind === 'dependent_write') ?? null;
  const dependency = dependentFinding ? dependencyOf(dependentFinding) : null;

  const symbolKeys = unique([...all.flatMap(f => f.symbols ?? []), ...(dependency ? [dependency.symbol] : [])]);
  const symbols = symbolKeys.map(key => { const p = parseSymbolKey(key); return { key, name: p.name, file: p.file }; });
  const files = unique([...symbols.map(s => s.file), ...all.flatMap(f => f.files ?? [])]).filter(Boolean);

  const contract = snapshot.contracts.find(c => c.producerSymbol !== null && symbolKeys.includes(c.producerSymbol) && !['rejected', 'cancelled'].includes(c.status)) ?? null;
  const runs = contract ? runsFor(contract.id) : [];
  const appliedRun = runs.filter(r => !r.overlay).at(-1) ?? null;
  const overlayPass = runs.filter(r => r.overlay && r.passed).at(-1) ?? null;

  const subject = disagreement?.name ?? symbols[0]?.name ?? files[0] ?? 'shared code';
  const people = sessionIds.length === 2 ? 'Two agents' : `${sessionIds.length} agents`;
  const tone = primary.severity === 'error' ? 'danger' : 'warning';

  let title: string;
  switch (primary.kind) {
    case 'assumption_mismatch': {
      const who = disagreement ? disagreement.values.map(v => splitSessionName(sessionName(v.sessionId))) : [];
      const sameMember = who.length === 2 && who[0].memberName === who[1].memberName;
      const names = who.length === 2 ? (sameMember ? `The ${who[0].agentName} and the ${who[1].agentName}` : `${who[0].memberName} and ${who[1].memberName}`) : people;
      title = `${names} expect a different ${disagreement?.attribute ?? 'behavior'} from ${subject}`;
      break;
    }
    case 'dependent_write': title = `A change to ${subject} reaches code another agent depends on`; break;
    case 'claim_violation': title = `A claim on ${subject} is no longer true`; break;
    case 'structural_incompatibility': title = `A staged change to ${subject} does not compile`; break;
    case 'direct_edit': title = `${files[0] ?? 'A file'} changed outside Hive`; break;
    default: title = `${people} are working on ${subject} at the same time`;
  }

  // Deterministic explanation: what each side declared, what the compiler proves, what the last run showed.
  const sentences: string[] = [];
  if (disagreement) {
    const [a, b] = disagreement.values;
    sentences.push(`${possessiveName(sessionName(a.sessionId))} expects the ${disagreement.attribute} of ${disagreement.name} to be ${a.value}; ${possessiveName(sessionName(b.sessionId))} expects ${b.value}.`);
  }
  if (dependency) {
    const name = parseSymbolKey(dependency.symbol).name;
    sentences.push(`The compiler shows ${name} in ${dependency.file} depends on ${subject}, so a change on one side reaches the other.`);
  }
  if (appliedRun && !appliedRun.passed) {
    sentences.push(`The last test run on applied code exited ${appliedRun.exitCode} at revision ${appliedRun.revision}.`);
  }
  if (!sentences.length) sentences.push(primary.evidence.replace(SESSION_ID, id => sessionName(id)));

  // Evidence list: one line per finding, plus the failing run when there is one.
  const evidence: EvidenceItem[] = all.map((f, i) => ({ id: `${f.kind}-${i}`, label: KIND_LABEL[f.kind], source: SOURCE_LABEL[f.source], parts: evidenceParts(f, sessionName, snapshot) }));
  if (appliedRun && !appliedRun.passed) {
    const line = failureLine(appliedRun.output);
    evidence.push({
      id: `run-${appliedRun.id}`,
      label: 'Failing test run',
      source: 'From verification',
      parts: [{ code: appliedRun.command }, ` exited ${appliedRun.exitCode} at revision ${appliedRun.revision}`, ...(line ? [': ', { code: line }] : [])],
    });
  }

  return {
    primary, sessionIds, tone, chip: tone === 'danger' ? 'Conflict' : 'Needs coordination', title,
    summary: sentences.join(' '), evidence, symbols, files, contract, appliedRun, overlayPass,
    model: modelViewFor(snapshot, sessionIds),
  };
}

function evidenceParts(f: Finding, sessionName: (id: string) => string, snapshot: ServiceSnapshot): Part[] {
  if (f.kind === 'assumption_mismatch') {
    const d = disagreementOf(snapshot, f);
    if (d) {
      const [a, b] = d.values;
      return [`${sessionName(a.sessionId)} expects `, { code: a.value }, `, ${sessionName(b.sessionId)} expects `, { code: b.value }, ' for ', { code: d.key }];
    }
  }
  if (f.kind === 'dependent_write') {
    const dep = dependencyOf(f);
    const target = f.symbols?.[0] ? parseSymbolKey(f.symbols[0]).name : null;
    if (dep && target) {
      return [{ code: parseSymbolKey(dep.symbol).name }, ' in ', { code: dep.line ? `${dep.file}:${dep.line}` : dep.file }, ' calls ', { code: target }, ', which another agent is changing'];
    }
  }
  // Fallback: the raw evidence with session ids replaced by names. Still plain text.
  return [f.evidence.replace(SESSION_ID, id => sessionName(id))];
}
