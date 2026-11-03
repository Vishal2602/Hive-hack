import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { callDaemon } from '../src/server/client.ts';
import { registerHiveTools, startHeartbeat, type ToolBackend } from '../src/server/tools.ts';

const ADMIN = 'test-admin-token-not-production';
const fixture = fileURLToPath(new URL('../fixtures/billing', import.meta.url));

async function unusedPort(): Promise<number> {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function startDaemon(): Promise<{ url: string; env: Record<string, string>; daemon: ChildProcess }> {
  const port = await unusedPort();
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  Object.assign(env, { HIVE_TOKEN: ADMIN, HIVE_PORT: String(port), HIVE_URL: `http://127.0.0.1:${port}`, HIVE_DB: ':memory:', HIVE_PROJECT_ROOT: fixture });
  delete env.PORT; delete env.HIVE_HOST;
  const daemon = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', fileURLToPath(new URL('../src/server/daemon.ts', import.meta.url))], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    let log = '';
    daemon.stderr!.on('data', chunk => { log += String(chunk); if (log.includes('Hive daemon listening')) resolve(); });
    daemon.once('error', reject);
    daemon.once('exit', code => reject(new Error(`Daemon exited ${code}: ${log}`)));
  });
  return { url: env.HIVE_URL!, env, daemon };
}

async function createToken(url: string, member: string, role: 'member' | 'viewer'): Promise<string> {
  const response = await fetch(`${url}/command`, { method: 'POST', headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'token_create', label: `${member} laptop`, member, role }) });
  assert.equal(response.status, 200);
  return ((await response.json()) as { token: string }).token;
}

function httpClient(url: string, token: string, name: string): { client: Client; transport: StreamableHTTPClientTransport } {
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  return { client: new Client({ name, version: '1.0.0' }), transport };
}

function payload(result: Awaited<ReturnType<Client['callTool']>>): any {
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
}

test('two HTTP MCP clients with member tokens coordinate over /mcp; viewers and other credentials are refused', { timeout: 60_000 }, async () => {
  const { url, env, daemon } = await startDaemon();
  const clients: Client[] = [];
  try {
    const tokenA = await createToken(url, 'Alice', 'member');
    const tokenB = await createToken(url, 'Bob', 'member');
    const viewer = await createToken(url, 'Judge', 'viewer');

    // Unauthenticated → 401; viewer → 403 (raw request and SDK client both refused).
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } };
    const post = (headers: Record<string, string>) => fetch(`${url}/mcp`, { method: 'POST', body: JSON.stringify(init),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers } });
    assert.equal((await post({})).status, 401);
    assert.equal((await post({ Authorization: 'Bearer hive_mem_not-a-real-token' })).status, 401);
    assert.equal((await post({ Authorization: `Bearer ${viewer}` })).status, 403);
    const refused = httpClient(url, viewer, 'judge');
    await assert.rejects(refused.client.connect(refused.transport), /403|Forbidden/);

    const a = httpClient(url, tokenA, 'agent-a'); clients.push(a.client); await a.client.connect(a.transport);
    const b = httpClient(url, tokenB, 'agent-b'); clients.push(b.client); await b.client.connect(b.transport);
    assert.ok(a.transport.sessionId && b.transport.sessionId && a.transport.sessionId !== b.transport.sessionId);

    // Tools are identical across transports: compare with a stdio adapter talking to the same daemon.
    const stdio = new Client({ name: 'stdio', version: '1.0.0' }); clients.push(stdio);
    await stdio.connect(new StdioClientTransport({ command: process.execPath,
      args: ['--disable-warning=ExperimentalWarning', fileURLToPath(new URL('../src/server/mcp.ts', import.meta.url))], env: { ...env, HIVE_TOKEN: tokenA } }));
    const httpTools = (await a.client.listTools()).tools;
    assert.equal(httpTools.length, 16);
    assert.deepEqual(httpTools, (await stdio.listTools()).tools);

    // Tool calls before hive_register are refused.
    const early = await a.client.callTool({ name: 'hive_context', arguments: {} });
    assert.equal(early.isError, true);
    assert.match(JSON.stringify(early.content), /hive_register/);

    const sessionA = payload(await a.client.callTool({ name: 'hive_register', arguments: { name: 'pricing agent' } }));
    const sessionB = payload(await b.client.callTool({ name: 'hive_register', arguments: { name: 'invoice agent' } }));
    assert.equal(sessionA.member, 'Alice');
    assert.equal(sessionB.member, 'Bob');
    assert.match(sessionA.client, /^mcp-http:agent-a/);
    const again = await a.client.callTool({ name: 'hive_register', arguments: { name: 'twice' } });
    assert.equal(again.isError, true, 'one MCP session binds exactly one Hive session');

    for (const [client, name] of [[a.client, 'A'], [b.client, 'B']] as const) {
      payload(await client.callTool({ name: 'hive_set_intent', arguments: {
        task: 'Pricing', files: [name === 'A' ? 'src/pricing.ts' : 'src/invoice.ts'],
        symbols: name === 'A' ? ['src/pricing.ts#getPrice:function'] : ['src/invoice.ts#invoiceTotal:function'],
        assumptions: [{ key: 'getPrice:unit', value: name === 'A' ? 'cents' : 'dollars' }] } }));
    }
    const context = JSON.stringify(payload(await b.client.callTool({ name: 'hive_context', arguments: {} })));
    assert.match(context, /assumption_mismatch/);
    assert.match(context, /cents/);

    const contract = payload(await a.client.callTool({ name: 'hive_propose_contract', arguments: {
      title: 'Explicit unit', declaration: "export declare function getPrice(unit: 'cents' | 'dollars'): number;",
      participants: [sessionB.id], producerSymbol: 'src/pricing.ts#getPrice:function' } }));
    assert.equal(contract.status, 'proposed');
    // Tools never take a sessionId argument: each call acts as the Hive session bound to that MCP session.
    const acked = payload(await b.client.callTool({ name: 'hive_acknowledge', arguments: { contractId: contract.id, version: 1 } }));
    assert.ok(acked.acknowledgements.includes(sessionB.id));
    let current = acked;
    if (current.status === 'proposed' && current.participants.includes(sessionA.id))
      current = payload(await a.client.callTool({ name: 'hive_acknowledge', arguments: { contractId: contract.id, version: 1 } }));
    assert.equal(current.status, 'accepted');

    // hive_verify over HTTP: argument failures, allowlist refusal, then a real run that it waits for (the fixture's
    // producer still returns dollars, so the run fails honestly; it is never reported as pending or passed).
    const neither = await b.client.callTool({ name: 'hive_verify', arguments: { contractId: contract.id } });
    assert.equal(neither.isError, true, 'command or runId is required');
    const disallowed = await b.client.callTool({ name: 'hive_verify', arguments: { contractId: contract.id, command: 'rm -rf src' } });
    assert.equal(disallowed.isError, true);
    assert.match(JSON.stringify(disallowed.content), /allowlist/);
    const run = payload(await b.client.callTool({ name: 'hive_verify', arguments: { contractId: contract.id, command: 'node --test tests/pricing.test.ts' } }));
    assert.equal(run.pending, false);
    assert.equal(run.contractId, contract.id);
    assert.notEqual(run.status, 'running');
    assert.notEqual(run.status, 'passed');
    const resumed = payload(await b.client.callTool({ name: 'hive_verify', arguments: { contractId: contract.id, runId: run.id } }));
    assert.equal(resumed.id, run.id);
    assert.equal(resumed.status, run.status);

    // verify_status over /command: a member may not poll through someone else's session.
    const foreign = await fetch(`${url}/command`, { method: 'POST', headers: { Authorization: `Bearer ${tokenB}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'verify_status', sessionId: sessionA.id, runId: run.id }) });
    assert.equal(foreign.status, 403);

    // An MCP session id is bound to the credential that created it.
    const hijack = await fetch(`${url}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${tokenB}`, 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream', 'mcp-session-id': a.transport.sessionId!, 'mcp-protocol-version': '2025-03-26' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'hive_finish', arguments: {} } }) });
    assert.equal(hijack.status, 403);
    const unknown = await fetch(`${url}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${tokenB}`, 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream', 'mcp-session-id': '00000000-0000-4000-8000-000000000000' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    assert.equal(unknown.status, 404);

    // DELETE /mcp ends the MCP session and finishes its Hive session.
    await a.transport.terminateSession();
    const snapshot = await (await fetch(`${url}/snapshot`, { headers: { Authorization: `Bearer ${ADMIN}` } })).json() as { sessions: Array<{ id: string }> };
    assert.ok(!snapshot.sessions.some(s => s.id === sessionA.id), 'A finished after DELETE /mcp');
    assert.ok(snapshot.sessions.some(s => s.id === sessionB.id), 'B is untouched');
  } finally {
    await Promise.all(clients.map(client => client.close().catch(() => {})));
    const exited = once(daemon, 'exit'); daemon.kill();
    if (daemon.exitCode === null) await exited;
  }
});

/** Fake daemon backend: verify starts a run that finishes after `finishAfterPolls` verify_status calls. */
function verifyHarness(finishAfterPolls: number, options: { failPolls?: number } = {}) {
  const contractId = '11111111-1111-4111-8111-111111111111';
  const runId = '22222222-2222-4222-8222-222222222222';
  const commands: Array<Record<string, unknown>> = [];
  let polls = 0;
  const backend: ToolBackend = {
    snapshot: async () => ({}),
    command: async command => {
      commands.push(command);
      if (command.action === 'register') return { id: '33333333-3333-4333-8333-333333333333' };
      if (command.action === 'verify') return { id: runId, contractId, status: 'running', exitCode: null };
      if (command.action === 'verify_status') {
        polls++;
        if (polls <= (options.failPolls ?? 0)) throw new Error('Hive daemon returned HTTP 503: {"error":"draining"}');
        return polls >= finishAfterPolls ? { id: runId, contractId, status: 'passed', exitCode: 0 } : { id: runId, contractId, status: 'running', exitCode: null };
      }
      throw new Error(`unexpected ${String(command.action)}`);
    },
  };
  return { backend, commands, contractId, runId };
}

async function toolClient(backend: ToolBackend, verifyWaitMs: number) {
  const server = new McpServer({ name: 'hive', version: 'test' });
  registerHiveTools(server, backend, { verifyWaitMs, verifyPollMs: 10 });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'unit', version: '1' });
  await client.connect(clientSide);
  payload(await client.callTool({ name: 'hive_register', arguments: { name: 'unit' } }));
  return client;
}

test('hive_verify waits for a running run and returns its final status', async () => {
  const { backend, commands, contractId } = verifyHarness(3, { failPolls: 1 });
  const client = await toolClient(backend, 5_000);
  const run = payload(await client.callTool({ name: 'hive_verify', arguments: { contractId, command: 'node --test tests/x.test.ts' } }));
  assert.equal(run.status, 'passed');
  assert.equal(run.pending, false);
  const polls = commands.filter(c => c.action === 'verify_status');
  assert.equal(polls.length, 3, 'a transient poll failure (503) is retried, not reported as the result');
  assert.ok(polls.every(c => c.sessionId === '33333333-3333-4333-8333-333333333333'), 'polls carry the session so its lease is extended');
  await client.close();
});

test('hive_verify reports a run that outlasts the wait as pending, not failed, and can resume by runId', async () => {
  const { backend, contractId, runId } = verifyHarness(Number.POSITIVE_INFINITY);
  const client = await toolClient(backend, 60);
  const run = payload(await client.callTool({ name: 'hive_verify', arguments: { contractId, command: 'node --test tests/x.test.ts' } }));
  assert.equal(run.status, 'running');
  assert.equal(run.pending, true);
  assert.equal(run.id, runId);
  assert.match(run.note, /not a failure/);
  const wrong = await client.callTool({ name: 'hive_verify', arguments: { contractId: '44444444-4444-4444-8444-444444444444', runId } });
  assert.equal(wrong.isError, true, 'a runId from another contract is refused');
  await client.close();
});

test('stdio heartbeat survives 503 draining responses for up to 3 retries, then drops the session', { timeout: 10_000 }, async () => {
  let failuresLeft = 0;
  let beats = 0;
  const stub = createHttpServer((request, response) => {
    beats++;
    request.resume();
    if (failuresLeft > 0) { failuresLeft--; response.writeHead(503, { 'Content-Type': 'application/json' }).end('{"error":"draining"}'); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"id":"s"}');
  });
  stub.listen(0, '127.0.0.1'); await once(stub, 'listening');
  const address = stub.address();
  if (!address || typeof address === 'string') throw new Error('No stub port');
  const previousUrl = process.env.HIVE_URL;
  process.env.HIVE_URL = `http://127.0.0.1:${address.port}`;
  const beat = () => callDaemon('/command', { action: 'heartbeat', sessionId: '33333333-3333-4333-8333-333333333333' });
  const until = async (condition: () => boolean) => { while (!condition()) await new Promise(resolve => setTimeout(resolve, 5)); };
  try {
    // Three consecutive 503s: the third retry succeeds, the session is kept and regular beats resume.
    failuresLeft = 3; beats = 0;
    let lost = false; const retries: number[] = [];
    const kept = startHeartbeat({ beat, intervalMs: 30, retryDelayMs: 20, onRetry: attempt => retries.push(attempt), onLost: () => { lost = true; } });
    await until(() => beats >= 6);
    kept.stop();
    assert.equal(lost, false);
    assert.deepEqual(retries, [1, 2, 3]);

    // Four consecutive 503s (initial beat + 3 retries): dropped exactly then, never before.
    failuresLeft = Number.POSITIVE_INFINITY; beats = 0;
    let lostAfter = -1; let lostError: unknown;
    const dropped = startHeartbeat({ beat, intervalMs: 30, retryDelayMs: 20, onLost: error => { lostAfter = beats; lostError = error; } });
    await until(() => lostAfter >= 0);
    await new Promise(resolve => setTimeout(resolve, 120));
    dropped.stop();
    assert.equal(lostAfter, 4);
    assert.equal(beats, 4, 'no beats after the session is dropped');
    assert.match(String(lostError), /503/);
  } finally {
    if (previousUrl === undefined) delete process.env.HIVE_URL; else process.env.HIVE_URL = previousUrl;
    await new Promise<void>(resolve => stub.close(() => resolve()));
  }
});
