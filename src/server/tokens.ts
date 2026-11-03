import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Store } from '../store/sqlite.ts';

export type Role = 'admin' | 'member' | 'viewer';
export const ROLES: readonly Role[] = ['admin', 'member', 'viewer'];
const ROLE_PREFIX: Record<Role, string> = { admin: 'adm', member: 'mem', viewer: 'view' };
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const SECRET_LENGTH = 32;
const TOUCH_INTERVAL_MS = 60_000;
export const TOKEN_PATTERN = /^hive_(adm|mem|view)_[0-9A-Za-z]{32}$/;

/** Public token metadata. Never carries the token value or its hash. */
export interface TokenRecord {
  id: string;
  label: string;
  member: string;
  role: Role;
  prefix: string;
  createdBy: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}
export interface CreatedToken { token: string; record: TokenRecord }

type TokenRow = { id: string; label: string; member: string; role: Role; hash: string; prefix: string; created_by: string; created_at: number; last_used_at: number | null; revoked_at: number | null };

export function hashToken(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }

/** Uniform base62 string via rejection sampling (bytes >= 248 are discarded to avoid modulo bias). */
function base62(length: number): string {
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= 248) continue;
      out += BASE62[byte % 62];
      if (out.length === length) break;
    }
  }
  return out;
}

function rowToRecord(row: TokenRow): TokenRecord {
  return { id: row.id, label: row.label, member: row.member, role: row.role, prefix: row.prefix, createdBy: row.created_by,
    createdAt: Number(row.created_at), lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at) };
}

function cleanName(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 80) throw new Error(`${field} must be 1-80 characters`);
  return trimmed;
}

/** Member/viewer/admin tokens. Only sha256 hashes are persisted; values are returned once by `create`. */
export class TokenService {
  private readonly store: Store;
  private readonly clock: () => number;

  constructor(store: Store, clock: () => number = Date.now) {
    this.store = store;
    this.clock = clock;
  }

  create(input: { label: string; member: string; role: Role; createdBy: string }): CreatedToken {
    if (!ROLES.includes(input.role)) throw new Error('Unknown role');
    const label = cleanName(input.label, 'label');
    const member = cleanName(input.member, 'member');
    const secret = base62(SECRET_LENGTH);
    const token = `hive_${ROLE_PREFIX[input.role]}_${secret}`;
    const id = randomUUID();
    this.store.run('INSERT INTO tokens(id, label, member, role, hash, prefix, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, label, member, input.role, hashToken(token), secret.slice(0, 8), input.createdBy, this.clock());
    return { token, record: this.get(id)! };
  }

  get(id: string): TokenRecord | undefined {
    const row = this.store.get<TokenRow>('SELECT * FROM tokens WHERE id = ?', id);
    return row ? rowToRecord(row) : undefined;
  }

  list(): TokenRecord[] {
    return this.store.all<TokenRow>('SELECT * FROM tokens ORDER BY created_at, rowid').map(rowToRecord);
  }

  rename(id: string, label: string): TokenRecord {
    const clean = cleanName(label, 'label');
    if (!Number(this.store.run('UPDATE tokens SET label = ? WHERE id = ?', clean, id).changes)) throw new Error('Unknown token');
    return this.get(id)!;
  }

  revoke(id: string): TokenRecord {
    const existing = this.get(id);
    if (!existing) throw new Error('Unknown token');
    if (existing.revokedAt === null) this.store.run('UPDATE tokens SET revoked_at = ? WHERE id = ?', this.clock(), id);
    return this.get(id)!;
  }

  /** Active token for a presented value, or undefined. Touches last_used_at at most once per minute. */
  resolve(value: string): TokenRecord | undefined {
    if (!TOKEN_PATTERN.test(value)) return undefined;
    const row = this.store.get<TokenRow>('SELECT * FROM tokens WHERE hash = ? AND revoked_at IS NULL', hashToken(value));
    if (!row) return undefined;
    const now = this.clock();
    if (row.last_used_at === null || now - Number(row.last_used_at) >= TOUCH_INTERVAL_MS) {
      this.store.run('UPDATE tokens SET last_used_at = ? WHERE id = ?', now, row.id);
      row.last_used_at = now;
    }
    return rowToRecord(row);
  }
}
