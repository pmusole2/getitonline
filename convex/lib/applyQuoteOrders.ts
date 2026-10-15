import type { Doc, Id } from "../_generated/dataModel";
import { allocateExactCents, centsToStoredMajor, checkedAdd } from "./catalogMoney";
import { PurchaseError } from "./paymentOperationContracts";
import type { PerOrderBreakdown } from "./paymentOperationContracts";
import type { CheckoutQuote, QuoteLine } from "./checkoutQuote";

// Derives immutable per-order slices and cart stock writes from a frozen
// accepted quote. This helper performs no reads or writes, so the wallet
// purchase mutation and the later provider checkout consume one allocation.
// Every money fact comes from the frozen quote cents; nothing is re-read or
// re-priced after the buyer approves the quote key.

export type OrderItemSlice = {
  productId: Id<"products">;
  title: string;
  price: number;
  quantity: number;
  image: string;
  selectedVariantOptions?: Array<{
    name: string;
    value: string;
    sku?: string;
    priceDelta?: number;
  }>;
  selectedVariant?: {
    variantId: string;
    sku: string;
    attributes: Array<{ name: string; value: string }>;
    price: number;
    image?: string;
  };
  selectedAddOns?: Array<{
    name: string;
    description?: string;
    price: number;
  }>;
  customizationKey: string;
};

export type OrderSlice = {
  orderId: Id<"orders"> | undefined;
  sellerId: Id<"users">;
  items: OrderItemSlice[];
  breakdown: Omit<PerOrderBreakdown, "orderId" | "sellerId">;
  stored: {
    subtotal: number;
    discountAmount: number;
    shippingCost: number;
    platformFee: number;
    totalAmount: number;
    sellerPayout: number;
  };
};

export type StockPatch = {
  productId: Id<"products">;
  quantity: number;
  status?: Doc<"products">["status"];
  variantCombinations?: Doc<"products">["variantCombinations"];
};

function centsToMajorOrThrow(cents: number): number {
  const major = centsToStoredMajor(cents);
  if (major === null) {
    throw new PurchaseError("malformed_money", "A checkout amount cannot be represented exactly.");
  }
  return major;
}

function signedCentsToMajorOrThrow(cents: number): number {
  if (!Number.isSafeInteger(cents)) {
    throw new PurchaseError("malformed_money", "A checkout amount cannot be represented exactly.");
  }
  if (cents < 0) {
    const magnitude = centsToStoredMajor(-cents);
    if (magnitude === null) {
      throw new PurchaseError("malformed_money", "A checkout amount cannot be represented exactly.");
    }
    return -magnitude;
  }
  return centsToMajorOrThrow(cents);
}

function lineToItemSlice(line: QuoteLine): OrderItemSlice {
  const optionSlices =
    line.optionPairs.length === 0
      ? undefined
      : line.optionPairs.map((pair) => ({
          name: pair.name,
          value: pair.value,
          ...(pair.sku === undefined ? {} : { sku: pair.sku }),
          priceDelta: signedCentsToMajorOrThrow(pair.deltaCents),
        }));
  return {
    productId: line.productId,
    title: line.title,
    price: centsToMajorOrThrow(line.unitCents),
    quantity: line.quantity,
    // The orders items image is a required string while the quote image is
    // optional. An explicit empty string carries "no image" without
    // inventing a product fact; the title and unit price stay canonical.
    image: line.image ?? "",
    ...(optionSlices === undefined ? {} : { selectedVariantOptions: optionSlices }),
    ...(line.variant === undefined
      ? {}
      : {
          selectedVariant: {
            variantId: line.variant.variantId,
            sku: line.variant.sku,
            attributes: line.variant.attributes.map((attribute) => ({
              name: attribute.name,
              value: attribute.value,
            })),
            price: centsToMajorOrThrow(line.variant.priceCents),
            ...(line.variant.image === undefined ? {} : { image: line.variant.image }),
          },
        }),
    ...(line.addOns.length === 0
      ? {}
      : {
          selectedAddOns: line.addOns.map((addOn) => ({
            name: addOn.name,
            ...(addOn.description === undefined ? {} : { description: addOn.description }),
            price: centsToMajorOrThrow(addOn.priceCents),
          })),
        }),
    customizationKey: line.customizationKey,
  };
}

type SellerOrderGroup = {
  sellerId: Id<"users">;
  orderId: Id<"orders"> | undefined;
  lines: QuoteLine[];
  subtotalCents: number;
};

/**
 * Derives one immutable slice per order from the frozen quote. Cart source
 * creates one order per seller. Pending source retains every existing
 * order, including several orders for the same seller: seller promo,
 * loyalty, shipping, and fee amounts split across those orders with the
 * same stable largest-remainder rule the quote uses, never by copying a
 * whole seller total into each order.
 */
export function deriveOrderSlices(quote: CheckoutQuote, pendingOrderIds?: Array<Id<"orders">>): OrderSlice[] {
  const groups = new Map<Id<"users">, SellerOrderGroup[]>();
  for (const seller of quote.sellers) {
    const sellerLines = quote.lines.filter((line) => line.sellerId === seller.sellerId);
    if (quote.source === "cart") {
      const subtotalCents = sellerLines.reduce((sum, line) => sum + line.lineTotalCents, 0);
      groups.set(seller.sellerId, [
        { sellerId: seller.sellerId, orderId: undefined, lines: sellerLines, subtotalCents },
      ]);
      continue;
    }
    const byOrder = new Map<Id<"orders">, QuoteLine[]>();
    for (const line of sellerLines) {
      if (line.orderId === undefined) {
        throw new PurchaseError("malformed_catalog", "A pending quote line must name its order.");
      }
      const bucket = byOrder.get(line.orderId) ?? [];
      bucket.push(line);
      byOrder.set(line.orderId, bucket);
    }
    const orderedIds = [...byOrder.keys()].sort();
    const sellerGroups: SellerOrderGroup[] = orderedIds.map((orderId) => {
      const lines = byOrder.get(orderId) ?? [];
      return {
        sellerId: seller.sellerId,
        orderId,
        lines,
        subtotalCents: lines.reduce((sum, line) => sum + line.lineTotalCents, 0),
      };
    });
    groups.set(seller.sellerId, sellerGroups);
  }

  if (pendingOrderIds !== undefined) {
    // The whole requested set must correspond exactly to the derived slices.
    // A per-seller filter would hide an order with no lines (for example an
    // empty pending order), so the comparison runs against every id at once.
    const actual = [...groups.values()]
      .flatMap((sellerGroups) => sellerGroups.map((group) => group.orderId))
      .filter((orderId) => orderId !== undefined)
      .sort();
    const expected = [...pendingOrderIds].sort();
    if (actual.length !== expected.length || actual.some((orderId, index) => orderId !== expected[index])) {
      throw new PurchaseError("malformed_catalog", "A pending quote line names an unexpected order.");
    }
  }

  const slices: OrderSlice[] = [];
  for (const seller of quote.sellers) {
    const sellerGroups = groups.get(seller.sellerId) ?? [];
    const weights = sellerGroups.map((group) => group.subtotalCents);
    const promoShares = allocateExactCents(seller.promoCents, weights);
    if (promoShares === null) {
      throw new PurchaseError("malformed_money", "A promo discount cannot be represented exactly.");
    }
    const loyaltyWeights = sellerGroups.map((group, index) => group.subtotalCents - (promoShares[index] ?? 0));
    const loyaltyShares = allocateExactCents(seller.loyaltyCents, loyaltyWeights);
    if (loyaltyShares === null) {
      throw new PurchaseError("malformed_money", "A loyalty discount cannot be represented exactly.");
    }
    let shippingShares: number[];
    if (quote.delivery.methodType === "product_fallback") {
      // Authoritative per-line fallback shipping sums per order exactly.
      shippingShares = sellerGroups.map((group) =>
        group.lines.reduce((sum, line) => sum + (line.fallbackShipping?.priceCents ?? 0), 0)
      );
      if (shippingShares.reduce((sum, share) => sum + share, 0) !== seller.shippingCents) {
        throw new PurchaseError("malformed_money", "The delivery fee cannot be represented exactly.");
      }
    } else {
      const allocated = allocateExactCents(seller.shippingCents, weights);
      if (allocated === null) {
        throw new PurchaseError("malformed_money", "The delivery fee cannot be represented exactly.");
      }
      shippingShares = allocated;
    }
    const feeWeights = sellerGroups.map(
      (group, index) => group.subtotalCents - (promoShares[index] ?? 0) - (loyaltyShares[index] ?? 0)
    );
    const feeShares = allocateExactCents(seller.platformFeeCents, feeWeights);
    if (feeShares === null) {
      throw new PurchaseError("malformed_money", "The platform fee cannot be represented exactly.");
    }

    sellerGroups.forEach((group, index) => {
      const promoCents = promoShares[index] ?? 0;
      const loyaltyCents = loyaltyShares[index] ?? 0;
      const discountCents = promoCents + loyaltyCents;
      if (discountCents > group.subtotalCents) {
        throw new PurchaseError("malformed_money", "A checkout discount exceeds its order subtotal.");
      }
      const discountedSubtotalCents = group.subtotalCents - discountCents;
      const shippingCents = shippingShares[index] ?? 0;
      const platformFeeCents = feeShares[index] ?? 0;
      const sellerPayoutCents = checkedAdd(discountedSubtotalCents, shippingCents);
      const totalAmountCents = sellerPayoutCents === null ? null : checkedAdd(sellerPayoutCents, platformFeeCents);
      if (sellerPayoutCents === null || totalAmountCents === null) {
        throw new PurchaseError("malformed_money", "A seller total cannot be represented exactly.");
      }
      slices.push({
        orderId: group.orderId,
        sellerId: group.sellerId,
        items: group.lines.map((line) => lineToItemSlice(line)),
        breakdown: {
          subtotalCents: group.subtotalCents,
          promoCents,
          loyaltyCents,
          discountCents,
          discountedSubtotalCents,
          shippingCents,
          platformFeeCents,
          sellerPayoutCents,
          totalAmountCents,
        },
        stored: {
          subtotal: centsToMajorOrThrow(group.subtotalCents),
          discountAmount: centsToMajorOrThrow(discountCents),
          shippingCost: centsToMajorOrThrow(shippingCents),
          platformFee: centsToMajorOrThrow(platformFeeCents),
          totalAmount: centsToMajorOrThrow(totalAmountCents),
          sellerPayout: centsToMajorOrThrow(sellerPayoutCents),
        },
      });
    });
  }

  // Conservation: per-order slices sum back to every seller aggregate and
  // to the checkout totals, so no cent is created or lost in the split.
  for (const seller of quote.sellers) {
    const sellerSlices = slices.filter((slice) => slice.sellerId === seller.sellerId);
    const sumField = (pick: (breakdown: OrderSlice["breakdown"]) => number): number =>
      sellerSlices.reduce((sum, slice) => sum + pick(slice.breakdown), 0);
    const expected: Array<[key: keyof OrderSlice["breakdown"], value: number]> = [
      ["subtotalCents", seller.subtotalCents],
      ["promoCents", seller.promoCents],
      ["loyaltyCents", seller.loyaltyCents],
      ["discountCents", seller.discountCents],
      ["discountedSubtotalCents", seller.discountedSubtotalCents],
      ["shippingCents", seller.shippingCents],
      ["platformFeeCents", seller.platformFeeCents],
      ["sellerPayoutCents", seller.sellerPayoutCents],
      ["totalAmountCents", seller.totalAmountCents],
    ];
    for (const [key, value] of expected) {
      const pick = (breakdown: OrderSlice["breakdown"]): number => breakdown[key];
      if (sumField(pick) !== value) {
        throw new PurchaseError("malformed_money", "Order slices do not conserve the seller totals.");
      }
    }
  }
  return slices.sort((left, right) => {
    if (left.sellerId !== right.sellerId) {
      return left.sellerId < right.sellerId ? -1 : 1;
    }
    const leftOrder = left.orderId ?? "";
    const rightOrder = right.orderId ?? "";
    return leftOrder < rightOrder ? -1 : leftOrder > rightOrder ? 1 : 0;
  });
}

export type CartStockInput = {
  product: Doc<"products">;
  quantities: Array<{ quantity: number; variantId: string | undefined }>;
};

/**
 * Prepares exact cart stock writes from frozen quote quantities. Pending
 * orders already hold their reservation and are never decremented again.
 * Only the purchased aggregate and matching variant combinations move;
 * unrelated combinations and statuses are preserved byte-for-byte.
 */
export function prepareCartStockPatches(inputs: CartStockInput[]): StockPatch[] {
  return inputs.map((input) => {
    const totalQuantity = input.quantities.reduce((sum, entry) => sum + entry.quantity, 0);
    const quantity = input.product.quantity - totalQuantity;
    const patch: StockPatch = { productId: input.product._id, quantity };
    if (quantity === 0) {
      patch.status = "sold";
    }
    const variantIds = new Set(
      input.quantities.map((entry) => entry.variantId).filter((variantId) => variantId !== undefined)
    );
    if (variantIds.size > 0) {
      const combinations = (input.product.variantCombinations ?? []).map((combination) => {
        if (!variantIds.has(combination.id)) {
          return combination;
        }
        const variantQuantity = input.quantities
          .filter((entry) => entry.variantId === combination.id)
          .reduce((sum, entry) => sum + entry.quantity, 0);
        const stock = combination.stock - variantQuantity;
        return {
          ...combination,
          stock,
          status: stock === 0 ? ("out_of_stock" as const) : combination.status,
        };
      });
      patch.variantCombinations = combinations;
    }
    return patch;
  });
}
