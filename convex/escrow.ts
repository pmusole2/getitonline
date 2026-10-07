import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { ensureAdminActor, getSellerDisplayInfo } from "./lib/platform";

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
export const createEscrowHold = mutation({
  args: {
    orderId: v.id("orders"),
    buyerId: v.id("users"),
    sellerId: v.id("users"),
    amount: v.number(), // Legacy - same as grossAmount
  },
  handler: async (ctx, args) => {
    // Verify order exists and is in correct state
    const order = await ctx.db.get(args.orderId);
    if (!order) throw new Error("Order not found");
    if (order.buyerId !== args.buyerId) throw new Error("Buyer mismatch");
    if (order.sellerId !== args.sellerId) throw new Error("Seller mismatch");

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
    const sellerAmount = order.sellerPayout || (order.subtotal + order.shippingCost);

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
    return await ctx.db
      .query("escrow")
      .withIndex("by_order", (q) => q.eq("orderId", args.orderId))
      .first();
  },
});

// Get escrow by ID
export const getEscrow = query({
  args: { escrowId: v.id("escrow") },
  handler: async (ctx, args) => {
    const escrow = await ctx.db.get(args.escrowId);
    if (!escrow) return null;

    const order = await ctx.db.get(escrow.orderId);
    const buyer = await ctx.db.get(escrow.buyerId);
    const seller = await ctx.db.get(escrow.sellerId);

    return {
      ...escrow,
      order,
      buyer: buyer
        ? { _id: buyer._id, firstName: buyer.firstName, lastName: buyer.lastName }
        : null,
      seller: seller
        ? { _id: seller._id, firstName: seller.firstName, lastName: seller.lastName }
        : null,
    };
  },
});

// Release funds to seller's wallet (when buyer confirms receipt)
// Seller receives: sellerAmount (subtotal + shipping) credited to their wallet
// Platform retains: platformFee (5%)
export const releaseFunds = mutation({
  args: {
    escrowId: v.id("escrow"),
    buyerId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const escrow = await ctx.db.get(args.escrowId);
    if (!escrow) throw new Error("Escrow not found");
    if (escrow.buyerId !== args.buyerId) throw new Error("Unauthorized");
    if (escrow.status !== "held") {
      throw new Error("Escrow is not in held status");
    }

    const now = Date.now();
    const payoutAmount = escrow.sellerAmount || escrow.amount;

    // Get order for reference
    const order = await ctx.db.get(escrow.orderId);

    // Release funds - update escrow status
    await ctx.db.patch(args.escrowId, {
      status: "released",
      releasedAt: now,
      updatedAt: now,
    });

    // Update order status to completed
    await ctx.db.patch(escrow.orderId, {
      status: "completed",
      updatedAt: now,
    });

    // Credit seller's wallet
    // Get or create seller's wallet
    let sellerWallet = await ctx.db
      .query("wallets")
      .withIndex("by_user", (q) => q.eq("userId", escrow.sellerId))
      .first();

    if (!sellerWallet) {
      // Create wallet if doesn't exist
      const walletId = await ctx.db.insert("wallets", {
        userId: escrow.sellerId,
        balance: 0,
        pendingBalance: 0,
        totalEarned: 0,
        totalWithdrawn: 0,
        totalSpent: 0,
        isActive: true,
        isFrozen: false,
        createdAt: now,
        updatedAt: now,
      });
      sellerWallet = await ctx.db.get(walletId);
    }

    if (sellerWallet) {
      const newBalance = sellerWallet.balance + payoutAmount;

      // Update wallet balance
      await ctx.db.patch(sellerWallet._id, {
        balance: newBalance,
        pendingBalance: Math.max(0, sellerWallet.pendingBalance - payoutAmount),
        totalEarned: sellerWallet.totalEarned + payoutAmount,
        lastTransactionAt: now,
        updatedAt: now,
      });

      // Generate wallet transaction reference
      const timestamp = now.toString(36).toUpperCase();
      const random = Math.random().toString(36).substring(2, 6).toUpperCase();
      const walletReference = `WLT-${timestamp}-${random}`;

      // Create wallet transaction record
      await ctx.db.insert("walletTransactions", {
        walletId: sellerWallet._id,
        userId: escrow.sellerId,
        type: "credit",
        source: "escrow_release",
        amount: payoutAmount,
        balanceAfter: newBalance,
        orderId: escrow.orderId,
        escrowId: args.escrowId,
        reference: walletReference,
        status: "completed",
        description: `Sale completed: Order #${order?.orderNumber || 'Unknown'}`,
        createdAt: now,
        completedAt: now,
        updatedAt: now,
      });
    }

    // Increment seller's sales count
    const seller = await ctx.db.get(escrow.sellerId);
    if (seller) {
      await ctx.db.patch(seller._id, {
        totalSales: seller.totalSales + 1,
        updatedAt: now,
      });
    }

    // Increment buyer's purchases count
    const buyer = await ctx.db.get(escrow.buyerId);
    if (buyer) {
      await ctx.db.patch(buyer._id, {
        totalPurchases: buyer.totalPurchases + 1,
        updatedAt: now,
      });
    }

    // Create notification for seller about funds added to wallet
    await ctx.db.insert("notifications", {
      userId: escrow.sellerId,
      type: "wallet_credit",
      title: "Funds Added to Wallet",
      message: `K${payoutAmount.toLocaleString()} from order #${order?.orderNumber || ''} has been added to your wallet.`,
      data: { orderId: escrow.orderId, escrowId: args.escrowId },
      isRead: false,
      createdAt: now,
    });

    return await ctx.db.get(args.escrowId);
  },
});

// Full refund to buyer
// Buyer gets back: grossAmount (everything they paid)
export const refundFull = mutation({
  args: {
    escrowId: v.id("escrow"),
    moderatorId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const moderator = await ctx.db.get(args.moderatorId);
    if (!moderator || (moderator.role !== "moderator" && moderator.role !== "admin")) {
      throw new Error("Unauthorized: Only moderators can issue refunds");
    }

    const escrow = await ctx.db.get(args.escrowId);
    if (!escrow) throw new Error("Escrow not found");
    if (escrow.status !== "held" && escrow.status !== "disputed") {
      throw new Error("Escrow cannot be refunded in current state");
    }

    const now = Date.now();
    // Full refund = buyer gets back everything (grossAmount)
    const refundAmount = escrow.grossAmount || escrow.amount;

    await ctx.db.patch(args.escrowId, {
      status: "refunded",
      refundAmount,
      updatedAt: now,
    });

    // Notify buyer of refund
    await ctx.db.insert("notifications", {
      userId: escrow.buyerId,
      type: "funds_released",
      title: "Refund Processed",
      message: `A full refund of K${refundAmount.toLocaleString()} has been processed.`,
      data: { orderId: escrow.orderId, escrowId: args.escrowId },
      isRead: false,
      createdAt: now,
    });

    return await ctx.db.get(args.escrowId);
  },
});

// Partial refund
// Buyer gets: refundAmount
// Seller gets: sellerAmount - refundAmount (or remaining after refund)
export const refundPartial = mutation({
  args: {
    escrowId: v.id("escrow"),
    moderatorId: v.id("users"),
    refundAmount: v.number(),
  },
  handler: async (ctx, args) => {
    const moderator = await ctx.db.get(args.moderatorId);
    if (!moderator || (moderator.role !== "moderator" && moderator.role !== "admin")) {
      throw new Error("Unauthorized: Only moderators can issue refunds");
    }

    const escrow = await ctx.db.get(args.escrowId);
    if (!escrow) throw new Error("Escrow not found");
    if (escrow.status !== "held" && escrow.status !== "disputed") {
      throw new Error("Escrow cannot be refunded in current state");
    }

    const maxRefundable = escrow.grossAmount || escrow.amount;
    if (args.refundAmount <= 0 || args.refundAmount > maxRefundable) {
      throw new Error("Invalid refund amount");
    }

    const now = Date.now();

    await ctx.db.patch(args.escrowId, {
      status: "partially_refunded",
      refundAmount: args.refundAmount,
      releasedAt: now, // Remaining amount released to seller
      updatedAt: now,
    });

    // Notify buyer
    await ctx.db.insert("notifications", {
      userId: escrow.buyerId,
      type: "funds_released",
      title: "Partial Refund Processed",
      message: `A partial refund of K${args.refundAmount.toLocaleString()} has been processed.`,
      data: { orderId: escrow.orderId, escrowId: args.escrowId },
      isRead: false,
      createdAt: now,
    });

    // Notify seller about their portion
    const sellerReceives = (escrow.sellerAmount || escrow.amount) - args.refundAmount;
    if (sellerReceives > 0) {
      await ctx.db.insert("notifications", {
        userId: escrow.sellerId,
        type: "funds_released",
        title: "Funds Released",
        message: `K${sellerReceives.toLocaleString()} has been released to your account after partial refund.`,
        data: { orderId: escrow.orderId, escrowId: args.escrowId },
        isRead: false,
        createdAt: now,
      });
    }

    return await ctx.db.get(args.escrowId);
  },
});

// Mark escrow as disputed
export const markAsDisputed = mutation({
  args: {
    escrowId: v.id("escrow"),
    buyerId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const escrow = await ctx.db.get(args.escrowId);
    if (!escrow) throw new Error("Escrow not found");
    if (escrow.buyerId !== args.buyerId) throw new Error("Unauthorized");
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
  args: { buyerId: v.id("users") },
  handler: async (ctx, args) => {
    const escrows = await ctx.db
      .query("escrow")
      .withIndex("by_buyer", (q) => q.eq("buyerId", args.buyerId))
      .collect();

    return await Promise.all(
      escrows.map(async (escrow) => {
        const order = await ctx.db.get(escrow.orderId);
        const seller = await ctx.db.get(escrow.sellerId);
        return {
          ...escrow,
          order,
          seller: seller
            ? { _id: seller._id, firstName: seller.firstName, lastName: seller.lastName }
            : null,
        };
      })
    );
  },
});

// Get seller's pending escrow (money awaiting release)
export const getSellerPendingEscrow = query({
  args: { sellerId: v.id("users") },
  handler: async (ctx, args) => {
    const escrows = await ctx.db
      .query("escrow")
      .withIndex("by_seller", (q) => q.eq("sellerId", args.sellerId))
      .filter((q) => q.eq(q.field("status"), "held"))
      .collect();

    // Sum seller's share (not gross amount)
    const totalPending = escrows.reduce(
      (sum, escrow) => sum + (escrow.sellerAmount || escrow.amount),
      0
    );

    return {
      escrows,
      totalPending, // Amount seller will receive when released
      count: escrows.length,
    };
  },
});

export const listEscrowsForAdmin = query({
  args: { adminId: v.id("users") },
  handler: async (ctx, args) => {
    await ensureAdminActor(ctx, args.adminId);

    const allEscrows = await ctx.db.query("escrow").collect();
    const allDisputes = await ctx.db.query("disputes").collect();
    const counts = createAdminEscrowCounts();

    for (const escrow of allEscrows) {
      counts.all += 1;
      counts[escrow.status] += 1;
    }

    const disputeByOrderId = new Map(
      allDisputes.map((dispute) => [dispute.orderId, dispute])
    );

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
            buyerName: buyer
              ? `${buyer.firstName} ${buyer.lastName}`.trim()
              : "Unknown buyer",
            buyerEmail: buyer?.email ?? "",
            sellerId: escrow.sellerId,
            sellerName: seller
              ? `${seller.firstName} ${seller.lastName}`.trim()
              : "Unknown seller",
            sellerEmail: seller?.email ?? "",
            sellerDisplayName: sellerDisplay.displayName,
            isCompanyStore: sellerDisplay.isCompanyStore,
            status: escrow.status,
            grossAmount: escrow.grossAmount || escrow.amount,
            sellerAmount: escrow.sellerAmount || escrow.amount,
            platformFee: escrow.platformFee || 0,
            refundAmount: escrow.refundAmount,
            shippingLocation: order
              ? `${order.shippingAddress.city}, ${order.shippingAddress.province}`
              : undefined,
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
  handler: async (ctx, args) => {
    const admin = await ctx.db.get(args.adminId);
    if (!admin || admin.role !== "admin") {
      throw new Error("Unauthorized");
    }

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
        case "partially_refunded":
          stats.totalGrossRefunded += escrow.refundAmount ?? 0;
          const sellerReceived = sellerAmount - (escrow.refundAmount ?? 0);
          stats.totalSellerPayouts += Math.max(0, sellerReceived);
          stats.partialRefundCount++;
          break;
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
