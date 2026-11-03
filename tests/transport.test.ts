import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function unusedPort(): Promise<number> {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

test('two independent stdio clients share the daemon, register and observe conflicts', { timeout: 20_000 }, async () => {
  const port = await unusedPort();
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  Object.assign(env, { HIVE_TOKEN: 'test-token-not-production', HIVE_PORT: String(port), HIVE_URL: `http://127.0.0.1:${port}`, HIVE_DB: ':memory:', HIVE_PROJECT_ROOT: fileURLToPath(new URL('../fixtures/billing', import.meta.url)) });
  const daemon = spawn(process.execPath, [fileURLToPath(new URL('../src/server/daemon.ts', import.meta.url))], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  const clients: Client[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      let log = '';
      daemon.stderr!.on('data', chunk => { log += String(chunk); if (log.includes('Hive daemon listening')) resolve(); });
      daemon.once('error', reject);
      daemon.once('exit', code => reject(new Error(`Daemon exited ${code}: ${log}`)));
    });
    const unauthenticated = await fetch(`${env.HIVE_URL}/snapshot`);
    assert.equal(unauthenticated.status, 401);
    for (const name of ['A', 'B']) {
      const client = new Client({ name: `test-${name}`, version: '1.0.0' });
      clients.push(client);
      await client.connect(new StdioClientTransport({ command: process.execPath,
        args: [fileURLToPath(new URL('../src/server/mcp.ts', import.meta.url))], env }));
      const registration = await client.callTool({ name: 'hive_register', arguments: { name } });
      assert.notEqual(registration.isError, true);
      const intent = await client.callTool({ name: 'hive_set_intent', arguments: {
        task: 'Pricing', files: [name === 'A' ? 'src/pricing.ts' : 'src/invoice.ts'], symbols: name === 'A' ? ['src/pricing.ts#getPrice:function'] : ['src/invoice.ts#invoiceTotal:function'],
        assumptions: [{ key: 'getPrice:unit', value: name === 'A' ? 'cents' : 'dollars' }],
      } });
      assert.notEqual(intent.isError, true);
    }
    const context = await clients[0]!.callTool({ name: 'hive_context', arguments: {} });
    assert.notEqual(context.isError, true);
    assert.match(JSON.stringify(context), /assumption_mismatch/);
    assert.match(JSON.stringify(context), /dollars/);
    assert.match(JSON.stringify(context), /dependent_write/);
    const symbol = await clients[1]!.callTool({ name: 'hive_symbol', arguments: { reference: 'src/pricing.ts#getPrice:function' } });
    assert.match(JSON.stringify(symbol), /invoiceTotal/);
    const tools = await clients[1]!.listTools();
    assert.ok(tools.tools.length >= 8, `expected at least 8 tools, got ${tools.tools.length}`);
  } finally {
    await Promise.all(clients.map(client => client.close()));
    const exited = once(daemon, 'exit'); daemon.kill();
    if (daemon.exitCode === null) await exited;
  }
});
