import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HiveService, type ServiceOptions } from '../src/service.ts';
import { Store } from '../src/store/sqlite.ts';

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}/`, import.meta.url));
function setup(name = 'billing', options: Partial<ServiceOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hive-ops-'));
  cpSync(fixture(name), dir, { recursive: true });
  const store = new Store();
  const service = new HiveService({ store, root: dir, ...options });
  const session = service.coordinator.register('A');
  service.coordinator.setIntent(session.id, { task: 'ops test', files: [], symbols: [], assumptions: [] });
  service.sync(); // initial index (bumps the revision once) happens before any measurement
  const read = (file: string) => readFileSync(join(dir, file), 'utf8');
  const snapshotFiles = (files: string[]) => Object.fromEntries(files.map(f => [f, read(f)]));
  return { dir, store, service, session, read, snapshotFiles, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const getPriceRequired = { kind: 'change_signature' as const, symbol: 'src/pricing.ts#getPrice:function', declaration: "export function getPrice(unit: 'cents' | 'dollars'): number" };
const dropRegion = { kind: 'change_signature' as const, symbol: 'src/tax.ts#applyTax:function', declaration: 'applyTax(amount: number, rate: number): number' };

test('unsupported operations are rejected explicitly and can never be applied', () => {
  const { service, session, cleanup } = setup();
  try {
    const preview = service.engine.preview(session.id, { kind: 'rename_symbol', symbol: 'src/pricing.ts#getPrice:function', newName: 'price' });
    assert.equal(preview.status, 'rejected');
    assert.match(preview.rejections[0]!, /unsupported.*rename_symbol/);
    assert.equal(service.engine.apply(session.id, preview.proposalId).status, 'rejected');
    const unknown = service.engine.preview(session.id, { kind: 'add_field', symbol: 'src/nope.ts#Nope:interface', name: 'x', type: 'string', optional: true });
    assert.match(unknown.rejections[0]!, /unknown_symbol/);
  } finally { cleanup(); }
});

test('add_field: a required field that breaks an object literal is rejected naming the caller; an optional field applies', () => {
  const { service, session, read, cleanup } = setup();
  try {
    const required = service.engine.preview(session.id, { kind: 'add_field', symbol: 'src/types.ts#LineItem:interface', name: 'note', type: 'string', optional: false });
    assert.equal(required.status, 'rejected');
    assert.ok(required.newDiagnostics.some(d => d.file === 'src/catalog.ts' && /note/.test(d.message)));
    assert.ok(required.callers.some(c => c.from === 'src/catalog.ts#items:variable' && /breaks/.test(c.note)));
    assert.equal(read('src/types.ts').includes('note'), false, 'preview must not write');

    const base = service.coordinator.revision();
    const optional = service.engine.preview(session.id, { kind: 'add_field', symbol: 'src/types.ts#LineItem:interface', name: 'note', type: 'string', optional: true });
    assert.equal(optional.status, 'previewed');
    assert.match(optional.diff, /\+\s+note\?: string;/);
    assert.deepEqual(optional.affectedFiles, ['src/types.ts']);
    const applied = service.engine.apply(session.id, optional.proposalId);
    assert.equal(applied.status, 'applied');
    assert.equal(applied.revision, base + 1);
    assert.match(read('src/types.ts'), /note\?: string;/);
    assert.ok(service.graph().symbol('src/types.ts#LineItem.note:property'), 'index updated after apply');
    assert.equal(service.engine.proposal(optional.proposalId)!.status, 'applied');
    assert.equal(service.coordinator.events().some(e => e.type === 'operation.applied'), true);
  } finally { cleanup(); }
});

test('change_signature: a new required parameter reports unfixable callers instead of inventing arguments', () => {
  const { service, session, read, cleanup } = setup();
  try {
    const preview = service.engine.preview(session.id, getPriceRequired);
    assert.equal(preview.status, 'rejected');
    assert.ok(preview.newDiagnostics.some(d => d.file === 'src/invoice.ts' && /Expected 1 arguments, but got 0/.test(d.message)));
    assert.ok(preview.callers.some(c => c.from === 'src/invoice.ts#invoiceTotal:function' && /breaks/.test(c.note)));
    assert.ok(preview.notes.some(n => /does not invent arguments/.test(n)));
    assert.match(read('src/pricing.ts'), /getPrice\(\): number/);
  } finally { cleanup(); }
});

test('change_signature: optional parameter applies; dropping a parameter removes the argument at call sites', () => {
  const { service, session, read, cleanup } = setup();
  try {
    const optional = service.engine.preview(session.id, { ...getPriceRequired, declaration: "getPrice(unit?: 'cents' | 'dollars'): number" });
    assert.equal(optional.status, 'previewed', optional.rejections.join('; '));
    assert.equal(service.engine.apply(session.id, optional.proposalId).status, 'applied');
    assert.match(read('src/pricing.ts'), /getPrice\(unit\?: 'cents' \| 'dollars'\): number/);
    assert.match(read('src/invoice.ts'), /getPrice\(\)/, 'callers untouched for optional parameters');

    const drop = service.engine.preview(session.id, dropRegion);
    assert.equal(drop.status, 'previewed', drop.rejections.join('; '));
    assert.deepEqual(drop.affectedFiles.sort(), ['src/invoice.ts', 'src/tax.ts']);
    assert.ok(drop.notes.some(n => /Removed 1 argument/.test(n)));
    assert.equal(service.engine.apply(session.id, drop.proposalId).status, 'applied');
    assert.match(read('src/tax.ts'), /applyTax\(amount: number, rate: number\): number/);
    assert.match(read('src/invoice.ts'), /applyTax\(getPrice\(\), 0\.2\)/);
    assert.equal(service.graph().symbol('src/tax.ts#applyTax:function')!.meta.signature, 'applyTax(amount: number, rate: number): number');
  } finally { cleanup(); }
});

test('change_signature refuses overloaded functions instead of rewriting the overload set', () => {
  const { service, session, cleanup } = setup('aliases');
  try {
    const preview = service.engine.preview(session.id, { kind: 'change_signature', symbol: 'src/core/money.ts#format:function', declaration: 'format(value: number): string' });
    assert.equal(preview.status, 'rejected');
    assert.match(preview.rejections[0]!, /overload/);
  } finally { cleanup(); }
});

test('injected failure after the first file write restores every file and the database', () => {
  const { service, session, snapshotFiles, store, cleanup } = setup('billing', { onFileWritten: (_file, index) => { if (index === 0) throw new Error('disk full (injected)'); } });
  try {
    const files = ['src/tax.ts', 'src/invoice.ts'];
    const before = snapshotFiles(files);
    const revision = service.coordinator.revision();
    const preview = service.engine.preview(session.id, dropRegion);
    assert.equal(preview.status, 'previewed');
    const result = service.engine.apply(session.id, preview.proposalId);
    assert.equal(result.status, 'failed');
    assert.match(result.reasons[0]!, /restored from the journal.*disk full/);
    assert.deepEqual(snapshotFiles(files), before, 'all files restored');
    assert.equal(service.coordinator.revision(), revision, 'revision unchanged');
    assert.equal(service.engine.proposal(preview.proposalId)!.status, 'failed');
    assert.equal(store.get<{ status: string }>('SELECT status FROM journal')!.status, 'rolled_back');
    assert.deepEqual(service.graph().changes(), { changed: [], added: [], removed: [] }, 'index matches restored disk');
    assert.equal(service.graph().symbol('src/tax.ts#applyTax:function')!.meta.signature, 'applyTax(amount: number, rate: number, region: string): number');
  } finally { cleanup(); }
});

test('a simulated crash mid-apply is recovered from the durable journal on restart', () => {
  const crash = () => { const error = new Error('process killed (simulated)'); error.name = 'SimulatedCrash'; throw error; };
  const { service, session, snapshotFiles, store, dir, cleanup } = setup('billing', { onFileWritten: (_file, index) => { if (index === 0) crash(); } });
  try {
    const files = ['src/tax.ts', 'src/invoice.ts'];
    const before = snapshotFiles(files);
    const preview = service.engine.preview(session.id, dropRegion);
    assert.throws(() => service.engine.apply(session.id, preview.proposalId), /simulated/);
    assert.notDeepEqual(snapshotFiles(files), before, 'first file was written before the crash');
    assert.equal(store.get<{ status: string }>('SELECT status FROM journal')!.status, 'writing');
    // "Restart": a new service over the same store recovers the journal before accepting work.
    const restarted = new HiveService({ store, root: dir });
    assert.deepEqual(snapshotFiles(files), before, 'originals restored on restart');
    assert.equal(store.get<{ status: string }>('SELECT status FROM journal')!.status, 'recovered');
    assert.equal(restarted.engine.proposal(preview.proposalId)!.status, 'failed');
    assert.ok(restarted.coordinator.events().some(e => e.type === 'proposal.recovered'));
    assert.deepEqual(restarted.graph().changes(), { changed: [], added: [], removed: [] });
  } finally { cleanup(); }
});

test('two proposals from the same base: the second apply is stale, not silently applied', () => {
  const { service, session, read, cleanup } = setup();
  try {
    const b = service.coordinator.register('B');
    service.coordinator.setIntent(b.id, { task: 'other', files: [], symbols: [], assumptions: [] });
    const first = service.engine.preview(session.id, { kind: 'add_field', symbol: 'src/types.ts#LineItem:interface', name: 'note', type: 'string', optional: true });
    const second = service.engine.preview(b.id, { kind: 'add_field', symbol: 'src/types.ts#LineItem:interface', name: 'tag', type: 'string', optional: true });
    assert.equal(first.baseRevision, second.baseRevision);
    assert.equal(service.engine.apply(session.id, first.proposalId).status, 'applied');
    const stale = service.engine.apply(b.id, second.proposalId);
    assert.equal(stale.status, 'stale');
    assert.match(stale.reasons[0]!, /revision changed/);
    assert.equal(read('src/types.ts').includes('tag'), false);
    assert.throws(() => service.engine.apply(session.id, second.proposalId), /Only the proposing session/);
  } finally { cleanup(); }
});

test('a direct edit between preview and apply makes the proposal stale and is reported as a direct edit', () => {
  const { service, session, dir, cleanup } = setup();
  try {
    const preview = service.engine.preview(session.id, { kind: 'add_field', symbol: 'src/types.ts#LineItem:interface', name: 'note', type: 'string', optional: true });
    writeFileSync(join(dir, 'src/button.ts'), "export const buttonLabel = 'Download invoice';\n");
    const result = service.engine.apply(session.id, preview.proposalId);
    assert.equal(result.status, 'stale');
    const snapshot = service.snapshot();
    assert.ok(snapshot.findings.some(f => f.kind === 'direct_edit' && f.files?.includes('src/button.ts')));
    assert.ok(snapshot.events.some(e => e.type === 'direct_edit'));
  } finally { cleanup(); }
});
