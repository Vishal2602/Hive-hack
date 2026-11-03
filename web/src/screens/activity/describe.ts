// Turns raw Hive events into plain sentences. Detail strings come from the server and stay text;
// ids are swapped for the names the snapshot already knows, and nothing else is added.
import type { HiveEvent, ServiceSnapshot } from '@/mock';

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
const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

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
  /** Replace every known session and contract id inside a server string with its name. */
  const humanize = (text: string) => {
    let out = text;
    for (const s of snapshot.sessions) out = out.split(s.id).join(s.name);
    for (const c of snapshot.contracts) out = out.split(c.id).join(c.title);
    return out;
  };

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
      case 'direct_edit': {
        const files = Array.isArray(p.files) ? p.files.filter((f): f is string => typeof f === 'string') : [];
        return { ...base, kind: 'Direct edit', tone: 'danger', title: 'Edited outside Hive', actor: 'Hive server', summary: `${files.join(', ') || 'Files'} changed without a Hive operation. Detected after the fact.` };
      }
      default:
        return base;
    }
  };
}
