import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Coordinator } from '../src/domain/coordinator.ts';
import { Store } from '../src/store/sqlite.ts';

const intent = (unit: string) => ({ task: 'Pricing', files: ['src/pricing.ts'], symbols: ['src/pricing.ts#getPrice:function'], assumptions: [{ key: 'getPrice:unit', value: unit }] });

test('restart preserves sessions, intents, contracts, events and revision', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-store-'));
  try {
    const dbPath = join(dir, '.hive', 'hive.db');
    let now = 1_000;
    const first = new Coordinator({ store: new Store(dbPath), root: dir, clock: () => now, ttl: 10_000 });
    const a = first.register('A'); const b = first.register('B');
    first.setIntent(a.id, intent('cents')); first.setIntent(b.id, intent('dollars'));
    const contract = first.propose(a.id, { title: 'Cents API', declaration: 'export declare function getPriceCents(): number;', participants: [b.id], producerSymbol: 'src/pricing.ts#getPriceCents:function' });
    first.acknowledge(b.id, contract.id, 1);
    first.bumpRevision('test');
    first.store.close();
    assert.ok(existsSync(dbPath));

    now = 2_000;
    const second = new Coordinator({ store: new Store(dbPath), root: dir, clock: () => now, ttl: 10_000 });
    const snapshot = second.snapshot();
    assert.deepEqual(snapshot.sessions.map(s => s.id).sort(), [a.id, b.id].sort());
    assert.equal(snapshot.intents.length, 2);
    assert.equal(snapshot.contracts[0]!.id, contract.id);
    assert.deepEqual(snapshot.contracts[0]!.acknowledgements, [b.id]);
    assert.equal(snapshot.contracts[0]!.status, 'proposed');
    assert.equal(snapshot.repository.revision, 1);
    assert.ok(snapshot.events.some(e => e.type === 'contract.proposed'));
    assert.equal(snapshot.findings.filter(f => f.kind === 'assumption_mismatch').length, 1);
    // Same repository identity across restarts.
    assert.equal(second.repositoryId, first.repositoryId);
    second.store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('expired leases are released after a restart and release their scope', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-store-'));
  try {
    const dbPath = join(dir, 'hive.db');
    let now = 0;
    const first = new Coordinator({ store: new Store(dbPath), root: dir, clock: () => now, ttl: 100 });
    const a = first.register('A'); const b = first.register('B');
    first.setIntent(a.id, intent('cents')); first.setIntent(b.id, intent('dollars'));
    first.propose(a.id, { title: 'C', declaration: 'interface P {}', participants: [b.id] });
    first.store.close();
    now = 500; // leases lapsed while the daemon was down
    const second = new Coordinator({ store: new Store(dbPath), root: dir, clock: () => now, ttl: 100 });
    const snapshot = second.snapshot();
    assert.equal(snapshot.sessions.length, 0);
    assert.equal(snapshot.findings.length, 0);
    assert.equal(snapshot.contracts[0]!.status, 'stale');
    assert.throws(() => second.heartbeat(a.id), /expired/);
    assert.ok(snapshot.events.filter(e => e.type === 'session.expired').length === 2);
    second.store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('workspaces: sessions can register a worktree directory; bad paths are rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-ws-'));
  try {
    const worktree = join(dir, 'wt-a'); mkdirSync(worktree);
    const hive = new Coordinator({ root: dir });
    const a = hive.register('A', { workspace: worktree, client: 'test' });
    const ws = hive.workspace(a.workspaceId);
    assert.notEqual(a.workspaceId, hive.workspaceId);
    assert.equal(ws.repositoryId, hive.repositoryId);
    assert.ok(ws.realRoot.endsWith('wt-a'));
    assert.equal(a.client, 'test');
    assert.throws(() => hive.register('B', { workspace: join(dir, 'missing') }));
    assert.equal(hive.snapshot().workspaces.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('contract versions: revising clears acknowledgements and v1 acks cannot satisfy v2', () => {
  const hive = new Coordinator();
  const a = hive.register('A'); const b = hive.register('B');
  hive.setIntent(a.id, intent('cents')); hive.setIntent(b.id, intent('dollars'));
  const c = hive.propose(a.id, { title: 'C', declaration: 'export declare function getPriceCents(): number;', participants: [b.id] });
  hive.acknowledge(a.id, c.id, 1); hive.acknowledge(b.id, c.id, 1);
  assert.equal(hive.contract(c.id).status, 'accepted');
  const v2 = hive.revise(a.id, c.id, { declaration: 'export declare function getPriceCents(): bigint;' });
  assert.equal(v2.version, 2);
  assert.equal(v2.status, 'proposed');
  assert.deepEqual(v2.acknowledgements, []);
  assert.throws(() => hive.acknowledge(b.id, c.id, 1), /version/);
  hive.acknowledge(b.id, c.id, 2);
  assert.equal(hive.contract(c.id).status, 'proposed');
  hive.acknowledge(a.id, c.id, 2);
  assert.equal(hive.contract(c.id).status, 'accepted');
  assert.equal(hive.contract(c.id).history.length, 2);
  assert.equal(hive.contract(c.id).acknowledgementDetails.find(x => x.sessionId === b.id)!.intentRevision, 1);
});

test('reject by participant and cancel by owner are distinct terminal states', () => {
  const hive = new Coordinator();
  const a = hive.register('A'); const b = hive.register('B');
  hive.setIntent(a.id, intent('cents')); hive.setIntent(b.id, intent('dollars'));
  const c1 = hive.propose(a.id, { title: 'C1', declaration: 'interface X {}', participants: [b.id] });
  assert.equal(hive.reject(b.id, c1.id, 'units still wrong').status, 'rejected');
  assert.throws(() => hive.acknowledge(a.id, c1.id, 1), /rejected/);
  const c2 = hive.propose(a.id, { title: 'C2', declaration: 'interface Y {}', participants: [b.id] });
  assert.equal(hive.reject(a.id, c2.id, 'withdrawn').status, 'cancelled');
});

test('event history is durable, ordered and queryable after a sequence number', () => {
  const hive = new Coordinator();
  const a = hive.register('A');
  const before = hive.events().at(-1)!.seq;
  hive.setIntent(a.id, intent('cents'));
  hive.setIntent(a.id, intent('cents'));
  const later = hive.events(before);
  assert.equal(later.length, 2);
  assert.ok(later.every(e => e.type === 'intent.updated'));
  assert.ok(later[0]!.seq < later[1]!.seq);
});
