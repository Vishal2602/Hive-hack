// Prototype store: the mock snapshot plus demo state (connection, model, dataset), auth and theme.
// Screens read it through useMock(); nothing here talks to a network.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  CLOUD_LINK, agentViews, emptySnapshot, generateToken, members as seedMembers, resolveToken, scenarioSnapshot,
  tokens as seedTokens, unavailableAnalysis, verificationRuns, workspaceInfo,
  type AccessToken, type AgentView, type ClientId, type ConnectionState, type Dataset, type HiveEvent, type Member,
  type ModelState, type Role, type ServiceSnapshot, type VerificationRun, type WorkspaceInfo,
} from '@/mock';

export type Theme = 'light' | 'dark';
export type Accent = 'amber' | 'neutral' | 'violet' | 'blue' | 'green' | 'orange' | 'coral' | 'rose';

const TOKEN_KEY = 'hive.session-token';

function readStorage(storage: 'local' | 'session', key: string): string | null {
  try { return (storage === 'local' ? window.localStorage : window.sessionStorage).getItem(key); } catch { return null; }
}
function writeStorage(storage: 'local' | 'session', key: string, value: string | null) {
  try {
    const s = storage === 'local' ? window.localStorage : window.sessionStorage;
    if (value === null) s.removeItem(key); else s.setItem(key, value);
  } catch { /* storage unavailable: keep in memory only */ }
}

export interface MockStore {
  /** The ServiceSnapshot as the daemon would return it, after demo state is applied. */
  snapshot: ServiceSnapshot;
  workspace: WorkspaceInfo;
  /** One view per session with intent, contracts, findings and derived progress. */
  agents: AgentView[];
  /** Every verification run for a contract, oldest first. */
  runsFor: (contractId: string) => VerificationRun[];
  /** Display name for a session id ("Sanika · pricing agent"), or a short id when unknown. */
  sessionName: (sessionId: string) => string;
  members: Member[];
  tokens: AccessToken[];

  connection: ConnectionState;
  model: ModelState;
  dataset: Dataset;
  setConnection: (state: ConnectionState) => void;
  setModel: (state: ModelState) => void;
  setDataset: (dataset: Dataset) => void;
  /** When the connection state last changed; used to derive poll age for stale/offline. */
  connectionChangedAt: number;

  /** Signed-in member, or null. The token itself stays in sessionStorage only. */
  me: Member | null;
  signIn: (token: string) => { ok: true; member: Member } | { ok: false; reason: string };
  signOut: () => void;

  /** Creates a member if the name is new, then a token for them. The secret is returned once and not kept. */
  createToken: (input: { name: string; role: Role; label?: string; client: ClientId | null }) => { secret: string; token: AccessToken; member: Member };
  revokeToken: (tokenId: string) => void;
  renameToken: (tokenId: string, label: string) => void;
  /** Simulates the first agent registering with a token (for the Connect waiting step). */
  registerAgent: (tokenId: string, agentName: string, client: ClientId | null) => string;

  theme: Theme;
  setTheme: (theme: Theme) => void;
  accent: Accent;
  setAccent: (accent: Accent) => void;
}

const MockContext = createContext<MockStore | null>(null);

export function MockProvider({ children }: { children: ReactNode }) {
  const [connection, setConnectionState] = useState<ConnectionState>('online');
  const [connectionChangedAt, setConnectionChangedAt] = useState(() => Date.now());
  const [model, setModel] = useState<ModelState>('available');
  const [dataset, setDataset] = useState<Dataset>('scenario');
  const [members, setMembers] = useState<Member[]>(seedMembers);
  const [tokens, setTokens] = useState<AccessToken[]>(seedTokens);
  const [extraSessions, setExtraSessions] = useState<ServiceSnapshot['sessions']>([]);
  const [extraEvents, setExtraEvents] = useState<HiveEvent[]>([]);
  const [me, setMe] = useState<Member | null>(() => {
    const saved = readStorage('session', TOKEN_KEY);
    if (!saved) return null;
    const result = resolveToken(saved, seedTokens, seedMembers);
    return result.ok ? result.member : null;
  });
  const [theme, setThemeState] = useState<Theme>(() => (document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'));
  const [accent, setAccentState] = useState<Accent>(() => (document.documentElement.getAttribute('data-accent') as Accent | null) ?? 'amber');

  useEffect(() => { document.documentElement.setAttribute('data-theme', theme); }, [theme]);
  useEffect(() => { document.documentElement.setAttribute('data-accent', accent); }, [accent]);

  const setTheme = useCallback((next: Theme) => { setThemeState(next); writeStorage('local', 'hive.theme', next); }, []);
  const setAccent = useCallback((next: Accent) => { setAccentState(next); writeStorage('local', 'hive.accent', next); }, []);
  const setConnection = useCallback((next: ConnectionState) => { setConnectionState(next); setConnectionChangedAt(Date.now()); }, []);

  const snapshot = useMemo<ServiceSnapshot>(() => {
    const base = dataset === 'empty' ? emptySnapshot : scenarioSnapshot;
    const lastSeq = base.events.at(-1)?.seq ?? 0;
    const withExtras: ServiceSnapshot = {
      ...base,
      sessions: [...base.sessions, ...extraSessions],
      events: [...base.events, ...extraEvents.map((e, i) => ({ ...e, seq: lastSeq + i + 1 }))],
    };
    if (model === 'unavailable') return { ...withExtras, analysis: base.analysis ? unavailableAnalysis : null };
    if (model === 'not_configured') return { ...withExtras, analysis: null, model: { configured: false, model: 'custom' } };
    return withExtras;
  }, [dataset, model, extraSessions, extraEvents]);

  const agents = useMemo(() => agentViews(snapshot), [snapshot]);

  const sessionName = useCallback((id: string) => snapshot.sessions.find(s => s.id === id)?.name ?? `session ${id.slice(0, 8)}`, [snapshot]);
  const runsFor = useCallback((contractId: string) => (dataset === 'empty' ? [] : verificationRuns.filter(r => r.contractId === contractId)), [dataset]);

  const signIn = useCallback<MockStore['signIn']>((token) => {
    const result = resolveToken(token, tokens, members);
    if (!result.ok) return result;
    writeStorage('session', TOKEN_KEY, token.trim());
    setMe(result.member);
    return { ok: true, member: result.member };
  }, [tokens, members]);

  const signOut = useCallback(() => { writeStorage('session', TOKEN_KEY, null); setMe(null); }, []);

  const createToken = useCallback<MockStore['createToken']>(({ name, role, label, client }) => {
    const clean = name.trim() || 'New member';
    let member = members.find(m => m.name.toLowerCase() === clean.toLowerCase());
    if (!member) {
      member = { id: `mem-${clean.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${members.length + 1}`, name: clean, email: '', role, joinedAt: Date.now() };
      const created = member;
      setMembers(list => [...list, created]);
    }
    const { secret, record } = generateToken({ memberId: member.id, label: label?.trim() || `${clean} token`, role, client });
    setTokens(list => [record, ...list]);
    return { secret, token: record, member };
  }, [members]);

  const revokeToken = useCallback((tokenId: string) => {
    setTokens(list => list.map(t => (t.id === tokenId && !t.revokedAt ? { ...t, revokedAt: Date.now() } : t)));
  }, []);

  const renameToken = useCallback((tokenId: string, label: string) => {
    setTokens(list => list.map(t => (t.id === tokenId ? { ...t, label: label.trim() || t.label } : t)));
  }, []);

  const registerAgent = useCallback<MockStore['registerAgent']>((tokenId, agentName, client) => {
    const token = tokens.find(t => t.id === tokenId);
    const owner = members.find(m => m.id === token?.memberId);
    const id = crypto.randomUUID();
    const name = `${owner?.name ?? 'New member'} · ${agentName}`;
    const now = Date.now();
    setExtraSessions(list => [...list, { id, name, workspaceId: scenarioSnapshot.workspaces[0].id, client, expiresAt: now + 10 * 60_000, status: 'active' }]);
    setExtraEvents(list => [...list, { seq: 0, at: now, type: 'session.registered', detail: `${name} (${id})`, payload: { sessionId: id, name } }]);
    setTokens(list => list.map(t => (t.id === tokenId ? { ...t, lastUsedAt: now, agentSessionIds: [...t.agentSessionIds, id] } : t)));
    return id;
  }, [tokens, members]);

  const value = useMemo<MockStore>(() => ({
    snapshot, workspace: { ...workspaceInfo, cloudLink: CLOUD_LINK }, agents, runsFor, sessionName, members, tokens,
    connection, model, dataset, setConnection, setModel, setDataset, connectionChangedAt,
    me, signIn, signOut, createToken, revokeToken, renameToken, registerAgent,
    theme, setTheme, accent, setAccent,
  }), [snapshot, agents, runsFor, sessionName, members, tokens, connection, model, dataset, setConnection, connectionChangedAt,
    me, signIn, signOut, createToken, revokeToken, renameToken, registerAgent, theme, setTheme, accent, setAccent]);

  return <MockContext.Provider value={value}>{children}</MockContext.Provider>;
}

/** The prototype's stand-in for the Hive API. */
export function useMock(): MockStore {
  const store = useContext(MockContext);
  if (!store) throw new Error('useMock must be used inside <MockProvider>');
  return store;
}

/** Current time, re-rendering the caller every `intervalMs`. Use for relative times and lease countdowns. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

export const POLL_INTERVAL_MS = 2000;
export const STALE_AFTER_MS = 10_000;

/** Simulated polling: online polls every 2 s; stale and offline stop updating 12 s before the switch. */
export function useLastPoll(): { lastPollAt: number; ageMs: number; stale: boolean } {
  const { connection, connectionChangedAt } = useMock();
  const now = useNow(1000);
  const lastPollAt = connection === 'online' ? now - (now % POLL_INTERVAL_MS) : connectionChangedAt - 12_000;
  const ageMs = Math.max(0, now - lastPollAt);
  return { lastPollAt, ageMs, stale: ageMs > STALE_AFTER_MS };
}

const seedMemberIds = new Set(seedMembers.map(m => m.id));
const seedTokenIds = new Set(seedTokens.map(t => t.id));

/**
 * Members and tokens as the current dataset shows them. The empty workspace keeps only you
 * (signed in with the bootstrap token) and anyone invited since; the scenario shows everyone.
 */
export function useVisibleAccess(): { members: Member[]; tokens: AccessToken[]; activeTokens: number } {
  const { members, tokens, dataset, me } = useMock();
  return useMemo(() => {
    const empty = dataset === 'empty';
    const visibleMembers = empty ? members.filter(m => m.id === me?.id || !seedMemberIds.has(m.id)) : members;
    const visibleTokens = empty ? tokens.filter(t => !seedTokenIds.has(t.id)) : tokens;
    return { members: visibleMembers, tokens: visibleTokens, activeTokens: visibleTokens.filter(t => !t.revokedAt).length };
  }, [members, tokens, dataset, me?.id]);
}
