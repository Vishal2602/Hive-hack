// The web app's API client and live feed (web/src/api) against a real daemon: Bearer auth,
// role-aware polling (viewer -> /api/view, member/admin -> /snapshot), incremental /events,
// 401 -> sign out, offline / stale / timeout handling. The web/src/api folder has no runtime
// imports outside itself, so Node runs it directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { ApiError, HiveClient, memoryTokenStore } from '../web/src/api/client.ts';
import { LiveFeed, connectionAt, mergeEvents } from '../web/src/api/live.ts';
import { displaySessionName, viewToSnapshot } from '../web/src/api/adapt.ts';

const ADMIN = 'web-live-test-admin-token-5c1d9e';

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
  delete env.PORT; delete env.MODEL_API_KEY;
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

async function stop(daemon: ChildProcess): Promise<void> {
  const exited = once(daemon, 'exit'); daemon.kill();
  if (daemon.exitCode === null) await exited;
}

test('live feed: role-aware polling, incremental events, token actions and 401 sign-out against a real daemon', { timeout: 60_000 }, async () => {
  const { base, daemon } = await startDaemon();
  const feeds: LiveFeed[] = [];
  try {
    const admin = new HiveClient({ baseUrl: base, tokens: memoryTokenStore(ADMIN) });
    const me = await admin.me();
    assert.equal(me.role, 'admin');
    assert.equal(me.member, 'operator');
    assert.equal(me.workspace.name, 'billing');
    assert.ok(me.workspace.root, 'admins see the root path');

    const member = await admin.tokenCreate({ label: 'Sanika laptop', member: 'Sanika', role: 'member' });
    const viewer = await admin.tokenCreate({ label: 'Judge read-only', member: 'Judge', role: 'viewer' });
    assert.match(member.token, /^hive_mem_[0-9A-Za-z]{32}$/);
    assert.equal('token' in member.record, false, 'the record never carries the value');

    // Sign-in checks the token with /me without storing a bad one.
    const memberClient = new HiveClient({ baseUrl: base, tokens: memoryTokenStore() });
    const memberFeed = new LiveFeed({ client: memberClient, intervalMs: 60_000 }); feeds.push(memberFeed);
    const refused = await memberFeed.signIn('hive_mem_wrongwrongwrongwrongwrongwrong12');
    assert.equal(refused.ok, false);
    assert.equal(memberClient.token, null);
    assert.equal(memberFeed.getState().status, 'signed-out');
    const signedIn = await memberFeed.signIn(member.token);
    assert.equal(signedIn.ok, true);
    assert.equal(memberClient.token, member.token);
    let state = memberFeed.getState();
    assert.equal(state.status, 'ready');
    assert.ok(state.snapshot, 'members poll /snapshot');
    assert.equal(state.view, null);
    assert.equal(typeof state.cacheAgeMs, 'number');
    assert.equal(connectionAt(state, Date.now()), 'online');
    assert.deepEqual(state.tokens, [], 'members get no token list');

    // Incremental events: a registration shows up exactly once on the next poll.
    const seqBefore = state.lastEventSeq;
    const session = await memberClient.register('pricing agent', 'claude-code');
    await memberFeed.refresh();
    state = memberFeed.getState();
    const registered = state.events.filter(e => e.type === 'session.registered');
    assert.equal(registered.length, 1);
    assert.ok(registered[0]!.seq > seqBefore);
    assert.deepEqual(state.events.map(e => e.seq), [...new Set(state.events.map(e => e.seq))].sort((a, b) => a - b), 'ascending, no duplicates');
    await memberFeed.refresh({ access: true });
    assert.equal(memberFeed.getState().events.filter(e => e.type === 'session.registered').length, 1, 'no repeats on later polls');
    // member_list (members see people with sessions; token metadata is admin-only).
    assert.deepEqual(memberFeed.getState().members.find(m => m.member === 'Sanika')?.sessions.map(s => s.agent), ['pricing agent']);
    const sessionRow = memberFeed.getState().snapshot!.sessions.find(s => s.id === session.id)!;
    assert.equal(sessionRow.member, 'Sanika');
    assert.equal(displaySessionName(sessionRow.name, sessionRow.member), 'Sanika · pricing agent');

    // Admin feed: token list, and refresh({ access: true }) sees a rename immediately.
    const adminFeed = new LiveFeed({ client: admin, intervalMs: 60_000 }); feeds.push(adminFeed);
    await adminFeed.resume();
    assert.equal(adminFeed.getState().tokens.length, 2);
    await admin.tokenRename(member.record.id, 'Sanika workstation');
    await adminFeed.refresh({ access: true });
    assert.equal(adminFeed.getState().tokens.find(t => t.id === member.record.id)?.label, 'Sanika workstation');

    // Viewer feed: /api/view only (a /snapshot read would be 403), scrubbed events, lifted into a snapshot shape.
    const viewerClient = new HiveClient({ baseUrl: base, tokens: memoryTokenStore() });
    const viewerFeed = new LiveFeed({ client: viewerClient, intervalMs: 60_000 }); feeds.push(viewerFeed);
    assert.equal((await viewerFeed.signIn(viewer.token)).ok, true);
    const viewState = viewerFeed.getState();
    assert.equal(viewState.snapshot, null);
    assert.ok(viewState.view, 'viewers poll /api/view');
    assert.ok(viewState.events.length > 0);
    assert.ok(viewState.events.every(e => !('payload' in e)), 'viewer events carry no payload');
    const lifted = viewToSnapshot(viewState.view!, viewState.events);
    assert.equal(lifted.sessions.find(s => s.id === session.id)?.name, 'Sanika · pricing agent');
    assert.equal(JSON.stringify(lifted).includes(me.workspace.root!), false, 'no absolute root in the viewer data');
    await assert.rejects(viewerClient.snapshot(), (error: unknown) => error instanceof ApiError && error.status === 403);
    await assert.rejects(viewerClient.memberList(), (error: unknown) => error instanceof ApiError && error.status === 403);
    assert.equal(viewerClient.token, viewer.token, 'a 403 does not sign out');

    // Revoking the viewer token: the next poll gets 401, the token is cleared and the feed signs out.
    let notified = 0;
    viewerClient.onUnauthorized(() => { notified++; });
    await admin.tokenRevoke(viewer.record.id);
    await viewerFeed.refresh();
    assert.equal(notified, 1);
    assert.equal(viewerClient.token, null);
    assert.equal(viewerFeed.getState().status, 'signed-out');
    assert.equal(viewerFeed.getState().signedOutReason, 'unauthorized');
    assert.equal(viewerFeed.getState().view, null, 'data is dropped on sign-out');

    // A daemon that goes away: the feed keeps its last data, reports offline, and the stale clock runs.
    await stop(daemon);
    await memberFeed.refresh();
    state = memberFeed.getState();
    assert.equal(state.unreachable, true);
    assert.equal(connectionAt(state, Date.now()), 'offline');
    assert.ok(state.snapshot, 'last data is kept while offline');
    assert.equal(state.status, 'ready');
  } finally {
    for (const feed of feeds) feed.dispose();
    if (daemon.exitCode === null) await stop(daemon);
  }
});

test('client: timeouts and unreachable servers are typed errors; stale after 10 s without a successful poll', { timeout: 15_000 }, async () => {
  const hanging = createHttpServer(() => { /* never answers */ });
  hanging.listen(0, '127.0.0.1'); await once(hanging, 'listening');
  const address = hanging.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  try {
    const slow = new HiveClient({ baseUrl: `http://127.0.0.1:${address.port}`, tokens: memoryTokenStore('t'), timeoutMs: 150 });
    await assert.rejects(slow.me(), (error: unknown) => error instanceof ApiError && error.kind === 'timeout' && error.unreachable);
    assert.equal(slow.token, 't', 'a timeout does not sign out');
  } finally {
    hanging.closeAllConnections(); hanging.close();
  }
  const closed = new HiveClient({ baseUrl: `http://127.0.0.1:${await unusedPort()}`, tokens: memoryTokenStore('t') });
  await assert.rejects(closed.me(), (error: unknown) => error instanceof ApiError && error.kind === 'network' && error.status === 0);

  // Stale is purely time since the last successful poll; offline wins while the last poll failed.
  assert.equal(connectionAt({ lastPollAt: null, unreachable: false }, 1_000), 'connecting');
  assert.equal(connectionAt({ lastPollAt: 0, unreachable: false }, 10_000), 'online');
  assert.equal(connectionAt({ lastPollAt: 0, unreachable: false }, 10_001), 'stale');
  assert.equal(connectionAt({ lastPollAt: 9_000, unreachable: true }, 10_000), 'offline');

  // mergeEvents only appends newer seqs and caps memory.
  const e = (seq: number) => ({ seq, at: seq, type: 't', detail: '' });
  assert.deepEqual(mergeEvents([e(1), e(2)], [e(2), e(4), e(3)]).map(x => x.seq), [1, 2, 3, 4]);
  assert.deepEqual(mergeEvents([e(1), e(2), e(3)], [e(4), e(5)], 3).map(x => x.seq), [3, 4, 5]);
});
