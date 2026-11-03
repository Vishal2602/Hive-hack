// Formatting helpers shared by screens. Plain text output only.

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "just now", "12 seconds ago", "4 minutes ago", "in 3 minutes". */
export function formatRelative(at: number, now: number = Date.now()): string {
  const diff = at - now;
  const abs = Math.abs(diff);
  if (abs < 5_000) return 'just now';
  if (abs < 60_000) return rtf.format(Math.round(diff / 1000), 'second');
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), 'minute');
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), 'hour');
  return rtf.format(Math.round(diff / 86_400_000), 'day');
}

/** "14:32:05" in the viewer's locale. */
export function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** "2 Nov, 14:32". */
export function formatDateTime(at: number): string {
  return new Date(at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** "19.8 s", "820 ms", "3 min 05 s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m} min ${String(s).padStart(2, '0')} s`;
}

/** Lease remaining: "4 min left", "40 s left", "expired". */
export function formatLease(expiresAt: number, now: number = Date.now()): string {
  const left = expiresAt - now;
  if (left <= 0) return 'Lease expired';
  if (left < 60_000) return `${Math.ceil(left / 1000)} s left on lease`;
  return `${Math.ceil(left / 60_000)} min left on lease`;
}

/** "a41c9e2…" style short hash for display; keep the full value available in a title or copy button. */
export const shortHash = (hash: string, length = 10) => (hash.length > length ? `${hash.slice(0, length)}…` : hash);

/** Splits a symbol key "src/pricing.ts#getPrice:function" into its parts. */
export function parseSymbolKey(key: string): { file: string; name: string; kind: string } {
  const [file, rest = ''] = key.split('#');
  const colon = rest.lastIndexOf(':');
  return colon === -1 ? { file, name: rest, kind: '' } : { file, name: rest.slice(0, colon), kind: rest.slice(colon + 1) };
}
