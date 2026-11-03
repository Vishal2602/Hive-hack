import { getPrice } from './pricing.ts';
import { withTax } from './tax.ts';
import type { Invoice, LineItem } from './types.ts';

/** Formats a dollar amount as "$12.34". */
export function formatMoney(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export function lineTotal(line: LineItem): number {
  return getPrice(line.product.sku) * line.quantity;
}

export function buildInvoice(id: string, lines: LineItem[], region = 'US'): Invoice {
  const subtotal = lines.reduce((sum, line) => sum + lineTotal(line), 0);
  return { id, lines, total: formatMoney(withTax(subtotal, region)) };
}
