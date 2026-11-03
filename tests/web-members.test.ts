// Members screen model (web/src/screens/members/access.ts): role scoping, grouping tokens by member,
// agents by token id, and that the bootstrap admin token never surfaces. Pure module, run under Node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  agentName, buildAccess, canManageTokens, displayPrefix, prefixFromSecret, validateLabel, type SessionLike,
} from '../web/src/screens/members/access.ts';
import type { TokenRecord } from '../web/src/api/types.ts';

const NOW = 1_800_000_000_000;
const MIN = 60_000;

function token(id: string, member: string, role: TokenRecord['role'], extra: Partial<TokenRecord> = {}): TokenRecord {
  return { id, label: `${member} laptop`, member, role, prefix: `${id.slice(0, 4)}Abcd`, createdBy: 'operator',
    createdAt: NOW - 60 * MIN, lastUsedAt: null, revokedAt: null, ...extra };
}

const tokens: TokenRecord[] = [
  token('t-san1', 'Sanika', 'member', { lastUsedAt: NOW - 2 * MIN }),
  token('t-san0', 'Sanika', 'member', { createdAt: NOW - 120 * MIN, revokedAt: NOW - 30 * MIN }),
  token('t-vis1', 'Vishal', 'member', { lastUsedAt: NOW - 40 * MIN }),
  token('t-view', 'Judge', 'viewer'),
  token('t-old', 'Former', 'member', { revokedAt: NOW - 5 * MIN }),
];
const sessions: SessionLike[] = [
  { id: 's1', name: 'Sanika · pricing agent', client: 'claude-code', member: 'Sanika', tokenId: 't-san1' },
  { id: 's2', name: 'Vishal · checkout agent', client: 'mcp', member: 'Vishal', tokenId: 't-vis1' },
  { id: 's3', name: 'seed agent', client: null, member: 'operator', tokenId: null },
];
const OPERATOR_ME = { role: 'admin' as const, member: 'operator', tokenId: null };

test('admin sees every member grouped from tokens, with agents matched by token id', () => {
  const access = buildAccess({ me: OPERATOR_ME, tokens, sessions, memberNames: ['Sanika', 'Vishal', 'operator'], now: NOW });
  assert.equal(access.scope, 'all');
  assert.deepEqual(access.rows.map(r => r.name), ['operator', 'Former', 'Sanika', 'Vishal', 'Judge'], 'me first, then role, then name');
  assert.equal(access.activeTokens, 3);

  const sanika = access.rows.find(r => r.name === 'Sanika')!;
  assert.deepEqual(sanika.tokens.map(t => t.id), ['t-san1', 't-san0'], 'active tokens before revoked ones');
  assert.equal(sanika.activeTokenCount, 1);
  assert.deepEqual(sanika.agents.map(a => a.name), ['pricing agent'], 'member prefix stripped from agent names');
  assert.deepEqual(sanika.tokens[0]!.agents.map(a => a.id), ['s1']);
  assert.equal(sanika.tokens[1]!.agents.length, 0);
  assert.equal(sanika.status, 'active');
  assert.equal(sanika.joinedAt, NOW - 120 * MIN);
  assert.equal(sanika.tokens[0]!.prefix, 'hive_mem_t-saAbcd');

  assert.equal(access.rows.find(r => r.name === 'Vishal')!.status, 'idle');
  assert.equal(access.rows.find(r => r.name === 'Former')!.status, 'no-access');
  assert.equal(access.rows.find(r => r.name === 'Judge')!.role, 'viewer');
});

test('the bootstrap admin token is never listed: the operator row has no tokens and no prefix', () => {
  const access = buildAccess({ me: OPERATOR_ME, tokens, sessions, now: NOW, signedInToken: 'operator-secret-value' });
  const operator = access.rows[0]!;
  assert.equal(operator.name, 'operator');
  assert.equal(operator.bootstrap, true);
  assert.equal(operator.role, 'admin');
  assert.deepEqual(operator.tokens, []);
  assert.deepEqual(operator.agents.map(a => a.id), ['s3'], 'operator sessions (no token row) still count as its agents');
  assert.ok(!JSON.stringify(access).includes('operator-secret-value'));
});

test('an admin signed in with a token row sees that token marked as current', () => {
  const adminToken = token('t-adm', 'Ana', 'admin');
  const access = buildAccess({ me: { role: 'admin', member: 'Ana', tokenId: 't-adm' }, tokens: [...tokens, adminToken], sessions, now: NOW });
  const ana = access.rows[0]!;
  assert.equal(ana.name, 'Ana');
  assert.equal(ana.bootstrap, false);
  assert.equal(ana.tokens[0]!.current, true);
  assert.equal(access.rows.filter(r => r.tokens.some(t => t.current)).length, 1);
});

test('a member sees only their own row and the token they signed in with, never other members', () => {
  const secret = `hive_mem_${'Q'.repeat(4)}${'z'.repeat(28)}`;
  const access = buildAccess({ me: { role: 'member', member: 'Sanika', tokenId: 't-san1' }, tokens, sessions, signedInToken: secret, now: NOW });
  assert.equal(access.scope, 'own');
  assert.equal(access.rows.length, 1);
  const row = access.rows[0]!;
  assert.equal(row.name, 'Sanika');
  assert.equal(row.tokens.length, 1);
  assert.equal(row.tokens[0]!.id, 't-san1');
  assert.equal(row.tokens[0]!.prefix, 'hive_mem_QQQQzzzz', 'same 8 characters the daemon stores');
  assert.equal(row.tokens[0]!.detailsKnown, false);
  assert.deepEqual(row.agents.map(a => a.id), ['s1'], 'only sessions registered with their token');
  assert.ok(!JSON.stringify(access).includes('Vishal'));
  assert.ok(!JSON.stringify(access).includes(secret), 'full secret never copied into the model');
});

test('viewers and signed-out visitors get no rows', () => {
  assert.deepEqual(buildAccess({ me: { role: 'viewer', member: 'Judge', tokenId: 't-view' }, tokens, sessions, now: NOW }), { scope: 'none', rows: [], activeTokens: 0 });
  assert.deepEqual(buildAccess({ me: null, tokens, sessions, now: NOW }), { scope: 'none', rows: [], activeTokens: 0 });
});

test('only admins may manage tokens', () => {
  assert.equal(canManageTokens('admin'), true);
  assert.equal(canManageTokens('member'), false);
  assert.equal(canManageTokens('viewer'), false);
  assert.equal(canManageTokens(null), false);
});

test('prefix helpers accept only well-formed member tokens', () => {
  assert.equal(prefixFromSecret(`hive_view_${'a'.repeat(32)}`), 'hive_view_aaaaaaaa');
  assert.equal(prefixFromSecret('some-operator-bootstrap-token'), null);
  assert.equal(prefixFromSecret(`hive_mem_${'a'.repeat(31)}`), null);
  assert.equal(prefixFromSecret(null), null);
  assert.equal(displayPrefix('viewer', 'Ab12Cd34'), 'hive_view_Ab12Cd34');
  assert.equal(displayPrefix('member', 'hive_mem_7Qk2'), 'hive_mem_7Qk2', 'mock prefixes pass through');
  assert.equal(displayPrefix('member', ''), '');
});

test('labels follow the daemon bounds, and agent names keep text that is not a member prefix', () => {
  assert.equal(validateLabel('   '), 'Give the token a label.');
  assert.equal(validateLabel('x'.repeat(80)), null);
  assert.match(validateLabel('x'.repeat(81)) ?? '', /80 characters/);
  assert.equal(agentName('Sanika · pricing agent', 'Sanika'), 'pricing agent');
  assert.equal(agentName('pricing agent', 'Sanika'), 'pricing agent');
  assert.equal(agentName('<img src=x> agent', null), '<img src=x> agent');
});
