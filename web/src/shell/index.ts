// Public shell API for screens. Screens import from '@/shell' only.
export { Page, type PageProps } from './Page';
export { Standalone } from './Standalone';
export { ConnectionNotice, ModelNotice } from './StateNotices';
export {
  HiveProvider, MockProvider, useHive, useMock, useNow, useLastPoll, useVisibleAccess, detectMode, POLL_INTERVAL_MS, STALE_AFTER_MS,
  type HiveStore, type MockStore, type SignInResult, type StoreMode, type Theme, type Accent,
} from './store';
export { SECTIONS, sectionForPath, type Section } from './sections';
export { useMediaQuery, usePrefersReducedMotion } from './useMediaQuery';
export * from './format';
