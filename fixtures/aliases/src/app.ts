import { formatMoney, round2, Ledger } from './core/index.js';
import type { Money } from './core/index.js';
export function show(m: Money): string { return formatMoney(round2(m.amount), m.currency); }
export function totalOf(items: Money[]): string {
  const ledger = new Ledger();
  for (const item of items) ledger.add(item);
  return formatMoney(ledger.total());
}
