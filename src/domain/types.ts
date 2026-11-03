export interface Repository { id: string; canonicalRoot: string; revision: number }
export interface Workspace { id: string; repositoryId: string; realRoot: string; baseCommit: string | null }
export type SessionStatus = 'active' | 'finished' | 'expired';
export interface Session {
  id: string;
  name: string;
  workspaceId: string;
  client: string | null;
  expiresAt: number;
  status: SessionStatus;
}
export interface Assumption {
  // Canonical semantic identity, e.g. src/pricing.ts#getPrice:unit.
  key: string;
  value: string;
}
export interface IntentInput {
  task: string;
  files: string[];
  symbols: string[];
  assumptions: Assumption[];
}
export interface Intent extends IntentInput {
  sessionId: string;
  revision: number;
  at: number;
}
export type FindingKind =
  | 'assumption_mismatch'   // deterministic: same key, different value
  | 'symbol_overlap'        // informational
  | 'file_overlap'          // informational
  | 'dependent_write'       // compiler graph: one session writes a symbol another session's scope depends on
  | 'structural_incompatibility' // compiler diagnostics from a staged operation or overlay check
  | 'claim_violation'       // deterministic claim rule broken in current source
  | 'direct_edit';          // files changed outside Hive operations, detected after the fact
export interface Finding {
  kind: FindingKind;
  severity: 'error' | 'warning' | 'info';
  sessions: string[];
  evidence: string;
  source: 'deterministic' | 'compiler' | 'model';
  symbols?: string[];
  files?: string[];
}
export type ContractStatus = 'proposed' | 'accepted' | 'implemented' | 'verified' | 'stale' | 'rejected' | 'cancelled';
export interface ContractVersion { version: number; declaration: string; behaviorNotes: string; participants: string[]; at: number }
export interface Acknowledgement { sessionId: string; version: number; intentRevision: number; at: number }
export interface ImplementationEvidence { symbol: string; file: string; declarationHash: string; declaration: string; revision: number; at: number }
export interface VerificationRun {
  id: string;
  contractId: string;
  version: number;
  command: string;
  exitCode: number;
  passed: boolean;
  overlay: boolean;
  revision: number;
  sourceHashes: Record<string, string>;
  output: string;
  at: number;
}
export interface ContractEvidence {
  implemented?: ImplementationEvidence | null;
  verification?: VerificationRun | null;
  staleReason?: string;
  overlayCheck?: { ok: boolean; diagnostics: string[]; at: number } | null;
}
export interface Contract {
  id: string;
  version: number;
  title: string;
  ownerSessionId: string;
  producerSymbol: string | null;
  // Pending interface text validated as a declaration, NOT executable code or proof of correctness.
  declaration: string;
  behaviorNotes: string;
  participants: string[];
  acknowledgements: string[];
  acknowledgementDetails: Acknowledgement[];
  intentRevisions: Record<string, number>;
  status: ContractStatus;
  evidence: ContractEvidence;
  history: ContractVersion[];
  createdAt: number;
  updatedAt: number;
}
export interface Event {
  seq: number;
  at: number;
  type: string;
  detail: string;
  payload?: Record<string, unknown>;
}
export interface Snapshot {
  repository: Repository;
  workspaces: Workspace[];
  sessions: Session[];
  intents: Intent[];
  contracts: Contract[];
  findings: Finding[];
  events: Event[];
}
