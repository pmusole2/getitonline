import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { action, internalMutation, internalQuery } from "./_generated/server";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import { requireUser } from "./lib/auth";
import { armFinancialPolling } from "./lib/paymentPolling";
import { centsToStoredMajor } from "./lib/catalogMoney";
import {
  deriveOrderSlices,
  prepareCartStockPatches,
  type CartStockInput,
  type OrderSlice,
} from "./lib/applyQuoteOrders";
import { QuoteError, QuoteMismatchError, computeCheckoutQuote, type CheckoutQuote } from "./lib/checkoutQuote";
import { snapshotCapturedCartRow } from "./lib/checkoutCartSnapshot";
import {
  canReserveLoyaltyPoints,
  countActiveRedemptions,
  countActiveRedemptionsForUser,
  isValidLoyaltyCounters,
  metadataNamesCheckoutOrder,
} from "./lib/checkoutReservations";
import { createLencoAdapter, type LencoFetch } from "./lib/lencoAdapter";
import { checkoutCoverageConsumed, validateCheckoutAccounting } from "./lib/checkoutSettlement";
import {
  buildCheckoutRequestIdentity,
  checkoutCollectionRequestValidator,
  checkoutInitiateResultValidator,
  checkoutMismatchValidator,
  claimedCheckoutResultValidator,
  destinationKeyForMm,
  generateCheckoutReference,
  isValidCheckoutReference,
  normalizeCheckoutCollectionRequest,
  normalizeOperator,
  normalizePhone,
  normalizeRequestId,
  validateProviderAmount,
  OperationError,
  PROVIDER_CURRENCY,
  zambiaOperatorValidator,
  type CheckoutInitiateResult,
  type ClaimedCheckoutResult,
  type CollectionDestinationFacts,
  type NormalizedCheckoutCollectionRequest,
  type ProviderInitiateSuccess,
  type ProviderReceiptFacts,
} from "./lib/providerOperationContracts";

// Verified-owner non-card checkout collection (Task3B2). A verified owner
// approves a fresh authoritative quote; one atomic mutation reserves orders,
// stock, promo and loyalty, and claims exactly one collection POST. Unknown
// outcomes retain every reservation. Trusted success and failure settle only
// through the single Task4B writer; this slice never pays escrow, moves
// wallet money, refunds, or writes financial succeeded/failed itself. Cards
// are excluded.

export type CheckoutDeps = {
  env: () => Record<string, string | undefined>;
  fetchImpl?: LencoFetch;
};

type CheckoutActionCtx = Pick<ActionCtx, "auth" | "runQuery" | "runMutation">;

type CheckoutOperation = Extract<Doc<"paymentOperations">, { kind: "checkout_collection" }>;

function centsToMajorOrThrow(cents: number): number {
  const major = centsToStoredMajor(cents);
  if (major === null) {
    throw new OperationError("invalid_amount", "A checkout amount that round-trips losslessly is required.");
  }
  return major;
}

function readServerConfig(env: Record<string, string | undefined>): {
  apiKey: string;
  baseUrl?: string;
} {
  // Server-only configuration. Values are never logged, never returned, and
  // never pass through function arguments: only the constructed adapter sees
  // the key. Collections never require a debit account.
  const config: { apiKey: string; baseUrl?: string } = {
    apiKey: env["LENCO_API_KEY"] ?? "",
  };
  const baseUrl = env["LENCO_BASE_URL"];
  if (baseUrl !== undefined) {
    config.baseUrl = baseUrl;
  }
  return config;
}

async function loadPaymentsSwitch(ctx: MutationCtx): Promise<boolean> {
  const config = await ctx.db
    .query("appConfig")
    .withIndex("by_key", (q) => q.eq("key", "singleton"))
    .first();
  return config?.paymentsEnabled === true;
}

async function loadExistingRequest(
  ctx: MutationCtx,
  ownerId: Id<"users">,
  requestId: string
): Promise<Array<Doc<"paymentOperations">>> {
  return await ctx.db
    .query("paymentOperations")
    .withIndex("by_owner_request", (q) => q.eq("ownerId", ownerId).eq("requestId", requestId))
    .collect();
}

async function allocateCheckoutReference(ctx: MutationCtx): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const reference = generateCheckoutReference();
    if (!isValidCheckoutReference(reference)) {
      continue;
    }
    const collision = await ctx.db
      .query("paymentOperations")
      .withIndex("by_provider_reference", (q) => q.eq("providerReference", reference))
      .first();
    if (collision === null) {
      return reference;
    }
  }
  throw new OperationError("review_needed", "This request needs review before a reference can be issued.");
}

async function loadFreshQuote(
  ctx: MutationCtx,
  actor: Doc<"users">,
  request: NormalizedCheckoutCollectionRequest
): Promise<CheckoutQuote> {
  try {
    return await computeCheckoutQuote(ctx, actor, {
      source: request.source,
      ...(request.orderIds === undefined ? {} : { orderIds: request.orderIds }),
      ...(request.deliveryMethodId === undefined ? {} : { deliveryMethodId: request.deliveryMethodId }),
      ...(request.pickupPointId === undefined ? {} : { pickupPointId: request.pickupPointId }),
      shippingAddress: request.shippingAddress,
      ...(request.promoCode === undefined ? {} : { promoCode: request.promoCode }),
      ...(request.loyaltyPoints === undefined ? {} : { loyaltyPoints: request.loyaltyPoints }),
    });
  } catch (error) {
    if (error instanceof QuoteMismatchError) {
      throw new OperationError(
        "quote_mismatch",
        "The catalog moved since this quote. Refresh and review the new quote."
      );
    }
    if (error instanceof QuoteError) {
      throw new OperationError(error.code, error.message);
    }
    throw error;
  }
}

// A different requestId cannot initiate a second collection for the same
// reserved checkout rows. Same request recovers before this scan. Provider
// top-up/withdrawal rows carry no order or cart selectors and are skipped.
// A checkout keeps its coverage until Task4B positively proves its capture
// or release, so even a terminal-looking local label never frees coverage
// here; paid orders still fail order_not_pending. A proven capture or
// release frees exactly that checkout's cart coverage so a failed attempt
// can retry the original cart and rows retained after success can be
// purchased again. A sticky review keeps blocking even with complete
// funding proof. Original order ids stay protected by the reciprocal
// order/escrow/legacy evidence checks below.
async function assertNoOverlappingOperations(
  ctx: MutationCtx,
  actor: Doc<"users">,
  quote: CheckoutQuote
): Promise<void> {
  const operations = await ctx.db
    .query("paymentOperations")
    .withIndex("by_owner", (q) => q.eq("ownerId", actor._id))
    .collect();
  const covers = (operation: (typeof operations)[number]): boolean => {
    if (operation.kind === "top_up_collection" || operation.kind === "withdrawal_transfer") {
      return false;
    }
    return true;
  };
  if (quote.source === "cart") {
    const captured = new Set<string>();
    for (const operation of operations) {
      if (!covers(operation)) {
        continue;
      }
      if (operation.kind === "checkout_collection" && (await checkoutCoverageConsumed(ctx, operation))) {
        continue;
      }
      if (operation.kind === "wallet_purchase" || operation.kind === "checkout_collection") {
        for (const cartItemId of operation.cartItemIds ?? []) {
          captured.add(cartItemId);
        }
      }
    }
    for (const cartItemId of quote.cartItemIds ?? []) {
      if (captured.has(cartItemId)) {
        throw new OperationError("order_overlap", "These cart lines are already covered by another checkout.");
      }
    }
    return;
  }
  const covered = new Set<string>();
  // Original ORDER-ID coverage is never freed by positive proof: even a
  // proven capture or release keeps blocking a second pending collection on
  // the same ids, behind the reciprocal order/escrow/legacy evidence checks
  // below. Only the cart branch above releases coverage through the consumed
  // qualifier, so a failed attempt can retry the original cart.
  for (const operation of operations) {
    if (!covers(operation)) {
      continue;
    }
    if (operation.kind !== "wallet_purchase" && operation.kind !== "checkout_collection") {
      continue;
    }
    for (const orderId of operation.orderIds) {
      covered.add(orderId);
    }
  }
  for (const orderId of quote.orderIds ?? []) {
    if (covered.has(orderId)) {
      throw new OperationError("order_overlap", "An order in this checkout is already covered by another checkout.");
    }
  }
}

async function loadPendingOrdersForSlices(
  ctx: MutationCtx,
  actor: Doc<"users">,
  quote: CheckoutQuote
): Promise<Array<Doc<"orders">>> {
  const orders: Array<Doc<"orders">> = [];
  for (const orderId of quote.orderIds ?? []) {
    const order = await ctx.db.get(orderId);
    if (!order || order.buyerId !== actor._id) {
      throw new OperationError("order_not_owned", "This order does not belong to the signed-in buyer.");
    }
    if (order.status !== "pending_payment") {
      throw new OperationError("order_not_pending", "Only unpaid orders can be collected for checkout.");
    }
    if (order.operationId !== undefined) {
      throw new OperationError("order_overlap", "An order in this checkout is already covered by another checkout.");
    }
    const escrow = await ctx.db
      .query("escrow")
      .withIndex("by_order", (q) => q.eq("orderId", order._id))
      .first();
    if (escrow) {
      throw new OperationError("order_overlap", "An order in this checkout already holds escrow funds.");
    }
    // Historical provider rows are never funding proof. Any directly linked
    // legacy record against the same order is ambiguous evidence in every
    // local status, so a second financial attempt is refused for review
    // instead of being created. Local failed/cancelled labels are not
    // validated matching receipts and do not authorize another collection.
    const legacyTransactions = await ctx.db
      .query("transactions")
      .withIndex("by_order", (q) => q.eq("orderId", order._id))
      .collect();
    if (legacyTransactions.length > 0) {
      throw new OperationError("evidence_review", "An order in this checkout has prior payment evidence to review.");
    }
    const legacyLedger = await ctx.db
      .query("walletTransactions")
      .withIndex("by_order", (q) => q.eq("orderId", order._id))
      .collect();
    if (legacyLedger.length > 0) {
      throw new OperationError("evidence_review", "An order in this checkout has prior ledger evidence to review.");
    }
    orders.push(order);
  }
  // Aggregate and metadata-only legacy rows name orders without setting
  // orderId, so the verified actor's rows are scanned as well. Only owned
  // metadata is read: a foreign account pointing at these orders proves
  // nothing about this checkout.
  const checkoutOrderIds = new Set((quote.orderIds ?? []).map((orderId) => orderId));
  const ownedTransactions = await ctx.db
    .query("transactions")
    .withIndex("by_user", (q) => q.eq("userId", actor._id))
    .collect();
  const ownedLedger = await ctx.db
    .query("walletTransactions")
    .withIndex("by_user", (q) => q.eq("userId", actor._id))
    .collect();
  for (const row of [...ownedTransactions, ...ownedLedger]) {
    if (metadataNamesCheckoutOrder(row.metadata, checkoutOrderIds)) {
      throw new OperationError("evidence_review", "An order in this checkout has prior payment evidence to review.");
    }
  }
  return orders;
}

async function recheckPromoCounters(ctx: MutationCtx, actor: Doc<"users">, quote: CheckoutQuote): Promise<void> {
  if (quote.promo === undefined) {
    return;
  }
  const record = await ctx.db.get(quote.promo.promoCodeId);
  if (!record || !record.isActive) {
    throw new OperationError("promo_invalid", "This promo code is not valid for this checkout.");
  }
  const now = Date.now();
  if (!(record.startsAt <= now && (record.endsAt === undefined || record.endsAt >= now))) {
    throw new OperationError("promo_invalid", "This promo code is not valid for this checkout.");
  }
  const redemptions = await ctx.db
    .query("promoCodeRedemptions")
    .withIndex("by_promo_code", (q) => q.eq("promoCodeId", record._id))
    .collect();
  if (record.usageLimit !== undefined && countActiveRedemptions(redemptions) >= record.usageLimit) {
    throw new OperationError("promo_invalid", "This promo code has reached its usage limit.");
  }
  if (record.perUserLimit !== undefined) {
    if (countActiveRedemptionsForUser(redemptions, actor._id) >= record.perUserLimit) {
      throw new OperationError("promo_invalid", "This promo code has already been used.");
    }
  }
}

type LoyaltyReservation = {
  account: Doc<"loyaltyAccounts">;
  effectivePoints: number;
} | null;

// Checkout reserves only the frozen effective points: the balance is debited
// once here, and lifetimeRedeemed stays untouched until Task4 capture.
async function loadLoyaltyReservation(
  ctx: MutationCtx,
  actor: Doc<"users">,
  quote: CheckoutQuote
): Promise<LoyaltyReservation> {
  if (quote.loyalty === undefined) {
    return null;
  }
  const effectivePoints = quote.loyalty.points;
  const accounts = await ctx.db
    .query("loyaltyAccounts")
    .withIndex("by_user", (q) => q.eq("userId", actor._id))
    .collect();
  if (accounts.length > 1) {
    throw new OperationError("loyalty_invalid", "Multiple loyalty accounts need review before this checkout.");
  }
  const account = accounts[0];
  if (account === undefined) {
    throw new OperationError("loyalty_invalid", "There are not enough loyalty points for this checkout.");
  }
  if (!isValidLoyaltyCounters(account)) {
    throw new OperationError("loyalty_invalid", "The loyalty account cannot be used for this checkout.");
  }
  if (!canReserveLoyaltyPoints(account, effectivePoints)) {
    throw new OperationError("loyalty_invalid", "There are not enough loyalty points for this checkout.");
  }
  return { account, effectivePoints };
}

function generateOrderNumber(): string {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `ORD-${timestamp}-${random}`;
}

// Every finalized order keeps its slice paired by identity: sorting only
// orders the stored list, never the money. Multiple unequal same-seller
// pending orders and another seller stay correctly paired through the
// sliceByOrder map, never a sorted-index zip.
type FinalizedOrder = {
  orderId: Id<"orders">;
  slice: OrderSlice;
  breakdown: {
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
};

function checkSliceConservation(slices: OrderSlice[], quote: CheckoutQuote): void {
  let total = 0;
  const sellerTotals = new Map<string, number>();
  for (const slice of slices) {
    total += slice.breakdown.totalAmountCents;
    sellerTotals.set(slice.sellerId, (sellerTotals.get(slice.sellerId) ?? 0) + slice.breakdown.totalAmountCents);
  }
  if (total !== quote.totalAmountCents) {
    throw new OperationError("malformed_catalog", "A checkout slice does not conserve the approved quote total.");
  }
  for (const seller of quote.sellers) {
    if ((sellerTotals.get(seller.sellerId) ?? 0) !== seller.totalAmountCents) {
      throw new OperationError("malformed_catalog", "A checkout slice does not conserve the approved seller total.");
    }
  }
}

const persistClaimResultValidator = v.union(
  claimedCheckoutResultValidator,
  v.object({
    mayPost: v.literal(false),
    operationId: v.id("paymentOperations"),
    status: v.union(
      v.literal("reserved"),
      v.literal("attempted"),
      v.literal("unknown"),
      v.literal("succeeded"),
      v.literal("failed"),
      v.literal("cancelled")
    ),
    providerReference: v.string(),
  }),
  checkoutMismatchValidator
);

type PersistClaimResult =
  | ClaimedCheckoutResult
  | {
      mayPost: false;
      operationId: Id<"paymentOperations">;
      status: CheckoutOperation["status"];
      providerReference: string;
    }
  | { ok: false; code: "quote_mismatch"; quote: CheckoutQuote };

// Account-scoped recovery: the immutable request is looked up before any
// config, availability, cart, discount, or switch read. A matching request
// returns its stored status with no new write; a conflicting kind or
// identity rejects; duplicate rows fail to review.
export const recoverCheckoutRequest = internalQuery({
  args: {
    requestId: v.string(),
    requestIdentity: v.string(),
  },
  returns: v.union(
    v.object({
      operationId: v.id("paymentOperations"),
      kind: v.literal("checkout_collection"),
      status: v.union(
        v.literal("reserved"),
        v.literal("attempted"),
        v.literal("unknown"),
        v.literal("succeeded"),
        v.literal("failed"),
        v.literal("cancelled")
      ),
      providerReference: v.string(),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const requestId = normalizeRequestId(args.requestId);
    const existing = await ctx.db
      .query("paymentOperations")
      .withIndex("by_owner_request", (q) => q.eq("ownerId", actor._id).eq("requestId", requestId))
      .collect();
    if (existing.length > 1) {
      throw new OperationError("review_needed", "This request has duplicate records to review.");
    }
    const previous = existing[0];
    if (previous === undefined) {
      return null;
    }
    if (previous.kind !== "checkout_collection" || previous.requestIdentity !== args.requestIdentity) {
      throw new OperationError("conflicting_reuse", "This request id is already used with different inputs.");
    }
    // Terminal success or failure without complete capture/release proof is
    // never exposed as financially applied: the same request recovers as
    // review instead of authorizing a new POST.
    if (
      previous.reviewNeeded === true ||
      previous.status === "succeeded" ||
      previous.status === "failed" ||
      previous.status === "cancelled" ||
      previous.accounting !== undefined
    ) {
      if (!(await validateCheckoutAccounting(ctx, previous))) {
        throw new OperationError("review_needed", "This checkout needs accounting review.");
      }
    }
    return {
      operationId: previous._id,
      kind: previous.kind,
      status: previous.status,
      providerReference: previous.providerReference,
    };
  },
});

// One atomic checkout persist-and-claim. All business checks run before the
// first write; the reserved-to-attempted edge inside this mutation is the
// only transition that authorizes mayPost:true. A lost race against an
// identical concurrent request returns the stored row with mayPost:false
// instead of inserting a duplicate.
export const persistAndClaimCheckout = internalMutation({
  args: {
    expectedUserId: v.id("users"),
    requestId: v.string(),
    source: v.union(v.literal("cart"), v.literal("pending_orders")),
    orderIds: v.optional(v.array(v.id("orders"))),
    deliveryMethodId: v.optional(v.id("deliveryMethods")),
    pickupPointId: v.optional(v.id("pickupPoints")),
    shippingAddress: v.object({
      street: v.string(),
      city: v.string(),
      province: v.string(),
      country: v.string(),
      phone: v.string(),
    }),
    promoCode: v.optional(v.string()),
    loyaltyPoints: v.optional(v.number()),
    expectedQuoteKey: v.string(),
    phone: v.string(),
    operator: zambiaOperatorValidator,
  },
  returns: persistClaimResultValidator,
  handler: async (ctx, args): Promise<PersistClaimResult> => {
    const actor = await requireUser(ctx);
    if (actor._id !== args.expectedUserId) {
      throw new Error("Unauthorized");
    }
    const request = normalizeCheckoutCollectionRequest({
      requestId: args.requestId,
      source: args.source,
      ...(args.orderIds === undefined ? {} : { orderIds: args.orderIds }),
      ...(args.deliveryMethodId === undefined ? {} : { deliveryMethodId: args.deliveryMethodId }),
      ...(args.pickupPointId === undefined ? {} : { pickupPointId: args.pickupPointId }),
      shippingAddress: args.shippingAddress,
      ...(args.promoCode === undefined ? {} : { promoCode: args.promoCode }),
      ...(args.loyaltyPoints === undefined ? {} : { loyaltyPoints: args.loyaltyPoints }),
      expectedQuoteKey: args.expectedQuoteKey,
      phone: args.phone,
      operator: args.operator,
    });
    const requestIdentity = await buildCheckoutRequestIdentity({ actorId: actor._id, request });

    const existing = await loadExistingRequest(ctx, actor._id, request.requestId);
    if (existing.length > 1) {
      throw new OperationError("review_needed", "This request has duplicate records to review.");
    }
    const previous = existing[0];
    if (previous !== undefined) {
      if (previous.kind !== "checkout_collection" || previous.requestIdentity !== requestIdentity) {
        throw new OperationError("conflicting_reuse", "This request id is already used with different inputs.");
      }
      // The same persisted-request branch consumes the same proof: a held
      // or unproven terminal claim never silently replays as applied and a
      // lost response recovers the exact stored state with no new POST.
      if (
        previous.reviewNeeded === true ||
        previous.status === "succeeded" ||
        previous.status === "failed" ||
        previous.status === "cancelled" ||
        previous.accounting !== undefined
      ) {
        if (!(await validateCheckoutAccounting(ctx, previous))) {
          throw new OperationError("review_needed", "This checkout needs accounting review.");
        }
      }
      return {
        mayPost: false,
        operationId: previous._id,
        status: previous.status,
        providerReference: previous.providerReference,
      };
    }

    if (!(await loadPaymentsSwitch(ctx))) {
      throw new OperationError("payments_disabled", "Payments are currently disabled.");
    }
    const quote = await loadFreshQuote(ctx, actor, request);
    if (quote.quoteKey !== request.expectedQuoteKey) {
      return { ok: false as const, code: "quote_mismatch" as const, quote };
    }
    // Positive exact safe/losslessly convertible provider amount. A
    // zero-total checkout rejects with no effects: no fake amount is posted.
    validateProviderAmount(quote.totalAmountCents);
    await assertNoOverlappingOperations(ctx, actor, quote);
    const pendingOrders = quote.source === "pending_orders" ? await loadPendingOrdersForSlices(ctx, actor, quote) : [];
    await recheckPromoCounters(ctx, actor, quote);
    const loyalty = await loadLoyaltyReservation(ctx, actor, quote);
    const slices = deriveOrderSlices(
      quote,
      quote.source === "pending_orders" ? pendingOrders.map((order) => order._id) : undefined
    );
    checkSliceConservation(slices, quote);

    // Snapshot the raw stored selectors for the captured owned cart rows
    // that the fresh approved quote already validated. Captured after quote
    // validation and before writes; Task4 consumes these for cleanup.
    // Quote-resolved choices are never snapshotted: raw selectors only.
    const rawCartSnapshot: Array<{
      cartItemId: Id<"cartItems">;
      ownerId: Id<"users">;
      productId: Id<"products">;
      quantity: number;
      variantId: string;
      variantSku: string;
      options: Array<{ name: string; value: string }>;
      addOns: string[];
      shippingName: string;
    }> = [];
    if (quote.source === "cart") {
      const lineProductByCartItem = new Map<Id<"cartItems">, Id<"products">>();
      for (const line of quote.lines) {
        if (line.cartItemId !== undefined) {
          lineProductByCartItem.set(line.cartItemId, line.productId);
        }
      }
      for (const cartItemId of quote.cartItemIds ?? []) {
        const row = await ctx.db.get(cartItemId);
        if (!row || row.userId !== actor._id) {
          continue;
        }
        if (row.productId !== lineProductByCartItem.get(cartItemId)) {
          continue;
        }
        const snapshot = snapshotCapturedCartRow(row);
        rawCartSnapshot.push({
          cartItemId,
          ownerId: snapshot.ownerId,
          productId: snapshot.productId,
          quantity: snapshot.quantity,
          variantId: snapshot.variantId,
          variantSku: snapshot.variantSku,
          options: snapshot.options,
          addOns: snapshot.addOns,
          shippingName: snapshot.shippingName,
        });
      }
    }

    // The whole requested set preflights before any write below.
    const finalized: FinalizedOrder[] = [];
    if (quote.source === "pending_orders") {
      const sliceByOrder = new Map<Id<"orders">, OrderSlice>();
      for (const slice of slices) {
        if (slice.orderId === undefined || slice.items.length === 0) {
          throw new OperationError("malformed_catalog", "A pending order is missing from this checkout.");
        }
        sliceByOrder.set(slice.orderId, slice);
      }
      if (sliceByOrder.size !== pendingOrders.length) {
        throw new OperationError("malformed_catalog", "A pending order is missing from this checkout.");
      }
      for (const order of pendingOrders) {
        const slice = sliceByOrder.get(order._id);
        if (!slice) {
          throw new OperationError("malformed_catalog", "A pending order is missing from this checkout.");
        }
        finalized.push({
          orderId: order._id,
          slice,
          breakdown: { ...slice.breakdown, orderId: order._id, sellerId: slice.sellerId },
        });
      }
    }

    // ---- First write below. Everything above denied before writing. ----
    const now = Date.now();
    const amountMajor = centsToMajorOrThrow(quote.totalAmountCents);

    if (quote.source === "cart") {
      const productsById = new Map<string, Doc<"products">>();
      for (const line of quote.lines) {
        if (!productsById.has(line.productId)) {
          const product = await ctx.db.get(line.productId);
          if (!product) {
            throw new OperationError("unavailable", "A listing in this checkout is no longer available.");
          }
          productsById.set(line.productId, product);
        }
      }
      // Aggregate and authoritative variant stock are reserved exactly once.
      const stockInputs: CartStockInput[] = [...productsById.values()].map((product) => ({
        product,
        quantities: quote.lines
          .filter((line) => line.productId === product._id)
          .map((line) => ({ quantity: line.quantity, variantId: line.variant?.variantId })),
      }));
      for (const patch of prepareCartStockPatches(stockInputs)) {
        const fields: {
          quantity: number;
          status?: Doc<"products">["status"];
          variantCombinations?: Doc<"products">["variantCombinations"];
        } = {
          quantity: patch.quantity,
        };
        if (patch.status !== undefined) {
          fields.status = patch.status;
        }
        if (patch.variantCombinations !== undefined) {
          fields.variantCombinations = patch.variantCombinations;
        }
        await ctx.db.patch(patch.productId, { ...fields, updatedAt: now });
      }
      // One pending_payment order per seller from the canonical frozen
      // items, address, delivery, and exact slice. Cart rows stay until
      // trusted Task4 success.
      for (const slice of slices) {
        const orderId = await ctx.db.insert("orders", {
          orderNumber: generateOrderNumber(),
          buyerId: actor._id,
          sellerId: slice.sellerId,
          items: slice.items,
          subtotal: slice.stored.subtotal,
          discountAmount: slice.stored.discountAmount,
          ...(quote.promo === undefined ? {} : { promoCodeId: quote.promo.promoCodeId, promoCode: quote.promo.code }),
          shippingCost: slice.stored.shippingCost,
          platformFee: slice.stored.platformFee,
          totalAmount: slice.stored.totalAmount,
          sellerPayout: slice.stored.sellerPayout,
          ...(quote.delivery.methodId === undefined ? {} : { deliveryMethodId: quote.delivery.methodId }),
          deliveryMethodName: quote.delivery.name,
          ...(quote.delivery.minDays === undefined || quote.delivery.maxDays === undefined
            ? {}
            : { deliveryEta: { minDays: quote.delivery.minDays, maxDays: quote.delivery.maxDays } }),
          ...(quote.delivery.pickupPointId === undefined ? {} : { pickupPointId: quote.delivery.pickupPointId }),
          shippingAddress: quote.shippingAddress,
          status: "pending_payment",
          createdAt: now,
          updatedAt: now,
        });
        // The insert id is captured onto its slice immediately: production
        // ids are opaque, so money never follows a sorted position.
        finalized.push({
          orderId,
          slice,
          breakdown: { ...slice.breakdown, orderId, sellerId: slice.sellerId },
        });
      }
    } else {
      // Pending source: refresh each owned existing pending order with its
      // identity-paired canonical slice. Inventory is NOT decremented again.
      for (const entry of finalized) {
        const slice = entry.slice;
        await ctx.db.patch(entry.orderId, {
          items: slice.items,
          subtotal: slice.stored.subtotal,
          discountAmount: slice.stored.discountAmount,
          ...(quote.promo === undefined
            ? { promoCodeId: undefined, promoCode: undefined }
            : { promoCodeId: quote.promo.promoCodeId, promoCode: quote.promo.code }),
          shippingCost: slice.stored.shippingCost,
          platformFee: slice.stored.platformFee,
          totalAmount: slice.stored.totalAmount,
          sellerPayout: slice.stored.sellerPayout,
          ...(quote.delivery.methodId === undefined
            ? { deliveryMethodId: undefined }
            : { deliveryMethodId: quote.delivery.methodId }),
          deliveryMethodName: quote.delivery.name,
          ...(quote.delivery.minDays === undefined || quote.delivery.maxDays === undefined
            ? { deliveryEta: undefined }
            : { deliveryEta: { minDays: quote.delivery.minDays, maxDays: quote.delivery.maxDays } }),
          ...(quote.delivery.pickupPointId === undefined
            ? { pickupPointId: undefined }
            : { pickupPointId: quote.delivery.pickupPointId }),
          shippingAddress: quote.shippingAddress,
          status: "pending_payment",
          updatedAt: now,
        });
      }
    }
    // The stored list is sorted for return and recovery only; every money
    // fact above follows the finalized identity pairing.
    const orderIds = finalized.map((entry) => entry.orderId);
    orderIds.sort();

    const breakdowns = finalized.map((entry) => entry.breakdown);
    const providerReference = await allocateCheckoutReference(ctx);
    const phone = normalizePhone(request.phone);
    const operator = normalizeOperator(request.operator);
    const destinationKey = destinationKeyForMm(phone, operator);
    const destination: CollectionDestinationFacts = { phone, operator, country: "zm" };

    const operationId = await ctx.db.insert("paymentOperations", {
      ownerId: actor._id,
      requestId: request.requestId,
      kind: "checkout_collection",
      status: "reserved",
      source: quote.source,
      requestIdentity,
      quoteKey: quote.quoteKey,
      quoteSnapshot: quote,
      orderBreakdowns: breakdowns,
      orderIds,
      ...(quote.cartItemIds === undefined ? {} : { cartItemIds: [...quote.cartItemIds].sort() }),
      ...(rawCartSnapshot.length === 0 ? {} : { rawCartSnapshot }),
      providerReference,
      amountCents: quote.totalAmountCents,
      currency: PROVIDER_CURRENCY,
      destinationKey,
      collectionDestination: destination,
      ...(loyalty === null ? {} : { loyaltyAccountId: loyalty.account._id, loyaltyPoints: loyalty.effectivePoints }),
      createdAt: now,
      updatedAt: now,
    });

    for (const entry of finalized) {
      await ctx.db.patch(entry.orderId, { operationId, updatedAt: now });
    }

    // The linked pending collection companion carries the TXN provider
    // reference, exact majors, currency, owner, and checkout order ids for
    // later Task4 matching. Pending evidence only, never funding proof.
    const companionId = await ctx.db.insert("transactions", {
      userId: actor._id,
      reference: providerReference,
      type: "collection",
      paymentMethod: "mobile_money",
      mobileMoneyProvider: operator,
      mobileNumber: phone,
      amount: amountMajor,
      currency: PROVIDER_CURRENCY,
      status: "pending",
      description: "Checkout collection.",
      metadata: { operationId, checkoutOrderIds: orderIds },
      operationId,
      initiatedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(operationId, { transactionId: companionId, updatedAt: now });

    // One promo usage per operation with the authoritative effective
    // discount amount and a reciprocal operation link. Multi-seller checkout
    // is not multiple promo usages.
    if (quote.promo !== undefined) {
      const firstOrderId = orderIds[0];
      if (firstOrderId === undefined) {
        throw new OperationError("malformed_catalog", "A checkout order is missing from this checkout.");
      }
      const redemptionId = await ctx.db.insert("promoCodeRedemptions", {
        promoCodeId: quote.promo.promoCodeId,
        userId: actor._id,
        orderId: firstOrderId,
        discountAmount: centsToMajorOrThrow(quote.promo.discountCents),
        redeemedAt: now,
        operationId,
        status: "reserved",
      });
      await ctx.db.patch(operationId, { promoRedemptionId: redemptionId, updatedAt: now });
    }

    // Only the frozen effective loyalty points are reserved: the balance is
    // debited once, lifetimeRedeemed stays untouched until Task4 capture,
    // and lifetimeEarned/tier are retained.
    if (loyalty) {
      const firstOrderId = orderIds[0];
      await ctx.db.patch(loyalty.account._id, {
        pointsBalance: loyalty.account.pointsBalance - loyalty.effectivePoints,
        updatedAt: now,
      });
      const loyaltyTransactionId = await ctx.db.insert("loyaltyTransactions", {
        accountId: loyalty.account._id,
        userId: actor._id,
        type: "redeem",
        points: loyalty.effectivePoints,
        ...(firstOrderId === undefined ? {} : { orderId: firstOrderId }),
        reason: "Checkout collection reservation.",
        operationId,
        status: "reserved",
        createdAt: now,
      });
      await ctx.db.patch(operationId, { loyaltyTransactionId, updatedAt: now });
    }

    // paymentsEnabled is rechecked at claim: a disabled switch between the
    // preflight and this edge denies before the single POST is authorized.
    if (!(await loadPaymentsSwitch(ctx))) {
      throw new OperationError("payments_disabled", "Payments are currently disabled.");
    }
    await ctx.db.patch(operationId, { status: "attempted", attemptedAt: now, updatedAt: now });
    await armFinancialPolling(ctx, operationId);

    return {
      mayPost: true,
      operationId,
      kind: "checkout_collection",
      providerReference,
      amountCents: quote.totalAmountCents,
      collectionDestination: destination,
    };
  },
});

type RecoveryProjection = {
  operationId: Id<"paymentOperations">;
  kind: "checkout_collection";
  status: CheckoutOperation["status"];
  providerReference: string;
};

async function reuseResult(ctx: CheckoutActionCtx, found: RecoveryProjection): Promise<ProviderInitiateSuccess> {
  if (found.status === "attempted") {
    // Claim-then-crash heals to unknown with no POST.
    await ctx.runMutation(internal.providerOperations.markUnknown, { operationId: found.operationId });
    return { ok: true, operationId: found.operationId, status: "unknown", providerReference: found.providerReference };
  }
  return {
    ok: true,
    operationId: found.operationId,
    status: found.status,
    providerReference: found.providerReference,
  };
}

// Public checkout initiation. Recovery runs before config, availability,
// cart, discount, or switch reads; a repeat returns its stored status with
// zero POST and zero writes. Missing or invalid private config yields safe
// not_started with none of those effects either. Exactly one POST follows
// the single new claim: a normalized receipt settles through the same
// writer while absent or ambiguous outcomes attach as unknown with all
// reservations retained.
export function createCheckoutCollectionAction(deps: CheckoutDeps) {
  return action({
    args: checkoutCollectionRequestValidator,
    returns: checkoutInitiateResultValidator,
    handler: async (ctx, args): Promise<CheckoutInitiateResult> => {
      const actor = await ctx.runQuery(internal.providerOperations.resolveActor, {});
      const request = normalizeCheckoutCollectionRequest({
        requestId: args.requestId,
        source: args.source,
        ...(args.orderIds === undefined ? {} : { orderIds: args.orderIds }),
        ...(args.deliveryMethodId === undefined ? {} : { deliveryMethodId: args.deliveryMethodId }),
        ...(args.pickupPointId === undefined ? {} : { pickupPointId: args.pickupPointId }),
        shippingAddress: args.shippingAddress,
        ...(args.promoCode === undefined ? {} : { promoCode: args.promoCode }),
        ...(args.loyaltyPoints === undefined ? {} : { loyaltyPoints: args.loyaltyPoints }),
        expectedQuoteKey: args.expectedQuoteKey,
        phone: args.phone,
        operator: args.operator,
      });
      const requestIdentity = await buildCheckoutRequestIdentity({ actorId: actor.userId, request });

      const existing = await ctx.runQuery(internal.checkoutCollection.recoverCheckoutRequest, {
        requestId: request.requestId,
        requestIdentity,
      });
      if (existing !== null) {
        return await reuseResult(ctx, existing);
      }

      const adapter = createLencoAdapter(readServerConfig(deps.env()), deps.fetchImpl);
      if (!adapter.configured) {
        throw new OperationError("not_started", "The provider is not configured.");
      }

      const persisted = await ctx.runMutation(internal.checkoutCollection.persistAndClaimCheckout, {
        expectedUserId: actor.userId,
        requestId: request.requestId,
        source: request.source,
        ...(request.orderIds === undefined ? {} : { orderIds: request.orderIds }),
        ...(request.deliveryMethodId === undefined ? {} : { deliveryMethodId: request.deliveryMethodId }),
        ...(request.pickupPointId === undefined ? {} : { pickupPointId: request.pickupPointId }),
        shippingAddress: request.shippingAddress,
        ...(request.promoCode === undefined ? {} : { promoCode: request.promoCode }),
        ...(request.loyaltyPoints === undefined ? {} : { loyaltyPoints: request.loyaltyPoints }),
        expectedQuoteKey: request.expectedQuoteKey,
        phone: request.phone,
        operator: request.operator,
      });
      if (!("mayPost" in persisted) && persisted.ok === false) {
        return persisted;
      }
      if (!("mayPost" in persisted) || !persisted.mayPost) {
        const stored = persisted as {
          operationId: Id<"paymentOperations">;
          status: CheckoutOperation["status"];
          providerReference: string;
        };
        return {
          ok: true,
          operationId: stored.operationId,
          status: stored.status,
          providerReference: stored.providerReference,
        };
      }

      if (persisted.kind !== "checkout_collection") {
        // Impossible through the typed persist edge: retain the claimed
        // operation for review instead of inventing a payout route.
        throw new OperationError("review_needed", "This request needs review before transport.");
      }

      // One POST only, driven by the immutable claim facts. The row, all
      // reservations, and the companion already exist at fetch time.
      let receipt: ProviderReceiptFacts | undefined;
      let failureCode: string | undefined;
      try {
        const result = await adapter.initiateMobileMoneyCollection({
          reference: persisted.providerReference,
          phone: persisted.collectionDestination.phone,
          operator: persisted.collectionDestination.operator,
          amountMinor: persisted.amountCents,
        });
        if (result.ok) {
          receipt = {
            kind: "collection",
            id: result.value.id,
            reference: result.value.reference,
            amountMinor: result.value.amountMinor,
            feeMinor: result.value.feeMinor,
            currency: PROVIDER_CURRENCY,
            status: result.value.status,
            collectionType: "mobile-money",
            country: "zm",
            bearer: "merchant",
            operator: result.value.operator,
            phone: result.value.phone,
            reasonForFailure: result.value.reasonForFailure,
            settlementStatus: result.value.settlementStatus,
          };
        } else {
          failureCode = result.code;
        }
      } catch {
        failureCode = "provider_error";
      }
      // A normalized receipt enters the same settlement writer with
      // internally constructed initiation provenance and returns the actual
      // safe financial state. Absent or ambiguous outcomes stay
      // evidence-only with every reservation retained.
      const attached =
        receipt === undefined
          ? await ctx.runMutation(internal.providerOperations.attachProviderResult, {
              operationId: persisted.operationId,
              ...(failureCode === undefined ? {} : { failureCode }),
            })
          : await ctx.runMutation(internal.providerSettlement.settleProviderReceipt, {
              operationId: persisted.operationId,
              receipt,
              acquisition: { kind: "initiation_post", operationId: persisted.operationId },
            });
      return {
        ok: true,
        operationId: persisted.operationId,
        status: attached.status,
        providerReference: persisted.providerReference,
      };
    },
  });
}

export const initiateCheckoutCollection = createCheckoutCollectionAction({ env: () => process.env });
