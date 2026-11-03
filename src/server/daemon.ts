import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HiveService, sanitizeEvents } from '../service.ts';
import { Store } from '../store/sqlite.ts';
import { AuthError, OPERATOR_MEMBER, authorizeCommand, authorizeRoute, resolveAuth, type Auth } from './auth.ts';
import { createMcpHttpHandler } from './mcpHttp.ts';
import { commandSchema, type Command } from './schemas.ts';
import { createUiHandler } from './static.ts';
import { TokenService } from './tokens.ts';

const token = process.env.HIVE_TOKEN;
if (!token || token === 'replace-with-a-local-random-token') throw new Error('Set a non-default HIVE_TOKEN in .env');
const root = resolve(process.env.HIVE_PROJECT_ROOT ?? process.cwd());
const dataDir = resolve(process.env.HIVE_DATA_DIR ?? `${root}/.hive`);
const dbPath = process.env.HIVE_DB === ':memory:' ? ':memory:' : `${dataDir}/hive.db`;
const store = new Store(dbPath);
const service = new HiveService({ store, root, tsconfig: process.env.HIVE_TSCONFIG,
  verifyAllow: process.env.HIVE_VERIFY_ALLOW ? process.env.HIVE_VERIFY_ALLOW.split(',').map(s => s.trim()).filter(Boolean) : undefined,
  requireAgreementForDependents: process.env.HIVE_REQUIRE_AGREEMENT === '1' });
const coordinator = service.coordinator;
const adminToken: string = token;
const tokens = new TokenService(store);
const publicUrl = process.env.HIVE_PUBLIC_URL?.trim() || null;
const hiveVersion = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? 'unknown';
const OPERATOR_AUTH: Auth = { role: 'admin', member: OPERATOR_MEMBER, tokenId: null };

/** GET /me: who the caller is and what this service is. The root path is only shown to admins. */
function me(auth: Auth): unknown {
  const analyzer = service.analyzer as { configured?: boolean; model?: string };
  return { role: auth.role, member: auth.member, tokenId: auth.tokenId,
    workspace: { id: coordinator.workspaceId, name: basename(coordinator.root), ...(auth.role === 'admin' ? { root: coordinator.root } : {}) },
    publicUrl, model: { configured: analyzer.configured ?? true, model: analyzer.model ?? 'custom' }, version: hiveVersion };
}

/**
 * Runs one command through the service's command wrapper: counted as in flight (shutdown drains it)
 * and, on success, marks the cached snapshot dirty so the next read reflects the change.
 */
export function execute(command: Command, auth: Auth = OPERATOR_AUTH): Promise<unknown> {
  return service.track(() => dispatch(command, auth));
}

function dispatch(command: Command, auth: Auth): unknown | Promise<unknown> {
  switch (command.action) {
    case 'register': return coordinator.register(command.name, { workspace: command.workspace, client: command.client, tokenId: auth.tokenId, member: auth.member });
    case 'heartbeat': return coordinator.heartbeat(command.sessionId);
    case 'finish': coordinator.finish(command.sessionId); return { finished: true };
    case 'intent': return coordinator.setIntent(command.sessionId, command.intent);
    case 'propose': return service.propose(command.sessionId, command);
    case 'acknowledge': return coordinator.acknowledge(command.sessionId, command.contractId, command.version);
    case 'revise': return service.revise(command.sessionId, command.contractId, command);
    case 'reject': return coordinator.reject(command.sessionId, command.contractId, command.reason);
    case 'reindex': { const session = coordinator.heartbeat(command.sessionId); return service.reindex(session.workspaceId, `requested by ${session.name}`); }
    case 'symbol': { const session = coordinator.heartbeat(command.sessionId); return service.symbolReport(command.reference, session.workspaceId); }
    case 'preview': return service.preview(command.sessionId, command.operation);
    case 'apply': return service.apply(command.sessionId, command.proposalId);
    case 'contract_check': return service.contractCheck(command.sessionId, command.contractId);
    case 'verify': return service.verify(command.sessionId, command.contractId, command.command);
    case 'verify_status': { if (command.sessionId) coordinator.heartbeat(command.sessionId); return service.verifyStatus(command.runId); }
    case 'claim': return service.claim(command.sessionId, command.rule);
    case 'analyze': return service.analyze(command.sessionId, { force: command.force });
    case 'sync': return service.sync();
    case 'hook_check': return service.hookCheck(command.file);
    case 'member_list': return service.members(auth.role === 'admin' ? tokens.list() : []);
    case 'token_create': return tokens.create({ label: command.label, member: command.member, role: command.role, createdBy: auth.tokenId ?? auth.member });
    case 'token_list': return tokens.list();
    case 'token_rename': return tokens.rename(command.tokenId, command.label);
    case 'token_revoke': return tokens.revoke(command.tokenId);
  }
}

// MCP over Streamable HTTP (/mcp): same tools as the stdio adapter, run in process with the caller's auth.
const mcpHttp = createMcpHttpHandler({
  version: hiveVersion,
  command: async (auth, body) => {
    const command = commandSchema.parse(body);
    authorizeCommand(auth, command, id => coordinator.session(id));
    return execute(command, auth);
  },
  snapshot: async () => service.snapshotCached(),
  heartbeat: sessionId => { coordinator.heartbeat(sessionId); },
  finish: (auth, sessionId) => execute({ action: 'finish', sessionId }, auth),
});

// The React app (web/dist, built with base '/ui/'). HIVE_WEB_DIST overrides the folder (tests, custom builds).
const ui = createUiHandler(process.env.HIVE_WEB_DIST?.trim() || fileURLToPath(new URL('../../web/dist/', import.meta.url)));

const startedAt = Date.now();
let draining = false;
const EVENTS_DEFAULT_LIMIT = 200;
const EVENTS_MAX_LIMIT = 1000;

/** Non-negative integer query parameter, or the fallback when absent; throws on garbage. */
function intParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer`);
  return Number(raw);
}

const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  const requestPath = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  // Unauthenticated liveness for the platform healthcheck: DB reads only, never sync or a compiler project.
  if (request.method === 'GET' && requestPath === '/healthz') {
    let body: Record<string, unknown>;
    try {
      body = { ok: !draining, ...(draining ? { draining: true } : {}), ...service.health(), uptimeMs: Date.now() - startedAt, version: hiveVersion };
      body.recovered = body.recoveredJournals;
    } catch (error) {
      body = { ok: false, error: error instanceof Error ? error.message : 'health check failed' };
    }
    response.writeHead(body.ok ? 200 : 503, { 'Content-Type': 'application/json' }).end(JSON.stringify(body)); return;
  }
  if (draining && request.method === 'POST') {
    response.writeHead(503, { 'Content-Type': 'application/json', Connection: 'close' }).end(JSON.stringify({ error: 'draining' })); return;
  }
  // The dashboard (GET/HEAD /ui/*, plus redirects from / and /join) is static and secret-free; it reads
  // the token from sessionStorage and sends it on every data request. Only these GETs skip Authorization.
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  if (ui.handle(request, response, pathname)) return;
  response.setHeader('Content-Type', 'application/json');
  // Every other route: HIVE_TOKEN (admin) or an active member/viewer token; viewers only reach viewer-safe GETs.
  let auth: Auth;
  try {
    auth = resolveAuth(request.headers.authorization, { adminToken, tokens });
    authorizeRoute(auth, request.method ?? 'GET', pathname);
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 401;
    response.writeHead(status).end(JSON.stringify({ error: status === 401 ? 'Unauthorized' : (error as Error).message })); return;
  }
  if (pathname === '/mcp') {
    // Member/admin only (viewers were refused above). The transport parses its own body and sets its own headers.
    response.removeHeader('Content-Type');
    await mcpHttp.handle(request, response, auth); return;
  }
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/me') {
      response.end(JSON.stringify(me(auth))); return;
    }
    // Both read the cached snapshot; ?fresh=1 forces a sync for members/admins (ignored for viewers).
    const fresh = url.searchParams.get('fresh') === '1' && auth.role !== 'viewer';
    if (request.method === 'GET' && url.pathname === '/api/view') {
      response.end(JSON.stringify(service.viewCached({ fresh }))); return;
    }
    if (request.method === 'GET' && url.pathname === '/snapshot') {
      response.end(JSON.stringify(service.snapshotCached({ fresh }))); return;
    }
    if (request.method === 'GET' && url.pathname === '/events') {
      // Ascending seq > after, at most `limit`; page with after = last seq returned.
      const after = intParam(url, 'after', 0);
      const limit = Math.min(Math.max(intParam(url, 'limit', EVENTS_DEFAULT_LIMIT), 1), EVENTS_MAX_LIMIT);
      const events = coordinator.events(after, limit);
      // Viewers get type + scrubbed detail only: no payloads, no absolute paths.
      response.end(JSON.stringify(auth.role === 'viewer' ? sanitizeEvents(events, coordinator.workspaces().map(w => w.realRoot).concat(coordinator.root)) : events)); return;
    }
    if (request.method !== 'POST' || url.pathname !== '/command') {
      response.writeHead(404).end(JSON.stringify({ error: 'Not found' })); return;
    }
    let body = '';
    for await (const chunk of request) {
      body += String(chunk);
      if (Buffer.byteLength(body) > 65536) throw new Error('Request too large');
    }
    const command = commandSchema.parse(JSON.parse(body));
    authorizeCommand(auth, command, id => coordinator.session(id));
    response.end(JSON.stringify(await execute(command, auth)));
  } catch (error) {
    response.writeHead(error instanceof AuthError ? error.status : 400).end(JSON.stringify({ error: error instanceof Error ? error.message : 'Request failed' }));
  }
});
server.requestTimeout = 15_000;

// ---- listen: PORT (Railway) first, then HIVE_PORT, then 4317; HIVE_HOST defaults to loopback ----
const host = process.env.HIVE_HOST?.trim() || '127.0.0.1';
const portSource = process.env.PORT?.trim() || process.env.HIVE_PORT?.trim() || '4317';
if (!/^\d+$/.test(portSource) || Number(portSource) > 65535) throw new Error(`Invalid port "${portSource}" (PORT / HIVE_PORT)`);
const isLoopback = (value: string) => value === 'localhost' || value === '::1' || /^127\./.test(value);
if (!isLoopback(host)) console.error(`Hive: WARNING listening on non-loopback host ${host}; every route except /healthz and the static UI requires a Bearer token. Use TLS in front of it.`);
let stopSnapshotTimer: () => void = () => {};
server.on('error', error => { console.error('Hive daemon failed to listen:', error.message); process.exit(1); });
server.listen(Number(portSource), host, () => {
  const address = server.address();
  const port = address && typeof address !== 'string' ? address.port : Number(portSource);
  const shown = host.includes(':') ? `[${host}]` : host;
  console.error(`Hive daemon listening on http://${shown}:${port} root=${root} db=${dbPath} dashboard=http://${shown}:${port}/ui`);
  // HIVE_SNAPSHOT_REFRESH_MS (default 5000) only exists so tests can make the drift timer fast or slow.
  const refreshMs = Number(process.env.HIVE_SNAPSHOT_REFRESH_MS ?? 5_000);
  stopSnapshotTimer = service.startSnapshotTimer(Number.isFinite(refreshMs) && refreshMs >= 50 ? refreshMs : 5_000);
  // Warm the cache (first index) after the ready line so /healthz answers while it runs.
  setImmediate(() => {
    try { service.snapshotCached(); } catch (error) { console.error('Hive: initial snapshot failed:', error instanceof Error ? error.message : error); }
  });
});

// ---- graceful shutdown: refuse new writes, drain in-flight apply/verify (max 10 s), close SQLite, exit 0 ----
const DRAIN_TIMEOUT_MS = 10_000;
async function shutdown(signal: string): Promise<void> {
  if (draining) { console.error(`Hive: ${signal} received while draining; still waiting`); return; }
  draining = true;
  stopSnapshotTimer();
  const inFlight = () => service.inFlightCommands + service.inFlightVerifications;
  console.error(`Hive: ${signal} received; draining (${inFlight()} in flight)`);
  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
  while (inFlight() > 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  if (inFlight() > 0) console.error(`Hive: drain timed out after ${DRAIN_TIMEOUT_MS} ms with ${inFlight()} still in flight`);
  await mcpHttp.closeAll();
  server.close();
  server.closeAllConnections();
  try { store.close(); } catch (error) { console.error('Hive: closing the store failed:', error instanceof Error ? error.message : error); }
  console.error('Hive daemon stopped');
  process.exit(0);
}
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
