import { findProduct } from './catalog.ts';

/** Returns the unit price of a product in US dollars (decimal). */
export function getPrice(sku: string): number {
  return findProduct(sku).price;
}

/** Applies a percentage discount and returns dollars (decimal). */
export function applyDiscount(amount: number, percent: number): number {
  return Math.round(amount * (1 - percent / 100) * 100) / 100;
}
