// Wire types for the Hive daemon's HTTP API. Every shape is imported (type-only) from the backend
// sources so the client cannot drift from what the daemon sends. Relative paths, not the "@hive"
// alias, so this folder also type-checks and runs under Node for the backend's test suite.
import type { Event, VerificationRun } from '../../../src/domain/types.ts';
import type { ModelDiagnosis as HubModelDiagnosis } from '../../../src/intelligence/meta.ts';
import type { ConnectorSummary, HiveView, MemberSummary, ModelSnapshot, ServiceSnapshot, ViewEvent } from '../../../src/service.ts';
import type { PairingInfo, PairingStatus } from '../../../src/server/pairing.ts';
import type { Command } from '../../../src/server/schemas.ts';
import type { CreatedToken, Role, TokenRecord } from '../../../src/server/tokens.ts';

export type { Command, ConnectorSummary, CreatedToken, Event, HiveView, MemberSummary, ModelSnapshot, PairingInfo, PairingStatus, Role, ServiceSnapshot, TokenRecord, VerificationRun, ViewEvent };

/** The provider the hub's model analysis talks to (HIVE_MODEL_PROVIDER): Meta's Model API or Muse Spark Open on Fireworks. */
export type ModelProvider = 'meta' | 'fireworks';
/**
 * model_diagnose answer (src/intelligence/meta.ts ModelDiagnosis). `provider` is optional here because hubs built before
 * 2026-11-03 do not send it; the dashboard shows the row only when present. (snapshot.model.provider is already optional
 * on the hub's ModelSnapshot and HiveView, so those pass through unchanged and fixtures may omit it.)
 */
export type ModelDiagnosis = Omit<HubModelDiagnosis, 'provider'> & { provider?: ModelProvider };

/** What signed in: the operator (HIVE_TOKEN), a member's browser/agent token, or a Hive Connect credential. */
export type MeKind = 'operator' | 'member' | 'connector' | 'viewer-link';

/** pair_approve answer: the pairing plus the connector label the CLI will receive. */
export type PairingApproved = PairingInfo & { label: string };

/** connector_disconnect answer. */
export interface ConnectorDisconnected { disconnected: boolean; tokenId: string; revokedAt: number | null; checkoutCleared: boolean }

/** GET /me (src/server/daemon.ts `me()`): who the caller is and what this service is. */
export interface Me {
  role: Role;
  member: string;
  /** Token row id; null for the operator (HIVE_TOKEN). */
  tokenId: string | null;
  /** `root` is only sent to admins. */
  workspace: { id: string; name: string; root?: string };
  /** HIVE_PUBLIC_URL, or null when unset (then use window.location.origin). */
  publicUrl: string | null;
  /** Older daemons omit the fields below. */
  kind?: MeKind;
  /** HIVE_PUBLIC_URL, or the address this request reached the hub on (X-Forwarded-Proto + Host). */
  hubUrl?: string;
  /** The one command a teammate runs inside their repository. */
  connect?: { cliCommand: string };
  /** Only for a Hive Connect credential: the repository and machine it is bound to. */
  connector?: { repoIdentity: string | null; machine: string | null };
  model: { configured: boolean; model: string };
  version: string;
}

/** GET /snapshot (member/admin): the cached ServiceSnapshot plus its age. */
export type SnapshotResponse = ServiceSnapshot & { cacheAgeMs: number };
/** GET /api/view (any role): the viewer-safe projection plus its age. */
export type ViewResponse = HiveView & { cacheAgeMs: number };
/** GET /events: members/admins get full events (with payload); viewers get scrubbed ViewEvents. */
export type EventItem = Event | ViewEvent;

/** GET /healthz (unauthenticated). */
export interface Health {
  ok: boolean;
  draining?: boolean;
  revision?: number;
  indexed?: boolean;
  recovered?: number;
  recoveredJournals?: number;
  uptimeMs?: number;
  version?: string;
  error?: string;
}
