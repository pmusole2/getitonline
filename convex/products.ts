import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import {
  aiModerationStatusValidator,
  buildSellerPublicProfile,
  canActorManageProduct,
  canViewerInspectProduct,
  ensureCatalogActor,
  ensureReviewerActor,
  getPlatformSettings,
  isStaffViewer,
  isPublicStorefrontSeller,
  productStatusValidator,
  resolveListingActor,
} from "./lib/platform";

const productConditionValidator = v.union(
  v.literal("new"),
  v.literal("like_new"),
  v.literal("good"),
  v.literal("fair")
);

const shippingOptionValidator = v.object({
  name: v.string(),
  price: v.number(),
  estimatedDays: v.string(),
});

const productMutationArgs = {
  title: v.string(),
  description: v.string(),
  price: v.number(),
  compareAtPrice: v.optional(v.number()),
  categoryId: v.id("categories"),
  subcategoryId: v.optional(v.id("categories")),
  images: v.array(v.string()),
  condition: productConditionValidator,
  quantity: v.number(),
  specifications: v.optional(
    v.array(v.object({ key: v.string(), value: v.string() }))
  ),
  tags: v.optional(v.array(v.string())),
  location: v.optional(v.object({ city: v.string(), province: v.string() })),
  shippingOptions: v.array(shippingOptionValidator),
};

type ReaderCtx = QueryCtx | MutationCtx;
type ProductDoc = Doc<"products">;

async function isProductPublic(
  ctx: ReaderCtx,
  product: Pick<ProductDoc, "sellerId" | "status">
) {
  return (
    product.status === "active" &&
    (await isPublicStorefrontSeller(ctx, product.sellerId))
  );
}

async function enrichProduct(
  ctx: ReaderCtx,
  product: ProductDoc
) {
  const seller = await buildSellerPublicProfile(ctx, product.sellerId);
  const category = await ctx.db.get(product.categoryId);
  const subcategory = product.subcategoryId
    ? await ctx.db.get(product.subcategoryId)
    : null;

  return {
    ...product,
    seller,
    category,
    subcategory,
  };
}

function hasCustomerFacingChanges(
  updates: Record<string, unknown>
) {
  const customerFacingKeys = [
    "title",
    "description",
    "price",
    "compareAtPrice",
    "categoryId",
    "subcategoryId",
    "images",
    "condition",
    "quantity",
    "specifications",
    "tags",
    "location",
    "shippingOptions",
  ];

  return customerFacingKeys.some((key) => key in updates);
}

// Create a new product listing
export const createProduct = mutation({
  args: {
    actorUserId: v.id("users"),
    ...productMutationArgs,
    status: v.optional(v.union(v.literal("draft"), v.literal("pending_review"))),
  },
  handler: async (ctx, args) => {
    const listingActor = await resolveListingActor(ctx, args.actorUserId);
    const { actorUserId, status, ...productInput } = args;
    const nextStatus = status ?? "draft";
    const now = Date.now();

    return await ctx.db.insert("products", {
      ...productInput,
      sellerId: listingActor.sellerId,
      managedByUserId: actorUserId,
      status: nextStatus,
      submittedAt: nextStatus === "pending_review" ? now : undefined,
      views: 0,
      createdAt: now,
      updatedAt: now,
    });
  },
});

// Get product by ID
export const getProduct = query({
  args: {
    productId: v.id("products"),
    viewerUserId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    const product = await ctx.db.get(args.productId);
    if (!product) return null;

    const canInspectHidden = await canViewerInspectProduct(
      ctx,
      product,
      args.viewerUserId
    );

    if (!(await isProductPublic(ctx, product)) && !canInspectHidden) {
      return null;
    }

    return await enrichProduct(ctx, product);
  },
});

// Get products by seller
export const getProductsBySeller = query({
  args: {
    sellerId: v.id("users"),
    status: v.optional(productStatusValidator),
    viewerUserId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    let productsQuery = ctx.db
      .query("products")
      .withIndex("by_seller", (q) => q.eq("sellerId", args.sellerId));

    if (args.status) {
      productsQuery = productsQuery.filter((q) =>
        q.eq(q.field("status"), args.status)
      );
    }

    const products = await productsQuery.order("desc").collect();
    const canInspectHidden = args.viewerUserId
      ? args.viewerUserId === args.sellerId ||
        (await isStaffViewer(ctx, args.viewerUserId))
      : false;

    return (
      await Promise.all(
        products.map(async (product) => {
          const isPublic = await isProductPublic(ctx, product);
          if (!isPublic && !canInspectHidden) {
            return null;
          }
          return product;
        })
      )
    ).filter((product) => product !== null);
  },
});

export const getMyListings = query({
  args: {
    actorUserId: v.id("users"),
    status: v.optional(productStatusValidator),
  },
  handler: async (ctx, args) => {
    const listingActor = await resolveListingActor(ctx, args.actorUserId);
    const sellerId = listingActor.sellerId;

    let productsQuery = ctx.db
      .query("products")
      .withIndex("by_seller", (q) => q.eq("sellerId", sellerId));

    if (args.status) {
      productsQuery = productsQuery.filter((q) =>
        q.eq(q.field("status"), args.status)
      );
    }

    return await productsQuery.order("desc").collect();
  },
});

// Get products by category
export const getProductsByCategory = query({
  args: {
    categoryId: v.id("categories"),
    limit: v.optional(v.number()),
    cursor: v.optional(v.id("products")),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 20;

    const products = await ctx.db
      .query("products")
      .withIndex("by_category", (q) => q.eq("categoryId", args.categoryId))
      .filter((q) => q.eq(q.field("status"), "active"))
      .order("desc")
      .take(limit * 3);

    const visibleProducts = (
      await Promise.all(
        products.map(async (product) =>
          (await isProductPublic(ctx, product)) ? product : null
        )
      )
    ).filter((product) => product !== null);

    const items = visibleProducts.slice(0, limit);
    const hasMore = visibleProducts.length > limit;
    const lastItem = items[items.length - 1];

    return {
      items,
      hasMore,
      nextCursor: hasMore && lastItem ? lastItem._id : null,
    };
  },
});

// Get products by subcategory
export const getProductsBySubcategory = query({
  args: {
    subcategoryId: v.id("categories"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 20;

    const products = await ctx.db
      .query("products")
      .withIndex("by_subcategory", (q) => q.eq("subcategoryId", args.subcategoryId))
      .filter((q) => q.eq(q.field("status"), "active"))
      .order("desc")
      .take(limit * 3);

    const visibleProducts = (
      await Promise.all(
        products.map(async (product) =>
          (await isProductPublic(ctx, product)) ? product : null
        )
      )
    ).filter((product) => product !== null);

    return visibleProducts.slice(0, limit);
  },
});

// Search products
export const searchProducts = query({
  args: {
    query: v.string(),
    categoryId: v.optional(v.id("categories")),
    condition: v.optional(productConditionValidator),
    minPrice: v.optional(v.number()),
    maxPrice: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 20;

    let searchQuery = ctx.db
      .query("products")
      .withSearchIndex("search_products", (q) => {
        let search = q.search("title", args.query);
        if (args.categoryId) {
          search = search.eq("categoryId", args.categoryId);
        }
        if (args.condition) {
          search = search.eq("condition", args.condition);
        }
        return search.eq("status", "active");
      });

    let results = await searchQuery.take(limit * 4);

    if (args.minPrice !== undefined || args.maxPrice !== undefined) {
      results = results.filter((product) => {
        if (args.minPrice !== undefined && product.price < args.minPrice) {
          return false;
        }
        if (args.maxPrice !== undefined && product.price > args.maxPrice) {
          return false;
        }
        return true;
      });
    }

    const visibleProducts = (
      await Promise.all(
        results.map(async (product) =>
          (await isProductPublic(ctx, product)) ? product : null
        )
      )
    ).filter((product) => product !== null);

    return visibleProducts.slice(0, limit);
  },
});

// Get recent products
export const getRecentProducts = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 20;

    const products = await ctx.db
      .query("products")
      .withIndex("by_status_created", (q) => q.eq("status", "active"))
      .order("desc")
      .take(limit * 4);

    const visibleProducts = (
      await Promise.all(
        products.map(async (product) =>
          (await isProductPublic(ctx, product)) ? product : null
        )
      )
    ).filter((product) => product !== null);

    return visibleProducts.slice(0, limit);
  },
});

// Get popular products (most views)
export const getPopularProducts = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 20;

    const products = await ctx.db
      .query("products")
      .filter((q) => q.eq(q.field("status"), "active"))
      .collect();

    const visibleProducts = (
      await Promise.all(
        products.map(async (product) =>
          (await isProductPublic(ctx, product)) ? product : null
        )
      )
    ).filter((product) => product !== null);

    return visibleProducts
      .sort((left, right) => right.views - left.views)
      .slice(0, limit);
  },
});

// Update product
export const updateProduct = mutation({
  args: {
    productId: v.id("products"),
    actorUserId: v.id("users"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    price: v.optional(v.number()),
    compareAtPrice: v.optional(v.number()),
    categoryId: v.optional(v.id("categories")),
    subcategoryId: v.optional(v.id("categories")),
    images: v.optional(v.array(v.string())),
    condition: v.optional(productConditionValidator),
    quantity: v.optional(v.number()),
    specifications: v.optional(
      v.array(v.object({ key: v.string(), value: v.string() }))
    ),
    tags: v.optional(v.array(v.string())),
    location: v.optional(v.object({ city: v.string(), province: v.string() })),
    shippingOptions: v.optional(v.array(shippingOptionValidator)),
    status: v.optional(v.union(v.literal("draft"), v.literal("pending_review"))),
  },
  handler: async (ctx, args) => {
    const product = await ctx.db.get(args.productId);
    if (!product) throw new Error("Product not found");

    const canManage = await canActorManageProduct(ctx, args.actorUserId, product);
    if (!canManage) {
      throw new Error("Unauthorized");
    }

    const { productId, actorUserId, status, ...updates } = args;
    const filteredUpdates = Object.fromEntries(
      Object.entries(updates).filter(([_, value]) => value !== undefined)
    );

    const now = Date.now();
    const shouldResubmitActiveListing =
      product.status === "active" && hasCustomerFacingChanges(filteredUpdates);

    await ctx.db.patch(productId, {
      ...filteredUpdates,
      managedByUserId: actorUserId,
      status: status ?? (shouldResubmitActiveListing ? "pending_review" : product.status),
      submittedAt:
        status === "pending_review" || shouldResubmitActiveListing
          ? now
          : product.submittedAt,
      updatedAt: now,
    });

    return await ctx.db.get(productId);
  },
});

export const submitForReview = mutation({
  args: {
    productId: v.id("products"),
    actorUserId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const product = await ctx.db.get(args.productId);
    if (!product) {
      throw new Error("Product not found");
    }

    const canManage = await canActorManageProduct(ctx, args.actorUserId, product);
    if (!canManage) {
      throw new Error("Unauthorized");
    }

    if (!["draft", "changes_requested"].includes(product.status)) {
      throw new Error("Only draft or changes-requested listings can be submitted");
    }

    await ctx.db.patch(args.productId, {
      status: "pending_review",
      submittedAt: Date.now(),
      managedByUserId: args.actorUserId,
      updatedAt: Date.now(),
    });

    return await ctx.db.get(args.productId);
  },
});

export const getPendingReviewListings = query({
  args: {
    reviewerId: v.id("users"),
    status: v.optional(
      v.union(v.literal("pending_review"), v.literal("changes_requested"))
    ),
  },
  handler: async (ctx, args) => {
    await ensureReviewerActor(ctx, args.reviewerId);
    const status = args.status ?? "pending_review";

    const products = await ctx.db
      .query("products")
      .withIndex("by_status", (q) => q.eq("status", status))
      .order("desc")
      .collect();

    return await Promise.all(
      products.map(async (product) => enrichProduct(ctx, product))
    );
  },
});

export const reviewListing = mutation({
  args: {
    productId: v.id("products"),
    reviewerId: v.id("users"),
    decision: v.union(
      v.literal("approved"),
      v.literal("changes_requested"),
      v.literal("suspended")
    ),
    reviewNotes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ensureReviewerActor(ctx, args.reviewerId);

    const product = await ctx.db.get(args.productId);
    if (!product) {
      throw new Error("Product not found");
    }

    const status =
      args.decision === "approved"
        ? "active"
        : args.decision === "changes_requested"
          ? "changes_requested"
          : "suspended";

    await ctx.db.patch(args.productId, {
      status,
      reviewNotes: args.reviewNotes,
      reviewedByUserId: args.reviewerId,
      reviewedAt: Date.now(),
      updatedAt: Date.now(),
    });

    return await ctx.db.get(args.productId);
  },
});

export const storeListingModerationResult = mutation({
  args: {
    productId: v.id("products"),
    reviewerId: v.id("users"),
    status: aiModerationStatusValidator,
    summary: v.string(),
    flags: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    await ensureReviewerActor(ctx, args.reviewerId);

    const product = await ctx.db.get(args.productId);
    if (!product) {
      throw new Error("Product not found");
    }

    await ctx.db.patch(args.productId, {
      aiModerationStatus: args.status,
      aiModerationSummary: args.summary,
      aiModerationFlags: args.flags,
      updatedAt: Date.now(),
    });

    return await ctx.db.get(args.productId);
  },
});

// Delete product
export const deleteProduct = mutation({
  args: {
    productId: v.id("products"),
    actorUserId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const product = await ctx.db.get(args.productId);
    if (!product) throw new Error("Product not found");

    const canManage = await canActorManageProduct(ctx, args.actorUserId, product);
    if (!canManage) {
      throw new Error("Unauthorized");
    }

    await ctx.db.delete(args.productId);
  },
});

// Increment view count
export const incrementViews = mutation({
  args: { productId: v.id("products") },
  handler: async (ctx, args) => {
    const product = await ctx.db.get(args.productId);
    if (!product || !(await isProductPublic(ctx, product))) return;

    await ctx.db.patch(args.productId, {
      views: product.views + 1,
    });
  },
});

// Mark product as sold
export const markAsSold = mutation({
  args: {
    productId: v.id("products"),
    actorUserId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const product = await ctx.db.get(args.productId);
    if (!product) throw new Error("Product not found");

    const canManage = await canActorManageProduct(ctx, args.actorUserId, product);
    if (!canManage) {
      throw new Error("Unauthorized");
    }

    await ctx.db.patch(args.productId, {
      status: "sold",
      managedByUserId: args.actorUserId,
      updatedAt: Date.now(),
    });
  },
});

export const getManagedCatalogProducts = query({
  args: {
    actorUserId: v.id("users"),
    status: v.optional(productStatusValidator),
  },
  handler: async (ctx, args) => {
    await ensureCatalogActor(ctx, args.actorUserId);
    const settings = await getPlatformSettings(ctx);
    if (!settings) {
      return [];
    }

    let productsQuery = ctx.db
      .query("products")
      .withIndex("by_seller", (q) => q.eq("sellerId", settings.companySellerUserId));

    if (args.status) {
      productsQuery = productsQuery.filter((q) =>
        q.eq(q.field("status"), args.status)
      );
    }

    return await productsQuery.order("desc").collect();
  },
});

// Suspend product (admin/moderator)
export const suspendProduct = mutation({
  args: {
    productId: v.id("products"),
    moderatorId: v.id("users"),
  },
  handler: async (ctx, args) => {
    await ensureReviewerActor(ctx, args.moderatorId);

    await ctx.db.patch(args.productId, {
      status: "suspended",
      reviewedByUserId: args.moderatorId,
      reviewedAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});

// Decrease product quantity
export const decreaseQuantity = mutation({
  args: {
    productId: v.id("products"),
    amount: v.number(),
  },
  handler: async (ctx, args) => {
    const product = await ctx.db.get(args.productId);
    if (!product) throw new Error("Product not found");

    const newQuantity = product.quantity - args.amount;
    if (newQuantity < 0) throw new Error("Insufficient quantity");

    await ctx.db.patch(args.productId, {
      quantity: newQuantity,
      status: newQuantity === 0 ? "sold" : product.status,
      updatedAt: Date.now(),
    });
  },
});

// Get products by their IDs (for AI recommendations)
export const getProductsByIds = query({
  args: {
    productIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const products = await Promise.all(
      args.productIds.map(async (id) => {
        try {
          const product = await ctx.db
            .query("products")
            .filter((q) => q.eq(q.field("_id"), id))
            .first();
          return product;
        } catch {
          return null;
        }
      })
    );

    return (
      await Promise.all(
        products.map(async (product) =>
          product && (await isProductPublic(ctx, product)) ? product : null
        )
      )
    ).filter((product) => product !== null);
  },
});

// Get products for recommendations (by category IDs)
export const getProductsByCategories = query({
  args: {
    categoryIds: v.array(v.id("categories")),
    excludeProductIds: v.optional(v.array(v.id("products"))),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 10;
    const excludeIds = new Set(args.excludeProductIds ?? []);

    const allProducts: ProductDoc[] = [];

    for (const categoryId of args.categoryIds) {
      const products = await ctx.db
        .query("products")
        .withIndex("by_category", (q) => q.eq("categoryId", categoryId))
        .filter((q) => q.eq(q.field("status"), "active"))
        .take(limit * 2);

      allProducts.push(...products);
    }

    const visibleProducts = (
      await Promise.all(
        allProducts.map(async (product) =>
          product && (await isProductPublic(ctx, product)) ? product : null
        )
      )
    ).filter((product) => product !== null);

    const seen = new Set<string>();
    const uniqueProducts = visibleProducts.filter((product) => {
      if (excludeIds.has(product._id) || seen.has(product._id)) {
        return false;
      }

      seen.add(product._id);
      return true;
    });

    return uniqueProducts
      .sort(() => Math.random() - 0.5)
      .slice(0, limit);
  },
});
