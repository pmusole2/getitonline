// The backend accepts only whole cart quantities from 1 to MAX_GUEST_CART_QUANTITY, and rejects a whole merge batch when one
// line is invalid. Local guest-cart lines are normalized with this before they are sent or added.
export const MAX_GUEST_CART_QUANTITY = 99;

// Returns the quantity a local line may use, or null when the line cannot be made valid and should be dropped.
export function normalizeGuestCartQuantity(quantity: number): number | null {
  if (!Number.isFinite(quantity)) {
    return null;
  }

  const wholeQuantity = Math.floor(quantity);
  if (wholeQuantity < 1) {
    return null;
  }

  return Math.min(wholeQuantity, MAX_GUEST_CART_QUANTITY);
}
