import { useCallback, useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Activity as ActivityIcon } from 'lucide-react';
import { Button } from '@/components/arc/button/button';
import { EmptyState } from '@/components/arc/empty-state/empty-state';
import { ScrollArea } from '@/components/arc/scroll-area/scroll-area';
import { TocRail, type TocItem } from '@/components/TocRail';
import { Page, formatClock, useMediaQuery, useMock, useNow, usePrefersReducedMotion } from '@/shell';
import { EventDetail } from './activity/EventDetail';
import { makeDescriber, type EventView } from './activity/describe';
import styles from './activity/activity.module.css';

// Tick geometry of the vendored element: ticks run from 1.875rem to 33.625rem.
const TRACK_TOP = 1.875;
const TRACK_BOTTOM = 33.625;
const RAIL_LIMIT = 200;
const shortClock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const tickTop = (index: number, count: number) => TRACK_TOP + (index / Math.max(count - 1, 1)) * (TRACK_BOTTOM - TRACK_TOP);

export default function Activity() {
  const { snapshot, sessionName } = useMock();
  const navigate = useNavigate();
  const now = useNow(15_000);
  const wide = useMediaQuery('(min-width: 1024px)');
  const [params, setParams] = useSearchParams();

  const views = useMemo<EventView[]>(() => {
    const describe = makeDescriber(snapshot, sessionName);
    // Chronological, oldest first. The rail holds at most 200 items, so keep the most recent ones.
    return [...snapshot.events].sort((a, b) => a.seq - b.seq).slice(-RAIL_LIMIT).map(describe);
  }, [snapshot, sessionName]);

  const requested = Number(params.get('event'));
  const found = views.findIndex(v => v.event.seq === requested);
  const index = found >= 0 ? found : views.length - 1;

  const select = useCallback((next: number) => {
    const view = views[next];
    if (!view) return;
    const p = new URLSearchParams(params);
    p.set('event', String(view.event.seq));
    setParams(p, { replace: true });
  }, [views, params, setParams]);

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

  const current = views[index];
  const onlyServer = views.every(v => !v.sessionId);

  return (
    <Page
      title="Activity"
      description={wide
        ? 'Every event on this Hive server, in order. Scrub the rail to preview, click or press Enter to open one, or use the arrow keys.'
        : 'Every event on this Hive server, in order. Pick one to see its diff or test output.'}
    >
      {onlyServer && (
        <p className={styles.hint}>Only server events so far. Agent registrations, intents and changes will join this timeline as people connect.</p>
      )}
      <div className={wide ? styles.layoutWide : styles.layoutNarrow}>
        {wide
          ? <Scrubber views={views} index={index} onSelect={select} />
          : <Strip views={views} index={index} onSelect={select} />}
        <div className={styles.main}>
          <EventDetail key={current.event.seq} view={current} position={index + 1} total={views.length} now={now} />
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
