/**
 * Live Meta Model API smoke test. Reads MODEL_API_KEY from the environment (npm script loads .env),
 * makes ONE small chat completion with structured output, and prints model id, latency and token
 * usage. It never prints the key. Exit 0 = the key and endpoint work; exit 1 = not usable (reason shown).
 */
import { MetaAnalyzer } from '../src/intelligence/meta.ts';
import type { EvidenceBundle } from '../src/intelligence/types.ts';

const key = process.env.MODEL_API_KEY ?? '';
if (!key.trim()) {
  console.error('MODEL_API_KEY is empty. Put it in .env as MODEL_API_KEY=<key> (never paste it into chat), then rerun `npm run smoke:model`.');
  process.exit(1);
}
// Pinned to the Meta provider: this script reads MODEL_API_KEY, so it must never follow HIVE_MODEL_PROVIDER=fireworks
// (that would send the Meta key to Fireworks). The banner is derived from the analyzer so it cannot disagree with the request.
const analyzer = new MetaAnalyzer({ provider: 'meta', apiKey: key, maxAttempts: 2, timeoutMs: 60_000 });
console.error(`Key present (${key.length} chars, not shown). Provider: ${analyzer.label}. Model: ${analyzer.model}. Endpoint: ${analyzer.baseUrl}/chat/completions`);

const bundle: EvidenceBundle = {
  revision: 0,
  inputHash: 'smoke',
  intents: [
    { sessionId: 'smoke-a', revision: 1, at: Date.now(), task: 'Return integer cents from getPrice', files: ['src/pricing.ts'], symbols: ['src/pricing.ts#getPrice:function'], assumptions: [{ key: 'src/pricing.ts#getPrice:unit', value: 'cents' }] },
    { sessionId: 'smoke-b', revision: 1, at: Date.now(), task: 'Format invoices in dollars', files: ['src/invoice.ts'], symbols: ['src/invoice.ts#invoiceTotal:function'], assumptions: [{ key: 'src/pricing.ts#getPrice:unit', value: 'dollars' }] },
  ],
  candidates: [{ kind: 'assumption_mismatch', severity: 'warning', sessions: ['smoke-a', 'smoke-b'], source: 'deterministic', symbols: ['src/pricing.ts#getPrice:unit'], evidence: 'src/pricing.ts#getPrice:unit: smoke-a expects cents; smoke-b expects dollars' }],
  contracts: [],
  symbols: [{ key: 'src/pricing.ts#getPrice:function', file: 'src/pricing.ts', line: 2, kind: 'function', signature: 'getPrice(): number', excerpt: '/** Returns US dollars. */\nexport function getPrice(): number { return 19.99; }' }],
  dependents: [{ symbol: 'src/pricing.ts#getPrice:function', from: 'src/invoice.ts#invoiceTotal:function', file: 'src/invoice.ts', line: 3 }],
};

try {
  const result = await analyzer.analyze(bundle, ['smoke-a', 'smoke-b']);
  console.log(JSON.stringify({ ok: true, model: result.model, latencyMs: result.latencyMs, attempts: result.attempts, usage: result.usage,
    summary: result.summary, findings: result.findings.map(f => ({ kind: f.kind, confidence: f.confidence, explanation: f.explanation, proposedDeclaration: f.proposedDeclaration ?? null })), dropped: result.dropped }, null, 2));
} catch (error) {
  console.error(`Smoke test FAILED: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
  process.exit(1);
}
