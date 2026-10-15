import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { requireRole, requireUser, requireSelfOr } from "./lib/auth";

// Generate unique transaction reference
function generateWalletReference(): string {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `WLT-${timestamp}-${random}`;
}

// ============================================================================
// QUERIES
// ============================================================================

// Get user's wallet (or create if doesn't exist)
export const getWallet = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    await requireSelfOr(ctx, args.userId, ["admin"]);
    const wallet = await ctx.db
      .query("wallets")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .first();

    if (!wallet) {
      return null;
    }

    return wallet;
  },
});

// Get wallet balance summary
export const getWalletBalance = query({
  args: {},
  handler: async (ctx) => {
    const actor = await requireUser(ctx);
    const wallet = await ctx.db
      .query("wallets")
      .withIndex("by_user", (q) => q.eq("userId", actor._id))
      .first();

    if (!wallet) {
      return {
        balance: 0,
        pendingBalance: 0,
        totalEarned: 0,
        totalWithdrawn: 0,
        totalSpent: 0,
        hasWallet: false,
      };
    }

    return {
      balance: wallet.balance,
      pendingBalance: wallet.pendingBalance,
      totalEarned: wallet.totalEarned,
      totalWithdrawn: wallet.totalWithdrawn,
      totalSpent: wallet.totalSpent,
      hasWallet: true,
      isActive: wallet.isActive,
      isFrozen: wallet.isFrozen,
    };
  },
});

// Get wallet transactions
export const getWalletTransactions = query({
  args: {
    limit: v.optional(v.number()),
    type: v.optional(
      v.union(v.literal("credit"), v.literal("debit"), v.literal("hold"), v.literal("release"), v.literal("refund"))
    ),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const wallet = await ctx.db
      .query("wallets")
      .withIndex("by_user", (q) => q.eq("userId", actor._id))
      .first();

    if (!wallet) {
      return [];
    }

    const query = ctx.db
      .query("walletTransactions")
      .withIndex("by_wallet", (q) => q.eq("walletId", wallet._id))
      .order("desc");

    const transactions = await query.take(args.limit || 50);

    // Filter by type if specified
    if (args.type) {
      return transactions.filter((t) => t.type === args.type);
    }

    return transactions;
  },
});

// Get recent wallet activity for dashboard
export const getWalletActivity = query({
  args: {},
  handler: async (ctx) => {
    const actor = await requireUser(ctx);
    const wallet = await ctx.db
      .query("wallets")
      .withIndex("by_user", (q) => q.eq("userId", actor._id))
      .first();

    if (!wallet) {
      return {
        recentTransactions: [],
        pendingWithdrawals: 0,
        thisMonthEarnings: 0,
        thisMonthWithdrawals: 0,
      };
    }

    // Get recent transactions
    const recentTransactions = await ctx.db
      .query("walletTransactions")
      .withIndex("by_wallet", (q) => q.eq("walletId", wallet._id))
      .order("desc")
      .take(10);

    // Get this month's start
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

    // Calculate this month's earnings and withdrawals
    const allTransactions = await ctx.db
      .query("walletTransactions")
      .withIndex("by_wallet", (q) => q.eq("walletId", wallet._id))
      .collect();

    const thisMonthTransactions = allTransactions.filter((t) => t.createdAt >= monthStart && t.status === "completed");

    const thisMonthEarnings = thisMonthTransactions
      .filter((t) => t.type === "credit" && t.source === "sale")
      .reduce((sum, t) => sum + t.amount, 0);

    const thisMonthWithdrawals = thisMonthTransactions
      .filter((t) => t.type === "debit" && (t.source === "withdrawal_mobile_money" || t.source === "withdrawal_bank"))
      .reduce((sum, t) => sum + t.amount, 0);

    const pendingWithdrawals = allTransactions
      .filter(
        (t) =>
          t.type === "debit" &&
          (t.source === "withdrawal_mobile_money" || t.source === "withdrawal_bank") &&
          t.status === "pending"
      )
      .reduce((sum, t) => sum + t.amount, 0);

    return {
      recentTransactions,
      pendingWithdrawals,
      thisMonthEarnings,
      thisMonthWithdrawals,
    };
  },
});

// ============================================================================
// MUTATIONS
// ============================================================================

// Create wallet for user (called when user first needs a wallet)
export const createWallet = mutation({
  args: {},
  handler: async (ctx) => {
    const actor = await requireUser(ctx);
    // Check if wallet already exists
    const existingWallet = await ctx.db
      .query("wallets")
      .withIndex("by_user", (q) => q.eq("userId", actor._id))
      .first();

    if (existingWallet) {
      return existingWallet._id;
    }

    // Create new wallet
    const walletId = await ctx.db.insert("wallets", {
      userId: actor._id,
      balance: 0,
      pendingBalance: 0,
      totalEarned: 0,
      totalWithdrawn: 0,
      totalSpent: 0,
      isActive: true,
      isFrozen: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    return walletId;
  },
});

// Credit wallet (add funds - from sales, top-ups, refunds)
export const creditWallet = internalMutation({
  args: {
    userId: v.id("users"),
    amount: v.number(),
    source: v.union(
      v.literal("sale"),
      v.literal("top_up_mobile_money"),
      v.literal("top_up_card"),
      v.literal("top_up_bank"),
      v.literal("refund"),
      v.literal("withdrawal_reversal"),
      v.literal("admin_adjustment"),
      v.literal("escrow_release")
    ),
    description: v.string(),
    orderId: v.optional(v.id("orders")),
    escrowId: v.optional(v.id("escrow")),
    externalReference: v.optional(v.string()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    if (args.amount <= 0) {
      throw new Error("Credit amount must be positive");
    }

    // Get or create wallet
    let wallet = await ctx.db
      .query("wallets")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .first();

    if (!wallet) {
      const walletId = await ctx.db.insert("wallets", {
        userId: args.userId,
        balance: 0,
        pendingBalance: 0,
        totalEarned: 0,
        totalWithdrawn: 0,
        totalSpent: 0,
        isActive: true,
        isFrozen: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      wallet = await ctx.db.get(walletId);
      if (!wallet) {
        throw new Error("Failed to create wallet");
      }
    }

    if (wallet.isFrozen) {
      throw new Error("Wallet is frozen");
    }

    const newBalance = wallet.balance + args.amount;
    const now = Date.now();
    const reference = generateWalletReference();

    // Update wallet balance
    await ctx.db.patch(wallet._id, {
      balance: newBalance,
      totalEarned:
        args.source === "sale" || args.source === "escrow_release"
          ? wallet.totalEarned + args.amount
          : wallet.totalEarned,
      lastTransactionAt: now,
      updatedAt: now,
    });

    // Create transaction record
    const transactionId = await ctx.db.insert("walletTransactions", {
      walletId: wallet._id,
      userId: args.userId,
      type: "credit",
      source: args.source,
      amount: args.amount,
      balanceAfter: newBalance,
      orderId: args.orderId,
      escrowId: args.escrowId,
      reference,
      externalReference: args.externalReference,
      status: "completed",
      description: args.description,
      metadata: args.metadata,
      createdAt: now,
      completedAt: now,
      updatedAt: now,
    });

    // Send notification
    await ctx.db.insert("notifications", {
      userId: args.userId,
      type: "wallet_credit",
      title: "Funds Added",
      message: `K${args.amount.toLocaleString()} has been added to your wallet. ${args.description}`,
      data: { transactionId, walletId: wallet._id },
      isRead: false,
      createdAt: now,
    });

    return { transactionId, reference, newBalance };
  },
});

// Debit wallet (remove funds - for purchases, withdrawals)
export const debitWallet = internalMutation({
  args: {
    userId: v.id("users"),
    amount: v.number(),
    source: v.union(
      v.literal("purchase"),
      v.literal("withdrawal_mobile_money"),
      v.literal("withdrawal_bank"),
      v.literal("admin_adjustment")
    ),
    description: v.string(),
    orderId: v.optional(v.id("orders")),
    paymentAccountId: v.optional(v.id("paymentAccounts")),
    externalReference: v.optional(v.string()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    if (args.amount <= 0) {
      throw new Error("Debit amount must be positive");
    }

    const wallet = await ctx.db
      .query("wallets")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .first();

    if (!wallet) {
      throw new Error("Wallet not found");
    }

    if (wallet.isFrozen) {
      throw new Error("Wallet is frozen");
    }

    if (wallet.balance < args.amount) {
      throw new Error("Insufficient wallet balance");
    }

    const newBalance = wallet.balance - args.amount;
    const now = Date.now();
    const reference = generateWalletReference();

    // Determine if this is a withdrawal (pending) or immediate debit (completed)
    const isWithdrawal = args.source === "withdrawal_mobile_money" || args.source === "withdrawal_bank";
    const status = isWithdrawal ? "pending" : "completed";

    // Update wallet balance
    await ctx.db.patch(wallet._id, {
      balance: newBalance,
      totalWithdrawn: isWithdrawal ? wallet.totalWithdrawn + args.amount : wallet.totalWithdrawn,
      totalSpent: args.source === "purchase" ? wallet.totalSpent + args.amount : wallet.totalSpent,
      lastTransactionAt: now,
      updatedAt: now,
    });

    // Create transaction record
    const transactionId = await ctx.db.insert("walletTransactions", {
      walletId: wallet._id,
      userId: args.userId,
      type: "debit",
      source: args.source,
      amount: args.amount,
      balanceAfter: newBalance,
      orderId: args.orderId,
      paymentAccountId: args.paymentAccountId,
      reference,
      externalReference: args.externalReference,
      status,
      description: args.description,
      metadata: args.metadata,
      createdAt: now,
      completedAt: status === "completed" ? now : undefined,
      updatedAt: now,
    });

    // Send notification
    const notificationType = isWithdrawal ? "withdrawal_initiated" : "wallet_debit";
    const notificationTitle = isWithdrawal ? "Withdrawal Initiated" : "Payment Made";

    await ctx.db.insert("notifications", {
      userId: args.userId,
      type: notificationType,
      title: notificationTitle,
      message: isWithdrawal
        ? `Your withdrawal of K${args.amount.toLocaleString()} is being processed.`
        : `K${args.amount.toLocaleString()} has been deducted from your wallet. ${args.description}`,
      data: { transactionId, walletId: wallet._id },
      isRead: false,
      createdAt: now,
    });

    return { transactionId, reference, newBalance, status };
  },
});

// Update withdrawal status (called by webhook or admin)
export const updateWithdrawalStatus = internalMutation({
  args: {
    reference: v.string(),
    status: v.union(v.literal("completed"), v.literal("failed"), v.literal("cancelled")),
    externalReference: v.optional(v.string()),
    failureReason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const transaction = await ctx.db
      .query("walletTransactions")
      .withIndex("by_reference", (q) => q.eq("reference", args.reference))
      .first();

    if (!transaction) {
      throw new Error("Transaction not found");
    }

    if (transaction.status !== "pending") {
      throw new Error("Transaction is not pending");
    }

    const now = Date.now();

    // Update transaction status
    await ctx.db.patch(transaction._id, {
      status: args.status,
      externalReference: args.externalReference || transaction.externalReference,
      failureReason: args.failureReason,
      completedAt: args.status === "completed" ? now : undefined,
      updatedAt: now,
    });

    // If failed or cancelled, reverse the debit (add funds back)
    if (args.status === "failed" || args.status === "cancelled") {
      const wallet = await ctx.db.get(transaction.walletId);
      if (wallet) {
        const newBalance = wallet.balance + transaction.amount;

        await ctx.db.patch(wallet._id, {
          balance: newBalance,
          totalWithdrawn: wallet.totalWithdrawn - transaction.amount,
          updatedAt: now,
        });

        // Create reversal transaction
        await ctx.db.insert("walletTransactions", {
          walletId: wallet._id,
          userId: transaction.userId,
          type: "credit",
          source: "withdrawal_reversal",
          amount: transaction.amount,
          balanceAfter: newBalance,
          reference: generateWalletReference(),
          status: "completed",
          description: `Withdrawal reversed: ${args.failureReason || "Transaction failed"}`,
          metadata: { originalTransactionId: transaction._id },
          createdAt: now,
          completedAt: now,
          updatedAt: now,
        });

        // Notify user
        await ctx.db.insert("notifications", {
          userId: transaction.userId,
          type: "withdrawal_failed",
          title: "Withdrawal Failed",
          message: `Your withdrawal of K${transaction.amount.toLocaleString()} failed. ${args.failureReason || "Please try again."}. The funds have been returned to your wallet.`,
          data: { transactionId: transaction._id },
          isRead: false,
          createdAt: now,
        });
      }
    } else if (args.status === "completed") {
      // Notify user of successful withdrawal
      await ctx.db.insert("notifications", {
        userId: transaction.userId,
        type: "withdrawal_completed",
        title: "Withdrawal Successful",
        message: `Your withdrawal of K${transaction.amount.toLocaleString()} has been completed.`,
        data: { transactionId: transaction._id },
        isRead: false,
        createdAt: now,
      });
    }

    return { success: true };
  },
});

// Update wallet transaction external reference (for Lenco ID tracking)
export const updateTransactionExternalReference = internalMutation({
  args: {
    reference: v.string(),
    externalReference: v.string(),
  },
  handler: async (ctx, args) => {
    const transaction = await ctx.db
      .query("walletTransactions")
      .withIndex("by_reference", (q) => q.eq("reference", args.reference))
      .first();

    if (!transaction) {
      throw new Error("Transaction not found");
    }

    // Update only the external reference, keeping the status as-is
    await ctx.db.patch(transaction._id, {
      externalReference: args.externalReference,
      updatedAt: Date.now(),
    });

    return { success: true };
  },
});

// Update wallet transaction status by external reference (Lenco ID) - for webhooks
export const updateWalletTransactionByLencoId = internalMutation({
  args: {
    lencoId: v.string(),
    reference: v.optional(v.string()), // Fallback lookup
    status: v.union(v.literal("completed"), v.literal("failed"), v.literal("cancelled")),
    failureReason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Try to find by Lenco ID (external reference) first
    let transaction = await ctx.db
      .query("walletTransactions")
      .filter((q) => q.eq(q.field("externalReference"), args.lencoId))
      .first();

    // Fallback: try to find by reference
    if (!transaction && args.reference) {
      const ref = args.reference;
      console.log(`🔍 Wallet transaction not found by Lenco ID, trying reference: ${ref}`);
      transaction = await ctx.db
        .query("walletTransactions")
        .withIndex("by_reference", (q) => q.eq("reference", ref))
        .first();

      // If found by reference, update the externalReference
      if (transaction) {
        await ctx.db.patch(transaction._id, {
          externalReference: args.lencoId,
        });
      }
    }

    if (!transaction) {
      console.error(`❌ Wallet transaction not found for Lenco ID: ${args.lencoId}, reference: ${args.reference}`);
      throw new Error(`Wallet transaction not found for webhook - lencoId: ${args.lencoId}, ref: ${args.reference}`);
    }

    console.log(`✅ Found wallet transaction: ${transaction.reference} (${transaction._id})`);

    const now = Date.now();

    // Update transaction status
    await ctx.db.patch(transaction._id, {
      status: args.status,
      failureReason: args.failureReason,
      completedAt: args.status === "completed" ? now : undefined,
      updatedAt: now,
    });

    // If failed or cancelled, reverse the debit (add funds back)
    if (args.status === "failed" || args.status === "cancelled") {
      const wallet = await ctx.db.get(transaction.walletId);
      if (wallet) {
        const newBalance = wallet.balance + transaction.amount;

        await ctx.db.patch(wallet._id, {
          balance: newBalance,
          totalWithdrawn: wallet.totalWithdrawn - transaction.amount,
          updatedAt: now,
        });

        // Create reversal transaction
        await ctx.db.insert("walletTransactions", {
          walletId: wallet._id,
          userId: transaction.userId,
          type: "credit",
          source: "withdrawal_reversal",
          amount: transaction.amount,
          balanceAfter: newBalance,
          reference: generateWalletReference(),
          status: "completed",
          description: `Withdrawal reversed: ${args.failureReason || "Transfer failed"}`,
          metadata: { originalTransactionId: transaction._id },
          createdAt: now,
          completedAt: now,
          updatedAt: now,
        });

        // Notify user of reversal
        await ctx.db.insert("notifications", {
          userId: transaction.userId,
          type: "withdrawal_failed",
          title: "Withdrawal Failed",
          message: `Your withdrawal of K${transaction.amount.toLocaleString()} failed. ${args.failureReason || "Please try again."}. The funds have been returned to your wallet.`,
          data: { transactionId: transaction._id },
          isRead: false,
          createdAt: now,
        });
      }
    } else if (args.status === "completed") {
      // Notify user of successful withdrawal
      await ctx.db.insert("notifications", {
        userId: transaction.userId,
        type: "withdrawal_completed",
        title: "Withdrawal Successful",
        message: `Your withdrawal of K${transaction.amount.toLocaleString()} has been completed.`,
        data: { transactionId: transaction._id },
        isRead: false,
        createdAt: now,
      });
    }

    return { success: true, transaction: transaction.reference };
  },
});

// Check if user can pay with wallet
export const canPayWithWallet = query({
  args: {
    amount: v.number(),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const wallet = await ctx.db
      .query("wallets")
      .withIndex("by_user", (q) => q.eq("userId", actor._id))
      .first();

    if (!wallet) {
      return { canPay: false, reason: "No wallet found" };
    }

    if (wallet.isFrozen) {
      return { canPay: false, reason: "Wallet is frozen" };
    }

    if (!wallet.isActive) {
      return { canPay: false, reason: "Wallet is inactive" };
    }

    if (wallet.balance < args.amount) {
      return {
        canPay: false,
        reason: "Insufficient balance",
        currentBalance: wallet.balance,
        shortfall: args.amount - wallet.balance,
      };
    }

    return {
      canPay: true,
      currentBalance: wallet.balance,
      balanceAfterPayment: wallet.balance - args.amount,
    };
  },
});

// Get wallet transaction by reference
export const getTransactionByReference = query({
  args: { reference: v.string() },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const transaction = await ctx.db
      .query("walletTransactions")
      .withIndex("by_reference", (q) => q.eq("reference", args.reference))
      .first();

    if (!transaction) {
      return null;
    }

    if (actor.role !== "admin") {
      const wallet = await ctx.db.get(transaction.walletId);

      if (transaction.userId !== actor._id || wallet?.userId !== actor._id) {
        throw new Error("Unauthorized");
      }
    }

    return transaction;
  },
});

// Admin: Freeze wallet. Admin-only on the server, matching the admin UI. The acting admin comes from the verified token.
export const freezeWallet = mutation({
  args: {
    walletId: v.id("wallets"),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    await requireRole(ctx, ["admin"]);

    const wallet = await ctx.db.get(args.walletId);
    if (!wallet) {
      throw new Error("Wallet not found");
    }

    await ctx.db.patch(args.walletId, {
      isFrozen: true,
      freezeReason: args.reason,
      updatedAt: Date.now(),
    });

    // Notify user
    await ctx.db.insert("notifications", {
      userId: wallet.userId,
      type: "system",
      title: "Wallet Frozen",
      message: `Your wallet has been frozen. Reason: ${args.reason}. Please contact support for assistance.`,
      data: { walletId: wallet._id },
      isRead: false,
      createdAt: Date.now(),
    });

    return { success: true };
  },
});

// Admin: Unfreeze wallet. Admin-only on the server, matching the admin UI. The acting admin comes from the verified token.
export const unfreezeWallet = mutation({
  args: {
    walletId: v.id("wallets"),
  },
  handler: async (ctx, args) => {
    await requireRole(ctx, ["admin"]);

    const wallet = await ctx.db.get(args.walletId);
    if (!wallet) {
      throw new Error("Wallet not found");
    }

    await ctx.db.patch(args.walletId, {
      isFrozen: false,
      freezeReason: undefined,
      updatedAt: Date.now(),
    });

    // Notify user
    await ctx.db.insert("notifications", {
      userId: wallet.userId,
      type: "system",
      title: "Wallet Unfrozen",
      message: "Your wallet has been unfrozen. You can now use it normally.",
      data: { walletId: wallet._id },
      isRead: false,
      createdAt: Date.now(),
    });

    return { success: true };
  },
});

// Get or create wallet (ensures wallet exists)
export const ensureWallet = mutation({
  args: {},
  handler: async (ctx) => {
    const actor = await requireUser(ctx);
    let wallet = await ctx.db
      .query("wallets")
      .withIndex("by_user", (q) => q.eq("userId", actor._id))
      .first();

    if (!wallet) {
      const walletId = await ctx.db.insert("wallets", {
        userId: actor._id,
        balance: 0,
        pendingBalance: 0,
        totalEarned: 0,
        totalWithdrawn: 0,
        totalSpent: 0,
        isActive: true,
        isFrozen: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      wallet = await ctx.db.get(walletId);
    }

    return wallet;
  },
});
