import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { requireUser } from "./lib/auth";
import { applyEscrowAccounting } from "./lib/escrowAccounting";
import { assertFinancialOrderAccess, requireEscrowReadAccess } from "./lib/financialAccess";
import { canActAsCompanySeller, ensureAdminActor, ensureReviewerActor, getSellerDisplayInfo } from "./lib/platform";

function createAdminEscrowCounts() {
  return {
    all: 0,
    held: 0,
    released: 0,
    refunded: 0,
    partially_refunded: 0,
    disputed: 0,
  };
}

// Create escrow hold when order is paid
export const createEscrowHold = internalMutation({
  args: {
    orderId: v.id("orders"),
    buyerId: v.id("users"),
    sellerId: v.id("users"),
    amount: v.number(), // Legacy - same as grossAmount
  },
  handler: async (ctx, args) => {
    // Verify order exists and is in correct state
    const order = await ctx.db.get(args.orderId);
    if (!order) {
      throw new Error("Order not found");
    }
    if (order.buyerId !== args.buyerId) {
      throw new Error("Buyer mismatch");
    }
    if (order.sellerId !== args.sellerId) {
      throw new Error("Seller mismatch");
    }

    // Check if escrow already exists for this order
    const existingEscrow = await ctx.db
      .query("escrow")
      .withIndex("by_order", (q) => q.eq("orderId", args.orderId))
      .first();

    if (existingEscrow) {
      throw new Error("Escrow already exists for this order");
    }

    // Calculate fund breakdown from order
    const grossAmount = order.totalAmount || args.amount;
    const platformFee = order.platformFee || 0;
    const sellerAmount = order.sellerPayout || order.subtotal + order.shippingCost;

    return await ctx.db.insert("escrow", {
      orderId: args.orderId,
      buyerId: args.buyerId,
      sellerId: args.sellerId,
      // Fund breakdown for proper accounting
      grossAmount,
      platformFee,
      sellerAmount,
      // Legacy field
      amount: grossAmount,
      status: "held",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});

// Get escrow by order ID
export const getEscrowByOrder = query({
  args: { orderId: v.id("orders") },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const order = await ctx.db.get(args.orderId);
    if (order) {
      await assertFinancialOrderAccess(ctx, actor, order);
    }
    const escrow = await ctx.db
      .query("escrow")
      .withIndex("by_order", (q) => q.eq("orderId", args.orderId))
      .first();
    if (escrow) {
      await requireEscrowReadAccess(ctx, actor, escrow);
    }

    return escrow;
  },
});

// Get escrow by ID
export const getEscrow = query({
  args: { escrowId: v.id("escrow") },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const escrow = await ctx.db.get(args.escrowId);
    if (!escrow) {
      return null;
    }

    const order = await requireEscrowReadAccess(ctx, actor, escrow);
    const buyer = await ctx.db.get(escrow.buyerId);
    const seller = await ctx.db.get(escrow.sellerId);

    return {
      ...escrow,
      order,
      buyer: buyer ? { _id: buyer._id, firstName: buyer.firstName, lastName: buyer.lastName } : null,
      seller: seller ? { _id: seller._id, firstName: seller.firstName, lastName: seller.lastName } : null,
    };
  },
});

// Release funds to seller's wallet (when buyer confirms receipt)
// Seller receives: sellerAmount (subtotal + shipping) credited to their wallet
// Platform retains: platformFee (5%)
export const releaseFunds = internalMutation({
  args: { escrowId: v.id("escrow") },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const escrow = await ctx.db.get(args.escrowId);
    if (!escrow) {
      throw new Error("Escrow not found");
    }
    if (actor._id !== escrow.buyerId) {
      throw new Error("Unauthorized");
    }
    const result = await applyEscrowAccounting(ctx, escrow, actor, "release");
    if (result.application === "applied" && result.newlyApplied) {
      await ctx.db.patch(escrow.orderId, { status: "completed", updatedAt: result.escrow.updatedAt });
    }
    return { ...result.escrow, accountingOutcome: result.application };
  },
});

// Full refund credits the original buyer's marketplace wallet, never a
// provider refund or the verified reviewer's wallet.
export const refundFull = internalMutation({
  args: { escrowId: v.id("escrow") },
  handler: async (ctx, args) => {
    const actor = await ensureReviewerActor(ctx);
    const escrow = await ctx.db.get(args.escrowId);
    if (!escrow) {
      throw new Error("Escrow not found");
    }
    const result = await applyEscrowAccounting(ctx, escrow, actor, "full_refund");
    return { ...result.escrow, accountingOutcome: result.application };
  },
});

// Partial refund preserves the approved frozen payout-minus-refund policy.
export const refundPartial = internalMutation({
  args: { escrowId: v.id("escrow"), refundAmount: v.number() },
  handler: async (ctx, args) => {
    const actor = await ensureReviewerActor(ctx);
    const escrow = await ctx.db.get(args.escrowId);
    if (!escrow) {
      throw new Error("Escrow not found");
    }
    const result = await applyEscrowAccounting(ctx, escrow, actor, "partial_refund", args.refundAmount);
    return { ...result.escrow, accountingOutcome: result.application };
  },
});

// Mark escrow as disputed
export const markAsDisputed = internalMutation({
  args: {
    escrowId: v.id("escrow"),
    buyerId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const escrow = await ctx.db.get(args.escrowId);
    if (!escrow) {
      throw new Error("Escrow not found");
    }
    if (escrow.buyerId !== args.buyerId) {
      throw new Error("Unauthorized");
    }
    if (escrow.status !== "held") {
      throw new Error("Escrow cannot be disputed in current state");
    }

    await ctx.db.patch(args.escrowId, {
      status: "disputed",
      updatedAt: Date.now(),
    });

    return await ctx.db.get(args.escrowId);
  },
});

// Get buyer's escrow holdings
export const getBuyerEscrows = query({
  args: {},
  handler: async (ctx) => {
    const actor = await requireUser(ctx);
    const escrows = await ctx.db
      .query("escrow")
      .withIndex("by_buyer", (q) => q.eq("buyerId", actor._id))
      .collect();

    return await Promise.all(
      escrows.map(async (escrow) => {
        const order = await requireEscrowReadAccess(ctx, actor, escrow);
        const seller = await ctx.db.get(escrow.sellerId);
        return {
          ...escrow,
          order,
          seller: seller ? { _id: seller._id, firstName: seller.firstName, lastName: seller.lastName } : null,
        };
      })
    );
  },
});

// Get seller's pending escrow (money awaiting release)
export const getSellerPendingEscrow = query({
  args: { sellerId: v.id("users") },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    if (!(await canActAsCompanySeller(ctx, actor, args.sellerId))) {
      throw new Error("Unauthorized");
    }

    const escrows = await ctx.db
      .query("escrow")
      .withIndex("by_seller", (q) => q.eq("sellerId", args.sellerId))
      .filter((q) => q.eq(q.field("status"), "held"))
      .collect();

    for (const escrow of escrows) {
      await requireEscrowReadAccess(ctx, actor, escrow);
    }

    // Sum seller's share (not gross amount)
    const totalPending = escrows.reduce((sum, escrow) => sum + (escrow.sellerAmount || escrow.amount), 0);

    return {
      escrows,
      totalPending, // Amount seller will receive when released
      count: escrows.length,
    };
  },
});

export const listEscrowsForAdmin = query({
  args: { adminId: v.id("users") },
  handler: async (ctx, _args) => {
    await ensureAdminActor(ctx);

    const allEscrows = await ctx.db.query("escrow").collect();
    const allDisputes = await ctx.db.query("disputes").collect();
    const counts = createAdminEscrowCounts();

    for (const escrow of allEscrows) {
      counts.all += 1;
      counts[escrow.status] += 1;
    }

    const disputeByOrderId = new Map(allDisputes.map((dispute) => [dispute.orderId, dispute]));

    const items = await Promise.all(
      [...allEscrows]
        .sort((left, right) => right.createdAt - left.createdAt)
        .map(async (escrow) => {
          const [buyer, seller, sellerDisplay, order] = await Promise.all([
            ctx.db.get(escrow.buyerId),
            ctx.db.get(escrow.sellerId),
            getSellerDisplayInfo(ctx, escrow.sellerId),
            ctx.db.get(escrow.orderId),
          ]);

          const dispute = disputeByOrderId.get(escrow.orderId);

          return {
            _id: escrow._id,
            orderId: escrow.orderId,
            orderNumber: order?.orderNumber ?? "Unknown order",
            orderStatus: order?.status,
            buyerId: escrow.buyerId,
            buyerName: buyer ? `${buyer.firstName} ${buyer.lastName}`.trim() : "Unknown buyer",
            buyerEmail: buyer?.email ?? "",
            sellerId: escrow.sellerId,
            sellerName: seller ? `${seller.firstName} ${seller.lastName}`.trim() : "Unknown seller",
            sellerEmail: seller?.email ?? "",
            sellerDisplayName: sellerDisplay.displayName,
            isCompanyStore: sellerDisplay.isCompanyStore,
            status: escrow.status,
            grossAmount: escrow.grossAmount || escrow.amount,
            sellerAmount: escrow.sellerAmount || escrow.amount,
            platformFee: escrow.platformFee || 0,
            refundAmount: escrow.refundAmount,
            shippingLocation: order ? `${order.shippingAddress.city}, ${order.shippingAddress.province}` : undefined,
            createdAt: escrow.createdAt,
            updatedAt: escrow.updatedAt,
            releasedAt: escrow.releasedAt,
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

// Get escrow statistics (admin)
export const getEscrowStats = query({
  args: { adminId: v.id("users") },
  handler: async (ctx, _args) => {
    await ensureAdminActor(ctx);

    const allEscrows = await ctx.db.query("escrow").collect();

    const stats = {
      // Gross amounts (what buyers paid)
      totalGrossReceived: 0,
      totalGrossHeld: 0,
      totalGrossReleased: 0,
      totalGrossRefunded: 0,

      // Seller amounts
      totalSellerPayouts: 0,
      totalSellerPending: 0,

      // Platform fees
      totalPlatformFees: 0,

      // Counts
      heldCount: 0,
      releasedCount: 0,
      refundedCount: 0,
      partialRefundCount: 0,
      disputedCount: 0,
    };

    for (const escrow of allEscrows) {
      const grossAmount = escrow.grossAmount || escrow.amount;
      const sellerAmount = escrow.sellerAmount || escrow.amount;
      const platformFee = escrow.platformFee || 0;

      stats.totalGrossReceived += grossAmount;
      stats.totalPlatformFees += platformFee;

      switch (escrow.status) {
        case "held":
          stats.totalGrossHeld += grossAmount;
          stats.totalSellerPending += sellerAmount;
          stats.heldCount++;
          break;
        case "released":
          stats.totalGrossReleased += grossAmount;
          stats.totalSellerPayouts += sellerAmount;
          stats.releasedCount++;
          break;
        case "refunded":
          stats.totalGrossRefunded += escrow.refundAmount ?? grossAmount;
          stats.refundedCount++;
          break;
        case "partially_refunded": {
          stats.totalGrossRefunded += escrow.refundAmount ?? 0;
          const sellerReceived = sellerAmount - (escrow.refundAmount ?? 0);
          stats.totalSellerPayouts += Math.max(0, sellerReceived);
          stats.partialRefundCount++;
          break;
        }
        case "disputed":
          stats.totalGrossHeld += grossAmount;
          stats.totalSellerPending += sellerAmount;
          stats.disputedCount++;
          break;
      }
    }

    return stats;
  },
});
