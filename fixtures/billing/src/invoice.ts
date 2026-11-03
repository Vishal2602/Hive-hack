import { getPrice } from './pricing.ts';
import { applyTax } from './tax.ts';
export function invoiceTotal(): string { return `$${getPrice().toFixed(2)}`; }
export function invoiceWithTax(): number { return applyTax(getPrice(), 0.2, 'EU'); }
