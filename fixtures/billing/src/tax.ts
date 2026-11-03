export function applyTax(amount: number, rate: number, region: string): number {
  return amount * (1 + rate);
}
