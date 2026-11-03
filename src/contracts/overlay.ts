import { Node, Project, SyntaxKind, type SourceFile } from 'ts-morph';
import { signatureOf, type GraphIndex, type IndexedSymbol } from '../graph/index.ts';
import type { DiagnosticRecord } from '../ops/types.ts';

export interface DeclarationCheck { ok: boolean; problems: string[]; name: string | null; kind: string | null; overlay: string }
export interface OverlayResult { ok: boolean; diagnostics: DiagnosticRecord[]; producerDiagnostics: DiagnosticRecord[]; checkedFiles: string[]; overlay: boolean; at: number }

const AMBIENT = new Set(['function', 'class', 'const', 'let', 'var', 'enum', 'abstract']);

/** Strips export/declare and returns the declaration in ambient `export declare` form. */
export function toOverlayText(declaration: string): string {
  const core = declaration.trim().replace(/^(?:(?:export|default|declare)\s+)+/, '').replace(/;?\s*$/, '');
  const keyword = core.split(/\s+/)[0] ?? '';
  return `${AMBIENT.has(keyword) ? 'export declare ' : 'export '}${core}${/[;}]$/.test(core) ? '' : ';'}`;
}

function topLevelDeclaration(file: SourceFile): Node | undefined {
  return file.getStatements().find(statement => Node.isFunctionDeclaration(statement) || Node.isInterfaceDeclaration(statement) || Node.isTypeAliasDeclaration(statement)
    || Node.isClassDeclaration(statement) || Node.isEnumDeclaration(statement) || Node.isVariableStatement(statement));
}
function declaredName(node: Node): string | null {
  if (Node.isVariableStatement(node)) return node.getDeclarations()[0]?.getName() ?? null;
  return Node.hasName(node) ? node.getName() : null;
}

/**
 * A Ghost Contract declaration must be a single, named, ambient TypeScript declaration that matches
 * the producer symbol's name, contains no implementation and does not use `any` to hide incompatibilities.
 */
export function validateDeclaration(declaration: string, producerSymbol: string | null): DeclarationCheck {
  const problems: string[] = [];
  const overlay = toOverlayText(declaration);
  const scratch = new Project({ useInMemoryFileSystem: true, compilerOptions: { strict: true } });
  const file = scratch.createSourceFile('contract.ts', overlay);
  const syntax = scratch.getProgram().compilerObject.getSyntacticDiagnostics(file.compilerNode);
  if (syntax.length) problems.push(`Declaration does not parse: ${String(syntax[0]!.messageText)}`);
  const statements = file.getStatements();
  if (statements.length !== 1) problems.push(`Declaration must be exactly one top-level declaration (found ${statements.length})`);
  const node = topLevelDeclaration(file);
  const name = node ? declaredName(node) : null;
  const kind = node ? node.getKindName() : null;
  if (!node || !name) problems.push('Declaration must be a named function, interface, type alias, class, enum or const declaration');
  if (node && Node.isFunctionDeclaration(node) && node.hasBody()) problems.push('Declaration must not contain an implementation body');
  if (node && Node.isClassDeclaration(node) && node.getMethods().some(m => m.hasBody())) problems.push('Class declaration must not contain method bodies');
  if (file.getDescendantsOfKind(SyntaxKind.AnyKeyword).length) problems.push('Declaration uses `any`, which would hide incompatibilities');
  if (producerSymbol && name) {
    const expected = producerSymbol.split('#')[1]?.split(':')[0]?.split('.').pop();
    if (expected && expected !== name) problems.push(`Declaration names ${name} but the producer symbol is ${expected}`);
  }
  return { ok: problems.length === 0, problems, name, kind, overlay };
}

/** Structural shape used to compare a contract declaration against the indexed implementation. */
export function shapeOf(node: Node): { kind: string; signature: string; members: string[] } {
  if (Node.isInterfaceDeclaration(node)) return { kind: 'interface', signature: `interface ${node.getName()}`, members: node.getMembers().map(signatureOf).sort() };
  if (Node.isClassDeclaration(node)) return { kind: 'class', signature: `class ${node.getName() ?? ''}`, members: node.getMembers().filter(m => !Node.isConstructorDeclaration(m)).map(signatureOf).sort() };
  if (Node.isTypeAliasDeclaration(node)) {
    const typeNode = node.getTypeNode();
    const members = typeNode && Node.isTypeLiteral(typeNode) ? typeNode.getMembers().map(signatureOf).sort() : [];
    return { kind: 'type', signature: members.length ? `type ${node.getName()}` : signatureOf(node), members };
  }
  if (Node.isVariableStatement(node)) { const declaration = node.getDeclarations()[0]!; return { kind: 'variable', signature: signatureOf(declaration), members: [] }; }
  return { kind: Node.isFunctionDeclaration(node) ? 'function' : node.getKindName(), signature: signatureOf(node), members: [] };
}

export function contractShape(declaration: string): { kind: string; signature: string; members: string[] } | null {
  const scratch = new Project({ useInMemoryFileSystem: true, compilerOptions: { strict: true } });
  const file = scratch.createSourceFile('contract.ts', toOverlayText(declaration));
  const node = topLevelDeclaration(file);
  return node ? shapeOf(node) : null;
}

/** Does the implemented symbol satisfy the contract? Functions must match exactly; types must contain every promised member. */
export function satisfies(contract: { kind: string; signature: string; members: string[] }, actual: IndexedSymbol): { ok: boolean; reason: string } {
  if (contract.kind === 'function' || contract.kind === 'variable') {
    const ok = (actual.meta.signature ?? '') === contract.signature;
    return { ok, reason: ok ? 'signature matches' : `expected ${contract.signature}, found ${actual.meta.signature ?? actual.kind}` };
  }
  if (contract.kind === 'interface' || contract.kind === 'class' || contract.kind === 'type') {
    const missing = contract.members.filter(member => !(actual.meta.members ?? []).some(name => member.startsWith(`${name}:`) || member.startsWith(`${name}?:`) || member.startsWith(`${name}(`)));
    return { ok: missing.length === 0, reason: missing.length ? `missing members: ${missing.join(', ')}` : 'all promised members present' };
  }
  return { ok: false, reason: `unsupported contract kind ${contract.kind}` };
}

function diagnosticsFor(project: Project, graph: GraphIndex, files: Set<string>): DiagnosticRecord[] {
  const out: DiagnosticRecord[] = [];
  for (const diagnostic of project.getPreEmitDiagnostics()) {
    const file = diagnostic.getSourceFile();
    if (!file) continue;
    const path = graph.rel(file.getFilePath());
    if (!files.has(path)) continue;
    const text = diagnostic.getMessageText();
    out.push({ file: path, line: diagnostic.getStart() !== undefined ? file.getLineAndColumnAtPos(diagnostic.getStart()!).line : 0, code: diagnostic.getCode(),
      message: typeof text === 'string' ? text : text.getMessageText() });
  }
  return out;
}

/**
 * Overlay check: in an isolated compiler project the producer file is rewritten so the contract's
 * declaration replaces any existing declaration with that name. Nothing is written to disk.
 * Consumers can type-check against the promise while the producer is still pending.
 */
export function overlayCheck(graph: GraphIndex, producerSymbol: string, declaration: string, consumerFiles: string[], clock: () => number = Date.now): OverlayResult {
  const producerFile = producerSymbol.split('#')[0]!;
  const name = producerSymbol.split('#')[1]?.split(':')[0]?.split('.')[0] ?? '';
  const project = graph.openProject();
  const abs = graph.abs(producerFile);
  const file = project.getSourceFile(abs) ?? project.createSourceFile(abs, '');
  for (const statement of [...file.getStatements()]) {
    if (Node.isVariableStatement(statement)) { if (statement.getDeclarations().some(d => d.getName() === name)) statement.remove(); continue; }
    if (Node.hasName(statement) && statement.getName() === name) statement.remove();
  }
  file.addStatements(toOverlayText(declaration));
  const consumers = new Set(consumerFiles.filter(path => path !== producerFile));
  const diagnostics = diagnosticsFor(project, graph, consumers);
  return { ok: diagnostics.length === 0, overlay: true, checkedFiles: [...consumers].sort(), at: clock(), diagnostics,
    producerDiagnostics: diagnosticsFor(project, graph, new Set([producerFile])) };
}

/** Real check: the same consumer files against the actual code, no overlay. */
export function realCheck(graph: GraphIndex, producerSymbol: string, consumerFiles: string[], clock: () => number = Date.now): OverlayResult {
  const producerFile = producerSymbol.split('#')[0]!;
  const project = graph.openProject();
  const consumers = new Set(consumerFiles);
  const diagnostics = diagnosticsFor(project, graph, consumers);
  return { ok: diagnostics.length === 0, overlay: false, checkedFiles: [...consumers].sort(), at: clock(), diagnostics,
    producerDiagnostics: diagnosticsFor(project, graph, new Set([producerFile])) };
}
