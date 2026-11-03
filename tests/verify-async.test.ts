import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verificationEnv } from '../src/contracts/service.ts';
import { HiveService, type ServiceOptions } from '../src/service.ts';
import { migrations } from '../src/store/schema.ts';
import { Store } from '../src/store/sqlite.ts';

const fixture = fileURLToPath(new URL('../fixtures/billing/', import.meta.url));
const PRODUCER = 'src/pricing.ts#getPrice:function';
const DECLARATION = "export declare function getPrice(unit: 'cents' | 'dollars'): number;";
const PRODUCER_BODY = "export function getPrice(unit: 'cents' | 'dollars'): number { return unit === 'cents' ? 1999 : 19.99; }\n";
const CONSUMER = "import { getPrice } from './pricing.ts';\nimport { applyTax } from './tax.ts';\nexport function invoiceTotal(): string { return `$${(getPrice('cents') / 100).toFixed(2)}`; }\nexport function invoiceWithTax(): number { return applyTax(getPrice('dollars'), 0.2, 'EU'); }\n";
const sleepTest = (ms: number, extra = '') => `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { getPrice } from '../src/pricing.ts';\n${extra}\ntest('slow behaviour check', async () => {\n  await new Promise(resolve => setTimeout(resolve, ${ms}));\n  assert.equal(getPrice('cents'), 1999);\n});\n`;

/** Billing fixture copy where the producer already satisfies the declaration and both sessions accepted the contract. */
function setup(options: Partial<ServiceOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hive-verify-'));
  cpSync(fixture, dir, { recursive: true });
  const write = (file: string, text: string) => writeFileSync(join(dir, file), text);
  write('src/pricing.ts', PRODUCER_BODY);
  write('src/invoice.ts', CONSUMER);
  const service = new HiveService({ store: new Store(), root: dir, ...options });
  const a = service.coordinator.register('pricing agent');
  const b = service.coordinator.register('invoice agent');
  service.coordinator.setIntent(a.id, { task: 'Unit-explicit getPrice', files: ['src/pricing.ts'], symbols: [PRODUCER], assumptions: [] });
  service.coordinator.setIntent(b.id, { task: 'Invoices', files: ['src/invoice.ts'], symbols: ['src/invoice.ts#invoiceTotal:function'], assumptions: [] });
  const contract = service.propose(a.id, { title: 'Explicit unit', declaration: DECLARATION, participants: [b.id], producerSymbol: PRODUCER });
  service.coordinator.acknowledge(b.id, contract.id, 1);
  service.coordinator.acknowledge(a.id, contract.id, 1);
  const events = (type: string) => service.coordinator.events(0, 1000).filter(e => e.type === type);
  return { dir, service, a, b, contract, write, events, cleanup: async () => { await service.drainVerifications(); rmSync(dir, { recursive: true, force: true }); } };
}

test('verify returns a running run at once; heartbeat and snapshot stay under 500 ms while a 3 s test runs', { timeout: 30_000 }, async () => {
  const { service, a, b, contract, write, events, cleanup } = setup();
  try {
    write('tests/slow.test.ts', sleepTest(3_000));
    const t0 = performance.now();
    const run = service.verify(a.id, contract.id, 'node --test tests/slow.test.ts');
    const startMs = performance.now() - t0;
    assert.equal(run.status, 'running');
    assert.equal(run.exitCode, null);
    assert.equal(run.passed, false);
    assert.ok(startMs < 500, `verify() blocked for ${startMs.toFixed(0)} ms`);
    assert.equal(service.inFlightVerifications, 1);
    assert.equal(events('contract.verification_started').length, 1);

    const latencies: number[] = [];
    for (let i = 0; i < 8; i++) {
      const timerStart = performance.now();
      await new Promise(resolve => setTimeout(resolve, 150));
      const loopLag = performance.now() - timerStart - 150;
      const callStart = performance.now();
      service.coordinator.heartbeat(b.id);
      service.snapshot();
      const callMs = performance.now() - callStart;
      latencies.push(callMs);
      assert.ok(loopLag < 500, `event loop stalled ${loopLag.toFixed(0)} ms during verification`);
      assert.ok(callMs < 500, `heartbeat+snapshot took ${callMs.toFixed(0)} ms during verification`);
      assert.equal(service.verifyStatus(run.id).status, 'running', 'the 3 s test must still be running while we measure');
    }
    assert.equal(service.coordinator.contract(contract.id).status, 'implemented', 'a running run never marks the contract verified');

    const done = await service.waitForRun(run.id);
    assert.equal(done.status, 'passed', done.output);
    assert.equal(done.exitCode, 0);
    assert.ok(done.finishedAt! >= done.at);
    assert.deepEqual(Object.keys(done.sourceHashes).sort(), ['src/invoice.ts', 'src/pricing.ts']);
    assert.equal(service.inFlightVerifications, 0);
    const verified = service.coordinator.contract(contract.id);
    assert.equal(verified.status, 'verified');
    assert.equal(verified.evidence.verification!.id, run.id);
    assert.equal(events('contract.verified').length, 1);
    assert.deepEqual(service.contracts.runs(contract.id).map(r => r.status), ['passed'], 'the running row is updated in place');
  } finally { await cleanup(); }
});

test('a checked file changed during the run makes it inconclusive, never passed', { timeout: 30_000 }, async () => {
  const { dir, service, a, contract, write, events, cleanup } = setup();
  try {
    write('tests/slow.test.ts', sleepTest(1_500));
    const run = service.verify(a.id, contract.id, 'node --test tests/slow.test.ts');
    await new Promise(resolve => setTimeout(resolve, 300));
    write('src/pricing.ts', readFileSync(join(dir, 'src/pricing.ts'), 'utf8') + '// edited while tests ran\n');
    const done = await service.waitForRun(run.id);
    assert.equal(done.exitCode, 0, 'the test itself passed');
    assert.equal(done.status, 'inconclusive');
    assert.equal(done.passed, false);
    assert.match(done.reasons.join(), /files changed during the run: src\/pricing\.ts/);
    assert.notEqual(service.coordinator.contract(contract.id).status, 'verified');
    assert.equal(events('contract.verification_inconclusive').length, 1);
    assert.equal(events('contract.verified').length, 0);
  } finally { await cleanup(); }
});

test('the child gets a minimal environment without Hive or model secrets', { timeout: 30_000 }, async () => {
  const saved = { HIVE_TOKEN: process.env.HIVE_TOKEN, MODEL_API_KEY: process.env.MODEL_API_KEY, NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT };
  const { service, a, contract, write, cleanup } = setup();
  try {
    process.env.HIVE_TOKEN = 'throwaway-test-token';
    process.env.MODEL_API_KEY = 'throwaway-test-key';
    assert.deepEqual(Object.keys(verificationEnv({ PATH: '/bin', HOME: '/h', LANG: 'C', HIVE_TOKEN: 'x', MODEL_API_KEY: 'y', NODE_OPTIONS: '--inspect', NODE_TEST_CONTEXT: 'child' })).sort(), ['HOME', 'LANG', 'PATH']);
    write('tests/env.test.ts', sleepTest(0, "for (const key of ['HIVE_TOKEN', 'MODEL_API_KEY', 'NODE_OPTIONS']) assert.equal(process.env[key], undefined, key);\nconsole.log('CHILD_ENV_KEYS=' + Object.keys(process.env).filter(k => !k.startsWith('NODE_TEST')).sort().join(','));"));
    const done = await service.waitForRun(service.verify(a.id, contract.id, 'node --test tests/env.test.ts').id);
    assert.equal(done.status, 'passed', done.output);
    assert.doesNotMatch(done.output, /throwaway-test/);
    const keys = /CHILD_ENV_KEYS=([^\s]*)/.exec(done.output)?.[1]?.split(',') ?? [];
    assert.ok(keys.includes('PATH'));
    // macOS adds __CF_USER_TEXT_ENCODING to every process at launch; it does not come from the parent.
    assert.ok(keys.every(key => ['PATH', 'HOME', 'LANG', 'TMPDIR', '__CF_USER_TEXT_ENCODING'].includes(key)), `unexpected child env keys: ${keys.join(',')}`);
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await cleanup();
  }
});

test('a run that exceeds the timeout is killed and recorded as failed', { timeout: 30_000 }, async () => {
  const { service, a, contract, write, events, cleanup } = setup({ verifyTimeoutMs: 500 });
  try {
    write('tests/hang.test.ts', sleepTest(20_000));
    const t0 = performance.now();
    const done = await service.waitForRun(service.verify(a.id, contract.id, 'node --test tests/hang.test.ts').id);
    assert.ok(performance.now() - t0 < 8_000, 'the child was killed, not waited out');
    assert.equal(done.status, 'failed');
    assert.match(done.reasons.join(), /timed out after/);
    assert.equal(service.coordinator.contract(contract.id).status, 'implemented');
    assert.equal(events('contract.verification_failed').length, 1);
  } finally { await cleanup(); }
});

test('a command that cannot start is an error, not a pass; pending runs report pending; duplicates are handled', { timeout: 30_000 }, async () => {
  const { service, a, contract, write, events, cleanup } = setup({ verifyAllow: ['node --test', 'hive-no-such-binary-xyz'] });
  try {
    const missing = await service.waitForRun(service.verify(a.id, contract.id, 'hive-no-such-binary-xyz').id);
    assert.equal(missing.status, 'error');
    assert.equal(missing.exitCode, null);
    assert.match(missing.reasons.join(), /could not start hive-no-such-binary-xyz/);
    assert.equal(events('contract.verification_failed').at(-1)!.payload!.status, 'error');
    assert.throws(() => service.verify(a.id, contract.id, 'npm test'), /allowlist/);

    write('tests/slow.test.ts', sleepTest(1_000));
    const run = service.verify(a.id, contract.id, 'node --test tests/slow.test.ts');
    assert.equal(service.verify(a.id, contract.id, 'node --test tests/slow.test.ts').id, run.id, 'same command while running returns the same run');
    assert.throws(() => service.verify(a.id, contract.id, 'node --test tests/pricing.test.ts'), /already running/);
    const pending = await service.waitForRun(run.id, 50);
    assert.equal(pending.status, 'running', 'a wait that times out reports pending, not failure');
    assert.throws(() => service.verifyStatus('00000000-0000-4000-8000-000000000000'), /Unknown verification run/);
    assert.equal((await service.waitForRun(run.id)).status, 'passed');
  } finally { await cleanup(); }
});

test('combined stdout and stderr are capped at 64 KB, keeping the tail', { timeout: 30_000 }, async () => {
  const { service, a, contract, write, cleanup } = setup();
  try {
    write('tests/noisy.test.ts', sleepTest(0, "process.stdout.write('x'.repeat(150_000) + '\\n');\nprocess.stderr.write('y'.repeat(50_000) + '\\nEND-OF-OUTPUT\\n');"));
    const done = await service.waitForRun(service.verify(a.id, contract.id, 'node --test tests/noisy.test.ts').id);
    assert.equal(done.status, 'passed');
    const marker = /^\[output truncated: first (\d+) bytes dropped\]\n/.exec(done.output);
    assert.ok(marker, 'truncation is stated, not silent');
    assert.ok(Buffer.byteLength(done.output.slice(marker[0].length)) <= 64 * 1024);
    assert.match(done.output, /END-OF-OUTPUT|pass 1/, 'the tail (where results are) is kept');
    assert.equal(service.contracts.runs(contract.id)[0]!.output, done.output, 'the capped output is what is stored');
  } finally { await cleanup(); }
});

test('migration backfills status on runs recorded before asynchronous verification', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-verify-db-'));
  try {
    const path = join(dir, 'hive.db');
    const index = migrations.findIndex(sql => /verification_runs ADD COLUMN status/.test(sql));
    assert.ok(index > 0);
    const db = new DatabaseSync(path);
    for (const sql of migrations.slice(0, index)) db.exec(sql);
    db.exec(`PRAGMA user_version = ${index}`);
    const insert = db.prepare("INSERT INTO verification_runs(id, contract_id, version, source_hashes_json, command, exit_code, output, revision, overlay, passed, created_at) VALUES (?, 'c', 1, '{}', 'npm test', ?, '', 1, 0, ?, 5)");
    insert.run('old-pass', 0, 1); insert.run('old-fail', 1, 0);
    db.close();
    const store = new Store(path);
    const rows = store.all<{ id: string; status: string; finished_at: number }>('SELECT id, status, finished_at FROM verification_runs ORDER BY id');
    assert.deepEqual(rows.map(r => [r.id, r.status, Number(r.finished_at)]), [['old-fail', 'failed', 5], ['old-pass', 'passed', 5]]);
    assert.throws(() => store.run("UPDATE verification_runs SET status = 'maybe' WHERE id = 'old-pass'"), /CHECK constraint/);
    store.db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
