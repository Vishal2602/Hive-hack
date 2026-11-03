import { Coordinator, type CoordinatorOptions } from './domain/coordinator.ts';
import type { Finding, Intent, Snapshot } from './domain/types.ts';
import { GraphIndex, type FileChanges, type IndexedEdge, type IndexedSymbol } from './graph/index.ts';
import { ClaimService, type Claim, type ClaimRule } from './contracts/claims.ts';
import { ContractService, type ContractCheck } from './contracts/service.ts';
import type { ProposeInput, ReviseInput } from './domain/coordinator.ts';
import type { Contract, VerificationRun } from './domain/types.ts';
import { MetaAnalyzer } from './intelligence/meta.ts';
import { AnalysisService } from './intelligence/service.ts';
import type { Analysis, Analyzer } from './intelligence/types.ts';
import { OperationEngine, type Gate } from './ops/engine.ts';
import type { ApplyResult, Proposal, SemanticOperation, OperationPreview } from './ops/types.ts';
import type { Store } from './store/sqlite.ts';

export interface ServiceOptions extends Omit<CoordinatorOptions, 'detectors' | 'store'> {
  store: Store;
  tsconfig?: string;
  gates?: Gate[];
  /** Test hook forwarded to the operation engine. */
  onFileWritten?: (file: string, index: number) => void;
  verifyAllow?: string[];
  requireAgreementForDependents?: boolean;
  /** Model adapter. Defaults to MetaAnalyzer over MODEL_API_KEY; tests inject a fake. */
  analyzer?: Analyzer;
}
export interface GraphSummary { workspaceId: string; indexed: boolean; symbols: number; edges: number; files: number; lastSync: FileChanges | null }
export interface ServiceSnapshot extends Snapshot { graph: GraphSummary; proposals: Proposal[]; claims: Claim[]; analysis: Analysis | null; model: { configured: boolean; model: string } }
export interface HookCheck {
  file: string;
  pendingContracts: { id: string; version: number; title: string; missing: string[] }[];
  declaredBy: { sessionId: string; name: string; task: string }[];
  dependentSessions: { sessionId: string; name: string; task: string }[];
  revision: number;
}
export interface SymbolReport { symbol: IndexedSymbol | null; dependents: IndexedEdge[]; dependentFiles: string[]; candidates: string[] }

const DIRECT_EDIT_WINDOW_MS = 10 * 60_000;

/**
 * Composition root used by the daemon: one coordinator, one compiler index per workspace,
 * direct-edit detection before every read, and compiler-backed findings.
 */
export class HiveService {
  readonly coordinator: Coordinator;
  readonly engine: OperationEngine;
  readonly contracts: ContractService;
  readonly claims: ClaimService;
  readonly analysis: AnalysisService;
  readonly analyzer: Analyzer;
  readonly store: Store;
  private readonly graphs = new Map<string, GraphIndex>();
  private readonly lastSync = new Map<string, FileChanges>();
  private readonly tsconfig: string | undefined;
  private readonly clock: () => number;

  constructor(options: ServiceOptions) {
    this.store = options.store;
    this.tsconfig = options.tsconfig;
    this.clock = options.clock ?? Date.now;
    this.coordinator = new Coordinator({ ...options, detectors: [intents => this.graphFindings(intents), () => this.directEditFindings(), () => this.claims.findings(this.graph())] });
    this.claims = new ClaimService(this.store, this.coordinator.repositoryId, this.clock);
    this.contracts = new ContractService({ store: this.store, coordinator: this.coordinator, graph: id => this.graph(id), sync: id => this.sync(id), clock: this.clock,
      verifyAllow: options.verifyAllow, requireAgreementForDependents: options.requireAgreementForDependents });
    this.engine = new OperationEngine({ store: this.store, coordinator: this.coordinator, graph: id => this.graph(id), sync: id => this.sync(id),
      gates: [this.contracts.gate(), this.claims.gate(id => this.graph(id)), ...(options.gates ?? [])], clock: this.clock, onFileWritten: options.onFileWritten });
    this.analyzer = options.analyzer ?? new MetaAnalyzer();
    this.analysis = new AnalysisService({ store: this.store, coordinator: this.coordinator, graph: id => this.graph(id), sync: id => this.sync(id), findings: () => this.coordinator.findings(), analyzer: this.analyzer, clock: this.clock });
  }

  analyze(sessionId: string, options: { force?: boolean } = {}): Promise<Analysis> { return this.analysis.analyze(sessionId, options); }

  /** Pre-write check used by client hooks: is this file under a pending agreement or inside another session's declared scope? */
  hookCheck(file: string): HookCheck {
    const graph = this.graph();
    const rel = graph.rel(graph.abs(file));
    const pending = this.coordinator.contracts().filter(c => c.status === 'proposed' && c.producerSymbol?.split('#')[0] === rel)
      .map(c => ({ id: c.id, version: c.version, title: c.title, missing: c.participants.filter(p => !c.acknowledgements.includes(p)) }));
    const declaredBy = this.coordinator.intents().filter(i => i.files.includes(rel)).map(i => ({ sessionId: i.sessionId, name: this.coordinator.session(i.sessionId)?.name ?? i.sessionId, task: i.task }));
    const dependents = graph.symbolsInFile(rel).flatMap(symbol => graph.dependents(symbol.key)).filter(edge => edge.file !== rel);
    const dependentSessions = this.coordinator.intents().filter(i => dependents.some(edge => i.files.includes(edge.file))).map(i => ({ sessionId: i.sessionId, name: this.coordinator.session(i.sessionId)?.name ?? i.sessionId, task: i.task }));
    return { file: rel, pendingContracts: pending, declaredBy, dependentSessions, revision: this.coordinator.revision() };
  }

  // ---- operations (engine + contract evidence refresh) ----------------------------------------
  preview(sessionId: string, operation: SemanticOperation): OperationPreview { return this.engine.preview(sessionId, operation); }
  apply(sessionId: string, proposalId: string): ApplyResult {
    const result = this.engine.apply(sessionId, proposalId);
    if (result.status === 'applied') this.contracts.refresh();
    return result;
  }

  // ---- contracts ---------------------------------------------------------------------------------
  propose(sessionId: string, input: ProposeInput): Contract { this.sync(this.coordinator.heartbeat(sessionId).workspaceId); return this.contracts.propose(sessionId, input); }
  revise(sessionId: string, contractId: string, input: ReviseInput): Contract { return this.contracts.revise(sessionId, contractId, input); }
  contractCheck(sessionId: string, contractId: string): ContractCheck { return this.contracts.check(sessionId, contractId); }
  verify(sessionId: string, contractId: string, command: string): VerificationRun { return this.contracts.verify(sessionId, contractId, command); }
  claim(sessionId: string, rule: ClaimRule): Claim {
    const session = this.coordinator.heartbeat(sessionId);
    const claim = this.claims.register(`${session.name} (${session.id})`, rule);
    this.coordinator.emit('claim.registered', `${rule.kind} ${rule.symbol}.${rule.field}${rule.type ? `: ${rule.type}` : ''} by ${session.name}`, { claimId: claim.id, sessionId });
    return claim;
  }

  /** Index for a workspace, built on first use. */
  graph(workspaceId: string = this.coordinator.workspaceId): GraphIndex {
    let graph = this.graphs.get(workspaceId);
    if (!graph) {
      const workspace = this.coordinator.workspace(workspaceId);
      graph = new GraphIndex({ store: this.store, workspaceId, root: workspace.realRoot, clock: this.clock,
        ...(workspaceId === this.coordinator.workspaceId && this.tsconfig ? { tsconfig: this.tsconfig } : {}) });
      this.graphs.set(workspaceId, graph);
    }
    if (!graph.isIndexed()) this.reindex(workspaceId, 'initial index');
    return graph;
  }

  /** Full reindex: bumps the code revision when sources changed and stales contracts touching them. */
  reindex(workspaceId: string = this.coordinator.workspaceId, reason = 'reindex requested'): FileChanges & { symbols: number; edges: number; files: number; revision: number } {
    const graph = this.graphs.get(workspaceId) ?? this.graph(workspaceId);
    const wasIndexed = graph.isIndexed();
    const result = graph.reindex();
    this.lastSync.set(workspaceId, { changed: result.changed, added: result.added, removed: result.removed });
    const touched = [...result.changed, ...result.added, ...result.removed];
    let revision = this.coordinator.revision();
    if (!wasIndexed || touched.length) {
      revision = this.coordinator.bumpRevision(`${reason}: ${touched.length ? touched.join(', ') : `${result.files} files indexed`}`);
      if (wasIndexed && touched.length) {
        this.coordinator.emit('direct_edit', `Files changed outside Hive operations: ${touched.join(', ')}`, { files: touched, workspaceId, revision });
        // A promise is not withdrawn by code; its implementation/verification evidence is re-derived.
        this.contracts.refresh();
      }
    }
    return { ...result, revision };
  }

  /** Cheap drift check on known files; reindexes when something changed. Called before reads and operations. */
  sync(workspaceId: string = this.coordinator.workspaceId): FileChanges {
    const graph = this.graph(workspaceId);
    const quick = graph.quickChanges();
    if (quick.changed.length || quick.removed.length) return this.reindex(workspaceId, 'direct edit detected');
    return quick;
  }

  graphSummary(workspaceId: string = this.coordinator.workspaceId): GraphSummary {
    const graph = this.graph(workspaceId);
    const count = (table: string) => Number(this.store.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`, workspaceId)!.n);
    return { workspaceId, indexed: graph.isIndexed(), symbols: count('symbols'), edges: count('edges'), files: count('files'), lastSync: this.lastSync.get(workspaceId) ?? null };
  }

  symbolReport(reference: string, workspaceId: string = this.coordinator.workspaceId): SymbolReport {
    this.sync(workspaceId);
    const graph = this.graph(workspaceId);
    const symbol = graph.resolve(reference) ?? null;
    const candidates = symbol ? [] : graph.symbols().filter(s => s.key.includes(reference)).map(s => s.key).slice(0, 20);
    return { symbol, dependents: symbol ? graph.dependents(symbol.key) : [], dependentFiles: symbol ? graph.dependentFiles(symbol.key) : [], candidates };
  }

  /** Compiler-backed candidates: one session declares work on a symbol that another session's scope depends on. */
  graphFindings(intents: Intent[]): Finding[] {
    const findings: Finding[] = [];
    const seen = new Set<string>();
    for (const writer of intents) {
      const session = this.coordinator.session(writer.sessionId);
      if (!session) continue;
      const graph = this.graph(session.workspaceId);
      for (const reference of writer.symbols) {
        const symbol = graph.resolve(reference);
        if (!symbol) continue;
        const dependents = graph.dependents(symbol.key);
        if (!dependents.length) continue;
        for (const reader of intents) {
          if (reader.sessionId === writer.sessionId) continue;
          const hits = dependents.filter(edge => reader.files.includes(edge.file) || reader.symbols.some(s => graph.resolve(s)?.key === edge.from));
          if (!hits.length) continue;
          const id = [writer.sessionId, reader.sessionId, symbol.key].join('|');
          if (seen.has(id)) continue;
          seen.add(id);
          const where = hits.slice(0, 3).map(edge => `${edge.from} (${edge.file}:${edge.line})`).join('; ');
          findings.push({ kind: 'dependent_write', severity: 'warning', sessions: [writer.sessionId, reader.sessionId], source: 'compiler',
            symbols: [symbol.key], files: [...new Set(hits.map(h => h.file))],
            evidence: `${writer.sessionId} declares work on ${symbol.key} (${symbol.meta.signature ?? symbol.kind}); ${reader.sessionId}'s scope depends on it: ${where}` });
        }
      }
    }
    return findings;
  }

  /** Recent direct edits, surfaced as findings so clients see them after the fact. */
  directEditFindings(): Finding[] {
    const since = this.clock() - DIRECT_EDIT_WINDOW_MS;
    const intents = this.coordinator.intents();
    return this.coordinator.events(0, 500).filter(event => event.type === 'direct_edit' && event.at >= since).map(event => {
      const files = (event.payload?.files as string[] | undefined) ?? [];
      const sessions = intents.filter(intent => intent.files.some(file => files.includes(file))).map(intent => intent.sessionId);
      return { kind: 'direct_edit', severity: 'info', sessions, source: 'deterministic', files, evidence: `${event.detail} (detected ${new Date(event.at).toISOString()}, revision ${String(event.payload?.revision ?? '?')})` } satisfies Finding;
    });
  }

  snapshot(): ServiceSnapshot {
    this.sync();
    const analyzer = this.analyzer as { configured?: boolean; model?: string };
    return { ...this.coordinator.snapshot(), graph: this.graphSummary(), proposals: this.engine.proposals(20), claims: this.claims.active(), analysis: this.analysis.latest(),
      model: { configured: analyzer.configured ?? true, model: analyzer.model ?? 'custom' } };
  }
}
