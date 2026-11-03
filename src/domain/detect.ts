import type { Finding, Intent } from './types.ts';

/** Deterministic candidates only. Overlap is NOT proof of a conflict. */
export function detect(intents: Intent[]): Finding[] {
  const findings: Finding[] = [];
  for (let i = 0; i < intents.length; i++) {
    for (let j = i + 1; j < intents.length; j++) {
      const a = intents[i]!;
      const b = intents[j]!;
      const sessions = [a.sessionId, b.sessionId];
      for (const assumption of a.assumptions) {
        const other = b.assumptions.find(item => item.key === assumption.key);
        if (other && other.value !== assumption.value) {
          findings.push({ kind: 'assumption_mismatch', severity: 'warning', sessions, source: 'deterministic',
            symbols: [assumption.key],
            evidence: `${assumption.key}: ${a.sessionId} expects ${assumption.value}; ${b.sessionId} expects ${other.value}` });
        }
      }
      const symbols = a.symbols.filter(symbol => b.symbols.includes(symbol));
      const files = a.files.filter(file => b.files.includes(file));
      if (symbols.length) findings.push({ kind: 'symbol_overlap', severity: 'info', sessions, source: 'deterministic',
        symbols, evidence: `Shared symbols: ${symbols.join(', ')}` });
      else if (files.length) findings.push({ kind: 'file_overlap', severity: 'info', sessions, source: 'deterministic',
        files, evidence: `Shared files: ${files.join(', ')}` });
    }
  }
  return findings;
}
