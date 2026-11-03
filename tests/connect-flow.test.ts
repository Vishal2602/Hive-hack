// The Connect and sign-in screens' logic (web/src/screens/connect/logic.ts): config snippets built from the
// real endpoint, invite links, token paste clean-up, and "waiting for the first agent" progress, checked
// both as pure functions and against a real daemon (token_create, member refusal, tokenId on sessions).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { ApiError, HiveClient, memoryTokenStore } from '../web/src/api/client.ts';
import {
  REMOTE_SCOPE_NOTE, configSnippet, inviteLink, inviteProgress, mcpUrl, normalizePastedToken, shellQuote,
} from '../web/src/screens/connect/logic.ts';

const ADMIN = 'connect-flow-test-admin-token-81f3a2';
const TOKEN = 'hive_mem_AbC123xyz';

test('snippets use the real /mcp endpoint and the exact token for each client', () => {
  assert.equal(mcpUrl('https://hive.example.com/'), 'https://hive.example.com/mcp');
  assert.equal(configSnippet('claude-code', 'https://hive.example.com', TOKEN),
    `curl -fsSL 'https://hive.example.com/connect.mjs' -o hive-connect.mjs && node hive-connect.mjs '${TOKEN}' && rm hive-connect.mjs`);

  const muse = JSON.parse(configSnippet('muse-code', 'https://hive.example.com//', TOKEN)) as Record<string, unknown>;
  assert.deepEqual(muse, { mcp_servers: { hive: { transport: 'streamable_http', url: 'https://hive.example.com/mcp', headers: { Authorization: `Bearer ${TOKEN}` } } } });

  assert.equal(configSnippet('mcp', 'http://127.0.0.1:4318', TOKEN), `URL: http://127.0.0.1:4318/mcp\nAuthorization: Bearer ${TOKEN}`);
  assert.match(REMOTE_SCOPE_NOTE, /on your machine/);
  assert.match(REMOTE_SCOPE_NOTE, /never secrets/);
});

test('shell quoting keeps hostile values inert in the Claude Code command', () => {
  assert.equal(shellQuote(`a'b`), `'a'\\''b'`);
  const snippet = configSnippet('claude-code', `https://x.dev/$(rm -rf ~)`, `tok'; echo pwned`);
  assert.ok(snippet.includes(`'https://x.dev/$(rm -rf ~)/connect.mjs'`), 'command substitution stays inside single quotes');
  assert.ok(snippet.includes(`'tok'\\''; echo pwned'`), 'a quote in the token cannot end the argument');
});

test('invite links put the token after # under the app base path', () => {
  assert.equal(inviteLink('https://hive.example.com/', '/ui/', 'hive_mem_a+b'), 'https://hive.example.com/ui/join#token=hive_mem_a%2Bb');
  assert.equal(inviteLink('http://localhost:4318', '/', TOKEN), `http://localhost:4318/join#token=${TOKEN}`);
  const url = new URL(inviteLink('https://hive.example.com', '/ui/', TOKEN));
  assert.equal(url.pathname, '/ui/join');
  assert.equal(url.search, '', 'nothing secret in the query, which servers log');
  assert.equal(new URLSearchParams(url.hash.slice(1)).get('token'), TOKEN);
});

test('pasted tokens lose quotes, header names and Bearer prefixes, and nothing else', () => {
  assert.equal(normalizePastedToken(`  ${TOKEN}\n`), TOKEN);
  assert.equal(normalizePastedToken(`"${TOKEN}"`), TOKEN);
  assert.equal(normalizePastedToken(`Authorization: Bearer ${TOKEN}`), TOKEN);
  assert.equal(normalizePastedToken(`bearer ${TOKEN}`), TOKEN);
  assert.equal(normalizePastedToken('   '), '');
  assert.equal(normalizePastedToken('hive_mem_Bearer'), 'hive_mem_Bearer', 'only a leading prefix is removed');
});

test('invite progress: only new sessions with the followed token count; revocation and first use are reported', () => {
  const sessions = [
    { id: 's-old', tokenId: 'tok-1' },
    { id: 's-other', tokenId: 'tok-2' },
    { id: 's-op', tokenId: null },
  ];
  const own = inviteProgress({ tokenId: 'tok-1', baselineSessionIds: ['s-old'], sessions, record: null, newToken: false });
  assert.deepEqual(own, { sessionIds: [], clientSeenAt: null, registered: false, revoked: false }, 'a session that existed before waiting does not tick');

  const later = inviteProgress({ tokenId: 'tok-1', baselineSessionIds: ['s-old'], sessions: [...sessions, { id: 's-new', tokenId: 'tok-1' }], record: null, newToken: false });
  assert.deepEqual(later.sessionIds, ['s-new']);
  assert.equal(later.registered, true);

  const fresh = inviteProgress({ tokenId: 'tok-3', baselineSessionIds: [], sessions, record: { id: 'tok-3', lastUsedAt: 1234, revokedAt: null }, newToken: true });
  assert.equal(fresh.registered, false);
  assert.equal(fresh.clientSeenAt, 1234, 'first use of a new token');
  assert.equal(inviteProgress({ tokenId: 'tok-1', baselineSessionIds: [], sessions, record: { id: 'tok-1', lastUsedAt: 99, revokedAt: null }, newToken: false }).clientSeenAt,
    null, 'an own token is used by the dashboard itself, so its last use proves nothing');

  const revoked = inviteProgress({ tokenId: 'tok-3', baselineSessionIds: [], sessions, record: { id: 'tok-3', lastUsedAt: null, revokedAt: 5 }, newToken: true });
  assert.equal(revoked.revoked, true);
  assert.equal(inviteProgress({ tokenId: null, baselineSessionIds: [], sessions, record: null, newToken: false }).registered, false,
    'the operator token (no token id) never matches operator sessions');
});

async function unusedPort(): Promise<number> {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function startDaemon(): Promise<{ base: string; daemon: ChildProcess }> {
  const port = await unusedPort();
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  delete env.PORT; delete env.MODEL_API_KEY; delete env.HIVE_PUBLIC_URL;
  Object.assign(env, { HIVE_TOKEN: ADMIN, HIVE_PORT: String(port), HIVE_DB: ':memory:', HIVE_PROJECT_ROOT: fileURLToPath(new URL('../fixtures/billing', import.meta.url)) });
  const daemon = spawn(process.execPath, [fileURLToPath(new URL('../src/server/daemon.ts', import.meta.url))], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    let log = '';
    daemon.stderr!.on('data', chunk => { log += String(chunk); if (log.includes('Hive daemon listening')) resolve(); });
    daemon.once('error', reject);
    daemon.once('exit', code => reject(new Error(`Daemon exited ${code}: ${log}`)));
  });
  return { base: `http://127.0.0.1:${port}`, daemon };
}

test('connect flow against a real daemon: admin creates a token, members are refused, the new agent is found by tokenId', { timeout: 60_000 }, async () => {
  const { base, daemon } = await startDaemon();
  try {
    const admin = new HiveClient({ baseUrl: base, tokens: memoryTokenStore(ADMIN) });
    const me = await admin.me();
    assert.equal(me.publicUrl, null, 'without HIVE_PUBLIC_URL the screen falls back to the page origin');

    // Step 2 (admin): token_create returns the value once.
    const created = await admin.tokenCreate({ label: 'Priya · Claude Code', member: 'Priya', role: 'member' });
    assert.match(created.token, /^hive_mem_/);
    let record = (await admin.tokenList()).find(t => t.id === created.record.id)!;
    assert.equal(record.lastUsedAt, null, 'unused until the client presents it');
    assert.equal(inviteProgress({ tokenId: record.id, baselineSessionIds: [], sessions: (await admin.snapshot()).sessions, record, newToken: true }).registered, false);

    // Step 2 (member): the daemon refuses token_create, which is what the screen explains.
    const member = new HiveClient({ baseUrl: base, tokens: memoryTokenStore(created.token) });
    await assert.rejects(member.tokenCreate({ label: 'Second', member: 'Priya', role: 'member' }),
      (error: unknown) => error instanceof ApiError && error.status === 403 && /admin/i.test(error.message));
    assert.equal(member.token, created.token, 'a 403 does not sign the member out');

    // Step 3: the agent registers with the new token; the admin snapshot carries its tokenId.
    const session = await member.register('pricing agent', 'claude-code');
    record = (await admin.tokenList()).find(t => t.id === created.record.id)!;
    assert.ok(record.lastUsedAt !== null, 'first use recorded');
    const snapshot = await admin.snapshot({ fresh: true });
    const progress = inviteProgress({ tokenId: record.id, baselineSessionIds: [], sessions: snapshot.sessions, record, newToken: true });
    assert.deepEqual(progress.sessionIds, [session.id]);
    assert.equal(progress.registered, true);
    assert.ok(progress.clientSeenAt !== null);

    // Revoking the token is reported, and the old secret no longer signs in (sign-in shows the 401 message).
    await admin.tokenRevoke(record.id);
    record = (await admin.tokenList()).find(t => t.id === created.record.id)!;
    assert.equal(inviteProgress({ tokenId: record.id, baselineSessionIds: [], sessions: snapshot.sessions, record, newToken: true }).revoked, true);
    const signIn = new HiveClient({ baseUrl: base, tokens: memoryTokenStore(null) });
    await assert.rejects(signIn.me({ token: created.token }), (error: unknown) => error instanceof ApiError && error.status === 401);
    await assert.rejects(signIn.me({ token: normalizePastedToken('Bearer not-a-real-token') }), (error: unknown) => error instanceof ApiError && error.status === 401);
  } finally {
    const exited = once(daemon, 'exit'); daemon.kill();
    if (daemon.exitCode === null) await exited;
  }
});
