import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, internalMutation } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  buildSellerPublicProfile,
  canActAsCompanySeller,
  ensureAdminActor,
  ensureCatalogActor,
  getSellerDisplayInfo,
  getPlatformSettings,
  isReviewerRole,
} from "./lib/platform";
import { requireUser } from "./lib/auth";
import { metadataNamesCheckoutOrder } from "./lib/checkoutReservations";
import { validateCheckoutAccounting } from "./lib/checkoutSettlement";
import { applyEscrowAccounting } from "./lib/escrowAccounting";

// Generate unique order number
function generateOrderNumber(): string {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `ORD-${timestamp}-${random}`;
}

// Platform fee percentage (5% to cover transaction fees and ensure no shortfall)
const PLATFORM_FEE_PERCENTAGE = 0.05;
const selectedVariantValidator = v.object({
  variantId: v.string(),
  sku: v.string(),
  attributes: v.array(v.object({ name: v.string(), value: v.string() })),
  price: v.number(),
  image: v.optional(v.string()),
});

type SelectedVariant = {
  variantId: string;
  sku: string;
  attributes: Array<{ name: string; value: string }>;
  price: number;
  image?: string;
};
type VariantCombination = {
  id: string;
  sku: string;
  attributes: Array<{ name: string; value: string }>;
  price: number;
  stock: number;
  status: "active" | "inactive" | "out_of_stock";
  primaryImage?: string;
  galleryImages?: string[];
};

// Calculate platform fee from subtotal
function calculatePlatformFee(subtotal: number): number {
  return Math.ceil(subtotal * PLATFORM_FEE_PERCENTAGE * 100) / 100; // Round up to nearest cent
}

function getVariantCombinations(product: { variantCombinations?: unknown }) {
  return (product.variantCombinations ?? []) as VariantCombination[];
}

function resolveOrderVariant(
  product: { title: string; variantCombinations?: unknown },
  selectedVariant?: SelectedVariant
) {
  const combinations = getVariantCombinations(product);
  if (combinations.length === 0) {
    return undefined;
  }
  if (!selectedVariant) {
    throw new Error(`Select a variant for ${product.title}`);
  }

  // The variant id names the variant. The sku is a fallback, used only when no variant carries the id.
  const combination =
    combinations.find((candidate) => candidate.id === selectedVariant.variantId) ??
    combinations.find((candidate) => candidate.sku === selectedVariant.sku);
  if (!combination) {
    throw new Error(`Invalid variant for ${product.title}`);
  }
  if (combination.status !== "active" || combination.stock <= 0) {
    throw new Error(`Selected variant for ${product.title} is out of stock`);
  }

  return combination;
}

function decrementVariantStock(
  product: { variantCombinations?: unknown },
  selectedVariant: SelectedVariant,
  quantity: number
) {
  return getVariantCombinations(product).map((combination) => {
    if (combination.id !== selectedVariant.variantId) {
      return combination;
    }
    const stock = Math.max(0, combination.stock - quantity);
    return {
      ...combination,
      stock,
      status: stock === 0 ? ("out_of_stock" as const) : combination.status,
    };
  });
}

// Gives a cancelled order's quantity back to the variant it was taken from, and to no other. A variant that sold out
// because of this order is active again; one that is inactive, or out of stock with stock left, keeps that choice.
// Returns null when the variant is no longer on the product, so the caller can say so instead of crediting a guess.
function incrementVariantStock(
  product: { variantCombinations?: unknown },
  selectedVariant: SelectedVariant,
  quantity: number
) {
  const combinations = getVariantCombinations(product);
  if (!combinations.some((combination) => combination.id === selectedVariant.variantId)) {
    return null;
  }
  return combinations.map((combination) => {
    if (combination.id !== selectedVariant.variantId) {
      return combination;
    }
    return {
      ...combination,
      stock: combination.stock + quantity,
      status:
        combination.status === "out_of_stock" && combination.stock === 0 ? ("active" as const) : combination.status,
    };
  });
}

function createAdminOrderCounts() {
  return {
    all: 0,
    pending_payment: 0,
    paid: 0,
    processing: 0,
    shipped: 0,
    delivered: 0,
    completed: 0,
    cancelled: 0,
    disputed: 0,
  };
}

async function syncTransactionsForCancelledOrder(ctx: MutationCtx, orderId: Id<"orders">, now: number) {
  // The original captured provider companion (and any wallet purchase debit,
  // which lives in walletTransactions) is immutable funding history: the
  // wallet refund ledger plus the escrow lifecycle proof is the refund
  // authority, so cancellation never relabels the companion based on one
  // slice of an aggregate checkout.
  const order = await ctx.db.get(orderId);
  const operation = order?.operationId === undefined ? null : await ctx.db.get(order.operationId);
  const protectedTransactionId =
    operation !== null && operation.kind === "checkout_collection" ? operation.transactionId : undefined;

  const transactions = await ctx.db
    .query("transactions")
    .withIndex("by_order", (q) => q.eq("orderId", orderId))
    .collect();

  await Promise.all(
    transactions.map(async (transaction) => {
      if (transaction._id === protectedTransactionId) {
        return;
      }
      if (transaction.status === "successful") {
        await ctx.db.patch(transaction._id, {
          status: "refunded",
          completedAt: now,
          updatedAt: now,
        });
        return;
      }

      if (transaction.status === "pending" || transaction.status === "processing") {
        await ctx.db.patch(transaction._id, {
          status: "cancelled",
          completedAt: now,
          updatedAt: now,
        });
      }
    })
  );
}

// Everything a cancelled order undoes: stock goes back, a held or disputed escrow is refunded, the order's transactions
// are settled, and the order is marked cancelled. cancelOrder and the cancelled transition of updateOrderStatus both use
// it, so the two paths cannot drift apart. `orderPatch` is spread onto the order as given: cancelOrder passes its reason only when the
// buyer gave one, and updateOrderStatus passes nothing, so an existing note is left alone.
async function assertNoUnresolvedCheckout(ctx: MutationCtx, order: Doc<"orders">): Promise<void> {
  // A linked checkout collection owns this order's reservation. Cancelling
  // would return stock while the collection is still in flight, so both
  // cancel entry points reject before any order, product, variant, escrow,
  // transaction, or notice write. Legacy wallet and unlinked orders keep
  // their existing path unchanged: only checkout_collection links guard.
  // A positively proven captured checkout (reciprocal operation/order/escrow
  // lineage, no sticky source review, accepted validator truth) may cancel
  // through the shared refund writer below. Pending, unknown, failed,
  // conflicting, or review-held sources still cannot free stock or pretend
  // a refund.
  // Defensively verify the reciprocal owner/order linkage: a missing or
  // conflicting linked operation needs review and never authorizes
  // cancellation.
  const linkedId = order.operationId;
  if (linkedId === undefined) {
    return;
  }
  const linked = await ctx.db.get(linkedId);
  if (linked === null) {
    throw new Error("This order has a missing payment record to review before cancellation.");
  }
  if (linked.kind === "checkout_collection") {
    if (linked.ownerId !== order.buyerId || !linked.orderIds.includes(order._id) || linked.reviewNeeded === true) {
      throw new Error("This order has a conflicting payment record to review before cancellation.");
    }
    const captured =
      linked.accounting?.kind === "checkout_captured" &&
      linked.amountCents > 0 &&
      (await validateCheckoutAccounting(ctx, linked));
    if (!captured) {
      throw new Error("This order is covered by an unresolved checkout and cannot be cancelled yet.");
    }
    return;
  }
  if (linked.kind === "wallet_purchase") {
    if (linked.ownerId !== order.buyerId || !linked.orderIds.includes(order._id)) {
      throw new Error("This order has a conflicting payment record to review before cancellation.");
    }
    return;
  }
  throw new Error("This order has a conflicting payment record to review before cancellation.");
}

// Restores aggregate product quantities and the authoritative selected-variant
// quantities for every cancelled line, under the existing variant policy.
// Shared by the unfunded legacy path and the funded refund path; runs only
// after money is applied (or proven absent), never before a review decision.
async function restoreCancelledStock(ctx: MutationCtx, order: Doc<"orders">, now: number) {
  for (const item of order.items) {
    const product = await ctx.db.get(item.productId);
    if (product) {
      const patch: Partial<Doc<"products">> = {
        quantity: product.quantity + item.quantity,
        status: product.status === "sold" ? "active" : product.status,
        updatedAt: now,
      };

      if (item.selectedVariant) {
        const combinations = incrementVariantStock(product, item.selectedVariant, item.quantity);
        if (combinations) {
          patch.variantCombinations = combinations as Doc<"products">["variantCombinations"];
        } else {
          // The seller changed the variants after the sale. Say so instead of crediting a guess or hiding it.
          await ctx.db.insert("notifications", {
            userId: product.sellerId,
            type: "system",
            title: "Stock needs a manual check",
            message: `A cancelled order included ${item.quantity} x ${product.title} (SKU ${item.selectedVariant.sku}), but that variant no longer exists. Its variant stock could not be restored.`,
            data: { orderId: order._id, productId: product._id },
            isRead: false,
            createdAt: now,
          });
        }
      }

      await ctx.db.patch(item.productId, patch);
    }
  }
}

// A missing forward marker is not proof of no funds. Before the genuine
// unlinked unfunded fallback below, indexed participant-owned history is
// checked for ambiguity: buyer- or seller-owned ledger/transaction metadata
// naming this order (accepted fail-closed metadataNamesCheckoutOrder
// semantics), and buyer-owned wallet_purchase/checkout_collection operations
// with this order in their reverse orderIds. Metadata is an ambiguity
// signal only, never financial authority or proof of payment/refund; unknown
// or unrelated-owner rows are ignored, and no history is repaired. Any hit
// throws the existing missing-record review error before any business write.
async function assertNoAmbiguousParticipantHistory(ctx: MutationCtx, order: Doc<"orders">): Promise<void> {
  const target = new Set<string>([order._id]);
  const participants = order.buyerId === order.sellerId ? [order.buyerId] : [order.buyerId, order.sellerId];
  for (const participant of participants) {
    const ownedLedger = await ctx.db
      .query("walletTransactions")
      .withIndex("by_user", (q) => q.eq("userId", participant))
      .collect();
    for (const entry of ownedLedger) {
      if (metadataNamesCheckoutOrder(entry.metadata, target)) {
        throw new Error("This order has a missing payment record to review before cancellation.");
      }
    }
    const ownedTransactions = await ctx.db
      .query("transactions")
      .withIndex("by_user", (q) => q.eq("userId", participant))
      .collect();
    for (const entry of ownedTransactions) {
      if (metadataNamesCheckoutOrder(entry.metadata, target)) {
        throw new Error("This order has a missing payment record to review before cancellation.");
      }
    }
  }
  const ownedOperations = await ctx.db
    .query("paymentOperations")
    .withIndex("by_owner", (q) => q.eq("ownerId", order.buyerId))
    .collect();
  for (const operation of ownedOperations) {
    if (operation.kind !== "wallet_purchase" && operation.kind !== "checkout_collection") {
      continue;
    }
    if (operation.orderIds.includes(order._id)) {
      throw new Error("This order has a missing payment record to review before cancellation.");
    }
  }
}

// Everything a cancelled order undoes: stock goes back, a held or disputed escrow is refunded, the order's transactions
// are settled, and the order is marked cancelled. cancelOrder and the cancelled transition of updateOrderStatus both use
// it, so the two paths cannot drift apart. `orderPatch` is spread onto the order as given: cancelOrder passes its reason only when the
// buyer gave one, and updateOrderStatus passes nothing, so an existing note is left alone.
//
// Money moves before inventory and order effects, through the same
// same-MutationCtx accounting writer. A review outcome returns before any
// stock, notice, order, or transaction write. Only a genuine unlinked
// unfunded pending_payment order (no escrow, no linked operation, no
// financial rows) still stock-cancels without money movement.
async function cancelOrderEffects(
  ctx: MutationCtx,
  order: Doc<"orders">,
  actor: Doc<"users">,
  now: number,
  orderPatch: { notes?: string }
): Promise<{ accountingOutcome?: "applied" | "review" }> {
  await assertNoUnresolvedCheckout(ctx, order);

  const escrows = await ctx.db
    .query("escrow")
    .withIndex("by_order", (q) => q.eq("orderId", order._id))
    .collect();

  if (escrows.length === 0) {
    const linked = order.operationId === undefined ? null : await ctx.db.get(order.operationId);
    const linkedTransactions = await ctx.db
      .query("transactions")
      .withIndex("by_order", (q) => q.eq("orderId", order._id))
      .collect();
    const linkedLedger = await ctx.db
      .query("walletTransactions")
      .withIndex("by_order", (q) => q.eq("orderId", order._id))
      .collect();
    if (
      linked !== null ||
      linkedTransactions.length !== 0 ||
      linkedLedger.length !== 0 ||
      order.status !== "pending_payment"
    ) {
      // A paid or processing order without escrow, or any financial linkage
      // without a hold, is ambiguous history: review, never a no-funds
      // fallback or retroactive adoption.
      throw new Error("This order has a missing payment record to review before cancellation.");
    }
    // Forward markers are empty, so participant-owned ambiguity is the last
    // preflight before the genuine unfunded stock-cancel. Rejects before any
    // stock, notice, order, counter, transaction, or approval write.
    await assertNoAmbiguousParticipantHistory(ctx, order);
    await restoreCancelledStock(ctx, order, now);
    await syncTransactionsForCancelledOrder(ctx, order._id, now);
    await ctx.db.patch(order._id, {
      status: "cancelled",
      ...orderPatch,
      updatedAt: now,
    });
    return {};
  }

  if (escrows.length !== 1 || escrows[0] === undefined) {
    throw new Error("This order has a conflicting payment record to review before cancellation.");
  }
  const escrow = escrows[0];

  const result = await applyEscrowAccounting(ctx, escrow, actor, "full_refund");
  if (result.application === "review") {
    // The writer persisted only the immutable approval. Business state,
    // inventory, notices, and counters are unchanged.
    return { accountingOutcome: "review" };
  }

  await restoreCancelledStock(ctx, order, result.escrow.updatedAt);
  await syncTransactionsForCancelledOrder(ctx, order._id, result.escrow.updatedAt);

  await ctx.db.patch(order._id, {
    status: "cancelled",
    ...orderPatch,
    updatedAt: result.escrow.updatedAt,
  });
  return { accountingOutcome: "applied" };
}

// Legacy fixture/internal callers only; clients create orders through the authoritative checkout quote flow.
export const createOrder = internalMutation({
  args: {
    sellerId: v.id("users"),
    items: v.array(
      v.object({
        productId: v.id("products"),
        title: v.string(),
        price: v.number(),
        quantity: v.number(),
        image: v.string(),
        selectedVariantOptions: v.optional(
          v.array(
            v.object({
              name: v.string(),
              value: v.string(),
              sku: v.optional(v.string()),
              priceDelta: v.optional(v.number()),
            })
          )
        ),
        selectedVariant: v.optional(selectedVariantValidator),
        selectedAddOns: v.optional(
          v.array(
            v.object({
              name: v.string(),
              description: v.optional(v.string()),
              price: v.number(),
            })
          )
        ),
        customizationKey: v.optional(v.string()),
      })
    ),
    subtotal: v.number(),
    discountAmount: v.optional(v.number()),
    promoCodeId: v.optional(v.id("promoCodes")),
    promoCode: v.optional(v.string()),
    shippingCost: v.number(),
    deliveryMethodId: v.optional(v.id("deliveryMethods")),
    deliveryMethodName: v.optional(v.string()),
    deliveryEta: v.optional(
      v.object({
        minDays: v.number(),
        maxDays: v.number(),
      })
    ),
    pickupPointId: v.optional(v.id("pickupPoints")),
    shippingAddress: v.object({
      street: v.string(),
      city: v.string(),
      province: v.string(),
      country: v.string(),
      phone: v.string(),
    }),
  },
  handler: async (ctx, args) => {
    const buyer = await requireUser(ctx);

    // Validate products and stock. A line's variant is the one the product holds, so the stock it reserves, the variant
    // it stores, and any later cancel all name the same variant. Lines that share a product, or a variant, draw on one
    // pool, so the running totals are checked, not each line on its own.
    const reservedByProduct = new Map<string, number>();
    const reservedByVariant = new Map<string, number>();
    const orderItems: Doc<"orders">["items"] = [];
    for (const item of args.items) {
      const product = await ctx.db.get(item.productId);
      if (!product) {
        throw new Error(`Product ${item.productId} not found`);
      }
      if (product.status !== "active") {
        throw new Error(`Product ${product.title} is no longer available`);
      }
      const combination = resolveOrderVariant(product, item.selectedVariant);

      const productReserved = (reservedByProduct.get(item.productId) ?? 0) + item.quantity;
      reservedByProduct.set(item.productId, productReserved);
      if (productReserved > product.quantity) {
        throw new Error(`Insufficient stock for ${product.title}`);
      }
      if (combination) {
        const variantKey = `${item.productId}:${combination.id}`;
        const variantReserved = (reservedByVariant.get(variantKey) ?? 0) + item.quantity;
        reservedByVariant.set(variantKey, variantReserved);
        if (variantReserved > combination.stock) {
          throw new Error(`Insufficient stock for ${product.title}`);
        }
      }

      // Store the variant the product holds, not the one the request named. A product without variants stores none.
      const { selectedVariant: requested, ...line } = item;
      orderItems.push(
        combination && requested
          ? { ...line, selectedVariant: { ...requested, variantId: combination.id, sku: combination.sku } }
          : line
      );
    }

    // Calculate financial breakdown
    // Platform fee: 5% of subtotal to cover bank/gateway fees
    const discountAmount = Math.min(args.discountAmount ?? 0, args.subtotal);
    const discountedSubtotal = args.subtotal - discountAmount;
    const platformFee = calculatePlatformFee(discountedSubtotal);

    // Seller payout: subtotal + shipping (what seller receives)
    const sellerPayout = discountedSubtotal + args.shippingCost;

    // Total amount: what buyer pays (subtotal + shipping + platform fee)
    const totalAmount = discountedSubtotal + args.shippingCost + platformFee;

    // Create order with full financial breakdown
    const orderId = await ctx.db.insert("orders", {
      orderNumber: generateOrderNumber(),
      buyerId: buyer._id,
      sellerId: args.sellerId,
      items: orderItems,
      subtotal: args.subtotal,
      discountAmount,
      promoCodeId: args.promoCodeId,
      promoCode: args.promoCode,
      shippingCost: args.shippingCost,
      platformFee,
      totalAmount,
      sellerPayout,
      deliveryMethodId: args.deliveryMethodId,
      deliveryMethodName: args.deliveryMethodName,
      deliveryEta: args.deliveryEta,
      pickupPointId: args.pickupPointId,
      shippingAddress: args.shippingAddress,
      status: "pending_payment",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Decrease product quantities
    for (const item of orderItems) {
      const product = await ctx.db.get(item.productId);
      if (product) {
        const newQuantity = product.quantity - item.quantity;
        const patch: Partial<Doc<"products">> = {
          quantity: newQuantity,
          status: newQuantity === 0 ? "sold" : product.status,
          updatedAt: Date.now(),
        };

        if (item.selectedVariant) {
          patch.variantCombinations = decrementVariantStock(
            product,
            item.selectedVariant,
            item.quantity
          ) as Doc<"products">["variantCombinations"];
        }

        await ctx.db.patch(item.productId, patch);

        await ctx.db.insert("behaviorEvents", {
          userId: buyer._id,
          eventType: "purchase",
          productId: item.productId,
          categoryId: product.categoryId,
          variantId: item.selectedVariant?.variantId,
          quantity: item.quantity,
          metadata: { orderId },
          createdAt: Date.now(),
        });
      }
    }

    return orderId;
  },
});

// Participants (buyer, seller, company-seller staff) and the admin/moderator review role may read an order.
async function canReadOrder(ctx: QueryCtx, viewer: Doc<"users">, order: Doc<"orders">) {
  return (
    order.buyerId === viewer._id ||
    order.sellerId === viewer._id ||
    isReviewerRole(viewer.role) ||
    (await canActAsCompanySeller(ctx, viewer, order.sellerId))
  );
}

// Get order by ID
export const getOrder = query({
  args: { orderId: v.id("orders") },
  handler: async (ctx, args) => {
    const viewer = await requireUser(ctx);
    const order = await ctx.db.get(args.orderId);
    if (!order) {
      return null;
    }
    if (!(await canReadOrder(ctx, viewer, order))) {
      throw new Error("Unauthorized");
    }

    const buyer = await ctx.db.get(order.buyerId);
    const seller = await buildSellerPublicProfile(ctx, order.sellerId);

    return {
      ...order,
      buyer: buyer ? { _id: buyer._id, firstName: buyer.firstName, lastName: buyer.lastName } : null,
      seller,
    };
  },
});

// Get order by order number
export const getOrderByNumber = query({
  args: { orderNumber: v.string() },
  handler: async (ctx, args) => {
    const viewer = await requireUser(ctx);
    const order = await ctx.db
      .query("orders")
      .withIndex("by_order_number", (q) => q.eq("orderNumber", args.orderNumber))
      .first();
    if (!order) {
      return null;
    }
    if (!(await canReadOrder(ctx, viewer, order))) {
      throw new Error("Unauthorized");
    }

    return order;
  },
});

// Get buyer's orders
export const getBuyerOrders = query({
  args: {
    status: v.optional(
      v.union(
        v.literal("pending_payment"),
        v.literal("paid"),
        v.literal("processing"),
        v.literal("shipped"),
        v.literal("delivered"),
        v.literal("completed"),
        v.literal("cancelled"),
        v.literal("disputed")
      )
    ),
  },
  handler: async (ctx, args) => {
    const buyer = await requireUser(ctx);
    let ordersQuery = ctx.db.query("orders").withIndex("by_buyer", (q) => q.eq("buyerId", buyer._id));

    if (args.status) {
      ordersQuery = ordersQuery.filter((q) => q.eq(q.field("status"), args.status));
    }

    const orders = await ordersQuery.order("desc").collect();

    // Add seller info
    return await Promise.all(
      orders.map(async (order) => {
        const seller = await buildSellerPublicProfile(ctx, order.sellerId);
        return {
          ...order,
          seller,
        };
      })
    );
  },
});

// Get seller's orders
export const getSellerOrders = query({
  args: {
    sellerId: v.id("users"),
    status: v.optional(
      v.union(
        v.literal("pending_payment"),
        v.literal("paid"),
        v.literal("processing"),
        v.literal("shipped"),
        v.literal("delivered"),
        v.literal("completed"),
        v.literal("cancelled"),
        v.literal("disputed")
      )
    ),
  },
  handler: async (ctx, args) => {
    const seller = await requireUser(ctx);
    if (!(await canActAsCompanySeller(ctx, seller, args.sellerId))) {
      throw new Error("Unauthorized");
    }

    let ordersQuery = ctx.db.query("orders").withIndex("by_seller", (q) => q.eq("sellerId", args.sellerId));

    if (args.status) {
      ordersQuery = ordersQuery.filter((q) => q.eq(q.field("status"), args.status));
    }

    const orders = await ordersQuery.order("desc").collect();

    // Add buyer info
    return await Promise.all(
      orders.map(async (order) => {
        const buyer = await ctx.db.get(order.buyerId);
        return {
          ...order,
          buyer: buyer ? { _id: buyer._id, firstName: buyer.firstName, lastName: buyer.lastName } : null,
        };
      })
    );
  },
});

export const getManagedCatalogOrders = query({
  args: {
    status: v.optional(
      v.union(
        v.literal("pending_payment"),
        v.literal("paid"),
        v.literal("processing"),
        v.literal("shipped"),
        v.literal("delivered"),
        v.literal("completed"),
        v.literal("cancelled"),
        v.literal("disputed")
      )
    ),
  },
  handler: async (ctx, args) => {
    await ensureCatalogActor(ctx);
    const settings = await getPlatformSettings(ctx);
    if (!settings) {
      return [];
    }

    let ordersQuery = ctx.db
      .query("orders")
      .withIndex("by_seller", (q) => q.eq("sellerId", settings.companySellerUserId));

    if (args.status) {
      ordersQuery = ordersQuery.filter((q) => q.eq(q.field("status"), args.status));
    }

    const orders = await ordersQuery.order("desc").collect();

    return await Promise.all(
      orders.map(async (order) => {
        const buyer = await ctx.db.get(order.buyerId);
        return {
          ...order,
          buyer: buyer ? { _id: buyer._id, firstName: buyer.firstName, lastName: buyer.lastName } : null,
        };
      })
    );
  },
});

export const listOrdersForAdmin = query({
  args: {
    adminId: v.id("users"),
    status: v.optional(
      v.union(
        v.literal("pending_payment"),
        v.literal("paid"),
        v.literal("processing"),
        v.literal("shipped"),
        v.literal("delivered"),
        v.literal("completed"),
        v.literal("cancelled"),
        v.literal("disputed")
      )
    ),
  },
  handler: async (ctx, args) => {
    await ensureAdminActor(ctx);

    const allOrders = await ctx.db.query("orders").collect();
    const allEscrows = await ctx.db.query("escrow").collect();
    const allDisputes = await ctx.db.query("disputes").collect();
    const counts = createAdminOrderCounts();

    for (const order of allOrders) {
      counts.all += 1;
      counts[order.status] += 1;
    }

    const escrowByOrderId = new Map(allEscrows.map((escrow) => [escrow.orderId, escrow]));
    const disputeByOrderId = new Map(allDisputes.map((dispute) => [dispute.orderId, dispute]));

    const filteredOrders = allOrders
      .filter((order) => !args.status || order.status === args.status)
      .sort((left, right) => right.createdAt - left.createdAt);

    const items = await Promise.all(
      filteredOrders.map(async (order) => {
        const [buyer, seller, sellerDisplay] = await Promise.all([
          ctx.db.get(order.buyerId),
          ctx.db.get(order.sellerId),
          getSellerDisplayInfo(ctx, order.sellerId),
        ]);

        const escrow = escrowByOrderId.get(order._id);
        const dispute = disputeByOrderId.get(order._id);
        const itemCount = order.items.reduce((total, item) => total + item.quantity, 0);

        return {
          _id: order._id,
          orderNumber: order.orderNumber,
          buyerId: order.buyerId,
          sellerId: order.sellerId,
          status: order.status,
          totalAmount: order.totalAmount,
          subtotal: order.subtotal,
          shippingCost: order.shippingCost,
          platformFee: order.platformFee,
          createdAt: order.createdAt,
          updatedAt: order.updatedAt,
          buyerName: buyer ? `${buyer.firstName} ${buyer.lastName}`.trim() : "Unknown buyer",
          buyerEmail: buyer?.email ?? "",
          sellerName: seller ? `${seller.firstName} ${seller.lastName}`.trim() : "Unknown seller",
          sellerEmail: seller?.email ?? "",
          sellerDisplayName: sellerDisplay.displayName,
          isCompanyStore: sellerDisplay.isCompanyStore,
          shippingLocation: `${order.shippingAddress.city}, ${order.shippingAddress.province}`,
          itemCount,
          itemPreview: order.items[0]?.title ?? `${itemCount} item${itemCount === 1 ? "" : "s"}`,
          escrowId: escrow?._id,
          escrowStatus: escrow?.status,
          disputeId: dispute?._id,
          disputeStatus: dispute?.status,
        };
      })
    );

    return {
      items,
      counts,
    };
  },
});

// Update order status
export const updateOrderStatus = mutation({
  args: {
    orderId: v.id("orders"),
    status: v.union(
      v.literal("paid"),
      v.literal("processing"),
      v.literal("shipped"),
      v.literal("delivered"),
      v.literal("completed"),
      v.literal("cancelled"),
      v.literal("disputed")
    ),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const order = await ctx.db.get(args.orderId);
    if (!order) {
      throw new Error("Order not found");
    }

    // Validate who can update to what status
    const isBuyer = order.buyerId === actor._id;
    const isSeller = order.sellerId === actor._id || (await canActAsCompanySeller(ctx, actor, order.sellerId));
    const isModerator = actor.role === "moderator" || actor.role === "admin";

    // Status transition rules
    const allowedTransitions: Record<string, { buyer?: string[]; seller?: string[]; moderator?: string[] }> = {
      pending_payment: { buyer: ["cancelled"], seller: [], moderator: ["cancelled"] },
      paid: { buyer: [], seller: ["processing"], moderator: ["cancelled"] },
      processing: { buyer: [], seller: ["shipped"], moderator: ["cancelled"] },
      shipped: { buyer: ["delivered"], seller: [], moderator: [] },
      delivered: { buyer: ["completed"], seller: [], moderator: [] },
      completed: { buyer: [], seller: [], moderator: [] },
      cancelled: { buyer: [], seller: [], moderator: [] },
      // A disputed order is entered only by createDispute and left only by resolveDispute, never by a status change.
      disputed: { buyer: [], seller: [], moderator: [] },
    };

    const currentAllowed = allowedTransitions[order.status];
    let canUpdate = false;

    if (currentAllowed) {
      if (isBuyer && currentAllowed.buyer?.includes(args.status)) {
        canUpdate = true;
      }
      if (isSeller && currentAllowed.seller?.includes(args.status)) {
        canUpdate = true;
      }
      if (isModerator && currentAllowed.moderator?.includes(args.status)) {
        canUpdate = true;
      }
    }

    if (!canUpdate) {
      throw new Error(`Cannot transition from ${order.status} to ${args.status}`);
    }

    // A cancel refunds through the shared accounting writer before it undoes
    // the order's stock, escrow, and transactions, exactly as cancelOrder
    // does. A held review decision returns truthfully without cancelling.
    if (args.status === "cancelled") {
      const effects = await cancelOrderEffects(ctx, order, actor, Date.now(), {});
      const fresh = await ctx.db.get(args.orderId);
      if (effects.accountingOutcome === undefined) {
        return fresh;
      }
      return { ...fresh, accountingOutcome: effects.accountingOutcome };
    }

    // A completion releases the held escrow to the seller through the same
    // accounting writer, which also counts the sale exactly once. A held
    // review decision returns truthfully without completing the order.
    if (args.status === "completed") {
      const escrows = await ctx.db
        .query("escrow")
        .withIndex("by_order", (q) => q.eq("orderId", order._id))
        .collect();
      if (escrows.length !== 1 || escrows[0] === undefined) {
        throw new Error("Escrow funding needs review");
      }
      const result = await applyEscrowAccounting(ctx, escrows[0], actor, "release");
      if (result.application === "review") {
        return { ...order, accountingOutcome: "review" as const };
      }
      await ctx.db.patch(args.orderId, {
        status: "completed",
        updatedAt: result.escrow.updatedAt,
      });
      const fresh = await ctx.db.get(args.orderId);
      return { ...fresh, accountingOutcome: "applied" as const };
    }

    await ctx.db.patch(args.orderId, {
      status: args.status,
      updatedAt: Date.now(),
    });

    return await ctx.db.get(args.orderId);
  },
});

// Add tracking information (seller only)
export const addTrackingInfo = mutation({
  args: {
    orderId: v.id("orders"),
    trackingNumber: v.string(),
    shippingCarrier: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const order = await ctx.db.get(args.orderId);
    if (!order) {
      throw new Error("Order not found");
    }
    if (!(await canActAsCompanySeller(ctx, actor, order.sellerId))) {
      throw new Error("Unauthorized");
    }

    await ctx.db.patch(args.orderId, {
      trackingNumber: args.trackingNumber,
      shippingCarrier: args.shippingCarrier,
      updatedAt: Date.now(),
    });

    return await ctx.db.get(args.orderId);
  },
});

// Mark order as shipped (seller)
export const markAsShipped = mutation({
  args: {
    orderId: v.id("orders"),
    trackingNumber: v.optional(v.string()),
    shippingCarrier: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const order = await ctx.db.get(args.orderId);
    if (!order) {
      throw new Error("Order not found");
    }
    if (!(await canActAsCompanySeller(ctx, actor, order.sellerId))) {
      throw new Error("Unauthorized");
    }
    if (order.status !== "processing" && order.status !== "paid") {
      throw new Error("Order must be in processing or paid status to mark as shipped");
    }

    await ctx.db.patch(args.orderId, {
      status: "shipped",
      trackingNumber: args.trackingNumber,
      shippingCarrier: args.shippingCarrier,
      updatedAt: Date.now(),
    });

    return await ctx.db.get(args.orderId);
  },
});

// Confirm delivery (buyer)
export const confirmDelivery = mutation({
  args: {
    orderId: v.id("orders"),
  },
  handler: async (ctx, args) => {
    const order = await ctx.db.get(args.orderId);
    if (!order) {
      throw new Error("Order not found");
    }
    const buyer = await requireUser(ctx);
    if (order.buyerId !== buyer._id) {
      throw new Error("Unauthorized");
    }
    if (order.status !== "shipped") {
      throw new Error("Order must be shipped to confirm delivery");
    }

    await ctx.db.patch(args.orderId, {
      status: "delivered",
      updatedAt: Date.now(),
    });

    return await ctx.db.get(args.orderId);
  },
});

// Complete order and release funds (buyer)
export const completeOrder = mutation({
  args: {
    orderId: v.id("orders"),
  },
  handler: async (ctx, args) => {
    const order = await ctx.db.get(args.orderId);
    if (!order) {
      throw new Error("Order not found");
    }
    const actor = await requireUser(ctx);
    if (order.buyerId !== actor._id) {
      throw new Error("Unauthorized");
    }
    if (order.status !== "delivered") {
      throw new Error("Order must be delivered to complete");
    }

    // Release the held escrow to the seller through the shared accounting
    // writer, which credits the seller wallet, writes the reciprocal ledger
    // and proof, and counts the sale exactly once. Handle the writer outcome
    // before any order or counter write: a held review decision returns
    // truthfully without completing the order.
    const escrows = await ctx.db
      .query("escrow")
      .withIndex("by_order", (q) => q.eq("orderId", order._id))
      .collect();
    if (escrows.length !== 1 || escrows[0] === undefined) {
      throw new Error("Escrow funding needs review");
    }
    const result = await applyEscrowAccounting(ctx, escrows[0], actor, "release");
    if (result.application === "review") {
      return { ...order, accountingOutcome: "review" as const };
    }

    await ctx.db.patch(args.orderId, {
      status: "completed",
      updatedAt: result.escrow.updatedAt,
    });

    return { ...(await ctx.db.get(args.orderId)), accountingOutcome: "applied" as const };
  },
});

// Cancel order
export const cancelOrder = mutation({
  args: {
    orderId: v.id("orders"),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const order = await ctx.db.get(args.orderId);
    if (!order) {
      throw new Error("Order not found");
    }

    const user = await requireUser(ctx);

    const isBuyer = order.buyerId === user._id;
    const isAdmin = user.role === "admin";

    if (!isBuyer && !isAdmin) {
      throw new Error("Unauthorized");
    }

    // Only allow cancellation before shipping
    if (!["pending_payment", "paid", "processing"].includes(order.status)) {
      throw new Error("Order cannot be cancelled at this stage");
    }

    const effects = await cancelOrderEffects(
      ctx,
      order,
      user,
      Date.now(),
      args.reason === undefined ? {} : { notes: args.reason }
    );
    const fresh = await ctx.db.get(args.orderId);
    if (effects.accountingOutcome === undefined) {
      return fresh;
    }
    return { ...fresh, accountingOutcome: effects.accountingOutcome };
  },
});

// Get order statistics (for admin dashboard)
export const getOrderStats = query({
  args: { adminId: v.id("users") },
  handler: async (ctx) => {
    await ensureAdminActor(ctx);

    const allOrders = await ctx.db.query("orders").collect();

    const stats = {
      total: allOrders.length,
      pendingPayment: 0,
      paid: 0,
      processing: 0,
      shipped: 0,
      delivered: 0,
      completed: 0,
      cancelled: 0,
      disputed: 0,
      totalRevenue: 0,
    };

    for (const order of allOrders) {
      switch (order.status) {
        case "pending_payment":
          stats.pendingPayment++;
          break;
        case "paid":
          stats.paid++;
          break;
        case "processing":
          stats.processing++;
          break;
        case "shipped":
          stats.shipped++;
          break;
        case "delivered":
          stats.delivered++;
          break;
        case "completed":
          stats.completed++;
          stats.totalRevenue += order.totalAmount;
          break;
        case "cancelled":
          stats.cancelled++;
          break;
        case "disputed":
          stats.disputed++;
          break;
      }
    }

    return stats;
  },
});

// Mark order as paid using wallet
export const markPaidByWallet = internalMutation({
  args: {
    orderId: v.id("orders"),
    walletReference: v.string(),
  },
  handler: async (ctx, args) => {
    const order = await ctx.db.get(args.orderId);
    if (!order) {
      throw new Error("Order not found");
    }
    if (order.status !== "pending_payment") {
      throw new Error("Order is not pending payment");
    }

    const now = Date.now();

    // Update order status to paid
    await ctx.db.patch(args.orderId, {
      status: "paid",
      updatedAt: now,
    });

    // Create escrow record
    await ctx.db.insert("escrow", {
      orderId: args.orderId,
      buyerId: order.buyerId,
      sellerId: order.sellerId,
      grossAmount: order.totalAmount,
      platformFee: order.platformFee,
      sellerAmount: order.sellerPayout,
      amount: order.totalAmount, // Legacy field
      status: "held",
      createdAt: now,
      updatedAt: now,
    });

    // Notify seller
    await ctx.db.insert("notifications", {
      userId: order.sellerId,
      type: "payment_received",
      title: "Payment Received (Wallet)",
      message: `Payment received for order #${order.orderNumber} via wallet. Please process the order.`,
      data: { orderId: args.orderId },
      isRead: false,
      createdAt: now,
    });

    // Notify buyer
    await ctx.db.insert("notifications", {
      userId: order.buyerId,
      type: "order_status_update",
      title: "Payment Successful",
      message: `Your wallet payment for order #${order.orderNumber} was successful.`,
      data: { orderId: args.orderId, walletReference: args.walletReference },
      isRead: false,
      createdAt: now,
    });

    return await ctx.db.get(args.orderId);
  },
});
