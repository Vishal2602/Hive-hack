import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MetaAnalyzer } from '../src/intelligence/meta.ts';
import { HiveService } from '../src/service.ts';
import { Store } from '../src/store/sqlite.ts';

const fixture = fileURLToPath(new URL('../fixtures/billing/', import.meta.url));
const PRODUCER = 'src/pricing.ts#getPrice:function';

type Handler = (url: string, init: RequestInit, attempt: number) => Response | Promise<Response>;
function fakeFetch(handler: Handler) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(url), init: init ?? {} }); return handler(String(url), init ?? {}, calls.length); }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}
const ok = (content: unknown, extra: Record<string, unknown> = {}) => new Response(JSON.stringify({ model: 'muse-spark-1.3', choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }], usage: { prompt_tokens: 1200, completion_tokens: 180, total_tokens: 1380 }, ...extra }), { status: 200 });
const goodFinding = (a: string, b: string) => ({ summary: 'getPrice unit disagreement', findings: [{ sessionIds: [a, b], kind: 'semantic_conflict', explanation: 'A returns cents, B formats dollars',
  evidence: [`${PRODUCER} currently returns 19.99 (dollars)`, 'src/pricing.ts#getPrice:unit: cents vs dollars'], suggestion: 'Make the unit explicit', proposedDeclaration: "export declare function getPrice(unit: 'cents' | 'dollars'): number;", behaviorNotes: '19.99 -> 1999', confidence: 'high' }] });

function setup(options: { fetch?: typeof fetch; apiKey?: string | null; maxAttempts?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hive-ai-'));
  cpSync(fixture, dir, { recursive: true });
  const sleeps: number[] = [];
  const analyzer = new MetaAnalyzer({ apiKey: options.apiKey === null ? undefined : options.apiKey ?? 'test-key', fetch: options.fetch ?? fakeFetch(() => ok(goodFinding('x', 'y'))).fetch,
    maxAttempts: options.maxAttempts ?? 3, sleep: async ms => { sleeps.push(ms); }, random: () => 0, timeoutMs: 50 });
  const service = new HiveService({ store: new Store(), root: dir, analyzer });
  const a = service.coordinator.register('pricing'); const b = service.coordinator.register('invoice'); const c = service.coordinator.register('ui');
  service.coordinator.setIntent(a.id, { task: 'cents', files: ['src/pricing.ts'], symbols: [PRODUCER], assumptions: [{ key: 'src/pricing.ts#getPrice:unit', value: 'cents' }] });
  service.coordinator.setIntent(b.id, { task: 'invoice', files: ['src/invoice.ts'], symbols: ['src/invoice.ts#invoiceTotal:function'], assumptions: [{ key: 'src/pricing.ts#getPrice:unit', value: 'dollars' }] });
  service.coordinator.setIntent(c.id, { task: 'label', files: ['src/button.ts'], symbols: ['src/button.ts#buttonLabel:variable'], assumptions: [] });
  return { service, a, b, c, sleeps, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('without MODEL_API_KEY the analysis is explicitly unavailable, never "no conflict"', async () => {
  const { service, a, cleanup } = setup({ apiKey: null });
  try {
    const analysis = await service.analyze(a.id);
    assert.equal(analysis.status, 'unavailable');
    assert.match(analysis.error!, /MODEL_API_KEY/);
    assert.equal(service.snapshot().model.configured, false);
    assert.equal(service.snapshot().analysis!.status, 'unavailable');
    assert.ok(service.snapshot().findings.some(f => f.kind === 'assumption_mismatch'), 'deterministic findings are unaffected');
  } finally { cleanup(); }
});

test('bounded evidence bundle: real declarations, dependents, candidates; no secrets; structured output requested', async () => {
  let a = ''; let b = '';
  const { fetch, calls } = fakeFetch(() => ok(goodFinding(a, b)));
  const ctx = setup({ fetch });
  a = ctx.a.id; b = ctx.b.id;
  try {
    const analysis = await ctx.service.analyze(ctx.a.id);
    assert.equal(analysis.status, 'ok', analysis.error ?? '');
    assert.equal(analysis.findings.length, 1);
    assert.equal(analysis.model, 'muse-spark-1.3');
    assert.deepEqual(analysis.usage, { promptTokens: 1200, completionTokens: 180, totalTokens: 1380 });
    assert.ok(analysis.latencyMs! >= 0);
    assert.equal(analysis.attempts, 1);
    assert.ok(analysis.evidenceRefs.symbols.includes(PRODUCER));
    const request = JSON.parse(String(calls[0]!.init.body)) as { model: string; response_format: { type: string; json_schema: { name: string } }; messages: { role: string; content: string }[] };
    assert.equal(request.model, 'muse-spark-1.3');
    assert.equal(request.response_format.type, 'json_schema');
    assert.equal(request.response_format.json_schema.name, 'HiveAnalysis');
    assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, 'Bearer test-key');
    const bundle = JSON.parse(request.messages[1]!.content) as { symbols: { key: string; excerpt: string; signature: string }[]; dependents: { from: string }[]; candidates: { kind: string }[]; intents: unknown[] };
    assert.ok(bundle.symbols.some(s => s.key === PRODUCER && s.excerpt.includes('return 19.99') && s.signature === 'getPrice(): number'));
    assert.ok(bundle.dependents.some(d => d.from === 'src/invoice.ts#invoiceTotal:function'));
    assert.ok(bundle.candidates.some(c => c.kind === 'assumption_mismatch') && bundle.candidates.some(c => c.kind === 'dependent_write'));
    assert.equal(bundle.intents.length, 3);
    assert.ok(!String(calls[0]!.init.body).includes('test-key'), 'key never inside the prompt');
    assert.ok(Buffer.byteLength(String(calls[0]!.init.body)) < 200_000);
    assert.ok(ctx.service.coordinator.events().some(e => e.type === 'analysis.ok'));
  } finally { ctx.cleanup(); }
});

test('results are cached by input hash and recomputed after an intent change', async () => {
  let a = ''; let b = '';
  const { fetch, calls } = fakeFetch(() => ok(goodFinding(a, b)));
  const ctx = setup({ fetch });
  a = ctx.a.id; b = ctx.b.id;
  try {
    assert.equal((await ctx.service.analyze(ctx.a.id)).status, 'ok');
    const second = await ctx.service.analyze(ctx.b.id);
    assert.equal(second.status, 'cached');
    assert.equal(calls.length, 1);
    ctx.service.coordinator.setIntent(ctx.c.id, { task: 'label v2', files: ['src/button.ts'], symbols: [], assumptions: [] });
    assert.equal((await ctx.service.analyze(ctx.a.id)).status, 'ok');
    assert.equal(calls.length, 2);
    assert.equal((await ctx.service.analyze(ctx.a.id, { force: true })).status, 'ok');
    assert.equal(calls.length, 3);
  } finally { ctx.cleanup(); }
});

test('malformed model output is an explicit invalid state', async () => {
  const ctx = setup({ fetch: fakeFetch(() => ok('{"summary": "oops", "findings": [{"nope": true}]')).fetch });
  try {
    const analysis = await ctx.service.analyze(ctx.a.id);
    assert.equal(analysis.status, 'invalid');
    assert.match(analysis.error!, /Malformed model output/);
    assert.equal(analysis.findings.length, 0);
    const envelope = setup({ fetch: fakeFetch(() => new Response('not json', { status: 200 })).fetch });
    try { assert.match((await envelope.service.analyze(envelope.a.id)).error!, /Malformed API envelope/); } finally { envelope.cleanup(); }
  } finally { ctx.cleanup(); }
});

test('timeouts retry with bounded backoff, then surface as unavailable', async () => {
  const { fetch, calls } = fakeFetch(() => { const error = new Error('The operation was aborted due to timeout'); error.name = 'TimeoutError'; throw error; });
  const ctx = setup({ fetch, maxAttempts: 3 });
  try {
    const analysis = await ctx.service.analyze(ctx.a.id);
    assert.equal(analysis.status, 'unavailable');
    assert.equal(analysis.attempts, 3);
    assert.equal(calls.length, 3);
    assert.deepEqual(ctx.sleeps, [500, 1000]);
    assert.match(analysis.error!, /TimeoutError/);
  } finally { ctx.cleanup(); }
});

test('429 honors Retry-After then succeeds; 400 is not retried; 504 is not retried', async () => {
  let a = ''; let b = '';
  const { fetch, calls } = fakeFetch((_url, _init, attempt) => attempt === 1
    ? new Response(JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit' } }), { status: 429, headers: { 'retry-after': '2' } })
    : ok(goodFinding(a, b)));
  const ctx = setup({ fetch });
  a = ctx.a.id; b = ctx.b.id;
  try {
    const analysis = await ctx.service.analyze(ctx.a.id);
    assert.equal(analysis.status, 'ok');
    assert.equal(analysis.attempts, 2);
    assert.equal(calls.length, 2);
    assert.deepEqual(ctx.sleeps, [2000]);
  } finally { ctx.cleanup(); }
  const bad = fakeFetch(() => new Response(JSON.stringify({ error: { message: '`top_p` invalid', type: 'invalid_request_error' } }), { status: 400 }));
  const ctx400 = setup({ fetch: bad.fetch });
  try {
    const analysis = await ctx400.service.analyze(ctx400.a.id);
    assert.equal(analysis.status, 'unavailable');
    assert.equal(bad.calls.length, 1);
    assert.match(analysis.error!, /HTTP 400: `top_p` invalid/);
  } finally { ctx400.cleanup(); }
  const gateway = fakeFetch(() => new Response('', { status: 504 }));
  const ctx504 = setup({ fetch: gateway.fetch });
  try { assert.match((await ctx504.service.analyze(ctx504.a.id)).error!, /HTTP 504.*not retried/); assert.equal(gateway.calls.length, 1); } finally { ctx504.cleanup(); }
});

test('findings that cite nothing from the evidence or reference unknown sessions are dropped, not trusted', async () => {
  let a = '';
  const { fetch } = fakeFetch(() => ok({ summary: 'mixed', findings: [
    { sessionIds: [a, 'ghost-session'], kind: 'semantic_conflict', explanation: 'unknown peer', evidence: [PRODUCER], suggestion: '', confidence: 'high' },
    { sessionIds: [a], kind: 'semantic_conflict', explanation: 'no citations', evidence: ['trust me'], suggestion: '', confidence: 'high' },
    { sessionIds: [a], kind: 'semantic_conflict', explanation: 'any smuggled', evidence: [PRODUCER], suggestion: '', proposedDeclaration: 'export declare function getPrice(u: any): number;', confidence: 'high' },
    { sessionIds: [a], kind: 'harmless_overlap', explanation: 'fine', evidence: ['src/pricing.ts'], suggestion: 'none', confidence: 'medium' },
  ] }));
  const ctx = setup({ fetch });
  a = ctx.a.id;
  try {
    const analysis = await ctx.service.analyze(ctx.a.id);
    assert.equal(analysis.status, 'ok');
    assert.equal(analysis.findings.length, 1);
    assert.equal(analysis.findings[0]!.kind, 'harmless_overlap');
    assert.equal(analysis.dropped.length, 3);
    assert.match(analysis.dropped.join('\n'), /unknown session/);
    assert.match(analysis.dropped.join('\n'), /cited no symbol/);
    assert.match(analysis.dropped.join('\n'), /any/);
  } finally { ctx.cleanup(); }
});

test('inputs that change during the model call make the result stale and uncached', async () => {
  let a = ''; let b = '';
  let ctx: ReturnType<typeof setup> | undefined;
  const { fetch, calls } = fakeFetch(() => {
    if (calls.length === 1) ctx!.service.coordinator.setIntent(ctx!.c.id, { task: 'changed mid-flight', files: ['src/button.ts'], symbols: [], assumptions: [] });
    return ok(goodFinding(a, b));
  });
  ctx = setup({ fetch });
  a = ctx.a.id; b = ctx.b.id;
  try {
    const analysis = await ctx.service.analyze(ctx.a.id);
    assert.equal(analysis.status, 'stale');
    assert.match(analysis.error!, /changed during analysis/);
    assert.equal(analysis.findings.length, 1, 'kept for reference');
    const again = await ctx.service.analyze(ctx.a.id);
    assert.equal(again.status, 'ok', 'stale results are not served from cache');
    assert.equal(calls.length, 2);
  } finally { ctx.cleanup(); }
});
