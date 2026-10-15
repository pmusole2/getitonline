import type { Doc, Id } from "../_generated/dataModel";

// Shared raw cart snapshot helpers (Task3B2). Extracted byte-for-byte
// semantically from paymentOperations.ts so the wallet purchase and the
// checkout collection compare the same raw selectors with the same cleanup
// behavior. The snapshot never establishes authority, never reprices, and
// never consults cached prices, display attributes, images, descriptions,
// the optional customization key, or timestamps.

// Raw stored selectors captured for an owned cart row AFTER the fresh quote
// already validated it. Cleanup compares each current row to its snapshot
// (raw to raw), never to canonical quote normalization.
export type CapturedCartSnapshot = {
  ownerId: Doc<"cartItems">["userId"];
  productId: Doc<"cartItems">["productId"];
  quantity: number;
  variantId: string;
  variantSku: string;
  options: Array<{ name: string; value: string }>;
  addOns: string[];
  shippingName: string;
};

// Independently copies every selector value so a mutable row reference in a
// test double cannot rewrite the captured snapshot. Optional absence is
// normalized to "" / [] and ordering is stabilized; comparisons below are
// structural, never delimiter-joined strings.
export function snapshotCapturedCartRow(row: Doc<"cartItems">): CapturedCartSnapshot {
  const options = (row.selectedVariantOptions ?? [])
    .map((option) => ({ name: option.name, value: option.value }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const addOns = (row.selectedAddOns ?? []).map((addOn) => addOn.name).sort();
  return {
    ownerId: row.userId,
    productId: row.productId,
    quantity: row.quantity,
    variantId: row.selectedVariant?.variantId ?? "",
    variantSku: row.selectedVariant?.sku ?? "",
    options,
    addOns,
    shippingName: row.selectedShipping?.name ?? "",
  };
}

export function capturedCartSnapshotsEqual(first: CapturedCartSnapshot, second: CapturedCartSnapshot): boolean {
  if (first.ownerId !== second.ownerId || first.productId !== second.productId || first.quantity !== second.quantity) {
    return false;
  }
  if (first.variantId !== second.variantId || first.variantSku !== second.variantSku) {
    return false;
  }
  if (first.shippingName !== second.shippingName) {
    return false;
  }
  if (first.options.length !== second.options.length || first.addOns.length !== second.addOns.length) {
    return false;
  }
  for (const [index, option] of first.options.entries()) {
    const other = second.options[index];
    if (!other || option.name !== other.name || option.value !== other.value) {
      return false;
    }
  }
  for (const [index, name] of first.addOns.entries()) {
    if (name !== second.addOns[index]) {
      return false;
    }
  }
  return true;
}

export type CartSnapshotMap = Map<Id<"cartItems">, CapturedCartSnapshot>;
