import { randomUUID } from 'node:crypto';
import { Node, type Project } from 'ts-morph';
import type { Finding } from '../domain/types.ts';
import type { GraphIndex } from '../graph/index.ts';
import { locate } from '../ops/renderers.ts';
import type { Gate } from '../ops/engine.ts';
import type { Store } from '../store/sqlite.ts';

/** Deterministic, enforceable rules. Only `field_required` ships in this build. */
export type ClaimRule = { kind: 'field_required'; symbol: string; field: string; type?: string; note?: string };
export interface Claim { id: string; rule: ClaimRule; author: string; status: 'active' | 'retired'; createdAt: number }

export class ClaimService {
  private readonly store: Store;
  private readonly repositoryId: string;
  private readonly clock: () => number;
  constructor(store: Store, repositoryId: string, clock: () => number = Date.now) {
    this.store = store; this.repositoryId = repositoryId; this.clock = clock;
  }

  register(author: string, rule: ClaimRule): Claim {
    if (rule.kind !== 'field_required') throw new Error('Only field_required claims are supported');
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(rule.field)) throw new Error('field must be an identifier');
    const claim: Claim = { id: randomUUID(), rule, author, status: 'active', createdAt: this.clock() };
    this.store.run('INSERT INTO claims(id, repository_id, rule_json, author, status, created_at) VALUES (?, ?, ?, ?, ?, ?)', claim.id, this.repositoryId, JSON.stringify(rule), author, 'active', claim.createdAt);
    return claim;
  }
  retire(id: string): void { this.store.run("UPDATE claims SET status = 'retired' WHERE id = ? AND repository_id = ?", id, this.repositoryId); }
  active(): Claim[] {
    return this.store.all<{ id: string; rule_json: string; author: string; status: 'active' | 'retired'; created_at: number }>(
      "SELECT id, rule_json, author, status, created_at FROM claims WHERE repository_id = ? AND status = 'active' ORDER BY created_at", this.repositoryId)
      .map(row => ({ id: row.id, rule: JSON.parse(row.rule_json) as ClaimRule, author: row.author, status: row.status, createdAt: Number(row.created_at) }));
  }

  /** Evaluates every active claim against the current index. Violations are findings, observed after the fact. */
  findings(graph: GraphIndex): Finding[] {
    const out: Finding[] = [];
    for (const claim of this.active()) {
      const problem = this.violation(claim.rule, member => {
        const target = graph.resolve(claim.rule.symbol);
        if (!target) return 'symbol missing';
        const found = graph.symbol(`${target.key.split(':')[0]}.${member}:property`);
        if (!found) return 'field missing';
        return found.meta.signature ?? '';
      });
      if (problem) out.push({ kind: 'claim_violation', severity: 'error', sessions: [], source: 'deterministic', symbols: [claim.rule.symbol],
        evidence: `Claim ${claim.id} (${claim.author}) requires ${claim.rule.symbol} to have ${claim.rule.field}${claim.rule.type ? `: ${claim.rule.type}` : ''}; current source: ${problem}` });
    }
    return out;
  }

  /** Blocks a supported Hive operation whose staged result would break a claim. Direct edits are only observed. */
  gate(graphFor: (workspaceId: string) => GraphIndex): Gate {
    return context => {
      const reasons: string[] = [];
      const graph = graphFor(context.workspaceId);
      for (const claim of this.active()) {
        const target = graph.resolve(claim.rule.symbol);
        if (!target || !context.touchedFiles.includes(target.file)) continue;
        const problem = this.violation(claim.rule, member => memberSignature(context.staged, graph, target, member));
        if (problem) reasons.push(`Claim ${claim.id} violated: ${claim.rule.symbol} must keep ${claim.rule.field}${claim.rule.type ? `: ${claim.rule.type}` : ''} (${problem})`);
      }
      return reasons;
    };
  }

  private violation(rule: ClaimRule, lookup: (member: string) => string): string | null {
    const signature = lookup(rule.field);
    if (signature === 'symbol missing' || signature === 'field missing') return signature;
    if (rule.type && !signature.replace(/\s+/g, ' ').endsWith(`: ${rule.type.replace(/\s+/g, ' ')}`)) return `field is "${signature}"`;
    return null;
  }
}

function memberSignature(project: Project, graph: GraphIndex, target: ReturnType<GraphIndex['resolve']> & object, member: string): string {
  try {
    const node = locate(project, graph.root, target);
    const members = (node as unknown as { getMembers?: () => Node[] }).getMembers?.() ?? [];
    const found = members.find(m => Node.hasName(m) && m.getName() === member);
    if (!found) return 'field missing';
    const type = (found as unknown as { getTypeNode?: () => Node | undefined }).getTypeNode?.()?.getText() ?? '';
    const optional = (found as unknown as { hasQuestionToken?: () => boolean }).hasQuestionToken?.() ? '?' : '';
    return `${member}${optional}: ${type}`;
  } catch { return 'symbol missing'; }
}
