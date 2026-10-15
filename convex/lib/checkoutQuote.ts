import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { isPositiveSafeCents } from "./lencoAdapter";
import { isPublicStorefrontSeller } from "./platform";
import { countActiveRedemptions, countActiveRedemptionsForUser } from "./checkoutReservations";
import {
  allocateExactCents,
  checkedAdd,
  checkedMultiply,
  finiteMajorToRational,
  isLosslessSignedMajorCents,
  isLosslessStoredMajorCents,
  majorNumberToCents,
  percentDiscountCents,
  platformFeeCents,
  proportionalCents,
  signedMajorToCents,
  type DecimalRational,
} from "./catalogMoney";

// Authoritative checkout quote: prices cart lines or owned pending orders
// from current catalog records in checked integer cents. This module performs
// no writes and no provider calls. Genuine ids are selectors, never authority:
// every price, seller, and discount fact is re-resolved from stored records.

export const QUOTE_CURRENCY = "ZMW" as const;

export type QuoteSource = "cart" | "pending_orders";

export type ShippingAddressInput = {
  street: string;
  city: string;
  province: string;
  country: string;
  phone: string;
};

export type QuoteCheckoutArgs = {
  source: QuoteSource;
  orderIds?: Id<"orders">[];
  deliveryMethodId?: Id<"deliveryMethods">;
  pickupPointId?: Id<"pickupPoints">;
  shippingAddress: ShippingAddressInput;
  promoCode?: string;
  loyaltyPoints?: number;
  expectedQuoteKey?: string;
};

export type QuoteLine = {
  productId: Id<"products">;
  sellerId: Id<"users">;
  cartItemId?: Id<"cartItems">;
  orderId?: Id<"orders">;
  title: string;
  image?: string;
  quantity: number;
  baseCents: number;
  unitCents: number;
  lineTotalCents: number;
  variant?: QuoteVariant;
  optionPairs: QuoteOption[];
  addOns: QuoteAddOn[];
  fallbackShipping?: QuoteFallbackShipping;
  customizationKey: string;
};

export type QuoteVariant = {
  variantId: string;
  sku: string;
  attributes: Array<{ name: string; value: string }>;
  priceCents: number;
  image?: string;
};

export type QuoteOption = {
  name: string;
  value: string;
  deltaCents: number;
  sku?: string;
};

export type QuoteAddOn = {
  name: string;
  priceCents: number;
  description?: string;
};

export type QuoteFallbackShipping = {
  name: string;
  priceCents: number;
};

export type QuoteSeller = {
  sellerId: Id<"users">;
  subtotalCents: number;
  promoCents: number;
  loyaltyCents: number;
  discountCents: number;
  discountedSubtotalCents: number;
  shippingCents: number;
  platformFeeCents: number;
  sellerPayoutCents: number;
  totalAmountCents: number;
};

export type QuoteDelivery = {
  methodId?: Id<"deliveryMethods">;
  pickupPointId?: Id<"pickupPoints">;
  name: string;
  code: string;
  methodType: "standard" | "express" | "same_day" | "pickup" | "product_fallback";
  minDays?: number;
  maxDays?: number;
};

export type CheckoutQuote = {
  currency: "ZMW";
  source: QuoteSource;
  lines: QuoteLine[];
  sellers: QuoteSeller[];
  subtotalCents: number;
  promoCents: number;
  loyaltyCents: number;
  discountCents: number;
  discountedSubtotalCents: number;
  shippingCents: number;
  platformFeeCents: number;
  sellerPayoutCents: number;
  totalAmountCents: number;
  delivery: QuoteDelivery;
  promo?: { promoCodeId: Id<"promoCodes">; code: string; discountCents: number };
  loyalty?: { points: number; discountCents: number };
  shippingAddress: ShippingAddressInput;
  cartItemIds?: Id<"cartItems">[];
  orderIds?: Id<"orders">[];
  inputIdentity: string;
  quoteKey: string;
};

export const QUOTE_ERROR_CODES = [
  "empty",
  "unavailable",
  "insufficient_stock",
  "invalid_variant",
  "invalid_addon",
  "invalid_delivery",
  "invalid_pickup",
  "malformed_money",
  "malformed_catalog",
  "promo_invalid",
  "loyalty_invalid",
  "order_not_owned",
  "order_not_pending",
  "quote_mismatch",
  "self_purchase",
  "invalid_request",
] as const;

export type QuoteErrorCode = (typeof QUOTE_ERROR_CODES)[number];

export type QuoteResult =
  | { ok: true; quote: CheckoutQuote }
  | { ok: false; code: QuoteErrorCode; quote?: CheckoutQuote };

export class QuoteError extends Error {
  readonly code: QuoteErrorCode;

  constructor(code: QuoteErrorCode, message?: string) {
    super(message ?? code);
    this.name = "QuoteError";
    this.code = code;
  }
}

export class QuoteMismatchError extends QuoteError {
  readonly quote: CheckoutQuote;

  constructor(quote: CheckoutQuote) {
    super("quote_mismatch", "The catalog moved since this quote. Refresh and review the new quote.");
    this.name = "QuoteMismatchError";
    this.quote = quote;
  }
}

const addressValidator = v.object({
  street: v.string(),
  city: v.string(),
  province: v.string(),
  country: v.string(),
  phone: v.string(),
});

export const quoteRequestValidator = v.object({
  source: v.union(v.literal("cart"), v.literal("pending_orders")),
  orderIds: v.optional(v.array(v.id("orders"))),
  deliveryMethodId: v.optional(v.id("deliveryMethods")),
  pickupPointId: v.optional(v.id("pickupPoints")),
  shippingAddress: addressValidator,
  promoCode: v.optional(v.string()),
  loyaltyPoints: v.optional(v.number()),
  expectedQuoteKey: v.optional(v.string()),
});

const quoteLineValidator = v.object({
  productId: v.id("products"),
  sellerId: v.id("users"),
  cartItemId: v.optional(v.id("cartItems")),
  orderId: v.optional(v.id("orders")),
  title: v.string(),
  image: v.optional(v.string()),
  quantity: v.number(),
  baseCents: v.number(),
  unitCents: v.number(),
  lineTotalCents: v.number(),
  variant: v.optional(
    v.object({
      variantId: v.string(),
      sku: v.string(),
      attributes: v.array(v.object({ name: v.string(), value: v.string() })),
      priceCents: v.number(),
      image: v.optional(v.string()),
    })
  ),
  optionPairs: v.array(
    v.object({
      name: v.string(),
      value: v.string(),
      deltaCents: v.number(),
      sku: v.optional(v.string()),
    })
  ),
  addOns: v.array(
    v.object({
      name: v.string(),
      priceCents: v.number(),
      description: v.optional(v.string()),
    })
  ),
  fallbackShipping: v.optional(
    v.object({
      name: v.string(),
      priceCents: v.number(),
    })
  ),
  customizationKey: v.string(),
});

const quoteSellerValidator = v.object({
  sellerId: v.id("users"),
  subtotalCents: v.number(),
  promoCents: v.number(),
  loyaltyCents: v.number(),
  discountCents: v.number(),
  discountedSubtotalCents: v.number(),
  shippingCents: v.number(),
  platformFeeCents: v.number(),
  sellerPayoutCents: v.number(),
  totalAmountCents: v.number(),
});

const quoteDeliveryValidator = v.object({
  methodId: v.optional(v.id("deliveryMethods")),
  pickupPointId: v.optional(v.id("pickupPoints")),
  name: v.string(),
  code: v.string(),
  methodType: v.union(
    v.literal("standard"),
    v.literal("express"),
    v.literal("same_day"),
    v.literal("pickup"),
    v.literal("product_fallback")
  ),
  minDays: v.optional(v.number()),
  maxDays: v.optional(v.number()),
});

export const checkoutQuoteValidator = v.object({
  currency: v.literal("ZMW"),
  source: v.union(v.literal("cart"), v.literal("pending_orders")),
  lines: v.array(quoteLineValidator),
  sellers: v.array(quoteSellerValidator),
  subtotalCents: v.number(),
  promoCents: v.number(),
  loyaltyCents: v.number(),
  discountCents: v.number(),
  discountedSubtotalCents: v.number(),
  shippingCents: v.number(),
  platformFeeCents: v.number(),
  sellerPayoutCents: v.number(),
  totalAmountCents: v.number(),
  delivery: quoteDeliveryValidator,
  promo: v.optional(v.object({ promoCodeId: v.id("promoCodes"), code: v.string(), discountCents: v.number() })),
  loyalty: v.optional(v.object({ points: v.number(), discountCents: v.number() })),
  shippingAddress: addressValidator,
  cartItemIds: v.optional(v.array(v.id("cartItems"))),
  orderIds: v.optional(v.array(v.id("orders"))),
  inputIdentity: v.string(),
  quoteKey: v.string(),
});

export const quoteErrorCodeValidator = v.union(
  v.literal("empty"),
  v.literal("unavailable"),
  v.literal("insufficient_stock"),
  v.literal("invalid_variant"),
  v.literal("invalid_addon"),
  v.literal("invalid_delivery"),
  v.literal("invalid_pickup"),
  v.literal("malformed_money"),
  v.literal("malformed_catalog"),
  v.literal("promo_invalid"),
  v.literal("loyalty_invalid"),
  v.literal("order_not_owned"),
  v.literal("order_not_pending"),
  v.literal("quote_mismatch"),
  v.literal("self_purchase"),
  v.literal("invalid_request")
);

export const quoteResultValidator = v.union(
  v.object({ ok: v.literal(true), quote: checkoutQuoteValidator }),
  v.object({ ok: v.literal(false), code: quoteErrorCodeValidator, quote: v.optional(checkoutQuoteValidator) })
);

export type StoredVariantSelection = {
  variantId: string;
  sku: string;
  attributes: Array<{ name: string; value: string }>;
};

export type StoredOptionSelection = {
  name: string;
  value: string;
  sku?: string;
  priceDelta?: number;
};

export type StoredAddOnSelection = {
  name: string;
  description?: string;
  price: number;
};

export type QuotedProduct = {
  _id: string;
  sellerId: string;
  title: string;
  price: number;
  quantity: number;
  status: string;
  images: string[];
  categoryId: string;
  subcategoryId?: string;
  classificationId?: string;
  weightKg?: number;
  variants?: Array<{
    name: string;
    options: Array<{ value: string; priceDelta?: number; quantity?: number; sku?: string }>;
  }>;
  variantCombinations?: Array<{
    id: string;
    sku: string;
    attributes: Array<{ name: string; value: string }>;
    price: number;
    stock: number;
    status: string;
    primaryImage?: string;
  }>;
  addOns?: Array<{ name: string; price: number; description?: string; isRequired: boolean }>;
  shippingOptions?: Array<{ name: string; price: number }>;
};

export type ResolvedLinePricing = {
  baseCents: number;
  unitCents: number;
  addOnCents: number;
  variant:
    | {
        variantId: string;
        sku: string;
        attributes: Array<{ name: string; value: string }>;
        priceCents: number;
        image?: string;
      }
    | undefined;
  optionPairs: Array<{
    name: string;
    value: string;
    deltaCents: number;
    sku?: string;
    capQuantity?: number | undefined;
  }>;
  addOns: Array<{ name: string; priceCents: number; description?: string }>;
  variantStock: number | undefined;
  customizationKey: string;
};

export type StableValue = string | number | boolean | null | StableValue[] | { [key: string]: StableValue | undefined };

/**
 * Serializes a value with sorted object keys so the same logical content
 * always hashes identically regardless of key or array insertion order where
 * the caller sorts arrays first.
 */
export function stableStringify(value: StableValue): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new QuoteError("invalid_request", "The quote cannot be identified from these selectors.");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const parts: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const entry = value[key];
    if (entry === undefined) {
      continue;
    }
    parts.push(`${JSON.stringify(key)}:${stableStringify(entry)}`);
  }
  return `{${parts.join(",")}}`;
}

/** Deterministic SHA-256 hex digest over UTF-8 text. No randomness involved. */
export async function sha256Hex(message: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(message));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Reads a current stock number as an exact non-negative safe integer. Corrupt
 * holdings are malformed, never normalized: any negative, fractional,
 * non-finite, or unsafe value denies the quote as malformed_catalog, so
 * damaged product, variant-combination, and legacy-option records cannot pass
 * as available. Legitimate zero holdings (including owned-reserved and sold
 * records) remain valid.
 */
export function normalizeStock(value: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    return null;
  }
  return value;
}

/**
 * Resolves one saved line against the current product record. Variant ids win
 * over sku fallback, and only a unique sku match is accepted; ambiguous or
 * unknown definitions fail safe. Stored prices, attributes, and images are
 * never trusted: the returned facts (base, variant price and authoritative
 * primary image, option deltas and skus, add-on prices and descriptions) all
 * come from the current catalog record, so a later order can be created from
 * this quote without re-reading or re-pricing. Option deltas may be negative;
 * the final unit clamps at zero.
 */
export function resolveLinePricing(input: {
  product: QuotedProduct;
  selectedVariant?: StoredVariantSelection;
  selectedVariantOptions?: StoredOptionSelection[];
  selectedAddOns?: StoredAddOnSelection[];
  allowReservedStock: boolean;
}): ResolvedLinePricing {
  const product = input.product;
  const baseCents = majorNumberToCents(product.price);
  if (baseCents === null) {
    throw new QuoteError("malformed_money", "A listing price is not a valid amount.");
  }
  const combinations = product.variantCombinations ?? [];
  let variant: ResolvedLinePricing["variant"] = undefined;
  let optionPairs: ResolvedLinePricing["optionPairs"] = [];
  let variantStock: number | undefined = undefined;
  let unitBase = BigInt(baseCents);
  let signedDeltas = BigInt(0);

  if (combinations.length > 0) {
    const stored = input.selectedVariant;
    if (!stored || stored.variantId === "") {
      throw new QuoteError("invalid_variant", "This listing requires a variant choice.");
    }
    const idMatches = combinations.filter((candidate) => candidate.id === stored.variantId);
    let combination: (typeof combinations)[number] | undefined = undefined;
    if (idMatches.length === 1) {
      combination = idMatches[0];
    } else if (idMatches.length > 1) {
      throw new QuoteError("invalid_variant", "This listing has an ambiguous variant definition.");
    } else {
      const skuMatches = combinations.filter((candidate) => candidate.sku === stored.sku);
      if (skuMatches.length !== 1) {
        throw new QuoteError("invalid_variant", "The selected variant is no longer available.");
      }
      combination = skuMatches[0];
    }
    if (combination === undefined) {
      throw new QuoteError("invalid_variant", "The selected variant is no longer available.");
    }
    if (combination.status === "inactive") {
      throw new QuoteError("invalid_variant", "The selected variant is no longer available.");
    }
    if (combination.status !== "active" && combination.status !== "out_of_stock") {
      throw new QuoteError("invalid_variant", "The selected variant is no longer available.");
    }
    const stock = normalizeStock(combination.stock);
    if (stock === null) {
      throw new QuoteError("malformed_catalog", "A listing stock record is not a valid quantity.");
    }
    if (combination.status === "out_of_stock") {
      if (stock > 0) {
        throw new QuoteError("invalid_variant", "The selected variant is no longer available.");
      }
      if (!input.allowReservedStock) {
        throw new QuoteError("insufficient_stock", "The selected variant is out of stock.");
      }
    }
    const combinationCents = majorNumberToCents(combination.price);
    if (combinationCents === null) {
      throw new QuoteError("malformed_money", "A listing price is not a valid amount.");
    }
    variant = {
      variantId: combination.id,
      sku: combination.sku,
      attributes: combination.attributes.map((attribute) => ({ name: attribute.name, value: attribute.value })),
      priceCents: combinationCents,
      ...(typeof combination.primaryImage === "string" ? { image: combination.primaryImage } : {}),
    };
    variantStock = stock;
    unitBase = BigInt(combinationCents);
  } else {
    const variantDefs = product.variants ?? [];
    const seenNames = new Set<string>();
    for (const def of variantDefs) {
      if (seenNames.has(def.name)) {
        throw new QuoteError("malformed_catalog", "A listing has an ambiguous option definition.");
      }
      seenNames.add(def.name);
      const seenValues = new Set<string>();
      for (const option of def.options) {
        if (seenValues.has(option.value)) {
          throw new QuoteError("malformed_catalog", "A listing has an ambiguous option definition.");
        }
        seenValues.add(option.value);
      }
    }
    const storedOptions = input.selectedVariantOptions ?? [];
    const pairs: ResolvedLinePricing["optionPairs"] = [];
    for (const def of variantDefs) {
      const stored = storedOptions.find((option) => option.name === def.name);
      if (!stored) {
        throw new QuoteError("invalid_variant", "This listing requires an option choice.");
      }
      const canonical = def.options.find((option) => option.value === stored.value);
      if (!canonical) {
        throw new QuoteError("invalid_variant", "A selected option is no longer available.");
      }
      const deltaCents = signedMajorToCents(canonical.priceDelta ?? 0);
      if (deltaCents === null) {
        throw new QuoteError("malformed_money", "A listing price is not a valid amount.");
      }
      signedDeltas += BigInt(deltaCents);
      const capQuantity = typeof canonical.quantity === "number" ? canonical.quantity : undefined;
      if (capQuantity !== undefined && normalizeStock(capQuantity) === null) {
        throw new QuoteError("malformed_catalog", "A listing stock record is not a valid quantity.");
      }
      pairs.push({
        name: def.name,
        value: canonical.value,
        deltaCents,
        ...(typeof canonical.sku === "string" ? { sku: canonical.sku } : {}),
        ...(capQuantity === undefined ? {} : { capQuantity }),
      });
    }
    pairs.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    optionPairs = pairs;
  }

  const addOnDefs = product.addOns ?? [];
  const knownAddOns = new Set<string>();
  for (const def of addOnDefs) {
    if (knownAddOns.has(def.name)) {
      throw new QuoteError("malformed_catalog", "A listing has an ambiguous add-on definition.");
    }
    knownAddOns.add(def.name);
  }
  const requestedAddOns = input.selectedAddOns ?? [];
  for (const requested of requestedAddOns) {
    if (!knownAddOns.has(requested.name)) {
      throw new QuoteError("invalid_addon", "A selected add-on is no longer available.");
    }
  }
  const requestedNames = new Set(requestedAddOns.map((entry) => entry.name));
  let addOnTotal = BigInt(0);
  const addOns: ResolvedLinePricing["addOns"] = [];
  for (const def of addOnDefs) {
    if (def.isRequired || requestedNames.has(def.name)) {
      const cents = majorNumberToCents(def.price);
      if (cents === null) {
        throw new QuoteError("malformed_money", "A listing price is not a valid amount.");
      }
      addOnTotal += BigInt(cents);
      addOns.push({
        name: def.name,
        priceCents: cents,
        ...(typeof def.description === "string" ? { description: def.description } : {}),
      });
    }
  }

  const rawUnit = unitBase + signedDeltas + addOnTotal;
  const clamped = rawUnit < BigInt(0) ? BigInt(0) : rawUnit;
  if (clamped > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new QuoteError("malformed_money", "A listing price cannot be represented exactly.");
  }
  const unitCents = Number(clamped);
  const addOnCents = Number(addOnTotal);

  const variantKey = variant ? variant.variantId : "";
  const pairsKey = optionPairs.map((pair) => `${pair.name}:${pair.value}`).join("|");
  const customizationKey = `${product._id}::variant=${variantKey}::variants=${pairsKey}::addons=${addOns
    .map((addOn) => addOn.name)
    .sort()
    .join("|")}`;

  return {
    baseCents,
    unitCents,
    addOnCents,
    variant,
    optionPairs,
    addOns,
    variantStock,
    customizationKey,
  };
}

/**
 * Sums exact weight terms (kilos times quantity) as one rational. All
 * denominators are powers of ten, so scaling to the largest denominator is
 * exact. Returns null for malformed terms.
 */
export function sumWeightTerms(terms: Array<{ kilos: number; quantity: number }>): DecimalRational | null {
  const parsed: Array<{ numerator: bigint; denominator: bigint; quantity: number }> = [];
  for (const term of terms) {
    if (!Number.isSafeInteger(term.quantity) || term.quantity < 1) {
      return null;
    }
    const ratio = finiteMajorToRational(term.kilos);
    if (ratio === null || ratio.numerator < BigInt(0)) {
      return null;
    }
    parsed.push({ numerator: ratio.numerator, denominator: ratio.denominator, quantity: term.quantity });
  }
  let denominator = BigInt(1);
  for (const part of parsed) {
    if (part.denominator > denominator) {
      denominator = part.denominator;
    }
  }
  let numerator = BigInt(0);
  for (const part of parsed) {
    numerator += part.numerator * BigInt(part.quantity) * (denominator / part.denominator);
  }
  return { numerator, denominator };
}

export type CanonicalLineSelector = {
  productId: string;
  quantity: number;
  variantId?: string;
  sku?: string;
  options: Array<{ name: string; value: string }>;
  addOns: string[];
  shippingName?: string;
};

export type CanonicalSelectorDocument = {
  actor: string;
  source: QuoteSource;
  orderIds: string[];
  cartItemIds: string[];
  lines: LineSelectorRecord[];
  deliveryMethodId?: string;
  pickupPointId?: string;
  address: ShippingAddressInput;
  promoCode?: string;
  loyaltyPoints: number;
};

type LineSelectorRecord = {
  productId: string;
  quantity: number;
  variantId?: string;
  sku?: string;
  options: Array<{ name: string; value: string }>;
  addOns: string[];
  shippingName?: string;
};

/**
 * Builds the complete canonical selector document: every effective selector
 * plus the verified actor, with no prices. The priced fingerprint embeds this
 * same document, so changed selectors always require fresh review even when
 * the money is unchanged.
 */
export function canonicalSelectorDocument(input: {
  actorId: string;
  source: QuoteSource;
  orderIds?: string[];
  cartItemIds?: string[];
  lines: CanonicalLineSelector[];
  deliveryMethodId?: string;
  pickupPointId?: string;
  address: ShippingAddressInput;
  promoCode?: string;
  loyaltyPoints: number;
}): CanonicalSelectorDocument {
  const sortedLines = [...input.lines].sort((left, right) => {
    const leftKey = stableStringify(lineSelectorValue(left));
    const rightKey = stableStringify(lineSelectorValue(right));
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  return {
    actor: input.actorId,
    source: input.source,
    orderIds: [...(input.orderIds ?? [])].sort(),
    cartItemIds: [...(input.cartItemIds ?? [])].sort(),
    lines: sortedLines.map(lineSelectorValue),
    ...(input.deliveryMethodId === undefined ? {} : { deliveryMethodId: input.deliveryMethodId }),
    ...(input.pickupPointId === undefined ? {} : { pickupPointId: input.pickupPointId }),
    address: {
      street: input.address.street,
      city: input.address.city,
      province: input.address.province,
      country: input.address.country,
      phone: input.address.phone,
    },
    ...(input.promoCode === undefined ? {} : { promoCode: input.promoCode }),
    loyaltyPoints: input.loyaltyPoints,
  };
}

/**
 * Builds the selector identity: a hash of the complete canonical selectors
 * plus the verified actor, with no prices. Price or allocation moves keep the
 * same identity while changing the priced quote key.
 */
export async function buildInputIdentity(input: {
  actorId: string;
  source: QuoteSource;
  orderIds?: string[];
  cartItemIds?: string[];
  lines: CanonicalLineSelector[];
  deliveryMethodId?: string;
  pickupPointId?: string;
  address: ShippingAddressInput;
  promoCode?: string;
  loyaltyPoints: number;
}): Promise<string> {
  return sha256Hex(stableStringify(canonicalSelectorDocument(input)));
}

function lineSelectorValue(line: CanonicalLineSelector): LineSelectorRecord {
  return {
    productId: line.productId,
    quantity: line.quantity,
    ...(line.variantId === undefined ? {} : { variantId: line.variantId }),
    ...(line.sku === undefined ? {} : { sku: line.sku }),
    options: line.options.map((option) => ({ name: option.name, value: option.value })),
    addOns: [...line.addOns].sort(),
    ...(line.shippingName === undefined ? {} : { shippingName: line.shippingName }),
  };
}

/** Builds the priced quote key: a hash of the complete canonical priced snapshot. */
export async function buildQuoteKey(snapshot: StableValue): Promise<string> {
  return sha256Hex(stableStringify(snapshot));
}

/** Two quotes match only when both the selectors and every priced cent agree. */
export function quotesMatch(first: CheckoutQuote, second: CheckoutQuote): boolean {
  return first.inputIdentity === second.inputIdentity && first.quoteKey === second.quoteKey;
}

type DbReader = Pick<QueryCtx, "db">;

type AssembledLine = {
  product: Doc<"products">;
  quantity: number;
  storedVariant?: StoredVariantSelection;
  storedOptions?: StoredOptionSelection[];
  storedAddOns?: StoredAddOnSelection[];
  cartItemId?: Id<"cartItems">;
  orderId?: Id<"orders">;
  shippingName?: string;
  weightKg: number;
  tiebreak: string;
};

type PricedLine = {
  assembled: AssembledLine;
  pricing: ResolvedLinePricing;
  lineTotalCents: number;
  fallbackShipping?: { name: string; priceCents: number };
};

function readWeightKg(product: Doc<"products">): number {
  const raw = product.weightKg ?? 0;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    throw new QuoteError("malformed_catalog", "A listing weight is not a valid quantity.");
  }
  return raw;
}

async function assertSellerEligible(ctx: DbReader, sellerId: Id<"users">): Promise<void> {
  const seller = await ctx.db.get(sellerId);
  if (!seller) {
    throw new QuoteError("unavailable", "The seller for this listing is no longer available.");
  }
  if (seller.isBanned || seller.deletedAt !== undefined || seller.isDeleted === true) {
    throw new QuoteError("unavailable", "The seller for this listing is no longer available.");
  }
  if (!(await isPublicStorefrontSeller(ctx, sellerId))) {
    throw new QuoteError("unavailable", "The seller for this listing is no longer available.");
  }
}

function failSafe(code: QuoteErrorCode, message: string): never {
  throw new QuoteError(code, message);
}

/**
 * Prices the request from current authoritative records. The actor is the
 * verified caller: staff roles grant no privilege to quote another buyer's
 * cart, orders, or loyalty balance. Throws QuoteError for business denials.
 */
export async function computeCheckoutQuote(
  ctx: DbReader,
  actor: Doc<"users">,
  args: QuoteCheckoutArgs
): Promise<CheckoutQuote> {
  const requestedOrderIds = args.orderIds ?? [];
  if (args.source === "cart") {
    if (requestedOrderIds.length > 0) {
      failSafe("invalid_request", "Order selectors are only valid for pending orders.");
    }
  } else {
    if (requestedOrderIds.length === 0) {
      failSafe("invalid_request", "Pending orders require at least one order.");
    }
    const seenOrders = new Set<string>();
    for (const orderId of requestedOrderIds) {
      if (seenOrders.has(orderId)) {
        failSafe("invalid_request", "Order selectors must be unique.");
      }
      seenOrders.add(orderId);
    }
  }

  const requestedPoints = args.loyaltyPoints ?? 0;
  if (!Number.isSafeInteger(requestedPoints) || requestedPoints < 0) {
    failSafe("loyalty_invalid", "Loyalty points must be a whole number of zero or more.");
  }

  const address: ShippingAddressInput = {
    street: args.shippingAddress.street.trim(),
    city: args.shippingAddress.city.trim(),
    province: args.shippingAddress.province.trim(),
    country: args.shippingAddress.country.trim(),
    phone: args.shippingAddress.phone.trim(),
  };
  if (!address.street || !address.city || !address.province || !address.country || !address.phone) {
    failSafe("invalid_request", "A complete shipping address is required.");
  }

  let promoCode: string | undefined = undefined;
  if (args.promoCode !== undefined) {
    const normalized = args.promoCode.trim().toUpperCase();
    if (normalized === "") {
      failSafe("promo_invalid", "This promo code is not valid for this checkout.");
    }
    promoCode = normalized;
  }

  const allowReservedStock = args.source === "pending_orders";
  const lines: AssembledLine[] = [];
  let cartItemIds: Id<"cartItems">[] | undefined = undefined;
  let pendingOrderIds: Id<"orders">[] | undefined = undefined;

  if (args.source === "cart") {
    const rows = await ctx.db
      .query("cartItems")
      .withIndex("by_user", (q) => q.eq("userId", actor._id))
      .collect();
    if (rows.length === 0) {
      failSafe("empty", "The cart is empty.");
    }
    for (const row of rows) {
      if (!Number.isSafeInteger(row.quantity) || row.quantity < 1) {
        failSafe("malformed_catalog", "A saved cart quantity is not a valid quantity.");
      }
      const product = await ctx.db.get(row.productId);
      if (!product) {
        failSafe("unavailable", "A listing in this checkout is no longer available.");
      }
      lines.push({
        product,
        quantity: row.quantity,
        storedVariant: row.selectedVariant,
        storedOptions: row.selectedVariantOptions,
        storedAddOns: row.selectedAddOns,
        cartItemId: row._id,
        shippingName: row.selectedShipping?.name,
        weightKg: readWeightKg(product),
        tiebreak: `cart:${row._id}`,
      });
    }
    cartItemIds = rows.map((row) => row._id).sort();
  } else {
    for (const orderId of requestedOrderIds) {
      const order = await ctx.db.get(orderId);
      if (!order || order.buyerId !== actor._id) {
        failSafe("order_not_owned", "This order does not belong to the signed-in buyer.");
      }
      if (order.status !== "pending_payment") {
        failSafe("order_not_pending", "Only unpaid orders can be quoted for payment.");
      }
      for (const [itemIndex, item] of order.items.entries()) {
        if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) {
          failSafe("malformed_catalog", "A saved order quantity is not a valid quantity.");
        }
        const product = await ctx.db.get(item.productId);
        if (!product) {
          failSafe("unavailable", "A listing in this checkout is no longer available.");
        }
        if (product.sellerId !== order.sellerId) {
          failSafe("malformed_catalog", "A saved order names a listing from another seller.");
        }
        lines.push({
          product,
          quantity: item.quantity,
          storedVariant: item.selectedVariant,
          storedOptions: item.selectedVariantOptions,
          storedAddOns: item.selectedAddOns,
          orderId: order._id,
          weightKg: readWeightKg(product),
          tiebreak: `order:${order._id}:${itemIndex}`,
        });
      }
    }
    pendingOrderIds = [...requestedOrderIds].sort();
  }
  if (lines.length === 0) {
    failSafe("empty", "There is nothing to quote in this checkout.");
  }

  const priced: PricedLine[] = [];
  const productPools = new Map<string, number>();
  const variantPools = new Map<string, number>();
  const variantStocks = new Map<string, number>();
  const optionPools = new Map<string, { total: number; cap: number | undefined }>();

  for (const line of lines) {
    const product = line.product;
    if (args.source === "cart") {
      if (product.status !== "active") {
        failSafe("unavailable", "A listing in this checkout is no longer available.");
      }
    } else if (product.status !== "active" && product.status !== "sold") {
      failSafe("unavailable", "A listing in this checkout is no longer available.");
    }
    if (product.sellerId === actor._id) {
      failSafe("self_purchase", "A seller cannot buy their own listing.");
    }
    await assertSellerEligible(ctx, product.sellerId);
    const pricing = resolveLinePricing({
      product,
      selectedVariant: line.storedVariant,
      selectedVariantOptions: line.storedOptions,
      selectedAddOns: line.storedAddOns,
      allowReservedStock,
    });
    const lineTotalCents = checkedMultiply(pricing.unitCents, line.quantity);
    if (lineTotalCents === null) {
      failSafe("malformed_money", "A line total cannot be represented exactly.");
    }
    priced.push({ assembled: line, pricing, lineTotalCents });
    productPools.set(product._id, (productPools.get(product._id) ?? 0) + line.quantity);
    if (pricing.variant) {
      const key = `${product._id}::${pricing.variant.variantId}`;
      variantPools.set(key, (variantPools.get(key) ?? 0) + line.quantity);
      if (!variantStocks.has(key) && pricing.variantStock !== undefined) {
        variantStocks.set(key, pricing.variantStock);
      }
    } else {
      for (const cap of pricing.optionPairs) {
        const key = `${product._id}::${cap.name}=${cap.value}`;
        const existing = optionPools.get(key);
        if (existing) {
          existing.total += line.quantity;
        } else {
          optionPools.set(key, { total: line.quantity, cap: cap.capQuantity });
        }
      }
    }
  }

  const seenProducts = new Set<string>();
  for (const line of priced) {
    const productId = line.assembled.product._id;
    if (!seenProducts.has(productId)) {
      seenProducts.add(productId);
      const stock = normalizeStock(line.assembled.product.quantity);
      if (stock === null) {
        failSafe("malformed_catalog", "A listing stock record is not a valid quantity.");
      }
      const pool = productPools.get(productId) ?? 0;
      if (allowReservedStock) {
        const effective = checkedAdd(stock, pool);
        if (effective === null || pool > effective) {
          failSafe("insufficient_stock", "There is not enough stock for this checkout.");
        }
      } else if (pool > stock) {
        failSafe("insufficient_stock", "There is not enough stock for this checkout.");
      }
    }
  }
  for (const [key, pool] of variantPools) {
    const stock = variantStocks.get(key) ?? 0;
    if (allowReservedStock) {
      const effective = checkedAdd(stock, pool);
      if (effective === null || pool > effective) {
        failSafe("insufficient_stock", "There is not enough stock for this checkout.");
      }
    } else if (pool > stock) {
      failSafe("insufficient_stock", "There is not enough stock for this checkout.");
    }
  }
  for (const [, pool] of optionPools) {
    if (pool.cap === undefined) {
      continue;
    }
    const cap = normalizeStock(pool.cap);
    if (cap === null) {
      failSafe("malformed_catalog", "A listing stock record is not a valid quantity.");
    }
    // Legacy per-option quantities are availability caps, never decremented
    // by order reservation (createOrder reserves only the aggregate product
    // and variant-combination pools). Owned pending quantities therefore
    // count against the cap exactly like cart quantities: no top-up.
    if (pool.total > cap) {
      failSafe("insufficient_stock", "There is not enough stock for this checkout.");
    }
  }

  let subtotalCents = 0;
  for (const line of priced) {
    const next = checkedAdd(subtotalCents, line.lineTotalCents);
    if (next === null) {
      failSafe("malformed_money", "The checkout subtotal cannot be represented exactly.");
    }
    subtotalCents = next;
  }
  const totalWeight = sumWeightTerms(
    priced.map((line) => ({ kilos: line.assembled.weightKg, quantity: line.assembled.quantity }))
  );
  if (totalWeight === null) {
    failSafe("malformed_catalog", "A listing weight is not a valid quantity.");
  }

  const sellerIds = [...new Set(priced.map((line) => line.assembled.product.sellerId))].sort();
  const sellerSubtotals = new Map<string, number>();
  for (const sellerId of sellerIds) {
    let sellerSubtotal = 0;
    for (const line of priced) {
      if (line.assembled.product.sellerId !== sellerId) {
        continue;
      }
      const next = checkedAdd(sellerSubtotal, line.lineTotalCents);
      if (next === null) {
        failSafe("malformed_money", "A seller subtotal cannot be represented exactly.");
      }
      sellerSubtotal = next;
    }
    sellerSubtotals.set(sellerId, sellerSubtotal);
  }

  const zones = await ctx.db.query("deliveryZones").collect();
  const matchingZoneIds = new Set<string>();
  for (const zone of zones) {
    if (!zone.isActive) {
      continue;
    }
    if (zone.province !== undefined && zone.province.toLowerCase() !== address.province.toLowerCase()) {
      continue;
    }
    if (zone.city !== undefined && zone.city.toLowerCase() !== address.city.toLowerCase()) {
      continue;
    }
    matchingZoneIds.add(zone._id);
  }
  const methods = await ctx.db.query("deliveryMethods").collect();
  const eligibleMethods = methods.filter(
    (method) => method.isActive && (method.zoneId === undefined || matchingZoneIds.has(method.zoneId))
  );

  let shippingCents = 0;
  let shippingShares: number[] = sellerIds.map(() => 0);
  let delivery: QuoteDelivery;
  if (eligibleMethods.length > 0) {
    if (args.deliveryMethodId === undefined) {
      failSafe("invalid_delivery", "A delivery method is required for this address.");
    }
    const method = await ctx.db.get(args.deliveryMethodId);
    if (!method || !eligibleMethods.some((candidate) => candidate._id === method._id)) {
      failSafe("invalid_delivery", "The selected delivery method is not available for this address.");
    }
    const baseFeeCents = majorNumberToCents(method.baseFee);
    if (baseFeeCents === null) {
      failSafe("malformed_money", "A delivery fee is not a valid amount.");
    }
    const perKgCents = method.perKgFee === undefined ? 0 : majorNumberToCents(method.perKgFee);
    if (perKgCents === null) {
      failSafe("malformed_money", "A delivery fee is not a valid amount.");
    }
    if (method.freeAboveSubtotal !== undefined) {
      const thresholdCents = majorNumberToCents(method.freeAboveSubtotal);
      if (thresholdCents === null) {
        failSafe("malformed_money", "A delivery fee is not a valid amount.");
      }
      if (subtotalCents >= thresholdCents) {
        shippingCents = 0;
      } else {
        const variable = proportionalCents(perKgCents, totalWeight.numerator, totalWeight.denominator);
        if (variable === null) {
          failSafe("malformed_money", "A delivery fee cannot be represented exactly.");
        }
        const fee = checkedAdd(baseFeeCents, variable);
        if (fee === null) {
          failSafe("malformed_money", "A delivery fee cannot be represented exactly.");
        }
        shippingCents = fee;
      }
    } else {
      const variable = proportionalCents(perKgCents, totalWeight.numerator, totalWeight.denominator);
      if (variable === null) {
        failSafe("malformed_money", "A delivery fee cannot be represented exactly.");
      }
      const fee = checkedAdd(baseFeeCents, variable);
      if (fee === null) {
        failSafe("malformed_money", "A delivery fee cannot be represented exactly.");
      }
      shippingCents = fee;
    }
    const shares = allocateExactCents(
      shippingCents,
      sellerIds.map((sellerId) => sellerSubtotals.get(sellerId) ?? 0)
    );
    if (shares === null) {
      failSafe("malformed_money", "The delivery fee cannot be represented exactly.");
    }
    shippingShares = shares;
    if (!Number.isSafeInteger(method.minDays) || method.minDays < 0) {
      failSafe("malformed_catalog", "A delivery estimate is not a valid quantity.");
    }
    if (!Number.isSafeInteger(method.maxDays) || method.maxDays < 0) {
      failSafe("malformed_catalog", "A delivery estimate is not a valid quantity.");
    }
    let pickupPointId: Id<"pickupPoints"> | undefined = undefined;
    if (method.type === "pickup") {
      if (args.pickupPointId === undefined) {
        failSafe("invalid_pickup", "A pickup point is required for this delivery method.");
      }
      const point = await ctx.db.get(args.pickupPointId);
      if (!point || !point.isActive) {
        failSafe("invalid_pickup", "The selected pickup point is not available.");
      }
      if (method.zoneId !== undefined && point.zoneId !== method.zoneId) {
        failSafe("invalid_pickup", "The selected pickup point is not available for this method.");
      }
      pickupPointId = point._id;
    } else if (args.pickupPointId !== undefined) {
      failSafe("invalid_pickup", "This delivery method does not use a pickup point.");
    }
    delivery = {
      methodId: method._id,
      ...(pickupPointId === undefined ? {} : { pickupPointId }),
      name: method.name,
      code: method.code,
      methodType: method.type,
      minDays: method.minDays,
      maxDays: method.maxDays,
    };
  } else {
    // Product fallback exists only when no delivery method can serve this
    // address and no explicit method was selected. Any explicitly selected
    // method that cannot serve the address is denied, never replaced.
    if (args.deliveryMethodId !== undefined) {
      failSafe("invalid_delivery", "The selected delivery method is not available for this address.");
    }
    if (args.pickupPointId !== undefined) {
      failSafe("invalid_pickup", "No pickup point is available for this address.");
    }
    const fallbackShips = new Map<string, number>();
    let fallbackTotal = 0;
    for (const line of priced) {
      const options = line.assembled.product.shippingOptions ?? [];
      const storedName = args.source === "cart" ? line.assembled.shippingName : undefined;
      const matched = storedName === undefined ? undefined : options.find((option) => option.name === storedName);
      const first = options[0];
      const chosen = matched ?? first ?? { name: "Free Delivery", price: 0 };
      const fee = majorNumberToCents(chosen.price);
      if (fee === null) {
        failSafe("malformed_money", "A product shipping price is not a valid amount.");
      }
      line.fallbackShipping = { name: chosen.name, priceCents: fee };
      const sellerId = line.assembled.product.sellerId;
      fallbackShips.set(sellerId, (fallbackShips.get(sellerId) ?? 0) + fee);
      const next = checkedAdd(fallbackTotal, fee);
      if (next === null) {
        failSafe("malformed_money", "The delivery fee cannot be represented exactly.");
      }
      fallbackTotal = next;
    }
    shippingCents = fallbackTotal;
    shippingShares = sellerIds.map((sellerId) => fallbackShips.get(sellerId) ?? 0);
    delivery = { name: "Product shipping", code: "product_fallback", methodType: "product_fallback" };
  }

  let promo: CheckoutQuote["promo"] = undefined;
  const promoShares = new Map<string, number>();
  for (const sellerId of sellerIds) {
    promoShares.set(sellerId, 0);
  }
  if (promoCode !== undefined) {
    const record = await ctx.db
      .query("promoCodes")
      .withIndex("by_code", (q) => q.eq("code", promoCode))
      .first();
    if (!record || !record.isActive) {
      failSafe("promo_invalid", "This promo code is not valid for this checkout.");
    }
    const now = Date.now();
    if (!(record.startsAt <= now && (record.endsAt === undefined || record.endsAt >= now))) {
      failSafe("promo_invalid", "This promo code is not valid for this checkout.");
    }
    const lineProductIds = new Set(priced.map((line) => line.assembled.product._id));
    const lineCategoryIds = new Set<string>();
    for (const line of priced) {
      lineCategoryIds.add(line.assembled.product.categoryId);
      if (line.assembled.product.subcategoryId !== undefined) {
        lineCategoryIds.add(line.assembled.product.subcategoryId);
      }
      if (line.assembled.product.classificationId !== undefined) {
        lineCategoryIds.add(line.assembled.product.classificationId);
      }
    }
    let eligibleBase = 0;
    const eligibleSellers = new Set<string>();
    if (record.scope === "platform") {
      eligibleBase = subtotalCents;
      for (const sellerId of sellerIds) {
        eligibleSellers.add(sellerId);
      }
    } else if (record.scope === "category") {
      if (record.categoryId === undefined || !lineCategoryIds.has(record.categoryId)) {
        failSafe("promo_invalid", "This promo code is not valid for this checkout.");
      }
      eligibleBase = subtotalCents;
      for (const sellerId of sellerIds) {
        eligibleSellers.add(sellerId);
      }
    } else if (record.scope === "product") {
      if (record.productId === undefined || !lineProductIds.has(record.productId)) {
        failSafe("promo_invalid", "This promo code is not valid for this checkout.");
      }
      eligibleBase = subtotalCents;
      for (const sellerId of sellerIds) {
        eligibleSellers.add(sellerId);
      }
    } else {
      if (record.sellerId === undefined || !sellerSubtotals.has(record.sellerId)) {
        failSafe("promo_invalid", "This promo code is not valid for this checkout.");
      }
      eligibleBase = sellerSubtotals.get(record.sellerId) ?? 0;
      eligibleSellers.add(record.sellerId);
    }
    if (record.minimumSubtotal !== undefined) {
      const minimumCents = majorNumberToCents(record.minimumSubtotal);
      if (minimumCents === null) {
        failSafe("malformed_money", "A promo minimum is not a valid amount.");
      }
      if (eligibleBase < minimumCents) {
        failSafe("promo_invalid", "This promo code needs a higher checkout subtotal.");
      }
    }
    let rawDiscount: number;
    if (record.discountType === "percent") {
      if (
        typeof record.discountValue !== "number" ||
        !Number.isFinite(record.discountValue) ||
        record.discountValue < 0
      ) {
        failSafe("malformed_money", "A promo value is not a valid amount.");
      }
      const computed = percentDiscountCents(eligibleBase, record.discountValue);
      if (computed === null) {
        failSafe("malformed_money", "A promo value cannot be represented exactly.");
      }
      rawDiscount = computed;
    } else {
      const fixed = majorNumberToCents(record.discountValue);
      if (fixed === null) {
        failSafe("malformed_money", "A promo value is not a valid amount.");
      }
      rawDiscount = fixed;
    }
    if (record.maxDiscount !== undefined) {
      const maxCents = majorNumberToCents(record.maxDiscount);
      if (maxCents === null) {
        failSafe("malformed_money", "A promo value is not a valid amount.");
      }
      rawDiscount = Math.min(rawDiscount, maxCents);
    }
    rawDiscount = Math.min(rawDiscount, eligibleBase);
    const redemptions = await ctx.db
      .query("promoCodeRedemptions")
      .withIndex("by_promo_code", (q) => q.eq("promoCodeId", record._id))
      .collect();
    if (record.usageLimit !== undefined && countActiveRedemptions(redemptions) >= record.usageLimit) {
      failSafe("promo_invalid", "This promo code has reached its usage limit.");
    }
    if (record.perUserLimit !== undefined) {
      if (countActiveRedemptionsForUser(redemptions, actor._id) >= record.perUserLimit) {
        failSafe("promo_invalid", "This promo code has already been used.");
      }
    }
    const shares = allocateExactCents(
      rawDiscount,
      sellerIds.map((sellerId) => (eligibleSellers.has(sellerId) ? (sellerSubtotals.get(sellerId) ?? 0) : 0))
    );
    if (shares === null) {
      failSafe("malformed_money", "A promo discount cannot be represented exactly.");
    }
    sellerIds.forEach((sellerId, index) => {
      promoShares.set(sellerId, shares[index] ?? 0);
    });
    promo = { promoCodeId: record._id, code: record.code, discountCents: rawDiscount };
  }

  const promoTotal = [...promoShares.values()].reduce((sum, share) => sum + share, 0);
  const postPromoSubtotal = subtotalCents - promoTotal;

  let loyalty: CheckoutQuote["loyalty"] = undefined;
  const loyaltyShares = new Map<string, number>();
  for (const sellerId of sellerIds) {
    loyaltyShares.set(sellerId, 0);
  }
  if (requestedPoints > 0) {
    const account = await ctx.db
      .query("loyaltyAccounts")
      .withIndex("by_user", (q) => q.eq("userId", actor._id))
      .first();
    if (!account) {
      failSafe("loyalty_invalid", "There are not enough loyalty points for this checkout.");
    }
    for (const field of ["pointsBalance", "lifetimeEarned", "lifetimeRedeemed"] as const) {
      const stored = account[field];
      if (!Number.isSafeInteger(stored) || stored < 0) {
        failSafe("loyalty_invalid", "The loyalty account cannot be used for this checkout.");
      }
    }
    const affordable = Math.floor(postPromoSubtotal / 10);
    const effective = Math.min(requestedPoints, account.pointsBalance, affordable);
    const loyaltyTotal = effective * 10;
    const shares = allocateExactCents(
      loyaltyTotal,
      sellerIds.map((sellerId) => (sellerSubtotals.get(sellerId) ?? 0) - (promoShares.get(sellerId) ?? 0))
    );
    if (shares === null) {
      failSafe("malformed_money", "A loyalty discount cannot be represented exactly.");
    }
    sellerIds.forEach((sellerId, index) => {
      loyaltyShares.set(sellerId, shares[index] ?? 0);
    });
    loyalty = { points: effective, discountCents: loyaltyTotal };
  }

  const loyaltyTotal = [...loyaltyShares.values()].reduce((sum, share) => sum + share, 0);
  const discountedSubtotal = subtotalCents - promoTotal - loyaltyTotal;
  const feeTotal = platformFeeCents(discountedSubtotal);
  if (feeTotal === null) {
    failSafe("malformed_money", "The platform fee cannot be represented exactly.");
  }
  const feeShares = allocateExactCents(
    feeTotal,
    sellerIds.map(
      (sellerId) =>
        (sellerSubtotals.get(sellerId) ?? 0) - (promoShares.get(sellerId) ?? 0) - (loyaltyShares.get(sellerId) ?? 0)
    )
  );
  if (feeShares === null) {
    failSafe("malformed_money", "The platform fee cannot be represented exactly.");
  }

  const sellers: QuoteSeller[] = [];
  sellerIds.forEach((sellerId, index) => {
    const sub = sellerSubtotals.get(sellerId) ?? 0;
    const promoShare = promoShares.get(sellerId) ?? 0;
    const loyaltyShare = loyaltyShares.get(sellerId) ?? 0;
    const discount = promoShare + loyaltyShare;
    const discounted = sub - discount;
    const ship = shippingShares[index] ?? 0;
    const fee = feeShares[index] ?? 0;
    const payout = checkedAdd(discounted, ship);
    if (payout === null) {
      failSafe("malformed_money", "A seller payout cannot be represented exactly.");
    }
    const total = checkedAdd(payout, fee);
    if (total === null) {
      failSafe("malformed_money", "A seller total cannot be represented exactly.");
    }
    sellers.push({
      sellerId,
      subtotalCents: sub,
      promoCents: promoShare,
      loyaltyCents: loyaltyShare,
      discountCents: discount,
      discountedSubtotalCents: discounted,
      shippingCents: ship,
      platformFeeCents: fee,
      sellerPayoutCents: payout,
      totalAmountCents: total,
    });
  });

  const sumField = (pick: (seller: QuoteSeller) => number): number =>
    sellers.reduce((sum, seller) => sum + pick(seller), 0);
  const totals = {
    subtotalCents: sumField((seller) => seller.subtotalCents),
    promoCents: sumField((seller) => seller.promoCents),
    loyaltyCents: sumField((seller) => seller.loyaltyCents),
    discountCents: sumField((seller) => seller.discountCents),
    discountedSubtotalCents: sumField((seller) => seller.discountedSubtotalCents),
    shippingCents: sumField((seller) => seller.shippingCents),
    platformFeeCents: sumField((seller) => seller.platformFeeCents),
    sellerPayoutCents: sumField((seller) => seller.sellerPayoutCents),
    totalAmountCents: sumField((seller) => seller.totalAmountCents),
  };
  if (!isPositiveSafeCents(totals.totalAmountCents)) {
    failSafe("invalid_request", "The checkout total must be a positive amount.");
  }

  // Every quoted amount that later becomes a stored or provider numeric major
  // must survive the projection losslessly. Safe-integer cents alone do not
  // imply that: very large totals can lose cents through a double major, so
  // line, component, seller, fee, discount, and shipping amounts all pass the
  // round-trip gate before this quote becomes payment authority.
  const exactCents: number[] = [];
  const exactSignedCents: number[] = [];
  for (const line of priced) {
    exactCents.push(line.pricing.baseCents, line.pricing.unitCents, line.lineTotalCents);
    if (line.pricing.variant !== undefined) {
      exactCents.push(line.pricing.variant.priceCents);
    }
    for (const option of line.pricing.optionPairs) {
      exactSignedCents.push(option.deltaCents);
    }
    for (const addOn of line.pricing.addOns) {
      exactCents.push(addOn.priceCents);
    }
    if (line.fallbackShipping !== undefined) {
      exactCents.push(line.fallbackShipping.priceCents);
    }
  }
  for (const seller of sellers) {
    exactCents.push(
      seller.subtotalCents,
      seller.promoCents,
      seller.loyaltyCents,
      seller.discountCents,
      seller.discountedSubtotalCents,
      seller.shippingCents,
      seller.platformFeeCents,
      seller.sellerPayoutCents,
      seller.totalAmountCents
    );
  }
  exactCents.push(
    totals.subtotalCents,
    totals.promoCents,
    totals.loyaltyCents,
    totals.discountCents,
    totals.discountedSubtotalCents,
    totals.shippingCents,
    totals.platformFeeCents,
    totals.sellerPayoutCents,
    totals.totalAmountCents
  );
  if (promo !== undefined) {
    exactCents.push(promo.discountCents);
  }
  if (loyalty !== undefined) {
    exactCents.push(loyalty.discountCents);
  }
  for (const value of exactCents) {
    if (!isLosslessStoredMajorCents(value)) {
      failSafe("malformed_money", "A checkout amount cannot be represented exactly.");
    }
  }
  for (const value of exactSignedCents) {
    if (!isLosslessSignedMajorCents(value)) {
      failSafe("malformed_money", "A checkout amount cannot be represented exactly.");
    }
  }

  const orderedLines = [...priced].sort((left, right) => {
    const leftSeller = left.assembled.product.sellerId;
    const rightSeller = right.assembled.product.sellerId;
    if (leftSeller !== rightSeller) {
      return leftSeller < rightSeller ? -1 : 1;
    }
    if (left.assembled.product._id !== right.assembled.product._id) {
      return left.assembled.product._id < right.assembled.product._id ? -1 : 1;
    }
    if (left.pricing.customizationKey !== right.pricing.customizationKey) {
      return left.pricing.customizationKey < right.pricing.customizationKey ? -1 : 1;
    }
    if (left.assembled.quantity !== right.assembled.quantity) {
      return left.assembled.quantity < right.assembled.quantity ? -1 : 1;
    }
    // Stable source identity breaks remaining ties: the cart row id for cart
    // lines, the owning order plus the original item position for pending
    // lines. Equal resources therefore order identically no matter how the
    // database or the order selectors enumerate them, while positions inside
    // one order stay meaningful. Distinct customizations never merge.
    if (left.assembled.tiebreak !== right.assembled.tiebreak) {
      return left.assembled.tiebreak < right.assembled.tiebreak ? -1 : 1;
    }
    return 0;
  });

  const linesOut: QuoteLine[] = orderedLines.map((line) => {
    const product = line.assembled.product;
    const canonicalImage = line.pricing.variant?.image ?? product.images[0];
    return {
      productId: product._id,
      sellerId: product.sellerId,
      ...(line.assembled.cartItemId === undefined ? {} : { cartItemId: line.assembled.cartItemId }),
      ...(line.assembled.orderId === undefined ? {} : { orderId: line.assembled.orderId }),
      title: product.title,
      ...(typeof canonicalImage === "string" ? { image: canonicalImage } : {}),
      quantity: line.assembled.quantity,
      baseCents: line.pricing.baseCents,
      unitCents: line.pricing.unitCents,
      lineTotalCents: line.lineTotalCents,
      ...(line.pricing.variant === undefined ? {} : { variant: line.pricing.variant }),
      optionPairs: line.pricing.optionPairs.map((pair) => ({
        name: pair.name,
        value: pair.value,
        deltaCents: pair.deltaCents,
        ...(pair.sku === undefined ? {} : { sku: pair.sku }),
      })),
      addOns: line.pricing.addOns.map((addOn) => ({
        name: addOn.name,
        priceCents: addOn.priceCents,
        ...(addOn.description === undefined ? {} : { description: addOn.description }),
      })),
      ...(line.fallbackShipping === undefined ? {} : { fallbackShipping: line.fallbackShipping }),
      customizationKey: line.pricing.customizationKey,
    };
  });

  const selectors: CanonicalLineSelector[] = orderedLines.map((line) => ({
    productId: line.assembled.product._id,
    quantity: line.assembled.quantity,
    ...(line.pricing.variant === undefined
      ? {}
      : { variantId: line.pricing.variant.variantId, sku: line.pricing.variant.sku }),
    options: line.pricing.optionPairs.map((pair) => ({ name: pair.name, value: pair.value })),
    addOns: line.pricing.addOns.map((addOn) => addOn.name),
    ...(line.fallbackShipping === undefined ? {} : { shippingName: line.fallbackShipping.name }),
  }));

  const selectorDocument = canonicalSelectorDocument({
    actorId: actor._id,
    source: args.source,
    orderIds: pendingOrderIds === undefined ? undefined : [...pendingOrderIds],
    cartItemIds: cartItemIds === undefined ? undefined : [...cartItemIds],
    lines: selectors,
    deliveryMethodId: args.deliveryMethodId,
    pickupPointId: args.pickupPointId,
    address,
    promoCode,
    loyaltyPoints: requestedPoints,
  });
  const inputIdentity = await sha256Hex(stableStringify(selectorDocument));

  // The priced key approves the complete canonical snapshot that this query
  // returns. One fully typed Omit<CheckoutQuote, "quoteKey"> value is both
  // hashed and returned, so no frozen line fact (variant attributes, title,
  // line image, component cents, allocations, delivery/discount facts) can
  // change without moving the key. inputIdentity carries the full canonical
  // selector-document binding into the snapshot; quoteKey itself is never
  // hashed into the snapshot, and no time, volatile, or blob fields exist on
  // the returned quote.
  const snapshot: Omit<CheckoutQuote, "quoteKey"> = {
    currency: QUOTE_CURRENCY,
    source: args.source,
    lines: linesOut,
    sellers,
    ...totals,
    delivery,
    ...(promo === undefined ? {} : { promo }),
    ...(loyalty === undefined ? {} : { loyalty }),
    shippingAddress: address,
    ...(cartItemIds === undefined ? {} : { cartItemIds }),
    ...(pendingOrderIds === undefined ? {} : { orderIds: pendingOrderIds }),
    inputIdentity,
  };
  const quoteKey = await buildQuoteKey(snapshot);

  const quote: CheckoutQuote = { ...snapshot, quoteKey };

  if (args.expectedQuoteKey !== undefined && args.expectedQuoteKey !== quoteKey) {
    throw new QuoteMismatchError(quote);
  }
  return quote;
}
