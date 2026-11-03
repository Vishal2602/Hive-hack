import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPath } from '../src/remote/paths.ts';

const fixture = fileURLToPath(new URL('../fixtures/billing/', import.meta.url));
const daemonPath = fileURLToPath(new URL('../src/server/daemon.ts', import.meta.url));
const hookPath = fileURLToPath(new URL('../src/hooks/hook.ts', import.meta.url));

async function unusedPort(): Promise<number> {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test port');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
type HookOut = { hookSpecificOutput: { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string } };
function runHook(event: string, env: Record<string, string>, stdin: unknown, hook = env.HOOK_FILE ?? hookPath): { status: number | null; stderr: string; out: HookOut['hookSpecificOutput'] } {
  const proc = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', hook, event, '--client', 'claude'], { env, input: JSON.stringify(stdin), encoding: 'utf8', timeout: 60_000 });
  const parsed = (() => { try { return JSON.parse(proc.stdout) as HookOut; } catch { return null; } })();
  assert.ok(parsed, `hook printed no JSON: ${proc.stdout} ${proc.stderr}`);
  return { status: proc.status, stderr: proc.stderr, out: parsed.hookSpecificOutput };
}
async function command(url: string, token: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${url}/command`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

test('remote paths: only repository-relative TypeScript sources outside node_modules/.git/.hive are synced', () => {
  assert.equal(checkPath('src/pricing.ts'), null);
  assert.equal(checkPath('src/ui/Button.tsx'), null);
  for (const bad of ['../etc/passwd.ts', '/abs/x.ts', 'src/../x.ts', 'node_modules/a/index.ts', '.git/x.ts', '.hive/x.ts', 'src/types.d.ts', 'README.md', 'src\\win.ts', '.env.ts', ''])
    assert.notEqual(checkPath(bad), null, bad);
});

test('laptop sync: an edit that breaks another member\'s uncommitted work is caught before the write, both agents are told, the hub checkout is untouched',
  { timeout: 120_000 }, async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'hive-remote-'));
    const hub = join(tmp, 'hub'); const sanika = join(tmp, 'sanika'); const vishal = join(tmp, 'vishal');
    cpSync(fixture, hub, { recursive: true });
    git(hub, 'init', '-q'); git(hub, 'add', '-A'); git(hub, 'commit', '-qm', 'base');
    spawnSync('git', ['clone', '-q', hub, sanika]); spawnSync('git', ['clone', '-q', hub, vishal]);
    const hubHashes = ['src/pricing.ts', 'src/invoice.ts'].map(p => sha(join(hub, p)));

    const port = await unusedPort();
    const url = `http://127.0.0.1:${port}`;
    const base: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'));
    const admin = 'remote-test-admin-token';
    const daemon = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', daemonPath],
      { env: { ...base, HIVE_TOKEN: admin, HIVE_PORT: String(port), HIVE_DB: ':memory:', HIVE_PROJECT_ROOT: hub, HIVE_SNAPSHOT_REFRESH_MS: '200' }, stdio: ['ignore', 'ignore', 'pipe'] });
    try {
      await new Promise<void>((resolve, reject) => {
        let log = '';
        daemon.stderr!.on('data', chunk => { log += String(chunk); if (log.includes('Hive daemon listening')) resolve(); });
        daemon.once('exit', code => reject(new Error(`Daemon exited ${code}: ${log}`)));
      });
      const tokenFor = async (member: string, role = 'member') => String(((await command(url, admin, { action: 'token_create', label: `${member} laptop`, member, role })).json).token);
      const sanikaEnv = { ...base, HIVE_URL: url, HIVE_TOKEN: await tokenFor('sanika') };
      const viewer = await tokenFor('judge', 'viewer');

      // Vishal sets up his laptop with the served one-time script (no Hive checkout needed). No claude CLI on PATH here.
      const vishalToken = await tokenFor('vishal');
      const script = await (await fetch(`${url}/connect.mjs`)).text();
      assert.ok(!script.includes(admin) && !script.includes(vishalToken), 'served script carries no secrets');
      writeFileSync(join(tmp, 'hive-connect.mjs'), script);
      const noClaude = { ...base, PATH: '/usr/bin:/bin', HIVE_URL: '' };
      assert.notEqual(spawnSync(process.execPath, [join(tmp, 'hive-connect.mjs'), viewer], { cwd: vishal, env: noClaude, encoding: 'utf8' }).status, 0, 'viewer tokens are refused');
      const setup = spawnSync(process.execPath, [join(tmp, 'hive-connect.mjs'), vishalToken], { cwd: join(vishal, 'src'), env: noClaude, encoding: 'utf8' });
      assert.equal(setup.status, 0, setup.stderr);
      assert.match(setup.stdout, /Connected vishal/);
      const settings = JSON.parse(readFileSync(join(vishal, '.claude/settings.local.json'), 'utf8')) as { env: Record<string, string>; hooks: Record<string, { hooks: { command: string }[] }[]> };
      assert.deepEqual(settings.env, { HIVE_URL: url, HIVE_TOKEN: vishalToken });
      assert.deepEqual(Object.keys(settings.hooks).sort(), ['PostToolUse', 'PreToolUse', 'SessionStart', 'UserPromptSubmit']);
      assert.match(settings.hooks.PreToolUse![0]!.hooks[0]!.command, /\.hive\/hive-hook\.mjs" pre-write/);
      assert.match(readFileSync(join(vishal, '.git/info/exclude'), 'utf8'), /^\.claude\/settings\.local\.json$/m);
      assert.equal(git(vishal, 'status', '--porcelain'), '', 'setup changes no tracked or visible files');
      const vishalEnv = { ...base, ...settings.env, HOOK_FILE: join(vishal, '.hive/hive-hook.mjs') };

      // Vishal's Claude adds a receipt function in his local invoice.ts (uncommitted) plus a new untracked file.
      const invoice = join(vishal, 'src/invoice.ts');
      writeFileSync(invoice, `${readFileSync(invoice, 'utf8')}export function receiptLine(): string { return \`Total \${getPrice().toFixed(2)}\`; }\n`);
      writeFileSync(join(vishal, 'src/receipt.ts'), "import { getPrice } from './pricing.ts';\nexport const receiptTotal = (): number => getPrice();\n");
      const start = runHook('session-start', vishalEnv, { session_id: 'v1', cwd: vishal });
      assert.equal(start.status, 0, start.stderr);
      assert.match(start.out.additionalContext!, /Hive is checking your local changes \(2 file/);
      let state = (await command(url, admin, { action: 'remote_status' })).json as { members: { member: string; files: { path: string }[] }[] };
      assert.deepEqual(state.members.map(m => [m.member, m.files.map(f => f.path)]), [['vishal', ['src/invoice.ts', 'src/receipt.ts']]]);

      // Sanika's Claude is about to change getPrice to take a unit. Before the write, Hive compiles it against Vishal's real edits.
      const pricing = join(sanika, 'src/pricing.ts');
      const edit = { tool_name: 'Edit', cwd: sanika, tool_input: { file_path: pricing, old_string: 'getPrice(): number { return 19.99; }', new_string: "getPrice(unit: 'cents' | 'dollars'): number { return unit === 'cents' ? 1999 : 19.99; }" } };
      const pre = runHook('pre-write', sanikaEnv, edit);
      assert.equal(pre.status, 0, pre.stderr);
      assert.equal(pre.out.permissionDecision, 'ask');
      assert.match(pre.out.permissionDecisionReason!, /would break work in progress by vishal/);
      assert.match(pre.out.permissionDecisionReason!, /src\/invoice\.ts:\d+ TS2554/);
      assert.match(pre.out.permissionDecisionReason!, /src\/receipt\.ts/);
      // A harmless edit to the same file is not gated.
      const harmless = runHook('pre-write', sanikaEnv, { ...edit, tool_input: { file_path: pricing, old_string: '/** Returns US dollars.', new_string: '/** Returns US dollars (documented).' } });
      assert.equal(harmless.out.permissionDecision, undefined);
      // HIVE_HOOK_GATE=deny blocks it outright.
      const denied = runHook('pre-write', { ...sanikaEnv, HIVE_HOOK_GATE: 'deny' }, edit);
      assert.equal(denied.status, 2);
      assert.equal(denied.out.permissionDecision, 'deny');

      // Sanika approves anyway; her edit lands locally and the post-write hook syncs it.
      writeFileSync(pricing, readFileSync(pricing, 'utf8').replace(edit.tool_input.old_string, edit.tool_input.new_string));
      const post = runHook('post-write', sanikaEnv, { ...edit, tool_response: {} });
      assert.equal(post.status, 0, post.stderr);
      assert.match(post.out.additionalContext ?? '', /sanika's uncommitted changes break vishal's work/);

      // The dashboard and Vishal's next prompt both carry the compiler finding.
      const snapshot = await (await fetch(`${url}/snapshot`, { headers: { Authorization: `Bearer ${admin}` } })).json() as { findings: { kind: string; severity: string; evidence: string }[] };
      const finding = snapshot.findings.find(f => f.kind === 'structural_incompatibility');
      assert.ok(finding, JSON.stringify(snapshot.findings));
      assert.equal(finding.severity, 'error');
      const prompt = runHook('prompt', vishalEnv, { session_id: 'v1', cwd: vishal, prompt: 'continue' });
      assert.match(prompt.out.additionalContext!, /sanika's uncommitted changes break vishal's work/);

      // Viewer-safe view lists who has changes, with relative paths only.
      const view = await (await fetch(`${url}/api/view`, { headers: { Authorization: `Bearer ${viewer}` } })).json() as { remote: { members: { member: string; files: { path: string }[] }[] } };
      assert.deepEqual(view.remote.members.map(m => m.member).sort(), ['sanika', 'vishal']);
      assert.ok(!JSON.stringify(view).includes(tmp), 'no absolute paths in the viewer view');

      // Sanika reverts: content equal to the hub base clears her change and the finding goes away.
      git(sanika, 'checkout', '--', 'src/pricing.ts');
      runHook('post-write', sanikaEnv, { ...edit, tool_response: {} });
      state = (await command(url, admin, { action: 'remote_status' })).json as typeof state;
      assert.deepEqual(state.members.map(m => m.member), ['vishal']);
      const after = await (await fetch(`${url}/snapshot`, { headers: { Authorization: `Bearer ${admin}` } })).json() as typeof snapshot;
      assert.equal(after.findings.filter(f => f.kind === 'structural_incompatibility').length, 0);

      // Unsafe paths are rejected; viewers cannot push; the hub checkout was never written.
      const pushed = (await command(url, sanikaEnv.HIVE_TOKEN, { action: 'remote_push', files: [{ path: '../escape.ts', content: 'x' }, { path: 'node_modules/x/index.ts', content: 'x' }, { path: 'src/ok.ts', content: 'export const ok = 1;\n' }] })).json as { stored: string[]; rejected: string[] };
      assert.deepEqual(pushed.stored, ['src/ok.ts']);
      assert.equal(pushed.rejected.length, 2);
      assert.equal((await command(url, viewer, { action: 'remote_push', files: [] })).status, 403);
      assert.deepEqual(['src/pricing.ts', 'src/invoice.ts'].map(p => sha(join(hub, p))), hubHashes);
      assert.equal(git(hub, 'status', '--porcelain'), '');
    } finally {
      daemon.kill('SIGTERM');
      await once(daemon, 'exit').catch(() => {});
      rmSync(tmp, { recursive: true, force: true });
    }
  });

test('laptop sync: Muse Spark evidence carries each member\'s diff and session ids, so a units mismatch with matching types can be analysed', async () => {
  const { HiveService } = await import('../src/service.ts');
  const { Store } = await import('../src/store/sqlite.ts');
  const dir = mkdtempSync(join(tmpdir(), 'hive-remote-evidence-'));
  cpSync(fixture, dir, { recursive: true });
  let seen: import('../src/intelligence/types.ts').EvidenceBundle | null = null;
  let known: string[] = [];
  const analyzer = { configured: true, model: 'fake', analyze: async (bundle: import('../src/intelligence/types.ts').EvidenceBundle, sessions: string[]) => {
    seen = bundle; known = sessions;
    return { summary: 'ok', findings: [], model: 'fake', usage: null, latencyMs: 1, attempts: 1, dropped: [] };
  } };
  try {
    const service = new HiveService({ store: new Store(), root: dir, analyzer });
    const s = service.coordinator.register('pricing agent', { member: 'sanika' });
    const v = service.coordinator.register('invoice agent', { member: 'vishal' });
    const pricing = readFileSync(join(dir, 'src/pricing.ts'), 'utf8');
    service.remote.push('sanika', { files: [{ path: 'src/pricing.ts', content: pricing.replace('return 19.99;', 'return 1999; // integer cents') }] });
    service.remote.push('vishal', { files: [{ path: 'src/invoice.ts', content: `${readFileSync(join(dir, 'src/invoice.ts'), 'utf8')}export const receipt = (): string => \`$\${getPrice().toFixed(2)}\`;\n` }] });
    // Same types on both sides: the compiler finds nothing to report.
    assert.equal(service.remote.findings().length, 0);
    await service.analyze(s.id, { force: true });
    const bundle = seen as unknown as import('../src/intelligence/types.ts').EvidenceBundle;
    assert.ok(bundle.changes, 'changes present');
    const byFile = Object.fromEntries(bundle.changes!.map(c => [c.file, c]));
    assert.match(byFile['src/pricing.ts']!.diff, /-export function getPrice\(\): number \{ return 19\.99; \}/);
    assert.match(byFile['src/pricing.ts']!.diff, /\+.*return 1999; \/\/ integer cents/);
    assert.deepEqual(byFile['src/pricing.ts']!.sessionIds, [s.id]);
    assert.deepEqual(byFile['src/invoice.ts']!.sessionIds, [v.id]);
    assert.ok(known.includes(v.id), 'members with changes are valid finding participants');
    // A change to the synced files changes the cache key: the next analysis is not served from cache.
    const first = bundle.inputHash;
    service.remote.push('vishal', { files: [{ path: 'src/invoice.ts', content: readFileSync(join(dir, 'src/invoice.ts'), 'utf8') + '// edited\n' }] });
    assert.notEqual(service.analysis.buildEvidence().inputHash, first);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('first boot: HIVE_REPO_URL is cloned into an empty project root once; an existing checkout is left alone; credentials are masked', async () => {
  const { maskUrl, prepareRepository } = await import('../src/server/prepare.ts');
  const tmp = mkdtempSync(join(tmpdir(), 'hive-prepare-'));
  try {
    const origin = join(tmp, 'origin');
    cpSync(fixture, origin, { recursive: true });
    git(origin, 'init', '-q'); git(origin, 'add', '-A'); git(origin, 'commit', '-qm', 'base');
    const root = join(tmp, 'data', 'repo');
    assert.equal(prepareRepository(root, { HIVE_REPO_URL: '' }), 'skipped');
    assert.equal(prepareRepository(root, { HIVE_REPO_URL: origin }), 'cloned');
    assert.equal(readFileSync(join(root, 'src/pricing.ts'), 'utf8'), readFileSync(join(origin, 'src/pricing.ts'), 'utf8'));
    writeFileSync(join(root, 'src/local-note.ts'), 'export const note = 1;\n');
    assert.equal(prepareRepository(root, { HIVE_REPO_URL: origin }), 'existing');
    assert.ok(readFileSync(join(root, 'src/local-note.ts'), 'utf8'), 'existing checkout untouched');
    assert.throws(() => prepareRepository(join(tmp, 'other'), { HIVE_REPO_URL: join(tmp, 'missing') }), /git clone/);
    assert.equal(maskUrl('https://x-access-token:ghp_secret@github.com/a/b.git'), 'https://***@github.com/a/b.git');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
