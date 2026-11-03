import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { Node, Project, SyntaxKind, type SourceFile } from 'ts-morph';
import type { Store } from '../store/sqlite.ts';

export interface IndexedSymbol {
  id: string;
  key: string;          // repository-relative path + '#' + qualified name + ':' + kind
  name: string;
  file: string;         // repository-relative POSIX path
  kind: string;
  line: number;
  exported: boolean;
  declarationHash: string;
  meta: SymbolMeta;
}
export interface SymbolMeta {
  signature?: string;   // normalized declaration signature (no body)
  overloads?: number;   // number of overload signatures (functions/methods)
  members?: string[];   // interface/class/type members by name
  parent?: string;      // key of the containing declaration for members
}
export interface IndexedEdge { from: string; to: string; kind: 'reference' | 'import' | 'reexport'; file: string; line: number }
export interface FileChanges { changed: string[]; added: string[]; removed: string[] }
export interface ReindexResult extends FileChanges { symbols: number; edges: number; files: number }
export interface GraphOptions { store: Store; workspaceId: string; root: string; tsconfig?: string; clock?: () => number }

export function sha256(text: string | Buffer): string { return createHash('sha256').update(text).digest('hex'); }

/**
 * Compiler-backed symbol and dependency index. The TypeScript program is authoritative;
 * rows in `symbols`/`edges`/`files` are a derived, workspace-scoped cache keyed by logical key.
 * Row IDs survive reindexing because upserts match on (workspace, logical_key); callers that
 * move a declaration (rename) pass an explicit key mapping so the ID follows the symbol.
 */
export class GraphIndex {
  readonly root: string;
  readonly tsconfig: string | undefined;
  private readonly store: Store;
  private readonly workspaceId: string;
  private readonly clock: () => number;

  constructor(options: GraphOptions) {
    this.store = options.store;
    this.workspaceId = options.workspaceId;
    this.root = existsSync(resolve(options.root)) ? realpathSync(resolve(options.root)) : resolve(options.root);
    this.clock = options.clock ?? Date.now;
    const candidate = options.tsconfig ?? resolve(this.root, 'tsconfig.json');
    this.tsconfig = existsSync(candidate) ? candidate : undefined;
  }

  // ---- paths -----------------------------------------------------------------------------
  /** Repository-relative POSIX path. Resolves symlinks (e.g. macOS /var → /private/var) so callers may pass either form. */
  rel(path: string): string {
    const absolute = this.abs(path);
    const real = existsSync(absolute) ? realpathSync(absolute) : absolute;
    return relative(this.root, real).split(sep).join('/');
  }
  abs(path: string): string { return isAbsolute(path) ? path : resolve(this.root, path); }

  /** Fresh compiler project over the workspace. Never shares state with a staged project. */
  openProject(): Project {
    if (this.tsconfig) return new Project({ tsConfigFilePath: this.tsconfig, skipAddingFilesFromTsConfig: false });
    const project = new Project({ compilerOptions: { strict: true, target: 99, module: 199, moduleResolution: 99, noEmit: true, skipLibCheck: true } });
    project.addSourceFilesAtPaths([`${this.root}/**/*.ts`, `${this.root}/**/*.tsx`, `!${this.root}/**/node_modules/**`, `!${this.root}/**/*.d.ts`, `!${this.root}/.hive/**`]);
    return project;
  }
  /** Project source files that belong to the workspace (no node_modules, no declaration files). */
  sourceFiles(project: Project): SourceFile[] {
    return project.getSourceFiles().filter(file => {
      const path = file.getFilePath();
      return !file.isDeclarationFile() && !path.includes('/node_modules/') && !this.rel(path).startsWith('..') && !this.rel(path).startsWith('.hive/');
    });
  }

  // ---- file hashes ------------------------------------------------------------------------
  diskHashes(project = this.openProject()): Record<string, string> {
    const hashes: Record<string, string> = {};
    for (const file of this.sourceFiles(project)) hashes[this.rel(file.getFilePath())] = sha256(readFileSync(file.getFilePath()));
    return hashes;
  }
  storedHashes(): Record<string, string> {
    const hashes: Record<string, string> = {};
    for (const row of this.store.all<{ path: string; hash: string }>('SELECT path, hash FROM files WHERE workspace_id = ?', this.workspaceId)) hashes[row.path] = row.hash;
    return hashes;
  }
  hashesFor(files: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const file of files) { const path = this.abs(file); if (existsSync(path)) out[this.rel(path)] = sha256(readFileSync(path)); }
    return out;
  }
  /** Compares the index against disk without changing anything. */
  changes(project = this.openProject()): FileChanges {
    const disk = this.diskHashes(project);
    const stored = this.storedHashes();
    const changed = Object.keys(disk).filter(path => stored[path] !== undefined && stored[path] !== disk[path]);
    const added = Object.keys(disk).filter(path => stored[path] === undefined);
    const removed = Object.keys(stored).filter(path => disk[path] === undefined);
    return { changed, added, removed };
  }
  /** Cheap drift check: hashes only files already in the index (no compiler project). New files need `changes()`. */
  quickChanges(): FileChanges {
    const stored = this.storedHashes();
    const changed: string[] = []; const removed: string[] = [];
    for (const [path, hash] of Object.entries(stored)) {
      const abs = this.abs(path);
      if (!existsSync(abs)) removed.push(path);
      else if (sha256(readFileSync(abs)) !== hash) changed.push(path);
    }
    return { changed, added: [], removed };
  }
  isIndexed(): boolean { return Boolean(this.store.get('SELECT 1 AS one FROM files WHERE workspace_id = ? LIMIT 1', this.workspaceId)); }

  // ---- extraction ---------------------------------------------------------------------------
  extract(project = this.openProject()): { symbols: Omit<IndexedSymbol, 'id'>[]; edges: IndexedEdge[] } {
    const files = this.sourceFiles(project);
    const nodeKeys = new Map<Node, string>();
    const symbols = new Map<string, Omit<IndexedSymbol, 'id'> & { texts: string[] }>();
    const register = (node: Node, key: string, name: string, kind: string, exported: boolean, meta: SymbolMeta, file: string) => {
      nodeKeys.set(node, key);
      const text = node.getText();
      const existing = symbols.get(key);
      if (existing) {
        existing.texts.push(text);
        existing.meta.overloads = (existing.meta.overloads ?? 1) + 1;
        if (meta.signature && Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node)) {
          if (!(node as { hasBody?: () => boolean }).hasBody?.()) existing.meta.signature = `${existing.meta.signature ?? ''}${existing.meta.signature ? ' | ' : ''}${meta.signature}`;
        }
        return;
      }
      symbols.set(key, { key, name, file, kind, line: node.getStartLineNumber(), exported, declarationHash: '', meta, texts: [text] });
    };
    for (const file of files) {
      const rel = this.rel(file.getFilePath());
      const visitContainer = (statements: Node[], prefix: string, exportedParent: boolean) => {
        for (const statement of statements) this.visitStatement(statement, rel, prefix, exportedParent, register, visitContainer);
      };
      visitContainer(file.getStatements(), '', false);
    }
    // Edges: resolve every identifier to its declaration through aliases (imports, barrels, re-exports).
    const edges = new Map<string, IndexedEdge>();
    for (const file of files) {
      const rel = this.rel(file.getFilePath());
      for (const identifier of file.getDescendantsOfKind(SyntaxKind.Identifier)) {
        const parent = identifier.getParent();
        // Skip an indexed declaration's own name (property accesses and import specifiers are references).
        if (parent && nodeKeys.has(parent) && Node.hasName(parent) && parent.getNameNode() === identifier) continue;
        let symbol;
        try { symbol = identifier.getSymbol(); } catch { continue; }
        if (!symbol) continue;
        if (symbol.isAlias()) symbol = symbol.getAliasedSymbol() ?? symbol;
        const targets = new Set<string>();
        for (const declaration of symbol.getDeclarations()) {
          const key = nodeKeys.get(declaration);
          if (key) targets.add(key);
        }
        if (!targets.size) continue;
        const from = identifier.getAncestors().map(a => nodeKeys.get(a)).find((key): key is string => Boolean(key)) ?? rel;
        const inImport = Boolean(identifier.getFirstAncestorByKind(SyntaxKind.ImportDeclaration));
        const inExport = Boolean(identifier.getFirstAncestorByKind(SyntaxKind.ExportDeclaration));
        const kind: IndexedEdge['kind'] = inImport ? 'import' : inExport ? 'reexport' : 'reference';
        const line = identifier.getStartLineNumber();
        for (const to of targets) {
          if (to === from) continue; // recursion / self reference inside own declaration
          const edge: IndexedEdge = { from, to, kind, file: rel, line };
          edges.set(`${from}|${to}|${kind}|${rel}|${line}`, edge);
        }
      }
    }
    const out = [...symbols.values()].map(({ texts, ...symbol }) => ({ ...symbol, declarationHash: sha256(texts.join('\n')) }));
    return { symbols: out, edges: [...edges.values()] };
  }

  private visitStatement(
    statement: Node, rel: string, prefix: string, exportedParent: boolean,
    register: (node: Node, key: string, name: string, kind: string, exported: boolean, meta: SymbolMeta, file: string) => void,
    visitContainer: (statements: Node[], prefix: string, exportedParent: boolean) => void,
  ): void {
    const exported = exportedParent || (Node.isExportable(statement) && statement.isExported()) || (Node.isVariableStatement(statement) && statement.isExported());
    if (Node.isFunctionDeclaration(statement)) {
      const name = statement.getName(); if (!name) return;
      register(statement, `${rel}#${prefix}${name}:function`, name, 'function', exported, { signature: signatureOf(statement) }, rel);
    } else if (Node.isClassDeclaration(statement)) {
      const name = statement.getName(); if (!name) return;
      const key = `${rel}#${prefix}${name}:class`;
      register(statement, key, name, 'class', exported, { members: statement.getMembers().map(m => (Node.hasName(m) ? m.getName() : 'constructor')) }, rel);
      for (const member of statement.getMembers()) {
        const memberName = Node.hasName(member) ? member.getName() : 'constructor';
        const kind = Node.isMethodDeclaration(member) ? 'method' : Node.isPropertyDeclaration(member) ? 'property' : Node.isGetAccessorDeclaration(member) ? 'getter' : Node.isSetAccessorDeclaration(member) ? 'setter' : Node.isConstructorDeclaration(member) ? 'constructor' : 'member';
        register(member, `${rel}#${prefix}${name}.${memberName}:${kind}`, memberName, kind, exported, { signature: signatureOf(member), parent: key }, rel);
      }
    } else if (Node.isInterfaceDeclaration(statement)) {
      const name = statement.getName();
      const key = `${rel}#${prefix}${name}:interface`;
      register(statement, key, name, 'interface', exported, { members: statement.getMembers().map(m => (Node.hasName(m) ? m.getName() : m.getKindName())) }, rel);
      for (const member of statement.getMembers()) {
        if (!Node.hasName(member)) continue;
        const kind = Node.isMethodSignature(member) ? 'method' : 'property';
        register(member, `${rel}#${prefix}${name}.${member.getName()}:${kind}`, member.getName(), kind, exported, { signature: signatureOf(member), parent: key }, rel);
      }
    } else if (Node.isTypeAliasDeclaration(statement)) {
      const name = statement.getName();
      const literal = statement.getTypeNode();
      const members = literal && Node.isTypeLiteral(literal) ? literal.getMembers().map(m => (Node.hasName(m) ? m.getName() : m.getKindName())) : undefined;
      register(statement, `${rel}#${prefix}${name}:type`, name, 'type', exported, { signature: signatureOf(statement), ...(members ? { members } : {}) }, rel);
    } else if (Node.isEnumDeclaration(statement)) {
      const name = statement.getName();
      const key = `${rel}#${prefix}${name}:enum`;
      register(statement, key, name, 'enum', exported, { members: statement.getMembers().map(m => m.getName()) }, rel);
      for (const member of statement.getMembers()) register(member, `${rel}#${prefix}${name}.${member.getName()}:enum_member`, member.getName(), 'enum_member', exported, { parent: key }, rel);
    } else if (Node.isVariableStatement(statement)) {
      for (const declaration of statement.getDeclarations()) {
        const nameNode = declaration.getNameNode();
        if (!Node.isIdentifier(nameNode)) continue; // destructuring patterns are not addressable
        register(declaration, `${rel}#${prefix}${nameNode.getText()}:variable`, nameNode.getText(), 'variable', exported, { signature: signatureOf(declaration) }, rel);
      }
    } else if (Node.isModuleDeclaration(statement)) {
      const name = statement.getName();
      register(statement, `${rel}#${prefix}${name}:namespace`, name, 'namespace', exported, {}, rel);
      visitContainer(statement.getStatements(), `${prefix}${name}.`, exported);
    }
  }

  // ---- persistence --------------------------------------------------------------------------
  /**
   * Rebuilds the derived index from the compiler program. `keyMap` moves existing row IDs to new
   * logical keys first (e.g. after a rename), so identity survives the change.
   */
  reindex(options: { keyMap?: Record<string, string>; project?: Project } = {}): ReindexResult {
    const project = options.project ?? this.openProject();
    const changes = this.changes(project);
    const disk = this.diskHashes(project);
    const { symbols, edges } = this.extract(project);
    const now = this.clock();
    this.store.transaction(() => {
      for (const [from, to] of Object.entries(options.keyMap ?? {})) {
        this.store.run('DELETE FROM symbols WHERE workspace_id = ? AND logical_key = ?', this.workspaceId, to);
        this.store.run('UPDATE symbols SET logical_key = ? WHERE workspace_id = ? AND logical_key = ?', to, this.workspaceId, from);
      }
      const keep = new Set(symbols.map(s => s.key));
      for (const row of this.store.all<{ logical_key: string }>('SELECT logical_key FROM symbols WHERE workspace_id = ?', this.workspaceId)) {
        if (!keep.has(row.logical_key)) this.store.run('DELETE FROM symbols WHERE workspace_id = ? AND logical_key = ?', this.workspaceId, row.logical_key);
      }
      for (const symbol of symbols) {
        this.store.run(`INSERT INTO symbols(id, workspace_id, logical_key, file, name, kind, declaration_hash, exported, line, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id, logical_key) DO UPDATE SET file = excluded.file, name = excluded.name, kind = excluded.kind,
          declaration_hash = excluded.declaration_hash, exported = excluded.exported, line = excluded.line, meta_json = excluded.meta_json`,
          randomUUID(), this.workspaceId, symbol.key, symbol.file, symbol.name, symbol.kind, symbol.declarationHash, symbol.exported ? 1 : 0, symbol.line, JSON.stringify(symbol.meta));
      }
      this.store.run('DELETE FROM edges WHERE workspace_id = ?', this.workspaceId);
      for (const edge of edges) {
        this.store.run('INSERT OR IGNORE INTO edges(workspace_id, from_symbol, to_symbol, kind, file, line) VALUES (?, ?, ?, ?, ?, ?)', this.workspaceId, edge.from, edge.to, edge.kind, edge.file, edge.line);
      }
      this.store.run('DELETE FROM files WHERE workspace_id = ?', this.workspaceId);
      for (const [path, hash] of Object.entries(disk)) this.store.run('INSERT INTO files(workspace_id, path, hash, indexed_at) VALUES (?, ?, ?, ?)', this.workspaceId, path, hash, now);
    });
    return { ...changes, symbols: symbols.length, edges: edges.length, files: Object.keys(disk).length };
  }

  // ---- queries -------------------------------------------------------------------------------
  private rowToSymbol(row: { id: string; logical_key: string; file: string; name: string; kind: string; declaration_hash: string; exported: number; line: number; meta_json: string }): IndexedSymbol {
    return { id: row.id, key: row.logical_key, file: row.file, name: row.name, kind: row.kind, declarationHash: row.declaration_hash, exported: Boolean(row.exported), line: Number(row.line), meta: JSON.parse(row.meta_json) as SymbolMeta };
  }
  symbols(): IndexedSymbol[] {
    return this.store.all<Parameters<GraphIndex['rowToSymbol']>[0]>('SELECT * FROM symbols WHERE workspace_id = ? ORDER BY file, line', this.workspaceId).map(row => this.rowToSymbol(row));
  }
  symbol(key: string): IndexedSymbol | undefined {
    const row = this.store.get<Parameters<GraphIndex['rowToSymbol']>[0]>('SELECT * FROM symbols WHERE workspace_id = ? AND logical_key = ?', this.workspaceId, key);
    return row ? this.rowToSymbol(row) : undefined;
  }
  symbolsInFile(file: string): IndexedSymbol[] {
    return this.store.all<Parameters<GraphIndex['rowToSymbol']>[0]>('SELECT * FROM symbols WHERE workspace_id = ? AND file = ? ORDER BY line', this.workspaceId, file).map(row => this.rowToSymbol(row));
  }
  /** Accepts `file#name:kind`, `file#name` (unique match required) or `name` (unique match required). */
  resolve(reference: string): IndexedSymbol | undefined {
    const exact = this.symbol(reference);
    if (exact) return exact;
    const candidates = reference.includes('#')
      ? this.store.all<Parameters<GraphIndex['rowToSymbol']>[0]>('SELECT * FROM symbols WHERE workspace_id = ? AND logical_key LIKE ?', this.workspaceId, `${reference.replace(/[%_]/g, '\\$&')}:%`)
      : this.store.all<Parameters<GraphIndex['rowToSymbol']>[0]>('SELECT * FROM symbols WHERE workspace_id = ? AND name = ? AND exported = 1', this.workspaceId, reference);
    return candidates.length === 1 ? this.rowToSymbol(candidates[0]!) : undefined;
  }
  /** Direct dependents: edges that point at the symbol. `from` may be a symbol key or a file path. */
  dependents(key: string): IndexedEdge[] {
    return this.store.all<{ from_symbol: string; to_symbol: string; kind: IndexedEdge['kind']; file: string; line: number }>(
      'SELECT from_symbol, to_symbol, kind, file, line FROM edges WHERE workspace_id = ? AND to_symbol = ? ORDER BY file, line', this.workspaceId, key)
      .map(row => ({ from: row.from_symbol, to: row.to_symbol, kind: row.kind, file: row.file, line: Number(row.line) }));
  }
  /** Symbols referenced from inside a file (what the file depends on). */
  dependencies(file: string): IndexedEdge[] {
    return this.store.all<{ from_symbol: string; to_symbol: string; kind: IndexedEdge['kind']; file: string; line: number }>(
      'SELECT from_symbol, to_symbol, kind, file, line FROM edges WHERE workspace_id = ? AND file = ? ORDER BY line', this.workspaceId, file)
      .map(row => ({ from: row.from_symbol, to: row.to_symbol, kind: row.kind, file: row.file, line: Number(row.line) }));
  }
  /** Files that transitively depend on a symbol (bounded depth). */
  dependentFiles(key: string, depth = 3): string[] {
    const seen = new Set<string>(); const files = new Set<string>(); let frontier = [key];
    for (let level = 0; level < depth && frontier.length; level++) {
      const next: string[] = [];
      for (const current of frontier) {
        for (const edge of this.dependents(current)) {
          files.add(edge.file);
          if (!seen.has(edge.from) && edge.from.includes('#')) { seen.add(edge.from); next.push(edge.from); }
        }
      }
      frontier = next;
    }
    return [...files].sort();
  }
}

/** Declaration signature without body, normalized whitespace. Used for implementation evidence. */
export function signatureOf(node: Node): string {
  const text = (() => {
    if (Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node) || Node.isMethodSignature(node) || Node.isConstructorDeclaration(node)
      || Node.isGetAccessorDeclaration(node) || Node.isSetAccessorDeclaration(node)) {
      const name = Node.hasName(node) ? node.getName() : 'constructor';
      const params = node.getParameters().map(p => p.getText()).join(', ');
      const returnType = Node.isConstructorDeclaration(node) || Node.isSetAccessorDeclaration(node) ? '' : `: ${node.getReturnTypeNode()?.getText() ?? node.getReturnType().getText(node)}`;
      return `${name}(${params})${returnType}`;
    }
    if (Node.isPropertyDeclaration(node) || Node.isPropertySignature(node)) {
      return `${node.getName()}${node.hasQuestionToken() ? '?' : ''}: ${node.getTypeNode()?.getText() ?? node.getType().getText(node)}`;
    }
    if (Node.isVariableDeclaration(node)) return `${node.getName()}: ${node.getTypeNode()?.getText() ?? node.getType().getText(node)}`;
    if (Node.isTypeAliasDeclaration(node)) return `type ${node.getName()} = ${node.getTypeNode()?.getText() ?? ''}`;
    return node.getText().split('{')[0] ?? '';
  })();
  return text.replace(/\s+/g, ' ').trim();
}
