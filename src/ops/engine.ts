import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Project } from 'ts-morph';
import type { Coordinator } from '../domain/coordinator.ts';
import type { GraphIndex, IndexedSymbol } from '../graph/index.ts';
import type { Store } from '../store/sqlite.ts';
import { unifiedDiff } from './diff.ts';
import { render } from './renderers.ts';
import { OperationError, type ApplyResult, type CallerRecord, type DiagnosticRecord, type OperationPreview, type Proposal, type ProposalStatus, type SemanticOperation } from './types.ts';

export interface GateContext {
  sessionId: string;
  workspaceId: string;
  operation: SemanticOperation;
  symbol: IndexedSymbol;
  staged: Project;
  touchedFiles: string[];
  newDiagnostics: DiagnosticRecord[];
}
/** Deterministic pre-apply checks (claims, agreement gate). Return human-readable rejection reasons. */
export type Gate = (context: GateContext) => string[];

export interface EngineOptions {
  store: Store;
  coordinator: Coordinator;
  graph: (workspaceId: string) => GraphIndex;
  sync: (workspaceId: string) => unknown;
  gates?: Gate[];
  clock?: () => number;
  /** Test hook invoked after each file write. Throwing an error named `SimulatedCrash` skips rollback to emulate a dead process. */
  onFileWritten?: (file: string, index: number) => void;
}

interface TouchedFile { path: string; before: string | null; after: string }
interface Staged {
  symbol: IndexedSymbol;
  staged: Project;
  touched: TouchedFile[];
  newDiagnostics: DiagnosticRecord[];
  callers: CallerRecord[];
  notes: string[];
  rejections: string[];
  sourceHashes: Record<string, string>;
}
type ProposalRow = { id: string; session_id: string; workspace_id: string; base_revision: number; source_hashes_json: string; operation_json: string; status: ProposalStatus; preview_json: string | null; result_json: string | null; created_at: number; updated_at: number };
type JournalEntry = { path: string; original: string | null };

function diagnosticsOf(project: Project, rel: (path: string) => string): { counts: Map<string, number>; records: DiagnosticRecord[] } {
  const counts = new Map<string, number>();
  const records: DiagnosticRecord[] = [];
  for (const diagnostic of project.getPreEmitDiagnostics()) {
    const text = diagnostic.getMessageText();
    const message = typeof text === 'string' ? text : text.getMessageText();
    const file = diagnostic.getSourceFile();
    const path = file ? rel(file.getFilePath()) : '<project>';
    const line = file && diagnostic.getStart() !== undefined ? file.getLineAndColumnAtPos(diagnostic.getStart()!).line : 0;
    const key = `${path}|${diagnostic.getCode()}|${message}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    records.push({ file: path, line, code: diagnostic.getCode(), message });
  }
  return { counts, records };
}

/**
 * Staged semantic operations. Preview never touches disk. Apply re-validates under a writer lock,
 * journals originals durably, writes files, reindexes and records evidence in one DB transaction,
 * and restores files + DB if anything fails. Journal recovery runs on construction.
 */
export class OperationEngine {
  private readonly store: Store;
  private readonly coordinator: Coordinator;
  private readonly graphFor: (workspaceId: string) => GraphIndex;
  private readonly sync: (workspaceId: string) => unknown;
  private readonly gates: Gate[];
  private readonly clock: () => number;
  private readonly onFileWritten: ((file: string, index: number) => void) | undefined;
  private busy = false;

  constructor(options: EngineOptions) {
    this.store = options.store;
    this.coordinator = options.coordinator;
    this.graphFor = options.graph;
    this.sync = options.sync;
    this.gates = options.gates ?? [];
    this.clock = options.clock ?? Date.now;
    this.onFileWritten = options.onFileWritten;
    this.recover();
  }

  // ---- staging --------------------------------------------------------------------------------
  private stage(sessionId: string, workspaceId: string, operation: SemanticOperation): Staged {
    if (operation.kind === 'rename_symbol' || operation.kind === 'add_endpoint')
      throw new OperationError('unsupported', `${operation.kind} is not implemented in this build; it is stretch work after the core demo.`);
    const graph = this.graphFor(workspaceId);
    const symbol = graph.resolve(operation.symbol);
    if (!symbol) throw new OperationError('unknown_symbol', `Unknown symbol "${operation.symbol}". Use hive_symbol to find the canonical key (file#name:kind).`);
    const staged = graph.openProject();
    const rel = (path: string) => graph.rel(path);
    const baseline = diagnosticsOf(staged, rel).counts;
    const outcome = render(staged, graph.root, symbol, operation);
    const post = diagnosticsOf(staged, rel);
    const seen = new Map<string, number>();
    const newDiagnostics = post.records.filter(record => {
      const key = `${record.file}|${record.code}|${record.message}`;
      const n = (seen.get(key) ?? 0) + 1; seen.set(key, n);
      return n > (baseline.get(key) ?? 0);
    });
    const touched: TouchedFile[] = staged.getSourceFiles().filter(file => !file.isSaved()).map(file => {
      const path = rel(file.getFilePath());
      const abs = file.getFilePath();
      return { path, before: existsSync(abs) ? readFileSync(abs, 'utf8') : null, after: file.getFullText() };
    });
    const dependents = graph.dependents(symbol.key);
    const brokenFiles = new Set(newDiagnostics.map(d => d.file));
    const callers: CallerRecord[] = dependents.map(edge => ({ from: edge.from, file: edge.file, line: edge.line,
      note: brokenFiles.has(edge.file) ? 'breaks under the staged change (see newDiagnostics); Hive will not guess a fix' : 'compiles under the staged change' }));
    const rejections: string[] = [];
    if (newDiagnostics.length) rejections.push(`Staged change introduces ${newDiagnostics.length} new diagnostic(s): ${newDiagnostics.slice(0, 5).map(d => `${d.file}:${d.line} TS${d.code} ${d.message}`).join(' | ')}`);
    const touchedFiles = touched.map(t => t.path);
    for (const gate of this.gates) rejections.push(...gate({ sessionId, workspaceId, operation, symbol, staged, touchedFiles, newDiagnostics }));
    const sourceHashes = graph.hashesFor([...new Set([symbol.file, ...touchedFiles, ...dependents.map(d => d.file)])]);
    return { symbol, staged, touched, newDiagnostics, callers, notes: outcome.notes, rejections, sourceHashes };
  }

  // ---- proposals ------------------------------------------------------------------------------
  private rowToProposal(row: ProposalRow): Proposal {
    return { id: row.id, sessionId: row.session_id, workspaceId: row.workspace_id, baseRevision: Number(row.base_revision),
      sourceHashes: JSON.parse(row.source_hashes_json) as Record<string, string>, operation: JSON.parse(row.operation_json) as SemanticOperation,
      status: row.status, preview: row.preview_json ? JSON.parse(row.preview_json) as OperationPreview : null,
      result: row.result_json ? JSON.parse(row.result_json) as ApplyResult : null, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
  }
  proposal(id: string): Proposal | undefined {
    const row = this.store.get<ProposalRow>('SELECT * FROM proposals WHERE id = ?', id);
    return row ? this.rowToProposal(row) : undefined;
  }
  proposals(limit = 50): Proposal[] {
    return this.store.all<ProposalRow>('SELECT * FROM proposals ORDER BY created_at DESC LIMIT ?', limit).map(row => this.rowToProposal(row)).reverse();
  }
  private setProposal(id: string, status: ProposalStatus, patch: { preview?: OperationPreview; result?: ApplyResult }): void {
    const sets = ['status = ?', 'updated_at = ?']; const params: (string | number)[] = [status, this.clock()];
    if (patch.preview) { sets.push('preview_json = ?'); params.push(JSON.stringify(patch.preview)); }
    if (patch.result) { sets.push('result_json = ?'); params.push(JSON.stringify(patch.result)); }
    this.store.run(`UPDATE proposals SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
  }

  preview(sessionId: string, operation: SemanticOperation): OperationPreview {
    const session = this.coordinator.heartbeat(sessionId);
    this.sync(session.workspaceId);
    const baseRevision = this.coordinator.revision();
    const id = randomUUID();
    const now = this.clock();
    const base: OperationPreview = { proposalId: id, sessionId, workspaceId: session.workspaceId, status: 'rejected', operation, symbol: null, baseRevision,
      sourceHashes: {}, affectedFiles: [], diff: '', newDiagnostics: [], callers: [], rejections: [], notes: [], createdAt: now };
    let preview: OperationPreview;
    try {
      const staged = this.stage(sessionId, session.workspaceId, operation);
      preview = { ...base, status: staged.rejections.length ? 'rejected' : 'previewed', symbol: staged.symbol.key, sourceHashes: staged.sourceHashes,
        affectedFiles: staged.touched.map(t => t.path), diff: staged.touched.map(t => unifiedDiff(t.before ?? '', t.after, t.path)).join('\n'),
        newDiagnostics: staged.newDiagnostics, callers: staged.callers, rejections: staged.rejections, notes: staged.notes };
    } catch (error) {
      if (!(error instanceof OperationError)) throw error;
      preview = { ...base, rejections: [`${error.code}: ${error.message}`] };
    }
    this.store.transaction(() => {
      this.store.run('INSERT INTO proposals(id, session_id, workspace_id, base_revision, source_hashes_json, operation_json, status, preview_json, result_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)',
        id, sessionId, session.workspaceId, baseRevision, JSON.stringify(preview.sourceHashes), JSON.stringify(operation), preview.status, JSON.stringify(preview), now, now);
      this.coordinator.emit(`proposal.${preview.status}`, `${operation.kind} on ${preview.symbol ?? ('symbol' in operation ? operation.symbol : operation.file)} by ${sessionId}${preview.rejections.length ? `: ${preview.rejections[0]}` : ''}`,
        { proposalId: id, sessionId, operation: operation.kind, symbol: preview.symbol, rejections: preview.rejections });
    });
    return preview;
  }

  // ---- apply -------------------------------------------------------------------------------------
  apply(sessionId: string, proposalId: string): ApplyResult {
    if (this.busy) throw new Error('Another operation is being applied; retry shortly');
    this.busy = true;
    try { return this.applyLocked(sessionId, proposalId); } finally { this.busy = false; }
  }

  private applyLocked(sessionId: string, proposalId: string): ApplyResult {
    const proposal = this.proposal(proposalId);
    if (!proposal) throw new Error('Unknown proposal');
    if (proposal.sessionId !== sessionId) throw new Error('Only the proposing session can apply a proposal');
    const fail = (status: ApplyResult['status'], reasons: string[]): ApplyResult => {
      const result: ApplyResult = { proposalId, status, revision: this.coordinator.revision(), changedFiles: [], sourceHashes: {}, reasons };
      this.store.transaction(() => {
        this.setProposal(proposalId, status, { result });
        this.coordinator.emit(`proposal.${status}`, `${proposal.operation.kind} ${proposalId}: ${reasons[0] ?? status}`, { proposalId, sessionId, reasons });
      });
      return result;
    };
    if (proposal.status !== 'previewed') return fail(proposal.status === 'applied' ? 'rejected' : proposal.status === 'stale' ? 'stale' : 'rejected', [`Proposal is ${proposal.status}; only previewed proposals can be applied`]);
    const session = this.coordinator.heartbeat(sessionId);
    this.sync(session.workspaceId);
    const graph = this.graphFor(session.workspaceId);
    const revision = this.coordinator.revision();
    if (revision !== proposal.baseRevision) return fail('stale', [`Repository revision changed from ${proposal.baseRevision} to ${revision} since the preview; preview again`]);
    const current = graph.hashesFor(Object.keys(proposal.sourceHashes));
    const drifted = Object.entries(proposal.sourceHashes).filter(([path, hash]) => current[path] !== hash).map(([path]) => path);
    if (drifted.length) return fail('stale', [`Source changed since the preview: ${drifted.join(', ')}; preview again`]);

    let staged: Staged;
    try { staged = this.stage(sessionId, session.workspaceId, proposal.operation); }
    catch (error) { if (error instanceof OperationError) return fail('rejected', [`${error.code}: ${error.message}`]); throw error; }
    if (staged.rejections.length) return fail('rejected', staged.rejections);

    const journalId = randomUUID();
    const entries: JournalEntry[] = staged.touched.map(t => ({ path: t.path, original: t.before }));
    this.store.transaction(() => {
      this.store.run("INSERT INTO journal(id, proposal_id, workspace_id, entries_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'writing', ?, ?)",
        journalId, proposalId, session.workspaceId, JSON.stringify(entries), this.clock(), this.clock());
    });
    try {
      staged.touched.forEach((file, index) => {
        const abs = graph.abs(file.path);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, file.after);
        this.onFileWritten?.(file.path, index);
      });
      return this.store.transaction(() => {
        graph.reindex();
        const newRevision = this.coordinator.bumpRevision(`applied ${proposal.operation.kind} on ${staged.symbol.key}`);
        const result: ApplyResult = { proposalId, status: 'applied', revision: newRevision, changedFiles: staged.touched.map(t => t.path),
          sourceHashes: graph.hashesFor(staged.touched.map(t => t.path)), reasons: [] };
        this.setProposal(proposalId, 'applied', { result });
        this.store.run("UPDATE journal SET status = 'committed', updated_at = ? WHERE id = ?", this.clock(), journalId);
        this.coordinator.emit('operation.applied', `${proposal.operation.kind} on ${staged.symbol.key} by ${sessionId}: ${result.changedFiles.join(', ')} (revision ${newRevision})`,
          { proposalId, sessionId, symbol: staged.symbol.key, changedFiles: result.changedFiles, revision: newRevision });
        return result;
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'SimulatedCrash') throw error; // test-only: emulate a dead daemon (journal stays 'writing')
      this.restore(graph, entries);
      graph.reindex();
      const message = error instanceof Error ? error.message : String(error);
      this.store.transaction(() => this.store.run("UPDATE journal SET status = 'rolled_back', updated_at = ? WHERE id = ?", this.clock(), journalId));
      return fail('failed', [`Apply failed and all files were restored from the journal: ${message}`]);
    }
  }

  private restore(graph: GraphIndex, entries: JournalEntry[]): void {
    for (const entry of entries) {
      const abs = graph.abs(entry.path);
      if (entry.original === null) { if (existsSync(abs)) unlinkSync(abs); }
      else { mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, entry.original); }
    }
  }

  /** Crash recovery: any journal still marked 'writing' means a previous process died mid-apply. */
  recover(): { recovered: string[] } {
    const rows = this.store.all<{ id: string; proposal_id: string; workspace_id: string; entries_json: string }>("SELECT id, proposal_id, workspace_id, entries_json FROM journal WHERE status = 'writing'");
    const recovered: string[] = [];
    for (const row of rows) {
      const graph = this.graphFor(row.workspace_id);
      this.restore(graph, JSON.parse(row.entries_json) as JournalEntry[]);
      this.store.transaction(() => {
        this.store.run("UPDATE journal SET status = 'recovered', updated_at = ? WHERE id = ?", this.clock(), row.id);
        const result: ApplyResult = { proposalId: row.proposal_id, status: 'failed', revision: this.coordinator.revision(), changedFiles: [], sourceHashes: {},
          reasons: ['Daemon stopped during apply; original files were restored from the journal on restart'] };
        this.setProposal(row.proposal_id, 'failed', { result });
        this.coordinator.emit('proposal.recovered', `journal ${row.id} restored files for proposal ${row.proposal_id} after restart`, { proposalId: row.proposal_id, journalId: row.id });
      });
      recovered.push(row.proposal_id);
    }
    return { recovered };
  }
}
