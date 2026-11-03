import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import type { Project } from 'ts-morph';
import type { Coordinator } from '../domain/coordinator.ts';
import type { Finding } from '../domain/types.ts';
import type { EvidenceChange } from '../intelligence/types.ts';
import { unifiedDiff } from '../ops/diff.ts';
import { sha256, type GraphIndex } from '../graph/index.ts';
import type { Store } from '../store/sqlite.ts';
import { MAX_FILE_BYTES, checkPath } from './paths.ts';

export { checkPath } from './paths.ts';

/**
 * Laptop sync. Each member's client hook pushes the TypeScript files they changed relative to the hub's
 * base commit. Hive keeps them in SQLite (never in the hub checkout) and type-checks the hub's base code
 * plus everyone's changes in an in-memory compiler project, so one member's edit can be checked against
 * another member's real, uncommitted work. Only type errors are found this way; a unit mismatch with
 * identical types still needs tests or the model analysis.
 */

export interface PushedFile { path: string; content: string | null }
export interface RemoteDiagnostic { file: string; line: number; code: number; message: string; owners: string[] }
export interface RemoteCheck {
  member: string;
  /** Type errors the change adds, compared with the same code without it. */
  newDiagnostics: RemoteDiagnostic[];
  /** Members whose own changed files get new errors (the change would break their work). */
  breaks: string[];
  baseCommit: string | null;
  warnings: string[];
  checkedFiles: number;
}
export interface RemoteMemberState { member: string; baseCommit: string | null; files: { path: string; deleted: boolean; updatedAt: number }[] }
export interface RemoteState { baseCommit: string | null; members: RemoteMemberState[] }

type Row = { member: string; path: string; content: string | null; hash: string; base_commit: string | null; updated_at: number };

function diagnosticKey(d: { file: string; code: number; message: string }): string { return `${d.file}|${d.code}|${d.message}`; }

export class RemoteChanges {
  private readonly store: Store;
  private readonly coordinator: Coordinator;
  private readonly graph: () => GraphIndex;
  private readonly clock: () => number;
  private version = 0;
  private findingsCache: { key: string; findings: Finding[] } | null = null;
  private baseCache: { at: number; commit: string | null } | null = null;

  constructor(options: { store: Store; coordinator: Coordinator; graph: () => GraphIndex; clock?: () => number }) {
    this.store = options.store;
    this.coordinator = options.coordinator;
    this.graph = options.graph;
    this.clock = options.clock ?? Date.now;
  }

  /** The hub checkout's HEAD commit (cached for 30 s). Laptops diff against this. */
  baseCommit(): string | null {
    const now = this.clock();
    if (this.baseCache && now - this.baseCache.at < 30_000) return this.baseCache.commit;
    const result = spawnSync('git', ['-C', this.coordinator.root, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 });
    const commit = result.status === 0 ? result.stdout.trim() : null;
    this.baseCache = { at: now, commit };
    return commit;
  }

  private rows(member?: string): Row[] {
    return member === undefined
      ? this.store.all<Row>('SELECT member, path, content, hash, base_commit, updated_at FROM remote_files WHERE repository_id = ? ORDER BY member, path', this.coordinator.repositoryId)
      : this.store.all<Row>('SELECT member, path, content, hash, base_commit, updated_at FROM remote_files WHERE repository_id = ? AND member = ? ORDER BY path', this.coordinator.repositoryId, member);
  }

  /** Base file content in the hub checkout, or null when the file does not exist there. */
  private baseContent(path: string): string | null {
    const abs = this.graph().abs(path);
    return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
  }

  /**
   * Records a member's changed files. A file identical to the hub's base is dropped (no longer a change).
   * With `replace`, files of this member not in the list are dropped too (a full sync from the laptop).
   */
  push(member: string, input: { files: PushedFile[]; baseCommit?: string | null; replace?: boolean }): { stored: string[]; cleared: string[]; rejected: string[]; baseCommit: string | null; warnings: string[] } {
    const rejected: string[] = [];
    const accepted: PushedFile[] = [];
    for (const file of input.files) {
      const problem = checkPath(file.path);
      if (problem) { rejected.push(problem); continue; }
      if (file.content !== null && Buffer.byteLength(file.content) > MAX_FILE_BYTES) { rejected.push(`${file.path}: larger than ${MAX_FILE_BYTES} bytes`); continue; }
      accepted.push(file);
    }
    const now = this.clock();
    const stored: string[] = []; const cleared: string[] = [];
    this.store.transaction(() => {
      const keep = new Set(accepted.map(f => f.path));
      if (input.replace) {
        for (const row of this.rows(member)) {
          if (keep.has(row.path)) continue;
          this.store.run('DELETE FROM remote_files WHERE repository_id = ? AND member = ? AND path = ?', this.coordinator.repositoryId, member, row.path);
          cleared.push(row.path);
        }
      }
      for (const file of accepted) {
        if (file.content === this.baseContent(file.path)) {
          const result = this.store.run('DELETE FROM remote_files WHERE repository_id = ? AND member = ? AND path = ?', this.coordinator.repositoryId, member, file.path);
          if (Number(result.changes)) cleared.push(file.path);
          continue;
        }
        this.store.run(`INSERT INTO remote_files(repository_id, member, path, content, hash, base_commit, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(repository_id, member, path) DO UPDATE SET content = excluded.content, hash = excluded.hash, base_commit = excluded.base_commit, updated_at = excluded.updated_at`,
          this.coordinator.repositoryId, member, file.path, file.content, sha256(file.content ?? ''), input.baseCommit ?? null, now);
        stored.push(file.path);
      }
    });
    if (stored.length || cleared.length) {
      this.version++;
      this.coordinator.emit('remote.pushed', `${member} synced ${[...stored, ...cleared.map(p => `${p} (back to base)`)].join(', ')}`, { member, stored, cleared });
    }
    return { stored, cleared, rejected, baseCommit: this.baseCommit(), warnings: this.baseWarnings(input.baseCommit ?? null) };
  }

  private baseWarnings(laptopBase: string | null): string[] {
    const hub = this.baseCommit();
    if (!laptopBase || !hub || laptopBase === hub) return [];
    return [`Your checkout is based on ${laptopBase.slice(0, 8)} but Hive's shared copy is at ${hub.slice(0, 8)}; results may include differences that are already committed.`];
  }

  state(): RemoteState {
    const members = new Map<string, RemoteMemberState>();
    for (const row of this.rows()) {
      let entry = members.get(row.member);
      if (!entry) { entry = { member: row.member, baseCommit: row.base_commit, files: [] }; members.set(row.member, entry); }
      entry.files.push({ path: row.path, deleted: row.content === null, updatedAt: Number(row.updated_at) });
    }
    return { baseCommit: this.baseCommit(), members: [...members.values()] };
  }

  /** Bounded diffs of every member's changes for the model analysis (most recent first). */
  evidence(maxFiles = 12, maxChars = 4000): EvidenceChange[] {
    const sessions = this.coordinator.sessions();
    return this.rows().sort((a, b) => Number(b.updated_at) - Number(a.updated_at)).slice(0, maxFiles).map(row => {
      const diff = unifiedDiff(this.baseContent(row.path) ?? '', row.content ?? '', row.path);
      return { member: row.member, file: row.path, sessionIds: sessions.filter(s => (s.member ?? 'operator') === row.member).map(s => s.id),
        diff: diff.length > maxChars ? `${diff.slice(0, maxChars)}\n@@ diff truncated @@\n` : diff };
    });
  }

  /** Who has changed each file (member names). */
  private owners(rows: Row[]): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const row of rows) out.set(row.path, [...(out.get(row.path) ?? []), row.member]);
    return out;
  }

  /** Applies member files to an in-memory project. Later layers win for the same path. */
  private apply(project: Project, files: { path: string; content: string | null }[]): void {
    const graph = this.graph();
    for (const file of files) {
      const abs = graph.abs(file.path);
      if (file.content === null) { const existing = project.getSourceFile(abs); if (existing) project.removeSourceFile(existing); }
      else project.createSourceFile(abs, file.content, { overwrite: true });
    }
  }

  private diagnostics(project: Project): { file: string; line: number; code: number; message: string }[] {
    const graph = this.graph();
    const out: { file: string; line: number; code: number; message: string }[] = [];
    for (const diagnostic of project.getPreEmitDiagnostics()) {
      const file = diagnostic.getSourceFile();
      if (!file) continue;
      const path = graph.rel(file.getFilePath());
      if (path.startsWith('..') || path.includes('node_modules/')) continue;
      const text = diagnostic.getMessageText();
      out.push({ file: path, code: diagnostic.getCode(), message: typeof text === 'string' ? text : text.getMessageText(),
        line: diagnostic.getStart() !== undefined ? file.getLineAndColumnAtPos(diagnostic.getStart()!).line : 0 });
    }
    return out;
  }

  /**
   * Type errors added by `change` on top of everyone's current state. Baseline: hub base + other members'
   * files + this member's other files. After: the same plus `change`. Without `change`, the member's
   * whole pushed state is the change (baseline = base + others).
   */
  check(member: string, change?: PushedFile, laptopBase: string | null = null): RemoteCheck {
    if (change) { const problem = checkPath(change.path); if (problem) throw new Error(problem); }
    const rows = this.rows();
    const others = rows.filter(r => r.member !== member);
    const mine = rows.filter(r => r.member === member && (!change || r.path !== change.path));
    const graph = this.graph();
    const before = graph.openProject();
    this.apply(before, change ? [...others, ...mine] : others);
    const after = graph.openProject();
    this.apply(after, [...others, ...mine, ...(change ? [change] : [])]);
    const baseline = new Map<string, number>();
    for (const d of this.diagnostics(before)) baseline.set(diagnosticKey(d), (baseline.get(diagnosticKey(d)) ?? 0) + 1);
    const owners = this.owners(others);
    const newDiagnostics: RemoteDiagnostic[] = [];
    for (const d of this.diagnostics(after)) {
      const key = diagnosticKey(d);
      const left = baseline.get(key) ?? 0;
      if (left > 0) { baseline.set(key, left - 1); continue; }
      newDiagnostics.push({ ...d, owners: owners.get(d.file) ?? [] });
    }
    const breaks = [...new Set(newDiagnostics.flatMap(d => d.owners))].sort();
    return { member, newDiagnostics: newDiagnostics.slice(0, 50), breaks, baseCommit: this.baseCommit(), warnings: this.baseWarnings(laptopBase),
      checkedFiles: after.getSourceFiles().length };
  }

  /**
   * Compiler findings for the dashboard and agents: for each member with pushed changes, errors their changes
   * add in files they did not change (shared code or other members' work). Cached until a push or a new revision.
   */
  findings(): Finding[] {
    const key = `${this.version}|${this.coordinator.revision()}`;
    if (this.findingsCache?.key === key) return this.findingsCache.findings;
    const findings: Finding[] = [];
    const members = [...new Set(this.rows().map(r => r.member))];
    const sessions = this.coordinator.sessions();
    const sessionsOf = (name: string) => sessions.filter(s => (s.member ?? 'operator') === name).map(s => s.id);
    for (const member of members) {
      let result: RemoteCheck;
      try { result = this.check(member); } catch (error) { console.error('Hive: remote check failed:', error instanceof Error ? error.message : error); continue; }
      const ownFiles = new Set(this.rows(member).map(r => r.path));
      const foreign = result.newDiagnostics.filter(d => !ownFiles.has(d.file));
      if (!foreign.length) continue;
      const affected = [...new Set(foreign.flatMap(d => d.owners))];
      const where = foreign.slice(0, 3).map(d => `${d.file}:${d.line} TS${d.code} ${d.message}${d.owners.length ? ` (${d.owners.join(', ')} is changing this file)` : ''}`).join('; ');
      findings.push({ kind: 'structural_incompatibility', severity: affected.length ? 'error' : 'warning', source: 'compiler',
        sessions: [...sessionsOf(member), ...affected.flatMap(sessionsOf)],
        files: [...new Set(foreign.map(d => d.file))],
        evidence: `${member}'s uncommitted changes break ${affected.length ? `${affected.join(', ')}'s work` : 'shared code'}: ${where}` });
    }
    this.findingsCache = { key, findings };
    return findings;
  }
}
