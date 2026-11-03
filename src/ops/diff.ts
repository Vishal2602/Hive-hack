/** Minimal unified diff (line-based LCS). Good enough for previews of source edits. */
export function unifiedDiff(before: string, after: string, path: string): string {
  const a = before.split('\n'); const b = after.split('\n');
  if (a.length * b.length > 4_000_000) return `--- a/${path}\n+++ b/${path}\n@@ file too large for line diff: ${a.length} -> ${b.length} lines @@\n`;
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
    dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const lines: string[] = [];
  let i = 0; let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { lines.push(` ${a[i]}`); i++; j++; }
    else if (i < a.length && (j >= b.length || dp[i + 1]![j]! >= dp[i]![j + 1]!)) { lines.push(`-${a[i]}`); i++; }
    else { lines.push(`+${b[j]}`); j++; }
  }
  // Keep only hunks: changed lines with 2 lines of context.
  const keep = new Set<number>();
  lines.forEach((line, index) => { if (!line.startsWith(' ')) for (let k = index - 2; k <= index + 2; k++) keep.add(k); });
  const out: string[] = [`--- a/${path}`, `+++ b/${path}`];
  let previous = -2;
  for (let index = 0; index < lines.length; index++) {
    if (!keep.has(index)) continue;
    if (index !== previous + 1) out.push('@@');
    out.push(lines[index]!);
    previous = index;
  }
  return out.join('\n') + '\n';
}
