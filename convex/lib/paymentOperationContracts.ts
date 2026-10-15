import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { QUOTE_ERROR_CODES, checkoutQuoteValidator, sha256Hex, stableStringify } from "./checkoutQuote";

// Typed request/response contracts for the atomic wallet purchase slice
// (Task3A). No provider, scheduling, or speculative fields live here:
// Task3B expands operation kind/state/receipt contracts when a real
// provider consumer exists.

export const purchaseSourceValidator = v.union(v.literal("cart"), v.literal("pending_orders"));

export const purchaseAddressValidator = v.object({
  street: v.string(),
  city: v.string(),
  province: v.string(),
  country: v.string(),
  phone: v.string(),
});

// Public purchase args: an account-scoped requestId plus the existing quote
// selectors and a REQUIRED expected quote key. No acting ids, seller
// authority, or amount/subtotal/discount/price fields exist on this input.
export const purchaseRequestValidator = v.object({
  requestId: v.string(),
  source: purchaseSourceValidator,
  orderIds: v.optional(v.array(v.id("orders"))),
  deliveryMethodId: v.optional(v.id("deliveryMethods")),
  pickupPointId: v.optional(v.id("pickupPoints")),
  shippingAddress: purchaseAddressValidator,
  promoCode: v.optional(v.string()),
  loyaltyPoints: v.optional(v.number()),
  expectedQuoteKey: v.string(),
});

export type PurchaseRequestArgs = {
  requestId: string;
  source: "cart" | "pending_orders";
  orderIds?: Array<Id<"orders">>;
  deliveryMethodId?: Id<"deliveryMethods">;
  pickupPointId?: Id<"pickupPoints">;
  shippingAddress: {
    street: string;
    city: string;
    province: string;
    country: string;
    phone: string;
  };
  promoCode?: string;
  loyaltyPoints?: number;
  expectedQuoteKey: string;
};

export type NormalizedPurchaseRequest = {
  requestId: string;
  source: "cart" | "pending_orders";
  orderIds: Array<Id<"orders">> | undefined;
  deliveryMethodId: Id<"deliveryMethods"> | undefined;
  pickupPointId: Id<"pickupPoints"> | undefined;
  shippingAddress: {
    street: string;
    city: string;
    province: string;
    country: string;
    phone: string;
  };
  promoCode: string | undefined;
  loyaltyPoints: number | undefined;
  expectedQuoteKey: string;
};

export const operationKindValidator = v.literal("wallet_purchase");

export const operationStatusValidator = v.literal("succeeded");

// Immutable typed per-order money slices derived from the frozen quote.
// Seller and checkout sums must equal the sum of these slices exactly.
export const perOrderBreakdownValidator = v.object({
  orderId: v.id("orders"),
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

export type PerOrderBreakdown = {
  orderId: Id<"orders">;
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

export const purchaseSuccessValidator = v.object({
  ok: v.literal(true),
  operationId: v.id("paymentOperations"),
  status: operationStatusValidator,
  quoteKey: v.string(),
  requestIdentity: v.string(),
  totalAmountCents: v.number(),
  orderIds: v.array(v.id("orders")),
  walletTransactionId: v.id("walletTransactions"),
});

export type PurchaseSuccess = {
  ok: true;
  operationId: Id<"paymentOperations">;
  status: "succeeded";
  quoteKey: string;
  requestIdentity: string;
  totalAmountCents: number;
  orderIds: Array<Id<"orders">>;
  walletTransactionId: Id<"walletTransactions">;
};

// A stale expected key recovers with the fresh owned quote and zero writes,
// mirroring the read-only quote query contract.
export const purchaseMismatchValidator = v.object({
  ok: v.literal(false),
  code: v.literal("quote_mismatch"),
  quote: checkoutQuoteValidator,
});

export const purchaseWithWalletResultValidator = v.union(purchaseSuccessValidator, purchaseMismatchValidator);

// Owner-only safe projection for recovery. Amounts stay in exact cents; the
// frozen snapshot, addresses, and cross-account facts are never exposed here.
export const operationStatusProjectionValidator = v.object({
  operationId: v.id("paymentOperations"),
  kind: operationKindValidator,
  status: operationStatusValidator,
  source: purchaseSourceValidator,
  requestId: v.string(),
  requestIdentity: v.string(),
  quoteKey: v.string(),
  totalAmountCents: v.number(),
  orderIds: v.array(v.id("orders")),
  walletReference: v.string(),
  walletTransactionId: v.id("walletTransactions"),
  accountingAppliedAt: v.number(),
  createdAt: v.number(),
});

export type OperationStatusProjection = {
  operationId: Id<"paymentOperations">;
  kind: "wallet_purchase";
  status: "succeeded";
  source: "cart" | "pending_orders";
  requestId: string;
  requestIdentity: string;
  quoteKey: string;
  totalAmountCents: number;
  orderIds: Array<Id<"orders">>;
  walletReference: string;
  walletTransactionId: Id<"walletTransactions">;
  accountingAppliedAt: number;
  createdAt: number;
};

export const PURCHASE_ERROR_CODES = [
  ...QUOTE_ERROR_CODES,
  "payments_disabled",
  "wallet_missing",
  "wallet_inactive",
  "wallet_frozen",
  "wallet_malformed",
  "insufficient_funds",
  "order_overlap",
  "evidence_review",
  "conflicting_reuse",
  "review_needed",
] as const;

export type PurchaseErrorCode = (typeof PURCHASE_ERROR_CODES)[number];

// Typed application-error payload carried across the SDK boundary. Plain
// server errors are redacted in production deployments, while ConvexError
// data is preserved, so every business denial below travels in this shape.
export type PurchaseErrorData = {
  code: PurchaseErrorCode;
  message: string;
};

export const purchaseErrorDataValidator = v.object({
  code: v.string(),
  message: v.string(),
});

export function isPurchaseErrorData(value: unknown): value is PurchaseErrorData {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  // Validation boundary: the unknown SDK payload is narrowed field by field.
  const record = value as Record<string, unknown>;
  return (
    typeof record["code"] === "string" && isPurchaseErrorCode(record["code"]) && typeof record["message"] === "string"
  );
}

export class PurchaseError extends ConvexError<PurchaseErrorData> {
  readonly code: PurchaseErrorCode;

  constructor(code: PurchaseErrorCode, message?: string) {
    const resolved = message ?? code;
    super({ code, message: resolved });
    this.name = "PurchaseError";
    this.code = code;
  }
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

function normalizeRequestId(requestId: string): string {
  const trimmed = requestId.trim();
  if (!REQUEST_ID_PATTERN.test(trimmed)) {
    throw new PurchaseError(
      "invalid_request",
      "A request id of 1-128 letters, numbers, dots, dashes, or underscores is required."
    );
  }
  return trimmed;
}

/**
 * Normalizes static purchase selectors exactly the way the quote prices
 * them: trimmed addresses, uppercased promo codes, defaulted points, and
 * sorted order selectors. Dynamic cart contents stay out: the same request
 * must still recover after its cart rows are captured and removed.
 */
export function normalizePurchaseRequest(args: PurchaseRequestArgs): NormalizedPurchaseRequest {
  const requestId = normalizeRequestId(args.requestId);
  if (typeof args.expectedQuoteKey !== "string" || args.expectedQuoteKey === "") {
    throw new PurchaseError("invalid_request", "An expected quote key is required for wallet purchase.");
  }
  return {
    requestId,
    source: args.source,
    orderIds: args.orderIds === undefined ? undefined : [...args.orderIds].sort(),
    deliveryMethodId: args.deliveryMethodId,
    pickupPointId: args.pickupPointId,
    shippingAddress: {
      street: args.shippingAddress.street.trim(),
      city: args.shippingAddress.city.trim(),
      province: args.shippingAddress.province.trim(),
      country: args.shippingAddress.country.trim(),
      phone: args.shippingAddress.phone.trim(),
    },
    promoCode: args.promoCode === undefined ? undefined : args.promoCode.trim().toUpperCase(),
    loyaltyPoints: args.loyaltyPoints,
    expectedQuoteKey: args.expectedQuoteKey,
  };
}

export type RequestIdentityInput = {
  actorId: string;
  request: NormalizedPurchaseRequest;
};

/**
 * Builds the static request fingerprint: the verified actor plus every
 * normalized selector, with no prices and no dynamic cart contents. Stored
 * beside the approved quote key so a reused request id with different
 * inputs rejects as conflicting instead of repricing or double-spending.
 */
export async function buildRequestIdentity(input: RequestIdentityInput): Promise<string> {
  const document = {
    actor: input.actorId,
    source: input.request.source,
    orderIds: input.request.orderIds ?? [],
    ...(input.request.deliveryMethodId === undefined ? {} : { deliveryMethodId: input.request.deliveryMethodId }),
    ...(input.request.pickupPointId === undefined ? {} : { pickupPointId: input.request.pickupPointId }),
    address: {
      street: input.request.shippingAddress.street,
      city: input.request.shippingAddress.city,
      province: input.request.shippingAddress.province,
      country: input.request.shippingAddress.country,
      phone: input.request.shippingAddress.phone,
    },
    ...(input.request.promoCode === undefined ? {} : { promoCode: input.request.promoCode }),
    loyaltyPoints: input.request.loyaltyPoints ?? 0,
  };
  return sha256Hex(stableStringify(document));
}

export function isPurchaseErrorCode(code: string): code is PurchaseErrorCode {
  return (PURCHASE_ERROR_CODES as ReadonlyArray<string>).includes(code);
}
