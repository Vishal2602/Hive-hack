import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Builds the real Dockerfile and boots it on a throwaway volume. Skips (does not fail) when Docker
// is unavailable, or when HIVE_SKIP_CONTAINER_TEST=1 for a fast local loop.
const root = fileURLToPath(new URL('..', import.meta.url));

function docker(args: string[], timeoutMs = 60_000): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('docker', args, { cwd: root, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? String(result.error ?? '') };
}

function skipReason(): string | false {
  if (process.env.HIVE_SKIP_CONTAINER_TEST === '1') return 'HIVE_SKIP_CONTAINER_TEST=1: container test skipped';
  const info = docker(['info', '--format', '{{.ServerVersion}}'], 15_000);
  if (info.status !== 0) return 'Docker is not available ("docker info" failed): container build/run test skipped';
  return false;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor<T>(what: string, timeoutMs: number, probe: () => T | undefined | Promise<T | undefined>, diagnostics: () => string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await sleep(1_000);
  }
  throw new Error(`Timed out waiting for ${what}\n${diagnostics()}`);
}

test('container: image builds, entrypoint initialises /data/repo once, daemon serves /healthz, restart keeps edits',
  { skip: skipReason(), timeout: 25 * 60_000 }, async t => {
    const id = randomBytes(4).toString('hex');
    const tag = `hive-container-test:${id}`;
    const name = `hive-container-test-${id}`;
    const volume = `hive-container-test-${id}`;
    const token = `throwaway-container-test-${id}`;
    const logs = () => { const l = docker(['logs', '--tail', '60', name]); return `container logs:\n${l.stdout}${l.stderr}`; };
    const running = () => docker(['inspect', '-f', '{{.State.Running}}', name]).stdout.trim() === 'true';
    const exec = (...args: string[]) => docker(['exec', name, ...args]);
    try {
      // HIVE_CONTAINER_WEB_TYPECHECK=0 builds the web app with vite only (see the Dockerfile ARG).
      const buildArgs = process.env.HIVE_CONTAINER_WEB_TYPECHECK === '0' ? ['--build-arg', 'WEB_TYPECHECK=0'] : [];
      const build = docker(['build', ...buildArgs, '-t', tag, '.'], 20 * 60_000);
      assert.equal(build.status, 0, `docker build failed:\n${(build.stdout + build.stderr).slice(-4000)}`);

      // Missing HIVE_TOKEN must fail fast with a clear message instead of starting an open daemon.
      const noToken = docker(['run', '--rm', '-v', `${volume}:/data`, tag], 120_000);
      assert.notEqual(noToken.status, 0);
      assert.match(noToken.stderr, /HIVE_TOKEN is not set/);

      const run = docker(['run', '-d', '--name', name, '-e', `HIVE_TOKEN=${token}`, '-v', `${volume}:/data`, '-p', '127.0.0.1::4317', tag]);
      assert.equal(run.status, 0, `docker run failed: ${run.stderr}`);

      await waitFor('/data/repo initialisation', 240_000, () => {
        if (!running()) throw new Error(`container exited during start\n${logs()}`);
        const head = exec('git', '-C', '/data/repo', 'log', '--format=%s');
        return head.status === 0 && head.stdout.trim() === 'playground snapshot' ? true : undefined;
      }, logs);
      assert.equal(exec('test', '-x', '/data/repo/node_modules/.bin/tsc').status, 0, 'npm ci ran in /data/repo');
      assert.equal(exec('test', '-e', '/data/repo/.hive').status, 1, 'no stale .hive copied from the laptop snapshot');
      const status = exec('git', '-C', '/data/repo', 'status', '--porcelain');
      assert.equal(status.stdout.trim(), '', 'fresh checkout is clean (node_modules ignored)');
      const uid = exec('sh', '-c', "awk '/^Uid:/{print $2}' /proc/1/status");
      assert.notEqual(uid.stdout.trim(), '0', 'daemon (PID 1) does not run as root');

      const daemonSource = readFileSync(new URL('../src/server/daemon.ts', import.meta.url), 'utf8');
      const hostable = daemonSource.includes('/healthz') && daemonSource.includes('HIVE_HOST');
      await t.test('daemon answers /healthz through the published port', { skip: hostable ? false : 'daemon has no /healthz or HIVE_HOST yet (hostable daemon task)' }, async () => {
        const mapped = docker(['port', name, '4317/tcp']).stdout.trim().split('\n')[0] ?? '';
        const base = `http://${mapped.replace('0.0.0.0', '127.0.0.1')}`;
        await waitFor('/healthz 200', 120_000, async () => {
          try { const response = await fetch(`${base}/healthz`); return response.ok ? true : undefined; } catch { return undefined; }
        }, logs);
        const anonymous = await fetch(`${base}/snapshot`);
        assert.equal(anonymous.status, 401, 'data routes still require a token');
        await anonymous.body?.cancel();
      });

      // A restart must keep the checkout and the user's edits; the entrypoint never resets it.
      const before = exec('git', '-C', '/data/repo', 'rev-parse', 'HEAD').stdout.trim();
      assert.equal(exec('sh', '-c', 'echo "// edit kept across restart" >> /data/repo/src/tax.ts').status, 0);
      const restart = docker(['restart', '-t', '20', name], 90_000);
      assert.equal(restart.status, 0, restart.stderr);
      await waitFor('restart with existing repo', 60_000, () => logs().includes('left untouched') ? true : undefined, logs);
      assert.equal(exec('git', '-C', '/data/repo', 'rev-parse', 'HEAD').stdout.trim(), before);
      assert.match(exec('tail', '-n', '1', '/data/repo/src/tax.ts').stdout, /edit kept across restart/);
      assert.match(exec('git', '-C', '/data/repo', 'status', '--porcelain').stdout, /src\/tax\.ts/);
      assert.doesNotMatch(logs(), new RegExp(token), 'token never printed');
    } finally {
      docker(['rm', '-f', name]);
      docker(['volume', 'rm', '-f', volume]);
      docker(['rmi', '-f', tag]);
    }
  });
