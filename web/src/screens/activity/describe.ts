// Turns raw Hive events into plain sentences. Detail strings come from the server and stay text;
// ids are swapped for the names the snapshot already knows, and nothing else is added.
// Relative type-only imports (not '@/mock') so the backend test suite can type-check and import this file.
import type { Event as HiveEvent } from '../../../../src/domain/types.ts';
import type { ServiceSnapshot } from '../../../../src/service.ts';

export type EventTone = 'neutral' | 'warning' | 'danger' | 'success' | 'accent';

export interface EventView {
  event: HiveEvent;
  /** Short headline, sentence case. */
  title: string;
  /** Category shown as a chip. */
  kind: string;
  tone: EventTone;
  /** Who caused it: an agent name, "Hive server" or "Test runner". */
  actor: string;
  /** One sentence for the rail preview and the card lead. */
  summary: string;
  contractId: string | null;
  sessionId: string | null;
  revision: number | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const capitalize = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

const OPERATION_LABEL: Record<string, string> = {
  add_field: 'Add field',
  change_signature: 'Change signature',
  rename_symbol: 'Rename symbol',
  add_endpoint: 'Add endpoint',
};

export function makeDescriber(snapshot: ServiceSnapshot, sessionName: (id: string) => string) {
  const contractTitle = (id: string | null) => (id ? snapshot.contracts.find(c => c.id === id)?.title ?? `Agreement ${id.slice(0, 8)}` : 'An agreement');
  const clientLabel = (id: string | null) => {
    const client = id ? snapshot.sessions.find(s => s.id === id)?.client : null;
    if (client === 'claude-code') return 'Claude Code';
    if (client === 'muse-code') return 'Muse Code';
    if (client === 'mcp') return 'an MCP client';
    return client ?? null;
  };
  const known = new Set<string>(snapshot.sessions.map(s => s.id));
  for (const e of snapshot.events) if (e.type === 'session.registered' && typeof e.payload?.sessionId === 'string') known.add(e.payload.sessionId);
  /** Replace every known session and contract id inside a server string with its name; other ids stay as text. */
  const humanize = (text: string) => text.replace(UUID, id => {
    const contract = snapshot.contracts.find(c => c.id === id);
    if (contract) return contract.title;
    return known.has(id) ? sessionName(id) : id;
  });

  return (event: HiveEvent): EventView => {
    const p = event.payload ?? {};
    const sessionId = str(p.sessionId) ?? str(p.owner);
    const contractId = str(p.contractId);
    const revision = num(p.revision);
    const base: EventView = {
      event,
      title: capitalize(event.type.replace(/[._]/g, ' ')),
      kind: 'Event',
      tone: 'neutral',
      actor: sessionId ? sessionName(sessionId) : 'Hive server',
      summary: humanize(event.detail),
      contractId,
      sessionId,
      revision,
    };

    switch (event.type) {
      case 'revision.bumped': {
        const reason = str(p.reason);
        return { ...base, kind: 'Repository', title: `Revision ${revision ?? ''}`.trim(), summary: reason ? capitalize(reason) : base.summary };
      }
      case 'session.registered': {
        const client = clientLabel(sessionId);
        const name = str(p.name) ?? base.actor;
        return { ...base, kind: 'Agent', title: 'Agent registered', actor: name, summary: client ? `${name} connected from ${client}.` : `${name} connected.` };
      }
      case 'intent.updated': {
        const rev = num(p.revision);
        const task = event.detail.includes(': ') ? event.detail.slice(event.detail.indexOf(': ') + 2) : '';
        return {
          ...base,
          kind: 'Intent',
          title: rev && rev > 1 ? `Intent revised` : 'Intent declared',
          summary: task ? `${base.actor}: ${task}` : base.summary,
          revision: null,
        };
      }
      case 'contract.proposed':
        return { ...base, kind: 'Agreement', tone: 'accent', title: 'Agreement proposed', summary: `${contractTitle(contractId)}, version ${num(p.version) ?? 1}.` };
      case 'contract.acknowledged':
        return { ...base, kind: 'Agreement', tone: 'accent', title: 'Agreement signed', summary: `${base.actor} signed version ${num(p.version) ?? ''} of ${contractTitle(contractId)}.` };
      case 'contract.revised':
        return { ...base, kind: 'Agreement', tone: 'warning', title: 'Agreement revised', summary: `${base.actor} revised ${contractTitle(contractId)} to version ${num(p.version) ?? ''}. Earlier signatures no longer count.` };
      case 'contract.implemented':
        return { ...base, kind: 'Agreement', title: 'Code matches the agreement', actor: 'Compiler', summary: `${contractTitle(contractId)}, version ${num(p.version) ?? ''}: the compiler found matching code. Not verified until a test run passes.` };
      case 'contract.verification_started':
        return { ...base, kind: 'Verification', title: 'Verification started', actor: 'Test runner', summary: `${contractTitle(contractId)}: running ${str(p.command) ?? 'the test command'}.` };
      case 'contract.verification_inconclusive':
        return { ...base, kind: 'Verification', tone: 'warning', title: 'Verification inconclusive', actor: 'Test runner', summary: `${contractTitle(contractId)}: ${strings(p.reasons).join('; ') || humanize(event.detail)}.` };
      case 'contract.accepted':
        return { ...base, kind: 'Agreement', tone: 'accent', title: 'Agreement accepted', actor: 'Hive server', summary: `Every participant signed version ${num(p.version) ?? ''} of ${contractTitle(contractId)}.` };
      case 'contract.verified':
        return { ...base, kind: 'Verification', tone: 'success', title: 'Verification passed', actor: 'Test runner', summary: humanize(event.detail) };
      case 'contract.verification_failed': {
        const reasons = Array.isArray(p.reasons) ? p.reasons.filter((r): r is string => typeof r === 'string') : [];
        return { ...base, kind: 'Verification', tone: 'danger', title: 'Verification failed', actor: 'Test runner', summary: `${contractTitle(contractId)}: ${reasons.join('; ') || humanize(event.detail)}.` };
      }
      case 'contract.stale':
        return { ...base, kind: 'Agreement', tone: 'warning', title: 'Agreement went stale', actor: 'Hive server', summary: `${contractTitle(contractId)}: ${str(p.reason) ?? humanize(event.detail)}.` };
      case 'contract.rejected':
        return { ...base, kind: 'Agreement', tone: 'danger', title: 'Agreement rejected', summary: humanize(event.detail) };
      case 'contract.cancelled':
        return { ...base, kind: 'Agreement', title: 'Agreement cancelled', summary: humanize(event.detail) };
      case 'operation.applied': {
        const proposal = snapshot.proposals.find(pr => pr.id === str(p.proposalId));
        const op = proposal ? OPERATION_LABEL[proposal.operation.kind] ?? proposal.operation.kind : 'Operation';
        const files = Array.isArray(p.changedFiles) ? p.changedFiles.filter((f): f is string => typeof f === 'string') : [];
        return { ...base, kind: 'Change', tone: 'accent', title: `${op} applied`, summary: files.length ? `${files.join(', ')} changed at revision ${revision ?? ''}.` : humanize(event.detail) };
      }
      case 'proposal.previewed':
      case 'proposal.rejected':
      case 'proposal.stale':
      case 'proposal.failed': {
        const op = OPERATION_LABEL[str(p.operation) ?? ''] ?? str(p.operation) ?? 'Operation';
        const status = event.type.slice('proposal.'.length);
        const rejections = strings(p.rejections).concat(strings(p.reasons));
        return { ...base, kind: 'Proposal', tone: status === 'previewed' ? 'neutral' : 'danger', title: `${op} ${status}`,
          summary: rejections.length ? `${humanize(rejections.join('; '))}.` : humanize(event.detail) };
      }
      case 'proposal.recovered':
        return { ...base, kind: 'Recovery', tone: 'warning', title: 'Change rolled back after restart', actor: 'Hive server', summary: humanize(event.detail) };
      case 'session.finished':
        return { ...base, kind: 'Agent', title: 'Agent finished', summary: `${base.actor} finished its session.` };
      case 'session.expired':
        return { ...base, kind: 'Agent', tone: 'warning', title: 'Agent lease expired', summary: `${base.actor} stopped sending heartbeats, so its lease expired.` };
      case 'claim.registered':
        return { ...base, kind: 'Claim', title: 'Claim registered', summary: humanize(event.detail) };
      case 'direct_edit': {
        const files = Array.isArray(p.files) ? p.files.filter((f): f is string => typeof f === 'string') : [];
        return { ...base, kind: 'Direct edit', tone: 'danger', title: 'Edited outside Hive', actor: 'Hive server', summary: `${files.join(', ') || 'Files'} changed without a Hive operation. Detected after the fact.` };
      }
      default:
        return base;
    }
  };
}

/** A payload value as text: strings as they are, lists one per line, anything else as indented JSON. */
export function fieldText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every(v => typeof v === 'string')) return value.length ? value.join('\n') : '(empty list)';
  if (value === null || value === undefined) return 'none';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}
