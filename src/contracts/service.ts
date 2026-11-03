import { spawnSync } from 'node:child_process';
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

/** Ghost Contract lifecycle on top of the coordinator: validation, overlays, evidence, verification, gates. */
export class ContractService {
  private readonly store: Store;
  private readonly coordinator: Coordinator;
  private readonly graphFor: (workspaceId: string) => GraphIndex;
  private readonly sync: (workspaceId: string) => unknown;
  private readonly clock: () => number;
  private readonly verifyAllow: string[];
  private readonly requireAgreement: boolean;

  constructor(options: ContractServiceOptions) {
    this.store = options.store;
    this.coordinator = options.coordinator;
    this.graphFor = options.graph;
    this.sync = options.sync;
    this.clock = options.clock ?? Date.now;
    this.verifyAllow = options.verifyAllow ?? DEFAULT_ALLOW;
    this.requireAgreement = options.requireAgreementForDependents ?? false;
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
    return this.recordOverlay(contract);
  }
  revise(sessionId: string, contractId: string, input: ReviseInput): Contract {
    const current = this.coordinator.contract(contractId);
    if (input.declaration && current.producerSymbol) {
      const check = validateDeclaration(input.declaration, current.producerSymbol);
      if (!check.ok) throw new Error(`Invalid contract declaration: ${check.problems.join('; ')}`);
    }
    return this.recordOverlay(this.coordinator.revise(sessionId, contractId, input));
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

  /** Runs an allowlisted command in the session's workspace and records evidence. Only exit 0 + real type-check + implementation evidence can yield 'verified'. */
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
    const graph = this.graphFor(session.workspaceId);
    const [bin, ...args] = command.trim().split(/\s+/);
    const started = this.clock();
    // Child env: no Hive/model secrets, and no inherited test-runner context (a nested `node --test` would otherwise report exit 0).
    const env: Record<string, string | undefined> = { ...process.env, HIVE_TOKEN: '', MODEL_API_KEY: '' };
    delete env.NODE_TEST_CONTEXT; delete env.NODE_OPTIONS;
    const proc = spawnSync(bin!, args, { cwd: graph.root, encoding: 'utf8', timeout: 120_000, env });
    const exitCode = proc.status ?? (proc.error ? 1 : 1);
    const output = `${proc.stdout ?? ''}${proc.stderr ?? ''}${proc.error ? `\n${proc.error.message}` : ''}`.slice(-8000);
    const real = this.real(contract);
    const implementation = this.implementation(contract);
    const files = [...new Set([contract.producerSymbol.split('#')[0]!, ...this.consumerFiles(contract)])];
    const run: VerificationRun = { id: randomUUID(), contractId, version: contract.version, command: command.trim(), exitCode,
      passed: exitCode === 0 && real.ok && implementation.ok, overlay: false, revision: this.coordinator.revision(), sourceHashes: graph.hashesFor(files), output, at: started };
    this.store.transaction(() => {
      this.store.run('INSERT INTO verification_runs(id, contract_id, version, source_hashes_json, command, exit_code, output, revision, overlay, passed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)',
        run.id, contractId, run.version, JSON.stringify(run.sourceHashes), run.command, exitCode, output, run.revision, run.passed ? 1 : 0, started);
      const reasons = [exitCode === 0 ? null : `exit code ${exitCode}`, real.ok ? null : `real type-check failed: ${real.diagnostics.slice(0, 3).map(d => `${d.file}:${d.line} ${d.message}`).join(' | ')}`, implementation.ok ? null : `not implemented: ${implementation.reason}`].filter(Boolean);
      if (run.passed) this.coordinator.updateContract(contractId, 'verified', { ...contract.evidence, implemented: implementation.evidence, verification: run }, `${run.command} exit 0 at revision ${run.revision}`);
      else {
        this.coordinator.setEvidence(contractId, { ...contract.evidence, verification: run });
        this.coordinator.emit('contract.verification_failed', `${contractId} v${contract.version}: ${reasons.join('; ')}`, { contractId, runId: run.id, reasons });
      }
    });
    return run;
  }
  runs(contractId: string): VerificationRun[] {
    return this.store.all<{ id: string; version: number; source_hashes_json: string; command: string; exit_code: number; output: string; revision: number; passed: number; created_at: number }>(
      'SELECT * FROM verification_runs WHERE contract_id = ? ORDER BY created_at', contractId)
      .map(row => ({ id: row.id, contractId, version: Number(row.version), command: row.command, exitCode: Number(row.exit_code), passed: Boolean(row.passed), overlay: false,
        revision: Number(row.revision), sourceHashes: JSON.parse(row.source_hashes_json) as Record<string, string>, output: row.output, at: Number(row.created_at) }));
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
