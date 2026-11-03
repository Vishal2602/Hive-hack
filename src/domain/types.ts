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
  /** Member name of the token that registered the session ('operator' for HIVE_TOKEN); null for legacy rows. */
  member?: string | null;
  /** Token row id that registered the session; null for the operator token and legacy rows. */
  tokenId?: string | null;
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
/**
 * running: child process in flight. passed: exit 0 + real type-check + implementation evidence, files unchanged.
 * failed: the command or a check failed (including timeout). inconclusive: checked files or the contract changed
 * while the command ran, so the result proves nothing. error: the command could not be run at all.
 */
export type VerificationStatus = 'running' | 'passed' | 'failed' | 'inconclusive' | 'error';
export interface VerificationRun {
  id: string;
  contractId: string;
  version: number;
  command: string;
  status: VerificationStatus;
  /** null while running, or when the process was killed by a signal / never started. */
  exitCode: number | null;
  /** true only when status is 'passed'. */
  passed: boolean;
  overlay: boolean;
  revision: number;
  sourceHashes: Record<string, string>;
  /** Combined stdout+stderr tail, capped at 64 KB. */
  output: string;
  /** Why the run is not 'passed' (empty when it passed or is still running). */
  reasons: string[];
  at: number;
  finishedAt: number | null;
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
