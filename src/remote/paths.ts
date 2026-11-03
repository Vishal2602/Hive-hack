/** Which laptop files Hive syncs. Shared by the daemon and the client hook (no compiler import here). */
export const MAX_FILE_BYTES = 256 * 1024;
const SOURCE = /\.(ts|tsx|mts|cts)$/;
const BLOCKED_SEGMENTS = new Set(['node_modules', '.git', '.hive']);

/** Repository-relative POSIX path of a TypeScript source file, or an error message. */
export function checkPath(path: string): string | null {
  if (!path || path.length > 500) return 'path is empty or too long';
  if (path.startsWith('/') || path.startsWith('~') || /^[A-Za-z]:/.test(path) || path.includes('\\')) return `${path}: must be repository-relative with / separators`;
  const segments = path.split('/');
  if (segments.some(s => s === '..' || s === '.' || s === '')) return `${path}: must not contain empty, . or .. segments`;
  if (segments.some(s => BLOCKED_SEGMENTS.has(s))) return `${path}: node_modules, .git and .hive are not synced`;
  if (!SOURCE.test(path) || path.endsWith('.d.ts')) return `${path}: only .ts/.tsx source files are synced`;
  if (/(^|\/)\.env/.test(path)) return `${path}: secrets are not synced`;
  return null;
}
