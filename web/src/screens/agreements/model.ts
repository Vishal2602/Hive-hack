// Pure helpers that turn a Contract and its verification runs into plain-language states.
// Everything here derives from snapshot data; nothing is invented for display.
import type { Contract, ContractStatus, VerificationRun } from '@/mock';

export const STATE_LABEL: Record<ContractStatus, string> = {
  proposed: 'Proposed',
  accepted: 'Accepted',
  implemented: 'Implemented',
  verified: 'Verified',
  stale: 'Stale',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

/** Order used by the list and the filter. */
export const STATE_ORDER: ContractStatus[] = ['proposed', 'accepted', 'implemented', 'verified', 'stale', 'rejected', 'cancelled'];

export type Signature =
  | { kind: 'signed'; version: number; intentRevision: number; at: number }
  | { kind: 'outdated'; version: number; at: number }
  | { kind: 'pending' };

/** What a participant signed, compared with the current version. Only an exact-version signature counts. */
export function signatureFor(contract: Contract, sessionId: string): Signature {
  const acks = contract.acknowledgementDetails.filter(a => a.sessionId === sessionId);
  const exact = acks.find(a => a.version === contract.version);
  if (exact) return { kind: 'signed', version: exact.version, intentRevision: exact.intentRevision, at: exact.at };
  const latest = acks.sort((a, b) => b.version - a.version)[0];
  if (latest) return { kind: 'outdated', version: latest.version, at: latest.at };
  return { kind: 'pending' };
}

export function signatureText(sig: Signature): string {
  if (sig.kind === 'signed') return `Signed v${sig.version} · intent ${sig.intentRevision}`;
  if (sig.kind === 'outdated') return `Signed v${sig.version} only`;
  return 'Not signed';
}

export function signedCount(contract: Contract): number {
  return contract.participants.filter(p => signatureFor(contract, p).kind === 'signed').length;
}

export type RunVerdict = 'proof' | 'overlay' | 'failed';

/** Only a passing run on applied code is proof. A pass on a staged overlay is a rehearsal. */
export function runVerdict(run: VerificationRun): RunVerdict {
  if (!run.passed) return 'failed';
  return run.overlay ? 'overlay' : 'proof';
}

export const VERDICT_TITLE: Record<RunVerdict, string> = {
  proof: 'Passed on applied code',
  overlay: 'Passed on staged changes',
  failed: 'Failed',
};

export function verdictNote(run: VerificationRun): string {
  const verdict = runVerdict(run);
  if (verdict === 'proof') return `Counts as verification for version ${run.version}.`;
  if (verdict === 'overlay') return 'Does not count. It ran against changes that are staged but not applied.';
  return `Exited ${run.exitCode}, so version ${run.version} is not verified.`;
}

/** Latest run on applied code, if any. */
export function latestAppliedRun(runs: VerificationRun[]): VerificationRun | null {
  const applied = runs.filter(r => !r.overlay);
  return applied.length ? applied[applied.length - 1] : null;
}

/**
 * Lifecycle position on the four main steps (0 proposed, 1 accepted, 2 implemented, 3 verified, 4 all done).
 * For stale, rejected and cancelled the position is derived from the evidence that is still on record.
 */
export function lifecycleIndex(contract: Contract): number {
  switch (contract.status) {
    case 'proposed': return 1;
    case 'accepted': return 2;
    case 'implemented': return 3;
    case 'verified': return 4;
    default: {
      const allSigned = contract.participants.length > 0 && signedCount(contract) === contract.participants.length;
      if (!allSigned) return 1;
      if (contract.evidence.implemented) return contract.evidence.verification?.passed && !contract.evidence.verification.overlay ? 4 : 3;
      return 2;
    }
  }
}

export const isClosedState = (s: ContractStatus) => s === 'rejected' || s === 'cancelled';
export const isOffTrack = (s: ContractStatus) => s === 'stale' || isClosedState(s);

/** One sentence that says where the agreement stands, with no claim beyond the evidence. */
export function standingSentence(contract: Contract, runs: VerificationRun[]): string {
  const total = contract.participants.length;
  const signed = signedCount(contract);
  const applied = latestAppliedRun(runs);
  switch (contract.status) {
    case 'proposed':
      return `Waiting for signatures. ${signed} of ${total} participants signed version ${contract.version}.`;
    case 'accepted':
      return `Everyone signed version ${contract.version}. The compiler has not found code that matches the declaration yet.`;
    case 'implemented':
      if (applied && !applied.passed) return `Everyone signed version ${contract.version} and the code matches the declaration. It is not verified: the latest test run on applied code exited ${applied.exitCode}.`;
      return `Everyone signed version ${contract.version} and the code matches the declaration. It is not verified until a test run on applied code passes.`;
    case 'verified':
      return applied
        ? `Verified. ${applied.command} exited 0 on applied code at revision ${applied.revision}.`
        : 'Verified.';
    case 'stale':
      return `Stale. ${contract.evidence.staleReason ?? 'The code or an intent changed after this version was signed.'} Participants need to sign again before anyone builds on it.`;
    case 'rejected':
      return 'Rejected. A revised version would need every participant to sign again.';
    case 'cancelled':
      return 'Cancelled. Nobody is bound by it any more.';
  }
}
