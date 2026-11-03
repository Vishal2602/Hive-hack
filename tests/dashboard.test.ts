// The daemon serves the built React app (web/dist, base /ui/) at /ui with an SPA fallback.
// Replaces the old single-file src/dashboard/index.html checks (that page was removed in F0).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inlineScriptHashes, uiCsp } from '../src/server/static.ts';

async function unusedPort(): Promise<number> {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

const TOKEN = 'dashboard-test-token-7f3a91';
const INLINE = "document.documentElement.setAttribute('data-theme', 'light');";

/** A fake web build: index.html with one inline script, a fingerprinted asset, a favicon, and a file outside it. */
function fakeDist(): { root: string; dist: string } {
  const root = mkdtempSync(join(tmpdir(), 'hive-ui-'));
  const dist = join(root, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), `<!doctype html><html><head><title>Hive</title><script>${INLINE}</script>`
    + '<script type="module" crossorigin src="/ui/assets/index-abc123.js"></script></head><body><div id="root"></div></body></html>');
  writeFileSync(join(dist, 'assets', 'index-abc123.js'), 'console.log("app");');
  writeFileSync(join(dist, 'assets', 'index-abc123.css'), 'body{}');
  writeFileSync(join(dist, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(root, 'secret.txt'), 'outside the build');
  symlinkSync(join(root, 'secret.txt'), join(dist, 'assets', 'leak.js'));
  return { root, dist };
}

async function startDaemon(extra: Record<string, string>): Promise<{ base: string; daemon: ChildProcess; port: number }> {
  const port = await unusedPort();
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  delete env.PORT;
  Object.assign(env, { HIVE_TOKEN: TOKEN, HIVE_PORT: String(port), HIVE_DB: ':memory:', HIVE_PROJECT_ROOT: fileURLToPath(new URL('../fixtures/billing', import.meta.url)) }, extra);
  const daemon = spawn(process.execPath, [fileURLToPath(new URL('../src/server/daemon.ts', import.meta.url))], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    let log = '';
    daemon.stderr!.on('data', chunk => { log += String(chunk); if (log.includes('Hive daemon listening')) resolve(); });
    daemon.once('error', reject);
    daemon.once('exit', code => reject(new Error(`Daemon exited ${code}: ${log}`)));
  });
  return { base: `http://127.0.0.1:${port}`, daemon, port };
}

async function stop(daemon: ChildProcess): Promise<void> {
  const exited = once(daemon, 'exit'); daemon.kill();
  if (daemon.exitCode === null) await exited;
}

/** Raw GET without client-side path normalisation (fetch would collapse "..").  */
function rawGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, res => {
      let body = ''; res.on('data', chunk => { body += String(chunk); }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject); req.end();
  });
}

test('CSP hashes inline scripts only and keeps connections same-origin', () => {
  const html = `<script>${INLINE}</script><script type="module" src="/ui/assets/a.js"></script>`;
  const expected = `'sha256-${createHash('sha256').update(INLINE).digest('base64')}'`;
  assert.deepEqual(inlineScriptHashes(html), [expected]);
  const csp = uiCsp(html);
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /connect-src 'self'/);
  assert.ok(csp.includes(`script-src 'self' ${expected}`), csp);
  assert.equal(csp.includes("'unsafe-inline'; script") || /script-src[^;]*unsafe-inline/.test(csp), false, 'no unsafe-inline scripts');
  assert.match(csp, /frame-ancestors 'none'/);
});

test('daemon serves the built app at /ui with SPA fallback, cache headers and CSP; data routes stay authenticated', { timeout: 30_000 }, async () => {
  const { root, dist } = fakeDist();
  const { base, daemon, port } = await startDaemon({ HIVE_WEB_DIST: dist });
  try {
    // index.html for the app root and for client-side routes (deep links), never cached long.
    for (const path of ['/ui', '/ui/', '/ui/agreements/0b6f4a52-1d3e', '/ui/members', '/ui/join']) {
      const page = await fetch(`${base}${path}`);
      assert.equal(page.status, 200, path);
      assert.match(page.headers.get('content-type') ?? '', /^text\/html; charset=utf-8/, path);
      assert.equal(page.headers.get('cache-control'), 'no-cache', path);
      const csp = page.headers.get('content-security-policy') ?? '';
      assert.match(csp, /default-src 'self'/);
      assert.match(csp, /connect-src 'self'/);
      assert.ok(csp.includes(inlineScriptHashes(readFileSync(join(dist, 'index.html'), 'utf8'))[0]!), 'inline script allowed by hash');
      assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
      const body = await page.text();
      assert.match(body, /<div id="root"><\/div>/);
      assert.equal(body.includes(TOKEN), false, 'served page must not contain the token');
    }
    // Fingerprinted assets: right type, immutable for a year. Other files revalidate.
    const js = await fetch(`${base}/ui/assets/index-abc123.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type') ?? '', /^text\/javascript/);
    assert.equal(js.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.match((await fetch(`${base}/ui/assets/index-abc123.css`)).headers.get('content-type') ?? '', /^text\/css/);
    const icon = await fetch(`${base}/ui/favicon.svg`);
    assert.equal(icon.headers.get('content-type'), 'image/svg+xml');
    assert.equal(icon.headers.get('cache-control'), 'no-cache');
    // A missing asset is a 404, not the HTML shell (a stale bundle URL must fail loudly).
    assert.equal((await fetch(`${base}/ui/assets/index-old999.js`)).status, 404);
    // Traversal and symlinks out of the build are refused.
    // (%2e%2e segments are normalised by URL parsing to a path outside /ui, which then needs auth: 401.)
    for (const path of ['/ui/..%2fsecret.txt', '/ui/assets/%2e%2e/%2e%2e/secret.txt', '/ui/assets/..%5c..%5csecret.txt']) {
      const res = await rawGet(port, path);
      assert.ok(res.status === 404 || res.status === 401, `${path} -> ${res.status}`);
      assert.equal(res.body.includes('outside the build'), false, path);
    }
    const leak = await fetch(`${base}/ui/assets/leak.js`);
    assert.equal(leak.status, 404);
    assert.equal((await leak.text()).includes('outside the build'), false);
    // HEAD works without a body.
    const head = await fetch(`${base}/ui/`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal((await head.text()), '');
    // / and /join redirect into the app (the #token fragment of invite links survives a redirect).
    const rootRedirect = await fetch(`${base}/`, { redirect: 'manual' });
    assert.equal(rootRedirect.status, 302);
    assert.equal(rootRedirect.headers.get('location'), '/ui/');
    const joinRedirect = await fetch(`${base}/join`, { redirect: 'manual' });
    assert.equal(joinRedirect.status, 302);
    assert.equal(joinRedirect.headers.get('location'), '/ui/join');
    // Only GET/HEAD of the app is unauthenticated.
    assert.equal((await fetch(`${base}/ui`, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await fetch(`${base}/snapshot`)).status, 401);
    assert.equal((await fetch(`${base}/events?after=0`)).status, 401);
    assert.equal((await fetch(`${base}/me`)).status, 401);
    assert.equal((await fetch(`${base}/snapshot`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await fetch(`${base}/command`, { method: 'POST', body: JSON.stringify({ action: 'sync' }) })).status, 401);
    const snapshot = await fetch(`${base}/snapshot`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(snapshot.status, 200);
    assert.match(snapshot.headers.get('content-type') ?? '', /application\/json/);
    assert.equal(snapshot.headers.get('cache-control'), 'no-store');
    const data = await snapshot.json() as Record<string, unknown>;
    for (const key of ['repository', 'sessions', 'intents', 'contracts', 'findings', 'events', 'proposals', 'analysis', 'model', 'cacheAgeMs']) assert.ok(key in data, key);
    assert.deepEqual(data.sessions, []);
    // /healthz is still answered first and unauthenticated.
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  } finally {
    await stop(daemon);
    rmSync(root, { recursive: true, force: true });
  }
});

test('without a web build, /ui answers 503 with the build command while the API keeps working', { timeout: 20_000 }, async () => {
  const empty = mkdtempSync(join(tmpdir(), 'hive-ui-missing-'));
  const { base, daemon } = await startDaemon({ HIVE_WEB_DIST: join(empty, 'dist') });
  try {
    const page = await fetch(`${base}/ui/agreements`);
    assert.equal(page.status, 503);
    assert.match(page.headers.get('content-type') ?? '', /^text\/html/);
    const body = await page.text();
    assert.match(body, /npm run build:web/);
    assert.equal(body.includes(TOKEN), false);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/me`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 200);
  } finally {
    await stop(daemon);
    rmSync(empty, { recursive: true, force: true });
  }
});

const builtDist = fileURLToPath(new URL('../web/dist/', import.meta.url));
test('the real web build (when present) is based at /ui/ and embeds no token or operator secret', { skip: !existsSync(join(builtDist, 'index.html')) && 'web/dist not built (npm run build:web)' }, () => {
  const html = readFileSync(join(builtDist, 'index.html'), 'utf8');
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) assert.match(match[1]!, /^\/ui\//, `asset ${match[1]} must be under /ui/`);
  const bundle = readdirSync(join(builtDist, 'assets')).filter(f => f.endsWith('.js')).map(f => readFileSync(join(builtDist, 'assets', f), 'utf8')).join('\n');
  // The only token-shaped string allowed is the prototype's labelled fake (web/src/mock, ?mock=1 only).
  const tokenShaped = [...bundle.matchAll(/hive_(?:adm|mem|view)_[0-9A-Za-z]{32}/g)].map(m => m[0]).filter(t => !t.startsWith('hive_adm_4Wq8demo'));
  assert.deepEqual(tokenShaped, [], 'no real-format token in the bundle');
  assert.equal(bundle.includes('MODEL_API_KEY'), false);
  assert.equal(bundle.includes('HIVE_TOKEN='), false);
  // The client keeps the token in sessionStorage under hive.token, sent as a Bearer header.
  assert.ok(bundle.includes('hive.token'));
  assert.ok(bundle.includes('Bearer '));
});
