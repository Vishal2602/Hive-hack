// Derived view of members and their tokens for the Members screen. Pure functions over mock store data.
import { CLIENTS, splitSessionName, type AccessToken, type ClientId, type Member, type Role } from '@/mock';

/** Where "Invite member" lands: the invite step of the connect flow. */
export const INVITE_PATH = '/connect?step=invite';

/** A token used within this window counts as the member being active right now. */
export const ACTIVE_WINDOW_MS = 5 * 60_000;

export type MemberStatus = 'active' | 'idle' | 'no-access';

export interface AgentRef { id: string; name: string }

export interface MemberRow {
  member: Member;
  /** Active tokens first (newest first), then revoked tokens (most recently revoked first). */
  tokens: AccessToken[];
  activeTokenCount: number;
  agents: AgentRef[];
  lastActiveAt: number | null;
  status: MemberStatus;
}

export function clientName(client: ClientId | null): string {
  if (!client) return 'No client yet';
  return CLIENTS.find(c => c.id === client)?.name ?? client;
}

export function agentRefs(sessionIds: string[], sessionName: (id: string) => string): AgentRef[] {
  return sessionIds.map(id => ({ id, name: splitSessionName(sessionName(id)).agentName || sessionName(id) }));
}

export function buildRows(members: Member[], tokens: AccessToken[], sessionName: (id: string) => string, now: number): MemberRow[] {
  return members.map(member => {
    const own = tokens.filter(t => t.memberId === member.id);
    const active = own.filter(t => !t.revokedAt).sort((a, b) => b.createdAt - a.createdAt);
    const revoked = own.filter(t => t.revokedAt).sort((a, b) => (b.revokedAt ?? 0) - (a.revokedAt ?? 0));
    const used = own.map(t => t.lastUsedAt).filter((v): v is number => v !== null);
    const lastActiveAt = used.length ? Math.max(...used) : null;
    const recent = active.some(t => t.lastUsedAt !== null && now - t.lastUsedAt < ACTIVE_WINDOW_MS);
    const status: MemberStatus = active.length === 0 ? 'no-access' : recent ? 'active' : 'idle';
    return {
      member,
      tokens: [...active, ...revoked],
      activeTokenCount: active.length,
      agents: agentRefs(own.flatMap(t => t.agentSessionIds), sessionName),
      lastActiveAt,
      status,
    };
  });
}

/** Admins manage everyone; members manage their own tokens; viewers manage nothing. */
export function canManage(role: Role, meId: string | undefined, memberId: string): boolean {
  if (role === 'admin') return true;
  if (role === 'member') return meId === memberId;
  return false;
}

export const ROLE_ORDER: Role[] = ['admin', 'member', 'viewer'];

/** "1 agent", "3 agents". */
export const countAgents = (n: number) => `${n} ${n === 1 ? 'agent' : 'agents'}`;
