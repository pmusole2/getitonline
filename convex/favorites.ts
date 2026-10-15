import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { requireUser } from "./lib/auth";
import { canViewerSeeProduct } from "./products";

// Add product to favorites
export const addFavorite = mutation({
  args: {
    productId: v.id("products"),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    // Check if product exists
    const product = await ctx.db.get(args.productId);
    if (!product || !(await canViewerSeeProduct(ctx, product, actor))) {
      throw new Error("Product not found");
    }

    // Check if already favorited
    const existing = await ctx.db
      .query("favorites")
      .withIndex("by_user_product", (q) => q.eq("userId", actor._id).eq("productId", args.productId))
      .first();

    if (existing) {
      return existing._id; // Already favorited
    }

    return await ctx.db.insert("favorites", {
      userId: actor._id,
      productId: args.productId,
      createdAt: Date.now(),
    });
  },
});

// Remove product from favorites
export const removeFavorite = mutation({
  args: {
    productId: v.id("products"),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const favorite = await ctx.db
      .query("favorites")
      .withIndex("by_user_product", (q) => q.eq("userId", actor._id).eq("productId", args.productId))
      .first();

    if (favorite) {
      await ctx.db.delete(favorite._id);
    }
  },
});

// Toggle favorite
export const toggleFavorite = mutation({
  args: {
    productId: v.id("products"),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const existing = await ctx.db
      .query("favorites")
      .withIndex("by_user_product", (q) => q.eq("userId", actor._id).eq("productId", args.productId))
      .first();

    if (existing) {
      await ctx.db.delete(existing._id);
      return { isFavorited: false };
    }

    const product = await ctx.db.get(args.productId);
    if (!product || !(await canViewerSeeProduct(ctx, product, actor))) {
      throw new Error("Product not found");
    }

    await ctx.db.insert("favorites", {
      userId: actor._id,
      productId: args.productId,
      createdAt: Date.now(),
    });

    return { isFavorited: true };
  },
});

// Check if product is favorited
export const isFavorited = query({
  args: {
    productId: v.id("products"),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const favorite = await ctx.db
      .query("favorites")
      .withIndex("by_user_product", (q) => q.eq("userId", actor._id).eq("productId", args.productId))
      .first();

    return !!favorite;
  },
});

// Get user's favorites with product details
export const getUserFavorites = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const limit = args.limit ?? 20;

    const favorites = await ctx.db
      .query("favorites")
      .withIndex("by_user", (q) => q.eq("userId", actor._id))
      .order("desc")
      .take(limit);

    const favoritesWithProducts = await Promise.all(
      favorites.map(async (fav) => {
        const product = await ctx.db.get(fav.productId);
        if (!product) {
          return null;
        }

        // The row stays so the user can still remove it; the product fields are withheld.
        if (!(await canViewerSeeProduct(ctx, product, actor))) {
          return { ...fav, product: null };
        }

        const seller = await ctx.db.get(product.sellerId);

        return {
          ...fav,
          product: {
            _id: product._id,
            title: product.title,
            price: product.price,
            images: product.images,
            condition: product.condition,
            status: product.status,
            seller: seller
              ? {
                  _id: seller._id,
                  firstName: seller.firstName,
                  lastName: seller.lastName,
                  rating: seller.rating,
                }
              : null,
          },
        };
      })
    );

    // Filter out null (deleted products)
    return favoritesWithProducts.filter((f) => f !== null);
  },
});

// Get favorites count for user
export const getFavoritesCount = query({
  args: {},
  handler: async (ctx, _args) => {
    const actor = await requireUser(ctx);
    const favorites = await ctx.db
      .query("favorites")
      .withIndex("by_user", (q) => q.eq("userId", actor._id))
      .collect();

    return favorites.length;
  },
});

// Get product's favorite count
export const getProductFavoriteCount = query({
  args: { productId: v.id("products") },
  handler: async (ctx, args) => {
    const favorites = await ctx.db
      .query("favorites")
      .withIndex("by_product", (q) => q.eq("productId", args.productId))
      .collect();

    return favorites.length;
  },
});

// Clear all favorites for a user
export const clearFavorites = mutation({
  args: {},
  handler: async (ctx, _args) => {
    const actor = await requireUser(ctx);
    const favorites = await ctx.db
      .query("favorites")
      .withIndex("by_user", (q) => q.eq("userId", actor._id))
      .collect();

    for (const fav of favorites) {
      await ctx.db.delete(fav._id);
    }

    return { deleted: favorites.length };
  },
});

// Remove favorites for a deleted product (cleanup)
export const removeProductFavorites = internalMutation({
  args: { productId: v.id("products") },
  handler: async (ctx, args) => {
    const favorites = await ctx.db
      .query("favorites")
      .withIndex("by_product", (q) => q.eq("productId", args.productId))
      .collect();

    for (const fav of favorites) {
      await ctx.db.delete(fav._id);
    }

    return { deleted: favorites.length };
  },
});
