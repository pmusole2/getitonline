import { requireWalletFundingProof } from "./lib/fundingProof";
import { checkoutCoverageConsumed } from "./lib/checkoutSettlement";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { requireUser } from "./lib/auth";
import { centsToStoredMajor, majorNumberToCents } from "./lib/catalogMoney";
import {
  deriveOrderSlices,
  prepareCartStockPatches,
  type CartStockInput,
  type OrderSlice,
} from "./lib/applyQuoteOrders";
import {
  buildRequestIdentity,
  normalizePurchaseRequest,
  operationStatusProjectionValidator,
  purchaseRequestValidator,
  purchaseWithWalletResultValidator,
  PurchaseError,
  type NormalizedPurchaseRequest,
  type OperationStatusProjection,
  type PurchaseSuccess,
} from "./lib/paymentOperationContracts";
import { QuoteError, QuoteMismatchError, computeCheckoutQuote, type CheckoutQuote } from "./lib/checkoutQuote";
import {
  capturedCartSnapshotsEqual,
  snapshotCapturedCartRow,
  type CapturedCartSnapshot,
} from "./lib/checkoutCartSnapshot";
import {
  countActiveRedemptions,
  countActiveRedemptionsForUser,
  metadataNamesCheckoutOrder,
} from "./lib/checkoutReservations";

// Atomic verified-owner wallet purchase (Task3A). One mutation performs the
// preflight, then the debit, order transitions, escrow holds, discount
// captures, notices, and cart cleanup atomically. No provider calls, no
// scheduling, and no legacy money entry points are used here.

function generateOrderNumber(): string {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `ORD-${timestamp}-${random}`;
}

function generateWalletReference(): string {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `WLT-${timestamp}-${random}`;
}

function centsToMajorOrThrow(cents: number): number {
  const major = centsToStoredMajor(cents);
  if (major === null) {
    throw new PurchaseError("malformed_money", "A checkout amount cannot be represented exactly.");
  }
  return major;
}

async function loadPaymentsSwitch(ctx: MutationCtx): Promise<boolean> {
  const config = await ctx.db
    .query("appConfig")
    .withIndex("by_key", (q) => q.eq("key", "singleton"))
    .first();
  return config?.paymentsEnabled === true;
}

async function loadFreshQuote(
  ctx: MutationCtx,
  actor: Doc<"users">,
  request: NormalizedPurchaseRequest
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
      throw new PurchaseError(
        "quote_mismatch",
        "The catalog moved since this quote. Refresh and review the new quote."
      );
    }
    if (error instanceof QuoteError) {
      throw new PurchaseError(error.code, error.message);
    }
    throw error;
  }
}

type WalletMoney = {
  wallet: Doc<"wallets">;
  balanceCents: number;
  newBalanceCents: number;
  newBalanceMajor: number;
  newTotalSpentMajor: number;
};

async function loadVerifiedWallet(ctx: MutationCtx, actor: Doc<"users">, totalCents: number): Promise<WalletMoney> {
  const wallet = await ctx.db
    .query("wallets")
    .withIndex("by_user", (q) => q.eq("userId", actor._id))
    .first();
  if (!wallet) {
    throw new PurchaseError("wallet_missing", "No wallet exists for the signed-in buyer.");
  }
  if (!wallet.isActive) {
    throw new PurchaseError("wallet_inactive", "The wallet is not active.");
  }
  if (wallet.isFrozen) {
    throw new PurchaseError("wallet_frozen", "The wallet is frozen.");
  }
  const balanceCents = majorNumberToCents(wallet.balance);
  const pendingCents = majorNumberToCents(wallet.pendingBalance);
  const earnedCents = majorNumberToCents(wallet.totalEarned);
  const withdrawnCents = majorNumberToCents(wallet.totalWithdrawn);
  const spentCents = majorNumberToCents(wallet.totalSpent);
  if (
    balanceCents === null ||
    pendingCents === null ||
    earnedCents === null ||
    withdrawnCents === null ||
    spentCents === null
  ) {
    throw new PurchaseError("wallet_malformed", "The wallet holds an amount that cannot be represented exactly.");
  }
  if (balanceCents < totalCents) {
    throw new PurchaseError("insufficient_funds", "The wallet balance does not cover this checkout.");
  }
  const newBalanceCents = balanceCents - totalCents;
  const newTotalSpentCents = spentCents + totalCents;
  const newBalanceMajor = centsToStoredMajor(newBalanceCents);
  const newTotalSpentMajor = centsToStoredMajor(newTotalSpentCents);
  if (newBalanceMajor === null || newTotalSpentMajor === null) {
    throw new PurchaseError("wallet_malformed", "The wallet balance cannot be represented exactly.");
  }
  return { wallet, balanceCents, newBalanceCents, newBalanceMajor, newTotalSpentMajor };
}

async function assertNoOverlappingOperations(
  ctx: MutationCtx,
  actor: Doc<"users">,
  quote: CheckoutQuote
): Promise<void> {
  const operations = await ctx.db
    .query("paymentOperations")
    .withIndex("by_owner", (q) => q.eq("ownerId", actor._id))
    .collect();
  // Provider top-up/withdrawal rows carry no order or cart selectors in this
  // slice, so overlap scans skip exactly those two kinds. A checkout
  // collection keeps its coverage until Task4B positively proves its capture
  // or release, so even a terminal-looking local label never frees coverage
  // here. Paid orders still fail order_not_pending. A proven capture or
  // release frees exactly that checkout's cart coverage so a failed attempt
  // can retry and retained rows can be purchased again, while a sticky
  // review keeps blocking. Every other row (the
  // wallet branch and any malformed legacy row) keeps the previous defensive
  // handling below.
  const isProviderRow = (
    operation: (typeof operations)[number]
  ): operation is Extract<(typeof operations)[number], { kind: "top_up_collection" | "withdrawal_transfer" }> =>
    operation.kind === "top_up_collection" || operation.kind === "withdrawal_transfer";
  if (quote.source === "cart") {
    const captured = new Set<string>();
    for (const operation of operations) {
      if (isProviderRow(operation)) {
        continue;
      }
      if (operation.kind === "checkout_collection" && (await checkoutCoverageConsumed(ctx, operation))) {
        continue;
      }
      for (const cartItemId of operation.cartItemIds ?? []) {
        captured.add(cartItemId);
      }
    }
    for (const cartItemId of quote.cartItemIds ?? []) {
      if (captured.has(cartItemId)) {
        throw new PurchaseError("order_overlap", "These cart lines are already covered by another purchase.");
      }
    }
    return;
  }
  const covered = new Set<string>();
  // Original ORDER-ID coverage is never freed by positive proof: even a
  // proven checkout capture or release keeps blocking a second wallet debit
  // on the same ids, behind the reciprocal order/escrow/legacy evidence
  // checks below. Only the cart branch above releases coverage through the
  // consumed qualifier, so retained rows can still be purchased again.
  for (const operation of operations) {
    if (isProviderRow(operation)) {
      continue;
    }
    for (const orderId of operation.orderIds) {
      covered.add(orderId);
    }
  }
  for (const orderId of quote.orderIds ?? []) {
    if (covered.has(orderId)) {
      throw new PurchaseError("order_overlap", "An order in this checkout is already covered by another purchase.");
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
      throw new PurchaseError("order_not_owned", "This order does not belong to the signed-in buyer.");
    }
    if (order.status !== "pending_payment") {
      throw new PurchaseError("order_not_pending", "Only unpaid orders can be paid with the wallet.");
    }
    if (order.operationId !== undefined) {
      throw new PurchaseError("order_overlap", "An order in this checkout is already covered by another purchase.");
    }
    const escrow = await ctx.db
      .query("escrow")
      .withIndex("by_order", (q) => q.eq("orderId", order._id))
      .first();
    if (escrow) {
      throw new PurchaseError("order_overlap", "An order in this checkout already holds escrow funds.");
    }
    // Historical provider rows are never funding proof. Any directly linked
    // legacy record against the same order is ambiguous evidence in every
    // local status, so a second financial attempt is refused for review
    // instead of being created. Local failed/cancelled labels are not
    // validated matching receipts and do not authorize another debit.
    const legacyTransactions = await ctx.db
      .query("transactions")
      .withIndex("by_order", (q) => q.eq("orderId", order._id))
      .collect();
    if (legacyTransactions.length > 0) {
      throw new PurchaseError("evidence_review", "An order in this checkout has prior payment evidence to review.");
    }
    const legacyLedger = await ctx.db
      .query("walletTransactions")
      .withIndex("by_order", (q) => q.eq("orderId", order._id))
      .collect();
    if (legacyLedger.length > 0) {
      throw new PurchaseError("evidence_review", "An order in this checkout has prior ledger evidence to review.");
    }
    orders.push(order);
  }
  // Aggregate and metadata-only legacy rows name orders without setting
  // orderId, so the verified actor's rows are scanned as well. Only owned
  // metadata is read: a foreign account pointing at these orders proves
  // nothing and grants nothing.
  const checkoutOrderIds = new Set(quote.orderIds ?? []);
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
      throw new PurchaseError("evidence_review", "An order in this checkout has prior payment evidence to review.");
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
    throw new PurchaseError("promo_invalid", "This promo code is not valid for this checkout.");
  }
  const now = Date.now();
  if (!(record.startsAt <= now && (record.endsAt === undefined || record.endsAt >= now))) {
    throw new PurchaseError("promo_invalid", "This promo code is not valid for this checkout.");
  }
  const redemptions = await ctx.db
    .query("promoCodeRedemptions")
    .withIndex("by_promo_code", (q) => q.eq("promoCodeId", record._id))
    .collect();
  if (record.usageLimit !== undefined && countActiveRedemptions(redemptions) >= record.usageLimit) {
    throw new PurchaseError("promo_invalid", "This promo code has reached its usage limit.");
  }
  if (record.perUserLimit !== undefined) {
    if (countActiveRedemptionsForUser(redemptions, actor._id) >= record.perUserLimit) {
      throw new PurchaseError("promo_invalid", "This promo code has already been used.");
    }
  }
}

type LoyaltyCapture = {
  account: Doc<"loyaltyAccounts">;
  effectivePoints: number;
} | null;

async function loadLoyaltyCapture(
  ctx: MutationCtx,
  actor: Doc<"users">,
  quote: CheckoutQuote
): Promise<LoyaltyCapture> {
  if (quote.loyalty === undefined) {
    return null;
  }
  const effectivePoints = quote.loyalty.points;
  const account = await ctx.db
    .query("loyaltyAccounts")
    .withIndex("by_user", (q) => q.eq("userId", actor._id))
    .first();
  if (!account) {
    throw new PurchaseError("loyalty_invalid", "There are not enough loyalty points for this checkout.");
  }
  for (const field of ["pointsBalance", "lifetimeEarned", "lifetimeRedeemed"] as const) {
    const stored = account[field];
    if (!Number.isSafeInteger(stored) || stored < 0) {
      throw new PurchaseError("loyalty_invalid", "The loyalty account cannot be used for this checkout.");
    }
  }
  if (account.pointsBalance < effectivePoints) {
    throw new PurchaseError("loyalty_invalid", "There are not enough loyalty points for this checkout.");
  }
  const nextLifetimeRedeemed = account.lifetimeRedeemed + effectivePoints;
  if (!Number.isSafeInteger(nextLifetimeRedeemed)) {
    throw new PurchaseError("loyalty_invalid", "The loyalty account cannot be used for this checkout.");
  }
  return { account, effectivePoints };
}

// Builds the recoverable success from the frozen wallet operation only when
// the exact debit ledger row links back. Provider top-up/withdrawal rows are
// never a wallet success: they fail to review instead of projecting.
async function successFromOperation(ctx: MutationCtx, operation: Doc<"paymentOperations">): Promise<PurchaseSuccess> {
  if (operation.kind !== "wallet_purchase") {
    throw new PurchaseError("review_needed", "This purchase has a conflicting record to review.");
  }
  const ledgerId = await requireWalletFundingProof(ctx, operation);
  return {
    ok: true,
    operationId: operation._id,
    status: "succeeded",
    quoteKey: operation.quoteKey,
    requestIdentity: operation.requestIdentity,
    totalAmountCents: operation.totalAmountCents,
    orderIds: [...operation.orderIds],
    walletTransactionId: ledgerId,
  };
}

// Raw stored selectors captured for an owned cart row live in
// lib/checkoutCartSnapshot.ts (shared with the checkout collection slice).
// Cleanup compares each current row to its snapshot (raw to raw), never to
// canonical quote normalization, so required add-on insertion, unique-SKU
// fallback, and default-shipping fallback cannot strand an unchanged row.
// The snapshot never establishes authority, never reprices, and never
// consults cached prices, display attributes, images, descriptions, the
// optional customization key, or timestamps.

// One atomic verified-owner wallet purchase. The public args carry the
// account-scoped request id plus quote selectors; the single combined
// quote total is the only debit. Every check below runs before the first
// write, so a denial commits nothing.
export const purchaseWithWallet = mutation({
  args: purchaseRequestValidator,
  returns: purchaseWithWalletResultValidator,
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const request = normalizePurchaseRequest(args);
    const requestIdentity = await buildRequestIdentity({ actorId: actor._id, request });

    // Account-scoped recovery comes before any cart, price, discount,
    // wallet, or switch read. A repeated request returns its stored result
    // with no new debit, order, stock, escrow, or notice.
    const existing = await ctx.db
      .query("paymentOperations")
      .withIndex("by_owner_request", (q) => q.eq("ownerId", actor._id).eq("requestId", request.requestId))
      .collect();
    if (existing.length > 1) {
      throw new PurchaseError("review_needed", "This request has duplicate records to review.");
    }
    const previous = existing[0];
    if (previous !== undefined) {
      // A provider top-up/withdrawal row under the same request id is a
      // cross-kind conflict, never a wallet recovery.
      if (previous.kind !== "wallet_purchase") {
        throw new PurchaseError("conflicting_reuse", "This request id is already used with different inputs.");
      }
      if (previous.requestIdentity !== requestIdentity || previous.quoteKey !== request.expectedQuoteKey) {
        throw new PurchaseError("conflicting_reuse", "This request id is already used with different inputs.");
      }
      return await successFromOperation(ctx, previous);
    }

    if (!(await loadPaymentsSwitch(ctx))) {
      throw new PurchaseError("payments_disabled", "Payments are currently disabled.");
    }
    const quote = await loadFreshQuote(ctx, actor, request);
    if (quote.quoteKey !== request.expectedQuoteKey) {
      return { ok: false as const, code: "quote_mismatch" as const, quote };
    }
    const money = await loadVerifiedWallet(ctx, actor, quote.totalAmountCents);
    await assertNoOverlappingOperations(ctx, actor, quote);
    const pendingOrders = quote.source === "pending_orders" ? await loadPendingOrdersForSlices(ctx, actor, quote) : [];
    await recheckPromoCounters(ctx, actor, quote);
    const loyalty = await loadLoyaltyCapture(ctx, actor, quote);
    const slices = deriveOrderSlices(
      quote,
      quote.source === "pending_orders" ? pendingOrders.map((order) => order._id) : undefined
    );

    // Every finalized order keeps its slice paired by identity from here on:
    // sorting below only orders the stored list, never the money.
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
    const finalized: FinalizedOrder[] = [];
    if (quote.source === "pending_orders") {
      // The whole requested set preflights before any write: every requested
      // order carries exactly one slice with canonical items, so a malformed
      // sibling rejects with all tables unchanged instead of stranding a
      // patched order.
      const sliceByOrder = new Map<Id<"orders">, OrderSlice>();
      for (const slice of slices) {
        if (slice.orderId === undefined || slice.items.length === 0) {
          throw new PurchaseError("malformed_catalog", "A pending order is missing from this checkout.");
        }
        sliceByOrder.set(slice.orderId, slice);
      }
      if (sliceByOrder.size !== pendingOrders.length) {
        throw new PurchaseError("malformed_catalog", "A pending order is missing from this checkout.");
      }
      for (const order of pendingOrders) {
        const slice = sliceByOrder.get(order._id);
        if (!slice) {
          throw new PurchaseError("malformed_catalog", "A pending order is missing from this checkout.");
        }
        finalized.push({
          orderId: order._id,
          slice,
          breakdown: { ...slice.breakdown, orderId: order._id, sellerId: slice.sellerId },
        });
      }
    }

    // Snapshot the raw stored selectors for the captured owned cart rows
    // that the fresh approved quote already validated. Captured before the
    // first write; cleanup compares each current row to its snapshot instead
    // of canonical quote normalization. Only quote-validated rows are
    // captured, so the snapshot never establishes authority or reprices.
    const capturedCartSnapshots = new Map<Id<"cartItems">, CapturedCartSnapshot>();
    if (quote.source === "cart") {
      const lineProductByCartItem = new Map<Id<"cartItems">, Doc<"products">["_id"]>();
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
        capturedCartSnapshots.set(cartItemId, snapshotCapturedCartRow(row));
      }
    }

    // ---- First write below. Everything above denied before writing. ----
    const now = Date.now();
    const totalMajor = centsToMajorOrThrow(quote.totalAmountCents);

    if (quote.source === "cart") {
      const productsById = new Map<string, Doc<"products">>();
      for (const line of quote.lines) {
        if (!productsById.has(line.productId)) {
          const product = await ctx.db.get(line.productId);
          if (!product) {
            throw new PurchaseError("unavailable", "A listing in this checkout is no longer available.");
          }
          productsById.set(line.productId, product);
        }
      }
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
          status: "paid",
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
          status: "paid",
          updatedAt: now,
        });
      }
    }
    // The stored list is sorted for return and recovery only; every money
    // fact below follows the finalized identity pairing.
    const orderIds = finalized.map((entry) => entry.orderId);
    orderIds.sort();

    const breakdowns = finalized.map((entry) => entry.breakdown);
    const walletReference = generateWalletReference();
    const operationId = await ctx.db.insert("paymentOperations", {
      ownerId: actor._id,
      requestId: request.requestId,
      kind: "wallet_purchase",
      status: "succeeded",
      source: quote.source,
      requestIdentity,
      quoteKey: quote.quoteKey,
      quoteSnapshot: quote,
      orderBreakdowns: breakdowns,
      orderIds,
      ...(quote.cartItemIds === undefined ? {} : { cartItemIds: [...quote.cartItemIds].sort() }),
      totalAmountCents: quote.totalAmountCents,
      walletReference,
      debitAmountCents: quote.totalAmountCents,
      walletBalanceAfterCents: money.newBalanceCents,
      ...(quote.loyalty === undefined ? {} : { loyaltyPoints: quote.loyalty.points }),
      ...(quote.promo === undefined ? {} : { promoCodeId: quote.promo.promoCodeId }),
      accountingAppliedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    await ctx.db.patch(money.wallet._id, {
      balance: money.newBalanceMajor,
      totalSpent: money.newTotalSpentMajor,
      lastTransactionAt: now,
      updatedAt: now,
    });
    // The exact debit row id is captured and linked atomically; the frozen
    // operation never relies on the display reference alone.
    const ledgerId = await ctx.db.insert("walletTransactions", {
      walletId: money.wallet._id,
      userId: actor._id,
      type: "debit",
      source: "purchase",
      amount: totalMajor,
      balanceAfter: money.newBalanceMajor,
      reference: walletReference,
      status: "completed",
      description: `Wallet purchase for ${orderIds.length} order${orderIds.length === 1 ? "" : "s"}.`,
      metadata: { operationId, orderIds },
      operationId,
      createdAt: now,
      completedAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(operationId, { walletTransactionId: ledgerId, updatedAt: now });

    for (const entry of finalized) {
      const orderId = entry.orderId;
      const breakdown = entry.breakdown;
      const order = await ctx.db.get(orderId);
      if (!order) {
        throw new PurchaseError("malformed_catalog", "A checkout order is missing from this purchase.");
      }
      await ctx.db.patch(orderId, { operationId, updatedAt: now });
      await ctx.db.insert("escrow", {
        orderId,
        buyerId: order.buyerId,
        sellerId: order.sellerId,
        grossAmount: centsToMajorOrThrow(breakdown.totalAmountCents),
        platformFee: centsToMajorOrThrow(breakdown.platformFeeCents),
        sellerAmount: centsToMajorOrThrow(breakdown.sellerPayoutCents),
        amount: centsToMajorOrThrow(breakdown.totalAmountCents),
        status: "held",
        operationId,
        createdAt: now,
        updatedAt: now,
      });
    }

    if (quote.promo !== undefined) {
      const firstOrderId = orderIds[0];
      if (firstOrderId === undefined) {
        throw new PurchaseError("malformed_catalog", "A checkout order is missing from this purchase.");
      }
      await ctx.db.insert("promoCodeRedemptions", {
        promoCodeId: quote.promo.promoCodeId,
        userId: actor._id,
        orderId: firstOrderId,
        discountAmount: centsToMajorOrThrow(quote.promo.discountCents),
        redeemedAt: now,
        operationId,
      });
    }
    if (loyalty) {
      const firstOrderId = orderIds[0];
      await ctx.db.patch(loyalty.account._id, {
        pointsBalance: loyalty.account.pointsBalance - loyalty.effectivePoints,
        lifetimeRedeemed: loyalty.account.lifetimeRedeemed + loyalty.effectivePoints,
        updatedAt: now,
      });
      await ctx.db.insert("loyaltyTransactions", {
        accountId: loyalty.account._id,
        userId: actor._id,
        type: "redeem",
        points: loyalty.effectivePoints,
        ...(firstOrderId === undefined ? {} : { orderId: firstOrderId }),
        reason: `Wallet purchase ${request.requestId}.`,
        operationId,
        createdAt: now,
      });
    }

    if (quote.source === "cart") {
      const productsById = new Map<string, Doc<"products">>();
      for (const orderId of orderIds) {
        const order = await ctx.db.get(orderId);
        if (!order) {
          continue;
        }
        for (const item of order.items) {
          const product = productsById.get(item.productId) ?? (await ctx.db.get(item.productId));
          if (product) {
            productsById.set(item.productId, product);
            await ctx.db.insert("behaviorEvents", {
              userId: actor._id,
              eventType: "purchase",
              productId: item.productId,
              categoryId: product.categoryId,
              variantId: item.selectedVariant?.variantId,
              quantity: item.quantity,
              metadata: { orderId },
              createdAt: now,
            });
          }
        }
      }
    }

    for (const orderId of orderIds) {
      const order = await ctx.db.get(orderId);
      if (!order) {
        continue;
      }
      await ctx.db.insert("notifications", {
        userId: order.sellerId,
        type: "payment_received",
        title: "Payment Received (Wallet)",
        message: `Payment received for order #${order.orderNumber} via wallet. Please process the order.`,
        data: { orderId, operationId },
        isRead: false,
        createdAt: now,
      });
      await ctx.db.insert("notifications", {
        userId: order.buyerId,
        type: "order_status_update",
        title: "Payment Successful",
        message: `Your wallet payment for order #${order.orderNumber} was successful.`,
        data: { orderId, walletReference, operationId },
        isRead: false,
        createdAt: now,
      });
    }
    await ctx.db.insert("notifications", {
      userId: actor._id,
      type: "wallet_debit",
      title: "Payment Made",
      message: `K${totalMajor.toLocaleString()} has been deducted from your wallet. Wallet purchase for ${orderIds.length} order${orderIds.length === 1 ? "" : "s"}.`,
      data: { operationId, orderIds, walletReference },
      isRead: false,
      createdAt: now,
    });

    if (quote.source === "cart") {
      // Only captured unchanged rows are removed: a current row must still
      // equal the raw snapshot taken after quote approval. Changed, newly
      // added, and foreign rows have no matching snapshot and are retained.
      // Cached prices, display attributes, and the optional legacy key are
      // never authority and never count as selector changes.
      for (const cartItemId of quote.cartItemIds ?? []) {
        const snapshot = capturedCartSnapshots.get(cartItemId);
        if (snapshot === undefined) {
          continue;
        }
        const row = await ctx.db.get(cartItemId);
        if (!row || row.userId !== actor._id) {
          continue;
        }
        if (capturedCartSnapshotsEqual(snapshot, snapshotCapturedCartRow(row))) {
          await ctx.db.delete(cartItemId);
        }
      }
    }

    const operation = await ctx.db.get(operationId);
    if (!operation) {
      throw new PurchaseError("malformed_catalog", "The wallet purchase was not recorded.");
    }
    return await successFromOperation(ctx, operation);
  },
});

// Owner-only recovery for the wallet purchase slice. Only the owning
// account's safe status, exact-cent amounts, order ids, quote key, and
// ledger projection are exposed; cross-account rows stay undisclosed.
export const getMine = query({
  args: { operationId: v.id("paymentOperations") },
  returns: v.union(operationStatusProjectionValidator, v.null()),
  handler: async (ctx, args): Promise<OperationStatusProjection | null> => {
    const actor = await requireUser(ctx);
    const operation = await ctx.db.get(args.operationId);
    if (!operation) {
      return null;
    }
    if (operation.ownerId !== actor._id) {
      throw new Error("Unauthorized");
    }
    // Provider rows are never projected as a wallet purchase; the provider
    // slice owns their status.
    if (operation.kind !== "wallet_purchase") {
      return null;
    }
    const ledgerId = await requireWalletFundingProof(ctx, operation);
    return {
      operationId: operation._id,
      kind: "wallet_purchase",
      status: "succeeded",
      source: operation.source,
      requestId: operation.requestId,
      requestIdentity: operation.requestIdentity,
      quoteKey: operation.quoteKey,
      totalAmountCents: operation.totalAmountCents,
      orderIds: [...operation.orderIds],
      walletReference: operation.walletReference,
      walletTransactionId: ledgerId,
      accountingAppliedAt: operation.accountingAppliedAt,
      createdAt: operation.createdAt,
    };
  },
});
