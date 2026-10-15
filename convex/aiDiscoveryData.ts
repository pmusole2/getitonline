import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { internalQuery } from "./_generated/server";
import {
  DISCOVERY_LIMITS,
  type CallerActivity,
  type CartRecommendationContext,
  type DiscoveryCandidate,
  type RecommendationContext,
  type SimilarContext,
} from "./lib/aiDiscoveryPolicy";
import { isPublicStorefrontSeller } from "./lib/platform";

// Internal reads for Pinkie's discovery actions. The action passes the account it verified itself. Every read returns
// public product fields only, from active products by public sellers. Seller contact data, descriptions, and messages are
// never read here.

const CATALOG_SCAN_LIMIT = 200;

const VIEW_EVENT_TYPES = new Set<string>(["product_view", "product_time_spent", "category_browse"]);

async function categoryName(ctx: QueryCtx, categoryId: Id<"categories">): Promise<string | null> {
  const category = await ctx.db.get(categoryId);
  return category?.name ?? null;
}

async function toCandidate(ctx: QueryCtx, product: Doc<"products">): Promise<DiscoveryCandidate> {
  const category = await categoryName(ctx, product.categoryId);
  return {
    id: product._id,
    title: product.title,
    category: category ?? "Uncategorized",
    categoryId: product.categoryId,
    price: product.price,
    condition: product.condition,
  };
}

// Newest active listings from public sellers, up to `limit` visible results. Seller visibility is checked once per seller.
async function publicActiveProducts(
  ctx: QueryCtx,
  options: { limit: number; excludeSellerId?: Id<"users"> }
): Promise<Doc<"products">[]> {
  const products = await ctx.db
    .query("products")
    .withIndex("by_status_created", (q) => q.eq("status", "active"))
    .order("desc")
    .take(CATALOG_SCAN_LIMIT);

  const publicSellers = new Map<Id<"users">, boolean>();
  const visible: Doc<"products">[] = [];
  for (const product of products) {
    if (visible.length === options.limit) {
      break;
    }
    if (product.sellerId === options.excludeSellerId) {
      continue;
    }
    let isPublic = publicSellers.get(product.sellerId);
    if (isPublic === undefined) {
      isPublic = await isPublicStorefrontSeller(ctx, product.sellerId);
      publicSellers.set(product.sellerId, isPublic);
    }
    if (isPublic) {
      visible.push(product);
    }
  }
  return visible;
}

// Resolves category IDs to names, dropping any that no longer exist. The caller's own rows only, never anyone else's.
async function namesFor(ctx: QueryCtx, ids: Id<"categories">[], limit: number): Promise<string[]> {
  const names: string[] = [];
  for (const id of ids) {
    const name = await categoryName(ctx, id);
    if (name !== null) {
      names.push(name);
    }
  }
  return names.slice(0, limit);
}

async function callerActivity(ctx: QueryCtx, userId: Id<"users">): Promise<CallerActivity> {
  const user = await ctx.db.get(userId);
  const events = await ctx.db
    .query("behaviorEvents")
    .withIndex("by_user_created", (q) => q.eq("userId", userId))
    .order("desc")
    .take(DISCOVERY_LIMITS.behaviorEvents);

  const viewed: Id<"categories">[] = [];
  const purchased: Id<"categories">[] = [];
  for (const event of events) {
    if (!event.categoryId) {
      continue;
    }
    if (VIEW_EVENT_TYPES.has(event.eventType) && !viewed.includes(event.categoryId)) {
      viewed.push(event.categoryId);
    }
    if (event.eventType === "purchase" && !purchased.includes(event.categoryId)) {
      purchased.push(event.categoryId);
    }
  }

  const interestIds = (user?.interests ?? []).slice(0, DISCOVERY_LIMITS.interestIds);
  return {
    interests: await namesFor(ctx, interestIds, DISCOVERY_LIMITS.interestNames),
    recentlyViewed: await namesFor(ctx, viewed, DISCOVERY_LIMITS.categoryNames),
    purchases: await namesFor(ctx, purchased, DISCOVERY_LIMITS.categoryNames),
  };
}

export const recommendationContext = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args): Promise<RecommendationContext> => {
    const products = await publicActiveProducts(ctx, {
      limit: DISCOVERY_LIMITS.recommendationCandidates,
      excludeSellerId: args.userId,
    });
    const candidates: DiscoveryCandidate[] = [];
    for (const product of products) {
      candidates.push(await toCandidate(ctx, product));
    }
    return { candidates, ...(await callerActivity(ctx, args.userId)) };
  },
});

export const similarContext = internalQuery({
  args: { productId: v.id("products") },
  handler: async (ctx, args): Promise<SimilarContext> => {
    const product = await ctx.db.get(args.productId);
    // A missing, inactive, or private source looks the same to the caller, so it gets no candidates either.
    if (!product || product.status !== "active" || !(await isPublicStorefrontSeller(ctx, product.sellerId))) {
      return { source: null, candidates: [] };
    }

    const others = await publicActiveProducts(ctx, { limit: DISCOVERY_LIMITS.similarCandidates + 1 });
    const candidates: DiscoveryCandidate[] = [];
    for (const other of others) {
      if (other._id !== product._id && candidates.length < DISCOVERY_LIMITS.similarCandidates) {
        candidates.push(await toCandidate(ctx, other));
      }
    }
    return { source: await toCandidate(ctx, product), candidates };
  },
});

// Re-reads the shown IDs after the provider returns. Only IDs that are still active and from public sellers come back, so
// a listing hidden during the call is never returned. The action keeps only IDs it showed the model.
export const eligibleProducts = internalQuery({
  args: { productIds: v.array(v.id("products")) },
  handler: async (ctx, args): Promise<Id<"products">[]> => {
    const eligible: Id<"products">[] = [];
    for (const productId of args.productIds) {
      const product = await ctx.db.get(productId);
      if (product?.status === "active" && (await isPublicStorefrontSeller(ctx, product.sellerId))) {
        eligible.push(productId);
      }
    }
    return eligible;
  },
});

// A category family is its authoritative root, reached only through existing active parent rows. Cycles, missing
// parents fail closed instead of broadening the eligible family.
async function categoryAncestry(ctx: QueryCtx, categoryId: Id<"categories">): Promise<Doc<"categories">[] | null> {
  const ancestry: Doc<"categories">[] = [];
  const seen = new Set<Id<"categories">>();
  let next: Id<"categories"> | undefined = categoryId;
  while (next !== undefined) {
    if (seen.has(next)) {
      return null;
    }
    seen.add(next);
    const category: Doc<"categories"> | null = await ctx.db.get(next);
    if (category === null || category.isActive === false) {
      return null;
    }
    ancestry.push(category);
    next = category.parentId;
  }
  return ancestry;
}

async function cartProductEligible(ctx: QueryCtx, product: Doc<"products">, userId: Id<"users">): Promise<boolean> {
  const combinations = product.variantCombinations ?? [];

  return (
    product.status === "active" &&
    product.sellerId !== userId &&
    Number.isSafeInteger(product.quantity) &&
    product.quantity > 0 &&
    (combinations.length > 0
      ? combinations.some(
          (variant) => variant.status === "active" && Number.isSafeInteger(variant.stock) && variant.stock > 0
        )
      : (product.variants ?? []).every((variant) =>
          variant.options.some(
            (option) => option.quantity === undefined || (Number.isSafeInteger(option.quantity) && option.quantity > 0)
          )
        )) &&
    product.availabilityStatus !== "out_of_stock" &&
    product.availabilityStatus !== "preorder" &&
    product.preorder?.isPreorder !== true &&
    (await isPublicStorefrontSeller(ctx, product.sellerId))
  );
}

export const cartRecommendationContext = internalQuery({
  args: { userId: v.id("users"), cartProductIds: v.array(v.id("products")) },
  handler: async (ctx, args): Promise<CartRecommendationContext | null> => {
    const expectedIds = new Set(args.cartProductIds);
    if (expectedIds.size === 0 || args.cartProductIds.length > DISCOVERY_LIMITS.cartProducts) {
      return null;
    }

    // The extra row detects truncation, including many variant/customization rows for the same product.
    const rows = await ctx.db
      .query("cartItems")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .take(DISCOVERY_LIMITS.cartProducts + 1);
    const actualIds = new Set(rows.map((row) => row.productId));
    if (
      rows.length === 0 ||
      rows.length > DISCOVERY_LIMITS.cartProducts ||
      actualIds.size !== expectedIds.size ||
      [...actualIds].some((id) => !expectedIds.has(id))
    ) {
      return null;
    }

    const sources: DiscoveryCandidate[] = [];
    const families = new Set<Id<"categories">>();
    const sourceMetadata: unknown[] = [];
    for (const id of [...actualIds].sort()) {
      const product = await ctx.db.get(id);
      if (product === null || !(await cartProductEligible(ctx, product, args.userId))) {
        return null;
      }
      const productRows = rows.filter((row) => row.productId === id);
      if (productRows.some((row) => !Number.isSafeInteger(row.quantity) || row.quantity <= 0)) {
        return null;
      }
      if (productRows.reduce((quantity, row) => quantity + row.quantity, 0) > product.quantity) {
        return null;
      }
      const combinations = product.variantCombinations ?? [];
      const selectedQuantities = new Map<string, number>();
      for (const row of productRows) {
        if (combinations.length === 0) {
          break;
        }
        const selected = row.selectedVariant;
        const combination = selected
          ? combinations.find((variant) => variant.id === selected.variantId || variant.sku === selected.sku)
          : undefined;
        if (!combination || combination.status !== "active" || !Number.isSafeInteger(combination.stock)) {
          return null;
        }
        const quantity = (selectedQuantities.get(combination.id) ?? 0) + row.quantity;
        if (quantity > combination.stock) {
          return null;
        }
        selectedQuantities.set(combination.id, quantity);
      }
      const ancestry = await categoryAncestry(ctx, product.categoryId);
      const root = ancestry?.at(-1);
      if (!ancestry || !root) {
        return null;
      }
      families.add(root._id);
      const source = await toCandidate(ctx, product);
      sources.push(source);
      sourceMetadata.push({
        source,
        sellerId: product.sellerId,
        quantity: product.quantity,
        availabilityStatus: product.availabilityStatus ?? null,
        preorder: product.preorder ?? null,
        variantCombinations: product.variantCombinations ?? [],
        variants: product.variants ?? [],
        categories: ancestry.map((category) => ({
          id: category._id,
          name: category.name,
          parentId: category.parentId ?? null,
        })),
      });
    }

    const products = await publicActiveProducts(ctx, { limit: CATALOG_SCAN_LIMIT, excludeSellerId: args.userId });
    const candidates: DiscoveryCandidate[] = [];
    for (const product of products) {
      if (candidates.length === DISCOVERY_LIMITS.recommendationCandidates) {
        break;
      }
      if (actualIds.has(product._id) || !(await cartProductEligible(ctx, product, args.userId))) {
        continue;
      }
      const ancestry = await categoryAncestry(ctx, product.categoryId);
      const root = ancestry?.at(-1);
      if (root && families.has(root._id)) {
        candidates.push(await toCandidate(ctx, product));
      }
    }
    return {
      sources,
      candidates,
      snapshot: JSON.stringify({
        rows: [...rows].sort((left, right) => left._id.localeCompare(right._id)),
        sourceMetadata,
      }),
    };
  },
});
