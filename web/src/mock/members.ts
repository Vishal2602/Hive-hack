// Members and access tokens. Prototype-only: the backend has no member model yet.
// The admin bootstrap token that created this workspace is deliberately absent; it is never shown.
import { SESSION } from './snapshot.ts';
import { minutesAgo } from './time.ts';
import type { AccessToken, ClientId, Member, Role } from './types.ts';

export const ROLE_LABEL: Record<Role, string> = { admin: 'Admin', member: 'Member', viewer: 'Viewer' };

export const ROLE_DESCRIPTION: Record<Role, string> = {
  admin: 'Can invite people, revoke tokens and change workspace settings.',
  member: 'Can connect agents, declare intents and sign agreements.',
  viewer: 'Can read the workspace. Cannot connect agents or sign.',
};

export const members: Member[] = [
  { id: 'mem-sanika', name: 'Sanika', email: 'sanika@hive-demo.dev', role: 'admin', joinedAt: minutesAgo(60 * 26) },
  { id: 'mem-vishal', name: 'Vishal', email: 'vishal@hive-demo.dev', role: 'member', joinedAt: minutesAgo(60 * 25) },
  { id: 'mem-judge', name: 'Judge', email: 'judge@hive-demo.dev', role: 'viewer', joinedAt: minutesAgo(45) },
];

export const tokens: AccessToken[] = [
  {
    id: 'tok-1c8e', memberId: 'mem-sanika', label: 'Sanika laptop', role: 'admin', prefix: 'hive_adm_4Wq8',
    client: 'claude-code', createdAt: minutesAgo(60 * 26), lastUsedAt: minutesAgo(0.2), revokedAt: null,
    agentSessionIds: [SESSION.pricing],
  },
  {
    id: 'tok-7a2f', memberId: 'mem-vishal', label: 'Vishal workstation', role: 'member', prefix: 'hive_mem_7Qk2',
    client: 'muse-code', createdAt: minutesAgo(60 * 25), lastUsedAt: minutesAgo(0.4), revokedAt: null,
    agentSessionIds: [SESSION.invoice, SESSION.ui],
  },
  {
    id: 'tok-3d91', memberId: 'mem-vishal', label: 'Old CI runner', role: 'member', prefix: 'hive_mem_x91B',
    client: 'mcp', createdAt: minutesAgo(60 * 24), lastUsedAt: minutesAgo(60 * 23), revokedAt: minutesAgo(60 * 2),
    agentSessionIds: [],
  },
  {
    id: 'tok-9b4c', memberId: 'mem-judge', label: 'Judge read-only', role: 'viewer', prefix: 'hive_view_Lm3t',
    client: null, createdAt: minutesAgo(45), lastUsedAt: minutesAgo(12), revokedAt: null,
    agentSessionIds: [],
  },
];

const ROLE_PREFIX: Record<Role, string> = { admin: 'hive_adm_', member: 'hive_mem_', viewer: 'hive_view_' };
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function randomString(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => ALPHABET[b % ALPHABET.length]).join('');
}

/** Generates a token secret and its stored record. Show `secret` once; only `record.prefix` is kept. */
export function generateToken(input: { memberId: string; label: string; role: Role; client: ClientId | null }): { secret: string; record: AccessToken } {
  const secret = ROLE_PREFIX[input.role] + randomString(32);
  const record: AccessToken = {
    id: `tok-${randomString(4).toLowerCase()}`,
    memberId: input.memberId,
    label: input.label,
    role: input.role,
    prefix: secret.slice(0, ROLE_PREFIX[input.role].length + 4),
    client: input.client,
    createdAt: Date.now(),
    lastUsedAt: null,
    revokedAt: null,
    agentSessionIds: [],
  };
  return { secret, record };
}

/** A token the sign-in screen may offer for the clickable prototype. Maps to Sanika (admin). */
export const DEMO_TOKEN = 'hive_adm_4Wq8demoTokenForThePrototypeOnly';

/** Prototype validation: right shape and not revoked. Returns the member it belongs to. */
export function resolveToken(secret: string, list: AccessToken[], people: Member[]): { ok: true; member: Member; token: AccessToken | null } | { ok: false; reason: string } {
  const value = secret.trim();
  if (!/^hive_(adm|mem|view)_[A-Za-z0-9]{12,}$/.test(value)) {
    return { ok: false, reason: 'That does not look like a Hive token. Tokens start with hive_ and are at least 20 characters.' };
  }
  const token = list.find(t => value.startsWith(t.prefix)) ?? null;
  if (token?.revokedAt) return { ok: false, reason: 'This token was revoked. Ask an admin for a new invite.' };
  const member = (token && people.find(p => p.id === token.memberId)) ?? people.find(p => p.role === roleFromSecret(value)) ?? people[0];
  return { ok: true, member, token };
}

export function roleFromSecret(secret: string): Role {
  if (secret.startsWith('hive_adm_')) return 'admin';
  if (secret.startsWith('hive_view_')) return 'viewer';
  return 'member';
}
