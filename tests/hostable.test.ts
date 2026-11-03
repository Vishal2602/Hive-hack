import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HiveService, type ServiceOptions } from '../src/service.ts';
import { Store } from '../src/store/sqlite.ts';

const fixture = fileURLToPath(new URL('../fixtures/billing/', import.meta.url));
const daemonPath = fileURLToPath(new URL('../src/server/daemon.ts', import.meta.url));
const ADMIN = 'hostable-test-token-not-production';
const PRODUCER = 'src/pricing.ts#getPrice:function';
const DECLARATION = "export declare function getPrice(unit: 'cents' | 'dollars'): number;";
const PRODUCER_BODY = "export function getPrice(unit: 'cents' | 'dollars'): number { return unit === 'cents' ? 1999 : 19.99; }\n";
const CONSUMER = "import { getPrice } from './pricing.ts';\nexport function invoiceTotal(): string { return `$${(getPrice('cents') / 100).toFixed(2)}`; }\n";
const dropRegion = { kind: 'change_signature' as const, symbol: 'src/tax.ts#applyTax:function', declaration: 'applyTax(amount: number, rate: number): number' };

function copyFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hive-host-'));
  cpSync(fixture, dir, { recursive: true });
  return dir;
}

async function unusedPort(host = '127.0.0.1'): Promise<number> {
  const server = createServer(); server.listen(0, host); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

interface Daemon { child: ChildProcess; url: string; log: () => string; exit: Promise<number | null> }

/** Starts the daemon with a clean env (no inherited PORT / HIVE_*) and waits for the ready line. */
async function startDaemon(extra: Record<string, string>, port: number): Promise<Daemon> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string' && key !== 'PORT' && !key.startsWith('HIVE_')) env[key] = value;
  Object.assign(env, { HIVE_TOKEN: ADMIN, HIVE_SNAPSHOT_REFRESH_MS: '600000' }, extra);
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', daemonPath], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  child.stderr!.on('data', chunk => { log += String(chunk); });
  const exit = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`daemon not ready: ${log}`)), 20_000);
    child.stderr!.on('data', () => { if (log.includes('Hive daemon listening')) { clearTimeout(timer); resolve(); } });
    void exit.then(code => { clearTimeout(timer); reject(new Error(`Daemon exited ${code}: ${log}`)); });
  });
  return { child, url: `http://127.0.0.1:${port}`, log: () => log, exit };
}

async function stop(daemon: Daemon): Promise<number | null> {
  if (daemon.child.exitCode === null && daemon.child.signalCode === null) daemon.child.kill('SIGTERM');
  return daemon.exit;
}

function api(daemon: Daemon, token = ADMIN) {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  return {
    get: async (path: string) => { const r = await fetch(`${daemon.url}${path}`, { headers }); return { status: r.status, body: await r.json() as any }; },
    command: async (body: Record<string, unknown>) => {
      const r = await fetch(`${daemon.url}/command`, { method: 'POST', headers, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() as any };
    },
  };
}

// ---- in-process ------------------------------------------------------------------------------------

test('events(after, limit) pages ascending and returns every event exactly once; recentEvents returns the latest', () => {
  const dir = copyFixture();
  try {
    const service = new HiveService({ store: new Store(), root: dir });
    for (let i = 0; i < 23; i++) service.coordinator.emit('test.tick', `tick ${i}`, { i });
    const all = service.coordinator.events(0, 1000);
    const seen: number[] = [];
    let after = 0;
    for (let page = service.coordinator.events(after, 7); page.length; page = service.coordinator.events(after, 7)) {
      assert.ok(page.length <= 7);
      for (let i = 1; i < page.length; i++) assert.ok(page[i]!.seq > page[i - 1]!.seq, 'ascending within a page');
      seen.push(...page.map(e => e.seq));
      after = page.at(-1)!.seq;
    }
    assert.deepEqual(seen, all.map(e => e.seq), 'paging covers every event exactly once, in order');
    assert.equal(new Set(seen).size, seen.length);
    // The old DESC+reverse query returned the newest `limit` rows, so page 1 skipped the oldest events.
    assert.equal(service.coordinator.events(0, 5)[0]!.seq, all[0]!.seq, 'first page starts at the oldest event');
    const recent = service.coordinator.recentEvents(3);
    assert.deepEqual(recent.map(e => e.seq), all.slice(-3).map(e => e.seq));
    assert.equal(service.coordinator.lastEventSeq(), all.at(-1)!.seq);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('snapshotCached never re-hashes; disk edits appear only after refreshTick (drift) or fresh; commands mark it dirty', async () => {
  const dir = copyFixture();
  try {
    const service = new HiveService({ store: new Store(), root: dir });
    const first = service.snapshotCached();
    const revision = first.repository.revision;
    assert.equal(typeof first.cacheAgeMs, 'number');
    const graph = service.graph();
    let hashes = 0;
    const original = graph.quickChanges.bind(graph);
    graph.quickChanges = () => { hashes++; return original(); };

    writeFileSync(join(dir, 'src/pricing.ts'), `${readFileSync(join(dir, 'src/pricing.ts'), 'utf8')}\nexport const edited = 1;\n`);
    await new Promise(resolve => setTimeout(resolve, 20));
    for (let i = 0; i < 5; i++) assert.equal(service.snapshotCached().repository.revision, revision, 'cache still shows the old revision');
    assert.equal(hashes, 0, 'cached reads do not hash files');
    assert.ok(service.snapshotCached().cacheAgeMs >= 15, 'cache age grows while nothing changes');
    assert.equal(service.health().revision, revision, 'health does not sync');

    assert.deepEqual(service.refreshTick(), { drift: true });
    assert.equal(hashes, 1, 'the timer body runs one quickChanges per indexed workspace');
    const refreshed = service.snapshotCached();
    assert.equal(refreshed.repository.revision, revision + 1);
    assert.ok(refreshed.events.some(e => e.type === 'direct_edit'));
    assert.ok(refreshed.cacheAgeMs < 15);
    assert.deepEqual(service.refreshTick(), { drift: false }, 'no drift: no rebuild');

    // A command through the wrapper marks the cache dirty (heartbeat emits no event; only the wrapper can tell).
    const session = service.coordinator.register('A');
    const before = service.snapshotCached().sessions.find(s => s.id === session.id)!.expiresAt;
    await new Promise(resolve => setTimeout(resolve, 5));
    await service.track(() => service.coordinator.heartbeat(session.id));
    assert.ok(service.snapshotCached().sessions.find(s => s.id === session.id)!.expiresAt > before, 'heartbeat visible after a tracked command');
    // A failed command does not count as a state change and does not leak the in-flight counter.
    await assert.rejects(service.track(() => { throw new Error('boom'); }), /boom/);
    assert.equal(service.inFlightCommands, 0);

    writeFileSync(join(dir, 'src/tax.ts'), `${readFileSync(join(dir, 'src/tax.ts'), 'utf8')}\nexport const edited2 = 2;\n`);
    assert.equal(service.snapshotCached().repository.revision, revision + 1);
    assert.equal(service.snapshotCached({ fresh: true }).repository.revision, revision + 2, 'fresh forces a sync');
    assert.equal(service.viewCached().revision, revision + 2);
    assert.equal(typeof service.viewCached().cacheAgeMs, 'number');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- daemon process ----------------------------------------------------------------------------------

test('daemon binds HIVE_HOST=0.0.0.0 on PORT (over HIVE_PORT); /healthz is unauthenticated; cached snapshot; events paging', { timeout: 60_000 }, async () => {
  const dir = copyFixture();
  const data = mkdtempSync(join(tmpdir(), 'hive-host-data-'));
  const port = await unusedPort('0.0.0.0');
  const ignoredPort = await unusedPort();
  const daemon = await startDaemon({ HIVE_HOST: '0.0.0.0', PORT: String(port), HIVE_PORT: String(ignoredPort), HIVE_PROJECT_ROOT: dir, HIVE_DATA_DIR: data }, port);
  try {
    assert.match(daemon.log(), new RegExp(`Hive daemon listening on http://0\\.0\\.0\\.0:${port}`));
    assert.match(daemon.log(), /WARNING listening on non-loopback host 0\.0\.0\.0/);
    await assert.rejects(fetch(`http://127.0.0.1:${ignoredPort}/healthz`), 'HIVE_PORT is not used when PORT is set');

    const health = await fetch(`${daemon.url}/healthz`);
    assert.equal(health.status, 200);
    const h = await health.json() as any;
    assert.equal(h.ok, true);
    for (const key of ['revision', 'indexed', 'recoveredJournals', 'uptimeMs', 'version']) assert.ok(key in h, `healthz has ${key}`);
    assert.equal(h.recoveredJournals, 0);
    assert.equal(typeof h.version, 'string');
    assert.equal((await fetch(`${daemon.url}/snapshot`)).status, 401, 'other routes still need a token');

    const client = api(daemon);
    const snap = await client.get('/snapshot');
    assert.equal(snap.status, 200);
    assert.equal(typeof snap.body.cacheAgeMs, 'number');
    const revision = snap.body.repository.revision;

    // Edit on disk: healthz and the cached snapshot keep the old revision until ?fresh=1 forces sync.
    writeFileSync(join(dir, 'src/pricing.ts'), `${readFileSync(join(dir, 'src/pricing.ts'), 'utf8')}\nexport const edited = 1;\n`);
    assert.equal((await client.get('/snapshot')).body.repository.revision, revision, 'served from cache');
    assert.equal((await (await fetch(`${daemon.url}/healthz`)).json() as any).revision, revision, 'healthz never syncs');
    assert.equal((await client.get('/api/view')).body.revision, revision);
    const fresh = await client.get('/snapshot?fresh=1');
    assert.equal(fresh.body.repository.revision, revision + 1);
    assert.equal((await client.get('/api/view')).body.revision, revision + 1);

    // A command updates the cache immediately.
    const reg = await client.command({ action: 'register', name: 'paging agent' });
    assert.equal(reg.status, 200);
    assert.ok((await client.get('/snapshot')).body.sessions.some((s: any) => s.id === reg.body.id));
    for (let i = 0; i < 12; i++) assert.equal((await client.command({ action: 'heartbeat', sessionId: reg.body.id })).status, 200);
    await client.command({ action: 'intent', sessionId: reg.body.id, intent: { task: `paging task in ${dir}`, files: ['src/pricing.ts'], symbols: [], assumptions: [] } });

    const all = (await client.get('/events?after=0&limit=1000')).body as any[];
    assert.ok(all.length >= 4);
    const seen: number[] = [];
    let after = 0;
    for (;;) {
      const page = (await client.get(`/events?after=${after}&limit=3`)).body as any[];
      if (!page.length) break;
      assert.ok(page.length <= 3);
      seen.push(...page.map(e => e.seq));
      after = page.at(-1).seq;
    }
    assert.deepEqual(seen, all.map(e => e.seq), 'every event exactly once across pages');
    assert.equal((await client.get('/events?after=abc')).status, 400);
    assert.ok(((await client.get('/events?limit=5000')).body as any[]).length <= 1000);

    // Viewers get scrubbed details, no payloads.
    const created = await client.command({ action: 'token_create', label: 'judge', member: 'Judge', role: 'viewer' });
    const viewer = api(daemon, created.body.token);
    const viewed = await viewer.get('/events?after=0&limit=1000');
    assert.equal(viewed.status, 200);
    assert.ok(viewed.body.every((e: any) => !('payload' in e)));
    assert.ok(!JSON.stringify(viewed.body).includes(dir), 'no absolute paths for viewers');
    assert.equal((await viewer.get('/snapshot')).status, 403);
    assert.equal((await viewer.get('/api/view?fresh=1')).status, 200, 'viewer fresh is ignored, not an error');

    assert.equal(await stop(daemon), 0);
    assert.match(daemon.log(), /SIGTERM received; draining/);
    assert.match(daemon.log(), /Hive daemon stopped/);
  } finally {
    await stop(daemon);
    rmSync(dir, { recursive: true, force: true }); rmSync(data, { recursive: true, force: true });
  }
});

test('a crashed journal is recovered at daemon start; SIGTERM exits 0; a second start on the same DB is clean and the timer picks up drift', { timeout: 60_000 }, async () => {
  const dir = copyFixture();
  const data = mkdtempSync(join(tmpdir(), 'hive-host-data-'));
  const files = ['src/tax.ts', 'src/invoice.ts'];
  const originals = Object.fromEntries(files.map(f => [f, readFileSync(join(dir, f), 'utf8')]));
  {
    // Simulate a process killed mid-apply on the daemon's own DB file.
    const store = new Store(join(data, 'hive.db'));
    const crash = () => { const error = new Error('process killed (simulated)'); error.name = 'SimulatedCrash'; throw error; };
    const service = new HiveService({ store, root: dir, onFileWritten: (_file, index) => { if (index === 0) crash(); } } satisfies ServiceOptions);
    const session = service.coordinator.register('A');
    service.sync();
    const preview = service.engine.preview(session.id, dropRegion);
    assert.throws(() => service.engine.apply(session.id, preview.proposalId), /simulated/);
    assert.notDeepEqual(Object.fromEntries(files.map(f => [f, readFileSync(join(dir, f), 'utf8')])), originals);
    store.close();
  }
  const port = await unusedPort();
  const env = { HIVE_PORT: String(port), HIVE_PROJECT_ROOT: dir, HIVE_DATA_DIR: data };
  const first = await startDaemon(env, port);
  let second: Daemon | null = null;
  try {
    const h1 = await (await fetch(`${first.url}/healthz`)).json() as any;
    assert.equal(h1.recoveredJournals, 1, 'the writing journal was restored on start');
    assert.deepEqual(Object.fromEntries(files.map(f => [f, readFileSync(join(dir, f), 'utf8')])), originals);
    const reg = await api(first).command({ action: 'register', name: 'before restart' });
    assert.equal(reg.status, 200);
    assert.equal(await stop(first), 0, 'SIGTERM exits 0');

    second = await startDaemon({ ...env, HIVE_SNAPSHOT_REFRESH_MS: '200' }, port);
    const h2 = await (await fetch(`${second.url}/healthz`)).json() as any;
    assert.equal(h2.ok, true);
    assert.equal(h2.recoveredJournals, 0, 'nothing left to recover after a clean stop');
    assert.equal(h2.indexed, true, 'index persisted in the DB');
    const events = (await api(second).get('/events?after=0&limit=1000')).body as any[];
    assert.ok(events.some(e => e.type === 'proposal.recovered'), 'state from before the restart is still there');
    const snap = (await api(second).get('/snapshot')).body;
    assert.ok(snap.sessions.some((s: any) => s.id === reg.body.id), 'session survived the restart');

    // The 5 s timer (200 ms here) runs quickChanges and rebuilds the cache when it finds drift.
    writeFileSync(join(dir, 'src/pricing.ts'), `${readFileSync(join(dir, 'src/pricing.ts'), 'utf8')}\nexport const edited = 1;\n`);
    let revision = snap.repository.revision;
    for (let i = 0; i < 30 && revision === snap.repository.revision; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      revision = (await api(second).get('/snapshot')).body.repository.revision;
    }
    assert.equal(revision, snap.repository.revision + 1, 'timer picked up the direct edit');
    assert.equal(await stop(second), 0);
  } finally {
    await stop(first);
    if (second) await stop(second);
    rmSync(dir, { recursive: true, force: true }); rmSync(data, { recursive: true, force: true });
  }
});

test('SIGTERM drains an in-flight verification: new POSTs get 503 draining, the run finishes and is recorded, exit 0', { timeout: 60_000 }, async () => {
  const dir = copyFixture();
  const data = mkdtempSync(join(tmpdir(), 'hive-host-data-'));
  writeFileSync(join(dir, 'src/pricing.ts'), PRODUCER_BODY);
  writeFileSync(join(dir, 'src/invoice.ts'), CONSUMER);
  writeFileSync(join(dir, 'tests/slow.test.ts'), "import { test } from 'node:test';\ntest('slow', async () => { await new Promise(resolve => setTimeout(resolve, 1500)); });\n");
  let ids: { a: string; contract: string };
  {
    const store = new Store(join(data, 'hive.db'));
    const service = new HiveService({ store, root: dir });
    const a = service.coordinator.register('pricing agent');
    const b = service.coordinator.register('invoice agent');
    service.coordinator.setIntent(a.id, { task: 'Unit-explicit getPrice', files: ['src/pricing.ts'], symbols: [PRODUCER], assumptions: [] });
    service.coordinator.setIntent(b.id, { task: 'Invoices', files: ['src/invoice.ts'], symbols: ['src/invoice.ts#invoiceTotal:function'], assumptions: [] });
    const contract = service.propose(a.id, { title: 'Explicit unit', declaration: DECLARATION, participants: [b.id], producerSymbol: PRODUCER });
    service.coordinator.acknowledge(b.id, contract.id, 1);
    service.coordinator.acknowledge(a.id, contract.id, 1);
    ids = { a: a.id, contract: contract.id };
    store.close();
  }
  const port = await unusedPort();
  const daemon = await startDaemon({ HIVE_PORT: String(port), HIVE_PROJECT_ROOT: dir, HIVE_DATA_DIR: data }, port);
  try {
    const client = api(daemon);
    const started = await client.command({ action: 'verify', sessionId: ids.a, contractId: ids.contract, command: 'node --test tests/slow.test.ts' });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.status, 'running');
    daemon.child.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 150));
    const refused = await client.command({ action: 'heartbeat', sessionId: ids.a });
    assert.equal(refused.status, 503);
    assert.deepEqual(refused.body, { error: 'draining' });
    const health = await fetch(`${daemon.url}/healthz`);
    assert.equal(health.status, 503);
    assert.equal((await health.json() as any).draining, true);
    assert.equal(daemon.child.exitCode, null, 'still waiting for the verification');
    assert.equal(await daemon.exit, 0);
    assert.match(daemon.log(), /draining \(1 in flight\)/);

    const store = new Store(join(data, 'hive.db'));
    try {
      const run = store.get<{ status: string; exit_code: number }>('SELECT status, exit_code FROM verification_runs WHERE id = ?', started.body.id);
      assert.equal(run?.status, 'passed', 'the run completed and was recorded before the store closed');
      assert.equal(Number(run?.exit_code), 0);
    } finally { store.close(); }
  } finally {
    await stop(daemon);
    rmSync(dir, { recursive: true, force: true }); rmSync(data, { recursive: true, force: true });
  }
});
