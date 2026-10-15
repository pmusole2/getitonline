import assert from 'node:assert/strict';
import test from 'node:test';

import {
  allocateExactCents,
  centsToStoredMajor,
  checkedAdd,
  checkedMultiply,
  finiteMajorToRational,
  isLosslessSignedMajorCents,
  isLosslessStoredMajorCents,
  majorNumberToCents,
  percentDiscountCents,
  platformFeeCents,
  proportionalCents,
  roundHalfUpToSafeCents,
  signedMajorToCents,
  weightFeeCents,
} from './catalogMoney';

// Stored majors convert only when they are exact to the cent. Anything else
// (a third decimal, a sign where none is allowed, NaN, Infinity, or an unsafe
// magnitude) is malformed rather than rounded.

test('majorNumberToCents converts exact majors and rejects the rest', () => {
  assert.equal(majorNumberToCents(100), 10000);
  assert.equal(majorNumberToCents(10.01), 1001);
  assert.equal(majorNumberToCents(0.1), 10);
  assert.equal(majorNumberToCents(0), 0);
  assert.equal(majorNumberToCents(Number.NaN), null);
  assert.equal(majorNumberToCents(Number.POSITIVE_INFINITY), null);
  assert.equal(majorNumberToCents(-1), null);
  assert.equal(majorNumberToCents(10.001), null);
  assert.equal(majorNumberToCents(0.30000000000000004), null);
  assert.equal(majorNumberToCents(1e21), null);
  assert.equal(majorNumberToCents(Number.MAX_SAFE_INTEGER + 0.5), null);
});

test('signedMajorToCents allows exact negative deltas and rejects malformed ones', () => {
  assert.equal(signedMajorToCents(-1.5), -150);
  assert.equal(signedMajorToCents(2.5), 250);
  assert.equal(signedMajorToCents(0), 0);
  assert.equal(signedMajorToCents(-0), 0);
  assert.equal(signedMajorToCents(1.005), null);
  assert.equal(signedMajorToCents(Number.NaN), null);
  assert.equal(signedMajorToCents(Number.POSITIVE_INFINITY), null);
});

test('centsToStoredMajor round-trips lossless projections only', () => {
  assert.equal(centsToStoredMajor(1001), 10.01);
  assert.equal(centsToStoredMajor(10), 0.1);
  assert.equal(centsToStoredMajor(0), 0);
  assert.equal(centsToStoredMajor(-1), null);
  assert.equal(centsToStoredMajor(1.5), null);
  assert.equal(centsToStoredMajor(Number.MAX_SAFE_INTEGER + 1), null);
});

test('finiteMajorToRational reads stored decimals exactly', () => {
  assert.deepEqual(finiteMajorToRational(0.1), { numerator: BigInt(1), denominator: BigInt(10) });
  assert.deepEqual(finiteMajorToRational(2), { numerator: BigInt(2), denominator: BigInt(1) });
  assert.deepEqual(finiteMajorToRational(1.5), { numerator: BigInt(15), denominator: BigInt(10) });
  assert.deepEqual(finiteMajorToRational(1e-7), { numerator: BigInt(1), denominator: BigInt(10000000) });
  assert.equal(finiteMajorToRational(Number.NaN), null);
  assert.equal(finiteMajorToRational(Number.POSITIVE_INFINITY), null);
});

test('roundHalfUpToSafeCents rounds halves away from zero', () => {
  assert.equal(roundHalfUpToSafeCents(BigInt(1), BigInt(2)), 1);
  assert.equal(roundHalfUpToSafeCents(BigInt(3), BigInt(2)), 2);
  assert.equal(roundHalfUpToSafeCents(BigInt(5), BigInt(2)), 3);
  assert.equal(roundHalfUpToSafeCents(BigInt(1), BigInt(4)), 0);
  assert.equal(roundHalfUpToSafeCents(BigInt(0), BigInt(7)), 0);
  assert.equal(roundHalfUpToSafeCents(BigInt(-1), BigInt(2)), null);
  assert.equal(roundHalfUpToSafeCents(BigInt(1), BigInt(0)), null);
});

test('percentDiscountCents uses exact half-up rounding with no percent cap', () => {
  assert.equal(percentDiscountCents(10000, 10), 1000);
  assert.equal(percentDiscountCents(1, 50), 1);
  assert.equal(percentDiscountCents(199, 10), 20);
  assert.equal(percentDiscountCents(101, 10), 10);
  assert.equal(percentDiscountCents(100, 12.5), 13);
  assert.equal(percentDiscountCents(100, 0), 0);
  assert.equal(percentDiscountCents(100, 150), 150);
  assert.equal(percentDiscountCents(100, -5), null);
  assert.equal(percentDiscountCents(100, Number.NaN), null);
  assert.equal(percentDiscountCents(-100, 10), null);
});

test('proportionalCents scales by an exact rational', () => {
  assert.equal(proportionalCents(100, BigInt(1), BigInt(2)), 50);
  assert.equal(proportionalCents(1, BigInt(1), BigInt(2)), 1);
  assert.equal(proportionalCents(100, BigInt(0), BigInt(3)), 0);
  assert.equal(proportionalCents(100, BigInt(1), BigInt(0)), null);
  assert.equal(proportionalCents(-100, BigInt(1), BigInt(2)), null);
});

test('weightFeeCents adds the half-up rounded weight fee to the base', () => {
  assert.equal(weightFeeCents(500, 100, 0.005), 501);
  assert.equal(weightFeeCents(0, 250, 2), 500);
  assert.equal(weightFeeCents(2000, 0, 9.75), 2000);
  assert.equal(weightFeeCents(500, 100, -1), null);
  assert.equal(weightFeeCents(500, 100, Number.NaN), null);
  assert.equal(weightFeeCents(-500, 100, 1), null);
});

test('platformFeeCents ceils a single 5 percent fee', () => {
  assert.equal(platformFeeCents(1000), 50);
  assert.equal(platformFeeCents(1001), 51);
  assert.equal(platformFeeCents(1000), 50);
  assert.equal(platformFeeCents(10), 1);
  assert.equal(platformFeeCents(1), 1);
  assert.equal(platformFeeCents(0), 0);
  assert.equal(platformFeeCents(-1), null);
  assert.equal(platformFeeCents(1.5), null);
});

test('allocateExactCents conserves the total with stable remainder order', () => {
  assert.deepEqual(allocateExactCents(1, [10, 10]), [1, 0]);
  assert.deepEqual(allocateExactCents(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(allocateExactCents(550, [10000, 1000]), [500, 50]);
  assert.deepEqual(allocateExactCents(0, [7, 3]), [0, 0]);
  assert.deepEqual(allocateExactCents(5, [0, 0]), [0, 5]);
  assert.deepEqual(allocateExactCents(3, [0, 5]), [0, 3]);
  assert.deepEqual(allocateExactCents(0, []), []);
  assert.equal(allocateExactCents(1, []), null);
  assert.equal(allocateExactCents(-1, [5]), null);
  assert.equal(allocateExactCents(5, [-1]), null);
});

test('allocateExactCents always sums to the total across uneven weights', () => {
  const cases: Array<[number, number[]]> = [
    [7, [100, 33, 11]],
    [99, [1, 1, 1, 1]],
    [1000, [0, 250, 750]],
    [13, [5, 5, 5, 5, 5]],
  ];
  for (const [total, weights] of cases) {
    const shares = allocateExactCents(total, weights);
    assert.ok(shares, `allocation of ${total} must succeed`);
    assert.equal(
      shares.reduce((sum, share) => sum + share, 0),
      total,
      `shares of ${total} must conserve the total`,
    );
    for (const [index, share] of shares.entries()) {
      assert.ok(share >= 0, 'no share may be negative');
      if (weights[index] === 0) {
        assert.equal(share, 0, 'a zero weight must receive nothing');
      }
    }
  }
});

test('checkedMultiply and checkedAdd refuse unrepresentable results', () => {
  assert.equal(checkedMultiply(100, 25), 2500);
  assert.equal(checkedMultiply(0, 999), 0);
  assert.equal(checkedMultiply(Number.MAX_SAFE_INTEGER, 2), null);
  assert.equal(checkedMultiply(-1, 5), null);
  assert.equal(checkedAdd(100, 25), 125);
  assert.equal(checkedAdd(Number.MAX_SAFE_INTEGER, 1), null);
  assert.equal(checkedAdd(-1, 5), null);
});

test('lossless major transport gates every quoted cent, including signed deltas', () => {
  assert.equal(isLosslessStoredMajorCents(1001), true);
  assert.equal(isLosslessStoredMajorCents(0), true);
  assert.equal(isLosslessStoredMajorCents(8400000000000100), true);
  assert.equal(isLosslessStoredMajorCents(8400000000000415), false);
  assert.equal(isLosslessStoredMajorCents(-1), false);
  assert.equal(isLosslessStoredMajorCents(1.5), false);
  assert.equal(isLosslessSignedMajorCents(-150), true);
  assert.equal(isLosslessSignedMajorCents(150), true);
  assert.equal(isLosslessSignedMajorCents(-8400000000000415), false);
  assert.equal(isLosslessSignedMajorCents(1.5), false);
});
