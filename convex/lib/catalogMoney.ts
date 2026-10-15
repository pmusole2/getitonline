import { LENCO_CURRENCY, parseMajorDecimalToCents } from "./lencoAdapter";

// Integer-cent money primitives for the authoritative checkout quote.
//
// Every stored major-unit number converts to cents only through the reviewed
// strict decimal grammar (at most two fraction digits, finite, non-negative,
// safe-integer cents). Anything else is reported as malformed; this module
// never rounds a third decimal or hides an unsafe magnitude. Percentage and
// weight formulas use exact decimal/rational intermediates with nearest-cent
// half-up rounding (the existing mobile roundMoney convention), and every
// multi-seller split conserves its total exactly.

export const QUOTE_CURRENCY: typeof LENCO_CURRENCY = LENCO_CURRENCY;

export const PLATFORM_FEE_RATE_BPS = 500;

export const LOYALTY_CENTS_PER_POINT = 10;

export const MAX_SAFE_CENTS = Number.MAX_SAFE_INTEGER;

function withinSafeCents(value: bigint): number | null {
  if (value < BigInt(0) || value > BigInt(MAX_SAFE_CENTS)) {
    return null;
  }
  return Number(value);
}

/**
 * Converts a stored non-negative major-unit number to exact integer cents.
 * Returns null for anything that is not finite, is negative, needs more than
 * two fraction digits, or cannot be represented as safe-integer cents.
 */
export function majorNumberToCents(value: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return parseMajorDecimalToCents(String(value));
}

/**
 * Converts a stored signed major-unit option delta to exact integer cents.
 * Only option deltas may be negative; every other stored money path uses
 * majorNumberToCents. Returns null for malformed or unrepresentable input.
 */
export function signedMajorToCents(value: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const text = String(value);
  if (text.length === 0 || text.length > 33) {
    return null;
  }
  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const cents = parseMajorDecimalToCents(unsigned);
  if (cents === null) {
    return null;
  }
  if (cents === 0) {
    return 0;
  }
  return negative ? -cents : cents;
}

/**
 * Projects validated non-negative cents back to lossless major units.
 * Returns null unless the value round-trips through canonical decimal text
 * with no cent loss. Zero is a valid projection.
 */
export function centsToStoredMajor(cents: number): number | null {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    return null;
  }
  const major = cents / 100;
  if (!Number.isFinite(major)) {
    return null;
  }
  return parseMajorDecimalToCents(String(major)) === cents ? major : null;
}

/**
 * Reports whether non-negative safe-integer cents survive the round trip to
 * stored/provider numeric majors without loss. Safe-integer cents alone do
 * not imply lossless major transport: very large totals can lose cents when
 * projected through a double major, so every quoted amount passes this gate
 * before it becomes payment authority.
 */
export function isLosslessStoredMajorCents(cents: number): boolean {
  return centsToStoredMajor(cents) !== null;
}

/**
 * Signed variant of the lossless-major gate for option deltas, the only
 * quoted components allowed below zero. Zero and exactly projectable
 * magnitudes pass; anything else fails.
 */
export function isLosslessSignedMajorCents(cents: number): boolean {
  if (!Number.isSafeInteger(cents)) {
    return false;
  }
  return cents < 0 ? centsToStoredMajor(-cents) !== null : centsToStoredMajor(cents) !== null;
}

export type DecimalRational = { numerator: bigint; denominator: bigint };

const DECIMAL_TEXT_PATTERN = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/**
 * Reads a finite stored number as an exact decimal rational. The shortest
 * round-trip decimal text of the stored double is the value, so 0.1 reads as
 * exactly 1/10 rather than the binary approximation. Returns null for
 * non-finite input or text that cannot be expanded exactly.
 */
export function finiteMajorToRational(value: number): DecimalRational | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const negative = value < 0;
  const text = String(negative ? -value : value);
  const match = DECIMAL_TEXT_PATTERN.exec(text);
  if (match === null) {
    return null;
  }
  const intPart = match[1] ?? "";
  const fracPart = match[2] ?? "";
  const expPart = match[3] ?? "0";
  const digits = `${intPart}${fracPart}`;
  if (digits.length === 0 || digits.length > 64) {
    return null;
  }
  const exp = Number.parseInt(expPart, 10);
  if (!Number.isSafeInteger(exp) || Math.abs(exp) > 1000) {
    return null;
  }
  let numerator: bigint;
  try {
    numerator = BigInt(digits);
  } catch {
    return null;
  }
  let denominator = BigInt(1);
  const shift = exp - fracPart.length;
  if (shift >= 0) {
    numerator = numerator * BigInt(10) ** BigInt(shift);
  } else {
    denominator = BigInt(10) ** BigInt(-shift);
  }
  return { numerator: negative ? -numerator : numerator, denominator };
}

/**
 * Rounds a non-negative rational to the nearest cent, half up. Returns null
 * for a non-positive denominator, a negative numerator, or a result outside
 * the safe-integer cent range.
 */
export function roundHalfUpToSafeCents(numerator: bigint, denominator: bigint): number | null {
  if (denominator <= BigInt(0) || numerator < BigInt(0)) {
    return null;
  }
  return withinSafeCents((BigInt(2) * numerator + denominator) / (BigInt(2) * denominator));
}

/**
 * Scales non-negative safe cents by an exact non-negative rational and rounds
 * the result to the nearest cent, half up. Returns null when the inputs or
 * the rounded result are not representable.
 */
export function proportionalCents(baseCents: number, numerator: bigint, denominator: bigint): number | null {
  if (!Number.isSafeInteger(baseCents) || baseCents < 0) {
    return null;
  }
  if (denominator <= BigInt(0) || numerator < BigInt(0)) {
    return null;
  }
  return roundHalfUpToSafeCents(BigInt(baseCents) * numerator, denominator);
}

/**
 * Computes a percentage discount on eligible base cents with exact rational
 * arithmetic and nearest-cent half-up rounding. The caller applies the
 * existing minimum/maximum clamps. A negative percent is malformed; a percent
 * above 100 is applied and then clamped by the caller, matching the existing
 * discount helper which caps no percent value itself.
 */
export function percentDiscountCents(baseCents: number, percentValue: number): number | null {
  if (!Number.isSafeInteger(baseCents) || baseCents < 0) {
    return null;
  }
  const ratio = finiteMajorToRational(percentValue);
  if (ratio === null || ratio.numerator < BigInt(0)) {
    return null;
  }
  return proportionalCents(baseCents, ratio.numerator, BigInt(100) * ratio.denominator);
}

/**
 * Computes a delivery fee from an exact base fee, an exact per-kg fee, and a
 * finite non-negative weight in kilos: base plus the weight-scaled fee rounded
 * to the nearest cent, half up. Returns null for malformed inputs or an
 * unrepresentable total.
 */
export function weightFeeCents(baseFeeCents: number, perKgCents: number, weightKg: number): number | null {
  if (!Number.isSafeInteger(baseFeeCents) || baseFeeCents < 0) {
    return null;
  }
  if (!Number.isSafeInteger(perKgCents) || perKgCents < 0) {
    return null;
  }
  const ratio = finiteMajorToRational(weightKg);
  if (ratio === null || ratio.numerator < BigInt(0)) {
    return null;
  }
  const variable = proportionalCents(perKgCents, ratio.numerator, ratio.denominator);
  if (variable === null) {
    return null;
  }
  return withinSafeCents(BigInt(baseFeeCents) + BigInt(variable));
}

/**
 * Computes the single checkout-level platform fee: ceil of 5% of the
 * discounted subtotal, in exact integer cents. Returns null for malformed
 * input or an unrepresentable fee.
 */
export function platformFeeCents(discountedSubtotalCents: number): number | null {
  if (!Number.isSafeInteger(discountedSubtotalCents) || discountedSubtotalCents < 0) {
    return null;
  }
  return withinSafeCents((BigInt(discountedSubtotalCents) * BigInt(5) + BigInt(99)) / BigInt(100));
}

/**
 * Splits a non-negative total across non-negative weights so the shares sum
 * exactly to the total. Each share starts at the exact floor of its
 * proportional part; leftover cents go one each to the largest fractional
 * remainders, with ties broken by stable weight order. Groups with a zero
 * weight always receive zero. When every weight is zero, a positive total
 * goes to the last group (the existing last-group remainder fallback) and a
 * zero total splits into zeros.
 */
export function allocateExactCents(totalCents: number, weightsCents: number[]): number[] | null {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) {
    return null;
  }
  for (const weight of weightsCents) {
    if (!Number.isSafeInteger(weight) || weight < 0) {
      return null;
    }
  }
  const count = weightsCents.length;
  if (count === 0) {
    return totalCents === 0 ? [] : null;
  }
  if (totalCents === 0) {
    return weightsCents.map(() => 0);
  }
  let sum = BigInt(0);
  for (const weight of weightsCents) {
    sum += BigInt(weight);
  }
  if (sum === BigInt(0)) {
    return weightsCents.map((_, index) => (index === count - 1 ? totalCents : 0));
  }
  const total = BigInt(totalCents);
  const floors: number[] = [];
  const fractions: bigint[] = [];
  let floorSum = 0;
  for (const weight of weightsCents) {
    const product = total * BigInt(weight);
    const floor = product / sum;
    floors.push(Number(floor));
    fractions.push(product % sum);
    floorSum += Number(floor);
  }
  const leftover = totalCents - floorSum;
  const order = weightsCents.map((_, index) => index).filter((index) => (weightsCents[index] ?? 0) > 0);
  order.sort((left, right) => {
    const leftFraction = fractions[left] ?? BigInt(0);
    const rightFraction = fractions[right] ?? BigInt(0);
    if (leftFraction !== rightFraction) {
      return leftFraction > rightFraction ? -1 : 1;
    }
    return left - right;
  });
  const result = [...floors];
  for (let rank = 0; rank < leftover; rank++) {
    const index = order[rank];
    if (index === undefined) {
      return null;
    }
    result[index] = (result[index] ?? 0) + 1;
  }
  return result;
}

/**
 * Multiplies two non-negative safe integers exactly. Returns null unless the
 * product fits in the safe-integer cent range.
 */
export function checkedMultiply(first: number, second: number): number | null {
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(second) || first < 0 || second < 0) {
    return null;
  }
  return withinSafeCents(BigInt(first) * BigInt(second));
}

/**
 * Adds two non-negative safe integers exactly. Returns null unless the sum
 * fits in the safe-integer cent range.
 */
export function checkedAdd(first: number, second: number): number | null {
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(second) || first < 0 || second < 0) {
    return null;
  }
  return withinSafeCents(BigInt(first) + BigInt(second));
}
