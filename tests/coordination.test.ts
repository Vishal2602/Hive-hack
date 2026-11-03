import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Coordinator } from '../src/domain/coordinator.ts';
const input = (unit: string) => ({ task: 'Pricing', files: ['price.ts'], symbols: ['price.ts#getPrice'], assumptions: [{ key: 'unit', value: unit }] });
function pair() {
  const hive = new Coordinator(); const a = hive.register('A'); const b = hive.register('B');
  hive.setIntent(a.id, input('cents')); hive.setIntent(b.id, input('dollars'));
  return { hive, a, b };
}
test('different files can still disagree about a shared API', () => {
  const { hive, b } = pair(); hive.setIntent(b.id, { ...input('dollars'), files: ['invoice.ts'] });
  assert.equal(hive.snapshot().findings.filter(f => f.kind === 'assumption_mismatch').length, 1);
});
test('same-file overlap is informational, not an automatic blocker', () => {
  const { hive, b } = pair(); hive.setIntent(b.id, input('cents'));
  assert.ok(hive.snapshot().findings.every(f => f.severity === 'info'));
});
test('unrelated work is not included in alerts', () => {
  const { hive } = pair(); const c = hive.register('C');
  hive.setIntent(c.id, { task: 'UI', files: ['ui.ts'], symbols: ['label'], assumptions: [] });
  assert.ok(hive.snapshot().findings.every(f => !f.sessions.includes(c.id)));
});
test('all participants must accept and acceptance is not verification', () => {
  const { hive, a, b } = pair(); const c = hive.propose(a.id, { title: 'Contract', declaration: 'declare function price(): number;', participants: [b.id] });
  assert.equal(hive.acknowledge(a.id, c.id, 1).status, 'proposed');
  assert.equal(hive.acknowledge(b.id, c.id, 1).status, 'accepted');
  assert.equal(hive.snapshot().findings.some(f => f.kind === 'assumption_mismatch'), true);
});
test('intent changes invalidate existing agreements', () => {
  const { hive, a, b } = pair(); const c = hive.propose(a.id, { title: 'Contract', declaration: 'interface Price {}', participants: [b.id] });
  hive.setIntent(a.id, input('euros'));
  assert.throws(() => hive.acknowledge(b.id, c.id, 1), /stale/);
});
test('expired sessions stop producing conflicts and invalidate contracts', () => {
  let now = 0; const hive = new Coordinator({ clock: () => now, ttl: 100 }); const a = hive.register('A'); const b = hive.register('B');
  hive.setIntent(a.id, input('cents')); hive.setIntent(b.id, input('dollars'));
  hive.propose(a.id, { title: 'Contract', declaration: 'interface Price {}', participants: [b.id] });
  now = 101;
  assert.equal(hive.snapshot().findings.length, 0);
  assert.equal(hive.snapshot().contracts[0]!.status, 'stale');
});
test('wrong contract version and outsider acknowledgements are rejected', () => {
  const { hive, a, b } = pair(); const outsider = hive.register('C');
  const c = hive.propose(a.id, { title: 'Contract', declaration: 'interface Price {}', participants: [b.id] });
  assert.throws(() => hive.acknowledge(a.id, c.id, 2), /version/);
  assert.throws(() => hive.acknowledge(outsider.id, c.id, 1), /participant/);
});
test('snapshot consumers cannot mutate coordinator state', () => {
  const { hive } = pair(); hive.snapshot().intents[0]!.assumptions[0]!.value = 'changed';
  assert.equal(hive.snapshot().intents[0]!.assumptions[0]!.value, 'cents');
});
test('duplicate assumption keys are rejected', () => {
  const { hive, a } = pair(); assert.throws(() => hive.setIntent(a.id, {
    ...input('cents'), assumptions: [{ key: 'unit', value: 'cents' }, { key: 'unit', value: 'dollars' }],
  }), /unique/);
});
