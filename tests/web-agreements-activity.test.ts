// Behaviour of the pure helpers behind the Agreements and Activity screens: run verdicts (running,
// inconclusive and error are never shown as passes), which runs are still going, merging run copies,
// payload fields as text, exact-version signatures, and paging the event log for the 200-item rail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Contract, Event, VerificationRun } from '../src/domain/types.ts';
import { exitText, latestAppliedRun, runVerdict, runningRun, signatureFor, signatureText, signersOf, standingSentence, verdictNote } from '../web/src/screens/agreements/model.ts';
import { mergeRuns, preferRun, runIdsFromEvents, unfinishedRunIds } from '../web/src/screens/agreements/runModel.ts';
import { fieldText } from '../web/src/screens/activity/describe.ts';
import { PAGE_SIZE, mergeBySeq, pageWindow } from '../web/src/screens/activity/paging.ts';

const C = '11111111-1111-4111-8111-111111111111';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function run(id: string, patch: Partial<VerificationRun> = {}): VerificationRun {
  return { id, contractId: C, version: 1, command: 'npm test', status: 'failed', exitCode: 1, passed: false, overlay: false, revision: 3,
    sourceHashes: {}, output: '', reasons: ['exit code 1'], at: 1_000, finishedAt: 2_000, ...patch };
}
const ev = (seq: number, type: string, payload: Record<string, unknown> = {}): Event => ({ seq, at: seq * 10, type, detail: type, payload });

function contract(patch: Partial<Contract> = {}): Contract {
  return { id: C, version: 2, title: 'Unit on getPrice', ownerSessionId: A, producerSymbol: 'src/pricing.ts#getPrice:function', declaration: 'x', behaviorNotes: '',
    participants: [A, B], acknowledgements: [A], intentRevisions: {}, status: 'implemented', evidence: {}, history: [],
    acknowledgementDetails: [{ sessionId: A, version: 2, intentRevision: 3, at: 50 }, { sessionId: B, version: 1, intentRevision: 1, at: 20 }],
    createdAt: 0, updatedAt: 0, ...patch };
}

test('only a finished, passing run on applied code is proof', () => {
  assert.equal(runVerdict(run('r', { status: 'passed', passed: true, exitCode: 0 })), 'proof');
  assert.equal(runVerdict(run('r', { status: 'passed', passed: true, exitCode: 0, overlay: true })), 'overlay');
  assert.equal(runVerdict(run('r', { status: 'running', exitCode: null, finishedAt: null })), 'running');
  // Exit 0 but files moved during the run: inconclusive, never a pass.
  assert.equal(runVerdict(run('r', { status: 'inconclusive', exitCode: 0, reasons: ['files changed during the run: src/pricing.ts'] })), 'inconclusive');
  assert.equal(runVerdict(run('r', { status: 'error', exitCode: null, reasons: ['could not start npm'] })), 'error');
  assert.equal(runVerdict(run('r')), 'failed');
  assert.match(verdictNote(run('r', { status: 'inconclusive', exitCode: 0, reasons: ['files changed during the run: src/pricing.ts'] })), /proves nothing either way: files changed/i);
  assert.equal(exitText(run('r', { exitCode: null })), 'no exit code');
});

test('a running run is not the latest outcome and the standing sentence says a run is in progress', () => {
  const runs = [run('old'), run('new', { status: 'running', exitCode: null, finishedAt: null, at: 5_000 })];
  assert.equal(latestAppliedRun(runs)?.id, 'old');
  assert.equal(runningRun(runs)?.id, 'new');
  assert.match(standingSentence(contract({ history: [] }), runs), /in progress; it is not verified/);
  assert.equal(runningRun([run('old')]), null);
});

test('signatures count only for the exact version; viewer data without intent revisions omits them', () => {
  const c = contract();
  assert.deepEqual(signatureFor(c, A), { kind: 'signed', version: 2, intentRevision: 3, at: 50 });
  assert.deepEqual(signatureFor(c, B), { kind: 'outdated', version: 1, at: 20 });
  assert.equal(signatureText({ kind: 'signed', version: 2, intentRevision: 0, at: 1 }), 'Signed v2');
  assert.deepEqual(signersOf(c, 1).map(s => s.sessionId), [B]);
  assert.deepEqual(signersOf(c, 3), []);
});

test('run ids come from verification events; a run is unfinished until its finishing event or recorded verification', () => {
  const events = [
    ev(1, 'contract.verification_started', { contractId: C, runId: 'r1' }),
    ev(2, 'contract.verification_failed', { contractId: C, runId: 'r1' }),
    ev(3, 'contract.verification_started', { contractId: C, runId: 'r2' }),
    ev(4, 'contract.verification_started', { contractId: 'other', runId: 'x' }),
    ev(5, 'contract.verification_started', { contractId: C, runId: 'r3' }),
    { seq: 6, at: 60, type: 'contract.verification_started', detail: 'viewer events carry no payload' },
  ];
  assert.deepEqual(runIdsFromEvents(events, C), ['r1', 'r2', 'r3']);
  assert.deepEqual(runIdsFromEvents(events), ['r1', 'r2', 'x', 'r3']);
  assert.deepEqual(unfinishedRunIds(events, C, null), ['r3', 'r2']);
  // contract.verified has no run id: the recorded verification marks r3 finished.
  assert.deepEqual(unfinishedRunIds(events, C, 'r3'), ['r2']);
  assert.deepEqual(unfinishedRunIds([], C, null), []);
});

test('merging run copies keeps the finished one with output, oldest first', () => {
  const runningCopy = run('r1', { status: 'running', exitCode: null, finishedAt: null });
  const finished = run('r1', { output: 'not ok 4' });
  assert.equal(preferRun(runningCopy, finished), finished);
  assert.equal(preferRun(finished, runningCopy), finished);
  assert.equal(preferRun(run('r1'), finished), finished);
  assert.equal(preferRun(undefined, finished), finished);
  const merged = mergeRuns([runningCopy, run('r0', { at: 10 })], [finished]);
  assert.deepEqual(merged.map(r => [r.id, r.status]), [['r0', 'failed'], ['r1', 'failed']]);
});

test('payload fields render as text, never markup', () => {
  assert.equal(fieldText('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>');
  assert.equal(fieldText(['src/a.ts', 'src/b.ts']), 'src/a.ts\nsrc/b.ts');
  assert.equal(fieldText([]), '(empty list)');
  assert.equal(fieldText(null), 'none');
  assert.equal(fieldText(3), '3');
  assert.equal(fieldText({ a: 1 }), '{\n  "a": 1\n}');
});

test('event pages are aligned from the newest event and never exceed the rail limit', () => {
  assert.deepEqual(pageWindow(0, 0), { start: 0, end: 0, page: 0 });
  assert.deepEqual(pageWindow(19, 18), { start: 0, end: 19, page: 0 });
  const len = 450;
  assert.deepEqual(pageWindow(len, len - 1), { start: 250, end: 450, page: 0 });
  assert.deepEqual(pageWindow(len, 250), { start: 250, end: 450, page: 0 });
  assert.deepEqual(pageWindow(len, 249), { start: 50, end: 250, page: 1 });
  assert.deepEqual(pageWindow(len, 0), { start: 0, end: 50, page: 2 });
  for (let i = 0; i < len; i++) {
    const w = pageWindow(len, i);
    assert.ok(i >= w.start && i < w.end && w.end - w.start <= PAGE_SIZE, `index ${i}`);
  }
  // Older pages read from /events merge without duplicates, ascending.
  assert.deepEqual(mergeBySeq([ev(3, 'a'), ev(1, 'a')], [ev(3, 'b'), ev(4, 'b')]).map(e => [e.seq, e.type]), [[1, 'a'], [3, 'b'], [4, 'b']]);
});
