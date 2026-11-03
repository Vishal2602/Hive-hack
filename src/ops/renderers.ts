import { Node, Project, SyntaxKind, type CallExpression, type FunctionDeclaration, type MethodDeclaration, type ParameterDeclarationStructure, type SourceFile, StructureKind } from 'ts-morph';
import type { IndexedSymbol } from '../graph/index.ts';
import { OperationError, type SemanticOperation } from './types.ts';

export interface RenderOutcome { notes: string[]; touched: SourceFile[] }

const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function memberNamed(container: Node, name: string): Node | undefined {
  const members = (container as unknown as { getMembers(): Node[] }).getMembers();
  return members.find(member => Node.hasName(member) && member.getName() === name);
}

/** Locates the declaration node for an indexed symbol inside a (staged) project. */
export function locate(project: Project, root: string, symbol: IndexedSymbol): Node {
  const file = project.getSourceFile(`${root}/${symbol.file}`);
  if (!file) throw new OperationError('unknown_symbol', `File ${symbol.file} is not part of the compiler project`);
  const [, qualified] = symbol.key.split('#');
  const name = (qualified ?? '').split(':')[0] ?? '';
  const [owner, member] = name.split('.');
  if (member && owner) {
    const container = file.getClass(owner) ?? file.getInterface(owner) ?? file.getEnum(owner);
    if (!container) throw new OperationError('unknown_symbol', `Container ${owner} not found in ${symbol.file}`);
    const found = memberNamed(container, member);
    if (!found) throw new OperationError('unknown_symbol', `Member ${member} not found on ${owner}`);
    return found;
  }
  const found = file.getFunction(owner ?? '') ?? file.getClass(owner ?? '') ?? file.getInterface(owner ?? '') ?? file.getTypeAlias(owner ?? '') ?? file.getEnum(owner ?? '') ?? file.getVariableDeclaration(owner ?? '');
  if (!found) throw new OperationError('unknown_symbol', `Declaration ${name} not found in ${symbol.file}`);
  return found;
}

export function render(project: Project, root: string, symbol: IndexedSymbol, operation: SemanticOperation): RenderOutcome {
  switch (operation.kind) {
    case 'add_field': return addField(project, root, symbol, operation);
    case 'change_signature': return changeSignature(project, root, symbol, operation);
    case 'rename_symbol': throw new OperationError('unsupported', 'rename_symbol is not implemented in this build; it is listed as stretch work after the core demo.');
    case 'add_endpoint': throw new OperationError('unsupported', 'add_endpoint is not implemented in this build; it is listed as stretch work after the core demo.');
  }
}

/** add_field: interface, class, or type alias whose type is an object literal (or an intersection containing one). */
function addField(project: Project, root: string, symbol: IndexedSymbol, op: Extract<SemanticOperation, { kind: 'add_field' }>): RenderOutcome {
  if (!identifier.test(op.name)) throw new OperationError('invalid_input', `"${op.name}" is not a valid property name`);
  if (!op.type.trim()) throw new OperationError('invalid_input', 'type must not be empty');
  const node = locate(project, root, symbol);
  const structure = { name: op.name, type: op.type, hasQuestionToken: op.optional };
  const notes: string[] = [];
  if (Node.isInterfaceDeclaration(node)) {
    if (memberNamed(node, op.name)) throw new OperationError('invalid_input', `${node.getName()} already has a member named ${op.name}`);
    node.addProperty(structure);
  } else if (Node.isClassDeclaration(node)) {
    if (node.getMember(op.name)) throw new OperationError('invalid_input', `${node.getName()} already has a member named ${op.name}`);
    node.addProperty(structure);
    if (!op.optional) notes.push('Required class property added without an initializer; strictPropertyInitialization may require constructor changes (reported as diagnostics).');
  } else if (Node.isTypeAliasDeclaration(node)) {
    const typeNode = node.getTypeNode();
    const literal = typeNode && Node.isTypeLiteral(typeNode) ? typeNode
      : typeNode && Node.isIntersectionTypeNode(typeNode) ? typeNode.getTypeNodes().find(Node.isTypeLiteral) : undefined;
    if (!literal) throw new OperationError('unsupported', `add_field supports type aliases of object-literal (or intersection containing one) types only; ${node.getName()} is ${typeNode?.getKindName() ?? 'unknown'}`);
    if (memberNamed(literal, op.name)) throw new OperationError('invalid_input', `${node.getName()} already has a member named ${op.name}`);
    literal.addProperty(structure);
  } else {
    throw new OperationError('unsupported', `add_field supports interface, class and object type alias declarations; ${symbol.key} is ${symbol.kind}`);
  }
  if (!op.optional) notes.push(`Required member ${op.name}: ${op.type} added. Existing object literals and implementations that omit it will be reported as new diagnostics; Hive never invents values for them.`);
  return { notes, touched: [node.getSourceFile()] };
}

interface ParsedSignature { name: string; parameters: ParameterDeclarationStructure[]; returnType: string | undefined }

/**
 * Parses a declaration such as `export function getPrice(unit: 'cents'): number;`,
 * `getPrice(unit: 'cents'): number` or a class method header. Bodies are ignored; only syntax is validated here.
 */
export function parseSignature(declaration: string): ParsedSignature {
  const core = declaration.trim()
    .replace(/^(?:(?:export|default|declare|async|public|private|protected|static|abstract|override|readonly)\s+)*(?:function\s+)?/, '')
    .replace(/;\s*$/, '');
  const scratch = new Project({ useInMemoryFileSystem: true, compilerOptions: { strict: true } });
  const file = scratch.createSourceFile('scratch.ts', `function ${core}`);
  const syntax = scratch.getProgram().compilerObject.getSyntacticDiagnostics(file.compilerNode);
  // getFunctions() hides bodiless declarations (overload signatures), so look at statements directly.
  const fn = file.getStatements().find(Node.isFunctionDeclaration);
  if (syntax.length || !fn || !fn.getName())
    throw new OperationError('invalid_input', `Could not parse declaration as a function or method signature: ${declaration}${syntax[0] ? ` (${String(syntax[0].messageText)})` : ''}`);
  const parameters = fn.getParameters().map((p): ParameterDeclarationStructure => ({
    kind: StructureKind.Parameter, name: p.getName(), type: p.getTypeNode()?.getText(), hasQuestionToken: p.hasQuestionToken(),
    initializer: p.getInitializer()?.getText(), isRestParameter: p.isRestParameter(),
  }));
  return { name: fn.getName()!, parameters, returnType: fn.getReturnTypeNode()?.getText() };
}

/** change_signature: replaces the parameter list / return type of a non-overloaded function or method. */
function changeSignature(project: Project, root: string, symbol: IndexedSymbol, op: Extract<SemanticOperation, { kind: 'change_signature' }>): RenderOutcome {
  const node = locate(project, root, symbol);
  if (!Node.isFunctionDeclaration(node) && !Node.isMethodDeclaration(node))
    throw new OperationError('unsupported', `change_signature supports function declarations and class methods; ${symbol.key} is ${symbol.kind}`);
  const target: FunctionDeclaration | MethodDeclaration = node;
  if (target.getOverloads().length > 0 || !target.isImplementation())
    throw new OperationError('unsupported', `${symbol.key} has overload signatures; change_signature does not rewrite overload sets. Edit the overloads directly, then reindex.`);
  const parsed = parseSignature(op.declaration);
  if (parsed.name !== target.getName()) throw new OperationError('invalid_input', `Declaration names ${parsed.name} but the target is ${target.getName()}; renaming is a separate operation`);
  const oldNames = target.getParameters().map(p => p.getName());
  const newNames = parsed.parameters.map(p => p.name);
  const removedIndices = oldNames.map((name, index) => (newNames.includes(name) ? -1 : index)).filter(index => index >= 0).sort((x, y) => y - x);
  const addedRequired = parsed.parameters.filter(p => !oldNames.includes(p.name) && !p.hasQuestionToken && !p.initializer && !p.isRestParameter).map(p => p.name);
  const callSites = collectCallSites(target);
  for (const parameter of [...target.getParameters()].reverse()) parameter.remove();
  target.addParameters(parsed.parameters);
  if (parsed.returnType) target.setReturnType(parsed.returnType);
  const touched = new Set<SourceFile>([target.getSourceFile()]);
  let argumentsRemoved = 0;
  for (const call of callSites) {
    for (const index of removedIndices) {
      if (index < call.getArguments().length) { call.removeArgument(index); argumentsRemoved++; touched.add(call.getSourceFile()); }
    }
  }
  const notes = [`Signature set to ${target.getName()}(${parsed.parameters.map(p => `${p.name}${p.hasQuestionToken ? '?' : ''}${p.type ? `: ${p.type}` : ''}`).join(', ')})${parsed.returnType ? `: ${parsed.returnType}` : ''}.`];
  if (argumentsRemoved) notes.push(`Removed ${argumentsRemoved} argument(s) for dropped parameters at ${callSites.length} call site(s).`);
  if (addedRequired.length) notes.push(`New required parameter(s) ${addedRequired.join(', ')}: Hive does not invent arguments. Call sites that do not already pass them are reported as new diagnostics.`);
  return { notes, touched: [...touched] };
}

function collectCallSites(target: FunctionDeclaration | MethodDeclaration): CallExpression[] {
  const calls: CallExpression[] = [];
  for (const reference of target.findReferencesAsNodes()) {
    const parent = reference.getParent();
    if (parent && Node.isCallExpression(parent) && parent.getExpression() === reference) calls.push(parent);
    else if (parent && Node.isPropertyAccessExpression(parent) && parent.getNameNode() === reference) {
      const call = parent.getParent();
      if (call && Node.isCallExpression(call) && call.getExpression() === parent) calls.push(call);
    }
  }
  return calls;
}

export function isModified(file: SourceFile): boolean { return !file.isSaved(); }
export { SyntaxKind };
