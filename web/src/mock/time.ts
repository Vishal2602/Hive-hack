/** Mock clock origin. All scenario timestamps are relative to page load so relative times read naturally. */
export const T0 = Date.now();
export const minutesAgo = (minutes: number) => T0 - Math.round(minutes * 60_000);
export const minutesFromNow = (minutes: number) => T0 + Math.round(minutes * 60_000);
