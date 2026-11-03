import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toOverlayText, validateDeclaration } from '../src/contracts/overlay.ts';
import { HiveService } from '../src/service.ts';
import { Store } from '../src/store/sqlite.ts';

const fixture = fileURLToPath(new URL('../fixtures/billing/', import.meta.url));
const PRODUCER = 'src/pricing.ts#getPrice:function';
const DECLARATION = "export declare function getPrice(unit: 'cents' | 'dollars'): number;";
const OPERATION = { kind: 'change_signature' as const, symbol: PRODUCER, declaration: "getPrice(unit: 'cents' | 'dollars'): number" };
const TEST_COMMAND = 'node --test tests/pricing.test.ts';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'hive-contracts-'));
  cpSync(fixture, dir, { recursive: true });
  const service = new HiveService({ store: new Store(), root: dir });
  const a = service.coordinator.register('pricing agent');
  const b = service.coordinator.register('invoice agent');
  const c = service.coordinator.register('ui agent');
  service.coordinator.setIntent(a.id, { task: 'Make getPrice explicit about units (cents)', files: ['src/pricing.ts'], symbols: [PRODUCER], assumptions: [{ key: 'src/pricing.ts#getPrice:unit', value: 'cents' }] });
  service.coordinator.setIntent(b.id, { task: 'Export invoices', files: ['src/invoice.ts'], symbols: ['src/invoice.ts#invoiceTotal:function'], assumptions: [{ key: 'src/pricing.ts#getPrice:unit', value: 'dollars' }] });
  service.coordinator.setIntent(c.id, { task: 'Change button label', files: ['src/button.ts'], symbols: ['src/button.ts#buttonLabel:variable'], assumptions: [] });
  const write = (file: string, text: string) => writeFileSync(join(dir, file), text);
  const read = (file: string) => readFileSync(join(dir, file), 'utf8');
  const adaptConsumer = () => write('src/invoice.ts', "import { getPrice } from './pricing.ts';\nimport { applyTax } from './tax.ts';\nexport function invoiceTotal(): string { return `$${(getPrice('cents') / 100).toFixed(2)}`; }\nexport function invoiceWithTax(): number { return applyTax(getPrice('dollars'), 0.2, 'EU'); }\n");
  const implementProducerBody = () => write('src/pricing.ts', "/** Unit is explicit. 'cents' returns integer USD cents. */\nexport function getPrice(unit: 'cents' | 'dollars'): number { return unit === 'cents' ? 1999 : 19.99; }\n");
  // verify() now returns a 'running' run immediately (async verification); these tests assert on the finished run.
  const verify = (sessionId: string, contractId: string, command: string) => service.waitForRun(service.verify(sessionId, contractId, command).id);
  return { dir, service, a, b, c, write, read, verify, adaptConsumer, implementProducerBody, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('declaration validation rejects any, bodies and wrong names; overlay text is ambient', () => {
  assert.equal(validateDeclaration(DECLARATION, PRODUCER).ok, true);
  assert.equal(toOverlayText('function getPrice(): number'), 'export declare function getPrice(): number;');
  assert.equal(toOverlayText('export interface Price { amount: number }'), 'export interface Price { amount: number }');
  assert.match(validateDeclaration('export declare function getPrice(unit: any): number;', PRODUCER).problems.join(), /any/);
  assert.match(validateDeclaration('export function getPrice(): number { return 1 }', PRODUCER).problems.join(), /implementation body/);
  assert.match(validateDeclaration('export declare function price(): number;', PRODUCER).problems.join(), /names price but the producer symbol is getPrice/);
  assert.match(validateDeclaration('export declare function (: number;', PRODUCER).problems.join(), /does not parse/);
});

test('findings: unit mismatch across files, compiler-backed dependent write, and the UI agent is never involved', () => {
  const { service, a, b, c, cleanup } = setup();
  try {
    const findings = service.snapshot().findings;
    assert.ok(findings.some(f => f.kind === 'assumption_mismatch' && f.sessions.includes(a.id) && f.sessions.includes(b.id)));
    const dependent = findings.find(f => f.kind === 'dependent_write');
    assert.ok(dependent, 'compiler edge invoice.ts -> getPrice must produce a dependent_write candidate');
    assert.deepEqual(dependent!.symbols, [PRODUCER]);
    assert.match(dependent!.evidence, /src\/invoice\.ts#invoiceTotal:function/);
    assert.ok(findings.every(f => !f.sessions.includes(c.id)));
  } finally { cleanup(); }
});

test('consumer builds against the overlay while the producer is pending; the real check fails; nothing is verified', async () => {
  const { service, a, b, verify, adaptConsumer, cleanup } = setup();
  try {
    const contract = service.propose(a.id, { title: 'Explicit unit parameter on getPrice', declaration: DECLARATION, participants: [b.id], producerSymbol: PRODUCER, behaviorNotes: "getPrice('cents') returns 1999 for a $19.99 item; invoices keep printing $19.99" });
    assert.equal(contract.status, 'proposed');
    assert.equal(contract.evidence.overlayCheck!.ok, false, 'consumer still calls getPrice() with no argument');
    assert.match(contract.evidence.overlayCheck!.diagnostics.join(), /src\/invoice\.ts.*Expected 1 arguments/);

    adaptConsumer(); // the consumer adopts the promise while the producer is still pending
    const check = service.contractCheck(b.id, contract.id);
    assert.equal(check.overlay!.ok, true, 'consumer type-checks against the Ghost Contract overlay');
    assert.equal(check.real!.ok, false, 'against real code the consumer still fails');
    assert.match(check.real!.diagnostics.map(d => d.message).join(), /Expected 0 arguments, but got 1/);
    assert.equal(check.implementation.ok, false);
    assert.match(check.implementation.reason, /expected getPrice\(unit: 'cents' \| 'dollars'\): number, found getPrice\(\): number/);

    service.coordinator.acknowledge(b.id, contract.id, 1);
    service.coordinator.acknowledge(a.id, contract.id, 1);
    assert.equal(service.coordinator.contract(contract.id).status, 'accepted');
    const run = await verify(b.id, contract.id, TEST_COMMAND);
    assert.equal(run.status, 'failed');
    assert.equal(run.passed, false);
    assert.notEqual(run.exitCode, 0);
    assert.equal(service.coordinator.contract(contract.id).status, 'accepted', 'acceptance never becomes verified without implementation');
    assert.ok(service.coordinator.events().some(e => e.type === 'contract.verification_failed'));
    assert.ok(service.coordinator.events().every(e => e.type !== 'contract.verified'));
  } finally { cleanup(); }
});

test('agreement gate, implementation evidence and behavioral verification are separate states', async () => {
  const { service, a, b, verify, adaptConsumer, implementProducerBody, write, read, cleanup } = setup();
  try {
    const contract = service.propose(a.id, { title: 'Explicit unit parameter on getPrice', declaration: DECLARATION, participants: [b.id], producerSymbol: PRODUCER });
    adaptConsumer();
    const blocked = service.preview(a.id, OPERATION);
    assert.equal(blocked.status, 'rejected');
    assert.match(blocked.rejections.join(), new RegExp(`proposed but not yet accepted by: .*${b.id}`));

    service.coordinator.acknowledge(b.id, contract.id, 1);
    service.coordinator.acknowledge(a.id, contract.id, 1);
    const preview = service.preview(a.id, OPERATION);
    assert.equal(preview.status, 'previewed', preview.rejections.join('; '));
    assert.equal(service.apply(a.id, preview.proposalId).status, 'applied');
    let current = service.coordinator.contract(contract.id);
    assert.equal(current.status, 'implemented', 'signature now matches the declaration');
    assert.equal(current.evidence.implemented!.declaration, "getPrice(unit: 'cents' | 'dollars'): number");

    // Structural match is not behavior: the body still returns dollars.
    const failing = await verify(a.id, contract.id, TEST_COMMAND);
    assert.equal(failing.passed, false);
    assert.equal(service.coordinator.contract(contract.id).status, 'implemented');
    assert.match(failing.output, /1999/);

    implementProducerBody(); // direct edit by the producer; detected, not blocked
    const passing = await verify(a.id, contract.id, TEST_COMMAND);
    assert.equal(passing.status, 'passed', passing.output);
    assert.equal(passing.passed, true, passing.output);
    assert.equal(passing.exitCode, 0);
    current = service.coordinator.contract(contract.id);
    assert.equal(current.status, 'verified');
    assert.equal(current.evidence.verification!.command, TEST_COMMAND);
    assert.deepEqual(Object.keys(current.evidence.verification!.sourceHashes).sort(), ['src/invoice.ts', 'src/pricing.ts']);
    assert.equal(current.evidence.verification!.revision, service.coordinator.revision());
    assert.ok(service.snapshot().findings.some(f => f.kind === 'direct_edit' && f.files?.includes('src/pricing.ts')));

    // Any later change to the verified files downgrades the evidence until verification runs again.
    write('src/pricing.ts', read('src/pricing.ts') + '// touched after verification\n');
    service.sync();
    current = service.coordinator.contract(contract.id);
    assert.equal(current.status, 'implemented');
    assert.match(current.evidence.staleReason!, /source changed after verification/);
    assert.equal((await verify(a.id, contract.id, TEST_COMMAND)).passed, true);
    assert.equal(service.coordinator.contract(contract.id).status, 'verified');
    assert.equal(service.contracts.runs(contract.id).length, 3);
  } finally { cleanup(); }
});

test('revising a contract re-arms the agreement gate and needs fresh acknowledgements of the new version', () => {
  const { service, a, b, adaptConsumer, cleanup } = setup();
  try {
    const contract = service.propose(a.id, { title: 'v1', declaration: DECLARATION, participants: [b.id], producerSymbol: PRODUCER });
    adaptConsumer();
    service.coordinator.acknowledge(b.id, contract.id, 1); service.coordinator.acknowledge(a.id, contract.id, 1);
    const revised = service.revise(a.id, contract.id, { declaration: "export declare function getPrice(unit: 'cents' | 'dollars' | 'euros'): number;" });
    assert.equal(revised.version, 2);
    assert.deepEqual(revised.acknowledgements, []);
    assert.equal(service.preview(a.id, OPERATION).status, 'rejected');
    assert.throws(() => service.coordinator.acknowledge(b.id, contract.id, 1), /version/);
    service.coordinator.acknowledge(b.id, contract.id, 2); service.coordinator.acknowledge(a.id, contract.id, 2);
    assert.equal(service.coordinator.contract(contract.id).status, 'accepted');
    assert.throws(() => service.revise(a.id, contract.id, { declaration: 'export declare function getPrice(unit: any): number;' }), /any/);
  } finally { cleanup(); }
});

test('verification only runs allowlisted commands without shell metacharacters', () => {
  const { service, a, b, cleanup } = setup();
  try {
    const contract = service.propose(a.id, { title: 'v1', declaration: DECLARATION, participants: [b.id], producerSymbol: PRODUCER });
    service.coordinator.acknowledge(b.id, contract.id, 1); service.coordinator.acknowledge(a.id, contract.id, 1);
    assert.throws(() => service.verify(a.id, contract.id, 'rm -rf /'), /allowlist/);
    assert.throws(() => service.verify(a.id, contract.id, 'node --test x.ts; rm -rf /'), /safe set/);
    assert.throws(() => service.verify(a.id, contract.id, 'npm test && curl evil'), /safe set/);
  } finally { cleanup(); }
});

test('field_required claim: violations by direct edit are reported; staged operations are gated', () => {
  const { service, a, write, read, cleanup } = setup();
  try {
    const claim = service.claim(a.id, { kind: 'field_required', symbol: 'src/types.ts#LineItem:interface', field: 'quantity', type: 'number' });
    assert.equal(service.snapshot().findings.filter(f => f.kind === 'claim_violation').length, 0);
    const original = read('src/types.ts');
    write('src/types.ts', 'export interface LineItem { sku: string; quantity: string }\n');
    write('src/catalog.ts', "import type { LineItem } from './types.ts';\nexport const items: LineItem[] = [{ sku: 'basic', quantity: '1' }];\n");
    const violation = service.snapshot().findings.find(f => f.kind === 'claim_violation');
    assert.ok(violation);
    assert.match(violation!.evidence, new RegExp(`Claim ${claim.id}.*quantity: number.*quantity: string`));
    write('src/types.ts', original);
    write('src/catalog.ts', "import type { LineItem } from './types.ts';\nexport const items: LineItem[] = [{ sku: 'basic', quantity: 1 }];\n");
    assert.equal(service.snapshot().findings.filter(f => f.kind === 'claim_violation').length, 0);
    // A staged operation that keeps the field passes the gate.
    const ok = service.preview(a.id, { kind: 'add_field', symbol: 'src/types.ts#LineItem:interface', name: 'note', type: 'string', optional: true });
    assert.equal(ok.status, 'previewed', ok.rejections.join('; '));
    // A staged project that drops the field is rejected by the gate (checked directly: no shipped op removes members).
    const gate = service.claims.gate(id => service.graph(id));
    const staged = service.graph().openProject();
    staged.getSourceFileOrThrow(join(service.graph().root, 'src/types.ts')).getInterfaceOrThrow('LineItem').getPropertyOrThrow('quantity').remove();
    const reasons = gate({ sessionId: a.id, workspaceId: service.coordinator.workspaceId, operation: ok.operation, symbol: service.graph().symbol('src/types.ts#LineItem:interface')!, staged, touchedFiles: ['src/types.ts'], newDiagnostics: [] });
    assert.equal(reasons.length, 1);
    assert.match(reasons[0]!, /Claim .* violated: .*quantity: number \(field missing\)/);
  } finally { cleanup(); }
});

test('event order: acceptance is logged after every signature of that version, including the final one', () => {
  const { service, a, b, cleanup } = setup();
  try {
    const contract = service.propose(a.id, { title: 'v1', declaration: DECLARATION, participants: [b.id], producerSymbol: PRODUCER });
    service.coordinator.acknowledge(b.id, contract.id, 1);
    service.coordinator.acknowledge(a.id, contract.id, 1);
    const forVersion = service.coordinator.events().filter(e => e.payload?.contractId === contract.id && e.payload?.version === 1);
    const acknowledged = forVersion.filter(e => e.type === 'contract.acknowledged');
    const accepted = forVersion.filter(e => e.type === 'contract.accepted');
    assert.equal(acknowledged.length, 2);
    assert.equal(accepted.length, 1, 'accepted exactly once');
    for (const ack of acknowledged) assert.ok(accepted[0]!.seq > ack.seq, `accepted seq ${accepted[0]!.seq} must follow acknowledged seq ${ack.seq}`);
    // A repeat signature after acceptance must not emit a second acceptance.
    service.coordinator.acknowledge(a.id, contract.id, 1);
    assert.equal(service.coordinator.events().filter(e => e.type === 'contract.accepted' && e.payload?.contractId === contract.id).length, 1);
  } finally { cleanup(); }
});
