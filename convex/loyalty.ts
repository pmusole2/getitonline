import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { requireUser } from "./lib/auth";

function getTier(lifetimeEarned: number) {
  if (lifetimeEarned >= 50000) {
    return "platinum";
  }
  if (lifetimeEarned >= 20000) {
    return "gold";
  }
  if (lifetimeEarned >= 5000) {
    return "silver";
  }
  return "bronze";
}

// Amounts are whole points, so a request must be a safe integer of at least 1. NaN, Infinity, fractions, zero, and
// negatives are refused before any account is read.
function assertPositivePoints(points: number) {
  if (!Number.isSafeInteger(points) || points < 1) {
    throw new Error("Points must be a positive whole number");
  }
}

// A stored total is trusted only when it is a non-negative safe integer, because it is used as arithmetic operand. A
// fraction or a value past 2**53 would make the result wrong. A corrupt account is refused, not carried forward.
function assertSoundAccount(
  account: Doc<"loyaltyAccounts">,
  fields: Array<"pointsBalance" | "lifetimeEarned" | "lifetimeRedeemed">
) {
  for (const field of fields) {
    const amount = account[field];
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new Error("Loyalty account is corrupt and cannot be changed");
    }
  }
}

// A total past the largest safe integer can no longer be told apart from its neighbours, so it is refused.
function assertWithinLimit(total: number) {
  if (!Number.isFinite(total) || total > Number.MAX_SAFE_INTEGER) {
    throw new Error("Loyalty points total would exceed the largest supported amount");
  }
}

async function findAccount(ctx: MutationCtx, userId: Id<"users">) {
  return await ctx.db
    .query("loyaltyAccounts")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
}

async function createAccount(ctx: MutationCtx, userId: Id<"users">) {
  const now = Date.now();
  return await ctx.db.insert("loyaltyAccounts", {
    userId,
    pointsBalance: 0,
    lifetimeEarned: 0,
    lifetimeRedeemed: 0,
    tier: "bronze",
    createdAt: now,
    updatedAt: now,
  });
}

export const getMyLoyaltyAccount = query({
  args: {},
  handler: async (ctx) => {
    const actor = await requireUser(ctx);

    return await ctx.db
      .query("loyaltyAccounts")
      .withIndex("by_user", (q) => q.eq("userId", actor._id))
      .first();
  },
});

export const getLoyaltyTransactions = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const limit = args.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new Error("Limit must be a whole number of zero or more");
    }

    return await ctx.db
      .query("loyaltyTransactions")
      .withIndex("by_user", (q) => q.eq("userId", actor._id))
      .order("desc")
      .take(limit);
  },
});

export const awardPoints = internalMutation({
  args: {
    userId: v.id("users"),
    points: v.number(),
    reason: v.string(),
    orderId: v.optional(v.id("orders")),
  },
  handler: async (ctx, args) => {
    assertPositivePoints(args.points);

    // Every check runs before the account is created or patched, because a refused call must write nothing.
    const existing = await findAccount(ctx, args.userId);
    if (existing) {
      assertSoundAccount(existing, ["pointsBalance", "lifetimeEarned"]);
    }
    const nextLifetimeEarned = (existing?.lifetimeEarned ?? 0) + args.points;
    const nextBalance = (existing?.pointsBalance ?? 0) + args.points;
    assertWithinLimit(nextLifetimeEarned);
    assertWithinLimit(nextBalance);

    const accountId = existing?._id ?? (await createAccount(ctx, args.userId));
    await ctx.db.patch(accountId, {
      pointsBalance: nextBalance,
      lifetimeEarned: nextLifetimeEarned,
      tier: getTier(nextLifetimeEarned),
      updatedAt: Date.now(),
    });

    return await ctx.db.insert("loyaltyTransactions", {
      accountId,
      userId: args.userId,
      type: "earn",
      points: args.points,
      orderId: args.orderId,
      reason: args.reason,
      createdAt: Date.now(),
    });
  },
});

export const redeemPoints = mutation({
  args: {
    points: v.number(),
    reason: v.string(),
    orderId: v.optional(v.id("orders")),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    assertPositivePoints(args.points);

    // A redemption can only name an order the signed-in account bought. Checked before any account or ledger write.
    if (args.orderId !== undefined) {
      const order = await ctx.db.get(args.orderId);
      if (!order) {
        throw new Error("Order not found");
      }
      if (order.buyerId !== user._id) {
        throw new Error("Unauthorized");
      }
    }

    // Read only. A user without an account has no points, so the refusal below creates no account row.
    const account = await findAccount(ctx, user._id);
    if (!account) {
      throw new Error("Insufficient loyalty points");
    }
    assertSoundAccount(account, ["pointsBalance", "lifetimeRedeemed"]);
    if (account.pointsBalance < args.points) {
      throw new Error("Insufficient loyalty points");
    }
    const nextLifetimeRedeemed = account.lifetimeRedeemed + args.points;
    assertWithinLimit(nextLifetimeRedeemed);

    await ctx.db.patch(account._id, {
      pointsBalance: account.pointsBalance - args.points,
      lifetimeRedeemed: nextLifetimeRedeemed,
      updatedAt: Date.now(),
    });

    return await ctx.db.insert("loyaltyTransactions", {
      accountId: account._id,
      userId: user._id,
      type: "redeem",
      points: args.points,
      orderId: args.orderId,
      reason: args.reason,
      createdAt: Date.now(),
    });
  },
});
