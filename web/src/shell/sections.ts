// Primary sections of the app, in navigation order.
export interface Section {
  id: 'overview' | 'connect' | 'agreements' | 'activity' | 'members';
  path: string;
  title: string;
  description: string;
}

export const SECTIONS: Section[] = [
  { id: 'overview', path: '/', title: 'Overview', description: 'What every agent is doing and the conflict that needs a decision.' },
  { id: 'connect', path: '/connect', title: 'Connect', description: 'Share the cloud link and invite people and their agents.' },
  { id: 'agreements', path: '/agreements', title: 'Agreements', description: 'Versioned promises about interfaces, signed by every agent involved.' },
  { id: 'activity', path: '/activity', title: 'Activity', description: 'Every event in order, with diffs and test output.' },
  { id: 'members', path: '/members', title: 'Members', description: 'People, roles and the tokens their agents use.' },
];

export function sectionForPath(pathname: string): Section {
  if (pathname === '/' || pathname === '') return SECTIONS[0];
  return SECTIONS.find(s => s.path !== '/' && (pathname === s.path || pathname.startsWith(`${s.path}/`))) ?? SECTIONS[0];
}
