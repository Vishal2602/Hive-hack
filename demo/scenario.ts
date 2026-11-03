/**
 * Scripted replay of the Hive coordination flow on a temp copy of fixtures/billing.
 * No live coding agents: every file edit below is performed by this script and announced as such.
 * Exit code 0 only when every expected state was actually reached.
 */
import type { Finding } from '../src/domain/types.ts';
import { assertionLine, CHANGE_SIGNATURE, DECLARATION, EDITS, INTENTS, PRODUCER, TEST_COMMAND, typeCheck, workspace } from './lib.ts';

const failures: string[] = [];
let step = 0;
const say = (text = '') => process.stdout.write(`${text}\n`);
const heading = (text: string) => { step++; say(); say(`${String(step).padStart(2, ' ')}. ${text}`); };
const detail = (text: string) => say(`      ${text}`);
function expect(condition: boolean, what: string): boolean {
  detail(`${condition ? '[ok]  ' : '[FAIL]'} ${what}`);
  if (!condition) failures.push(`step ${step}: ${what}`);
  return condition;
}
const describe = (f: Finding, names: Record<string, string>) => `${f.severity.toUpperCase()} ${f.kind} (${f.source}) — ${f.sessions.map(s => names[s] ?? s).join(' vs ')}`;
/** Session ids in evidence strings are replaced by agent names for readability. */
const named = (text: string, names: Record<string, string>) => Object.entries(names).reduce((t, [id, name]) => t.split(id).join(name), text);

say('='.repeat(100));
say('SCRIPTED REPLAY — no live coding agents; the file edits below are performed by this script;');
say('model analysis runs only if MODEL_API_KEY is set, otherwise it is reported as unavailable');
say('='.repeat(100));

const ws = workspace('hive-demo-');
const { service } = ws;
try {
  detail(`workspace: temp copy of fixtures/billing at ${ws.dir}`);
  detail(`state: SQLite file ${ws.dbPath}`);

  heading('Three agents register and declare intents');
  const pricing = service.coordinator.register('Pricing agent');
  const invoice = service.coordinator.register('Invoice agent');
  const ui = service.coordinator.register('UI agent');
  const names: Record<string, string> = { [pricing.id]: 'Pricing agent', [invoice.id]: 'Invoice agent', [ui.id]: 'UI agent' };
  service.coordinator.setIntent(pricing.id, INTENTS.pricing);
  service.coordinator.setIntent(invoice.id, INTENTS.invoice);
  service.coordinator.setIntent(ui.id, INTENTS.ui);
  detail(`Pricing agent: "${INTENTS.pricing.task}" — assumes getPrice unit = cents`);
  detail(`Invoice agent: "${INTENTS.invoice.task}" — assumes getPrice unit = dollars`);
  detail(`UI agent:      "${INTENTS.ui.task}" — no shared assumptions`);

  heading('Hive reports findings (deterministic + compiler), before anyone edits code');
  const findings = service.snapshot().findings;
  for (const f of findings) { detail(describe(f, names)); detail(`   evidence: ${named(f.evidence, names)}`); }
  expect(findings.some(f => f.kind === 'assumption_mismatch' && f.sessions.includes(pricing.id) && f.sessions.includes(invoice.id)), 'assumption_mismatch between Pricing and Invoice (cents vs dollars)');
  expect(findings.some(f => f.kind === 'dependent_write' && f.symbols?.includes(PRODUCER)), 'compiler dependent_write: invoice.ts depends on getPrice');
  expect(findings.every(f => !f.sessions.includes(ui.id)), 'UI agent has no findings');

  heading('Model analysis (explicit, cached; never treated as "no conflict" when it cannot run)');
  const analysis = await service.analyze(pricing.id);
  detail(`model: ${service.snapshot().model.model}, configured: ${service.snapshot().model.configured}`);
  detail(`status: ${analysis.status}${analysis.error ? ` — ${analysis.error}` : ''}`);
  if (analysis.summary) detail(`summary: ${analysis.summary}`);
  for (const f of analysis.findings) detail(`model finding: ${f.kind} [${f.confidence}] ${f.explanation}`);
  if (analysis.usage) detail(`usage: ${JSON.stringify(analysis.usage)}; latency ${analysis.latencyMs} ms`);
  expect(['ok', 'cached', 'unavailable', 'invalid'].includes(analysis.status), `analysis reported an explicit status (${analysis.status})`);

  heading('Pricing agent proposes a Ghost Contract (pending interface, not code)');
  const contract = service.propose(pricing.id, { title: 'Explicit unit parameter on getPrice', declaration: DECLARATION, participants: [invoice.id], producerSymbol: PRODUCER,
    behaviorNotes: "getPrice('cents') returns 1999 for a $19.99 item; invoices keep printing $19.99" });
  detail(`contract ${contract.id} v${contract.version}, status: ${contract.status}`);
  detail(`validated declaration: ${contract.declaration}`);
  const overlay = contract.evidence.overlayCheck;
  detail(`overlay type-check of consumers against the promise: ${overlay?.ok ? 'passes' : 'fails'}`);
  for (const d of overlay?.diagnostics.slice(0, 3) ?? []) detail(`   ${d}`);
  expect(contract.status === 'proposed', 'contract is proposed');
  expect(overlay?.ok === false, 'consumer (invoice.ts) currently fails against the overlay — it still calls getPrice()');

  heading('Invoice agent adapts invoice.ts to the promise (EDIT PERFORMED BY THIS SCRIPT)');
  ws.write('src/invoice.ts', EDITS.consumerAdapted);
  detail("invoiceTotal now uses getPrice('cents') / 100; invoiceWithTax uses getPrice('dollars')");

  heading('Contract check for the consumer');
  const check = service.contractCheck(invoice.id, contract.id);
  detail(`against overlay (promised interface): ${check.overlay?.ok ? 'passes' : 'fails'}`);
  detail(`against real code (producer not changed yet): ${check.real?.ok ? 'passes' : 'fails'}`);
  for (const d of check.real?.diagnostics.slice(0, 2) ?? []) detail(`   ${d.file}:${d.line} ${d.message}`);
  detail(`implementation: ${check.implementation.reason}`);
  expect(check.overlay?.ok === true, 'consumer type-checks against the Ghost Contract overlay');
  expect(check.real?.ok === false, 'consumer fails against the real (unchanged) producer');

  heading('Agreement gate: producer tries to change the signature before agreement');
  const blocked = service.preview(pricing.id, CHANGE_SIGNATURE);
  detail(`preview status: ${blocked.status}`);
  for (const r of blocked.rejections) detail(`   rejected: ${named(r, names)}`);
  expect(blocked.status === 'rejected', 'change_signature is rejected while the contract is only proposed');

  heading('Both participants acknowledge the exact version');
  service.coordinator.acknowledge(invoice.id, contract.id, contract.version);
  service.coordinator.acknowledge(pricing.id, contract.id, contract.version);
  const accepted = service.coordinator.contract(contract.id);
  detail(`acknowledged by: ${accepted.acknowledgements.map(id => names[id] ?? id).join(', ')}; status: ${accepted.status}`);
  expect(accepted.status === 'accepted', 'contract is accepted (agreement only — nothing is implemented yet)');

  heading('Producer previews change_signature again (now allowed) and applies it through Hive');
  const preview = service.preview(pricing.id, CHANGE_SIGNATURE);
  detail(`preview status: ${preview.status}; affected files: ${preview.affectedFiles.join(', ')}`);
  for (const line of preview.diff.split('\n')) if (line.trim()) detail(`   ${line}`);
  if (!expect(preview.status === 'previewed', 'preview passes the agreement gate and the diagnostics comparison')) for (const r of preview.rejections) detail(`   rejected: ${r}`);
  const applied = service.apply(pricing.id, preview.proposalId);
  detail(`apply: ${applied.status} at revision ${applied.revision}; changed ${applied.changedFiles.join(', ')}`);
  expect(applied.status === 'applied', 'operation applied by the operation engine');
  const implemented = service.coordinator.contract(contract.id);
  detail(`contract status: ${implemented.status} (signature matches: ${implemented.evidence.implemented?.declaration ?? 'n/a'})`);
  expect(implemented.status === 'implemented', "contract is 'implemented' (structure only)");

  heading(`Verification: ${TEST_COMMAND}`);
  const failing = await service.waitForRun(service.verify(pricing.id, contract.id, TEST_COMMAND).id);
  detail(`exit code ${failing.exitCode}; passed: ${failing.passed}`);
  detail(`assertion: ${assertionLine(failing.output) ?? '(no assertion line found)'}`);
  expect(!failing.passed && failing.exitCode !== 0, 'verification fails: the body still returns 19.99 (dollars), the contract promises 1999 cents');
  expect(service.coordinator.contract(contract.id).status === 'implemented', "contract stays 'implemented', not 'verified'");

  heading('Pricing agent fixes the body (EDIT PERFORMED BY THIS SCRIPT, directly on disk)');
  ws.write('src/pricing.ts', EDITS.producerBody);
  detail("getPrice(unit) returns 1999 for 'cents', 19.99 for 'dollars'");

  heading('UI agent edits src/button.ts (EDIT PERFORMED BY THIS SCRIPT) — independent work proceeds');
  ws.write('src/button.ts', EDITS.uiLabel);
  const afterUi = service.snapshot().findings;
  const uiWarnings = afterUi.filter(f => f.sessions.includes(ui.id) && f.severity !== 'info');
  for (const f of afterUi.filter(f => f.kind === 'direct_edit')) detail(`${describe(f, names)}: ${f.evidence}`);
  expect(uiWarnings.length === 0, 'UI agent has no warnings (only the informational after-the-fact direct_edit label)');

  heading(`Verification again: ${TEST_COMMAND}`);
  const passing = await service.waitForRun(service.verify(pricing.id, contract.id, TEST_COMMAND).id);
  detail(`exit code ${passing.exitCode}; passed: ${passing.passed}`);
  const verified = service.coordinator.contract(contract.id);
  const run = verified.evidence.verification;
  detail(`contract status: ${verified.status}`);
  if (run) {
    detail(`evidence: command "${run.command}", exit ${run.exitCode}, revision ${run.revision}`);
    for (const [file, hash] of Object.entries(run.sourceHashes)) detail(`   ${file} sha256 ${hash.slice(0, 16)}…`);
  }
  expect(passing.passed && passing.exitCode === 0, 'tests pass against real code (no overlay)');
  expect(verified.status === 'verified', "contract is 'verified' with command, exit code, revision and source hashes");
  const types = typeCheck(service);
  expect(types.length === 0, `whole-project type-check clean (${types.length} diagnostics)`);
  expect(/^ok \d+ - invoice keeps rendering dollars/m.test(passing.output), "invoice test passed: renders $19.99 from 1999 cents, not $1999.00");

  say();
  say('-'.repeat(100));
  say(`Agreement accepted:      yes — both participants acknowledged v${contract.version} (an agreement, not proof).`);
  say(`Implementation verified: ${verified.status === 'verified' ? 'yes' : 'NO'} — ${TEST_COMMAND} exit ${passing.exitCode} on real code at revision ${run?.revision ?? '?'}.`);
  say('Limitation: direct edits (the body fix, the UI label) are detected after the fact, not prevented;');
  say('and this replay has no live agents — the script performed every edit.');
} catch (error) {
  failures.push(`unexpected error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
} finally {
  ws.cleanup();
}

if (failures.length) {
  say();
  say(`DEMO FAILED — ${failures.length} expected state(s) not reached:`);
  for (const f of failures) say(`  - ${f}`);
  process.exit(1);
}
say('All expected states reached. Exit 0.');
