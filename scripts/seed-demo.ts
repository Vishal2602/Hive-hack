/**
 * Seeds a live Hive daemon with the billing scenario for dashboard work and screenshots.
 *
 *   node --disable-warning=ExperimentalWarning scripts/seed-demo.ts [--port 4318] [--keep]
 *
 * Copies ../hive-playground (or HIVE_PLAYGROUND) to a temp dir, starts a daemon child on 127.0.0.1:<port>
 * with a file database in that dir, creates member tokens through token_create, registers three agents
 * with their own tokens, declares intents, proposes and acknowledges the getPrice agreement, adapts the
 * consumer files (EDIT PERFORMED BY THIS SCRIPT, not by an agent), applies change_signature through Hive and
 * runs `npm test` as verification, which fails by design (the body still returns dollars). Then it prints
 * the dashboard URL and the admin token to stderr and heartbeats the sessions until SIGINT.
 * No model call is made. Everything is logged to stderr.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const log = (text = '') => process.stderr.write(`${text}\n`);
const fail = (message: string): never => { throw new Error(message); };

function parseArgs(argv: string[]): { port: number; keep: boolean } {
  let port = 4318;
  let keep = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--keep') keep = true;
    else if (arg === '--port' || arg.startsWith('--port=')) {
      const raw = arg.includes('=') ? arg.split('=')[1]! : argv[++i];
      if (!raw || !/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) fail(`--port needs a number 1-65535, got "${raw ?? ''}"`);
      port = Number(raw);
    } else if (arg === '--help' || arg === '-h') {
      log('Usage: node scripts/seed-demo.ts [--port 4318] [--keep]'); process.exit(0);
    } else fail(`Unknown argument ${arg}`);
  }
  return { port, keep };
}

const HIVE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLAYGROUND = resolve(process.env.HIVE_PLAYGROUND ?? join(HIVE_ROOT, '..', 'hive-playground'));
const PRODUCER = 'src/pricing.ts#getPrice:function';
const UNIT_KEY = 'src/pricing.ts#getPrice:unit';
const DECLARATION = "export declare function getPrice(sku: string, unit: 'cents' | 'dollars'): number;";
const NEW_SIGNATURE = "getPrice(sku: string, unit: 'cents' | 'dollars'): number";

/** The invoice agent's adaptation to the agreed interface. Performed by this script, announced as such. */
const CONSUMER_EDITS: Record<string, (text: string) => string> = {
  'src/invoice.ts': text => text.replace('getPrice(line.product.sku)', "getPrice(line.product.sku, 'dollars')"),
  'tests/invoice.test.ts': text => text.replace("assert.equal(getPrice('basic'), 19.99);", "assert.equal(getPrice('basic', 'dollars'), 19.99);")
    + "\ntest('getPrice in cents returns integer cents (the agreed behaviour)', () => {\n  assert.equal(getPrice('basic', 'cents'), 1999);\n});\n",
};

interface Session { id: string; name: string }
interface Created { token: string; record: { id: string; label: string; member: string; role: string } }
interface Contract { id: string; version: number; status: string }
interface Run { id: string; status: string; exitCode: number | null; passed: boolean; reasons: string[]; output: string }

/** Set once the daemon is spawned: stops it and removes the temp copy. */
let cleanupRef: ((code: number) => Promise<void>) | null = null;

async function main(): Promise<void> {
  const { port, keep } = parseArgs(process.argv.slice(2));
  if (!existsSync(join(PLAYGROUND, 'src', 'pricing.ts'))) fail(`Playground not found at ${PLAYGROUND} (set HIVE_PLAYGROUND)`);
  const fromEnv = Boolean(process.env.HIVE_TOKEN && process.env.HIVE_TOKEN !== 'replace-with-a-local-random-token');
  const adminToken = fromEnv ? process.env.HIVE_TOKEN! : `seed-${randomBytes(24).toString('base64url')}`;

  // <tmp>/hive-seed-XXXX/hive-playground: the workspace name shown in the dashboard is the folder name.
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'hive-seed-')));
  const dir = join(parent, 'hive-playground');
  cpSync(PLAYGROUND, dir, { recursive: true, filter: source => !/[\\/]\.hive([\\/]|$)/.test(source.slice(PLAYGROUND.length)) });
  log(`seed: copied ${PLAYGROUND} -> ${dir}`);

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string') env[key] = value;
  for (const key of ['PORT', 'HIVE_DB', 'NODE_OPTIONS', 'NODE_TEST_CONTEXT', 'HIVE_PUBLIC_URL', 'HIVE_HOST', 'HIVE_WEB_DIST']) delete env[key];
  Object.assign(env, { HIVE_TOKEN: adminToken, HIVE_PORT: String(port), HIVE_HOST: '127.0.0.1', HIVE_PROJECT_ROOT: dir, HIVE_DATA_DIR: join(dir, '.hive') });

  const daemon: ChildProcess = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(HIVE_ROOT, 'src', 'server', 'daemon.ts')],
    { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let shuttingDown = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const cleanup = async (code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (heartbeat) clearInterval(heartbeat);
    if (daemon.exitCode === null && daemon.signalCode === null) {
      const exited = new Promise(resolveExit => daemon.once('exit', resolveExit));
      daemon.kill('SIGTERM');
      await Promise.race([exited, new Promise(r => setTimeout(r, 12_000))]);
    }
    if (!keep) rmSync(parent, { recursive: true, force: true });
    else log(`seed: kept ${dir}`);
    process.exit(code);
  };
  cleanupRef = cleanup;
  process.on('SIGINT', () => { log('\nseed: stopping'); void cleanup(0); });
  process.on('SIGTERM', () => { void cleanup(0); });

  await new Promise<void>((resolveReady, reject) => {
    let buffer = '';
    daemon.stderr!.on('data', chunk => {
      const text = String(chunk);
      for (const line of text.split('\n')) if (line.trim()) log(`[daemon] ${line}`);
      buffer += text;
      if (buffer.includes('Hive daemon listening')) resolveReady();
    });
    daemon.once('error', reject);
    daemon.once('exit', code => {
      if (!shuttingDown) { log(`seed: daemon exited (${code})`); void cleanup(1); }
      reject(new Error(`daemon exited ${code}`));
    });
  });

  const base = `http://127.0.0.1:${port}`;
  const call = async <T>(token: string, body: Record<string, unknown>): Promise<T> => {
    const response = await fetch(`${base}/command`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json() as T & { error?: string };
    if (!response.ok) fail(`${String(body.action)} failed (${response.status}): ${data.error ?? 'unknown error'}`);
    return data;
  };

  log('seed: creating member tokens (values stay in this process; only the admin token is printed)');
  const sanika = await call<Created>(adminToken, { action: 'token_create', label: 'Sanika laptop', member: 'Sanika', role: 'member' });
  const vishalInvoice = await call<Created>(adminToken, { action: 'token_create', label: 'Vishal workstation', member: 'Vishal', role: 'member' });
  const vishalUi = await call<Created>(adminToken, { action: 'token_create', label: 'Vishal UI laptop', member: 'Vishal', role: 'member' });

  log('seed: registering Sanika · pricing agent, Vishal · invoice agent, Vishal · UI agent');
  const pricing = await call<Session>(sanika.token, { action: 'register', name: 'pricing agent', client: 'claude-code' });
  const invoice = await call<Session>(vishalInvoice.token, { action: 'register', name: 'invoice agent', client: 'muse-code' });
  const ui = await call<Session>(vishalUi.token, { action: 'register', name: 'UI agent', client: 'claude-code' });

  await call(sanika.token, { action: 'intent', sessionId: pricing.id, intent: { task: 'Return integer cents from getPrice',
    files: ['src/pricing.ts', 'src/catalog.ts'], symbols: [PRODUCER], assumptions: [{ key: UNIT_KEY, value: 'cents' }] } });
  await call(vishalInvoice.token, { action: 'intent', sessionId: invoice.id, intent: { task: 'Add buildReceipt with dollar totals',
    files: ['src/invoice.ts', 'tests/invoice.test.ts'], symbols: ['src/invoice.ts#lineTotal:function'], assumptions: [{ key: UNIT_KEY, value: 'dollars' }] } });
  await call(vishalUi.token, { action: 'intent', sessionId: ui.id, intent: { task: "Rename the export button to 'Download invoice'",
    files: ['src/ui/button.ts'], symbols: [], assumptions: [] } });

  log('seed: pricing agent proposes the getPrice agreement');
  const contract = await call<Contract>(sanika.token, { action: 'propose', sessionId: pricing.id, title: 'Explicit unit parameter on getPrice',
    declaration: DECLARATION, participants: [invoice.id], producerSymbol: PRODUCER,
    behaviorNotes: "getPrice('basic', 'cents') returns 1999; getPrice('basic', 'dollars') returns 19.99; invoices keep printing dollars." });
  await call(vishalInvoice.token, { action: 'acknowledge', sessionId: invoice.id, contractId: contract.id, version: contract.version });
  const accepted = await call<Contract>(sanika.token, { action: 'acknowledge', sessionId: pricing.id, contractId: contract.id, version: contract.version });
  log(`seed: agreement v${contract.version} ${accepted.status}`);

  log('seed: EDIT PERFORMED BY THIS SCRIPT (standing in for the invoice agent): adapt src/invoice.ts and tests/invoice.test.ts');
  for (const [file, edit] of Object.entries(CONSUMER_EDITS)) {
    const path = join(dir, file);
    const before = readFileSync(path, 'utf8');
    const after = edit(before);
    if (after === before) fail(`consumer edit did not apply to ${file}`);
    writeFileSync(path, after);
  }

  log('seed: pricing agent applies change_signature through Hive');
  const preview = await call<{ proposalId: string; status: string; rejections: string[] }>(sanika.token,
    { action: 'preview', sessionId: pricing.id, operation: { kind: 'change_signature', symbol: PRODUCER, declaration: NEW_SIGNATURE } });
  if (preview.status !== 'previewed') fail(`change_signature preview ${preview.status}: ${preview.rejections.join('; ')}`);
  const applied = await call<{ status: string; revision: number }>(sanika.token, { action: 'apply', sessionId: pricing.id, proposalId: preview.proposalId });
  log(`seed: apply ${applied.status} at revision ${applied.revision}`);

  log('seed: verification `npm test` (expected to FAIL: getPrice still returns dollars)');
  let run = await call<Run>(sanika.token, { action: 'verify', sessionId: pricing.id, contractId: contract.id, command: 'npm test' });
  const deadline = Date.now() + 130_000;
  while (run.status === 'running' && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
    run = await call<Run>(sanika.token, { action: 'verify_status', runId: run.id, sessionId: pricing.id });
  }
  log(`seed: verification ${run.status}, exit ${run.exitCode}${run.reasons.length ? ` (${run.reasons[0]})` : ''}`);

  // Keep the three agents alive (lease 120 s) while the dashboard is open.
  heartbeat = setInterval(() => {
    for (const [token, session] of [[sanika.token, pricing], [vishalInvoice.token, invoice], [vishalUi.token, ui]] as const) {
      void call(token, { action: 'heartbeat', sessionId: session.id }).catch(error => log(`seed: heartbeat failed: ${error instanceof Error ? error.message : error}`));
    }
  }, 30_000);

  log('');
  log('='.repeat(72));
  log(`Hive seeded. Dashboard: ${base}/ui/`);
  log(fromEnv ? 'Admin token: the HIVE_TOKEN value from your environment.' : `Admin token (throwaway, this run only): ${adminToken}`);
  log(`Workspace copy: ${dir}${keep ? '' : ' (deleted on exit; --keep to keep it)'}`);
  log('Press Ctrl+C to stop.');
  log('='.repeat(72));
}

main().catch(error => {
  log(`seed: FAILED: ${error instanceof Error ? error.message : String(error)}`);
  if (cleanupRef) void cleanupRef(1); else process.exit(1);
});
