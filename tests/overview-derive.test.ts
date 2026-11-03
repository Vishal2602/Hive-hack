// Overview derivations (web/src/screens/overview/derive.ts) on live-shaped data: which finding leads the
// hero, how evidence strings from the daemon are read, which agreement and run back the conflict, and
// how model attribution is worded for every analysis status. Viewer data goes through the real adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Contract, Finding, VerificationRun } from '../src/domain/types.ts';
import type { Analysis } from '../src/intelligence/types.ts';
import type { ServiceSnapshot } from '../src/service.ts';
import { viewToSnapshot } from '../web/src/api/adapt.ts';
import type { ViewResponse } from '../web/src/api/types.ts';
import { agentProgress, coveredBy } from '../web/src/mock/progress.ts';
import {
  currentConflict, dependencyOf, disagreementOf, leaseText, modelViewFor, pickPrimary, relatedContract,
} from '../web/src/screens/overview/derive.ts';

const PRICING = '292bcbcf-0b20-4457-9e16-a4391a4d555e';
const INVOICE = 'bb9b5398-a02c-4f9a-9ec9-9d53ad72b146';
const UI = '9b7e96b6-f392-491f-9f51-10fe4494de1b';
const NAMES: Record<string, string> = { [PRICING]: 'Sanika · pricing agent', [INVOICE]: 'Vishal · invoice agent', [UI]: 'Vishal · UI agent' };
const sessionName = (id: string) => NAMES[id] ?? `session ${id.slice(0, 8)}`;
const noRuns = () => [] as VerificationRun[];

// Evidence strings exactly as src/domain/detect.ts and src/service.ts build them.
const mismatch: Finding = { kind: 'assumption_mismatch', severity: 'warning', sessions: [PRICING, INVOICE], source: 'deterministic',
  symbols: ['src/pricing.ts#getPrice:unit'], evidence: `src/pricing.ts#getPrice:unit: ${PRICING} expects cents; ${INVOICE} expects dollars` };
const dependent: Finding = { kind: 'dependent_write', severity: 'warning', sessions: [PRICING, INVOICE], source: 'compiler',
  symbols: ['src/pricing.ts#getPrice:function'], files: ['src/invoice.ts', 'tests/invoice.test.ts'],
  evidence: `${PRICING} declares work on src/pricing.ts#getPrice:function (getPrice(sku: string, unit: 'cents' | 'dollars'): number); ${INVOICE}'s scope depends on it: src/invoice.ts (src/invoice.ts:1); src/invoice.ts#lineTotal:function (src/invoice.ts:11); tests/invoice.test.ts (tests/invoice.test.ts:5)` };
const directEdit: Finding = { kind: 'direct_edit', severity: 'info', sessions: [INVOICE], source: 'deterministic', files: ['src/invoice.ts', 'tests/invoice.test.ts'],
  evidence: 'Files changed outside Hive operations: src/invoice.ts, tests/invoice.test.ts (detected 2026-11-03T15:06:43.337Z, revision 2)' };
const claim: Finding = { kind: 'claim_violation', severity: 'warning', sessions: [UI], source: 'deterministic', symbols: ['src/ui/button.ts#label:const'],
  evidence: 'Claim "label is Download invoice" no longer holds in src/ui/button.ts' };

const failedRun: VerificationRun = { id: 'run-1', contractId: 'c-1', version: 1, command: 'npm test', status: 'failed', exitCode: 1, passed: false, overlay: false,
  revision: 3, sourceHashes: {}, output: 'not ok 3 - getPrice in cents\n  AssertionError: 19.99 !== 1999\n', reasons: ['exit 1'], at: 1_000, finishedAt: 2_000 };

const contract: Contract = {
  id: 'c-1', version: 1, title: 'Explicit unit parameter on getPrice', ownerSessionId: PRICING, producerSymbol: 'src/pricing.ts#getPrice:function',
  declaration: "export declare function getPrice(sku: string, unit: 'cents' | 'dollars'): number;", behaviorNotes: 'invoices keep printing dollars.',
  participants: [PRICING, INVOICE], acknowledgements: [PRICING, INVOICE],
  acknowledgementDetails: [{ sessionId: INVOICE, version: 1, intentRevision: 1, at: 10 }, { sessionId: PRICING, version: 1, intentRevision: 1, at: 11 }],
  intentRevisions: {}, status: 'implemented',
  evidence: { implemented: { symbol: 'src/pricing.ts#getPrice:function', file: 'src/pricing.ts', declarationHash: 'h', declaration: '', revision: 3, at: 20 }, verification: failedRun },
  history: [], createdAt: 1, updatedAt: 30,
} as Contract;

function snapshot(overrides: Partial<ServiceSnapshot> = {}): ServiceSnapshot {
  return {
    repository: { id: 'r', canonicalRoot: '/tmp/hive-playground', revision: 3 }, workspaces: [],
    sessions: [PRICING, INVOICE, UI].map(id => ({ id, name: NAMES[id]!, workspaceId: 'w', client: 'claude-code', expiresAt: 10_000_000, status: 'active' as const })),
    intents: [
      { sessionId: PRICING, revision: 1, task: 'Return integer cents from getPrice', files: ['src/pricing.ts'], symbols: ['src/pricing.ts#getPrice:function'], assumptions: [{ key: 'src/pricing.ts#getPrice:unit', value: 'cents' }], at: 1 },
      { sessionId: INVOICE, revision: 1, task: 'Add buildReceipt with dollar totals', files: ['src/invoice.ts'], symbols: [], assumptions: [{ key: 'src/pricing.ts#getPrice:unit', value: 'dollars' }], at: 1 },
    ],
    contracts: [contract], findings: [mismatch, dependent, directEdit], events: [],
    graph: { workspaceId: 'w', indexed: true, symbols: 40, edges: 60, files: 8, lastSync: null },
    proposals: [], claims: [], analysis: null, model: { configured: false, model: 'muse-spark-1.3' },
    ...overrides,
  } as ServiceSnapshot;
}

const analysis = (overrides: Partial<Analysis> = {}): Analysis => ({
  id: 'a-1', status: 'ok', summary: 'The pricing and invoice agents disagree on units.', model: 'muse-spark-1.3', latencyMs: 900,
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, attempts: 1, dropped: [], inputHash: 'x', revision: 3, error: null,
  evidenceRefs: { symbols: [], files: [], sessions: [], candidates: 2 }, at: 5,
  findings: [{ sessionIds: [PRICING, INVOICE], kind: 'semantic_conflict', explanation: 'Invoices would print cents as dollars.', evidence: ['src/pricing.ts#getPrice:unit'],
    suggestion: 'Make the unit explicit.', proposedDeclaration: "export declare function getPrice(sku: string, unit: 'cents'): number;", confidence: 'high' }],
  ...overrides,
});

test('hero priority: claim/structural over assumption/dependent over other warnings, info last', () => {
  assert.equal(pickPrimary([]), null);
  assert.equal(pickPrimary([directEdit]), directEdit, 'an informational finding leads only when nothing else exists');
  assert.equal(pickPrimary([directEdit, dependent, mismatch]), dependent, 'equal rank keeps the daemon order');
  assert.equal(pickPrimary([directEdit, mismatch, claim]), claim, 'a broken claim leads even when listed last');
  const structural: Finding = { ...claim, kind: 'structural_incompatibility', severity: 'error' };
  assert.equal(pickPrimary([claim, structural]), structural, 'same rank: error before warning');
  const editWarning: Finding = { ...directEdit, severity: 'warning' };
  assert.equal(pickPrimary([editWarning, mismatch]), mismatch);
  assert.equal(pickPrimary([directEdit, editWarning]), editWarning, 'any warning outranks info');
});

test('reads dependent_write evidence as the daemon writes it, preferring a symbol over a whole file', () => {
  assert.deepEqual(dependencyOf(dependent), { symbol: 'src/invoice.ts#lineTotal:function', file: 'src/invoice.ts', line: 11 });
  const fileOnly: Finding = { ...dependent, evidence: `${PRICING} declares work on x (y); ${INVOICE}'s scope depends on it: src/invoice.ts (src/invoice.ts:1)` };
  assert.deepEqual(dependencyOf(fileOnly), { symbol: 'src/invoice.ts', file: 'src/invoice.ts', line: 1 });
  // Viewer evidence is capped with an ellipsis; a cut-off item is dropped, not misread.
  const truncated: Finding = { ...dependent, evidence: `${PRICING} declares work on x (y); ${INVOICE}'s scope depends on it: src/invoice.ts (src/invoice.ts:1); src/invoice.ts#lineTo…` };
  assert.deepEqual(dependencyOf(truncated), { symbol: 'src/invoice.ts', file: 'src/invoice.ts', line: 1 });
  assert.equal(dependencyOf({ ...dependent, evidence: 'unexpected text' }), null);
});

test('member hero: names, live agreement, failing applied run from contract evidence, deterministic summary', () => {
  const conflict = currentConflict(snapshot(), sessionName, noRuns)!;
  assert.equal(conflict.primary, mismatch);
  // Chip follows the signed, implemented agreement with a failing run (was the finding-based 'Needs coordination').
  assert.equal(conflict.tone, 'warning');
  assert.equal(conflict.chip, 'Agreed · check failing');
  assert.equal(conflict.eyebrow, 'Unresolved check');
  assert.equal(conflict.title, 'Sanika and Vishal expect a different unit from getPrice');
  assert.equal(conflict.contract?.id, 'c-1', 'the agreement on getPrice backs the conflict');
  assert.deepEqual(conflict.symbols.map(s => s.name), ['getPrice', 'lineTotal'], 'getPrice:unit and getPrice:function are listed once');
  assert.equal(conflict.appliedRun?.id, 'run-1', 'falls back to the contract evidence when no runs were observed');
  assert.match(conflict.summary, /Sanika's pricing agent expects the unit of getPrice to be cents; Vishal's invoice agent expects dollars\./);
  assert.match(conflict.summary, /lineTotal in src\/invoice\.ts depends on getPrice/);
  assert.match(conflict.summary, /exited 1 at revision 3/);
  const labels = conflict.evidence.map(e => e.label);
  assert.deepEqual(labels, ['Incompatible assumption', 'Dependent write', 'Failing test run'], 'informational findings stay out of the hero evidence');
  const run = conflict.evidence.at(-1)!.parts;
  assert.deepEqual(run.at(-1), { code: 'AssertionError: 19.99 !== 1999' });
  assert.ok(!JSON.stringify(conflict.evidence).includes(PRICING), 'session ids are replaced by names');
  assert.deepEqual(conflict.model, { kind: 'not_configured' });
});

test('a running or overlay run never counts as a failing applied run', () => {
  const running: VerificationRun = { ...failedRun, id: 'run-2', status: 'running', exitCode: null, at: 3_000, finishedAt: null };
  const overlayPass: VerificationRun = { ...failedRun, id: 'run-3', status: 'passed', exitCode: 0, passed: true, overlay: true, at: 4_000 };
  const conflict = currentConflict(snapshot(), sessionName, () => [failedRun, running, overlayPass])!;
  assert.equal(conflict.appliedRun?.id, 'run-2');
  assert.equal(conflict.overlayPass?.id, 'run-3');
  assert.ok(!conflict.evidence.some(e => e.label === 'Failing test run'));
  assert.doesNotMatch(conflict.summary, /exited/);
});

test('info-only findings lead as a candidate, never as a conflict', () => {
  const conflict = currentConflict(snapshot({ findings: [directEdit] }), sessionName, noRuns)!;
  assert.equal(conflict.tone, 'neutral');
  assert.equal(conflict.chip, 'For review');
  assert.equal(conflict.eyebrow, 'Worth a look');
  assert.equal(conflict.title, 'src/invoice.ts and 1 more changed outside Hive');
  assert.equal(conflict.contract, null);
  assert.match(conflict.summary, /not a proven conflict/);
  assert.equal(currentConflict(snapshot({ findings: [] }), sessionName, noRuns), null);
});

test('related agreement: by producer symbol first, else one shared by the agents, never a closed one', () => {
  const shared = { ...contract, id: 'c-2', producerSymbol: 'src/other.ts#x:function', updatedAt: 99 } as Contract;
  assert.equal(relatedContract([shared, contract], ['src/pricing.ts#getPrice:function'], [PRICING, INVOICE])?.id, 'c-1');
  assert.equal(relatedContract([shared], ['src/pricing.ts#getPrice:function'], [PRICING, INVOICE])?.id, 'c-2');
  assert.equal(relatedContract([{ ...contract, status: 'cancelled' } as Contract], ['src/pricing.ts#getPrice:function'], [PRICING, INVOICE]), null);
  assert.equal(relatedContract([shared], [], [PRICING]), null, 'one agent alone does not make a shared agreement');
});

test('model attribution for every analysis status', () => {
  const configured = { model: { configured: true, model: 'muse-spark-1.3' } };
  const ids = [PRICING, INVOICE];
  assert.equal(modelViewFor(snapshot(configured), ids).kind, 'pending');
  const ok = modelViewFor(snapshot({ ...configured, analysis: analysis() }), ids);
  assert.ok(ok.kind === 'ok' && ok.freshness === 'fresh' && ok.finding.explanation.startsWith('Invoices'));
  const cached = modelViewFor(snapshot({ ...configured, analysis: analysis({ status: 'cached' }) }), ids);
  assert.ok(cached.kind === 'ok' && cached.freshness === 'cached');
  const stale = modelViewFor(snapshot({ ...configured, analysis: analysis({ status: 'stale' }) }), ids);
  assert.ok(stale.kind === 'ok' && stale.freshness === 'stale');
  const moved = modelViewFor(snapshot({ ...configured, analysis: analysis({ revision: 2 }) }), ids);
  assert.ok(moved.kind === 'ok' && moved.freshness === 'stale', 'an answer for an older revision is stale');
  assert.equal(modelViewFor(snapshot({ ...configured, analysis: analysis({ status: 'unavailable', findings: [] }) }), ids).kind, 'unavailable');
  assert.equal(modelViewFor(snapshot({ ...configured, analysis: analysis({ status: 'invalid', findings: [] }) }), ids).kind, 'invalid');
  assert.equal(modelViewFor(snapshot({ ...configured, analysis: analysis() }), [UI]).kind, 'nothing', 'a finding about other agents is not attributed here');
  assert.equal(modelViewFor(snapshot({ analysis: analysis() }), ids).kind, 'not_configured');
});

test('viewer data: same hero from /api/view without assumptions, excerpts or model findings', () => {
  const view: ViewResponse = {
    workspace: { name: 'hive-playground' }, revision: 3, graph: { indexed: true, symbols: 40, files: 8 }, model: { configured: true, model: 'muse-spark-1.3' },
    sessions: [{ id: PRICING, member: 'Sanika', agent: 'pricing agent', task: 'Return integer cents from getPrice', step: 'implemented' },
      { id: INVOICE, member: 'Vishal', agent: 'invoice agent', task: 'Add buildReceipt with dollar totals', step: 'implemented' }],
    members: [{ member: 'Sanika', sessions: 1 }, { member: 'Vishal', sessions: 1 }],
    findings: [mismatch, dependent].map(f => ({ kind: f.kind, severity: f.severity, source: f.source, evidence: f.evidence, sessions: f.sessions, symbols: f.symbols ?? [], files: f.files ?? [] })),
    contracts: [{ id: 'c-1', title: contract.title, version: 1, status: 'implemented', producerSymbol: contract.producerSymbol,
      participants: [{ sessionId: PRICING, member: 'Sanika', agent: 'pricing agent', signedCurrent: true }, { sessionId: INVOICE, member: 'Vishal', agent: 'invoice agent', signedCurrent: true }],
      versions: [{ version: 1, declaration: contract.declaration, at: 1, signedBy: [] }], implemented: { symbol: 'src/pricing.ts#getPrice:function', revision: 3, at: 20 },
      verification: [{ id: 'run-1', version: 1, command: 'npm test', status: 'failed', exitCode: 1, passed: false, revision: 3, at: 1_000, finishedAt: 2_000 }],
      staleReason: null, createdAt: 1, updatedAt: 30 }],
    events: [], analysis: { status: 'cached', summary: 'Units disagree.', model: 'muse-spark-1.3', latencyMs: 900, findings: 1, at: 5 }, cacheAgeMs: 0,
  };
  const lifted = viewToSnapshot(view, [], 0);
  const names = (id: string) => ({ [PRICING]: 'Sanika · pricing agent', [INVOICE]: 'Vishal · invoice agent' } as Record<string, string>)[id] ?? id;
  assert.equal(lifted.intents[0]!.assumptions.length, 0, 'the view carries no assumptions');
  assert.deepEqual(disagreementOf(lifted, lifted.findings[0]!)?.values.map(v => v.value), ['cents', 'dollars'], 'read from the finding text instead');

  const runs = (id: string) => view.contracts.find(c => c.id === id)!.verification.map(r => ({ ...r, contractId: id, overlay: false, sourceHashes: {}, output: '', reasons: [] }) as VerificationRun);
  const conflict = currentConflict(lifted, names, runs, { analysisFindings: 1 })!;
  assert.equal(conflict.title, 'Sanika and Vishal expect a different unit from getPrice');
  assert.equal(conflict.contract?.declaration, contract.declaration);
  const run = conflict.evidence.find(e => e.label === 'Failing test run')!;
  assert.equal(run.parts.length, 2, 'no output excerpt for viewers');
  assert.ok(conflict.model.kind === 'summary' && conflict.model.findings === 1 && conflict.model.freshness === 'cached');
});

test('lease text: minutes, expiry and finished sessions', () => {
  assert.equal(leaseText({ status: 'active', expiresAt: 5 * 60_000 }, 0), '5 min left on lease');
  assert.equal(leaseText({ status: 'active', expiresAt: 61_000 }, 0), '2 min left on lease');
  assert.equal(leaseText({ status: 'active', expiresAt: 30_000 }, 0), 'lease ends in under a minute');
  assert.equal(leaseText({ status: 'active', expiresAt: 0 }, 1), 'lease expired');
  assert.equal(leaseText({ status: 'expired', expiresAt: 10_000_000 }, 0), 'lease expired');
  assert.equal(leaseText({ status: 'finished', expiresAt: 0 }, 1), 'session finished');
});

test('hero chip follows the linked agreement: signatures, failing check, not verified, resolved', () => {
  const withContract = (c: Partial<Contract>) => snapshot({ contracts: [{ ...contract, ...c } as Contract] });
  const proposed = currentConflict(withContract({ status: 'proposed', evidence: {} }), sessionName, noRuns)!;
  assert.equal(proposed.chip, 'Waiting for signatures');
  assert.equal(proposed.eyebrow, 'Current conflict');
  const accepted = currentConflict(withContract({ status: 'accepted', evidence: { verification: failedRun } }), sessionName, noRuns)!;
  assert.equal(accepted.chip, 'Agreed · check failing');
  const unverified = currentConflict(withContract({ status: 'implemented', evidence: {} }), sessionName, noRuns)!;
  assert.equal(unverified.chip, 'Agreed · not verified');
  const passed: VerificationRun = { ...failedRun, status: 'passed', exitCode: 0, passed: true, reasons: [] };
  const verified = currentConflict(withContract({ status: 'verified', evidence: { verification: passed } }), sessionName, noRuns)!;
  assert.equal(verified.chip, 'Resolved');
  assert.equal(verified.tone, 'success');
  assert.deepEqual(verified.evidence.map(e => e.label), ['Incompatible assumption', 'Dependent write'], 'evidence list is unchanged');
  const none = currentConflict(snapshot({ contracts: [] }), sessionName, noRuns)!;
  assert.equal(none.chip, 'Needs coordination', 'without an agreement the chip comes from the finding');
});

test('agent progress on the seeded shape: signed agreement covers its findings; failing check stops at Implemented', () => {
  const seeded = snapshot();
  for (const id of [PRICING, INVOICE]) {
    const p = agentProgress(seeded, id);
    assert.equal(p.step, 5, 'past the agreement step once both signed and it is implemented');
    assert.equal(p.key, 'implemented');
    assert.match(p.reason, /implemented; npm test failed, exit 1 at revision 3/);
    assert.equal(p.failure, 'Check failing');
  }
  assert.equal(coveredBy(mismatch, [contract])?.id, 'c-1', 'getPrice:unit names the same code as getPrice:function');
  assert.equal(coveredBy(dependent, [contract])?.id, 'c-1');
});

test('agent progress: findings stay blocking without a signed agreement that covers them', () => {
  const proposed = agentProgress(snapshot({ contracts: [{ ...contract, status: 'proposed' } as Contract] }), PRICING);
  assert.equal(proposed.key, 'contract_pending');
  const noContract = agentProgress(snapshot({ contracts: [] }), PRICING);
  assert.equal(noContract.key, 'contract_pending');
  assert.match(noContract.reason, /2 findings to resolve/);
  const elsewhere = { ...contract, producerSymbol: 'src/tax.ts#rate:const', evidence: { verification: failedRun } } as Contract;
  assert.equal(agentProgress(snapshot({ contracts: [elsewhere] }), PRICING).key, 'contract_pending', 'an agreement on other code does not cover the finding');
  const errorFinding: Finding = { ...dependent, severity: 'error' };
  assert.equal(agentProgress(snapshot({ findings: [mismatch, errorFinding] }), PRICING).key, 'contract_pending', 'errors are never covered');
  const third: Finding = { ...mismatch, sessions: [PRICING, UI] };
  assert.equal(coveredBy(third, [contract]), null, 'an agent outside the agreement keeps the finding open');
  const passed: VerificationRun = { ...failedRun, status: 'passed', exitCode: 0, passed: true, reasons: [] };
  const verified = agentProgress(snapshot({ contracts: [{ ...contract, status: 'verified', evidence: { verification: passed } } as Contract] }), PRICING);
  assert.equal(verified.key, 'verified');
  const untested = agentProgress(snapshot({ contracts: [{ ...contract, evidence: {} } as Contract] }), PRICING);
  assert.equal(untested.key, 'implemented');
  assert.equal(untested.failure, undefined);
  const overlay = agentProgress(snapshot({ contracts: [{ ...contract, evidence: { verification: { ...failedRun, overlay: true } } } as Contract] }), PRICING);
  assert.equal(overlay.failure, undefined, 'a staged-code run never marks the applied check as failing');
});
