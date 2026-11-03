import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Activity as ActivityIcon } from 'lucide-react';
import { Button } from '@/components/arc/button/button';
import { EmptyState } from '@/components/arc/empty-state/empty-state';
import { ScrollArea } from '@/components/arc/scroll-area/scroll-area';
import { TocRail, type TocItem } from '@/components/TocRail';
import { Page, formatClock, useHive, useMediaQuery, useNow, usePrefersReducedMotion } from '@/shell';
import type { HiveEvent } from '@/mock';
import { EventDetail } from './activity/EventDetail';
import { makeDescriber, type EventView } from './activity/describe';
import { PAGE_SIZE, mergeBySeq, pageWindow } from './activity/paging';
import styles from './activity/activity.module.css';

// Tick geometry of the vendored element: ticks run from 1.875rem to 33.625rem.
const TRACK_TOP = 1.875;
const TRACK_BOTTOM = 33.625;
const shortClock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const tickTop = (index: number, count: number) => TRACK_TOP + (index / Math.max(count - 1, 1)) * (TRACK_BOTTOM - TRACK_TOP);

export default function Activity() {
  const { snapshot, events: live, sessionName, client, mode } = useHive();
  const navigate = useNavigate();
  const now = useNow(1_000);
  const wide = useMediaQuery('(min-width: 1024px)');
  const [params, setParams] = useSearchParams();

  // The store keeps the newest events (it grows from /events?after=<last seq> on every poll). Older pages
  // are read from /events on demand and kept here for this visit.
  const [older, setOlder] = useState<HiveEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const all = useMemo(() => (older.length ? mergeBySeq(older, live) : [...live].sort((a, b) => a.seq - b.seq)), [older, live]);

  const views = useMemo<EventView[]>(() => {
    const describe = makeDescriber(snapshot, sessionName);
    return all.map(describe);
  }, [all, snapshot, sessionName]);

  const requestedRaw = params.get('event');
  const requested = requestedRaw === null ? null : Number(requestedRaw);
  const found = requested === null ? -1 : views.findIndex(v => v.event.seq === requested);
  const following = found < 0;
  const index = following ? views.length - 1 : found;
  const { start, end } = pageWindow(views.length, index);
  const windowViews = useMemo(() => views.slice(start, end), [views, start, end]);
  const firstSeq = all[0]?.seq ?? 0;
  const lastSeq = all[all.length - 1]?.seq ?? 0;

  const selectSeq = useCallback((seq: number | null) => {
    const p = new URLSearchParams(params);
    if (seq === null) p.delete('event'); else p.set('event', String(seq));
    setParams(p, { replace: true });
  }, [params, setParams]);

  const selectInWindow = useCallback((i: number) => {
    const view = windowViews[i];
    if (view) selectSeq(view.event.seq);
  }, [windowViews, selectSeq]);

  /** Reads up to one page of events that come before `beforeSeq` from /events and keeps them. */
  const loadBefore = useCallback(async (beforeSeq: number): Promise<HiveEvent[]> => {
    if (mode !== 'live' || beforeSeq <= 1) return [];
    setLoading(true);
    setLoadError(null);
    try {
      const after = Math.max(0, beforeSeq - 1 - PAGE_SIZE);
      const page = (await client.events(after, Math.min(PAGE_SIZE, beforeSeq - 1 - after))) as HiveEvent[];
      setOlder(prev => mergeBySeq(prev, page));
      return page;
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not load earlier events');
      return [];
    } finally {
      setLoading(false);
    }
  }, [client, mode]);

  // A link to an event older than the ones in memory: read the page that holds it once.
  const tried = useRef(new Set<number>());
  useEffect(() => {
    if (requested === null || !Number.isInteger(requested) || found >= 0 || !all.length) return;
    if (requested >= firstSeq || requested < 1 || tried.current.has(requested)) return;
    tried.current.add(requested);
    void loadBefore(Math.min(firstSeq, requested + PAGE_SIZE / 2));
  }, [requested, found, all.length, firstSeq, loadBefore]);

  const earlier = async () => {
    if (start > 0) { selectSeq(views[start - 1]!.event.seq); return; }
    const page = await loadBefore(firstSeq);
    if (page.length) selectSeq(page[page.length - 1]!.seq);
  };
  const later = () => { if (end < views.length) selectSeq(views[end]!.event.seq); };
  const canEarlier = start > 0 || (mode === 'live' && firstSeq > 1);

  if (views.length === 0) {
    return (
      <Page title="Activity" description="Every event on this Hive server, in order.">
        <EmptyState
          icon={<ActivityIcon />}
          title="No activity yet"
          description="Events appear here as agents register, declare intents, sign agreements and apply changes."
          action={<Button variant="secondary" onClick={() => navigate('/connect')}>Invite an agent</Button>}
        />
      </Page>
    );
  }

  const current = views[index]!;
  const onlyServer = views.every(v => !v.sessionId);
  const pager = (
    <div className={styles.pager}>
      <p className={styles.pagerText} aria-live="polite">
        {windowViews.length === views.length && firstSeq <= 1
          ? `${views.length} event${views.length === 1 ? '' : 's'}${following ? ', following new ones' : ''}`
          : `Events ${windowViews[0]!.event.seq} to ${windowViews[windowViews.length - 1]!.event.seq} of ${lastSeq}${following ? ', following new ones' : ''}`}
      </p>
      {canEarlier && <Button variant="ghost" size="sm" onClick={() => void earlier()} disabled={loading}>{loading ? 'Loading' : 'Earlier'}</Button>}
      {end < views.length && <Button variant="ghost" size="sm" onClick={later}>Later</Button>}
      {!following && <Button variant="secondary" size="sm" onClick={() => selectSeq(null)}>Follow latest</Button>}
      {loadError && <p className={styles.pagerError} role="alert">{loadError}</p>}
    </div>
  );

  return (
    <Page
      title="Activity"
      description={wide
        ? 'Every event on this Hive server, in order. Scrub the rail to preview, click or press Enter to open one, or use the arrow keys.'
        : 'Every event on this Hive server, in order. Pick one to see its fields, diff or test output.'}
    >
      {onlyServer && (
        <p className={styles.hint}>Only server events so far. Agent registrations, intents and changes will join this timeline as people connect.</p>
      )}
      <div className={wide ? styles.layoutWide : styles.layoutNarrow}>
        <div className={wide ? styles.side : styles.sideNarrow}>
          {pager}
          {wide
            ? <Scrubber views={windowViews} index={index - start} onSelect={selectInWindow} />
            : <Strip views={windowViews} index={index - start} onSelect={selectInWindow} />}
        </div>
        <div className={styles.main}>
          <EventDetail key={current.event.seq} view={current} position={current.event.seq} total={Math.max(lastSeq, current.event.seq)} now={now} />
        </div>
      </div>
    </Page>
  );
}

/** Desktop: the vendored rail, with a short label beside each tick. Arrow keys move the selection. */
function Scrubber({ views, index, onSelect }: { views: EventView[]; index: number; onSelect: (i: number) => void }) {
  const viaKeys = useRef(false);
  const items = useMemo<TocItem[]>(() => views.map(v => ({
    id: String(v.event.seq),
    title: v.title,
    description: `${formatClock(v.event.at)}. ${v.summary}`,
  })), [views]);
  // Labels need about 1.75rem each; with more events only the selected label shows.
  const spacing = (TRACK_BOTTOM - TRACK_TOP) / Math.max(views.length - 1, 1);
  const allLabels = spacing >= 1.75;

  return (
    <div
      className={styles.scrubber}
      onKeyDownCapture={e => { if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) viaKeys.current = true; }}
      onPointerMoveCapture={() => { viaKeys.current = false; }}
    >
      <TocRail
        items={items}
        value={index}
        label="Events"
        className={styles.rail}
        onChange={i => { if (viaKeys.current) onSelect(i); }}
        onCommit={i => onSelect(i)}
      />
      <ol className={styles.labels} aria-hidden="true">
        {views.map((v, i) => (allLabels || i === index) && (
          <li key={v.event.seq} style={{ top: `${tickTop(i, views.length)}rem` }}>
            <button
              type="button"
              tabIndex={-1}
              className={styles.label}
              data-current={i === index || undefined}
              data-tone={v.tone}
              onClick={() => onSelect(i)}
            >
              <span className={styles.labelTitle}>{v.title}</span>
              <span className={styles.labelTime}>{shortClock(v.event.at)}</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Below 1024 px: a horizontal list with a roving tab stop. Arrow keys move the selection. */
function Strip({ views, index, onSelect }: { views: EventView[]; index: number; onSelect: (i: number) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const reduced = usePrefersReducedMotion();
  const focusAfterKey = useRef(false);

  useEffect(() => {
    const el = refs.current[index];
    if (!el) return;
    el.scrollIntoView({ block: 'nearest', inline: 'center', behavior: reduced ? 'auto' : 'smooth' });
    if (focusAfterKey.current) { el.focus({ preventScroll: true }); focusAfterKey.current = false; }
  }, [index, reduced]);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    let next: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = Math.min(views.length - 1, index + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = Math.max(0, index - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = views.length - 1;
    if (next === null) return;
    e.preventDefault();
    focusAfterKey.current = true;
    onSelect(next);
  };

  return (
    <nav aria-label="Events" className={styles.stripNav}>
      <ScrollArea orientation="horizontal" fade={24}>
        <ol className={styles.strip}>
          {views.map((v, i) => (
            <li key={v.event.seq}>
              <button
                ref={el => { refs.current[i] = el; }}
                type="button"
                className={styles.chip}
                tabIndex={i === index ? 0 : -1}
                aria-current={i === index ? 'true' : undefined}
                data-tone={v.tone}
                onClick={() => onSelect(i)}
                onKeyDown={onKeyDown}
              >
                <span className={styles.chipTime}>{formatClock(v.event.at)}</span>
                <span className={styles.chipTitle}>{v.title}</span>
              </button>
            </li>
          ))}
        </ol>
      </ScrollArea>
    </nav>
  );
}
