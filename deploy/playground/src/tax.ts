const RATES: Record<string, number> = { US: 0.08, EU: 0.2, IN: 0.18 };

/** Adds sales tax for a region. Amount in, amount out, same unit as the caller used. */
export function withTax(amount: number, region: string): number {
  const rate = RATES[region] ?? 0;
  return Math.round(amount * (1 + rate) * 100) / 100;
}
