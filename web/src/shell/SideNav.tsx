// Desktop navigation: the vendored table-of-content rail, with a text link beside each tick.
// The rail scrubs and previews; click or Enter commits. The links are the plain, accessible path.
import { useMemo, type CSSProperties } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { TocRail, type TocItem } from '@/components/TocRail';
import { SECTIONS, sectionForPath } from './sections';
import { useMock, useVisibleAccess } from './store';
import styles from './SideNav.module.css';

// Tick geometry from the vendored model: ticks run from 1.875rem to 33.625rem of a 35.5rem stage,
// spread evenly whatever the item count. Five sections would sit about 127px apart, so the nav
// compresses the element vertically by RAIL_SCALE (CSS in SideNav.module.css scales tick, card and
// hit-area positions; pointer mapping in the element is proportional to the rail's height).
const TRACK_TOP = 1.875;
const TRACK_BOTTOM = 33.625;
const STAGE_HEIGHT = 35.5;
const TICK_PITCH = 4; // rem, 64px between sections
const LABEL_TAIL = 2.75; // rem below the last tick for its hint line
const railScale = (count: number) => Math.min(1, TICK_PITCH / ((TRACK_BOTTOM - TRACK_TOP) / Math.max(count - 1, 1)));
const tickTop = (index: number, count: number) =>
  railScale(count) * (TRACK_TOP + (index / Math.max(count - 1, 1)) * (TRACK_BOTTOM - TRACK_TOP));

function useSectionHints(): Record<string, string> {
  const { snapshot } = useMock();
  const { members, activeTokens } = useVisibleAccess();
  return useMemo(() => {
    const conflicts = snapshot.findings.filter(f => f.severity !== 'info').length;
    const byStatus = (s: string) => snapshot.contracts.filter(c => c.status === s).length;
    const agreementParts = [
      byStatus('proposed') && `${byStatus('proposed')} proposed`,
      byStatus('accepted') && `${byStatus('accepted')} accepted`,
      byStatus('implemented') && `${byStatus('implemented')} implemented`,
      byStatus('verified') && `${byStatus('verified')} verified`,
      byStatus('stale') && `${byStatus('stale')} stale`,
    ].filter(Boolean);
    return {
      overview: snapshot.sessions.length
        ? `${snapshot.sessions.length} agent${snapshot.sessions.length === 1 ? '' : 's'}, ${conflicts ? `${conflicts} to review` : 'no conflicts'}`
        : 'No agents yet',
      connect: 'Invite a person or agent',
      agreements: agreementParts.length ? agreementParts.join(', ') : 'None yet',
      activity: `${snapshot.events.length} event${snapshot.events.length === 1 ? '' : 's'}`,
      members: `${members.length} ${members.length === 1 ? 'person' : 'people'}, ${activeTokens} active ${activeTokens === 1 ? 'token' : 'tokens'}`,
    };
  }, [snapshot, members, activeTokens]);
}

export function SideNav() {
  const location = useLocation();
  const navigate = useNavigate();
  const current = sectionForPath(location.pathname);
  const hints = useSectionHints();
  const index = SECTIONS.findIndex(s => s.id === current.id);
  const items = useMemo<TocItem[]>(() => SECTIONS.map(s => ({ id: s.id, title: s.title, description: s.description })), []);

  return (
    <nav className={styles.nav} aria-label="Sections">
      <div
        className={styles.stage}
        style={{
          '--rail-scale': railScale(SECTIONS.length),
          blockSize: `${Math.max(STAGE_HEIGHT * railScale(SECTIONS.length), tickTop(SECTIONS.length - 1, SECTIONS.length) + LABEL_TAIL)}rem`,
        } as CSSProperties}
      >
        <TocRail
          items={items}
          value={index}
          label="Sections"
          onCommit={i => navigate(SECTIONS[i].path)}
          className={styles.rail}
        />
        <ul className={styles.links}>
          {SECTIONS.map((section, i) => (
            <li key={section.id} style={{ top: `${tickTop(i, SECTIONS.length)}rem` }}>
              <NavLink
                to={section.path}
                end={section.path === '/'}
                className={({ isActive }) => [styles.link, isActive || section.id === current.id ? styles.active : ''].join(' ')}
                aria-current={section.id === current.id ? 'page' : undefined}
              >
                <span className={styles.title}>{section.title}</span>
                <span className={styles.hint}>{hints[section.id]}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
