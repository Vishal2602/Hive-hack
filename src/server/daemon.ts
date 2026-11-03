import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { HiveService } from '../service.ts';
import { Store } from '../store/sqlite.ts';
import { commandSchema, type Command } from './schemas.ts';

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

export function execute(command: Command): unknown | Promise<unknown> {
  switch (command.action) {
    case 'register': return coordinator.register(command.name, { workspace: command.workspace, client: command.client });
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
    case 'claim': return service.claim(command.sessionId, command.rule);
    case 'analyze': return service.analyze(command.sessionId, { force: command.force });
    case 'sync': return service.sync();
    case 'hook_check': return service.hookCheck(command.file);
  }
}

const dashboardCsp = "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'";
const dashboardPaths = new Set(['/', '/ui', '/ui/']);

const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  // The dashboard page is static and secret-free; it reads the token from sessionStorage and
  // sends it on every data request. Only this GET is served without Authorization.
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  if (request.method === 'GET' && dashboardPaths.has(pathname)) {
    try {
      const html = readFileSync(new URL('../dashboard/index.html', import.meta.url));
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': dashboardCsp,
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }).end(html);
    } catch (error) {
      console.error('Dashboard unavailable:', error instanceof Error ? error.message : error);
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Dashboard unavailable');
    }
    return;
  }
  response.setHeader('Content-Type', 'application/json');
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401).end(JSON.stringify({ error: 'Unauthorized' })); return;
  }
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/snapshot') {
      response.end(JSON.stringify(service.snapshot())); return;
    }
    if (request.method === 'GET' && url.pathname === '/events') {
      response.end(JSON.stringify(coordinator.events(Number(url.searchParams.get('after') ?? 0)))); return;
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
    response.end(JSON.stringify(await execute(command)));
  } catch (error) {
    response.writeHead(400).end(JSON.stringify({ error: error instanceof Error ? error.message : 'Request failed' }));
  }
});
server.requestTimeout = 15_000;
const port = Number(process.env.HIVE_PORT ?? 4317);
server.listen(port, '127.0.0.1', () => {
  console.error(`Hive daemon listening on http://127.0.0.1:${port} root=${root} db=${dbPath} dashboard=http://127.0.0.1:${port}/ui`);
});
