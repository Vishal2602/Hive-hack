// Live feed: role-aware polling of the daemon, kept outside React so it can be tested under Node.
// Viewers poll GET /api/view, members and admins poll GET /snapshot, every 2 s; the activity
// timeline grows incrementally from GET /events?after=<last seq>. Members/tokens refresh every 10 s
// and right after a mutation. A 401 on the stored token signs out (the client clears it).
import { ApiError, type HiveClient } from './client.ts';
import type { EventItem, Me, MemberSummary, SnapshotResponse, TokenRecord, VerificationRun, ViewResponse } from './types.ts';

export const POLL_INTERVAL_MS = 2_000;
export const STALE_AFTER_MS = 10_000;
export const ACCESS_REFRESH_MS = 10_000;
/** Older events are dropped from memory beyond this many (the daemon keeps them all). */
export const MAX_EVENTS = 5_000;

export type FeedStatus = 'signed-out' | 'loading' | 'ready';
export type Connection = 'connecting' | 'online' | 'stale' | 'offline';

export interface LiveState {
  status: FeedStatus;
  /** Why the feed is signed out: the token was refused (revoked/wrong), or the person signed out. */
  signedOutReason: 'unauthorized' | 'signed-out' | null;
  me: Me | null;
  /** /snapshot for members and admins; null for viewers. */
  snapshot: SnapshotResponse | null;
  /** /api/view for viewers; null for members and admins. */
  view: ViewResponse | null;
  /** Every event seen since sign-in, ascending by seq, without duplicates. */
  events: EventItem[];
  lastEventSeq: number;
  /** Admin only (token_list). */
  tokens: TokenRecord[];
  /** member_list for members/admins; derived from view.members for viewers. */
  members: MemberSummary[];
  /** Verification runs observed in snapshots (latest per contract each poll), by run id. */
  runs: Record<string, VerificationRun>;
  /** Time of the last fully successful poll. */
  lastPollAt: number | null;
  lastAttemptAt: number | null;
  /** cacheAgeMs of the last snapshot/view (how old the daemon's cache was when served). */
  cacheAgeMs: number | null;
  /** The last poll failed because Hive was unreachable (network, timeout, 5xx). */
  unreachable: boolean;
  error: string | null;
}

export const initialLiveState = (): LiveState => ({
  status: 'signed-out', signedOutReason: null, me: null, snapshot: null, view: null, events: [], lastEventSeq: 0,
  tokens: [], members: [], runs: {}, lastPollAt: null, lastAttemptAt: null, cacheAgeMs: null, unreachable: false, error: null,
});

/** Connection state at `now`: offline after a failed poll, stale 10 s after the last success. */
export function connectionAt(state: Pick<LiveState, 'lastPollAt' | 'unreachable'>, now: number, staleAfterMs = STALE_AFTER_MS): Connection {
  if (state.unreachable) return 'offline';
  if (state.lastPollAt === null) return 'connecting';
  return now - state.lastPollAt > staleAfterMs ? 'stale' : 'online';
}

/** Appends events with seq > the last known seq, keeping ascending order and the memory cap. */
export function mergeEvents(existing: EventItem[], incoming: EventItem[], max = MAX_EVENTS): EventItem[] {
  const last = existing.length ? existing[existing.length - 1]!.seq : 0;
  const fresh = incoming.filter(e => e.seq > last).sort((a, b) => a.seq - b.seq);
  if (!fresh.length) return existing;
  const merged = existing.concat(fresh);
  return merged.length > max ? merged.slice(merged.length - max) : merged;
}

export interface LiveFeedOptions {
  client: HiveClient;
  intervalMs?: number;
  accessRefreshMs?: number;
  clock?: () => number;
}

export class LiveFeed {
  private readonly client: HiveClient;
  private readonly intervalMs: number;
  private readonly accessRefreshMs: number;
  private readonly clock: () => number;
  private state: LiveState = initialLiveState();
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private inFlight: Promise<void> | null = null;
  private accessAt = 0;
  private generation = 0;
  private unsubscribe: () => void;

  constructor(options: LiveFeedOptions) {
    this.client = options.client;
    this.intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
    this.accessRefreshMs = options.accessRefreshMs ?? ACCESS_REFRESH_MS;
    this.clock = options.clock ?? Date.now;
    this.unsubscribe = this.client.onUnauthorized(() => this.signedOut('unauthorized'));
    // A stored token (page reload) means "loading", not "signed out", until the first poll answers.
    if (this.client.token) this.state = { ...this.state, status: 'loading' };
  }

  getState = (): LiveState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private set(patch: Partial<LiveState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  /**
   * Checks a token with GET /me without touching the stored one. On success the token is stored,
   * the feed loads and starts polling. Returns the identity or a human-readable reason.
   */
  async signIn(token: string): Promise<{ ok: true; me: Me } | { ok: false; reason: string }> {
    const value = token.trim();
    if (!value) return { ok: false, reason: 'Paste your access token to continue.' };
    try {
      const me = await this.client.me({ token: value });
      this.client.setToken(value);
      this.reset({ status: 'loading', me });
      await this.start();
      return { ok: true, me };
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return { ok: false, reason: 'Hive did not accept this token. It may be mistyped or revoked; ask an admin for a new one.' };
      if (error instanceof ApiError && error.unreachable) return { ok: false, reason: `Cannot reach Hive right now. ${error.message}.` };
      return { ok: false, reason: error instanceof Error ? error.message : 'Sign in failed.' };
    }
  }

  /** Resumes with a token already in storage (page reload). Returns false when there is none. */
  async resume(): Promise<boolean> {
    if (!this.client.token) { this.reset({ status: 'signed-out' }); return false; }
    if (this.state.status === 'signed-out') this.reset({ status: 'loading' });
    await this.start();
    return true;
  }

  signOut(): void {
    this.client.signOut();
    this.signedOut('signed-out');
  }

  private signedOut(reason: 'unauthorized' | 'signed-out'): void {
    this.stop();
    this.reset({ status: 'signed-out', signedOutReason: reason });
  }

  private reset(patch: Partial<LiveState>): void {
    this.generation++;
    this.accessAt = 0;
    this.state = { ...initialLiveState(), ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  /** Starts polling (first poll runs immediately and is awaited). Idempotent. */
  async start(): Promise<void> {
    if (this.running) { await this.inFlight; return; }
    this.running = true;
    await this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
  }

  dispose(): void { this.stop(); this.unsubscribe(); this.listeners.clear(); }

  /** Poll now (coalesces with a poll already running). Call after a mutation for instant feedback. */
  refresh(options: { access?: boolean } = {}): Promise<void> {
    if (options.access) this.accessAt = 0;
    return this.tick();
  }

  /** One poll. Public for tests; the timer calls it every intervalMs while running. */
  tick(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const run = this.poll().finally(() => {
      this.inFlight = null;
      if (this.running) {
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = setTimeout(() => { void this.tick(); }, this.intervalMs);
      }
    });
    this.inFlight = run;
    return run;
  }

  private async poll(): Promise<void> {
    if (!this.client.token) { this.signedOut(this.state.status === 'signed-out' ? (this.state.signedOutReason ?? 'signed-out') : 'unauthorized'); return; }
    const generation = this.generation;
    const attemptAt = this.clock();
    const stale = () => generation !== this.generation;
    try {
      const me = this.state.me ?? await this.client.me();
      if (stale()) return;
      const viewer = me.role === 'viewer';
      const [snapshot, view] = viewer ? [null, await this.client.view()] : [await this.client.snapshot(), null];
      if (stale()) return;
      const incoming = await this.client.eventsSince(this.state.lastEventSeq, { maxPages: this.state.lastEventSeq === 0 ? 10 : 3 });
      if (stale()) return;
      const events = mergeEvents(this.state.events, incoming);
      let { tokens, members } = this.state;
      if (viewer) {
        members = (view?.members ?? []).map(m => ({ member: m.member, roles: [], tokens: [], sessions: [] }));
      } else if (this.accessAt === 0 || attemptAt - this.accessAt >= this.accessRefreshMs) {
        [members, tokens] = await Promise.all([this.client.memberList(), me.role === 'admin' ? this.client.tokenList() : Promise.resolve([] as TokenRecord[])]);
        if (stale()) return;
        this.accessAt = attemptAt;
      }
      const runs = { ...this.state.runs };
      for (const contract of snapshot?.contracts ?? []) {
        const run = contract.evidence.verification;
        if (run) runs[run.id] = run;
      }
      this.set({
        status: 'ready', signedOutReason: null, me, snapshot, view, events,
        lastEventSeq: events.length ? events[events.length - 1]!.seq : this.state.lastEventSeq,
        tokens, members, runs, lastPollAt: this.clock(), lastAttemptAt: attemptAt,
        cacheAgeMs: (snapshot ?? view)?.cacheAgeMs ?? null, unreachable: false, error: null,
      });
    } catch (error) {
      if (stale()) return;
      if (error instanceof ApiError && error.status === 401) return; // onUnauthorized already signed out
      const unreachable = error instanceof ApiError ? error.unreachable : true;
      this.set({ lastAttemptAt: attemptAt, unreachable, error: error instanceof Error ? error.message : 'Poll failed' });
    }
  }
}
