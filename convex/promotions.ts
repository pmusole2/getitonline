import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";

async function ensureAdmin(ctx: QueryCtx | MutationCtx, userId: Id<"users">) {
  const user = await ctx.db.get(userId);
  if (!user || user.role !== "admin") {
    throw new Error("Unauthorized: Only admins can manage promotions");
  }
  return user;
}

function isWithinWindow(
  startsAt: number,
  endsAt: number | undefined,
  now: number
) {
  return startsAt <= now && (endsAt === undefined || endsAt >= now);
}

function normalizeExternalUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("URL is required");
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const parsed = new URL(withProtocol);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("URL must start with http:// or https://");
  }
  return parsed.toString();
}

function safeNormalizeExternalUrl(value: string) {
  try {
    return normalizeExternalUrl(value);
  } catch {
    return value.trim();
  }
}

function calculateDiscount(
  discountType: "percent" | "fixed_amount",
  discountValue: number,
  subtotal: number,
  maxDiscount?: number
) {
  const rawDiscount =
    discountType === "percent"
      ? subtotal * (discountValue / 100)
      : discountValue;
  const cappedDiscount =
    maxDiscount === undefined ? rawDiscount : Math.min(rawDiscount, maxDiscount);
  return Math.max(0, Math.min(subtotal, cappedDiscount));
}

export const listActiveBanners = query({
  args: {
    placement: v.optional(
      v.union(
        v.literal("home_hero"),
        v.literal("home_monthly"),
        v.literal("home_strip"),
        v.literal("category"),
        v.literal("pdp")
      )
    ),
    categoryId: v.optional(v.id("categories")),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const banners = await ctx.db
      .query("promotionBanners")
      .withIndex("by_active", (q) => q.eq("isActive", true))
      .collect();

    return banners
      .filter((banner) => {
        if (!isWithinWindow(banner.startsAt, banner.endsAt, now)) return false;
        if (args.placement && banner.placement !== args.placement) return false;
        if (args.categoryId && banner.categoryId !== args.categoryId) return false;
        return true;
      })
      .map((banner) => ({
        ...banner,
        imageUrl: safeNormalizeExternalUrl(banner.imageUrl),
      }))
      .sort((left, right) => left.sortOrder - right.sortOrder);
  },
});

export const listPromotionBannersForAdmin = query({
  args: { adminId: v.id("users") },
  handler: async (ctx, args) => {
    await ensureAdmin(ctx, args.adminId);
    return (await ctx.db.query("promotionBanners").collect())
      .map((banner) => ({
        ...banner,
        imageUrl: safeNormalizeExternalUrl(banner.imageUrl),
      }))
      .sort((left, right) => right.createdAt - left.createdAt);
  },
});

export const listActivePromotions = query({
  args: {
    type: v.optional(
      v.union(
        v.literal("deal_of_day"),
        v.literal("flash_sale"),
        v.literal("weekend_sale"),
        v.literal("sponsored_product"),
        v.literal("seller_campaign")
      )
    ),
    sellerId: v.optional(v.id("users")),
    categoryId: v.optional(v.id("categories")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const limit = args.limit ?? 20;
    const promotions = await ctx.db
      .query("promotions")
      .withIndex("by_active", (q) => q.eq("isActive", true))
      .collect();

    return promotions
      .filter((promotion) => {
        if (!isWithinWindow(promotion.startsAt, promotion.endsAt, now)) return false;
        if (args.type && promotion.type !== args.type) return false;
        if (args.sellerId && promotion.sellerId !== args.sellerId) return false;
        if (args.categoryId && promotion.categoryId !== args.categoryId) return false;
        return true;
      })
      .sort((left, right) => right.priority - left.priority)
      .slice(0, limit);
  },
});

export const listPromotionsForAdmin = query({
  args: { adminId: v.id("users") },
  handler: async (ctx, args) => {
    await ensureAdmin(ctx, args.adminId);
    return (await ctx.db.query("promotions").collect()).sort(
      (left, right) => right.createdAt - left.createdAt
    );
  },
});

export const listPromoCodesForAdmin = query({
  args: { adminId: v.id("users") },
  handler: async (ctx, args) => {
    await ensureAdmin(ctx, args.adminId);
    return (await ctx.db.query("promoCodes").collect()).sort(
      (left, right) => right.createdAt - left.createdAt
    );
  },
});

export const validatePromoCode = query({
  args: {
    code: v.string(),
    userId: v.optional(v.id("users")),
    subtotal: v.number(),
    sellerId: v.optional(v.id("users")),
    categoryIds: v.optional(v.array(v.id("categories"))),
    productIds: v.optional(v.array(v.id("products"))),
  },
  handler: async (ctx, args) => {
    const normalizedCode = args.code.trim().toUpperCase();
    const promoCode = await ctx.db
      .query("promoCodes")
      .withIndex("by_code", (q) => q.eq("code", normalizedCode))
      .first();

    if (!promoCode || !promoCode.isActive) {
      return { valid: false, reason: "Promo code not found" };
    }

    const now = Date.now();
    if (!isWithinWindow(promoCode.startsAt, promoCode.endsAt, now)) {
      return { valid: false, reason: "Promo code is not active" };
    }

    if (
      promoCode.minimumSubtotal !== undefined &&
      args.subtotal < promoCode.minimumSubtotal
    ) {
      return { valid: false, reason: "Order subtotal is below the promo minimum" };
    }

    if (promoCode.scope === "seller" && promoCode.sellerId !== args.sellerId) {
      return { valid: false, reason: "Promo code does not apply to this seller" };
    }

    if (
      promoCode.scope === "category" &&
      (!promoCode.categoryId ||
        !(args.categoryIds ?? []).includes(promoCode.categoryId))
    ) {
      return { valid: false, reason: "Promo code does not apply to these categories" };
    }

    if (
      promoCode.scope === "product" &&
      (!promoCode.productId || !(args.productIds ?? []).includes(promoCode.productId))
    ) {
      return { valid: false, reason: "Promo code does not apply to these products" };
    }

    const redemptions = await ctx.db
      .query("promoCodeRedemptions")
      .withIndex("by_promo_code", (q) => q.eq("promoCodeId", promoCode._id))
      .collect();

    if (
      promoCode.usageLimit !== undefined &&
      redemptions.length >= promoCode.usageLimit
    ) {
      return { valid: false, reason: "Promo code usage limit reached" };
    }

    if (args.userId && promoCode.perUserLimit !== undefined) {
      const userRedemptions = redemptions.filter(
        (redemption) => redemption.userId === args.userId
      );
      if (userRedemptions.length >= promoCode.perUserLimit) {
        return { valid: false, reason: "Promo code already used" };
      }
    }

    const discountAmount = calculateDiscount(
      promoCode.discountType,
      promoCode.discountValue,
      args.subtotal,
      promoCode.maxDiscount
    );

    return {
      valid: true,
      promoCodeId: promoCode._id,
      code: promoCode.code,
      title: promoCode.title,
      discountAmount,
      totalAfterDiscount: Math.max(0, args.subtotal - discountAmount),
    };
  },
});

export const upsertPromotionBanner = mutation({
  args: {
    adminId: v.id("users"),
    bannerId: v.optional(v.id("promotionBanners")),
    title: v.string(),
    subtitle: v.optional(v.string()),
    imageUrl: v.string(),
    targetUrl: v.optional(v.string()),
    placement: v.union(
      v.literal("home_hero"),
      v.literal("home_monthly"),
      v.literal("home_strip"),
      v.literal("category"),
      v.literal("pdp")
    ),
    categoryId: v.optional(v.id("categories")),
    startsAt: v.number(),
    endsAt: v.optional(v.number()),
    isActive: v.boolean(),
    sortOrder: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ensureAdmin(ctx, args.adminId);
    const now = Date.now();
    const { adminId, bannerId, ...bannerInput } = args;
    const normalizedBannerInput = {
      ...bannerInput,
      imageUrl: normalizeExternalUrl(bannerInput.imageUrl),
    };

    if (bannerId) {
      await ctx.db.patch(bannerId, {
        ...normalizedBannerInput,
        sortOrder: normalizedBannerInput.sortOrder ?? 0,
        updatedAt: now,
      });
      return await ctx.db.get(bannerId);
    }

    return await ctx.db.insert("promotionBanners", {
      ...normalizedBannerInput,
      sortOrder: normalizedBannerInput.sortOrder ?? 0,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const upsertPromotion = mutation({
  args: {
    adminId: v.id("users"),
    promotionId: v.optional(v.id("promotions")),
    name: v.string(),
    type: v.union(
      v.literal("deal_of_day"),
      v.literal("flash_sale"),
      v.literal("weekend_sale"),
      v.literal("sponsored_product"),
      v.literal("seller_campaign")
    ),
    sellerId: v.optional(v.id("users")),
    categoryId: v.optional(v.id("categories")),
    productIds: v.array(v.id("products")),
    discountType: v.union(
      v.literal("percent"),
      v.literal("fixed_amount"),
      v.literal("compare_at")
    ),
    discountValue: v.optional(v.number()),
    startsAt: v.number(),
    endsAt: v.optional(v.number()),
    isActive: v.boolean(),
    priority: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ensureAdmin(ctx, args.adminId);
    const now = Date.now();
    const { adminId, promotionId, ...promotionInput } = args;

    if (promotionId) {
      await ctx.db.patch(promotionId, {
        ...promotionInput,
        priority: promotionInput.priority ?? 0,
        updatedAt: now,
      });
      return await ctx.db.get(promotionId);
    }

    return await ctx.db.insert("promotions", {
      ...promotionInput,
      priority: promotionInput.priority ?? 0,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const upsertPromoCode = mutation({
  args: {
    adminId: v.id("users"),
    promoCodeId: v.optional(v.id("promoCodes")),
    code: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    scope: v.union(
      v.literal("platform"),
      v.literal("seller"),
      v.literal("category"),
      v.literal("product")
    ),
    sellerId: v.optional(v.id("users")),
    categoryId: v.optional(v.id("categories")),
    productId: v.optional(v.id("products")),
    discountType: v.union(v.literal("percent"), v.literal("fixed_amount")),
    discountValue: v.number(),
    minimumSubtotal: v.optional(v.number()),
    maxDiscount: v.optional(v.number()),
    usageLimit: v.optional(v.number()),
    perUserLimit: v.optional(v.number()),
    startsAt: v.number(),
    endsAt: v.optional(v.number()),
    isActive: v.boolean(),
  },
  handler: async (ctx, args) => {
    await ensureAdmin(ctx, args.adminId);
    const now = Date.now();
    const { adminId, promoCodeId, code, ...promoInput } = args;
    const normalizedCode = code.trim().toUpperCase();

    if (promoCodeId) {
      await ctx.db.patch(promoCodeId, {
        ...promoInput,
        code: normalizedCode,
        updatedAt: now,
      });
      return await ctx.db.get(promoCodeId);
    }

    return await ctx.db.insert("promoCodes", {
      ...promoInput,
      code: normalizedCode,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const recordPromoCodeRedemption = mutation({
  args: {
    promoCodeId: v.id("promoCodes"),
    userId: v.id("users"),
    orderId: v.optional(v.id("orders")),
    discountAmount: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("promoCodeRedemptions", {
      promoCodeId: args.promoCodeId,
      userId: args.userId,
      orderId: args.orderId,
      discountAmount: args.discountAmount,
      redeemedAt: Date.now(),
    });
  },
});
