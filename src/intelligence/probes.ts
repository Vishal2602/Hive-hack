import type { Finding, Intent } from '../domain/types.ts';
import { PROVIDER_ENV, type MinimalCompletion, type ModelProvider } from './meta.ts';
import { AnalysisInvalid, type Analyzer, type AnalyzerResult, type EvidenceBundle, type ModelFindingKind, type ModelUsage } from './types.ts';

/**
 * model_probe: proves a provider works from this hub before it is activated. Three checks run in parallel on
 * SYNTHETIC repository data: a minimal completion, a conflict analysis that must find the unit disagreement,
 * and a harmless overlap that must not be flagged. Nothing here touches the database, emits events or needs
 * a session; every string in the report is bounded and redacted.
 */
export interface ProbeAnalyzer extends Analyzer {
  readonly provider: ModelProvider;
  readonly model: string;
  readonly baseUrlHost: string;
  readonly proxy: boolean;
  readonly configured: boolean;
  minimalCompletion(): Promise<MinimalCompletion>;
  sanitize(text: string): string;
}
export function isProbeAnalyzer(analyzer: Analyzer): analyzer is ProbeAnalyzer {
  const candidate = analyzer as Partial<ProbeAnalyzer>;
  return typeof candidate.minimalCompletion === 'function' && typeof candidate.sanitize === 'function' && typeof candidate.provider === 'string';
}

export type ProbeVerdict = 'not_configured' | 'pass' | 'fail';
export interface ProbeFinding { kind: ModelFindingKind; sessionIds: string[]; confidence: string; explanation: string; evidence: string[] }
export interface AnalysisProbe {
  status: 'ok' | 'unavailable' | 'invalid';
  latencyMs: number;
  usage: ModelUsage | null;
  model: string | null;
  summary: string;
  findings: ProbeFinding[];
  dropped: string[];
  error: string | null;
  expectation: { met: boolean; detail: string };
}
export interface ModelProbeReport {
  provider: ModelProvider;
  model: string;
  baseUrlHost: string;
  proxy: boolean;
  configured: boolean;
  /** pass: the minimal completion answered 2xx and both analysis expectations were met. */
  verdict: ProbeVerdict;
  at: number;
  latencyMs: number;
  minimal: MinimalCompletion;
  conflict: AnalysisProbe;
  harmless: AnalysisProbe;
}

const GET_PRICE = 'src/pricing.ts#getPrice:function';
const GET_PRICE_UNIT = `${GET_PRICE}:unit`;
const RENDER_INVOICE = 'src/invoice.ts#renderInvoice:function';
const FORMAT_SKU = 'src/pricing.ts#formatSku:function';
const LOG_PRICE = 'src/pricing.ts#logPrice:function';

function intent(sessionId: string, task: string, files: string[], symbols: string[], assumptions: Intent['assumptions']): Intent {
  return { sessionId, revision: 0, at: 0, task, files, symbols, assumptions };
}

/** Synthetic billing repository: one session makes getPrice return cents, another renders its result as dollars. */
export const PROBE_CONFLICT_BUNDLE: EvidenceBundle = {
  revision: 0,
  inputHash: 'probe-conflict',
  intents: [
    intent('probe-pricing', 'Change getPrice to return integer cents', ['src/pricing.ts'], [GET_PRICE], [{ key: GET_PRICE_UNIT, value: 'cents' }]),
    intent('probe-invoice', 'Render invoice totals from getPrice as dollars', ['src/invoice.ts'], [GET_PRICE, RENDER_INVOICE], [{ key: GET_PRICE_UNIT, value: 'dollars' }]),
  ],
  candidates: [{ kind: 'assumption_mismatch', severity: 'warning', sessions: ['probe-pricing', 'probe-invoice'], source: 'deterministic', symbols: [GET_PRICE], files: ['src/pricing.ts', 'src/invoice.ts'],
    evidence: `${GET_PRICE_UNIT}: probe-pricing assumes cents; probe-invoice assumes dollars` } satisfies Finding],
  contracts: [],
  symbols: [
    { key: GET_PRICE, file: 'src/pricing.ts', line: 3, kind: 'function', signature: 'getPrice(sku: string): number',
      excerpt: '/** Price of a SKU in integer cents (1999 means $19.99). */\nexport function getPrice(sku: string): number {\n  return PRICES[sku] ?? 0;\n}' },
    { key: RENDER_INVOICE, file: 'src/invoice.ts', line: 3, kind: 'function', signature: 'renderInvoice(skus: string[]): string',
      excerpt: 'export function renderInvoice(skus: string[]): string {\n  const total = skus.reduce((sum, sku) => sum + getPrice(sku), 0);\n  return `Total: $${total.toFixed(2)}`;\n}' },
  ],
  dependents: [{ symbol: GET_PRICE, from: RENDER_INVOICE, file: 'src/invoice.ts', line: 4 }],
};

/** Synthetic harmless overlap: two sessions touch src/pricing.ts in unrelated functions, sharing no symbol or assumption. */
export const PROBE_HARMLESS_BUNDLE: EvidenceBundle = {
  revision: 0,
  inputHash: 'probe-harmless',
  intents: [
    intent('probe-docs', 'Add a JSDoc comment to formatSku', ['src/pricing.ts'], [FORMAT_SKU], []),
    intent('probe-logging', 'Add a stderr log line to logPrice', ['src/pricing.ts'], [LOG_PRICE], []),
  ],
  candidates: [{ kind: 'file_overlap', severity: 'info', sessions: ['probe-docs', 'probe-logging'], source: 'deterministic', files: ['src/pricing.ts'],
    evidence: 'src/pricing.ts: probe-docs and probe-logging both declare this file' } satisfies Finding],
  contracts: [],
  symbols: [
    { key: FORMAT_SKU, file: 'src/pricing.ts', line: 9, kind: 'function', signature: 'formatSku(sku: string): string',
      excerpt: 'export function formatSku(sku: string): string {\n  return sku.trim().toUpperCase();\n}' },
    { key: LOG_PRICE, file: 'src/pricing.ts', line: 13, kind: 'function', signature: 'logPrice(sku: string, cents: number): void',
      excerpt: 'export function logPrice(sku: string, cents: number): void {\n  process.stderr.write(`${sku}: ${cents}\\n`);\n}' },
  ],
  dependents: [],
};

const CONFLICT_KINDS = new Set<ModelFindingKind>(['semantic_conflict', 'structural_conflict']);
/** What a conflict finding must cite: the shared symbol (also the prefix of the unit assumption key) or the unit values. */
const CONFLICT_CITATIONS = [GET_PRICE, 'cents', 'dollars'];

function conflictExpectation(result: AnalyzerResult): AnalysisProbe['expectation'] {
  const hit = result.findings.find(f => CONFLICT_KINDS.has(f.kind) && f.sessionIds.includes('probe-pricing') && f.sessionIds.includes('probe-invoice')
    && f.evidence.some(line => CONFLICT_CITATIONS.some(ref => line.includes(ref))));
  if (hit) return { met: true, detail: `${hit.kind} between probe-pricing and probe-invoice citing ${GET_PRICE} or its unit (confidence ${hit.confidence})` };
  const kinds = result.findings.map(f => f.kind);
  return { met: false, detail: kinds.length
    ? `expected a semantic_conflict between probe-pricing and probe-invoice citing ${GET_PRICE} or its unit assumption; got ${kinds.join(', ')}`
    : 'expected a semantic_conflict between probe-pricing and probe-invoice; the model returned no findings' };
}

function harmlessExpectation(result: AnalyzerResult): AnalysisProbe['expectation'] {
  const flagged = result.findings.filter(f => CONFLICT_KINDS.has(f.kind)).map(f => f.kind);
  if (flagged.length) return { met: false, detail: `expected no conflict between probe-docs and probe-logging; the model flagged ${flagged.join(', ')}` };
  const kinds = result.findings.map(f => f.kind);
  return { met: true, detail: kinds.length ? `no conflict flagged (${kinds.join(', ')} only)` : 'no conflict flagged (no findings)' };
}

function bound(text: string, max: number): string { return text.length > max ? text.slice(0, max) : text; }

async function analysisProbe(analyzer: ProbeAnalyzer, bundle: EvidenceBundle, expectation: (result: AnalyzerResult) => AnalysisProbe['expectation']): Promise<AnalysisProbe> {
  const started = Date.now();
  const clip = (text: string, max: number) => bound(analyzer.sanitize(text), max);
  try {
    const result = await analyzer.analyze(bundle, bundle.intents.map(i => i.sessionId));
    const findings: ProbeFinding[] = result.findings.slice(0, 10).map(f => ({ kind: f.kind, sessionIds: f.sessionIds.slice(0, 10), confidence: f.confidence,
      explanation: clip(f.explanation, 300), evidence: f.evidence.slice(0, 3).map(line => clip(line, 160)) }));
    return { status: 'ok', latencyMs: result.latencyMs, usage: result.usage, model: result.model === null ? null : clip(result.model, 120), summary: clip(result.summary, 300), findings,
      dropped: result.dropped.slice(0, 10).map(line => clip(line, 200)), error: null, expectation: expectation(result) };
  } catch (error) {
    const status = error instanceof AnalysisInvalid ? 'invalid' : 'unavailable';
    return { status, latencyMs: Date.now() - started, usage: null, model: null, summary: '', findings: [], dropped: [], error: clip(error instanceof Error ? error.message : String(error), 400),
      expectation: { met: false, detail: status === 'invalid' ? 'the model reply was not valid HiveAnalysis JSON' : 'the analysis did not run' } };
  }
}

export async function runModelProbe(analyzer: ProbeAnalyzer, clock: () => number = Date.now): Promise<ModelProbeReport> {
  const at = clock();
  const started = Date.now();
  const head = { provider: analyzer.provider, model: analyzer.model, baseUrlHost: analyzer.baseUrlHost, proxy: analyzer.proxy, configured: analyzer.configured };
  if (!analyzer.configured) {
    const error = `${PROVIDER_ENV[analyzer.provider].keyVar} is not set on the hub; nothing was sent`;
    const skipped: AnalysisProbe = { status: 'unavailable', latencyMs: 0, usage: null, model: null, summary: '', findings: [], dropped: [], error, expectation: { met: false, detail: 'not run' } };
    return { ...head, verdict: 'not_configured', at, latencyMs: 0, minimal: { status: null, latencyMs: 0, usage: null, replyExcerpt: '', requestIds: [], error }, conflict: skipped, harmless: skipped };
  }
  const [minimal, conflict, harmless] = await Promise.all([
    analyzer.minimalCompletion(),
    analysisProbe(analyzer, PROBE_CONFLICT_BUNDLE, conflictExpectation),
    analysisProbe(analyzer, PROBE_HARMLESS_BUNDLE, harmlessExpectation),
  ]);
  const minimalOk = minimal.status !== null && minimal.status >= 200 && minimal.status < 300;
  const verdict: ProbeVerdict = minimalOk && conflict.expectation.met && harmless.expectation.met ? 'pass' : 'fail';
  return { ...head, verdict, at, latencyMs: Date.now() - started, minimal, conflict, harmless };
}
