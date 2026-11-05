import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MetaAnalyzer, PROVIDER_LABEL, RESPONSE_JSON_SCHEMA, SYSTEM_PROMPT, createAnalyzer, diagnoseVerdict } from '../src/intelligence/meta.ts';
import { PROBE_CONFLICT_BUNDLE, PROBE_HARMLESS_BUNDLE } from '../src/intelligence/probes.ts';
import type { EvidenceBundle } from '../src/intelligence/types.ts';
import { authorizeCommand } from '../src/server/auth.ts';
import { commandSchema } from '../src/server/schemas.ts';
import { HiveService } from '../src/service.ts';
import { Store } from '../src/store/sqlite.ts';

const KEY = 'throwaway-fireworks-key-456';
const MODEL = 'accounts/fireworks/models/muse-spark-open';
const CONFLICT_SESSIONS = ['probe-pricing', 'probe-invoice'];
type Reply = { status: number; body: unknown; headers?: Record<string, string> };
type Seen = { method: string; url: string; auth: string; body: string };
type ChatRoute = Reply | ((body: Record<string, unknown>, seen: Seen[]) => Reply);

/** Fake OpenAI-compatible provider on 127.0.0.1. The chat route may inspect the request body (the probe sends three different ones). */
async function provider(routes: { models?: Reply; chat: ChatRoute; ip?: Reply }) {
  const seen: Seen[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', chunk => { body += String(chunk); });
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', auth: String(req.headers.authorization ?? ''), body });
      const reply: Reply = req.url === '/v1/models' ? routes.models ?? { status: 404, body: 'Error listing deployed models' }
        : req.url === '/v1/chat/completions' ? (typeof routes.chat === 'function' ? routes.chat(JSON.parse(body) as Record<string, unknown>, seen) : routes.chat)
        : req.url === '/ip' ? routes.ip ?? { status: 200, body: { ip: '203.0.113.9' } } : { status: 404, body: {} };
      res.writeHead(reply.status, { 'Content-Type': 'application/json', ...reply.headers }).end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  return { seen, base: `http://127.0.0.1:${port}`, port, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
type Options = ConstructorParameters<typeof MetaAnalyzer>[0];
/** A Fireworks analyzer against the fake, hermetic (env: {}) so the shell's variables never leak in. */
function fireworks(base: string, options: Options = {}) {
  return new MetaAnalyzer({ provider: 'fireworks', env: {}, apiKey: KEY, baseUrl: `${base}/v1`, proxyUrl: null, ipLookupUrl: `${base}/ip`, maxAttempts: 1, timeoutMs: 2000, sleep: async () => {}, random: () => 0, ...options });
}
const envelope = (content: unknown, finish: string | null = 'stop', extra: Record<string, unknown> = {}) => ({ model: MODEL,
  choices: [{ message: { content: content === null ? null : typeof content === 'string' ? content : JSON.stringify(content) }, finish_reason: finish }],
  usage: { prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020 }, ...extra });
const CONFLICT_REPLY = envelope({ summary: 'getPrice unit disagreement', findings: [{ sessionIds: CONFLICT_SESSIONS, kind: 'semantic_conflict', explanation: 'probe-pricing returns cents while probe-invoice formats the value as dollars',
  evidence: ['src/pricing.ts#getPrice:function', 'src/pricing.ts#getPrice:function:unit: cents vs dollars', 'src/invoice.ts#renderInvoice:function uses toFixed(2)', 'extra citation src/pricing.ts'],
  suggestion: 'Agree on integer cents', proposedDeclaration: 'export declare function getPrice(sku: string): number;', behaviorNotes: '1999 renders as $19.99', confidence: 'high' }] });
const HARMLESS_REPLY = envelope({ summary: 'Unrelated edits to the same file', findings: [] });
/** Routes the three probe requests by their bodies: minimal (max_tokens 8), conflict (probe-pricing), harmless (probe-docs). */
function probeRoutes(overrides: { minimal?: Reply; conflict?: Reply; harmless?: Reply } = {}): ChatRoute {
  return body => {
    if (body.max_tokens === 8) return overrides.minimal ?? { status: 200, body: envelope('OK'), headers: { 'x-request-id': 'fw-min' } };
    const user = (body.messages as { content: string }[])[1]!.content;
    if (user.includes('probe-pricing')) return overrides.conflict ?? { status: 200, body: CONFLICT_REPLY };
    if (user.includes('probe-docs')) return overrides.harmless ?? { status: 200, body: HARMLESS_REPLY };
    return { status: 500, body: 'unexpected request' };
  };
}
const fixture = fileURLToPath(new URL('../fixtures/billing/', import.meta.url));
function hive(base: string, analyzerOptions: Options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hive-provider-'));
  cpSync(fixture, dir, { recursive: true });
  const service = new HiveService({ store: new Store(), root: dir, analyzer: fireworks(base, analyzerOptions),
    analyzerFor: (provider, overrides) => fireworks(base, { ...analyzerOptions, provider, ...overrides }) });
  return { service, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ---- 1. configuration -------------------------------------------------------------------------------------
test('createAnalyzer: meta is the default and reads only its variables; fireworks reads FIREWORKS_* with the documented defaults', () => {
  const meta = createAnalyzer({ MODEL_API_KEY: 'meta-key', HIVE_MODEL: 'muse-x', HIVE_MODEL_BASE_URL: 'https://meta.example/v1/', FIREWORKS_API_KEY: 'fw-key', HIVE_FIREWORKS_MODEL: 'ignored' });
  assert.equal(meta.provider, 'meta');
  assert.equal(meta.configured, true);
  assert.equal(meta.model, 'muse-x');
  assert.equal(meta.baseUrl, 'https://meta.example/v1');
  assert.equal(meta.label, 'Meta Model API');
  const defaults = createAnalyzer({ HIVE_MODEL_PROVIDER: 'fireworks' });
  assert.equal(defaults.provider, 'fireworks');
  assert.equal(defaults.configured, false);
  assert.equal(defaults.model, MODEL);
  assert.equal(defaults.baseUrl, 'https://api.fireworks.ai/inference/v1');
  assert.equal(defaults.baseUrlHost, 'api.fireworks.ai');
  assert.equal(defaults.timeoutMs, 30_000);
  assert.equal(defaults.label, 'Fireworks (Muse Spark Open)');
  const custom = createAnalyzer({ HIVE_MODEL_PROVIDER: ' "fireworks" ', FIREWORKS_API_KEY: ' fw-key ', HIVE_FIREWORKS_MODEL: 'accounts/acme/models/custom', HIVE_FIREWORKS_BASE_URL: 'https://fw.example/inference/v1/', HIVE_MODEL: 'meta-model-ignored' });
  assert.equal(custom.provider, 'fireworks');
  assert.equal(custom.configured, true);
  assert.equal(custom.model, 'accounts/acme/models/custom');
  assert.equal(custom.baseUrl, 'https://fw.example/inference/v1');
  assert.equal(createAnalyzer({ HIVE_MODEL_PROVIDER: '' }).provider, 'meta');
  assert.equal(createAnalyzer({ HIVE_MODEL_PROVIDER: 'meta' }).provider, 'meta');
  assert.equal(createAnalyzer({}, { provider: 'fireworks' }).provider, 'fireworks', 'an explicit override wins over the environment');
  assert.deepEqual(PROVIDER_LABEL, { meta: 'Meta Model API', fireworks: 'Fireworks (Muse Spark Open)' });
});

test('fireworks never reads MODEL_API_KEY: with only the Meta key set it is not configured and sends nothing', async () => {
  const p = await provider({ chat: { status: 200, body: envelope({ summary: '', findings: [] }) } });
  try {
    const analyzer = createAnalyzer({ HIVE_MODEL_PROVIDER: 'fireworks', MODEL_API_KEY: 'meta-only-key', HIVE_FIREWORKS_BASE_URL: `${p.base}/v1` }, { ipLookupUrl: `${p.base}/ip`, timeoutMs: 2000 });
    assert.equal(analyzer.configured, false);
    const diagnosis = await analyzer.diagnose();
    assert.equal(diagnosis.verdict, 'not_configured');
    assert.equal(diagnosis.provider, 'fireworks');
    assert.match(diagnosis.hints.join(' '), /Set FIREWORKS_API_KEY in the hub's environment/);
    assert.doesNotMatch(diagnosis.hints.join(' '), /MODEL_API_KEY/);
    await assert.rejects(analyzer.analyze(PROBE_CONFLICT_BUNDLE, CONFLICT_SESSIONS), (error: Error) => error.name === 'AnalysisUnavailable' && /Details: FIREWORKS_API_KEY is not set on the hub/.test(error.message));
    assert.deepEqual(p.seen.filter(s => s.url.startsWith('/v1')), [], 'nothing reached the provider');
    assert.ok(p.seen.every(s => !s.auth.includes('meta-only-key') && !s.body.includes('meta-only-key')));
  } finally { await p.close(); }
});

test('an unknown HIVE_MODEL_PROVIDER fails loudly at construction (the hub does not start), never falls back', () => {
  assert.throws(() => createAnalyzer({ HIVE_MODEL_PROVIDER: 'openai' }), { message: 'HIVE_MODEL_PROVIDER must be "meta" or "fireworks" (got "openai")' });
  assert.throws(() => new MetaAnalyzer({ env: { HIVE_MODEL_PROVIDER: 'Fireworks' } }), /got "Fireworks"/);
  const dir = mkdtempSync(join(tmpdir(), 'hive-provider-'));
  cpSync(fixture, dir, { recursive: true });
  const saved = process.env.HIVE_MODEL_PROVIDER;
  process.env.HIVE_MODEL_PROVIDER = 'together';
  try { assert.throws(() => new HiveService({ store: new Store(), root: dir }), /HIVE_MODEL_PROVIDER must be "meta" or "fireworks" \(got "together"\)/); }
  finally { if (saved === undefined) delete process.env.HIVE_MODEL_PROVIDER; else process.env.HIVE_MODEL_PROVIDER = saved; rmSync(dir, { recursive: true, force: true }); }
});

test('HIVE_MODEL_TIMEOUT_MS: default 30 s, clamped to 5..120 s, non-numeric means the default; an explicit option is taken as is', () => {
  for (const [value, expected] of [['1000', 5000], ['999999', 120_000], ['45000', 45000], ['abc', 30_000], ['', 30_000], [undefined, 30_000], ['0', 5000]] as const) {
    assert.equal(createAnalyzer({ HIVE_MODEL_TIMEOUT_MS: value }).timeoutMs, expected, `HIVE_MODEL_TIMEOUT_MS=${String(value)}`);
  }
  assert.equal(createAnalyzer({ HIVE_MODEL_TIMEOUT_MS: '1000' }, { timeoutMs: 50 }).timeoutMs, 50);
});

// ---- 2. request body ---------------------------------------------------------------------------------------
test('requestBody: the Meta body is byte-identical to the pre-change shape; Fireworks adds max_tokens and the schema in the prompt', () => {
  const bundle: EvidenceBundle = { revision: 3, inputHash: 'h', intents: [], candidates: [], contracts: [], symbols: [], dependents: [] };
  const meta = new MetaAnalyzer({ provider: 'meta', env: {}, apiKey: 'k', proxyUrl: null });
  const before = JSON.stringify({ model: 'muse-spark-1.3', temperature: 0,
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: JSON.stringify(bundle) }],
    response_format: { type: 'json_schema', json_schema: { name: 'HiveAnalysis', schema: RESPONSE_JSON_SCHEMA } } });
  assert.equal(meta.requestBody(bundle), before);
  assert.equal(meta.requestBody(bundle).includes('max_tokens'), false);
  const fw = new MetaAnalyzer({ provider: 'fireworks', env: {}, apiKey: 'k', proxyUrl: null });
  const body = JSON.parse(fw.requestBody(bundle)) as { model: string; temperature: number; max_tokens: number; messages: { role: string; content: string }[]; response_format: unknown };
  assert.equal(body.model, MODEL);
  assert.equal(body.temperature, 0);
  assert.equal(body.max_tokens, 4096);
  assert.equal(body.messages.length, 2);
  assert.ok(body.messages[0]!.content.startsWith(SYSTEM_PROMPT));
  assert.ok(body.messages[0]!.content.includes(`Respond with a single JSON object matching this JSON schema: ${JSON.stringify(RESPONSE_JSON_SCHEMA)}`));
  assert.equal(body.messages[1]!.content, JSON.stringify(bundle));
  assert.deepEqual(body.response_format, { type: 'json_schema', json_schema: { name: 'HiveAnalysis', schema: RESPONSE_JSON_SCHEMA } });
});

// ---- 3. analyze --------------------------------------------------------------------------------------------
test('analyze (fireworks): a valid HiveAnalysis reply parses with usage and model; the hub key and max_tokens are sent', async () => {
  const p = await provider({ chat: { status: 200, body: CONFLICT_REPLY } });
  try {
    const result = await fireworks(p.base).analyze(PROBE_CONFLICT_BUNDLE, CONFLICT_SESSIONS);
    assert.equal(result.model, MODEL);
    assert.deepEqual(result.usage, { promptTokens: 900, completionTokens: 120, totalTokens: 1020 });
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]!.kind, 'semantic_conflict');
    assert.equal(result.attempts, 1);
    assert.deepEqual(result.dropped, []);
    const sent = p.seen.find(s => s.url === '/v1/chat/completions')!;
    assert.equal(sent.auth, `Bearer ${KEY}`);
    const body = JSON.parse(sent.body) as { model: string; max_tokens: number };
    assert.equal(body.model, MODEL);
    assert.equal(body.max_tokens, 4096);
  } finally { await p.close(); }
});

test('analyze (fireworks): finish_reason length and malformed content are explicit invalid results, never an empty success', async () => {
  const invalid = (error: Error, pattern: RegExp) => { assert.equal(error.name, 'AnalysisInvalid'); assert.match(error.message, pattern); return true; };
  const truncated = await provider({ chat: { status: 200, body: envelope('{"summary": "cut off mid', 'length') } });
  try { await assert.rejects(fireworks(truncated.base).analyze(PROBE_CONFLICT_BUNDLE, CONFLICT_SESSIONS), e => invalid(e as Error, /^Model output was truncated \(finish_reason=length\) before the JSON was complete; the analysis is invalid, not empty$/)); }
  finally { await truncated.close(); }
  // Parseable but cut off is still truncated: the finish reason wins.
  const parseable = await provider({ chat: { status: 200, body: envelope({ summary: 'x', findings: [] }, 'length') } });
  try { await assert.rejects(fireworks(parseable.base).analyze(PROBE_CONFLICT_BUNDLE, CONFLICT_SESSIONS), e => invalid(e as Error, /truncated \(finish_reason=length\)/)); }
  finally { await parseable.close(); }
  const malformed = await provider({ chat: { status: 200, body: envelope('not json at all') } });
  try { await assert.rejects(fireworks(malformed.base).analyze(PROBE_CONFLICT_BUNDLE, CONFLICT_SESSIONS), e => invalid(e as Error, /^Malformed model output \(expected HiveAnalysis JSON\)/)); }
  finally { await malformed.close(); }
  const empty = await provider({ chat: { status: 200, body: envelope(null) } });
  try { await assert.rejects(fireworks(empty.base).analyze(PROBE_CONFLICT_BUNDLE, CONFLICT_SESSIONS), e => invalid(e as Error, /^Malformed model output/)); }
  finally { await empty.close(); }
});

test('analyze (fireworks): 402 and 412 are unavailable without a retry; 404 names HIVE_FIREWORKS_MODEL; 429 then 200 is retried once; echoed keys are redacted', async () => {
  const billing = await provider({ chat: { status: 402, body: { error: { message: `Payment required for key ${KEY}` } } } });
  try {
    await assert.rejects(fireworks(billing.base, { maxAttempts: 3 }).analyze(PROBE_CONFLICT_BUNDLE, CONFLICT_SESSIONS), (error: Error) => {
      assert.equal(error.name, 'AnalysisUnavailable');
      assert.match(error.message, /^The model provider reports a billing problem for this server's account \(HTTP 402\)\. Details: Fireworks \(Muse Spark Open\) HTTP 402: Payment required for key \[redacted\] after 1 attempt\(s\)\./);
      assert.equal(error.message.includes(KEY), false);
      return true;
    });
    assert.equal(billing.seen.filter(s => s.url === '/v1/chat/completions').length, 1, '402 is not retried');
  } finally { await billing.close(); }
  const suspended = await provider({ chat: { status: 412, body: 'account suspended' } });
  try {
    await assert.rejects(fireworks(suspended.base, { maxAttempts: 3 }).analyze(PROBE_CONFLICT_BUNDLE, CONFLICT_SESSIONS), (error: Error) => {
      assert.equal(error.name, 'AnalysisUnavailable');
      assert.match(error.message, /^The model provider reports an account problem for this server's account \(HTTP 412\)\. Details: Fireworks \(Muse Spark Open\) HTTP 412: account suspended after 1 attempt\(s\)/);
      return true;
    });
    assert.equal(suspended.seen.filter(s => s.url === '/v1/chat/completions').length, 1, '412 is not retried');
  } finally { await suspended.close(); }
  const missing = await provider({ chat: { status: 404, body: { error: { message: 'Model not found, inaccessible, and/or not deployed' } } } });
  try {
    await assert.rejects(fireworks(missing.base).analyze(PROBE_CONFLICT_BUNDLE, CONFLICT_SESSIONS), (error: Error) => {
      assert.match(error.message, /^The model provider does not serve the configured model \(HTTP 404, model not found or not deployed\)\. Details: Fireworks \(Muse Spark Open\) HTTP 404: Model not found/);
      assert.match(error.message, /check HIVE_FIREWORKS_MODEL and HIVE_FIREWORKS_BASE_URL/);
      assert.doesNotMatch(error.message, /HIVE_MODEL_PROXY_URL|pass-through|HIVE_MODEL_BASE_URL/);
      return true;
    });
  } finally { await missing.close(); }
  const limited = await provider({ chat: (_body, seen) => seen.filter(s => s.url === '/v1/chat/completions').length === 1
    ? { status: 429, body: { error: { message: 'rate limited' } }, headers: { 'retry-after': '1' } } : { status: 200, body: HARMLESS_REPLY } });
  try {
    const sleeps: number[] = [];
    const result = await fireworks(limited.base, { maxAttempts: 3, sleep: async ms => { sleeps.push(ms); } }).analyze(PROBE_HARMLESS_BUNDLE, ['probe-docs', 'probe-logging']);
    assert.equal(result.attempts, 2);
    assert.deepEqual(sleeps, [1000]);
    assert.equal(limited.seen.filter(s => s.url === '/v1/chat/completions').length, 2);
  } finally { await limited.close(); }
});

// ---- 4. diagnose -------------------------------------------------------------------------------------------
test('diagnose (fireworks): a working completion is reachable even when GET /models fails; the list is informational only', async () => {
  const p = await provider({ models: { status: 404, body: 'Error listing deployed models' }, chat: { status: 200, body: envelope('OK'), headers: { 'x-request-id': 'fw-chat' } } });
  try {
    const result = await fireworks(p.base).diagnose();
    assert.equal(result.verdict, 'reachable');
    assert.equal(result.provider, 'fireworks');
    assert.equal(result.model, MODEL);
    assert.equal(result.configured, true);
    assert.equal(result.modelsStatus, 404);
    assert.equal(result.modelListed, null);
    assert.match(result.modelsExcerpt, /^informational \(not a serverless model list\): Error listing deployed models/);
    assert.equal(result.chatStatus, 200);
    assert.equal(result.egressIp, '203.0.113.9');
    assert.deepEqual(result.requestIds, ['chat x-request-id=fw-chat']);
    assert.match(result.hints[0]!, /The model answered from this hub \(this hub reaches 127\.0\.0\.1:\d+ from 203\.0\.113\.9\)/);
    assert.doesNotMatch(result.hints.join(' '), /HIVE_MODEL_PROXY_URL|pass-through|laptop relay|HIVE_MODEL\b/);
    const chat = p.seen.find(s => s.url === '/v1/chat/completions')!;
    assert.equal(chat.auth, `Bearer ${KEY}`);
    assert.equal((JSON.parse(chat.body) as { max_tokens: number }).max_tokens, 1);
    assert.equal(JSON.stringify(result).includes(KEY), false);
  } finally { await p.close(); }
});

test('diagnose (fireworks): 404 is model_not_found naming HIVE_FIREWORKS_MODEL; 401 is key_rejected naming FIREWORKS_API_KEY; 402 explains billing', async () => {
  const missing = await provider({ chat: { status: 404, body: { error: { message: `Model not found for ${KEY}` } } } });
  try {
    const result = await fireworks(missing.base).diagnose();
    assert.equal(result.verdict, 'model_not_found');
    assert.equal(result.chatStatus, 404);
    assert.match(result.chatExcerpt, /Model not found for \[redacted\]/);
    assert.match(result.hints[0]!, /HTTP 404 for "accounts\/fireworks\/models\/muse-spark-open".*Check HIVE_FIREWORKS_MODEL/);
    assert.doesNotMatch(result.hints.join(' '), /HIVE_MODEL_PROXY_URL|laptop relay|pass-through/);
  } finally { await missing.close(); }
  const rejected = await provider({ chat: { status: 401, body: { error: { message: 'invalid api key' } } } });
  try {
    const result = await fireworks(rejected.base).diagnose();
    assert.equal(result.verdict, 'key_rejected');
    assert.match(result.hints[0]!, /rejected the key \(HTTP 401\)\. Check FIREWORKS_API_KEY on the hub/);
    assert.doesNotMatch(result.hints.join(' '), /MODEL_API_KEY/);
  } finally { await rejected.close(); }
  const billing = await provider({ chat: { status: 402, body: { error: { message: 'payment required' } } } });
  try {
    const result = await fireworks(billing.base).diagnose();
    assert.equal(result.verdict, 'network_error');
    assert.match(result.hints[0]!, /answered HTTP 402/);
    assert.match(result.hints[1]!, /billing problem.*FIREWORKS_API_KEY/);
  } finally { await billing.close(); }
  const limited = await provider({ chat: { status: 429, body: {}, headers: { 'retry-after': '3' } } });
  try {
    const result = await fireworks(limited.base).diagnose();
    assert.equal(result.verdict, 'rate_limited');
    assert.match(result.hints[0]!, /Retry-After 3 s.*Fireworks serverless applies per-account/);
  } finally { await limited.close(); }
});

test('verdict order: a working chat outranks the model list, then key, rate limit, 404 per provider, empty Meta list', () => {
  assert.equal(diagnoseVerdict(401, null, 200), 'reachable', 'a working completion wins over a 401 from GET /models');
  assert.equal(diagnoseVerdict(404, null, 200, 'fireworks'), 'reachable');
  assert.equal(diagnoseVerdict(404, null, 401, 'fireworks'), 'key_rejected');
  assert.equal(diagnoseVerdict(200, 2, 429), 'rate_limited');
  assert.equal(diagnoseVerdict(200, 3, 404, 'meta'), 'no_models_for_host');
  assert.equal(diagnoseVerdict(404, null, 404, 'fireworks'), 'model_not_found');
  assert.equal(diagnoseVerdict(200, 0, 500, 'meta'), 'no_models_for_host', 'an empty Meta list explains a failing chat');
  assert.equal(diagnoseVerdict(200, 0, 500, 'fireworks'), 'network_error', 'the Fireworks list is never a verdict input');
  assert.equal(diagnoseVerdict(null, null, null, 'fireworks'), 'network_error');
});

// ---- 5. model_probe ----------------------------------------------------------------------------------------
test('model_probe: a correct conflict reply and a clean harmless reply pass, with latencies and usage; nothing is written or emitted', async () => {
  const p = await provider({ chat: probeRoutes() });
  const ctx = hive(p.base);
  try {
    const rows = () => Number(ctx.service.store.get<{ n: number }>('SELECT COUNT(*) AS n FROM analyses')!.n);
    const rowsBefore = rows();
    const eventsBefore = ctx.service.coordinator.events(0, 1000).length;
    const report = await ctx.service.analysis.probe('fireworks');
    assert.equal(report.verdict, 'pass', JSON.stringify(report));
    assert.equal(report.provider, 'fireworks');
    assert.equal(report.model, MODEL);
    assert.equal(report.baseUrlHost, `127.0.0.1:${p.port}`);
    assert.equal(report.proxy, false);
    assert.equal(report.configured, true);
    assert.ok(report.latencyMs >= 0 && report.at > 0);
    assert.equal(report.minimal.status, 200);
    assert.equal(report.minimal.replyExcerpt, 'OK');
    assert.deepEqual(report.minimal.usage, { promptTokens: 900, completionTokens: 120, totalTokens: 1020 });
    assert.deepEqual(report.minimal.requestIds, ['x-request-id=fw-min']);
    assert.equal(report.minimal.error, null);
    assert.ok(report.minimal.latencyMs >= 0);
    assert.equal(report.conflict.status, 'ok');
    assert.equal(report.conflict.expectation.met, true, report.conflict.expectation.detail);
    assert.equal(report.conflict.model, MODEL);
    assert.deepEqual(report.conflict.usage, { promptTokens: 900, completionTokens: 120, totalTokens: 1020 });
    assert.ok(report.conflict.latencyMs >= 0);
    assert.equal(report.conflict.findings.length, 1);
    assert.equal(report.conflict.findings[0]!.kind, 'semantic_conflict');
    assert.deepEqual(report.conflict.findings[0]!.sessionIds, CONFLICT_SESSIONS);
    assert.equal(report.conflict.findings[0]!.evidence.length, 3, 'evidence is capped at three items');
    assert.equal(report.harmless.status, 'ok');
    assert.equal(report.harmless.expectation.met, true);
    assert.deepEqual(report.harmless.findings, []);
    assert.equal(rows(), rowsBefore, 'the probe writes no analyses row');
    assert.equal(ctx.service.coordinator.events(0, 1000).length, eventsBefore, 'the probe emits no event');
    assert.equal(ctx.service.analysis.latest(), null);
    assert.equal(JSON.stringify(report).includes(KEY), false);
    const chats = p.seen.filter(s => s.url === '/v1/chat/completions');
    assert.equal(chats.length, 3);
    assert.ok(chats.every(s => s.auth === `Bearer ${KEY}`));
    const bodies = chats.map(s => JSON.parse(s.body) as { max_tokens: number; temperature: number; messages: { content: string }[] });
    assert.deepEqual(bodies.map(b => b.max_tokens).sort((a, b) => a - b), [8, 4096, 4096]);
    assert.ok(bodies.every(b => b.temperature === 0));
    assert.equal(bodies.find(b => b.max_tokens === 8)!.messages[0]!.content, 'Reply with the single word OK.');
  } finally { ctx.cleanup(); await p.close(); }
});

test('model_probe: a harmless reply that flags a conflict fails that expectation and the verdict', async () => {
  const flagged = envelope({ summary: 'conflict', findings: [{ sessionIds: ['probe-docs', 'probe-logging'], kind: 'semantic_conflict', explanation: 'same file', evidence: ['src/pricing.ts'], suggestion: '', confidence: 'low' }] });
  const p = await provider({ chat: probeRoutes({ harmless: { status: 200, body: flagged } }) });
  const ctx = hive(p.base);
  try {
    const report = await ctx.service.analysis.probe();
    assert.equal(report.provider, 'fireworks', 'no provider argument means the active provider');
    assert.equal(report.verdict, 'fail');
    assert.equal(report.conflict.expectation.met, true);
    assert.equal(report.harmless.status, 'ok');
    assert.equal(report.harmless.expectation.met, false);
    assert.match(report.harmless.expectation.detail, /flagged semantic_conflict/);
  } finally { ctx.cleanup(); await p.close(); }
});

test('model_probe: a malformed conflict reply is invalid (not empty), the verdict fails, and the key never appears', async () => {
  const p = await provider({ chat: probeRoutes({ conflict: { status: 200, body: envelope('{"summary": "oops"') }, minimal: { status: 401, body: { error: { message: `bad key ${KEY}` } } } }) });
  const ctx = hive(p.base);
  try {
    const report = await ctx.service.analysis.probe('fireworks');
    assert.equal(report.verdict, 'fail');
    assert.equal(report.conflict.status, 'invalid');
    assert.match(report.conflict.error!, /^Malformed model output \(expected HiveAnalysis JSON\)/);
    assert.deepEqual(report.conflict.findings, []);
    assert.equal(report.conflict.expectation.met, false);
    assert.equal(report.minimal.status, 401);
    assert.match(report.minimal.error!, /^HTTP 401: .*bad key \[redacted\]/);
    assert.equal(report.harmless.expectation.met, true);
    assert.equal(JSON.stringify(report).includes(KEY), false);
  } finally { ctx.cleanup(); await p.close(); }
});

test('model_probe: a missing key is not_configured and nothing is sent; the probe analyzer uses one attempt', async () => {
  const p = await provider({ chat: probeRoutes({ conflict: { status: 503, body: 'busy' } }) });
  const ctx = hive(p.base, { apiKey: '' });
  try {
    const report = await ctx.service.analysis.probe();
    assert.equal(report.verdict, 'not_configured');
    assert.equal(report.configured, false);
    assert.match(report.minimal.error!, /FIREWORKS_API_KEY is not set/);
    assert.equal(report.conflict.status, 'unavailable');
    assert.equal(p.seen.length, 0, 'nothing was sent without a key');
  } finally { ctx.cleanup(); }
  const configured = hive(p.base, { maxAttempts: 3 });
  try {
    const report = await configured.service.analysis.probe();
    assert.equal(report.verdict, 'fail');
    assert.equal(report.conflict.status, 'unavailable');
    assert.match(report.conflict.error!, /HTTP 503: busy after 1 attempt\(s\)/);
    assert.equal(p.seen.filter(s => s.url === '/v1/chat/completions' && s.body.includes('probe-pricing')).length, 1, 'the probe never retries');
  } finally { configured.cleanup(); await p.close(); }
});

test('model_probe and model_diagnose: admin only; provider must be meta or fireworks', () => {
  assert.deepEqual(commandSchema.parse({ action: 'model_probe', provider: 'fireworks' }), { action: 'model_probe', provider: 'fireworks' });
  assert.deepEqual(commandSchema.parse({ action: 'model_probe' }), { action: 'model_probe' });
  assert.deepEqual(commandSchema.parse({ action: 'model_diagnose', provider: 'meta' }), { action: 'model_diagnose', provider: 'meta' });
  assert.throws(() => commandSchema.parse({ action: 'model_probe', provider: 'openai' }));
  assert.throws(() => commandSchema.parse({ action: 'model_diagnose', provider: 'openai' }));
  for (const command of [commandSchema.parse({ action: 'model_probe' }), commandSchema.parse({ action: 'model_diagnose', provider: 'fireworks' })]) {
    assert.throws(() => authorizeCommand({ role: 'member', member: 'sanika', tokenId: 't1' }, command, () => undefined), /admin token required/);
    assert.throws(() => authorizeCommand({ role: 'member', member: 'sanika', tokenId: 't2', kind: 'connector' }, command, () => undefined), /admin token required/);
    assert.throws(() => authorizeCommand({ role: 'viewer', member: 'v', tokenId: 't3' }, command, () => undefined), /read-only/);
    assert.doesNotThrow(() => authorizeCommand({ role: 'admin', member: 'operator', tokenId: null }, command, () => undefined));
  }
});

// ---- 6. relay, snapshot, diagnose(provider) ----------------------------------------------------------------
test('the laptop relay is Meta-only; the snapshot names the provider; diagnose(provider) checks the other provider and keeps the result', async () => {
  const p = await provider({ models: { status: 200, body: { data: [] } }, chat: { status: 404, body: { error: { message: 'not found' } } } });
  const ctx = hive(p.base);
  try {
    assert.throws(() => ctx.service.analysis.relayRequest(), { message: 'The laptop relay is only available for the Meta provider; this hub reaches Fireworks directly' });
    const snapshot = ctx.service.snapshot();
    assert.equal(snapshot.model.provider, 'fireworks');
    assert.equal(snapshot.model.model, MODEL);
    assert.equal(snapshot.model.configured, true);
    assert.equal(snapshot.model.lastDiagnose, null);
    assert.equal(JSON.stringify(snapshot.model).includes(KEY), false);
    assert.equal(ctx.service.viewCached().model.provider, 'fireworks');
    const active = await ctx.service.analysis.diagnose();
    assert.equal(active.provider, 'fireworks');
    assert.equal(active.verdict, 'model_not_found');
    const other = await ctx.service.analysis.diagnose('meta');
    assert.equal(other.provider, 'meta');
    assert.equal(other.model, 'muse-spark-1.3');
    assert.equal(other.verdict, 'no_models_for_host', 'the Meta rules apply to the Meta analyzer');
    assert.match(other.hints.join(' '), /HIVE_MODEL_PROXY_URL/);
    assert.equal(ctx.service.analysis.lastDiagnose?.provider, 'meta');
    assert.equal(ctx.service.snapshot().model.lastDiagnose?.provider, 'meta');
    assert.equal(ctx.service.snapshot().model.provider, 'fireworks', 'diagnosing the other provider does not switch the hub');
    const same = await ctx.service.analysis.diagnose('fireworks');
    assert.equal(same.provider, 'fireworks');
  } finally { ctx.cleanup(); await p.close(); }
});
