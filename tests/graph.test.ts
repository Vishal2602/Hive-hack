import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphIndex } from '../src/graph/index.ts';
import { Store } from '../src/store/sqlite.ts';

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}/`, import.meta.url));
function index(root: string) {
  const store = new Store();
  return new GraphIndex({ store, workspaceId: 'ws', root });
}

test('aliases fixture: barrels, aliases, overloads, members and excluded files', () => {
  const graph = index(fixture('aliases'));
  const result = graph.reindex();
  assert.equal(result.files, 4, 'src/legacy/old.ts is excluded by tsconfig and must not be indexed');
  const keys = graph.symbols().map(s => s.key);
  assert.ok(keys.includes('src/core/money.ts#format:function'));
  assert.ok(keys.includes('src/core/money.ts#Money:interface'));
  assert.ok(keys.includes('src/core/money.ts#Money.amount:property'));
  assert.ok(keys.includes('src/core/money.ts#Ledger.add:method'));
  assert.ok(keys.includes('src/core/util.ts#round2:variable'));
  assert.ok(keys.includes('src/core/util.ts#Cents:type'));
  assert.ok(!keys.some(k => k.startsWith('src/legacy/')));
  const format = graph.symbol('src/core/money.ts#format:function')!;
  assert.equal(format.meta.overloads, 3, 'two overload signatures plus the implementation share one logical key');
  assert.match(format.meta.signature!, /format\(value: number\): string \| format\(value: number, currency: string\): string/);
  // app.ts calls formatMoney (alias through the barrel) -> edge to the original declaration.
  const dependents = graph.dependents('src/core/money.ts#format:function');
  assert.ok(dependents.some(e => e.from === 'src/app.ts#show:function' && e.kind === 'reference'));
  assert.ok(dependents.some(e => e.from === 'src/app.ts#totalOf:function'));
  assert.ok(dependents.some(e => e.file === 'src/core/index.ts' && e.kind === 'reexport'));
  assert.ok(dependents.some(e => e.file === 'src/app.ts' && e.kind === 'import'));
  assert.ok(graph.dependents('src/core/money.ts#Ledger.add:method').some(e => e.from === 'src/app.ts#totalOf:function'));
  assert.ok(graph.dependents('src/core/money.ts#Money:interface').some(e => e.from === 'src/core/money.ts#Ledger.add:method'));
  // `export * from './util.js'` names no identifier, so the barrel itself is (correctly) not a dependent.
  assert.deepEqual(graph.dependentFiles('src/core/util.ts#round2:variable'), ['src/app.ts']);
  assert.deepEqual(graph.dependentFiles('src/core/money.ts#Money:interface'), ['src/app.ts', 'src/core/index.ts', 'src/core/money.ts']);
  // Friendly resolution
  assert.equal(graph.resolve('src/core/money.ts#Ledger')!.kind, 'class');
  assert.equal(graph.resolve('round2')!.key, 'src/core/util.ts#round2:variable');
  assert.equal(graph.resolve('format')!.key, 'src/core/money.ts#format:function');
  assert.equal(graph.resolve('does-not-exist'), undefined);
});

test('billing fixture: invoice depends on getPrice through the compiler, button does not', () => {
  const graph = index(fixture('billing'));
  graph.reindex();
  const dependents = graph.dependents('src/pricing.ts#getPrice:function');
  assert.ok(dependents.some(e => e.from === 'src/invoice.ts#invoiceTotal:function'));
  assert.ok(!dependents.some(e => e.file === 'src/button.ts'));
  assert.deepEqual(graph.dependencies('src/button.ts'), []);
  assert.equal(graph.symbol('src/pricing.ts#getPrice:function')!.meta.signature, 'getPrice(): number');
});

test('stale sources are detected; reindex preserves IDs; explicit key mapping carries an ID through a rename', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-graph-'));
  try {
    cpSync(fixture('aliases'), dir, { recursive: true });
    const graph = index(dir);
    assert.equal(graph.isIndexed(), false);
    graph.reindex();
    assert.equal(graph.isIndexed(), true);
    assert.deepEqual(graph.changes(), { changed: [], added: [], removed: [] });
    const round2 = graph.symbol('src/core/util.ts#round2:variable')!;
    const formatBefore = graph.symbol('src/core/money.ts#format:function')!;

    // Direct edit outside Hive: add an export and change nothing else.
    const util = join(dir, 'src/core/util.ts');
    writeFileSync(util, readFileSync(util, 'utf8') + 'export const round0 = (n: number): number => Math.round(n);\n');
    writeFileSync(join(dir, 'src/extra.ts'), 'export const extra = 1;\n');
    const changes = graph.changes();
    assert.deepEqual(changes, { changed: ['src/core/util.ts'], added: ['src/extra.ts'], removed: [] });
    const result = graph.reindex();
    assert.deepEqual([result.changed, result.added], [['src/core/util.ts'], ['src/extra.ts']]);
    assert.equal(graph.symbol('src/core/util.ts#round2:variable')!.id, round2.id, 'unchanged symbol keeps its ID');
    assert.equal(graph.symbol('src/core/money.ts#format:function')!.id, formatBefore.id);
    assert.ok(graph.symbol('src/core/util.ts#round0:variable'));
    assert.ok(graph.symbol('src/extra.ts#extra:variable'));

    // Rename round2 -> roundTwo everywhere, then reindex with an explicit mapping.
    for (const file of ['src/core/util.ts', 'src/app.ts']) {
      const path = join(dir, file); writeFileSync(path, readFileSync(path, 'utf8').replaceAll('round2', 'roundTwo'));
    }
    graph.reindex({ keyMap: { 'src/core/util.ts#round2:variable': 'src/core/util.ts#roundTwo:variable' } });
    assert.equal(graph.symbol('src/core/util.ts#round2:variable'), undefined);
    assert.equal(graph.symbol('src/core/util.ts#roundTwo:variable')!.id, round2.id, 'mapped symbol keeps its ID');
    assert.ok(graph.dependents('src/core/util.ts#roundTwo:variable').some(e => e.from === 'src/app.ts#show:function'));

    // Removing a file drops its symbols.
    rmSync(join(dir, 'src/extra.ts'));
    assert.deepEqual(graph.changes().removed, ['src/extra.ts']);
    graph.reindex();
    assert.equal(graph.symbol('src/extra.ts#extra:variable'), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('hash of a declaration changes when its text changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-graph-'));
  try {
    cpSync(fixture('billing'), dir, { recursive: true });
    const graph = index(dir);
    graph.reindex();
    const before = graph.symbol('src/pricing.ts#getPrice:function')!.declarationHash;
    const pricing = join(dir, 'src/pricing.ts');
    writeFileSync(pricing, readFileSync(pricing, 'utf8').replace('19.99', '29.99'));
    graph.reindex();
    assert.notEqual(graph.symbol('src/pricing.ts#getPrice:function')!.declarationHash, before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
