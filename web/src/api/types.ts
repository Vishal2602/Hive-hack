// Wire types for the Hive daemon's HTTP API. Every shape is imported (type-only) from the backend
// sources so the client cannot drift from what the daemon sends. Relative paths, not the "@hive"
// alias, so this folder also type-checks and runs under Node for the backend's test suite.
import type { Event, VerificationRun } from '../../../src/domain/types.ts';
import type { HiveView, MemberSummary, ServiceSnapshot, ViewEvent } from '../../../src/service.ts';
import type { Command } from '../../../src/server/schemas.ts';
import type { CreatedToken, Role, TokenRecord } from '../../../src/server/tokens.ts';

export type { Command, CreatedToken, Event, HiveView, MemberSummary, Role, ServiceSnapshot, TokenRecord, VerificationRun, ViewEvent };

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
