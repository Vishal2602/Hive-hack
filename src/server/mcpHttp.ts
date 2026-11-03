import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Auth } from './auth.ts';
import { registerHiveTools, type HiveTools, type ToolBackend } from './tools.ts';

/**
 * MCP over Streamable HTTP at /mcp (stateful). The caller (daemon) authenticates the request first; viewers never
 * reach this handler. One MCP session = one Hive session: hive_register binds them, every request to the MCP
 * session heartbeats the bound Hive session, an open GET stream keeps it alive, and DELETE finishes it.
 * An MCP session can only be used with the credential that created it.
 */
export interface McpHttpOptions {
  version: string;
  /** Runs one /command body as `auth` (schema parse + command authorization + execute). */
  command: (auth: Auth, command: Record<string, unknown>) => Promise<unknown>;
  snapshot: (auth: Auth) => Promise<unknown>;
  /** Extends a Hive session lease; throws for an unknown/expired session. */
  heartbeat: (sessionId: string) => void;
  /** Finishes a Hive session on DELETE /mcp. */
  finish: (auth: Auth, sessionId: string) => Promise<unknown>;
  maxSessions?: number;
  idleMs?: number;
  streamHeartbeatMs?: number;
}

interface Entry { transport: StreamableHTTPServerTransport; server: McpServer; tools: HiveTools; auth: Auth; lastActive: number; openStreams: number }

const principal = (auth: Auth) => auth.tokenId ?? `operator:${auth.member}`;
function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
function jsonRpcError(response: ServerResponse, status: number, code: number, text: string): void {
  if (response.headersSent) return;
  response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code, message: text }, id: null }));
}
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function createMcpHttpHandler(options: McpHttpOptions) {
  const sessions = new Map<string, Entry>();
  const maxSessions = options.maxSessions ?? 100;
  const idleMs = options.idleMs ?? 30 * 60_000;

  /** Keeps the bound Hive session alive; a lost lease unbinds it so the agent can register again. */
  function keepAlive(entry: Entry): void {
    const hive = entry.tools.sessionId;
    if (!hive) return;
    try { options.heartbeat(hive); }
    catch (error) {
      console.error(`Hive /mcp: session ${hive} heartbeat failed (${errorText(error)}); unbound, the agent must call hive_register again`);
      entry.tools.drop();
    }
  }

  // Open GET streams keep their Hive session alive between requests; idle MCP sessions are closed.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const entry of sessions.values()) {
      if (entry.openStreams > 0) keepAlive(entry);
      else if (now - entry.lastActive > idleMs) void entry.transport.close().catch(error => console.error('Hive /mcp: closing idle session failed:', errorText(error)));
    }
  }, options.streamHeartbeatMs ?? 30_000);
  sweep.unref();

  async function create(request: IncomingMessage, response: ServerResponse, auth: Auth): Promise<void> {
    if (sessions.size >= maxSessions) { jsonRpcError(response, 503, -32000, 'Too many open MCP sessions'); return; }
    const server = new McpServer({ name: 'hive', version: options.version });
    const backend: ToolBackend = { command: command => options.command(auth, command), snapshot: () => options.snapshot(auth) };
    const tools = registerHiveTools(server, backend, {
      client: () => `mcp-http:${server.server.getClientVersion()?.name ?? 'unknown'}`.slice(0, 200),
    });
    let entry: Entry | undefined;
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      maxRequestBodySize: 1024 * 1024,
      onsessioninitialized: id => {
        entry = { transport, server, tools, auth, lastActive: Date.now(), openStreams: 0 };
        sessions.set(id, entry);
      },
      // DELETE /mcp: the client ended the MCP session, so its Hive session ends too.
      onsessionclosed: async () => {
        const hive = tools.sessionId;
        if (!hive) return;
        tools.drop();
        try { await options.finish(auth, hive); }
        catch (error) { console.error(`Hive /mcp: finishing session ${hive} failed: ${errorText(error)}`); }
      },
    });
    transport.onclose = () => { const id = transport.sessionId; if (id && sessions.get(id)?.transport === transport) sessions.delete(id); };
    transport.onerror = error => console.error('Hive /mcp transport error:', errorText(error));
    await server.connect(transport);
    await transport.handleRequest(request, response);
    // Not an initialize request (the transport answered 400): discard the unused server.
    if (!entry) await server.close().catch(() => {});
  }

  async function handle(request: IncomingMessage, response: ServerResponse, auth: Auth): Promise<void> {
    try {
      const id = header(request, 'mcp-session-id');
      if (!id) {
        if (request.method !== 'POST') { jsonRpcError(response, 400, -32000, 'Bad Request: No valid session ID provided'); return; }
        await create(request, response, auth); return;
      }
      const entry = sessions.get(id);
      if (!entry) { jsonRpcError(response, 404, -32001, 'Session not found'); return; }
      if (principal(entry.auth) !== principal(auth)) { jsonRpcError(response, 403, -32000, 'Forbidden: MCP session belongs to another credential'); return; }
      entry.lastActive = Date.now();
      if (request.method !== 'DELETE') keepAlive(entry);
      if (request.method === 'GET') {
        entry.openStreams++;
        response.once('close', () => { entry.openStreams--; entry.lastActive = Date.now(); });
      }
      await entry.transport.handleRequest(request, response);
    } catch (error) {
      console.error('Hive /mcp request failed:', errorText(error));
      jsonRpcError(response, 500, -32603, 'Internal server error');
    }
  }

  async function closeAll(): Promise<void> {
    clearInterval(sweep);
    await Promise.all([...sessions.values()].map(entry => entry.transport.close().catch(() => {})));
    sessions.clear();
  }

  return { handle, closeAll, get size() { return sessions.size; } };
}
