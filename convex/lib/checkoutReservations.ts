// Shared checkout reservation helpers (Task3B2). Status-aware promo counting
// and loyalty reservation validation consumed by the quote, wallet, promotion,
// and checkout-collection slices. No writes live here: every helper only
// reads and validates so all four consumers agree on the same counters.

export type RedemptionStatusRow = {
  userId: string;
  status?: string;
};

// A redemption row counts against global and per-user caps when its status
// is absent (legacy captured), reserved, or captured. Released rows never
// count. Unknown or malformed statuses fail closed: they count, so no caller
// can mint a free promo slot from an unexpected value.
export function redemptionCountsAgainstCaps(row: RedemptionStatusRow): boolean {
  if (row.status === undefined) {
    return true;
  }
  if (row.status === "reserved" || row.status === "captured") {
    return true;
  }
  if (row.status === "released") {
    return false;
  }
  return true;
}

export function countActiveRedemptions(rows: ReadonlyArray<RedemptionStatusRow>): number {
  let counted = 0;
  for (const row of rows) {
    if (redemptionCountsAgainstCaps(row)) {
      counted += 1;
    }
  }
  return counted;
}

export function countActiveRedemptionsForUser(rows: ReadonlyArray<RedemptionStatusRow>, userId: string): number {
  let counted = 0;
  for (const row of rows) {
    if (row.userId !== userId) {
      continue;
    }
    if (redemptionCountsAgainstCaps(row)) {
      counted += 1;
    }
  }
  return counted;
}

export type LoyaltyCounters = {
  pointsBalance: number;
  lifetimeEarned: number;
  lifetimeRedeemed: number;
};

// Narrow loyalty account validation shared by wallet capture and checkout
// reservation: every counter must be a nonnegative safe integer.
export function isValidLoyaltyCounters(value: {
  pointsBalance: unknown;
  lifetimeEarned: unknown;
  lifetimeRedeemed: unknown;
}): value is LoyaltyCounters {
  return (
    typeof value.pointsBalance === "number" &&
    Number.isSafeInteger(value.pointsBalance) &&
    value.pointsBalance >= 0 &&
    typeof value.lifetimeEarned === "number" &&
    Number.isSafeInteger(value.lifetimeEarned) &&
    value.lifetimeEarned >= 0 &&
    typeof value.lifetimeRedeemed === "number" &&
    Number.isSafeInteger(value.lifetimeRedeemed) &&
    value.lifetimeRedeemed >= 0
  );
}

// Reads owned legacy metadata for checkout order names without trusting its
// shape. Supported string arrays intersect this checkout; malformed owned
// metadata that visibly names a checkout order fails closed instead of
// being skipped. Raw metadata is never logged or repaired. Extracted from
// the accepted wallet purchase so both slices share one fail-closed
// algorithm byte-for-byte semantically.
export function metadataNamesCheckoutOrder(metadata: unknown, checkoutOrderIds: ReadonlySet<string>): boolean {
  if (metadata === undefined || metadata === null || checkoutOrderIds.size === 0) {
    return false;
  }
  if (typeof metadata === "string") {
    for (const orderId of checkoutOrderIds) {
      if (metadata.includes(orderId)) {
        return true;
      }
    }
    return false;
  }
  if (typeof metadata !== "object") {
    return false;
  }
  if (Array.isArray(metadata)) {
    return metadata.some((entry) => typeof entry === "string" && checkoutOrderIds.has(entry));
  }
  // Validation boundary: legacy metadata is v.any(), so every field narrows
  // from unknown before it can name an order.
  const record = metadata as Record<string, unknown>;
  for (const key of ["checkoutOrderIds", "orderIds"] as const) {
    const value = record[key];
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      let clean = true;
      for (const entry of value) {
        if (typeof entry !== "string") {
          clean = false;
          break;
        }
        if (checkoutOrderIds.has(entry)) {
          return true;
        }
      }
      if (clean) {
        continue;
      }
    }
    const text = JSON.stringify(value) ?? String(value);
    for (const orderId of checkoutOrderIds) {
      if (text.includes(orderId)) {
        return true;
      }
    }
  }
  return false;
}
// Checkout reserves only the frozen effective points from the approved quote
// snapshot: the balance must cover them and the prospective capture counter
// (lifetimeRedeemed + reserved, applied by Task4) must stay a safe integer.
// No lifetime increment happens in this slice.
export function canReserveLoyaltyPoints(
  account: { pointsBalance: number; lifetimeRedeemed: number },
  effectivePoints: number
): boolean {
  if (!Number.isSafeInteger(effectivePoints) || effectivePoints <= 0) {
    return false;
  }
  if (account.pointsBalance < effectivePoints) {
    return false;
  }
  return Number.isSafeInteger(account.lifetimeRedeemed + effectivePoints);
}
