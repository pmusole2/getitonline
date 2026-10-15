import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { query, internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { requireUser } from "./lib/auth";
import { assertFinancialOrderAccess, requireTransactionReadAccess } from "./lib/financialAccess";
import { ensureAdminActor } from "./lib/platform";
import { centsToStoredMajor, checkedAdd } from "./lib/catalogMoney";
import { projectEscrowFinancials } from "./lib/escrowAccounting";
import { provenProviderFee } from "./lib/paymentReconciliation";

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

  const candidate =
    "checkoutOrderIds" in metadata ? metadata.checkoutOrderIds : "orderIds" in metadata ? metadata.orderIds : undefined;

  if (!Array.isArray(candidate)) {
    return [];
  }

  return candidate.filter((id): id is string => typeof id === "string");
}

async function markOrderPaidAndCreateEscrow(ctx: MutationCtx, orderId: Id<"orders">, now: number, gatewayFee?: number) {
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
export const createTransaction = internalMutation({
  args: {
    orderId: v.optional(v.id("orders")),
    userId: v.id("users"),
    type: v.union(v.literal("collection"), v.literal("transfer"), v.literal("refund")),
    paymentMethod: v.union(v.literal("mobile_money"), v.literal("card"), v.literal("bank_transfer")),
    amount: v.number(),
    currency: v.string(),
    description: v.optional(v.string()),
    // Mobile money specific
    mobileMoneyProvider: v.optional(v.union(v.literal("mtn"), v.literal("airtel"), v.literal("zamtel"))),
    mobileNumber: v.optional(v.string()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) {
      throw new Error("User not found");
    }

    const order = args.orderId ? await ctx.db.get(args.orderId) : null;
    if (args.orderId && !order) {
      throw new Error("Order not found");
    }

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
      description: args.description || (order ? `Payment for order ${order.orderNumber}` : "Checkout payment"),
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
export const updateTransactionLencoIds = internalMutation({
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
    if (!transaction) {
      throw new Error("Transaction not found");
    }

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
export const updateTransactionStatus = internalMutation({
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

    if (!transaction) {
      throw new Error("Transaction not found");
    }

    const now = Date.now();
    const updates: Record<string, unknown> = {
      status: args.status,
      updatedAt: now,
    };

    if (args.failureReason) {
      updates.failureReason = args.failureReason;
    }
    if (args.fee !== undefined) {
      updates.fee = args.fee;
    }
    if (args.netAmount !== undefined) {
      updates.netAmount = args.netAmount;
    }
    if (args.metadata) {
      updates.metadata = args.metadata;
    }

    // Set completedAt for terminal statuses
    if (["successful", "failed", "cancelled", "refunded"].includes(args.status)) {
      updates.completedAt = now;
    }

    await ctx.db.patch(transaction._id, updates);

    // If successful, update order status and create escrow with proper fund breakdown
    if (args.status === "successful" && transaction.orderId) {
      const order = await ctx.db.get(transaction.orderId);
      if (!order) {
        throw new Error("Order not found for transaction");
      }

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
      if (!orderId) {
        return await ctx.db.get(transaction._id);
      } // Additional safety check

      const existingEscrow = await ctx.db
        .query("escrow")
        .withIndex("by_order", (q) => q.eq("orderId", orderId))
        .first();

      if (!existingEscrow) {
        // Use order's calculated values for proper fund tracking
        const grossAmount = order.totalAmount; // What buyer paid
        const platformFee = order.platformFee || 0; // 5% platform fee
        const sellerAmount = order.sellerPayout || order.subtotal + order.shippingCost; // Seller's share

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
export const updateTransactionByLencoId = internalMutation({
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
      .withIndex("by_lenco_collection", (q) => q.eq("lencoCollectionId", args.lencoCollectionId))
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

    if (args.failureReason) {
      updates.failureReason = args.failureReason;
    }
    if (args.fee !== undefined) {
      updates.fee = args.fee;
    }
    if (netAmount !== undefined) {
      updates.netAmount = netAmount;
    }
    if (args.metadata) {
      updates.metadata = args.metadata;
    }

    if (["successful", "failed", "cancelled", "refunded"].includes(args.status)) {
      updates.completedAt = now;
    }

    await ctx.db.patch(transaction._id, updates);

    // Handle successful payment - create escrow with proper fund breakdown
    if (args.status === "successful") {
      console.log(`✅ Processing successful payment for transaction: ${transaction._id}`);
      console.log(`📦 Order ID: ${transaction.orderId || "N/A (top-up)"}`);

      const checkoutOrderIds = getCheckoutOrderIds(transaction.metadata ?? args.metadata).map(
        (orderId) => orderId as Id<"orders">
      );

      if (!transaction.orderId && checkoutOrderIds.length > 0) {
        await Promise.all(checkoutOrderIds.map((orderId) => markOrderPaidAndCreateEscrow(ctx, orderId, now, args.fee)));
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
      if (!orderId) {
        return await ctx.db.get(transaction._id);
      } // Additional safety check

      const existingEscrow = await ctx.db
        .query("escrow")
        .withIndex("by_order", (q) => q.eq("orderId", orderId))
        .first();

      console.log(`💰 Existing escrow: ${existingEscrow ? "Yes" : "No"}`);

      if (!existingEscrow) {
        // Proper fund breakdown from order
        const grossAmount = order.totalAmount;
        const platformFee = order.platformFee || 0;
        const sellerAmount = order.sellerPayout || order.subtotal + order.shippingCost;

        console.log(
          `💰 Creating escrow - grossAmount: ${grossAmount}, platformFee: ${platformFee}, sellerAmount: ${sellerAmount}`
        );

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
    const actor = await requireUser(ctx);
    const transaction = await ctx.db
      .query("transactions")
      .withIndex("by_reference", (q) => q.eq("reference", args.reference))
      .first();
    if (transaction) {
      await requireTransactionReadAccess(ctx, actor, transaction);
    }

    return transaction;
  },
});

// Get transaction by ID
export const getTransaction = query({
  args: { transactionId: v.id("transactions") },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const transaction = await ctx.db.get(args.transactionId);
    if (!transaction) {
      return null;
    }

    const order = await requireTransactionReadAccess(ctx, actor, transaction);
    const user = await ctx.db.get(transaction.userId);

    return {
      ...transaction,
      order: order ? { orderNumber: order.orderNumber, totalAmount: order.totalAmount } : null,
      user: user ? { firstName: user.firstName, lastName: user.lastName } : null,
    };
  },
});

// Get transactions for an order
export const getOrderTransactions = query({
  args: { orderId: v.id("orders") },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const order = await ctx.db.get(args.orderId);
    if (!order) {
      return [];
    }
    await assertFinancialOrderAccess(ctx, actor, order);

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
    const actor = await requireUser(ctx);
    const limit = args.limit || 50;

    let query = ctx.db.query("transactions").withIndex("by_user", (q) => q.eq("userId", actor._id));

    if (args.status) {
      query = query.filter((q) => q.eq(q.field("status"), args.status));
    }

    const transactions = await query.order("desc").take(limit);

    // Add order details
    return await Promise.all(
      transactions.map(async (txn) => {
        const order = await requireTransactionReadAccess(ctx, actor, txn);
        return {
          ...txn,
          order: order ? { orderNumber: order.orderNumber, totalAmount: order.totalAmount } : null,
        };
      })
    );
  },
});

export const listTransactionsForAdmin = query({
  args: { adminId: v.id("users") },
  handler: async (ctx, _args) => {
    await ensureAdminActor(ctx);

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
            userName: user ? `${user.firstName} ${user.lastName}`.trim() : "Unknown user",
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
  handler: async (ctx, _args) => {
    await ensureAdminActor(ctx);

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
      if (txn.status === "pending") {
        stats.pending++;
      } else if (txn.status === "processing") {
        stats.processing++;
      } else if (txn.status === "successful") {
        stats.successful++;
      } else if (txn.status === "failed") {
        stats.failed++;
      } else if (txn.status === "cancelled") {
        stats.cancelled++;
      } else if (txn.status === "refunded") {
        stats.refunded++;
      }

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
export const createTopUpTransaction = internalMutation({
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
    if (!user) {
      throw new Error("User not found");
    }

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

function addFinancialCents(total: number | null, cents: number): number | null {
  return total === null ? null : checkedAdd(total, cents);
}

function financialMajor(cents: number | null): number | null {
  return cents === null ? null : centsToStoredMajor(cents);
}

function signedFinancialMajor(cents: number): number | null {
  const magnitude = centsToStoredMajor(Math.abs(cents));
  return magnitude === null ? null : cents < 0 ? -magnitude : magnitude;
}

// Get platform financial summary (admin only). Full-history reads are deliberate
// here; none are added to a money writer or used to reconcile/repair history.
export const getPlatformFinancialSummary = query({
  args: { adminId: v.id("users") },
  handler: async (ctx, _args) => {
    await ensureAdminActor(ctx);

    const allEscrows = await ctx.db.query("escrow").collect();
    const allTransactions = await ctx.db.query("transactions").collect();
    const operations = await ctx.db.query("paymentOperations").collect();
    const walletHistory = await ctx.db.query("walletTransactions").collect();
    let gross: number | null = 0;
    let earned: number | null = 0;
    let held: number | null = 0;
    let seller: number | null = 0;
    let refund: number | null = 0;
    let fees: number | null = 0;
    let verifiedEscrows = 0;
    let unprovenEscrows = 0;
    let pendingEscrows = 0;
    let unprovenFundingOperations = 0;
    let unknownFeeOperations = 0;
    let unsettledProviderOperations = 0;
    let verifiedFeeOperations = 0;
    const companions = new Set<Id<"transactions">>();
    const providerLedgers = new Set<Id<"walletTransactions">>();

    for (const escrow of allEscrows) {
      const projection = await projectEscrowFinancials(ctx, escrow);
      if (projection.state === "review") {
        unprovenEscrows++;
        continue;
      }
      verifiedEscrows++;
      if (projection.state === "pending") {
        pendingEscrows++;
      }
      gross = addFinancialCents(gross, projection.grossCents);
      earned = addFinancialCents(earned, projection.earnedCents);
      held = addFinancialCents(held, projection.heldCents);
      seller = addFinancialCents(seller, projection.sellerCents);
      refund = addFinancialCents(refund, projection.refundCents);
    }

    const escrowOperations = new Set(allEscrows.map((escrow) => escrow.operationId));
    for (const operation of operations) {
      if (
        (operation.kind === "wallet_purchase" ||
          (operation.kind === "checkout_collection" &&
            (operation.accounting?.kind === "checkout_captured" || operation.receipt?.status === "successful"))) &&
        !escrowOperations.has(operation._id)
      ) {
        unprovenFundingOperations++;
      }
      if (operation.kind === "wallet_purchase") {
        continue; // Internal wallet spending has no external provider fee.
      }
      // A durable reservation with no external attempt has no charged fee yet.
      if (
        operation.accounting === undefined &&
        operation.attemptedAt === undefined &&
        operation.receipt === undefined &&
        operation.providerId === undefined &&
        operation.reviewNeeded !== true &&
        (operation.status === "reserved" || operation.status === "cancelled")
      ) {
        continue;
      }
      const evidence = await provenProviderFee(ctx, operation);
      if (!evidence.validated || evidence.feeCents === null) {
        unknownFeeOperations++;
        if (operation.accounting === undefined) {
          unsettledProviderOperations++;
        }
      } else {
        verifiedFeeOperations++;
        fees = addFinancialCents(fees, evidence.feeCents);
      }
      if (!evidence.validated) {
        continue;
      }
      const accounting = operation.accounting;
      if (accounting === undefined) {
        throw new Error("Financial summary invariant: validated accounting missing");
      }
      if ("transactionId" in accounting) {
        companions.add(accounting.transactionId);
      }
      if (accounting.kind === "topup_credit") {
        providerLedgers.add(accounting.creditId);
      } else if (accounting.kind === "withdrawal_completed" || accounting.kind === "withdrawal_reversed") {
        providerLedgers.add(accounting.debitId);
        if (accounting.kind === "withdrawal_reversed") {
          providerLedgers.add(accounting.reversalId);
        }
      }
    }
    // Legacy/unlinked costs, including inactive cards, are explicitly unproven.
    // Transaction fee/gatewayFee fields never establish provider cost authority.
    const unprovenTransactions = allTransactions.filter((transaction) => !companions.has(transaction._id)).length;
    const unprovenProviderLedgerEntries = walletHistory.filter(
      (entry) =>
        (entry.source === "top_up_mobile_money" ||
          entry.source === "top_up_card" ||
          entry.source === "top_up_bank" ||
          entry.source === "withdrawal_mobile_money" ||
          entry.source === "withdrawal_bank" ||
          entry.source === "withdrawal_reversal") &&
        !providerLedgers.has(entry._id)
    ).length;
    const verifiedSubtotals = {
      totalGrossReceived: financialMajor(gross),
      totalPlatformFees: financialMajor(earned),
      totalGatewayFees: financialMajor(fees),
      heldInEscrow: financialMajor(held),
      releasedToSellers: financialMajor(seller),
      refundedToBuyers: financialMajor(refund),
    };
    const overflow = Object.values(verifiedSubtotals).some((value) => value === null);
    const escrowComplete =
      unprovenEscrows === 0 &&
      unprovenFundingOperations === 0 &&
      [
        verifiedSubtotals.totalGrossReceived,
        verifiedSubtotals.totalPlatformFees,
        verifiedSubtotals.heldInEscrow,
        verifiedSubtotals.releasedToSellers,
        verifiedSubtotals.refundedToBuyers,
      ].every((value) => value !== null);
    const feesComplete =
      unknownFeeOperations === 0 &&
      unprovenTransactions === 0 &&
      unprovenProviderLedgerEntries === 0 &&
      verifiedSubtotals.totalGatewayFees !== null;
    let assigned: number | null = 0;
    for (const value of [held, seller, refund, earned]) {
      assigned = value === null || assigned === null ? null : checkedAdd(assigned, value);
    }
    const conserved = escrowComplete && assigned !== null && assigned === gross;
    const profit = earned === null || fees === null ? null : signedFinancialMajor(earned - fees);
    const profitOverflow = earned !== null && fees !== null && profit === null;
    const complete = escrowComplete && feesComplete && pendingEscrows === 0 && conserved && !profitOverflow;

    return {
      totalGrossReceived: escrowComplete ? verifiedSubtotals.totalGrossReceived : null,
      totalPlatformFees: escrowComplete ? verifiedSubtotals.totalPlatformFees : null,
      totalGatewayFees: feesComplete ? verifiedSubtotals.totalGatewayFees : null,
      netPlatformProfit: complete ? profit : null,
      heldInEscrow: escrowComplete ? verifiedSubtotals.heldInEscrow : null,
      releasedToSellers: escrowComplete ? verifiedSubtotals.releasedToSellers : null,
      refundedToBuyers: escrowComplete ? verifiedSubtotals.refundedToBuyers : null,
      unaccountedFunds: complete ? 0 : null,
      completeness: { escrow: escrowComplete, fees: feesComplete, complete },
      review: {
        unprovenEscrows,
        unprovenFundingOperations,
        pendingEscrows,
        unknownFeeOperations,
        unsettledProviderOperations,
        unprovenTransactions,
        outOfScopeCardTransactions: allTransactions.filter((transaction) => transaction.paymentMethod === "card")
          .length,
        unprovenProviderLedgerEntries,
        aggregateOverflow: overflow || profitOverflow,
      },
      verifiedSubtotals,
      verifiedCounts: { escrows: verifiedEscrows, feeOperations: verifiedFeeOperations },
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
