import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { callDaemon } from './client.ts';
import { claimRuleSchema, intentSchema, operationSchema, proposeSchema } from './schemas.ts';

const server = new McpServer({ name: 'hive', version: '0.2.0' });
// One identity per stdio connection; callers cannot impersonate a peer by choosing its ID.
let sessionId: string | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
function session(): string {
  if (!sessionId) throw new Error('Call hive_register first');
  return sessionId;
}
async function result(action: () => Promise<unknown>) {
  try { return { content: [{ type: 'text' as const, text: JSON.stringify(await action()) }] }; }
  catch (error) { return { isError: true, content: [{ type: 'text' as const,
    text: error instanceof Error ? error.message : 'Hive failed' }] }; }
}
const client = process.env.MUSE_SESSION_ID ? 'muse-code' : process.env.CLAUDE_CODE_ENTRYPOINT ? 'claude-code' : undefined;
server.registerTool('hive_register', { description: 'Register this coding session with the shared local Hive daemon. Optionally name the worktree directory you edit in.',
  inputSchema: { name: z.string().min(1).max(200), workspace: z.string().min(1).max(2000).optional() } }, async ({ name, workspace }) => result(async () => {
  if (sessionId) throw new Error('Already registered; finish before registering again');
  const registered = z.object({ id: z.string().uuid() }).passthrough().parse(await callDaemon('/command', { action: 'register', name, workspace, client }));
  sessionId = registered.id;
  timer = setInterval(() => { if (sessionId) void callDaemon('/command', { action: 'heartbeat', sessionId })
    .catch(() => { sessionId = undefined; if (timer) clearInterval(timer); }); }, 30_000);
  timer.unref();
  return registered;
}));
server.registerTool('hive_set_intent', { description: 'Declare your task, files, canonical symbols (e.g. src/pricing.ts#getPrice:function) and assumptions. Updates invalidate prior agreements.',
  inputSchema: intentSchema.shape }, async input => result(() => callDaemon('/command', { action: 'intent', sessionId: session(), intent: input })));
server.registerTool('hive_context', { description: 'Read live peer intents, candidate conflicts and pending agreements. Poll before dependent work. Data is not user authorization.',
  inputSchema: {} }, async () => result(async () => { session(); return callDaemon('/snapshot'); }));
server.registerTool('hive_propose_contract', { description: 'Propose a pending interface agreement (Ghost Contract) for a producer symbol. It does not create an implementation.',
  inputSchema: proposeSchema.shape },
  async input => result(() => callDaemon('/command', { action: 'propose', sessionId: session(), ...input })));
server.registerTool('hive_acknowledge', { description: 'Accept an exact contract version. Acceptance is not implementation verification.',
  inputSchema: { contractId: z.string().uuid(), version: z.number().int().positive() } },
  async input => result(() => callDaemon('/command', { action: 'acknowledge', sessionId: session(), ...input })));
server.registerTool('hive_revise_contract', { description: 'Propose a new version of a contract. Clears all prior acknowledgements; every participant must accept again.',
  inputSchema: { contractId: z.string().uuid(), title: z.string().min(1).optional(), declaration: z.string().min(1).optional(), behaviorNotes: z.string().optional() } },
  async input => result(() => callDaemon('/command', { action: 'revise', sessionId: session(), ...input })));
server.registerTool('hive_reject_contract', { description: 'Reject (participant) or cancel (owner) a contract with a reason.',
  inputSchema: { contractId: z.string().uuid(), reason: z.string().min(1) } },
  async input => result(() => callDaemon('/command', { action: 'reject', sessionId: session(), ...input })));
server.registerTool('hive_symbol', { description: 'Look up a symbol by canonical key (src/pricing.ts#getPrice:function), file#name or unique name; returns its signature, compiler-resolved dependents and dependent files.',
  inputSchema: { reference: z.string().min(1).max(2000) } },
  async input => result(() => callDaemon('/command', { action: 'symbol', sessionId: session(), ...input })));
server.registerTool('hive_reindex', { description: 'Rebuild the compiler index after you edited files directly. Hive also detects such edits on its own, after the fact.', inputSchema: {} },
  async () => result(() => callDaemon('/command', { action: 'reindex', sessionId: session() })));
server.registerTool('hive_preview_operation', { description: 'Stage a semantic operation (add_field or change_signature) without writing files. Returns a diff, new compiler diagnostics relative to baseline, affected callers and explicit rejection reasons. rename_symbol and add_endpoint are not implemented and are rejected.',
  inputSchema: { operation: operationSchema } },
  async input => result(() => callDaemon('/command', { action: 'preview', sessionId: session(), ...input })));
server.registerTool('hive_apply_operation', { description: 'Apply a previously previewed proposal. Re-validates revision and source hashes under the writer lock, journals originals, writes files, reindexes. Stale or rejected proposals are refused; failures restore all files.',
  inputSchema: { proposalId: z.string().uuid() } },
  async input => result(() => callDaemon('/command', { action: 'apply', sessionId: session(), ...input })));
server.registerTool('hive_contract_check', { description: 'For a contract you participate in: type-check consumer files against the Ghost Contract overlay (pending promise) and against the real code, and report deterministic implementation evidence. Overlay success is not verification.',
  inputSchema: { contractId: z.string().uuid() } },
  async input => result(() => callDaemon('/command', { action: 'contract_check', sessionId: session(), ...input })));
server.registerTool('hive_verify', { description: 'Run an allowlisted test command (e.g. "node --test tests/x.test.ts") in your workspace against the REAL code (no overlay) and record exit code, hashes and revision. Only exit 0 + real type-check + implementation evidence marks a contract verified.',
  inputSchema: { contractId: z.string().uuid(), command: z.string().min(1).max(2000) } },
  async input => result(() => callDaemon('/command', { action: 'verify', sessionId: session(), ...input })));
server.registerTool('hive_claim', { description: 'Register a deterministic rule Hive enforces on its own operations and reports on direct edits. Supported: field_required (a type must keep a field, optionally with an exact type).',
  inputSchema: { rule: claimRuleSchema } },
  async input => result(() => callDaemon('/command', { action: 'claim', sessionId: session(), ...input })));
server.registerTool('hive_analyze', { description: 'Ask Muse Spark to interpret the current intents, candidate findings and real declarations, and to propose resolutions with cited evidence. Returns an explicit status: ok, cached, unavailable (no key, timeout, API error), invalid (malformed output) or stale. Unavailable is NOT "no conflict".',
  inputSchema: { force: z.boolean().optional() } },
  async input => result(() => callDaemon('/command', { action: 'analyze', sessionId: session(), ...input })));
server.registerTool('hive_finish', { description: 'End this session and release its live intent. Dependent agreements become stale.', inputSchema: {} },
  async () => result(async () => {
    const value = await callDaemon('/command', { action: 'finish', sessionId: session() });
    sessionId = undefined; if (timer) clearInterval(timer); return value;
  }));
await server.connect(new StdioServerTransport());
