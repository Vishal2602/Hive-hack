import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { callDaemon } from './client.ts';
import { registerHiveTools, startHeartbeat } from './tools.ts';

// stdio adapter: one per agent session; forwards every tool to the daemon over HTTP (HIVE_URL, HIVE_TOKEN).
// Tool definitions are shared with the daemon's /mcp endpoint (src/server/tools.ts). Log to stderr only.
const server = new McpServer({ name: 'hive', version: '0.2.0' });
const client = process.env.MUSE_SESSION_ID ? 'muse-code' : process.env.CLAUDE_CODE_ENTRYPOINT ? 'claude-code' : undefined;
let heartbeat: { stop(): void } | undefined;
const tools = registerHiveTools(server, {
  command: command => callDaemon('/command', command),
  snapshot: () => callDaemon('/snapshot'),
}, {
  client: () => client,
  onRegistered: sessionId => {
    heartbeat?.stop();
    // A failed heartbeat is retried 3 times, 5 s apart, before the session is dropped (e.g. daemon draining or paused).
    heartbeat = startHeartbeat({
      beat: () => callDaemon('/command', { action: 'heartbeat', sessionId }),
      onRetry: (attempt, error) => console.error(`Hive: heartbeat failed (${error instanceof Error ? error.message : error}); retry ${attempt}/3`),
      onLost: error => {
        console.error(`Hive: heartbeat failed after 3 retries (${error instanceof Error ? error.message : error}); session ${sessionId} dropped, call hive_register again`);
        heartbeat = undefined;
        if (tools.sessionId === sessionId) tools.drop();
      },
    });
  },
  onReleased: () => { heartbeat?.stop(); heartbeat = undefined; },
});
await server.connect(new StdioServerTransport());
