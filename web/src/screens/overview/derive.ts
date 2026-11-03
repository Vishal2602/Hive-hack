// Pure derivations for the Overview screen. Everything here reads snapshot data and returns plain values;
// rendering decides how to show them. Strings from agents and the model stay strings and render as text.
// Relative imports only (no "@/" alias), so the backend test suite can run this file under Node.
import type { Contract, ContractStatus, Finding, FindingKind, VerificationRun } from '../../../../src/domain/types.ts';
import type { Analysis, ModelFinding } from '../../../../src/intelligence/types.ts';
import type { ServiceSnapshot } from '../../../../src/service.ts';
import { parseSymbolKey } from '../../shell/format.ts';

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

export type ConflictTone = 'danger' | 'warning' | 'neutral' | 'success';

export interface ConflictView {
  primary: Finding;
  /** Session ids involved, in a stable order. */
  sessionIds: string[];
  tone: ConflictTone;
  chip: string;
  /** Small label above the title: a conflict, or an informational candidate that is not one. */
  eyebrow: string;
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

/** How fresh a model answer is: computed for this input, reused for an identical input, or outdated. */
export type Freshness = 'fresh' | 'cached' | 'stale';

export type ModelView =
  | { kind: 'ok'; analysis: Analysis; finding: ModelFinding; freshness: Freshness }
  /** Viewers: the view carries the model's summary and a finding count, not the findings themselves. */
  | { kind: 'summary'; analysis: Analysis; findings: number; freshness: Freshness }
  | { kind: 'nothing'; analysis: Analysis; freshness: Freshness }
  | { kind: 'unavailable'; analysis: Analysis }
  | { kind: 'invalid'; analysis: Analysis }
  | { kind: 'pending' }
  | { kind: 'not_configured' };

/** Viewer context: the /api/view analysis only says how many model findings there were. */
export interface ViewerContext { analysisFindings: number }

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
const CLOSED: ContractStatus[] = ['rejected', 'cancelled'];

/** "Sanika" and "pricing agent" from "Sanika · pricing agent". Same rule as the store's agent views. */
export function splitName(name: string): { memberName: string; agentName: string } {
  const [memberName = '', ...rest] = name.split(' · ');
  return { memberName: memberName.trim(), agentName: rest.join(' · ').trim() || 'agent' };
}

/** "Sanika's pricing agent" from "Sanika · pricing agent". */
export function possessiveName(sessionName: string): string {
  const { memberName, agentName } = splitName(sessionName);
  return `${memberName}'s ${agentName}`;
}

/** Signatures on the contract's current version. */
export function signatureCount(contract: Contract): { signed: number; total: number } {
  const signedNow = new Set(contract.acknowledgementDetails.filter(a => a.version === contract.version).map(a => a.sessionId));
  return { signed: contract.participants.filter(p => signedNow.has(p)).length, total: contract.participants.length };
}

/** Lease line in minutes only, so it changes at most once a minute. Finished and expired sessions say so. */
export function leaseText(session: { status: string; expiresAt: number }, now: number): string {
  if (session.status === 'finished') return 'session finished';
  const left = session.expiresAt - now;
  if (session.status === 'expired' || left <= 0) return 'lease expired';
  if (left < 60_000) return 'lease ends in under a minute';
  return `${Math.ceil(left / 60_000)} min left on lease`;
}

// ---- which finding leads -----------------------------------------------------------------------------

/** Lower leads. Broken claims and code that does not compile come first, then semantic disagreements. */
const KIND_RANK: Record<FindingKind, number> = {
  claim_violation: 0,
  structural_incompatibility: 0,
  assumption_mismatch: 1,
  dependent_write: 1,
  direct_edit: 2,
  symbol_overlap: 2,
  file_overlap: 2,
};
const SEVERITY_RANK: Record<Finding['severity'], number> = { error: 0, warning: 1, info: 2 };

/** Informational findings always rank last, whatever their kind: they are candidates, not proven conflicts. */
export function findingRank(f: Finding): number {
  return f.severity === 'info' ? 3 : KIND_RANK[f.kind] ?? 2;
}

/** The finding the Overview leads with, or null when there is none. Stable for equal ranks. */
export function pickPrimary(findings: Finding[]): Finding | null {
  let best: Finding | null = null;
  for (const f of findings) {
    if (!best) { best = f; continue; }
    const byRank = findingRank(f) - findingRank(best);
    if (byRank < 0 || (byRank === 0 && SEVERITY_RANK[f.severity] < SEVERITY_RANK[best.severity])) best = f;
  }
  return best;
}

// ---- reading finding evidence ------------------------------------------------------------------------

interface Dependency { symbol: string; file: string; line: number | null }

/**
 * Reads the first depending location out of a dependent_write finding's evidence:
 * "<writer> declares work on <key> (<sig>); <reader>'s scope depends on it: <from> (<file>:<line>); ...".
 * A symbol key is preferred over a whole-file dependency. Tolerates a truncated viewer string.
 */
export function dependencyOf(finding: Finding): Dependency | null {
  const marker = 'depends on it: ';
  const start = finding.evidence.indexOf(marker);
  if (start === -1) return null;
  const items = finding.evidence.slice(start + marker.length).split('; ').map(item => {
    const match = /^(\S+?)(?: \((\S+?):(\d+)\))?\s*$/.exec(item.trim());
    if (!match || match[1]!.endsWith('…')) return null;
    const from = match[1]!;
    return { symbol: from, file: match[2] ?? parseSymbolKey(from).file, line: match[3] ? Number(match[3]) : null };
  }).filter((d): d is Dependency => d !== null);
  return items.find(d => d.symbol.includes('#')) ?? items[0] ?? null;
}

interface Disagreement { key: string; name: string; attribute: string; values: { sessionId: string; value: string }[] }

function disagreementFor(key: string, values: { sessionId: string; value: string }[]): Disagreement {
  const parsed = parseSymbolKey(key);
  return { key, name: parsed.name || key, attribute: parsed.kind || 'value', values };
}

/**
 * The assumption key on which the finding's sessions declared different values. Reads the intents when
 * they carry assumptions (members, admins); otherwise parses the finding text "<key>: <a> expects <x>; <b> expects <y>",
 * which is all a viewer receives.
 */
export function disagreementOf(snapshot: ServiceSnapshot, finding: Finding): Disagreement | null {
  const byKey = new Map<string, { sessionId: string; value: string }[]>();
  for (const intent of snapshot.intents) {
    if (!finding.sessions.includes(intent.sessionId)) continue;
    for (const a of intent.assumptions) byKey.set(a.key, [...(byKey.get(a.key) ?? []), { sessionId: intent.sessionId, value: a.value }]);
  }
  const symbolNames = new Set((finding.symbols ?? []).map(s => { const p = parseSymbolKey(s); return `${p.file}#${p.name}`; }));
  const candidates = [...byKey.entries()].filter(([, values]) => new Set(values.map(v => v.value)).size > 1);
  const [key, values] = candidates.find(([k]) => (finding.symbols ?? []).includes(k))
    ?? candidates.find(([k]) => { const p = parseSymbolKey(k); return symbolNames.has(`${p.file}#${p.name}`); })
    ?? candidates[0] ?? [];
  if (key && values) return disagreementFor(key, values);

  const match = /^(\S+): (\S+) expects (.+?); (\S+) expects (.+)$/.exec(finding.evidence.trim());
  if (!match) return null;
  return disagreementFor(match[1]!, [{ sessionId: match[2]!, value: match[3]! }, { sessionId: match[4]!, value: match[5]! }]);
}

/** First assertion-looking line of test output, such as "19.99 !== 1999". Empty output (viewers) gives null. */
function failureLine(output: string): string | null {
  const lines = output.split('\n').map(l => l.trim()).filter(Boolean);
  return lines.find(l => /!==|===|expected|assert/i.test(l) && !/^Expected values/.test(l)) ?? null;
}

/** One sentence about an applied run that did not pass, or null when it passed or is still running. */
function runProblem(run: VerificationRun): string | null {
  if (run.passed || run.status === 'running') return null;
  if (run.status === 'inconclusive') return `The last test run on applied code was inconclusive at revision ${run.revision}.`;
  if (run.exitCode === null) return `The last test run on applied code did not finish at revision ${run.revision}.`;
  return `The last test run on applied code exited ${run.exitCode} at revision ${run.revision}.`;
}

// ---- model attribution -------------------------------------------------------------------------------

function freshnessOf(analysis: Analysis, revision: number): Freshness {
  if (analysis.status === 'stale' || analysis.revision !== revision) return 'stale';
  return analysis.status === 'cached' ? 'cached' : 'fresh';
}

export function modelViewFor(snapshot: ServiceSnapshot, sessionIds: string[], viewer: ViewerContext | null = null): ModelView {
  if (!snapshot.model.configured) return { kind: 'not_configured' };
  const analysis = snapshot.analysis;
  if (!analysis) return { kind: 'pending' };
  if (analysis.status === 'unavailable') return { kind: 'unavailable', analysis };
  if (analysis.status === 'invalid') return { kind: 'invalid', analysis };
  const freshness = freshnessOf(analysis, snapshot.repository.revision);
  if (viewer) {
    return viewer.analysisFindings > 0 || analysis.summary.trim()
      ? { kind: 'summary', analysis, findings: viewer.analysisFindings, freshness }
      : { kind: 'nothing', analysis, freshness };
  }
  const finding = analysis.findings.find(f => f.sessionIds.some(id => sessionIds.includes(id)));
  if (!finding) return { kind: 'nothing', analysis, freshness };
  return { kind: 'ok', analysis, finding, freshness };
}

// ---- the hero ----------------------------------------------------------------------------------------

/** The live agreement behind a conflict: one on a symbol it touches, else one the involved agents share. */
export function relatedContract(contracts: Contract[], symbolKeys: string[], sessionIds: string[]): Contract | null {
  const open = contracts.filter(c => !CLOSED.includes(c.status));
  const bySymbol = open.filter(c => c.producerSymbol !== null && symbolKeys.includes(c.producerSymbol));
  const byPeople = sessionIds.length > 1 ? open.filter(c => sessionIds.every(id => c.participants.includes(id))) : [];
  const newest = (list: Contract[]) => [...list].sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
  return newest(bySymbol) ?? newest(byPeople);
}

/**
 * The one finding the Overview leads with, by kind: claim violations and code that does not compile first,
 * then incompatible assumptions and dependent writes, then anything else, informational candidates last.
 */
export function currentConflict(
  snapshot: ServiceSnapshot,
  sessionName: (id: string) => string,
  runsFor: (contractId: string) => VerificationRun[],
  viewer: ViewerContext | null = null,
): ConflictView | null {
  const primary = pickPrimary(snapshot.findings);
  if (!primary) return null;
  const informational = primary.severity === 'info';

  const sessionIds = unique(primary.sessions);
  const touches = (f: Finding) => f.sessions.some(s => sessionIds.includes(s));
  const related = informational ? [] : snapshot.findings.filter(f => f !== primary && f.severity !== 'info' && touches(f));
  const all = [primary, ...related].sort((a, b) => findingRank(a) - findingRank(b));

  const mismatch = all.find(f => f.kind === 'assumption_mismatch') ?? null;
  const disagreement = mismatch ? disagreementOf(snapshot, mismatch) : null;
  const dependentFinding = all.find(f => f.kind === 'dependent_write') ?? null;
  const dependency = dependentFinding ? dependencyOf(dependentFinding) : null;

  const symbolKeys = unique([...all.flatMap(f => f.symbols ?? []), ...(dependency?.symbol.includes('#') ? [dependency.symbol] : [])]);
  // An assumption key (getPrice:unit) and the symbol (getPrice:function) name the same code: list it once.
  const symbols = symbolKeys.map(key => { const p = parseSymbolKey(key); return { key, name: p.name, file: p.file }; })
    .filter((s, i, list) => list.findIndex(o => o.name === s.name && o.file === s.file) === i);
  const files = unique([...symbols.map(s => s.file), ...all.flatMap(f => f.files ?? [])]).filter(Boolean);

  const contract = informational ? null : relatedContract(snapshot.contracts, symbolKeys, sessionIds);
  const observed = contract ? runsFor(contract.id) : [];
  const runs = observed.length ? observed : contract?.evidence.verification ? [contract.evidence.verification] : [];
  const byTime = [...runs].sort((a, b) => a.at - b.at);
  const appliedRun = byTime.filter(r => !r.overlay).at(-1) ?? null;
  const overlayPass = byTime.filter(r => r.overlay && r.passed).at(-1) ?? null;
  const problem = appliedRun ? runProblem(appliedRun) : null;

  const subject = disagreement?.name ?? symbols[0]?.name ?? files[0] ?? 'shared code';
  const people = sessionIds.length === 2 ? 'Two agents' : sessionIds.length === 1 ? 'An agent' : `${sessionIds.length} agents`;
  const tone: ConflictTone = informational ? 'neutral' : primary.severity === 'error' || findingRank(primary) === 0 ? 'danger' : 'warning';

  let title: string;
  switch (primary.kind) {
    case 'assumption_mismatch': {
      const who = disagreement ? disagreement.values.map(v => splitName(sessionName(v.sessionId))) : [];
      const sameMember = who.length === 2 && who[0]!.memberName === who[1]!.memberName;
      const names = who.length === 2 ? (sameMember ? `The ${who[0]!.agentName} and the ${who[1]!.agentName}` : `${who[0]!.memberName} and ${who[1]!.memberName}`) : people;
      title = `${names} expect a different ${disagreement?.attribute ?? 'behavior'} from ${subject}`;
      break;
    }
    case 'dependent_write': title = `A change to ${subject} reaches code another agent depends on`; break;
    case 'claim_violation': title = `A claim on ${subject} is no longer true`; break;
    case 'structural_incompatibility': title = `A staged change to ${subject} does not compile`; break;
    case 'direct_edit': title = `${files[0] ?? 'A file'}${files.length > 1 ? ` and ${files.length - 1} more` : ''} changed outside Hive`; break;
    default: title = `${people} ${sessionIds.length === 1 ? 'is' : 'are'} working on ${subject} at the same time`;
  }

  // Deterministic explanation: what each side declared, what the compiler proves, what the last run showed.
  const sentences: string[] = [];
  if (disagreement && disagreement.values.length >= 2) {
    const [a, b] = disagreement.values as [{ sessionId: string; value: string }, { sessionId: string; value: string }];
    sentences.push(`${possessiveName(sessionName(a.sessionId))} expects the ${disagreement.attribute} of ${disagreement.name} to be ${a.value}; ${possessiveName(sessionName(b.sessionId))} expects ${b.value}.`);
  }
  if (dependency) {
    const name = parseSymbolKey(dependency.symbol).name || dependency.file;
    const target = parseSymbolKey(dependentFinding?.symbols?.[0] ?? '').name || subject;
    sentences.push(`The compiler shows ${name} in ${dependency.file} depends on ${target}, so a change on one side reaches the other.`);
  }
  if (problem) sentences.push(problem);
  if (!sentences.length) sentences.push(primary.evidence.replace(SESSION_ID, id => sessionName(id)));
  if (informational) sentences.push('This is a candidate for review, not a proven conflict.');

  // Evidence list: one line per finding, plus the failing run when there is one.
  const evidence: EvidenceItem[] = all.map((f, i) => ({ id: `${f.kind}-${i}`, label: KIND_LABEL[f.kind], source: SOURCE_LABEL[f.source], parts: evidenceParts(f, sessionName, snapshot) }));
  if (appliedRun && problem) {
    const line = failureLine(appliedRun.output);
    const outcome = appliedRun.exitCode === null ? ` ${appliedRun.status}` : ` exited ${appliedRun.exitCode}`;
    evidence.push({
      id: `run-${appliedRun.id}`,
      label: appliedRun.status === 'inconclusive' ? 'Inconclusive test run' : 'Failing test run',
      source: 'From verification',
      parts: [{ code: appliedRun.command }, `${outcome} at revision ${appliedRun.revision}`, ...(line ? [': ', { code: line }] : [])],
    });
  }

  const status = contractStatus(contract, appliedRun, problem);
  const chip = status?.chip ?? (tone === 'danger' ? 'Conflict' : tone === 'warning' ? 'Needs coordination' : 'For review');

  return {
    primary, sessionIds, tone: status?.tone ?? tone, chip,
    eyebrow: status?.eyebrow ?? (informational ? 'Worth a look' : 'Current conflict'),
    title, summary: sentences.join(' '), evidence, symbols, files, contract, appliedRun, overlayPass,
    model: modelViewFor(snapshot, sessionIds, viewer),
  };
}

/**
 * Chip and eyebrow from the linked agreement, when there is one. The findings stay after both sides sign, so
 * the at-a-glance line follows the agreement: signatures still missing, signed with a check that has not
 * passed, or verified. Null leaves the finding-based chip in place.
 */
export function contractStatus(contract: Contract | null, appliedRun: VerificationRun | null, problem: string | null):
  { chip: string; eyebrow: string; tone: ConflictTone } | null {
  if (!contract) return null;
  switch (contract.status) {
    case 'proposed': return { chip: 'Waiting for signatures', eyebrow: 'Current conflict', tone: 'warning' };
    case 'verified': return { chip: 'Resolved', eyebrow: 'Verified on applied code', tone: 'success' };
    case 'stale': return { chip: 'Agreement out of date', eyebrow: 'Current conflict', tone: 'warning' };
    case 'accepted':
    case 'implemented':
      if (appliedRun && problem) {
        const chip = appliedRun.status === 'inconclusive' ? 'Agreed · check inconclusive' : 'Agreed · check failing';
        return { chip, eyebrow: 'Unresolved check', tone: 'warning' };
      }
      if (appliedRun?.status === 'running') return { chip: 'Agreed · check running', eyebrow: 'Waiting on verification', tone: 'neutral' };
      return { chip: 'Agreed · not verified', eyebrow: 'Waiting on verification', tone: 'neutral' };
    default: return null;
  }
}

function evidenceParts(f: Finding, sessionName: (id: string) => string, snapshot: ServiceSnapshot): Part[] {
  if (f.kind === 'assumption_mismatch') {
    const d = disagreementOf(snapshot, f);
    if (d && d.values.length >= 2) {
      const [a, b] = d.values as [{ sessionId: string; value: string }, { sessionId: string; value: string }];
      return [`${sessionName(a.sessionId)} expects `, { code: a.value }, `, ${sessionName(b.sessionId)} expects `, { code: b.value }, ' for ', { code: d.key }];
    }
  }
  if (f.kind === 'dependent_write') {
    const dep = dependencyOf(f);
    const target = f.symbols?.[0] ? parseSymbolKey(f.symbols[0]).name : null;
    if (dep && target) {
      const from = dep.symbol.includes('#') ? parseSymbolKey(dep.symbol).name : dep.file;
      return [{ code: from }, ' in ', { code: dep.line ? `${dep.file}:${dep.line}` : dep.file }, ' uses ', { code: target }, ', which another agent is changing'];
    }
  }
  // Fallback: the raw evidence with session ids replaced by names. Still plain text.
  return [f.evidence.replace(SESSION_ID, id => sessionName(id))];
}
