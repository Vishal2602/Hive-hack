import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('../fixtures/billing/', import.meta.url));
const daemonPath = fileURLToPath(new URL('../src/server/daemon.ts', import.meta.url));
const hookPath = fileURLToPath(new URL('../src/hooks/hook.ts', import.meta.url));

async function unusedPort(): Promise<number> {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test port');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}
function runHook(event: string, env: Record<string, string>, stdin: unknown, client = 'claude') {
  const proc = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', hookPath, event, '--client', client], { env, input: JSON.stringify(stdin), encoding: 'utf8', timeout: 30_000 });
  return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr, json: (() => { try { return JSON.parse(proc.stdout) as { hookSpecificOutput: Record<string, string> }; } catch { return null; } })() };
}
async function command(env: Record<string, string>, body: unknown): Promise<unknown> {
  const response = await fetch(`${env.HIVE_URL}/command`, { method: 'POST', headers: { Authorization: `Bearer ${env.HIVE_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(String(json.error));
  return json;
}

test('hook adapter: context injection, pre-write gate on a pending contract, post-write reindex, daemon-down fallback', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-hooks-'));
  cpSync(fixture, dir, { recursive: true });
  const port = await unusedPort();
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  Object.assign(env, { HIVE_TOKEN: 'hook-test-token', HIVE_PORT: String(port), HIVE_URL: `http://127.0.0.1:${port}`, HIVE_DB: ':memory:', HIVE_PROJECT_ROOT: dir });
  const daemon = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', daemonPath], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    await new Promise<void>((resolve, reject) => {
      let log = '';
      daemon.stderr!.on('data', chunk => { log += String(chunk); if (log.includes('Hive daemon listening')) resolve(); });
      daemon.once('exit', code => reject(new Error(`Daemon exited ${code}: ${log}`)));
    });
    const a = await command(env, { action: 'register', name: 'pricing agent' }) as { id: string };
    const b = await command(env, { action: 'register', name: 'invoice agent' }) as { id: string };
    await command(env, { action: 'intent', sessionId: a.id, intent: { task: 'cents', files: ['src/pricing.ts'], symbols: ['src/pricing.ts#getPrice:function'], assumptions: [{ key: 'src/pricing.ts#getPrice:unit', value: 'cents' }] } });
    await command(env, { action: 'intent', sessionId: b.id, intent: { task: 'invoices', files: ['src/invoice.ts'], symbols: ['src/invoice.ts#invoiceTotal:function'], assumptions: [{ key: 'src/pricing.ts#getPrice:unit', value: 'dollars' }] } });

    // Prompt hook: findings reach the agent's context.
    const prompt = runHook('prompt', env, { session_id: 'claude-1', prompt: 'continue' });
    assert.equal(prompt.status, 0, prompt.stderr);
    assert.equal(prompt.json!.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(prompt.json!.hookSpecificOutput.additionalContext!, /assumption_mismatch/);
    assert.match(prompt.json!.hookSpecificOutput.additionalContext!, /pricing agent vs invoice agent/);

    // Pre-write on a file nobody has a pending contract for: context only, no gate.
    const free = runHook('pre-write', env, { tool_name: 'Edit', tool_input: { file_path: join(dir, 'src/button.ts') } });
    assert.equal(free.status, 0);
    assert.equal(free.json!.hookSpecificOutput.permissionDecision, undefined);

    // Pre-write on the producer file of a proposed, unaccepted contract: ask (default gate).
    const contract = await command(env, { action: 'propose', sessionId: a.id, title: 'Explicit unit', declaration: "export declare function getPrice(unit: 'cents' | 'dollars'): number;", participants: [b.id], producerSymbol: 'src/pricing.ts#getPrice:function' }) as { id: string };
    const gated = runHook('pre-write', env, { tool_name: 'Write', tool_input: { file_path: join(dir, 'src/pricing.ts'), content: 'x' } });
    assert.equal(gated.status, 0);
    assert.equal(gated.json!.hookSpecificOutput.permissionDecision, 'ask');
    assert.match(gated.json!.hookSpecificOutput.permissionDecisionReason!, /proposed but not yet accepted/);
    assert.match(gated.json!.hookSpecificOutput.additionalContext!, /declared scope of: pricing agent/);
    const denied = runHook('pre-write', { ...env, HIVE_HOOK_GATE: 'deny' }, { tool_input: { file_path: 'src/pricing.ts' } });
    assert.equal(denied.status, 2);
    assert.equal(denied.json!.hookSpecificOutput.permissionDecision, 'deny');
    // Muse-style output: plain text, no JSON contract assumed.
    const muse = runHook('pre-write', env, { tool_input: { file_path: 'src/pricing.ts' } }, 'muse');
    assert.equal(muse.json, null);
    assert.match(muse.stdout, /proposed but not yet accepted/);
    assert.ok(readFileSync(join(dir, '.hive/hook-log.jsonl'), 'utf8').split('\n').filter(Boolean).length >= 5, 'raw stdin captured for schema verification');

    // Accept the contract: the gate clears. Then a direct edit is reindexed by the post-write hook.
    await command(env, { action: 'acknowledge', sessionId: b.id, contractId: contract.id, version: 1 });
    await command(env, { action: 'acknowledge', sessionId: a.id, contractId: contract.id, version: 1 });
    assert.equal(runHook('pre-write', env, { tool_input: { file_path: 'src/pricing.ts' } }).json!.hookSpecificOutput.permissionDecision, undefined);
    writeFileSync(join(dir, 'src/button.ts'), "export const buttonLabel = 'Download invoice';\n");
    const post = runHook('post-write', env, { tool_name: 'Edit', tool_input: { file_path: 'src/button.ts' } });
    assert.equal(post.status, 0, post.stderr);
    assert.match(post.json!.hookSpecificOutput.additionalContext!, /reindexed after your edit: src\/button\.ts/);
    const snapshot = await (await fetch(`${env.HIVE_URL}/snapshot`, { headers: { Authorization: `Bearer ${env.HIVE_TOKEN}` } })).json() as { events: { type: string }[] };
    assert.ok(snapshot.events.some(e => e.type === 'direct_edit'));
  } finally {
    const exited = once(daemon, 'exit'); daemon.kill(); if (daemon.exitCode === null) await exited;
    // Daemon down: hooks must not block the client.
    const down = runHook('prompt', env, { prompt: 'x' });
    assert.equal(down.status, 0);
    assert.match(down.json!.hookSpecificOutput.additionalContext!, /Hive daemon unreachable/);
    rmSync(dir, { recursive: true, force: true });
  }
});
