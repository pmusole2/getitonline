import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";

function getTier(lifetimeEarned: number) {
  if (lifetimeEarned >= 50000) return "platinum";
  if (lifetimeEarned >= 20000) return "gold";
  if (lifetimeEarned >= 5000) return "silver";
  return "bronze";
}

async function getOrCreateAccount(ctx: MutationCtx, userId: Id<"users">) {
  const existing = await ctx.db
    .query("loyaltyAccounts")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();

  if (existing) {
    return existing;
  }

  const now = Date.now();
  const accountId = await ctx.db.insert("loyaltyAccounts", {
    userId,
    pointsBalance: 0,
    lifetimeEarned: 0,
    lifetimeRedeemed: 0,
    tier: "bronze",
    createdAt: now,
    updatedAt: now,
  });

  const account = await ctx.db.get(accountId);
  if (!account) {
    throw new Error("Unable to create loyalty account");
  }
  return account;
}

export const getMyLoyaltyAccount = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("loyaltyAccounts")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .first();
  },
});

export const getLoyaltyTransactions = query({
  args: {
    userId: v.id("users"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("loyaltyTransactions")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .order("desc")
      .take(args.limit ?? 50);
  },
});

export const awardPoints = mutation({
  args: {
    userId: v.id("users"),
    points: v.number(),
    reason: v.string(),
    orderId: v.optional(v.id("orders")),
  },
  handler: async (ctx, args) => {
    if (args.points <= 0) {
      throw new Error("Points must be positive");
    }

    const account = await getOrCreateAccount(ctx, args.userId);
    const nextLifetimeEarned = account.lifetimeEarned + args.points;
    const nextBalance = account.pointsBalance + args.points;

    await ctx.db.patch(account._id, {
      pointsBalance: nextBalance,
      lifetimeEarned: nextLifetimeEarned,
      tier: getTier(nextLifetimeEarned),
      updatedAt: Date.now(),
    });

    return await ctx.db.insert("loyaltyTransactions", {
      accountId: account._id,
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
    userId: v.id("users"),
    points: v.number(),
    reason: v.string(),
    orderId: v.optional(v.id("orders")),
  },
  handler: async (ctx, args) => {
    if (args.points <= 0) {
      throw new Error("Points must be positive");
    }

    const account = await getOrCreateAccount(ctx, args.userId);
    if (account.pointsBalance < args.points) {
      throw new Error("Insufficient loyalty points");
    }

    await ctx.db.patch(account._id, {
      pointsBalance: account.pointsBalance - args.points,
      lifetimeRedeemed: account.lifetimeRedeemed + args.points,
      updatedAt: Date.now(),
    });

    return await ctx.db.insert("loyaltyTransactions", {
      accountId: account._id,
      userId: args.userId,
      type: "redeem",
      points: args.points,
      orderId: args.orderId,
      reason: args.reason,
      createdAt: Date.now(),
    });
  },
});
