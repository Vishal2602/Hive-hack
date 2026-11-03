// App store. Live by default: role-aware polling of the Hive daemon through src/api (LiveFeed).
// `?mock=1` switches this browser tab to the clickable prototype data (development only; `?mock=0`
// switches back). Both modes expose the same HiveStore, so screens do not care which one runs.
// Screens read it through useHive() (useMock() is the same hook, kept for existing screens).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  HiveClient, LiveFeed, connectionAt, normalizeSnapshot, sessionNames, sessionTokenStore, viewRunToRun, viewToSnapshot,
  type EventItem, type LiveState, type Me, type MemberSummary, type TokenRecord, type ViewResponse,
} from '@/api';
import {
  CLOUD_LINK, agentViews, emptySnapshot, generateToken, members as seedMembers, resolveToken, scenarioSnapshot,
  tokens as seedTokens, unavailableAnalysis, verificationRuns, workspaceInfo,
  type AccessToken, type AgentView, type ClientId, type ConnectionState, type Dataset, type HiveEvent, type Member,
  type ModelState, type Role, type ServiceSnapshot, type VerificationRun, type WorkspaceInfo,
} from '@/mock';

export type Theme = 'light' | 'dark';
export type Accent = 'amber' | 'neutral' | 'violet' | 'blue' | 'green' | 'orange' | 'coral' | 'rose';
export type StoreMode = 'live' | 'mock';
export type SignInResult = { ok: true; member: Member } | { ok: false; reason: string };

export const POLL_INTERVAL_MS = 2000;
export const STALE_AFTER_MS = 10_000;

const MOCK_TOKEN_KEY = 'hive.session-token';
const MOCK_MODE_KEY = 'hive.mock';

function readStorage(storage: 'local' | 'session', key: string): string | null {
  try { return (storage === 'local' ? window.localStorage : window.sessionStorage).getItem(key); } catch { return null; }
}
function writeStorage(storage: 'local' | 'session', key: string, value: string | null) {
  try {
    const s = storage === 'local' ? window.localStorage : window.sessionStorage;
    if (value === null) s.removeItem(key); else s.setItem(key, value);
  } catch { /* storage unavailable: keep in memory only */ }
}

/** The token this browser tab signed in with (sessionStorage only), so Connect can fill it into a member's own setup command. */
export function signedInToken(): string | null { return sessionTokenStore().get() ?? readStorage('session', MOCK_TOKEN_KEY); }

/** `?mock=1` turns the prototype data on for this tab, `?mock=0` turns it off; default is live. */
export function detectMode(): StoreMode {
  const flag = new URLSearchParams(window.location.search).get('mock');
  if (flag === '1') { writeStorage('session', MOCK_MODE_KEY, '1'); return 'mock'; }
  if (flag === '0') { writeStorage('session', MOCK_MODE_KEY, null); return 'live'; }
  return readStorage('session', MOCK_MODE_KEY) === '1' ? 'mock' : 'live';
}

export interface HiveStore {
  mode: StoreMode;
  /** Live: 'loading' until the first poll after sign-in or reload answers. Mock: always 'ready' or 'signed-out'. */
  status: LiveState['status'];
  /** Set after a 401 on the stored token (revoked or wrong): show it on the sign-in screen. */
  signedOutReason: LiveState['signedOutReason'];

  /** The ServiceSnapshot the screens render. Viewers get the viewer-safe view lifted into this shape. */
  snapshot: ServiceSnapshot;
  /** Raw viewer-safe view (viewers only, live mode); null otherwise. */
  view: ViewResponse | null;
  /** Every event seen since sign-in, ascending (live: incremental /events?after). Same as snapshot.events. */
  events: HiveEvent[];
  workspace: WorkspaceInfo;
  /** One view per session with intent, contracts, findings and derived progress. */
  agents: AgentView[];
  /** Verification runs for a contract, oldest first (live: runs observed while polling, viewers: last 5). */
  runsFor: (contractId: string) => VerificationRun[];
  /** Display name for a session id ("Sanika · pricing agent"), or a short id when unknown. */
  sessionName: (sessionId: string) => string;
  members: Member[];
  tokens: AccessToken[];
  /** Live wire data behind members/tokens (admin: token metadata, never values). */
  memberSummaries: MemberSummary[];
  tokenRecords: TokenRecord[];

  connection: ConnectionState;
  /** When `connection` last changed. */
  connectionChangedAt: number;
  /** Last successful poll (live) or simulated poll (mock); null before the first one. */
  lastPollAt: number | null;
  /** Age of the daemon's cached snapshot when it was served. */
  cacheAgeMs: number | null;
  /** Last poll or action error, human readable. */
  error: string | null;
  model: ModelState;
  dataset: Dataset;
  /** Mock-only demo controls; no-ops in live mode. */
  setConnection: (state: ConnectionState) => void;
  setModel: (state: ModelState) => void;
  setDataset: (dataset: Dataset) => void;

  /** Signed-in member, or null. The token itself stays in sessionStorage only. */
  me: Member | null;
  /** GET /me as the daemon sent it (live only). */
  identity: Me | null;
  role: Role | null;
  /** True for viewers: no commands, no token actions. */
  readOnly: boolean;
  signIn: (token: string) => Promise<SignInResult>;
  signOut: () => void;
  /** Poll now; `access` also refreshes members and tokens. */
  refresh: (options?: { access?: boolean }) => Promise<void>;
  /** Typed daemon client for actions not wrapped here (live mode; uses the signed-in token). */
  client: HiveClient;

  /** Admin: creates a token. The secret is returned once and not kept. Rejects with the daemon's message. */
  createToken: (input: { name: string; role: Role; label?: string; client: ClientId | null }) => Promise<{ secret: string; token: AccessToken; member: Member }>;
  revokeToken: (tokenId: string) => Promise<void>;
  renameToken: (tokenId: string, label: string) => Promise<void>;
  /** Mock only: simulates an agent registering with a token. Live returns '' (real agents register over /mcp). */
  registerAgent: (tokenId: string, agentName: string, client: ClientId | null) => string;
  canSimulateAgents: boolean;

  theme: Theme;
  setTheme: (theme: Theme) => void;
  accent: Accent;
  setAccent: (accent: Accent) => void;
}
/** @deprecated name kept for existing screens. */
export type MockStore = HiveStore;

const HiveContext = createContext<HiveStore | null>(null);

function useThemeState() {
  const [theme, setThemeState] = useState<Theme>(() => (document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'));
  const [accent, setAccentState] = useState<Accent>(() => (document.documentElement.getAttribute('data-accent') as Accent | null) ?? 'amber');
  useEffect(() => { document.documentElement.setAttribute('data-theme', theme); }, [theme]);
  useEffect(() => { document.documentElement.setAttribute('data-accent', accent); }, [accent]);
  const setTheme = useCallback((next: Theme) => { setThemeState(next); writeStorage('local', 'hive.theme', next); }, []);
  const setAccent = useCallback((next: Accent) => { setAccentState(next); writeStorage('local', 'hive.accent', next); }, []);
  return useMemo(() => ({ theme, setTheme, accent, setAccent }), [theme, setTheme, accent, setAccent]);
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

/** Live store by default; the prototype store when the tab is in mock mode. */
export function HiveProvider({ children, mode: forced }: { children: ReactNode; mode?: StoreMode }) {
  const [mode] = useState<StoreMode>(() => forced ?? detectMode());
  return mode === 'mock' ? <MockModeProvider>{children}</MockModeProvider> : <LiveModeProvider>{children}</LiveModeProvider>;
}
/** @deprecated name kept for existing code; same as HiveProvider. */
export const MockProvider = HiveProvider;

// ---- live mode ---------------------------------------------------------------------------------------

const ROLE_PREFIX: Record<Role, string> = { admin: 'adm', member: 'mem', viewer: 'view' };
const CLIENT_IDS: ClientId[] = ['claude-code', 'muse-code', 'mcp'];
const asClientId = (value: string | null | undefined): ClientId | null => (CLIENT_IDS as string[]).includes(value ?? '') ? value as ClientId : null;

function blankSnapshot(name: string): ServiceSnapshot {
  return { ...emptySnapshot, repository: { id: '', canonicalRoot: name, revision: 0 }, workspaces: [], sessions: [], intents: [], contracts: [],
    findings: [], events: [], proposals: [], claims: [], analysis: null,
    graph: { workspaceId: '', indexed: false, symbols: 0, edges: 0, files: 0, lastSync: null }, model: { configured: false, model: '' } };
}

function memberFromMe(me: Me): Member {
  return { id: me.member, name: me.member, email: '', role: me.role, joinedAt: 0 };
}

function toAccessToken(record: TokenRecord, sessions: ServiceSnapshot['sessions']): AccessToken {
  const used = sessions.filter(s => s.tokenId === record.id);
  return { id: record.id, memberId: record.member, label: record.label, role: record.role,
    prefix: `hive_${ROLE_PREFIX[record.role]}_${record.prefix}`, client: asClientId(used[0]?.client),
    createdAt: record.createdAt, lastUsedAt: record.lastUsedAt, revokedAt: record.revokedAt, agentSessionIds: used.map(s => s.id) };
}

function LiveModeProvider({ children }: { children: ReactNode }) {
  const [{ client, feed }] = useState(() => {
    const client = new HiveClient();
    return { client, feed: new LiveFeed({ client, intervalMs: POLL_INTERVAL_MS }) };
  });
  const state = useSyncExternalStore(feed.subscribe, feed.getState);
  const themeState = useThemeState();
  const [actionError, setActionError] = useState<string | null>(null);
  const now = useNow(1000);

  useEffect(() => {
    void feed.resume();
    return () => feed.stop();
  }, [feed]);

  const raw = connectionAt(state, now, STALE_AFTER_MS);
  const connection: ConnectionState = raw === 'connecting' ? 'online' : raw;
  const changed = useRef({ value: connection, at: Date.now() });
  if (changed.current.value !== connection) changed.current = { value: connection, at: Date.now() };

  const me = useMemo(() => (state.me ? memberFromMe(state.me) : null), [state.me]);
  const workspaceName = state.me?.workspace.name ?? state.view?.workspace.name ?? '';

  const snapshot = useMemo<ServiceSnapshot>(() => {
    if (state.snapshot) return normalizeSnapshot(state.snapshot, state.events);
    if (state.view) return viewToSnapshot(state.view, state.events);
    return blankSnapshot(workspaceName);
  }, [state.snapshot, state.view, state.events, workspaceName]);

  const workspace = useMemo<WorkspaceInfo>(() => ({
    name: workspaceName,
    cloudLink: (state.me?.publicUrl ?? window.location.origin).replace(/\/$/, ''),
    repository: '', branch: '', serverPath: state.me?.workspace.root ?? '', region: '',
  }), [workspaceName, state.me]);

  const agents = useMemo(() => agentViews(snapshot), [snapshot]);
  const names = useMemo(() => sessionNames(snapshot, state.view), [snapshot, state.view]);
  const sessionName = useCallback((id: string) => names[id] ?? `session ${id.slice(0, 8)}`, [names]);

  const runsFor = useCallback((contractId: string): VerificationRun[] => {
    if (state.view) return (state.view.contracts.find(c => c.id === contractId)?.verification ?? []).map(run => viewRunToRun(contractId, run));
    return Object.values(state.runs).filter(run => run.contractId === contractId).sort((a, b) => a.at - b.at);
  }, [state.view, state.runs]);

  const tokens = useMemo(() => state.tokens.map(t => toAccessToken(t, snapshot.sessions)), [state.tokens, snapshot.sessions]);
  const members = useMemo<Member[]>(() => {
    const list = state.members.map(m => {
      const own = state.tokens.filter(t => t.member === m.member);
      const role = (m.roles[0] as Role | undefined) ?? (m.member === state.me?.member ? state.me.role : own[0]?.role ?? 'member');
      return { id: m.member, name: m.member, email: '', role, joinedAt: own.length ? Math.min(...own.map(t => t.createdAt)) : 0 };
    });
    if (me && !list.some(m => m.id === me.id)) list.unshift(me);
    return list;
  }, [state.members, state.tokens, state.me, me]);

  const model: ModelState = !snapshot.model.configured ? 'not_configured' : snapshot.analysis?.status === 'unavailable' ? 'unavailable' : 'available';

  const signIn = useCallback(async (token: string): Promise<SignInResult> => {
    const result = await feed.signIn(token);
    return result.ok ? { ok: true, member: memberFromMe(result.me) } : result;
  }, [feed]);
  const signOut = useCallback(() => feed.signOut(), [feed]);
  const refresh = useCallback((options?: { access?: boolean }) => feed.refresh(options), [feed]);

  const createToken = useCallback<HiveStore['createToken']>(async ({ name, role, label }) => {
    const member = name.trim();
    const created = await client.tokenCreate({ label: (label?.trim() || `${member} token`).slice(0, 80), member, role });
    void feed.refresh({ access: true });
    return { secret: created.token, token: toAccessToken(created.record, []), member: { id: created.record.member, name: created.record.member, email: '', role, joinedAt: created.record.createdAt } };
  }, [client, feed]);

  const mutate = useCallback(async (run: () => Promise<unknown>) => {
    try { await run(); setActionError(null); } catch (error) { setActionError(error instanceof Error ? error.message : 'Action failed'); }
    await feed.refresh({ access: true });
  }, [feed]);
  const revokeToken = useCallback((tokenId: string) => mutate(() => client.tokenRevoke(tokenId)), [mutate, client]);
  const renameToken = useCallback((tokenId: string, label: string) => mutate(() => client.tokenRename(tokenId, label.trim())), [mutate, client]);
  const registerAgent = useCallback(() => '', []);
  const noop = useCallback(() => {}, []);

  const value = useMemo<HiveStore>(() => ({
    mode: 'live', status: state.status, signedOutReason: state.signedOutReason,
    snapshot, view: state.view, events: snapshot.events, workspace, agents, runsFor, sessionName, members, tokens,
    memberSummaries: state.members, tokenRecords: state.tokens,
    connection, connectionChangedAt: changed.current.at, lastPollAt: state.lastPollAt, cacheAgeMs: state.cacheAgeMs,
    error: actionError ?? state.error, model, dataset: 'scenario', setConnection: noop, setModel: noop, setDataset: noop,
    me, identity: state.me, role: state.me?.role ?? null, readOnly: state.me?.role === 'viewer',
    signIn, signOut, refresh, client, createToken, revokeToken, renameToken, registerAgent, canSimulateAgents: false,
    ...themeState,
  }), [state.status, state.signedOutReason, state.view, state.members, state.tokens, state.lastPollAt, state.cacheAgeMs, state.error, state.me,
    snapshot, workspace, agents, runsFor, sessionName, members, tokens, connection, actionError, model, noop, me,
    signIn, signOut, refresh, client, createToken, revokeToken, renameToken, registerAgent, themeState]);

  return <HiveContext.Provider value={value}>{children}</HiveContext.Provider>;
}

// ---- mock mode (prototype data, ?mock=1) ----------------------------------------------------------------

function MockModeProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => new HiveClient());
  const themeState = useThemeState();
  const [connection, setConnectionState] = useState<ConnectionState>('online');
  const [connectionChangedAt, setConnectionChangedAt] = useState(() => Date.now());
  const [model, setModel] = useState<ModelState>('available');
  const [dataset, setDataset] = useState<Dataset>('scenario');
  const [members, setMembers] = useState<Member[]>(seedMembers);
  const [tokens, setTokens] = useState<AccessToken[]>(seedTokens);
  const [extraSessions, setExtraSessions] = useState<ServiceSnapshot['sessions']>([]);
  const [extraEvents, setExtraEvents] = useState<HiveEvent[]>([]);
  const [me, setMe] = useState<Member | null>(() => {
    const saved = readStorage('session', MOCK_TOKEN_KEY);
    if (!saved) return null;
    const result = resolveToken(saved, seedTokens, seedMembers);
    return result.ok ? result.member : null;
  });

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

  const signIn = useCallback(async (token: string): Promise<SignInResult> => {
    const result = resolveToken(token, tokens, members);
    if (!result.ok) return result;
    writeStorage('session', MOCK_TOKEN_KEY, token.trim());
    setMe(result.member);
    return { ok: true, member: result.member };
  }, [tokens, members]);
  const signOut = useCallback(() => { writeStorage('session', MOCK_TOKEN_KEY, null); setMe(null); }, []);

  const createToken = useCallback<HiveStore['createToken']>(async ({ name, role, label, client: clientId }) => {
    const clean = name.trim() || 'New member';
    let member = members.find(m => m.name.toLowerCase() === clean.toLowerCase());
    if (!member) {
      member = { id: `mem-${clean.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${members.length + 1}`, name: clean, email: '', role, joinedAt: Date.now() };
      const created = member;
      setMembers(list => [...list, created]);
    }
    const { secret, record } = generateToken({ memberId: member.id, label: label?.trim() || `${clean} token`, role, client: clientId });
    setTokens(list => [record, ...list]);
    return { secret, token: record, member };
  }, [members]);
  const revokeToken = useCallback(async (tokenId: string) => {
    setTokens(list => list.map(t => (t.id === tokenId && !t.revokedAt ? { ...t, revokedAt: Date.now() } : t)));
  }, []);
  const renameToken = useCallback(async (tokenId: string, label: string) => {
    setTokens(list => list.map(t => (t.id === tokenId ? { ...t, label: label.trim() || t.label } : t)));
  }, []);
  const registerAgent = useCallback<HiveStore['registerAgent']>((tokenId, agentName, clientId) => {
    const token = tokens.find(t => t.id === tokenId);
    const owner = members.find(m => m.id === token?.memberId);
    const id = crypto.randomUUID();
    const name = `${owner?.name ?? 'New member'} · ${agentName}`;
    const now = Date.now();
    setExtraSessions(list => [...list, { id, name, workspaceId: scenarioSnapshot.workspaces[0].id, client: clientId, expiresAt: now + 10 * 60_000, status: 'active' }]);
    setExtraEvents(list => [...list, { seq: 0, at: now, type: 'session.registered', detail: `${name} (${id})`, payload: { sessionId: id, name } }]);
    setTokens(list => list.map(t => (t.id === tokenId ? { ...t, lastUsedAt: now, agentSessionIds: [...t.agentSessionIds, id] } : t)));
    return id;
  }, [tokens, members]);
  const refresh = useCallback(async () => {}, []);

  const value = useMemo<HiveStore>(() => ({
    mode: 'mock', status: me ? 'ready' : 'signed-out', signedOutReason: null,
    snapshot, view: null, events: snapshot.events, workspace: { ...workspaceInfo, cloudLink: CLOUD_LINK }, agents, runsFor, sessionName, members, tokens,
    memberSummaries: [], tokenRecords: [],
    connection, connectionChangedAt, lastPollAt: null, cacheAgeMs: null, error: null, model, dataset, setConnection, setModel, setDataset,
    me, identity: null, role: me?.role ?? null, readOnly: me?.role === 'viewer',
    signIn, signOut, refresh, client, createToken, revokeToken, renameToken, registerAgent, canSimulateAgents: true,
    ...themeState,
  }), [snapshot, agents, runsFor, sessionName, members, tokens, connection, connectionChangedAt, model, dataset, setConnection,
    me, signIn, signOut, refresh, client, createToken, revokeToken, renameToken, registerAgent, themeState]);

  return <HiveContext.Provider value={value}>{children}</HiveContext.Provider>;
}

// ---- hooks -----------------------------------------------------------------------------------------------

/** The app store (live or mock). */
export function useHive(): HiveStore {
  const store = useContext(HiveContext);
  if (!store) throw new Error('useHive must be used inside <HiveProvider>');
  return store;
}
/** Same as useHive(); kept so existing screens keep compiling. */
export const useMock = useHive;

/**
 * Poll age. Live: time since the last successful poll (stale after 10 s). Mock: simulated 2 s polling
 * that stops 12 s before a switch to stale/offline.
 */
export function useLastPoll(): { lastPollAt: number; ageMs: number; stale: boolean } {
  const { mode, connection, connectionChangedAt, lastPollAt: live } = useHive();
  const now = useNow(1000);
  if (mode === 'live') {
    const lastPollAt = live ?? now;
    const ageMs = Math.max(0, now - lastPollAt);
    return { lastPollAt, ageMs, stale: connection === 'stale' || ageMs > STALE_AFTER_MS };
  }
  const lastPollAt = connection === 'online' ? now - (now % POLL_INTERVAL_MS) : connectionChangedAt - 12_000;
  const ageMs = Math.max(0, now - lastPollAt);
  return { lastPollAt, ageMs, stale: ageMs > STALE_AFTER_MS };
}

const seedMemberIds = new Set(seedMembers.map(m => m.id));
const seedTokenIds = new Set(seedTokens.map(t => t.id));

/**
 * Members and tokens as the current data shows them. In mock mode the empty workspace keeps only you
 * and anyone invited since; live mode shows what the daemon returned.
 */
export function useVisibleAccess(): { members: Member[]; tokens: AccessToken[]; activeTokens: number } {
  const { members, tokens, dataset, me, mode } = useHive();
  return useMemo(() => {
    const empty = mode === 'mock' && dataset === 'empty';
    const visibleMembers = empty ? members.filter(m => m.id === me?.id || !seedMemberIds.has(m.id)) : members;
    const visibleTokens = empty ? tokens.filter(t => !seedTokenIds.has(t.id)) : tokens;
    return { members: visibleMembers, tokens: visibleTokens, activeTokens: visibleTokens.filter(t => !t.revokedAt).length };
  }, [members, tokens, dataset, me?.id, mode]);
}

export type { EventItem };
