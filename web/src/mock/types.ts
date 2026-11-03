// Type-only re-exports of the real Hive contract (../src via the "@hive" alias).
// Nothing here is bundled; the prototype compiles against the backend's own shapes.
export type {
  Acknowledgement, Assumption, Contract, ContractEvidence, ContractStatus, ContractVersion, Event as HiveEvent,
  Finding, FindingKind, ImplementationEvidence, Intent, IntentInput, Repository, Session, SessionStatus, Snapshot,
  VerificationRun, Workspace,
} from '@hive/domain/types.ts';
export type { GraphSummary, HookCheck, ServiceSnapshot } from '@hive/service.ts';
export type { ApplyResult, OperationPreview, Proposal, ProposalStatus, SemanticOperation } from '@hive/ops/types.ts';
export type { Analysis, AnalysisStatus, ModelFinding, ModelFindingKind, ModelUsage } from '@hive/intelligence/types.ts';
export type { Claim, ClaimRule } from '@hive/contracts/claims.ts';

/** Member roles. Prototype-only: the backend has no member model yet. */
export type Role = 'admin' | 'member' | 'viewer';

export interface Member {
  id: string;
  name: string;
  email: string;
  role: Role;
  joinedAt: number;
}

/** A generated access token. The secret is shown once at creation and never stored here. */
export interface AccessToken {
  id: string;
  memberId: string;
  label: string;
  role: Role;
  /** First characters of the secret, safe to display, e.g. "hive_mem_7Qk2". */
  prefix: string;
  client: ClientId | null;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  /** Session ids of agents registered with this token. */
  agentSessionIds: string[];
}

export type ClientId = 'claude-code' | 'muse-code' | 'mcp';

export interface WorkspaceInfo {
  name: string;
  cloudLink: string;
  repository: string;
  branch: string;
  /** Path of the integration clone on the Hive server. */
  serverPath: string;
  region: string;
}

export type ConnectionState = 'online' | 'stale' | 'offline';
export type ModelState = 'available' | 'unavailable' | 'not_configured';
export type Dataset = 'scenario' | 'empty';

export type AgentStepKey = 'registered' | 'intent' | 'working' | 'contract_pending' | 'implemented' | 'verified';
