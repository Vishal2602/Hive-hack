import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPrice } from '../src/pricing.ts';
import { invoiceTotal } from '../src/invoice.ts';

// Behavior the Ghost Contract promises. A TypeScript number does not encode dollars vs cents,
// so this test, not the type-check, is what "verified" means.
test('getPrice returns integer cents when asked for cents', () => {
  assert.equal((getPrice as unknown as (unit: string) => number)('cents'), 1999);
});
test('invoice keeps rendering dollars', () => {
  assert.equal(invoiceTotal(), '$19.99');
});
