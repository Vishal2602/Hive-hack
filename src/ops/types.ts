export type SemanticOperation =
  | { kind: 'rename_symbol'; symbol: string; newName: string }
  | { kind: 'add_field'; symbol: string; name: string; type: string; optional: boolean }
  | { kind: 'change_signature'; symbol: string; declaration: string }
  | { kind: 'add_endpoint'; file: string; method: string; route: string; responseType: string };

export type ProposalStatus = 'previewed' | 'rejected' | 'applied' | 'failed' | 'stale';

export interface DiagnosticRecord { file: string; line: number; code: number; message: string }
export interface CallerRecord { from: string; file: string; line: number; note: string }

export interface OperationPreview {
  proposalId: string;
  sessionId: string;
  workspaceId: string;
  status: ProposalStatus;
  operation: SemanticOperation;
  symbol: string | null;
  baseRevision: number;
  /** Hashes of every file the decision depended on (edited files and their dependents). */
  sourceHashes: Record<string, string>;
  affectedFiles: string[];
  diff: string;
  /** Diagnostics introduced by the staged change relative to the pre-change baseline. */
  newDiagnostics: DiagnosticRecord[];
  /** Compiler-resolved callers/dependents of the target symbol, with whether the staged change left them broken. */
  callers: CallerRecord[];
  /** Explicit reasons the proposal cannot be applied as-is. Empty means applicable. */
  rejections: string[];
  notes: string[];
  createdAt: number;
}

export interface ApplyResult {
  proposalId: string;
  status: 'applied' | 'rejected' | 'stale' | 'failed';
  revision: number;
  changedFiles: string[];
  sourceHashes: Record<string, string>;
  reasons: string[];
}

export interface Proposal {
  id: string;
  sessionId: string;
  workspaceId: string;
  baseRevision: number;
  sourceHashes: Record<string, string>;
  operation: SemanticOperation;
  status: ProposalStatus;
  preview: OperationPreview | null;
  result: ApplyResult | null;
  createdAt: number;
  updatedAt: number;
}

export class OperationError extends Error {
  readonly code: 'unsupported' | 'unknown_symbol' | 'invalid_input';
  constructor(code: OperationError['code'], message: string) { super(message); this.code = code; this.name = 'OperationError'; }
}
