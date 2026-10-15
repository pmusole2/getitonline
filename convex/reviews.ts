import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { optionalUser, requireUser, requireRole } from "./lib/auth";
import { canViewerSeeProduct } from "./products";

// Create a review
export const createReview = mutation({
  args: {
    orderId: v.id("orders"),
    rating: v.number(), // 1-5
    title: v.optional(v.string()),
    comment: v.optional(v.string()),
    photoUrls: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    // Validate rating
    if (args.rating < 1 || args.rating > 5) {
      throw new Error("Rating must be between 1 and 5");
    }

    const order = await ctx.db.get(args.orderId);
    if (!order) {
      throw new Error("Order not found");
    }

    // Only buyer can review
    if (order.buyerId !== actor._id) {
      throw new Error("Only buyers can leave reviews");
    }

    // Order must be completed
    if (order.status !== "completed") {
      throw new Error("Can only review completed orders");
    }

    // Check if review already exists
    const existingReview = await ctx.db
      .query("reviews")
      .withIndex("by_order", (q) => q.eq("orderId", args.orderId))
      .first();

    if (existingReview) {
      throw new Error("Review already exists for this order");
    }

    // Get product ID from order (first item for simplicity)
    const productId = order.items[0]?.productId;
    if (!productId) {
      throw new Error("Product not found in order");
    }

    const reviewId = await ctx.db.insert("reviews", {
      orderId: args.orderId,
      reviewerId: actor._id,
      revieweeId: order.sellerId, // Seller being reviewed
      productId,
      rating: args.rating,
      title: args.title,
      comment: args.comment,
      photoUrls: args.photoUrls,
      createdAt: Date.now(),
    });

    // Update seller's rating
    await updateUserRating(ctx, order.sellerId);

    const [reviewer, product] = await Promise.all([ctx.db.get(actor._id), ctx.db.get(productId)]);

    await ctx.db.insert("notifications", {
      userId: order.sellerId,
      type: "new_review",
      title: "New Review",
      message: `${reviewer ? `${reviewer.firstName} ${reviewer.lastName}`.trim() : "A buyer"} left a ${args.rating}-star review for "${product?.title ?? "an item"}".`,
      data: { orderId: args.orderId, productId, rating: args.rating },
      isRead: false,
      createdAt: Date.now(),
    });

    return reviewId;
  },
});

// Helper function to update user's average rating
async function updateUserRating(ctx: MutationCtx, userId: Id<"users">) {
  const reviews = await ctx.db
    .query("reviews")
    .withIndex("by_reviewee", (q) => q.eq("revieweeId", userId))
    .collect();

  if (reviews.length === 0) {
    return;
  }

  const totalRating = reviews.reduce((sum, review) => sum + review.rating, 0);
  const averageRating = totalRating / reviews.length;

  await ctx.db.patch(userId, {
    rating: Math.round(averageRating * 10) / 10,
    updatedAt: Date.now(),
  });
}

// Get review by order
export const getReviewByOrder = query({
  args: { orderId: v.id("orders") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("reviews")
      .withIndex("by_order", (q) => q.eq("orderId", args.orderId))
      .first();
  },
});

// Get reviews for a seller (user being reviewed)
export const getSellerReviews = query({
  args: {
    sellerId: v.id("users"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 20;

    const reviews = await ctx.db
      .query("reviews")
      .withIndex("by_reviewee", (q) => q.eq("revieweeId", args.sellerId))
      .order("desc")
      .take(limit);
    const viewer = await optionalUser(ctx);

    return await Promise.all(
      reviews.map(async (review) => {
        const reviewer = await ctx.db.get(review.reviewerId);
        const product = await ctx.db.get(review.productId);
        const canSeeProduct = product !== null && (await canViewerSeeProduct(ctx, product, viewer));

        return {
          ...review,
          reviewer: reviewer
            ? {
                _id: reviewer._id,
                firstName: reviewer.firstName,
                lastName: reviewer.lastName,
                avatar: reviewer.avatar,
              }
            : null,
          product:
            product && canSeeProduct
              ? {
                  _id: product._id,
                  title: product.title,
                  images: product.images,
                }
              : null,
        };
      })
    );
  },
});

// Get reviews for a product
export const getProductReviews = query({
  args: {
    productId: v.id("products"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 20;

    const reviews = await ctx.db
      .query("reviews")
      .withIndex("by_product", (q) => q.eq("productId", args.productId))
      .order("desc")
      .take(limit);

    return await Promise.all(
      reviews.map(async (review) => {
        const reviewer = await ctx.db.get(review.reviewerId);

        return {
          ...review,
          reviewer: reviewer
            ? {
                _id: reviewer._id,
                firstName: reviewer.firstName,
                lastName: reviewer.lastName,
                avatar: reviewer.avatar,
              }
            : null,
        };
      })
    );
  },
});

// Get reviews by user (reviews they've written)
export const getUserWrittenReviews = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const limit = args.limit ?? 20;

    const reviews = await ctx.db
      .query("reviews")
      .withIndex("by_reviewer", (q) => q.eq("reviewerId", actor._id))
      .order("desc")
      .take(limit);

    return await Promise.all(
      reviews.map(async (review) => {
        const reviewee = await ctx.db.get(review.revieweeId);
        const product = await ctx.db.get(review.productId);
        const canSeeProduct = product !== null && (await canViewerSeeProduct(ctx, product, actor));

        return {
          ...review,
          reviewee: reviewee
            ? {
                _id: reviewee._id,
                firstName: reviewee.firstName,
                lastName: reviewee.lastName,
              }
            : null,
          product:
            product && canSeeProduct
              ? {
                  _id: product._id,
                  title: product.title,
                  images: product.images,
                }
              : null,
        };
      })
    );
  },
});

// Get review statistics for a seller
export const getSellerReviewStats = query({
  args: { sellerId: v.id("users") },
  handler: async (ctx, args) => {
    const reviews = await ctx.db
      .query("reviews")
      .withIndex("by_reviewee", (q) => q.eq("revieweeId", args.sellerId))
      .collect();

    if (reviews.length === 0) {
      return {
        totalReviews: 0,
        averageRating: 0,
        ratingDistribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      };
    }

    const totalRating = reviews.reduce((sum, review) => sum + review.rating, 0);
    const averageRating = totalRating / reviews.length;

    const ratingDistribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const review of reviews) {
      ratingDistribution[review.rating as keyof typeof ratingDistribution]++;
    }

    return {
      totalReviews: reviews.length,
      averageRating: Math.round(averageRating * 10) / 10,
      ratingDistribution,
    };
  },
});

// Check if user can review an order
export const canReviewOrder = query({
  args: {
    orderId: v.id("orders"),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const order = await ctx.db.get(args.orderId);
    if (!order) {
      return { canReview: false, reason: "Order not found" };
    }

    if (order.buyerId !== actor._id) {
      return { canReview: false, reason: "Only buyers can review" };
    }

    if (order.status !== "completed") {
      return { canReview: false, reason: "Order must be completed" };
    }

    const existingReview = await ctx.db
      .query("reviews")
      .withIndex("by_order", (q) => q.eq("orderId", args.orderId))
      .first();

    if (existingReview) {
      return { canReview: false, reason: "Already reviewed" };
    }

    return { canReview: true, reason: null };
  },
});

// Delete review (admin only)
export const deleteReview = mutation({
  args: {
    reviewId: v.id("reviews"),
  },
  handler: async (ctx, args) => {
    const actor = await requireRole(ctx, ["admin"]);
    const admin = await ctx.db.get(actor._id);
    if (!admin || admin.role !== "admin") {
      throw new Error("Unauthorized: Only admins can delete reviews");
    }

    const review = await ctx.db.get(args.reviewId);
    if (!review) {
      throw new Error("Review not found");
    }

    const revieweeId = review.revieweeId;

    await ctx.db.delete(args.reviewId);

    // Update seller's rating
    await updateUserRating(ctx, revieweeId);
  },
});
