import { createHash, timingSafeEqual } from 'node:crypto';
import type { Command } from './schemas.ts';
import type { Role, TokenService } from './tokens.ts';

/** Who is calling. The operator (HIVE_TOKEN) is admin with no token row. */
export interface Auth { role: Role; member: string; tokenId: string | null }

export class AuthError extends Error {
  readonly status: 401 | 403;
  constructor(status: 401 | 403, message: string) { super(message); this.name = 'AuthError'; this.status = status; }
}

export const OPERATOR_MEMBER = 'operator';
/** Routes a viewer may call. Everything else is refused with 403 for viewers. */
const VIEWER_ROUTES = new Set(['/api/view', '/me', '/events', '/healthz']);
const ADMIN_ACTIONS = new Set(['token_create', 'token_list', 'token_rename', 'token_revoke']);

function digest(value: string): Buffer { return createHash('sha256').update(value, 'utf8').digest(); }

/** Constant-time comparison (both sides hashed to equal length first). */
export function safeEqual(a: string, b: string): boolean { return timingSafeEqual(digest(a), digest(b)); }

export function bearer(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const match = /^Bearer\s+(\S+)\s*$/.exec(value);
  return match ? match[1]! : null;
}

/** Resolves a request's Authorization header to an Auth, or throws 401. */
export function resolveAuth(header: string | string[] | undefined, options: { adminToken: string; tokens: TokenService }): Auth {
  const presented = bearer(header);
  if (!presented) throw new AuthError(401, 'Unauthorized');
  if (safeEqual(presented, options.adminToken)) return { role: 'admin', member: OPERATOR_MEMBER, tokenId: null };
  const record = options.tokens.resolve(presented);
  if (!record) throw new AuthError(401, 'Unauthorized');
  return { role: record.role, member: record.member, tokenId: record.id };
}

/** Route-level gate: viewers may only GET the viewer-safe routes. */
export function authorizeRoute(auth: Auth, method: string, pathname: string): void {
  if (auth.role !== 'viewer') return;
  if (method === 'GET' && VIEWER_ROUTES.has(pathname)) return;
  throw new AuthError(403, 'Forbidden: viewer tokens are read-only');
}

/**
 * Command-level gate. Admins may do anything. Members may run session commands only on
 * sessions registered with their own token. Viewers may run no command.
 */
export function authorizeCommand(auth: Auth, command: Command, sessionOwner: (sessionId: string) => { tokenId?: string | null } | undefined): void {
  if (auth.role === 'admin') return;
  if (auth.role === 'viewer') throw new AuthError(403, 'Forbidden: viewer tokens are read-only');
  if (ADMIN_ACTIONS.has(command.action)) throw new AuthError(403, 'Forbidden: admin token required');
  if ('sessionId' in command && command.sessionId) {
    const owner = sessionOwner(command.sessionId);
    // An unknown session falls through so the coordinator reports it as unknown/expired.
    if (owner && (owner.tokenId ?? null) !== auth.tokenId) throw new AuthError(403, 'Forbidden: session belongs to another member');
  }
}
