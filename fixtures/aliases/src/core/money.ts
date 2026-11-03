export interface Money { amount: number; currency: string }
export function format(value: number): string;
export function format(value: number, currency: string): string;
export function format(value: number, currency = 'USD'): string {
  return `${currency} ${value.toFixed(2)}`;
}
export class Ledger {
  private entries: Money[] = [];
  add(entry: Money): void { this.entries.push(entry); }
  total(): number { return this.entries.reduce((sum, e) => sum + e.amount, 0); }
}
