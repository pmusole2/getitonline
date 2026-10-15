import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_GUEST_CART_QUANTITY, normalizeGuestCartQuantity } from './guestCartQuantity';

// The backend accepts only whole quantities from 1 to 99 and rejects a whole merge batch for one bad line. A local line
// is therefore clamped to that range before it is sent or added, and a line that cannot be made valid is dropped.

test('the cap matches the backend cart quantity limit', () => {
  assert.equal(MAX_GUEST_CART_QUANTITY, 99);
});

test('a quantity above the cap is clamped to 99', () => {
  assert.equal(normalizeGuestCartQuantity(150), 99);
  assert.equal(normalizeGuestCartQuantity(99.9), 99);
});

test('a valid whole quantity is unchanged', () => {
  assert.equal(normalizeGuestCartQuantity(1), 1);
  assert.equal(normalizeGuestCartQuantity(5), 5);
  assert.equal(normalizeGuestCartQuantity(99), 99);
});

test('a fractional quantity is floored, and a fraction below one is dropped', () => {
  assert.equal(normalizeGuestCartQuantity(1.5), 1);
  assert.equal(normalizeGuestCartQuantity(0.5), null);
});

test('a quantity below one is dropped', () => {
  assert.equal(normalizeGuestCartQuantity(0), null);
  assert.equal(normalizeGuestCartQuantity(-3), null);
});

test('a quantity that is not a finite number is dropped', () => {
  assert.equal(normalizeGuestCartQuantity(Number.NaN), null);
  assert.equal(normalizeGuestCartQuantity(Number.POSITIVE_INFINITY), null);
  assert.equal(normalizeGuestCartQuantity(Number.NEGATIVE_INFINITY), null);
});
