import type { Product } from './types.ts';

export const products: Product[] = [
  { sku: 'basic', name: 'Basic plan', price: 19.99 },
  { sku: 'pro', name: 'Pro plan', price: 49.5 },
  { sku: 'addon-seat', name: 'Extra seat', price: 4 },
];

export function findProduct(sku: string): Product {
  const product = products.find(item => item.sku === sku);
  if (!product) throw new Error(`Unknown sku ${sku}`);
  return product;
}
