// Paging over the event log for the Activity rail. Pure; the backend test suite imports it under Node.
import type { Event as HiveEvent } from '../../../../src/domain/types.ts';

/** The rail holds at most 200 items, so the log is shown 200 events at a time. */
export const PAGE_SIZE = 200;

/** Ascending by seq, one copy of each seq. */
export function mergeBySeq(a: HiveEvent[], b: HiveEvent[]): HiveEvent[] {
  const bySeq = new Map<number, HiveEvent>();
  for (const event of a) bySeq.set(event.seq, event);
  for (const event of b) bySeq.set(event.seq, event);
  return [...bySeq.values()].sort((x, y) => x.seq - y.seq);
}

/** Page window aligned from the newest event: page 0 is the latest PAGE_SIZE events. */
export function pageWindow(length: number, index: number, size = PAGE_SIZE): { start: number; end: number; page: number } {
  if (length === 0) return { start: 0, end: 0, page: 0 };
  const page = Math.floor((length - 1 - index) / size);
  const end = length - page * size;
  return { start: Math.max(0, end - size), end, page };
}
