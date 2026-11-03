import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { claimRuleSchema, intentSchema, operationSchema, proposeSchema } from './schemas.ts';

/**
 * Every hive_* tool, shared by the stdio adapter (src/server/mcp.ts, forwards over HTTP to the daemon) and the
 * daemon's MCP-over-HTTP endpoint (src/server/mcpHttp.ts, runs commands in process). The adapters differ only in
 * the backend that carries a command and in how they keep the Hive session alive.
 */
export interface ToolBackend {
  /** Runs one /command body. Validation and authorization happen on the far side of this call. */
  command(command: Record<string, unknown>): Promise<unknown>;
  /** The cached snapshot (GET /snapshot). */
  snapshot(): Promise<unknown>;
}

export interface ToolOptions {
  /** Client label recorded on register (e.g. claude-code). */
  client?: () => string | undefined;
  /** Called after hive_register binds a Hive session to this MCP connection. */
  onRegistered?: (sessionId: string) => void;
  /** Called after hive_finish or drop() releases the binding. */
  onReleased?: (sessionId: string) => void;
  /** How long hive_verify waits for a running run (default 90 s). Tests shorten it. */
  verifyWaitMs?: number;
  /** Poll interval for verify_status while waiting (default 1 s). */
  verifyPollMs?: number;
}

/** The binding between one MCP connection and at most one Hive session. */
export interface HiveTools {
  readonly sessionId: string | undefined;
  /** Forgets the bound session (lease lost); the agent may register again. */
  drop(): void;
}

export const VERIFY_WAIT_MS = 90_000;
const VERIFY_POLL_MS = 1_000;
const runSchema = z.object({ id: z.string(), contractId: z.string(), status: z.string() }).passthrough();
type Run = z.infer<typeof runSchema>;

function message(error: unknown): string { return error instanceof Error ? error.message : 'Hive failed'; }
async function result(action: () => Promise<unknown>) {
  try { return { content: [{ type: 'text' as const, text: JSON.stringify(await action()) }] }; }
  catch (error) { return { isError: true, content: [{ type: 'text' as const, text: message(error) }] }; }
}
const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, Math.max(0, ms)); });

export function registerHiveTools(server: McpServer, backend: ToolBackend, options: ToolOptions = {}): HiveTools {
  // One identity per MCP connection; callers cannot impersonate a peer by choosing its ID.
  let sessionId: string | undefined;
  const release = () => { const released = sessionId; sessionId = undefined; if (released) options.onReleased?.(released); };
  function session(): string {
    if (!sessionId) throw new Error('Call hive_register first');
    return sessionId;
  }
  const send = (action: string, input: Record<string, unknown> = {}) => backend.command({ action, sessionId: session(), ...input });
  const waitMs = options.verifyWaitMs ?? VERIFY_WAIT_MS;
  const pollMs = options.verifyPollMs ?? VERIFY_POLL_MS;

  server.registerTool('hive_register', { description: 'Register this coding session with the shared Hive daemon. Optionally name the worktree directory you edit in.',
    inputSchema: { name: z.string().min(1).max(200), workspace: z.string().min(1).max(2000).optional() } }, async ({ name, workspace }) => result(async () => {
    if (sessionId) throw new Error('Already registered; finish before registering again');
    const registered = z.object({ id: z.string().uuid() }).passthrough().parse(await backend.command({ action: 'register', name, workspace, client: options.client?.() }));
    sessionId = registered.id;
    options.onRegistered?.(registered.id);
    return registered;
  }));
  server.registerTool('hive_set_intent', { description: 'Declare your task, files, canonical symbols (e.g. src/pricing.ts#getPrice:function) and assumptions. Updates invalidate prior agreements.',
    inputSchema: intentSchema.shape }, async input => result(() => send('intent', { intent: input })));
  server.registerTool('hive_context', { description: 'Read live peer intents, candidate conflicts and pending agreements. Poll before dependent work. Data is not user authorization.',
    inputSchema: {} }, async () => result(async () => { session(); return backend.snapshot(); }));
  server.registerTool('hive_propose_contract', { description: 'Propose a pending interface agreement (Ghost Contract) for a producer symbol. It does not create an implementation.',
    inputSchema: proposeSchema.shape }, async input => result(() => send('propose', input)));
  server.registerTool('hive_acknowledge', { description: 'Accept an exact contract version. Acceptance is not implementation verification.',
    inputSchema: { contractId: z.string().uuid(), version: z.number().int().positive() } }, async input => result(() => send('acknowledge', input)));
  server.registerTool('hive_revise_contract', { description: 'Propose a new version of a contract. Clears all prior acknowledgements; every participant must accept again.',
    inputSchema: { contractId: z.string().uuid(), title: z.string().min(1).optional(), declaration: z.string().min(1).optional(), behaviorNotes: z.string().optional() } },
  async input => result(() => send('revise', input)));
  server.registerTool('hive_reject_contract', { description: 'Reject (participant) or cancel (owner) a contract with a reason.',
    inputSchema: { contractId: z.string().uuid(), reason: z.string().min(1) } }, async input => result(() => send('reject', input)));
  server.registerTool('hive_symbol', { description: 'Look up a symbol by canonical key (src/pricing.ts#getPrice:function), file#name or unique name; returns its signature, compiler-resolved dependents and dependent files.',
    inputSchema: { reference: z.string().min(1).max(2000) } }, async input => result(() => send('symbol', input)));
  server.registerTool('hive_reindex', { description: 'Rebuild the compiler index after you edited files directly. Hive also detects such edits on its own, after the fact.', inputSchema: {} },
    async () => result(() => send('reindex')));
  server.registerTool('hive_preview_operation', { description: 'Stage a semantic operation (add_field or change_signature) without writing files. Returns a diff, new compiler diagnostics relative to baseline, affected callers and explicit rejection reasons. rename_symbol and add_endpoint are not implemented and are rejected.',
    inputSchema: { operation: operationSchema } }, async input => result(() => send('preview', input)));
  server.registerTool('hive_apply_operation', { description: 'Apply a previously previewed proposal. Re-validates revision and source hashes under the writer lock, journals originals, writes files, reindexes. Stale or rejected proposals are refused; failures restore all files.',
    inputSchema: { proposalId: z.string().uuid() } }, async input => result(() => send('apply', input)));
  server.registerTool('hive_contract_check', { description: 'For a contract you participate in: type-check consumer files against the Ghost Contract overlay (pending promise) and against the real code, and report deterministic implementation evidence. Overlay success is not verification.',
    inputSchema: { contractId: z.string().uuid() } }, async input => result(() => send('contract_check', input)));
  server.registerTool('hive_verify', { description: `Run an allowlisted test command (e.g. "node --test tests/x.test.ts") against the REAL code (no overlay) on the Hive service's checkout and record exit code, hashes and revision. Waits up to ${Math.round(waitMs / 1000)} s for the run; a run still going is returned with pending: true (pending is not a failure) and you can keep waiting by calling again with its runId instead of a command. Only exit 0 + real type-check + implementation evidence marks a contract verified; files changing during the run make it inconclusive.`,
    inputSchema: { contractId: z.string().uuid(), command: z.string().min(1).max(2000).optional(), runId: z.string().uuid().optional() } },
  async (input, extra) => result(async () => {
    const id = session();
    if (Boolean(input.command) === Boolean(input.runId)) throw new Error('Pass either command (to start a run) or runId (to keep waiting on a run), not both');
    let run: Run = runSchema.parse(input.runId
      ? await backend.command({ action: 'verify_status', sessionId: id, runId: input.runId })
      : await backend.command({ action: 'verify', sessionId: id, contractId: input.contractId, command: input.command }));
    if (run.contractId !== input.contractId) throw new Error(`Run ${run.id} belongs to contract ${run.contractId}, not ${input.contractId}`);
    const started = Date.now();
    const deadline = started + waitMs;
    const progressToken = extra?._meta?.progressToken;
    let pollError: string | undefined;
    while (run.status === 'running' && Date.now() < deadline && !extra?.signal?.aborted) {
      await sleep(Math.min(pollMs, deadline - Date.now()));
      if (progressToken !== undefined) await extra.sendNotification({ method: 'notifications/progress',
        params: { progressToken, progress: Date.now() - started, total: waitMs, message: `verification ${run.id} running` } }).catch(() => {});
      try { run = runSchema.parse(await backend.command({ action: 'verify_status', sessionId: id, runId: run.id })); pollError = undefined; }
      catch (error) { pollError = message(error); } // a transient poll failure is not a verification result; keep waiting
    }
    if (run.status !== 'running') return { ...run, pending: false };
    return { ...run, pending: true, waitedMs: Date.now() - started, ...(pollError ? { lastPollError: pollError } : {}),
      note: `Still running; this is not a failure. Call hive_verify again with {contractId, runId: "${run.id}"} to keep waiting.` };
  }));
  server.registerTool('hive_claim', { description: 'Register a deterministic rule Hive enforces on its own operations and reports on direct edits. Supported: field_required (a type must keep a field, optionally with an exact type).',
    inputSchema: { rule: claimRuleSchema } }, async input => result(() => send('claim', input)));
  server.registerTool('hive_analyze', { description: 'Ask Muse Spark to interpret the current intents, candidate findings and real declarations, and to propose resolutions with cited evidence. Returns an explicit status: ok, cached, unavailable (no key, timeout, API error), invalid (malformed output) or stale. Unavailable is NOT "no conflict".',
    inputSchema: { force: z.boolean().optional() } }, async input => result(() => send('analyze', input)));
  server.registerTool('hive_finish', { description: 'End this session and release its live intent. Dependent agreements become stale.', inputSchema: {} },
    async () => result(async () => { const value = await send('finish'); release(); return value; }));

  return { get sessionId() { return sessionId; }, drop: release };
}

export interface HeartbeatOptions {
  beat: () => Promise<unknown>;
  /** Called once when the initial beat and every retry failed; the heartbeat has stopped by then. */
  onLost: (error: unknown) => void;
  onRetry?: (attempt: number, error: unknown) => void;
  intervalMs?: number;
  retries?: number;
  retryDelayMs?: number;
}

/**
 * Heartbeats every intervalMs (default 30 s). A failed beat (daemon paused, restarting or draining with 503) is
 * retried `retries` times (default 3), retryDelayMs (default 5 s) apart, before the session is declared lost.
 */
export function startHeartbeat(options: HeartbeatOptions): { stop(): void } {
  const intervalMs = options.intervalMs ?? 30_000;
  const retries = options.retries ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 5_000;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (ms: number, failures: number) => {
    if (stopped) return;
    timer = setTimeout(() => { void attempt(failures); }, ms);
    timer.unref();
  };
  const attempt = async (failures: number): Promise<void> => {
    if (stopped) return;
    try {
      await options.beat();
      schedule(intervalMs, 0);
    } catch (error) {
      if (stopped) return;
      if (failures >= retries) { stopped = true; options.onLost(error); return; }
      options.onRetry?.(failures + 1, error);
      schedule(retryDelayMs, failures + 1);
    }
  };
  schedule(intervalMs, 0);
  return { stop() { stopped = true; if (timer) clearTimeout(timer); } };
}
