/**
 * Evaluation harness for docs/ACCEPTANCE.md. Runs each scenario on a fresh temp copy of
 * fixtures/billing, N repeats, and writes evaluation/results-<timestamp>.{json,md}.
 *
 * SCRIPTED: no live coding agents. File edits are performed by this harness. Numbers are measured,
 * never estimated; anything that cannot be measured is written as "n/a (<reason>)".
 *
 *   npm run evaluate -- --repeats 3
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Finding, IntentInput } from '../src/domain/types.ts';
import { AnalysisInvalid, AnalysisUnavailable, type Analysis, type Analyzer } from '../src/intelligence/types.ts';
import { assertionLine, CHANGE_SIGNATURE, DECLARATION, EDITS, INTENTS, INVOICE_TEST_ARGS, PRODUCER, runNode, TEST_COMMAND, typeCheck, workspace, type TypeDiagnostic, type Workspace } from './lib.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

function parseRepeats(argv: string[]): number {
  const index = argv.findIndex(a => a === '--repeats' || a.startsWith('--repeats='));
  if (index < 0) return 3;
  const raw = argv[index]!.includes('=') ? argv[index]!.split('=')[1] : argv[index + 1];
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`--repeats must be a positive integer, got ${String(raw)}`);
  return value;
}

interface Outcome {
  detected: string;
  falseAlert: string;
  integration: string;
  cost: string;
  /** Did the observed behavior match what the scenario is meant to show? */
  expected: boolean;
  expectation: string;
  inputs: Record<string, unknown>;
  evidence: Record<string, unknown>;
}
interface ResultRow extends Outcome { scenario: string; mode: 'hive' | 'no-hive'; run: number; latencyMs: number | null; latency: string; error: string | null }
interface Scenario { name: string; mode: 'hive' | 'no-hive'; run(): Promise<Outcome> }

const warnings = (findings: Finding[]) => findings.filter(f => f.severity !== 'info');
const summarize = (findings: Finding[]) => findings.map(f => ({ kind: f.kind, severity: f.severity, source: f.source, sessions: f.sessions, evidence: f.evidence }));
const diagSummary = (d: TypeDiagnostic[]) => d.map(x => `${x.file}:${x.line} TS${x.code} ${x.message}`);
function newDiagnostics(baseline: TypeDiagnostic[], after: TypeDiagnostic[]): TypeDiagnostic[] {
  const key = (d: TypeDiagnostic) => `${d.file}|${d.code}|${d.message}`;
  const seen = new Set(baseline.map(key));
  return after.filter(d => !seen.has(key(d)));
}
function analysisCost(analysis: Analysis): string {
  if (analysis.status === 'ok' && analysis.usage) return `${analysis.usage.totalTokens ?? 'n/a'} tokens (prompt ${analysis.usage.promptTokens ?? 'n/a'}, completion ${analysis.usage.completionTokens ?? 'n/a'}); dollars not estimated`;
  if (analysis.attempts === 0) return `0 (no model call: ${analysis.status})`;
  return `n/a (${analysis.attempts} model attempt(s), status ${analysis.status}, no usage returned)`;
}
function register(ws: Workspace, agents: Record<string, IntentInput>): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const [name, intent] of Object.entries(agents)) {
    const session = ws.service.coordinator.register(`${name} agent`);
    ws.service.coordinator.setIntent(session.id, intent);
    ids[name] = session.id;
  }
  return ids;
}
/** Integration check for scenarios that do not touch pricing: whole-project type-check + the invoice behavior test. */
function controlIntegration(ws: Workspace, baseline: TypeDiagnostic[]) {
  const added = newDiagnostics(baseline, typeCheck(ws.service));
  const test = runNode(ws.dir, INVOICE_TEST_ARGS);
  const passed = added.length === 0 && test.exitCode === 0;
  return { passed, text: passed ? 'yes (0 new type errors; invoice test exit 0)' : `no (${added.length} new type errors; invoice test exit ${test.exitCode})`,
    evidence: { newDiagnostics: diagSummary(added), command: test.command, exitCode: test.exitCode, output: test.output.slice(-2000) } };
}

// ---- scenarios -----------------------------------------------------------------------------------

const unitMismatchHive: Scenario = { name: 'Unit mismatch (cents vs dollars)', mode: 'hive', async run() {
  const ws = workspace('hive-eval-');
  try {
    const { service } = ws;
    const baseline = typeCheck(service);
    const ids = register(ws, INTENTS);
    const before = service.snapshot().findings;
    const detected = before.some(f => f.kind === 'assumption_mismatch') && before.some(f => f.kind === 'dependent_write' && f.symbols?.includes(PRODUCER));
    const analysis = await service.analyze(ids.pricing!);
    const contract = service.propose(ids.pricing!, { title: 'Explicit unit parameter on getPrice', declaration: DECLARATION, participants: [ids.invoice!], producerSymbol: PRODUCER });
    ws.write('src/invoice.ts', EDITS.consumerAdapted);
    const check = service.contractCheck(ids.invoice!, contract.id);
    const gated = service.preview(ids.pricing!, CHANGE_SIGNATURE);
    service.coordinator.acknowledge(ids.invoice!, contract.id, contract.version);
    service.coordinator.acknowledge(ids.pricing!, contract.id, contract.version);
    const acceptedStatus = service.coordinator.contract(contract.id).status;
    const preview = service.preview(ids.pricing!, CHANGE_SIGNATURE);
    const applied = preview.status === 'previewed' ? service.apply(ids.pricing!, preview.proposalId) : null;
    const implementedStatus = service.coordinator.contract(contract.id).status;
    const failing = service.verify(ids.pricing!, contract.id, TEST_COMMAND);
    ws.write('src/pricing.ts', EDITS.producerBody);
    ws.write('src/button.ts', EDITS.uiLabel);
    const after = service.snapshot().findings;
    const passing = service.verify(ids.pricing!, contract.id, TEST_COMMAND);
    const final = service.coordinator.contract(contract.id);
    const added = newDiagnostics(baseline, typeCheck(service));
    const uiAlerts = warnings([...before, ...after]).filter(f => f.sessions.includes(ids.ui!));
    const integrationOk = passing.passed && final.status === 'verified' && added.length === 0;
    const gateOk = gated.status === 'rejected' && acceptedStatus === 'accepted' && applied?.status === 'applied' && implementedStatus === 'implemented' && !failing.passed;
    return {
      detected: detected ? 'yes (assumption_mismatch + compiler dependent_write, before any edit)' : 'no',
      falseAlert: uiAlerts.length ? `yes (${uiAlerts.length} warning(s) on the unrelated UI agent)` : 'no (UI agent: 0 warnings)',
      integration: integrationOk ? `yes (${TEST_COMMAND} exit ${passing.exitCode}; contract verified; 0 new type errors)` : `no (exit ${passing.exitCode}; contract ${final.status}; ${added.length} new type errors)`,
      cost: analysisCost(analysis),
      expected: detected && uiAlerts.length === 0 && integrationOk && gateOk,
      expectation: 'conflict detected before edits; gate rejects pre-agreement change; first verify fails (19.99 !== 1999); verified after body fix; UI agent never warned',
      inputs: { intents: INTENTS, declaration: DECLARATION, operation: CHANGE_SIGNATURE, verifyCommand: TEST_COMMAND, edits: { 'src/invoice.ts': EDITS.consumerAdapted, 'src/pricing.ts': EDITS.producerBody, 'src/button.ts': EDITS.uiLabel } },
      evidence: { findingsBeforeEdits: summarize(before), findingsAfterEdits: summarize(after),
        analysis: { status: analysis.status, model: analysis.model, error: analysis.error, usage: analysis.usage, attempts: analysis.attempts, findings: analysis.findings.length },
        overlayCheckAtProposal: contract.evidence.overlayCheck, consumerCheck: { overlayOk: check.overlay?.ok ?? null, realOk: check.real?.ok ?? null, implementation: check.implementation.reason },
        gateBeforeAcceptance: { status: gated.status, rejections: gated.rejections }, statusAfterAcknowledgements: acceptedStatus,
        apply: applied ? { status: applied.status, revision: applied.revision, changedFiles: applied.changedFiles } : { status: 'not attempted', rejections: preview.rejections }, diff: preview.diff,
        statusAfterApply: implementedStatus,
        firstVerify: { command: failing.command, exitCode: failing.exitCode, passed: failing.passed, revision: failing.revision, assertion: assertionLine(failing.output), output: failing.output.slice(-2000) },
        secondVerify: { command: passing.command, exitCode: passing.exitCode, passed: passing.passed, revision: passing.revision, sourceHashes: passing.sourceHashes, output: passing.output.slice(-2000) },
        finalContractStatus: final.status, finalRevision: service.coordinator.revision(), newTypeDiagnostics: diagSummary(added) },
    };
  } finally { ws.cleanup(); }
} };

/** Control: identical producer edit (signature + body), consumer left calling getPrice(); no coordination layer involved. */
const unitMismatchNoHive: Scenario = { name: 'Unit mismatch (cents vs dollars)', mode: 'no-hive', async run() {
  const ws = workspace('hive-eval-');
  try {
    const baseline = typeCheck(ws.service);
    ws.write('src/pricing.ts', EDITS.producerBody);
    ws.write('src/button.ts', EDITS.uiLabel);
    const added = newDiagnostics(baseline, typeCheck(ws.service));
    const test = runNode(ws.dir, TEST_COMMAND.split(' ').slice(1));
    const passed = added.length === 0 && test.exitCode === 0;
    return {
      detected: 'no (control: no coordination layer; nothing ran before integration)',
      falseAlert: 'n/a (no detector in this mode)',
      integration: passed ? `yes (test exit ${test.exitCode}; 0 new type errors)` : `no (${added.length} new type errors in ${[...new Set(added.map(d => d.file))].join(', ') || '-'}; ${TEST_COMMAND} exit ${test.exitCode})`,
      cost: '0 (no model call)',
      expected: !passed && added.some(d => d.file === 'src/invoice.ts'),
      expectation: 'consumer still calls getPrice() after the producer requires a unit: type errors in invoice.ts at integration time',
      inputs: { edits: { 'src/pricing.ts': EDITS.producerBody, 'src/button.ts': EDITS.uiLabel }, untouched: ['src/invoice.ts'], verifyCommand: TEST_COMMAND, typeCheck: 'service.graph().openProject().getPreEmitDiagnostics()' },
      evidence: { newTypeDiagnostics: diagSummary(added), test: { command: test.command, exitCode: test.exitCode, assertion: assertionLine(test.output), output: test.output.slice(-2000) },
        note: 'Node strips types at runtime, so getPrice() with no unit falls through to dollars and the behavior test can still pass; the breakage is a compile-time error.' },
    };
  } finally { ws.cleanup(); }
} };

/** Control: the producer switches the unit without changing the signature. The compiler cannot see this. */
const silentUnitNoHive: Scenario = { name: 'Unit mismatch, signature unchanged', mode: 'no-hive', async run() {
  const ws = workspace('hive-eval-');
  try {
    const baseline = typeCheck(ws.service);
    ws.write('src/pricing.ts', EDITS.producerSilentCents);
    const added = newDiagnostics(baseline, typeCheck(ws.service));
    const test = runNode(ws.dir, TEST_COMMAND.split(' ').slice(1));
    const passed = added.length === 0 && test.exitCode === 0;
    return {
      detected: 'no (control: no coordination layer; type-check sees nothing)',
      falseAlert: 'n/a (no detector in this mode)',
      integration: passed ? `yes (test exit ${test.exitCode}; 0 new type errors)` : `no (${added.length} new type errors; ${TEST_COMMAND} exit ${test.exitCode}: ${assertionLine(test.output) ?? 'see output'})`,
      cost: '0 (no model call)',
      expected: !passed && added.length === 0 && test.exitCode !== 0,
      expectation: 'type-check passes but the invoice prints $1999.00: only the behavior test catches it',
      inputs: { edits: { 'src/pricing.ts': EDITS.producerSilentCents }, verifyCommand: TEST_COMMAND },
      evidence: { newTypeDiagnostics: diagSummary(added), test: { command: test.command, exitCode: test.exitCode, assertion: assertionLine(test.output), output: test.output.slice(-2000) } },
    };
  } finally { ws.cleanup(); }
} };

const noConflictControl: Scenario = { name: 'No-conflict control (UI label only)', mode: 'hive', async run() {
  const ws = workspace('hive-eval-');
  try {
    const { service } = ws;
    const baseline = typeCheck(service);
    const agents = { invoice: INTENTS.invoice, ui: INTENTS.ui };
    register(ws, agents);
    const before = service.snapshot().findings;
    ws.write('src/button.ts', EDITS.uiLabel);
    const after = service.snapshot().findings;
    const alerts = warnings([...before, ...after]);
    const integration = controlIntegration(ws, baseline);
    return {
      detected: 'n/a (nothing to detect)',
      falseAlert: alerts.length ? `yes (${alerts.length} warning/error finding(s))` : `no (0 warnings; info only: ${[...new Set([...before, ...after].map(f => f.kind))].join(', ') || 'none'})`,
      integration: integration.text,
      cost: '0 (no model call)',
      expected: alerts.length === 0 && integration.passed,
      expectation: 'zero warning/error findings for unrelated work',
      inputs: { intents: agents, edits: { 'src/button.ts': EDITS.uiLabel }, integrationCheck: ['type-check', `node ${INVOICE_TEST_ARGS.join(' ')}`] },
      evidence: { findingsBefore: summarize(before), findingsAfter: summarize(after), integration: integration.evidence, revision: service.coordinator.revision() },
    };
  } finally { ws.cleanup(); }
} };

const harmlessOverlap: Scenario = { name: 'Harmless overlap (same file, no assumptions)', mode: 'hive', async run() {
  const ws = workspace('hive-eval-');
  try {
    const { service } = ws;
    const baseline = typeCheck(service);
    const agents = {
      'label': { task: 'Change button label', files: ['src/button.ts'], symbols: [], assumptions: [] },
      'docs': { task: 'Add a doc comment to button.ts', files: ['src/button.ts'], symbols: [], assumptions: [] },
    } satisfies Record<string, IntentInput>;
    register(ws, agents);
    const findings = service.snapshot().findings;
    ws.write('src/button.ts', EDITS.uiLabel);
    ws.write('src/button.ts', `/** Label shown on the export button. */\n${ws.read('src/button.ts')}`);
    const after = service.snapshot().findings;
    const overlap = findings.filter(f => f.kind === 'file_overlap' || f.kind === 'symbol_overlap');
    const alerts = warnings([...findings, ...after]);
    const integration = controlIntegration(ws, baseline);
    return {
      detected: overlap.length ? `yes (${overlap.map(f => `${f.kind}/${f.severity}`).join(', ')})` : 'no (overlap not reported)',
      falseAlert: alerts.length ? `yes (${alerts.length} warning/error finding(s))` : 'no (overlap stays info)',
      integration: integration.text,
      cost: '0 (no model call)',
      expected: overlap.length > 0 && overlap.every(f => f.severity === 'info') && alerts.length === 0 && integration.passed,
      expectation: 'overlap reported as info only, never as a warning',
      inputs: { intents: agents, edits: ['src/button.ts label change', 'src/button.ts doc comment'], integrationCheck: ['type-check', `node ${INVOICE_TEST_ARGS.join(' ')}`] },
      evidence: { findingsBefore: summarize(findings), findingsAfter: summarize(after), integration: integration.evidence, revision: service.coordinator.revision() },
    };
  } finally { ws.cleanup(); }
} };

const directEdit: Scenario = { name: 'Direct edit bypassing Hive', mode: 'hive', async run() {
  const ws = workspace('hive-eval-');
  try {
    const { service } = ws;
    const baseline = typeCheck(service);
    const agents = { invoice: INTENTS.invoice, ui: INTENTS.ui };
    const ids = register(ws, agents);
    service.snapshot(); // index the workspace first so the next change is a detectable drift
    const revisionBefore = service.coordinator.revision();
    ws.write('src/button.ts', EDITS.uiLabel); // bypasses Hive: no operation, no preview
    const after = service.snapshot().findings;
    const label = after.filter(f => f.kind === 'direct_edit' && f.files?.includes('src/button.ts'));
    const events = service.coordinator.events(0, 500).filter(e => e.type === 'direct_edit');
    const alerts = warnings(after);
    const integration = controlIntegration(ws, baseline);
    const ok = label.length > 0 && label.every(f => f.severity === 'info') && label.some(f => f.sessions.includes(ids.ui!)) && /detected/.test(label[0]?.evidence ?? '');
    return {
      detected: ok ? `yes (direct_edit/info after the fact; revision ${revisionBefore} -> ${service.coordinator.revision()})` : 'no',
      falseAlert: alerts.length ? `yes (${alerts.length} warning/error finding(s))` : 'no',
      integration: integration.text,
      cost: '0 (no model call)',
      expected: ok && alerts.length === 0 && integration.passed,
      expectation: 'edit outside Hive is labelled direct_edit (detected afterwards, not prevented)',
      inputs: { intents: agents, edits: { 'src/button.ts': EDITS.uiLabel }, integrationCheck: ['type-check', `node ${INVOICE_TEST_ARGS.join(' ')}`] },
      evidence: { directEditFindings: summarize(label), events: events.map(e => ({ type: e.type, detail: e.detail, payload: e.payload })), integration: integration.evidence },
    };
  } finally { ws.cleanup(); }
} };

function modelFailure(name: string, analyzer: Analyzer, status: 'unavailable' | 'invalid', description: string): Scenario {
  return { name, mode: 'hive', async run() {
    const ws = workspace('hive-eval-', analyzer);
    try {
      const { service } = ws;
      const ids = register(ws, INTENTS);
      const analysis = await service.analyze(ids.pricing!);
      const deterministic = service.snapshot().findings;
      const explicit = analysis.status === status && Boolean(analysis.error);
      return {
        detected: explicit ? `yes (status ${analysis.status}: ${analysis.error})` : `no (status ${analysis.status})`,
        falseAlert: analysis.findings.length ? `yes (${analysis.findings.length} model finding(s) despite failure)` : 'no (0 model findings; not reported as "no conflict")',
        integration: 'n/a (analysis-only scenario; no code edits)',
        cost: '0 (fake analyzer injected; no model call)',
        expected: explicit && analysis.findings.length === 0 && deterministic.some(f => f.kind === 'assumption_mismatch'),
        expectation: `${description} yields explicit '${status}'; deterministic findings unaffected`,
        inputs: { intents: INTENTS, analyzer: description },
        evidence: { analysis: { status: analysis.status, error: analysis.error, attempts: analysis.attempts, findings: analysis.findings.length, inputHash: analysis.inputHash, revision: analysis.revision },
          deterministicFindings: summarize(deterministic) },
      };
    } finally { ws.cleanup(); }
  } };
}
const modelTimeout = modelFailure('Model timeout', { analyze: async () => { throw new AnalysisUnavailable('simulated timeout', 3); } }, 'unavailable', 'injected analyzer throwing AnalysisUnavailable("simulated timeout", 3)');
const modelMalformed = modelFailure('Model malformed output', { analyze: async () => { throw new AnalysisInvalid('simulated malformed JSON: Unexpected token } in JSON', 1); } }, 'invalid', 'injected analyzer throwing AnalysisInvalid("simulated malformed JSON")');

const SCENARIOS: Scenario[] = [unitMismatchHive, unitMismatchNoHive, silentUnitNoHive, noConflictControl, harmlessOverlap, directEdit, modelTimeout, modelMalformed];

// ---- run -----------------------------------------------------------------------------------------

const repeats = parseRepeats(process.argv.slice(2));
const startedAt = new Date();
const rows: ResultRow[] = [];
process.stderr.write(`SCRIPTED EVALUATION — no live coding agents; edits are performed by the harness. ${SCENARIOS.length} scenarios x ${repeats} repeat(s).\n`);
for (let run = 1; run <= repeats; run++) {
  for (const scenario of SCENARIOS) {
    const t0 = performance.now();
    try {
      const outcome = await scenario.run();
      const latencyMs = Math.round(performance.now() - t0);
      rows.push({ scenario: scenario.name, mode: scenario.mode, run, latencyMs, latency: `${latencyMs} ms`, error: null, ...outcome });
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      rows.push({ scenario: scenario.name, mode: scenario.mode, run, latencyMs: null, latency: 'n/a (scenario threw)', error: message,
        detected: 'n/a (error)', falseAlert: 'n/a (error)', integration: 'n/a (error)', cost: 'n/a (error)', expected: false, expectation: '', inputs: {}, evidence: {} });
    }
    const last = rows.at(-1)!;
    process.stderr.write(`  run ${run} ${scenario.mode.padEnd(7)} ${scenario.name}: ${last.expected ? 'as expected' : 'UNEXPECTED'} (${last.latency})\n`);
  }
}

const git = spawnSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
const meta = {
  label: 'SCRIPTED EVALUATION — no live coding agents; file edits performed by demo/evaluate.ts on temp copies of fixtures/billing',
  startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), repeats,
  node: process.version, platform: `${process.platform}-${process.arch}`,
  repoRevision: git.status === 0 ? git.stdout.trim() : 'n/a (not a git repository)',
  model: { configured: Boolean(process.env.MODEL_API_KEY), model: process.env.HIVE_MODEL ?? 'muse-spark-1.3 (default)', note: 'model analysis only runs in the unit-mismatch hive scenario and only when MODEL_API_KEY is set' },
  latencyDefinition: 'wall-clock ms for the whole scenario (temp copy, indexing, checks, test subprocesses, cleanup)',
  costDefinition: 'model tokens from analysis.usage when a real call ran; dollars are never estimated',
};
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const header = '| Scenario | Mode | Run | Detected? | False alert? | Integration passed? | Latency | Cost |\n|---|---|---|---|---|---|---|---|';
const table = [header, ...rows.map(r => `| ${[r.scenario, r.mode, String(r.run), r.detected, r.falseAlert, r.integration, r.latency, r.cost].map(cell).join(' | ')} |`)].join('\n');
const unexpected = rows.filter(r => !r.expected);
const markdown = [
  '# Hive evaluation results', '',
  `> ${meta.label}.`, '',
  `- Started: ${meta.startedAt}; repeats: ${repeats}; Node ${meta.node} on ${meta.platform}; repo revision: ${meta.repoRevision}`,
  `- Model: ${meta.model.configured ? `configured (${meta.model.model})` : 'not configured (MODEL_API_KEY unset) — no model calls were made'}`,
  `- Latency: ${meta.latencyDefinition}. Cost: ${meta.costDefinition}.`,
  '- Integration check: unit-mismatch rows run `node --test tests/pricing.test.ts` plus a whole-project compiler type-check; other rows run the type-check plus the invoice behavior test only (the cents test encodes the unit-change target, which those scenarios do not touch).',
  '', table, '',
  unexpected.length ? `**${unexpected.length} row(s) did not match the scenario expectation:** ${unexpected.map(r => `${r.scenario}/${r.mode}/run ${r.run}${r.error ? ` (error: ${r.error.split('\n')[0]})` : ''}`).join('; ')}` : 'All rows matched their stated expectation (see `expectation` per row in the JSON).',
  '', `Raw inputs, findings, diffs, command outputs and source hashes: see the JSON file with the same timestamp.`, '',
].join('\n');

const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
const outDir = join(ROOT, 'evaluation');
mkdirSync(outDir, { recursive: true });
const jsonPath = join(outDir, `results-${stamp}.json`);
const mdPath = join(outDir, `results-${stamp}.md`);
writeFileSync(jsonPath, `${JSON.stringify({ meta, rows }, null, 2)}\n`);
writeFileSync(mdPath, markdown);
process.stdout.write(`${table}\n\n`);
process.stdout.write(`Wrote ${jsonPath}\nWrote ${mdPath}\n`);
if (unexpected.length) {
  process.stdout.write(`${unexpected.length} row(s) did not match expectation.\n`);
  process.exit(1);
}
