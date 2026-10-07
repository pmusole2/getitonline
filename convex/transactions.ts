import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query, internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { ensureAdminActor } from "./lib/platform";

// Generate unique transaction reference
function generateReference(): string {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `TXN-${timestamp}-${random}`;
}

function createAdminTransactionCounts() {
  return {
    all: 0,
    pending: 0,
    processing: 0,
    successful: 0,
    failed: 0,
    cancelled: 0,
    refunded: 0,
  };
}

function createAdminTransactionTypeCounts() {
  return {
    all: 0,
    collection: 0,
    transfer: 0,
    refund: 0,
  };
}

function isTopUpMetadata(metadata: unknown) {
  if (!metadata || typeof metadata !== "object") {
    return false;
  }

  if (!("topUp" in metadata)) {
    return false;
  }

  return metadata.topUp === true;
}

function getCheckoutOrderIds(metadata: unknown) {
  if (!metadata || typeof metadata !== "object") {
    return [];
  }

  const candidate = "checkoutOrderIds" in metadata
    ? metadata.checkoutOrderIds
    : "orderIds" in metadata
      ? metadata.orderIds
      : undefined;

  if (!Array.isArray(candidate)) {
    return [];
  }

  return candidate.filter((id): id is string => typeof id === "string");
}

async function markOrderPaidAndCreateEscrow(
  ctx: MutationCtx,
  orderId: Id<"orders">,
  now: number,
  gatewayFee?: number
) {
  const order = await ctx.db.get(orderId);
  if (!order) {
    console.error(`❌ Order not found for aggregate payment: ${orderId}`);
    return;
  }

  await ctx.db.patch(order._id, {
    status: "paid",
    updatedAt: now,
  });

  const existingEscrow = await ctx.db
    .query("escrow")
    .withIndex("by_order", (q) => q.eq("orderId", order._id))
    .first();

  if (existingEscrow) {
    return;
  }

  const grossAmount = order.totalAmount;
  const platformFee = order.platformFee || 0;
  const sellerAmount = order.sellerPayout || order.subtotal + order.shippingCost;

  await ctx.db.insert("escrow", {
    orderId: order._id,
    buyerId: order.buyerId,
    sellerId: order.sellerId,
    grossAmount,
    platformFee,
    sellerAmount,
    amount: grossAmount,
    status: "held",
    createdAt: now,
    updatedAt: now,
  });

  await ctx.db.insert("notifications", {
    userId: order.sellerId,
    type: "payment_received",
    title: "Payment Received",
    message: `Payment received for order ${order.orderNumber}. K${sellerAmount.toLocaleString()} will be released after delivery confirmation.`,
    data: { orderId: order._id, gatewayFee },
    isRead: false,
    createdAt: now,
  });
}

// Create a new transaction (for initiating payment)
export const createTransaction = mutation({
  args: {
    orderId: v.optional(v.id("orders")),
    userId: v.id("users"),
    type: v.union(
      v.literal("collection"),
      v.literal("transfer"),
      v.literal("refund")
    ),
    paymentMethod: v.union(
      v.literal("mobile_money"),
      v.literal("card"),
      v.literal("bank_transfer")
    ),
    amount: v.number(),
    currency: v.string(),
    description: v.optional(v.string()),
    // Mobile money specific
    mobileMoneyProvider: v.optional(
      v.union(v.literal("mtn"), v.literal("airtel"), v.literal("zamtel"))
    ),
    mobileNumber: v.optional(v.string()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) throw new Error("User not found");

    const order = args.orderId ? await ctx.db.get(args.orderId) : null;
    if (args.orderId && !order) throw new Error("Order not found");

    const reference = generateReference();
    const now = Date.now();

    const transactionId = await ctx.db.insert("transactions", {
      orderId: args.orderId,
      userId: args.userId,
      reference,
      type: args.type,
      paymentMethod: args.paymentMethod,
      mobileMoneyProvider: args.mobileMoneyProvider,
      mobileNumber: args.mobileNumber,
      amount: args.amount,
      currency: args.currency,
      status: "pending",
      description:
        args.description ||
        (order ? `Payment for order ${order.orderNumber}` : "Checkout payment"),
      metadata: args.metadata,
      initiatedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    return {
      transactionId,
      reference,
    };
  },
});

// Update transaction with Lenco IDs (after API call)
export const updateTransactionLencoIds = mutation({
  args: {
    transactionId: v.id("transactions"),
    lencoTransactionId: v.optional(v.string()),
    lencoCollectionId: v.optional(v.string()),
    status: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("processing"),
        v.literal("successful"),
        v.literal("failed"),
        v.literal("cancelled"),
        v.literal("refunded")
      )
    ),
  },
  handler: async (ctx, args) => {
    const transaction = await ctx.db.get(args.transactionId);
    if (!transaction) throw new Error("Transaction not found");

    await ctx.db.patch(args.transactionId, {
      lencoTransactionId: args.lencoTransactionId,
      lencoCollectionId: args.lencoCollectionId,
      status: args.status || transaction.status,
      updatedAt: Date.now(),
    });

    return await ctx.db.get(args.transactionId);
  },
});

// Update transaction status (for webhooks)
export const updateTransactionStatus = mutation({
  args: {
    reference: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("processing"),
      v.literal("successful"),
      v.literal("failed"),
      v.literal("cancelled"),
      v.literal("refunded")
    ),
    failureReason: v.optional(v.string()),
    fee: v.optional(v.number()),
    netAmount: v.optional(v.number()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const transaction = await ctx.db
      .query("transactions")
      .withIndex("by_reference", (q) => q.eq("reference", args.reference))
      .first();

    if (!transaction) throw new Error("Transaction not found");

    const now = Date.now();
    const updates: Record<string, unknown> = {
      status: args.status,
      updatedAt: now,
    };

    if (args.failureReason) updates.failureReason = args.failureReason;
    if (args.fee !== undefined) updates.fee = args.fee;
    if (args.netAmount !== undefined) updates.netAmount = args.netAmount;
    if (args.metadata) updates.metadata = args.metadata;

    // Set completedAt for terminal statuses
    if (["successful", "failed", "cancelled", "refunded"].includes(args.status)) {
      updates.completedAt = now;
    }

    await ctx.db.patch(transaction._id, updates);

    // If successful, update order status and create escrow with proper fund breakdown
    if (args.status === "successful" && transaction.orderId) {
      const order = await ctx.db.get(transaction.orderId);
      if (!order) throw new Error("Order not found for transaction");

      // Update order to paid
      await ctx.db.patch(transaction.orderId, {
        status: "paid",
        updatedAt: now,
      });

      // Create escrow record if not exists (with complete fund breakdown)
      if (!transaction.orderId) {
        throw new Error("Order ID is required for escrow");
      }

      const orderId = transaction.orderId;
      if (!orderId) return await ctx.db.get(transaction._id); // Additional safety check

      const existingEscrow = await ctx.db
        .query("escrow")
        .withIndex("by_order", (q) => q.eq("orderId", orderId))
        .first();

      if (!existingEscrow) {
        // Use order's calculated values for proper fund tracking
        const grossAmount = order.totalAmount; // What buyer paid
        const platformFee = order.platformFee || 0; // 5% platform fee
        const sellerAmount = order.sellerPayout || (order.subtotal + order.shippingCost); // Seller's share

        const escrowId = await ctx.db.insert("escrow", {
          orderId: orderId,
          buyerId: order.buyerId,
          sellerId: order.sellerId,
          // Fund breakdown - ensures no mixup
          grossAmount,
          platformFee,
          sellerAmount,
          amount: grossAmount, // Legacy field
          status: "held",
          createdAt: now,
          updatedAt: now,
        });

        // Link escrow to transaction and store fee breakdown
        await ctx.db.patch(transaction._id, {
          escrowId,
          platformFee,
          sellerPayout: sellerAmount,
          updatedAt: now,
        });
      }

      // Create notification for seller
      await ctx.db.insert("notifications", {
        userId: order.sellerId,
        type: "payment_received",
        title: "Payment Received",
        message: `Payment received for order ${order.orderNumber}. Amount: K${order.sellerPayout?.toLocaleString() || order.subtotal.toLocaleString()} will be released after delivery confirmation.`,
        data: { orderId: transaction.orderId },
        isRead: false,
        createdAt: now,
      });
    }

    // If failed, notify buyer
    if (args.status === "failed") {
      await ctx.db.insert("notifications", {
        userId: transaction.userId,
        type: "payment_failed",
        title: "Payment Failed",
        message: args.failureReason || "Your payment could not be processed. Please try again.",
        data: transaction.orderId ? { orderId: transaction.orderId } : {},
        isRead: false,
        createdAt: now,
      });
    }

    return await ctx.db.get(transaction._id);
  },
});

// Update by Lenco collection ID (for webhooks)
export const updateTransactionByLencoId = mutation({
  args: {
    lencoCollectionId: v.string(),
    reference: v.optional(v.string()), // Fallback lookup
    status: v.union(
      v.literal("pending"),
      v.literal("processing"),
      v.literal("successful"),
      v.literal("failed"),
      v.literal("cancelled"),
      v.literal("refunded")
    ),
    failureReason: v.optional(v.string()),
    fee: v.optional(v.number()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    // Try to find by Lenco collection ID first
    let transaction = await ctx.db
      .query("transactions")
      .withIndex("by_lenco_collection", (q) =>
        q.eq("lencoCollectionId", args.lencoCollectionId)
      )
      .first();

    // Fallback: try to find by reference
    if (!transaction && args.reference) {
      const ref = args.reference; // TypeScript narrowing
      console.log(`Transaction not found by Lenco ID, trying reference: ${ref}`);
      transaction = await ctx.db
        .query("transactions")
        .withIndex("by_reference", (q) => q.eq("reference", ref))
        .first();

      // If found by reference, update the lencoCollectionId
      if (transaction) {
        await ctx.db.patch(transaction._id, {
          lencoCollectionId: args.lencoCollectionId,
        });
      }
    }

    if (!transaction) {
      console.error(`Transaction not found for Lenco ID: ${args.lencoCollectionId}, reference: ${args.reference}`);
      throw new Error(`Transaction not found for webhook - lencoId: ${args.lencoCollectionId}, ref: ${args.reference}`);
    }

    const now = Date.now();
    const netAmount = args.fee ? transaction.amount - args.fee : undefined;

    const updates: Record<string, unknown> = {
      status: args.status,
      updatedAt: now,
    };

    if (args.failureReason) updates.failureReason = args.failureReason;
    if (args.fee !== undefined) updates.fee = args.fee;
    if (netAmount !== undefined) updates.netAmount = netAmount;
    if (args.metadata) updates.metadata = args.metadata;

    if (["successful", "failed", "cancelled", "refunded"].includes(args.status)) {
      updates.completedAt = now;
    }

    await ctx.db.patch(transaction._id, updates);

    // Handle successful payment - create escrow with proper fund breakdown
    if (args.status === "successful") {
      console.log(`✅ Processing successful payment for transaction: ${transaction._id}`);
      console.log(`📦 Order ID: ${transaction.orderId || 'N/A (top-up)'}`);

      const checkoutOrderIds = getCheckoutOrderIds(
        transaction.metadata ?? args.metadata
      ).map((orderId) => orderId as Id<"orders">);

      if (!transaction.orderId && checkoutOrderIds.length > 0) {
        await Promise.all(
          checkoutOrderIds.map((orderId) =>
            markOrderPaidAndCreateEscrow(ctx, orderId, now, args.fee)
          )
        );
        console.log(`🎉 Aggregate payment processing complete for ${checkoutOrderIds.length} orders`);
        return await ctx.db.get(transaction._id);
      }

      // Skip escrow handling for top-ups or transactions without order context.
      if (!transaction.orderId) {
        console.log(`ℹ️ No order ID - skipping escrow`);
        return await ctx.db.get(transaction._id);
      }

      const order = await ctx.db.get(transaction.orderId);
      if (!order) {
        console.error(`❌ Order not found for transaction: ${transaction._id}`);
        return await ctx.db.get(transaction._id);
      }

      console.log(`📦 Order found: ${order.orderNumber}, current status: ${order.status}`);

      await ctx.db.patch(transaction.orderId, {
        status: "paid",
        updatedAt: now,
      });

      console.log(`✅ Order ${order.orderNumber} status updated to paid`);

      const orderId = transaction.orderId;
      if (!orderId) return await ctx.db.get(transaction._id); // Additional safety check

      const existingEscrow = await ctx.db
        .query("escrow")
        .withIndex("by_order", (q) => q.eq("orderId", orderId))
        .first();

      console.log(`💰 Existing escrow: ${existingEscrow ? 'Yes' : 'No'}`);

      if (!existingEscrow) {
        // Proper fund breakdown from order
        const grossAmount = order.totalAmount;
        const platformFee = order.platformFee || 0;
        const sellerAmount = order.sellerPayout || (order.subtotal + order.shippingCost);

        console.log(`💰 Creating escrow - grossAmount: ${grossAmount}, platformFee: ${platformFee}, sellerAmount: ${sellerAmount}`);

        const escrowId = await ctx.db.insert("escrow", {
          orderId: orderId,
          buyerId: order.buyerId,
          sellerId: order.sellerId,
          grossAmount,
          platformFee,
          sellerAmount,
          amount: grossAmount,
          status: "held",
          createdAt: now,
          updatedAt: now,
        });

        // Store gateway fee separately from platform fee
        await ctx.db.patch(transaction._id, {
          escrowId,
          gatewayFee: args.fee,
          platformFee,
          sellerPayout: sellerAmount,
          updatedAt: now,
        });

        await ctx.db.insert("notifications", {
          userId: order.sellerId,
          type: "payment_received",
          title: "Payment Received",
          message: `Payment received for order ${order.orderNumber}. K${sellerAmount.toLocaleString()} will be released after delivery confirmation.`,
          data: transaction.orderId ? { orderId: transaction.orderId } : {},
          isRead: false,
          createdAt: now,
        });

        console.log(`✅ Escrow created: ${escrowId}, notification sent to seller`);
      }

      console.log(`🎉 Payment processing complete for order ${order.orderNumber}`);
    }

    if (args.status === "failed") {
      await ctx.db.insert("notifications", {
        userId: transaction.userId,
        type: "payment_failed",
        title: "Payment Failed",
        message: args.failureReason || "Your payment could not be processed.",
        data: { orderId: transaction.orderId },
        isRead: false,
        createdAt: now,
      });
    }

    return await ctx.db.get(transaction._id);
  },
});

// Get transaction by reference
export const getTransactionByReference = query({
  args: { reference: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("transactions")
      .withIndex("by_reference", (q) => q.eq("reference", args.reference))
      .first();
  },
});

// Get transaction by ID
export const getTransaction = query({
  args: { transactionId: v.id("transactions") },
  handler: async (ctx, args) => {
    const transaction = await ctx.db.get(args.transactionId);
    if (!transaction) return null;

    const order = transaction.orderId ? await ctx.db.get(transaction.orderId) : null;
    const user = await ctx.db.get(transaction.userId);

    return {
      ...transaction,
      order: order
        ? { orderNumber: order.orderNumber, totalAmount: order.totalAmount }
        : null,
      user: user
        ? { firstName: user.firstName, lastName: user.lastName }
        : null,
    };
  },
});

// Get transactions for an order
export const getOrderTransactions = query({
  args: { orderId: v.id("orders") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("transactions")
      .withIndex("by_order", (q) => q.eq("orderId", args.orderId))
      .order("desc")
      .collect();
  },
});

// Get user's transactions
export const getUserTransactions = query({
  args: {
    userId: v.id("users"),
    limit: v.optional(v.number()),
    status: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("processing"),
        v.literal("successful"),
        v.literal("failed"),
        v.literal("cancelled"),
        v.literal("refunded")
      )
    ),
  },
  handler: async (ctx, args) => {
    const limit = args.limit || 50;

    let query = ctx.db
      .query("transactions")
      .withIndex("by_user", (q) => q.eq("userId", args.userId));

    if (args.status) {
      query = query.filter((q) => q.eq(q.field("status"), args.status));
    }

    const transactions = await query.order("desc").take(limit);

    // Add order details
    return await Promise.all(
      transactions.map(async (txn) => {
        const order = txn.orderId ? await ctx.db.get(txn.orderId) : null;
        return {
          ...txn,
          order: order
            ? { orderNumber: order.orderNumber, totalAmount: order.totalAmount }
            : null,
        };
      })
    );
  },
});

export const listTransactionsForAdmin = query({
  args: { adminId: v.id("users") },
  handler: async (ctx, args) => {
    await ensureAdminActor(ctx, args.adminId);

    const allTransactions = await ctx.db.query("transactions").collect();
    const counts = createAdminTransactionCounts();
    const typeCounts = createAdminTransactionTypeCounts();

    for (const transaction of allTransactions) {
      counts.all += 1;
      counts[transaction.status] += 1;
      typeCounts.all += 1;
      typeCounts[transaction.type] += 1;
    }

    const items = await Promise.all(
      [...allTransactions]
        .sort((left, right) => right.createdAt - left.createdAt)
        .map(async (transaction) => {
          const [user, order] = await Promise.all([
            ctx.db.get(transaction.userId),
            transaction.orderId ? ctx.db.get(transaction.orderId) : null,
          ]);

          const metadata: unknown = transaction.metadata;

          return {
            _id: transaction._id,
            reference: transaction.reference,
            orderId: transaction.orderId,
            orderNumber: order?.orderNumber,
            orderStatus: order?.status,
            userId: transaction.userId,
            userName: user
              ? `${user.firstName} ${user.lastName}`.trim()
              : "Unknown user",
            userEmail: user?.email ?? "",
            type: transaction.type,
            paymentMethod: transaction.paymentMethod,
            mobileMoneyProvider: transaction.mobileMoneyProvider,
            amount: transaction.amount,
            platformFee: transaction.platformFee,
            gatewayFee: transaction.gatewayFee ?? transaction.fee,
            netAmount: transaction.netAmount,
            sellerPayout: transaction.sellerPayout,
            currency: transaction.currency,
            status: transaction.status,
            description: transaction.description ?? "",
            initiatedAt: transaction.initiatedAt,
            createdAt: transaction.createdAt,
            updatedAt: transaction.updatedAt,
            completedAt: transaction.completedAt,
            isTopUp: isTopUpMetadata(metadata),
          };
        })
    );

    return {
      items,
      counts,
      typeCounts,
    };
  },
});

// Get transaction statistics for admin
export const getTransactionStats = query({
  args: { adminId: v.id("users") },
  handler: async (ctx, args) => {
    const admin = await ctx.db.get(args.adminId);
    if (!admin || admin.role !== "admin") {
      throw new Error("Unauthorized");
    }

    const allTransactions = await ctx.db.query("transactions").collect();

    const stats = {
      total: allTransactions.length,
      pending: 0,
      processing: 0,
      successful: 0,
      failed: 0,
      cancelled: 0,
      refunded: 0,
      totalVolume: 0,
      totalFees: 0,
      byPaymentMethod: {
        mobile_money: { count: 0, volume: 0 },
        card: { count: 0, volume: 0 },
        bank_transfer: { count: 0, volume: 0 },
      },
    };

    for (const txn of allTransactions) {
      // Count by status
      if (txn.status === "pending") stats.pending++;
      else if (txn.status === "processing") stats.processing++;
      else if (txn.status === "successful") stats.successful++;
      else if (txn.status === "failed") stats.failed++;
      else if (txn.status === "cancelled") stats.cancelled++;
      else if (txn.status === "refunded") stats.refunded++;

      // Sum volumes for successful transactions
      if (txn.status === "successful") {
        stats.totalVolume += txn.amount;
        stats.totalFees += txn.fee || 0;

        // By payment method
        const method = txn.paymentMethod;
        if (method in stats.byPaymentMethod) {
          stats.byPaymentMethod[method as keyof typeof stats.byPaymentMethod].count++;
          stats.byPaymentMethod[method as keyof typeof stats.byPaymentMethod].volume += txn.amount;
        }
      }
    }

    return stats;
  },
});

// Create transaction for wallet top-up (for webhook tracking)
export const createTopUpTransaction = mutation({
  args: {
    userId: v.id("users"),
    amount: v.number(),
    reference: v.string(),
    lencoCollectionId: v.string(),
    paymentMethod: v.union(v.literal("mobile_money"), v.literal("card")),
    provider: v.optional(v.union(v.literal("mtn"), v.literal("airtel"), v.literal("zamtel"))),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) throw new Error("User not found");

    const now = Date.now();

    // Create a special top-up transaction (without orderId)
    const transactionId = await ctx.db.insert("transactions", {
      userId: args.userId,
      reference: args.reference,
      lencoCollectionId: args.lencoCollectionId,
      type: "collection",
      paymentMethod: args.paymentMethod,
      mobileMoneyProvider: args.provider,
      amount: args.amount,
      currency: "ZMW",
      status: "pending",
      description: `Wallet top-up via ${args.paymentMethod === "mobile_money" ? args.provider?.toUpperCase() : "card"}`,
      initiatedAt: now,
      createdAt: now,
      updatedAt: now,
      // Note: orderId is optional in transactions, so this is valid
      metadata: {
        topUp: true,
        type: args.paymentMethod,
      },
    });

    return transactionId;
  },
});

// Get platform financial summary (admin only)
export const getPlatformFinancialSummary = query({
  args: { adminId: v.id("users") },
  handler: async (ctx, args) => {
    const admin = await ctx.db.get(args.adminId);
    if (!admin || admin.role !== "admin") {
      throw new Error("Unauthorized");
    }

    const allEscrows = await ctx.db.query("escrow").collect();
    const allTransactions = await ctx.db.query("transactions").collect();

    let totalGrossReceived = 0;
    let totalPlatformFees = 0;
    let totalSellerPayouts = 0;
    let totalGatewayFees = 0;
    let heldInEscrow = 0;
    let releasedToSellers = 0;
    let refundedToBuyers = 0;

    for (const escrow of allEscrows) {
      totalGrossReceived += escrow.grossAmount || escrow.amount;
      totalPlatformFees += escrow.platformFee || 0;

      if (escrow.status === "held") {
        heldInEscrow += escrow.sellerAmount || escrow.amount;
      } else if (escrow.status === "released") {
        releasedToSellers += escrow.sellerAmount || escrow.amount;
      } else if (escrow.status === "refunded") {
        refundedToBuyers += escrow.refundAmount || escrow.grossAmount || escrow.amount;
      }
    }

    for (const txn of allTransactions) {
      if (txn.status === "successful") {
        totalGatewayFees += txn.gatewayFee || txn.fee || 0;
      }
    }

    totalSellerPayouts = releasedToSellers;

    return {
      // Gross amounts
      totalGrossReceived,
      totalPlatformFees,
      totalGatewayFees,

      // Net platform profit
      netPlatformProfit: totalPlatformFees - totalGatewayFees,

      // Fund status
      heldInEscrow,
      releasedToSellers,
      refundedToBuyers,

      // Verification (should be 0 if balanced)
      unaccountedFunds: totalGrossReceived - heldInEscrow - releasedToSellers - refundedToBuyers - totalPlatformFees,
    };
  },
});

// Calculate order total with platform fee (helper for mobile app)
export const calculateOrderTotal = query({
  args: {
    subtotal: v.number(),
    shippingCost: v.number(),
  },
  handler: async (_ctx, args) => {
    const platformFeeRate = 0.05; // 5%
    const platformFee = Math.ceil(args.subtotal * platformFeeRate * 100) / 100;
    const totalAmount = args.subtotal + args.shippingCost + platformFee;
    const sellerPayout = args.subtotal + args.shippingCost;

    return {
      subtotal: args.subtotal,
      shippingCost: args.shippingCost,
      platformFee,
      platformFeePercentage: platformFeeRate * 100,
      totalAmount,
      sellerPayout,
      breakdown: {
        youPay: totalAmount,
        sellerReceives: sellerPayout,
        platformRetains: platformFee,
      },
    };
  },
});
