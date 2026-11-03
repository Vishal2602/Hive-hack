import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInvoice, formatMoney, lineTotal } from '../src/invoice.ts';
import { findProduct } from '../src/catalog.ts';
import { getPrice } from '../src/pricing.ts';

test('getPrice returns the catalog price', () => {
  assert.equal(getPrice('basic'), 19.99);
});

test('a line total multiplies price by quantity', () => {
  assert.equal(lineTotal({ product: findProduct('addon-seat'), quantity: 3 }), 12);
});

test('an invoice renders dollars with tax', () => {
  const invoice = buildInvoice('inv-1', [{ product: findProduct('basic'), quantity: 1 }], 'US');
  assert.equal(invoice.total, '$21.59');
});

test('formatMoney renders two decimals', () => {
  assert.equal(formatMoney(5), '$5.00');
});
