import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

async function unusedPort(): Promise<number> {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

const dashboardFile = fileURLToPath(new URL('../src/dashboard/index.html', import.meta.url));

test('dashboard source renders data as text, never through innerHTML, and embeds no token', () => {
  const html = readFileSync(dashboardFile, 'utf8');
  assert.equal(html.includes('innerHTML'), false, 'dashboard must not use innerHTML');
  assert.equal(html.includes('outerHTML'), false);
  assert.equal(html.includes('insertAdjacentHTML'), false);
  assert.equal(/document\.write/.test(html), false);
  assert.match(html, /sessionStorage/);
  assert.match(html, /Paste HIVE_TOKEN from \.env/);
  // The four outcome categories must be distinguishable in the UI.
  for (const label of ['potential overlap', 'incompatible assumption', 'agreement accepted', 'implementation verified']) assert.ok(html.includes(label), label);
  // A green verified badge requires a passing verification run.
  assert.match(html, /verification\.passed === true/);
});

test('daemon serves the dashboard without auth while data routes stay authenticated', { timeout: 20_000 }, async () => {
  const port = await unusedPort();
  const token = 'dashboard-test-token-7f3a91';
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  Object.assign(env, { HIVE_TOKEN: token, HIVE_PORT: String(port), HIVE_DB: ':memory:', HIVE_PROJECT_ROOT: fileURLToPath(new URL('../fixtures/billing', import.meta.url)) });
  const base = `http://127.0.0.1:${port}`;
  const daemon = spawn(process.execPath, [fileURLToPath(new URL('../src/server/daemon.ts', import.meta.url))], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    await new Promise<void>((resolve, reject) => {
      let log = '';
      daemon.stderr!.on('data', chunk => { log += String(chunk); if (log.includes('Hive daemon listening')) resolve(); });
      daemon.once('error', reject);
      daemon.once('exit', code => reject(new Error(`Daemon exited ${code}: ${log}`)));
    });
    for (const path of ['/ui', '/ui/', '/']) {
      const page = await fetch(`${base}${path}`);
      assert.equal(page.status, 200, path);
      assert.match(page.headers.get('content-type') ?? '', /^text\/html; charset=utf-8/);
      assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/);
      assert.match(page.headers.get('content-security-policy') ?? '', /connect-src 'self'/);
      const body = await page.text();
      assert.match(body, /<title>Hive dashboard<\/title>/);
      assert.equal(body.includes(token), false, 'served page must not contain the token');
    }
    // Only GET of the page is unauthenticated.
    assert.equal((await fetch(`${base}/ui`, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await fetch(`${base}/snapshot`)).status, 401);
    assert.equal((await fetch(`${base}/events?after=0`)).status, 401);
    assert.equal((await fetch(`${base}/snapshot`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await fetch(`${base}/command`, { method: 'POST', body: JSON.stringify({ action: 'sync' }) })).status, 401);
    const snapshot = await fetch(`${base}/snapshot`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(snapshot.status, 200);
    assert.match(snapshot.headers.get('content-type') ?? '', /application\/json/);
    const data = await snapshot.json() as Record<string, unknown>;
    for (const key of ['repository', 'sessions', 'intents', 'contracts', 'findings', 'events', 'proposals', 'analysis', 'model']) assert.ok(key in data, key);
    assert.deepEqual(data.sessions, []);
  } finally {
    const exited = once(daemon, 'exit'); daemon.kill();
    if (daemon.exitCode === null) await exited;
  }
});
