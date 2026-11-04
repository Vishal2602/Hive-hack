import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Coordinator, ProposeInput, ReviseInput } from '../domain/coordinator.ts';
import type { Contract, ImplementationEvidence, VerificationRun } from '../domain/types.ts';
import type { GraphIndex } from '../graph/index.ts';
import type { Gate } from '../ops/engine.ts';
import type { Store } from '../store/sqlite.ts';
import { contractShape, overlayCheck, realCheck, satisfies, validateDeclaration, type OverlayResult } from './overlay.ts';

export interface ContractServiceOptions {
  store: Store;
  coordinator: Coordinator;
  graph: (workspaceId: string) => GraphIndex;
  sync: (workspaceId: string) => unknown;
  clock?: () => number;
  /** Command prefixes the daemon may run for verification. Agent-supplied commands are never run otherwise. */
  verifyAllow?: string[];
  /** When true, operations on a symbol other live sessions depend on require an accepted contract. Default: warn only. */
  requireAgreementForDependents?: boolean;
  /** Verification child process timeout. Default 120 s. */
  verifyTimeoutMs?: number;
  /** Bytes of combined stdout+stderr kept per run (the tail). Default 64 KB. */
  verifyOutputLimit?: number;
}
export interface ContractCheck {
  contract: Contract;
  overlay: OverlayResult | null;
  real: OverlayResult | null;
  implementation: { ok: boolean; reason: string; evidence: ImplementationEvidence | null };
}

const DEFAULT_ALLOW = ['npm test', 'npm run', 'node --test', 'npx tsc', 'npx vitest'];
const SAFE_COMMAND = /^[A-Za-z0-9 ._/:*=@-]+$/;
const LIVE = new Set(['accepted', 'implemented', 'verified']);
/** Only these variables reach a verification child: no Hive token, model key, NODE_OPTIONS or inherited test-runner context. */
const CHILD_ENV = ['PATH', 'HOME', 'LANG', 'TMPDIR'];

export function verificationEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of CHILD_ENV) { const value = source[key]; if (value) env[key] = value; }
  return env;
}

type RunRow = { id: string; contract_id: string; version: number; source_hashes_json: string; command: string; exit_code: number; output: string; revision: number;
  passed: number; created_at: number; status: string; reasons_json: string; finished_at: number | null };
function rowToRun(row: RunRow): VerificationRun {
  const status = row.status as VerificationRun['status'];
  const exitCode = Number(row.exit_code);
  return { id: row.id, contractId: row.contract_id, version: Number(row.version), command: row.command, status,
    exitCode: status === 'running' || exitCode === -1 ? null : exitCode, passed: status === 'passed', overlay: false,
    revision: Number(row.revision), sourceHashes: JSON.parse(row.source_hashes_json) as Record<string, string>, output: row.output,
    reasons: JSON.parse(row.reasons_json) as string[], at: Number(row.created_at), finishedAt: row.finished_at === null ? null : Number(row.finished_at) };
}

/** Ghost Contract lifecycle on top of the coordinator: validation, overlays, evidence, verification, gates. */
export class ContractService {
  private readonly store: Store;
  private readonly coordinator: Coordinator;
  private readonly graphFor: (workspaceId: string) => GraphIndex;
  private readonly sync: (workspaceId: string) => unknown;
  private readonly clock: () => number;
  private readonly verifyAllow: string[];
  private readonly requireAgreement: boolean;
  private readonly timeoutMs: number;
  private readonly outputLimit: number;
  private readonly inFlight = new Map<string, { contractId: string; command: string; done: Promise<VerificationRun> }>();

  constructor(options: ContractServiceOptions) {
    this.store = options.store;
    this.coordinator = options.coordinator;
    this.graphFor = options.graph;
    this.sync = options.sync;
    this.clock = options.clock ?? Date.now;
    this.verifyAllow = options.verifyAllow ?? DEFAULT_ALLOW;
    this.requireAgreement = options.requireAgreementForDependents ?? false;
    this.timeoutMs = options.verifyTimeoutMs ?? 120_000;
    this.outputLimit = options.verifyOutputLimit ?? 64 * 1024;
  }

  private workspaceOf(sessionId: string): string { return this.coordinator.heartbeat(sessionId).workspaceId; }
  private producerWorkspace(contract: Contract): string { return this.coordinator.session(contract.ownerSessionId)?.workspaceId ?? this.coordinator.workspaceId; }
  consumerFiles(contract: Contract): string[] {
    const producerFile = contract.producerSymbol?.split('#')[0];
    return [...new Set(contract.participants.flatMap(id => this.coordinator.intent(id)?.files ?? []))].filter(file => file !== producerFile).sort();
  }

  propose(sessionId: string, input: ProposeInput): Contract {
    if (input.producerSymbol) {
      const check = validateDeclaration(input.declaration, input.producerSymbol);
      if (!check.ok) throw new Error(`Invalid contract declaration: ${check.problems.join('; ')}`);
    }
    const contract = this.coordinator.propose(sessionId, input);
    return this.autoAcknowledge(this.recordOverlay(contract));
  }

  /**
   * Routine agreements should not wait for an idle agent (a client cannot be woken from outside).
   * The proposer always signs. Each other participant is signed for automatically when the overlay check
   * shows no new type errors in their declared files AND they declared no assumption about the producer's file
   * (an assumption like "getPrice:unit = dollars" is a meaning-level stake the compiler cannot judge).
   * Everyone else still has to sign; the client hook tells them about it in their current turn.
   */
  autoAcknowledge(contract: Contract): Contract {
    if (contract.status !== 'proposed') return contract;
    const producerFile = contract.producerSymbol?.split('#')[0] ?? null;
    const diagnostics = contract.evidence.overlayCheck?.diagnostics ?? [];
    const sign = (id: string, reason: string): void => {
      try {
        this.coordinator.acknowledge(id, contract.id, contract.version);
        this.coordinator.emit('contract.auto_acknowledged', `${contract.id.slice(0, 8)} v${contract.version} for ${this.coordinator.session(id)?.name ?? id}: ${reason}`,
          { contractId: contract.id, version: contract.version, sessionId: id, reason });
      } catch { /* expired session or contract changed underneath: leave it for a manual signature */ }
    };
    sign(contract.ownerSessionId, 'proposer');
    for (const id of contract.participants) {
      if (id === contract.ownerSessionId) continue;
      const intent = this.coordinator.intent(id);
      if (!intent) continue;
      const stakes = producerFile ? intent.assumptions.filter(a => a.key.startsWith(`${producerFile}#`)) : [];
      const breaks = diagnostics.filter(d => intent.files.some(file => d.startsWith(`${file}:`)));
      if (stakes.length || breaks.length) continue;
      sign(id, 'compatible: no type errors in their files and no stated assumption about the changed code');
    }
    return this.coordinator.contract(contract.id);
  }

  /** Proposed contracts still waiting for a signature from one of this member's sessions (shown to that member's hook). */
  inbox(member: string | null | undefined): { contractId: string; version: number; title: string; declaration: string; behaviorNotes: string; proposer: string; sessionId: string; sessionName: string; reason: string }[] {
    const out: ReturnType<ContractService['inbox']> = [];
    for (const contract of this.coordinator.contracts()) {
      if (contract.status !== 'proposed') continue;
      const producerFile = contract.producerSymbol?.split('#')[0] ?? null;
      for (const id of contract.participants) {
        const session = this.coordinator.session(id);
        if (!session || (session.member ?? null) !== (member ?? null) || contract.acknowledgements.includes(id)) continue;
        const stakes = (this.coordinator.intent(id)?.assumptions ?? []).filter(a => producerFile && a.key.startsWith(`${producerFile}#`));
        out.push({ contractId: contract.id, version: contract.version, title: contract.title, declaration: contract.declaration, behaviorNotes: contract.behaviorNotes,
          proposer: this.coordinator.session(contract.ownerSessionId)?.name ?? contract.ownerSessionId, sessionId: id, sessionName: session.name,
          reason: stakes.length ? `it changes code you assumed: ${stakes.map(a => `${a.key} = ${a.value}`).join('; ')}` : 'it may affect your declared files' });
      }
    }
    return out;
  }
  revise(sessionId: string, contractId: string, input: ReviseInput): Contract {
    const current = this.coordinator.contract(contractId);
    if (input.declaration && current.producerSymbol) {
      const check = validateDeclaration(input.declaration, current.producerSymbol);
      if (!check.ok) throw new Error(`Invalid contract declaration: ${check.problems.join('; ')}`);
    }
    return this.autoAcknowledge(this.recordOverlay(this.coordinator.revise(sessionId, contractId, input)));
  }
  private recordOverlay(contract: Contract): Contract {
    if (!contract.producerSymbol) return contract;
    const overlay = this.overlay(contract);
    this.coordinator.setEvidence(contract.id, { ...contract.evidence, overlayCheck: { ok: overlay.ok, diagnostics: overlay.diagnostics.map(d => `${d.file}:${d.line} TS${d.code} ${d.message}`), at: overlay.at } });
    return this.coordinator.contract(contract.id);
  }

  overlay(contract: Contract): OverlayResult {
    const graph = this.graphFor(this.producerWorkspace(contract));
    return overlayCheck(graph, contract.producerSymbol!, contract.declaration, this.consumerFiles(contract), this.clock);
  }
  real(contract: Contract): OverlayResult {
    const graph = this.graphFor(this.producerWorkspace(contract));
    return realCheck(graph, contract.producerSymbol!, [...this.consumerFiles(contract), contract.producerSymbol!.split('#')[0]!], this.clock);
  }

  /** Deterministic implementation evidence from the compiler index. Never inferred from agreement. */
  implementation(contract: Contract): { ok: boolean; reason: string; evidence: ImplementationEvidence | null } {
    if (!contract.producerSymbol) return { ok: false, reason: 'contract has no producer symbol', evidence: null };
    const graph = this.graphFor(this.producerWorkspace(contract));
    const symbol = graph.symbol(contract.producerSymbol) ?? graph.resolve(contract.producerSymbol);
    if (!symbol) return { ok: false, reason: `${contract.producerSymbol} does not exist in the index`, evidence: null };
    const shape = contractShape(contract.declaration);
    if (!shape) return { ok: false, reason: 'contract declaration could not be parsed', evidence: null };
    const verdict = satisfies(shape, symbol);
    if (!verdict.ok) return { ok: false, reason: verdict.reason, evidence: null };
    return { ok: true, reason: verdict.reason, evidence: { symbol: symbol.key, file: symbol.file, declarationHash: symbol.declarationHash,
      declaration: symbol.meta.signature ?? symbol.kind, revision: this.coordinator.revision(), at: this.clock() } };
  }

  /** Full picture for a participant: can I build against the overlay, does the real code satisfy it, is it implemented. */
  check(sessionId: string, contractId: string): ContractCheck {
    this.sync(this.workspaceOf(sessionId));
    this.refresh([contractId]);
    const contract = this.coordinator.contract(contractId);
    if (!contract.producerSymbol) return { contract, overlay: null, real: null, implementation: this.implementation(contract) };
    return { contract, overlay: this.overlay(contract), real: this.real(contract), implementation: this.implementation(contract) };
  }

  /**
   * Re-derives implemented/verified from current code. Called after every code change.
   * A promise is not withdrawn by code changes; only its evidence moves.
   */
  refresh(ids?: string[]): void {
    for (const contract of this.coordinator.contracts()) {
      if (ids && !ids.includes(contract.id)) continue;
      if (!LIVE.has(contract.status) || !contract.producerSymbol) continue;
      const implementation = this.implementation(contract);
      if (!implementation.ok) {
        if (contract.status !== 'accepted')
          this.coordinator.updateContract(contract.id, 'accepted', { ...contract.evidence, implemented: null, verification: null, staleReason: `implementation evidence lost: ${implementation.reason}` }, `implementation no longer matches (${implementation.reason}); back to accepted`);
        continue;
      }
      if (contract.status === 'verified') {
        const run = contract.evidence.verification;
        const graph = this.graphFor(this.producerWorkspace(contract));
        const current = run ? graph.hashesFor(Object.keys(run.sourceHashes)) : {};
        const unchanged = run && Object.entries(run.sourceHashes).every(([file, hash]) => current[file] === hash);
        if (!unchanged) this.coordinator.updateContract(contract.id, 'implemented', { ...contract.evidence, implemented: implementation.evidence, verification: null, staleReason: 'source changed after verification; run verification again' }, 'verification evidence outdated by source change');
        continue;
      }
      if (contract.status === 'accepted') this.coordinator.updateContract(contract.id, 'implemented', { ...contract.evidence, implemented: implementation.evidence }, `producer ${implementation.evidence!.symbol} now satisfies the declaration (${implementation.evidence!.declaration})`);
    }
  }

  allowedCommand(command: string): string | null {
    const trimmed = command.trim();
    if (!SAFE_COMMAND.test(trimmed)) return 'command contains characters outside the safe set (no shell metacharacters)';
    if (!this.verifyAllow.some(prefix => trimmed === prefix || trimmed.startsWith(`${prefix} `))) return `command is not in the verification allowlist: ${this.verifyAllow.join(', ')}`;
    return null;
  }

  /**
   * Starts an allowlisted command in the session's workspace and returns the run as 'running' immediately; the
   * daemon's event loop is never blocked. The finished run is recorded by finishRun(). Only exit 0 + real type-check
   * + implementation evidence, with the checked files unchanged during the run, can yield 'passed' / 'verified'.
   */
  verify(sessionId: string, contractId: string, command: string): VerificationRun {
    const session = this.coordinator.heartbeat(sessionId);
    this.sync(session.workspaceId);
    this.refresh([contractId]);
    const contract = this.coordinator.contract(contractId);
    if (!contract.participants.includes(sessionId)) throw new Error('Not a contract participant');
    if (!LIVE.has(contract.status)) throw new Error(`Contract is ${contract.status}; verification requires an accepted contract`);
    if (!contract.producerSymbol) throw new Error('Contract has no producer symbol to verify');
    const problem = this.allowedCommand(command);
    if (problem) throw new Error(problem);
    const trimmed = command.trim();
    for (const [runId, flight] of this.inFlight) {
      if (flight.contractId !== contractId) continue;
      if (flight.command === trimmed) return this.run(runId)!; // idempotent: the same check is already running
      throw new Error(`Verification ${runId} (${flight.command}) is already running for this contract; wait for it with verify_status`);
    }
    const graph = this.graphFor(session.workspaceId);
    const files = [...new Set([contract.producerSymbol.split('#')[0]!, ...this.consumerFiles(contract)])];
    const startHashes = graph.hashesFor(files);
    const started = this.clock();
    const run: VerificationRun = { id: randomUUID(), contractId, version: contract.version, command: trimmed, status: 'running', exitCode: null, passed: false,
      overlay: false, revision: this.coordinator.revision(), sourceHashes: startHashes, output: '', reasons: [], at: started, finishedAt: null };
    this.store.transaction(() => {
      this.store.run("INSERT INTO verification_runs(id, contract_id, version, source_hashes_json, command, exit_code, output, revision, overlay, passed, created_at, status, reasons_json, finished_at) VALUES (?, ?, ?, ?, ?, -1, '', ?, 0, 0, ?, 'running', '[]', NULL)",
        run.id, contractId, run.version, JSON.stringify(startHashes), run.command, run.revision, started);
      this.coordinator.emit('contract.verification_started', `${contractId} v${contract.version}: ${run.command}`, { contractId, runId: run.id, version: contract.version, command: run.command });
    });
    const [bin, ...args] = run.command.split(/\s+/);
    const done = new Promise<VerificationRun>(resolve => {
      const chunks: Buffer[] = [];
      let size = 0; let dropped = 0; let timedOut = false; let settled = false;
      const collect = (chunk: Buffer) => {
        chunks.push(chunk); size += chunk.length;
        while (size > this.outputLimit && chunks.length) {
          const head = chunks[0]!; const excess = size - this.outputLimit;
          if (head.length <= excess) { chunks.shift(); size -= head.length; dropped += head.length; }
          else { chunks[0] = head.subarray(excess); size -= excess; dropped += excess; }
        }
      };
      const output = () => `${dropped ? `[output truncated: first ${dropped} bytes dropped]\n` : ''}${Buffer.concat(chunks).toString('utf8')}`;
      let child: ChildProcess;
      let killTimer: NodeJS.Timeout | undefined;
      const settle = (exitCode: number | null, failure: string | null) => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        resolve(this.finishRun(run, { workspaceId: session.workspaceId, files, startHashes, exitCode, failure, timedOut, output: output() }));
      };
      // Process group so a timeout also kills grandchildren (npm -> node --test -> workers).
      const group = process.platform !== 'win32';
      const kill = (signal: NodeJS.Signals) => { try { if (group && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* already gone */ } };
      try {
        child = spawn(bin!, args, { cwd: graph.root, env: verificationEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: group });
      } catch (error) {
        settle(null, `could not start ${bin}: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      child.stdout!.on('data', collect);
      child.stderr!.on('data', collect);
      const timer = setTimeout(() => { timedOut = true; kill('SIGTERM'); killTimer = setTimeout(() => kill('SIGKILL'), 2_000); }, this.timeoutMs);
      child.once('error', error => { clearTimeout(timer); settle(null, `could not start ${bin}: ${error.message}`); });
      child.once('close', code => { clearTimeout(timer); settle(code, null); });
    }).finally(() => { this.inFlight.delete(run.id); });
    this.inFlight.set(run.id, { contractId, command: run.command, done });
    return run;
  }

  /** Records the outcome of a finished child process. Never throws: a failure here is logged and reported as 'error'. */
  private finishRun(run: VerificationRun, outcome: { workspaceId: string; files: string[]; startHashes: Record<string, string>; exitCode: number | null; failure: string | null; timedOut: boolean; output: string }): VerificationRun {
    const finishedAt = this.clock();
    try {
      // Pick up edits made while the command ran (bumps the revision and re-derives evidence when files changed).
      this.sync(outcome.workspaceId);
      this.refresh([run.contractId]);
      const contract = this.coordinator.contract(run.contractId);
      const graph = this.graphFor(outcome.workspaceId);
      const endHashes = graph.hashesFor(outcome.files);
      const changed = outcome.files.filter(file => outcome.startHashes[file] !== endHashes[file]);
      const real = this.real(contract);
      const implementation = this.implementation(contract);
      const reasons: string[] = [];
      let status: VerificationRun['status'];
      if (outcome.failure) { status = 'error'; reasons.push(outcome.failure); }
      else {
        if (outcome.timedOut) reasons.push(`timed out after ${Math.round(this.timeoutMs / 1000)} s and was killed`);
        else if (outcome.exitCode !== 0) reasons.push(outcome.exitCode === null ? 'terminated by a signal' : `exit code ${outcome.exitCode}`);
        if (!real.ok) reasons.push(`real type-check failed: ${real.diagnostics.slice(0, 3).map(d => `${d.file}:${d.line} ${d.message}`).join(' | ')}`);
        if (!implementation.ok) reasons.push(`not implemented: ${implementation.reason}`);
        const moved = [
          changed.length ? `files changed during the run: ${changed.join(', ')}` : null,
          contract.version !== run.version ? `contract revised from v${run.version} to v${contract.version} during the run` : null,
          LIVE.has(contract.status) ? null : `contract became ${contract.status} during the run`,
        ].filter((reason): reason is string => reason !== null);
        if (moved.length) { status = 'inconclusive'; reasons.unshift(...moved); }
        else status = reasons.length ? 'failed' : 'passed';
      }
      const done: VerificationRun = { ...run, status, exitCode: outcome.failure ? null : outcome.exitCode, passed: status === 'passed', output: outcome.output,
        revision: this.coordinator.revision(), reasons, finishedAt };
      this.store.transaction(() => {
        this.store.run('UPDATE verification_runs SET status = ?, exit_code = ?, output = ?, revision = ?, passed = ?, reasons_json = ?, finished_at = ? WHERE id = ?',
          status, done.exitCode ?? -1, done.output, done.revision, done.passed ? 1 : 0, JSON.stringify(reasons), finishedAt, run.id);
        const payload = { contractId: run.contractId, runId: run.id, version: run.version, status, reasons };
        const detail = `${run.contractId} v${run.version}: ${reasons.join('; ')}`;
        if (status === 'passed') {
          this.coordinator.updateContract(run.contractId, 'verified', { ...contract.evidence, implemented: implementation.evidence, verification: done, staleReason: undefined }, `${run.command} exit 0 at revision ${done.revision}`);
        } else if (status === 'inconclusive') {
          // Evidence is left as it was: a run over moving files proves nothing either way.
          this.coordinator.emit('contract.verification_inconclusive', detail, payload);
        } else {
          if (contract.status === 'verified')
            this.coordinator.updateContract(run.contractId, implementation.ok ? 'implemented' : 'accepted', { ...contract.evidence, verification: done, staleReason: `latest verification ${status}` }, `latest verification ${status}; no longer verified`);
          else this.coordinator.setEvidence(run.contractId, { ...contract.evidence, verification: done });
          this.coordinator.emit('contract.verification_failed', detail, payload);
        }
      });
      return done;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Hive: recording verification ${run.id} failed: ${message}`);
      const failed: VerificationRun = { ...run, status: 'error', exitCode: outcome.exitCode, passed: false, output: outcome.output, reasons: [`recording the result failed: ${message}`], finishedAt };
      try {
        this.store.run('UPDATE verification_runs SET status = ?, exit_code = ?, output = ?, passed = 0, reasons_json = ?, finished_at = ? WHERE id = ?',
          'error', failed.exitCode ?? -1, failed.output, JSON.stringify(failed.reasons), finishedAt, run.id);
      } catch { /* store unavailable (closed during shutdown) */ }
      return failed;
    }
  }

  /** Number of verification child processes still running (used to drain before shutdown). */
  get inFlightVerifications(): number { return this.inFlight.size; }
  /** Resolves once every in-flight verification has finished and been recorded. */
  async drain(): Promise<void> { await Promise.allSettled([...this.inFlight.values()].map(flight => flight.done)); }

  run(runId: string): VerificationRun | undefined {
    const row = this.store.get<RunRow>('SELECT * FROM verification_runs WHERE id = ?', runId);
    return row ? rowToRun(row) : undefined;
  }
  /** Current state of a run; throws for an unknown id. */
  status(runId: string): VerificationRun {
    const run = this.run(runId);
    if (!run) throw new Error(`Unknown verification run ${runId}`);
    return run;
  }
  /** Waits up to timeoutMs for a run to finish; returns it as 'running' (pending, not failed) when time runs out. */
  async waitForRun(runId: string, timeoutMs = 90_000): Promise<VerificationRun> {
    const flight = this.inFlight.get(runId);
    if (!flight) return this.status(runId);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); });
    try {
      const finished = await Promise.race([flight.done, timeout]);
      return finished ?? this.status(runId);
    } finally { clearTimeout(timer); }
  }
  runs(contractId: string): VerificationRun[] {
    return this.store.all<RunRow>('SELECT * FROM verification_runs WHERE contract_id = ? ORDER BY created_at, rowid', contractId).map(rowToRun);
  }

  /** Agreement gate: a producer symbol under a proposed (not yet accepted) contract cannot be changed by a Hive operation. */
  gate(): Gate {
    return context => {
      const reasons: string[] = [];
      const graph = this.graphFor(context.workspaceId);
      for (const contract of this.coordinator.contracts()) {
        if (!contract.producerSymbol) continue;
        const producer = graph.resolve(contract.producerSymbol)?.key ?? contract.producerSymbol;
        if (producer !== context.symbol.key) continue;
        if (contract.status === 'proposed') {
          const missing = contract.participants.filter(id => !contract.acknowledgements.includes(id));
          reasons.push(`Contract "${contract.title}" (${contract.id} v${contract.version}) for ${producer} is proposed but not yet accepted by: ${missing.join(', ')}. Acknowledge or reject it first.`);
        }
      }
      if (this.requireAgreement && !reasons.length) {
        const covered = this.coordinator.contracts().some(c => c.producerSymbol && LIVE.has(c.status) && (graph.resolve(c.producerSymbol)?.key ?? c.producerSymbol) === context.symbol.key);
        const others = this.coordinator.intents().filter(intent => intent.sessionId !== context.sessionId);
        const dependents = graph.dependents(context.symbol.key);
        const affected = others.filter(intent => dependents.some(edge => intent.files.includes(edge.file)));
        if (affected.length && !covered) reasons.push(`Other sessions depend on ${context.symbol.key} (${affected.map(i => i.sessionId).join(', ')}) and no accepted contract covers it`);
      }
      return reasons;
    };
  }
}
