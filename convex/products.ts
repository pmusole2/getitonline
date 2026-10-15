import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { decideAccess, optionalUser, requireUser } from "./lib/auth";
import { areStorableFlags, normalizeSummary } from "./lib/aiModerationPolicy";
import {
  aiModerationStatusValidator,
  buildSellerPublicProfile,
  canActorManageProduct,
  canViewerInspectProduct,
  ensureCatalogActor,
  ensureReviewerActor,
  getPlatformSettings,
  isReviewerRole,
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

const dimensionsValidator = v.object({
  lengthCm: v.number(),
  widthCm: v.number(),
  heightCm: v.number(),
});

const availabilityStatusValidator = v.union(
  v.literal("in_stock"),
  v.literal("low_stock"),
  v.literal("out_of_stock"),
  v.literal("preorder")
);

const warrantyValidator = v.object({
  type: v.union(v.literal("manufacturer"), v.literal("seller"), v.literal("none")),
  durationDays: v.optional(v.number()),
  provider: v.optional(v.string()),
  terms: v.optional(v.string()),
});

const productImageMetadataValidator = v.object({
  url: v.string(),
  width: v.optional(v.number()),
  height: v.optional(v.number()),
  sizeBytes: v.optional(v.number()),
  mimeType: v.optional(v.string()),
  isPrimary: v.boolean(),
  hasWhiteBackground: v.optional(v.boolean()),
});

const productVariantValidator = v.object({
  name: v.string(),
  options: v.array(
    v.object({
      name: v.string(),
      value: v.string(),
      sku: v.optional(v.string()),
      priceDelta: v.optional(v.number()),
      quantity: v.optional(v.number()),
      imageUrl: v.optional(v.string()),
    })
  ),
});

const variantAttributeValidator = v.object({
  name: v.string(),
  values: v.array(v.string()),
});

const variantCombinationValidator = v.object({
  id: v.string(),
  sku: v.string(),
  attributes: v.array(v.object({ name: v.string(), value: v.string() })),
  price: v.number(),
  stock: v.number(),
  status: v.union(v.literal("active"), v.literal("inactive"), v.literal("out_of_stock")),
  primaryImage: v.optional(v.string()),
  galleryImages: v.optional(v.array(v.string())),
});

const productAddOnValidator = v.object({
  name: v.string(),
  description: v.optional(v.string()),
  price: v.number(),
  isRequired: v.boolean(),
});

const bulkPricingTierValidator = v.object({
  minQuantity: v.number(),
  unitPrice: v.number(),
});

const productMutationArgs = {
  title: v.string(),
  brand: v.optional(v.string()),
  sku: v.optional(v.string()),
  shortDescription: v.optional(v.string()),
  description: v.string(),
  keyFeatures: v.optional(v.array(v.string())),
  price: v.number(),
  compareAtPrice: v.optional(v.number()),
  categoryId: v.id("categories"),
  subcategoryId: v.optional(v.id("categories")),
  classificationId: v.optional(v.id("categories")),
  images: v.array(v.string()),
  imageMetadata: v.optional(v.array(productImageMetadataValidator)),
  condition: productConditionValidator,
  quantity: v.number(),
  lowStockThreshold: v.optional(v.number()),
  availabilityStatus: v.optional(availabilityStatusValidator),
  preorder: v.optional(
    v.object({
      isPreorder: v.boolean(),
      expectedShipDate: v.optional(v.number()),
      depositPercent: v.optional(v.number()),
    })
  ),
  variants: v.optional(v.array(productVariantValidator)),
  variantAttributes: v.optional(v.array(variantAttributeValidator)),
  variantCombinations: v.optional(v.array(variantCombinationValidator)),
  addOns: v.optional(v.array(productAddOnValidator)),
  bulkPricing: v.optional(v.array(bulkPricingTierValidator)),
  dimensions: v.optional(dimensionsValidator),
  weightKg: v.optional(v.number()),
  packageDimensions: v.optional(dimensionsValidator),
  packageWeightKg: v.optional(v.number()),
  warranty: v.optional(warrantyValidator),
  countryOfOrigin: v.optional(v.string()),
  modelNumber: v.optional(v.string()),
  manufacturerPartNumber: v.optional(v.string()),
  material: v.optional(v.string()),
  color: v.optional(v.string()),
  specifications: v.optional(v.array(v.object({ key: v.string(), value: v.string() }))),
  tags: v.optional(v.array(v.string())),
  location: v.optional(v.object({ city: v.string(), province: v.string() })),
  shippingOptions: v.array(shippingOptionValidator),
};

type ReaderCtx = QueryCtx | MutationCtx;
type ProductDoc = Doc<"products">;
type VariantAttribute = {
  name: string;
  values: string[];
};
type VariantCombination = {
  id: string;
  sku: string;
  attributes: Array<{ name: string; value: string }>;
  price: number;
  stock: number;
  status: "active" | "inactive" | "out_of_stock";
  primaryImage?: string;
  galleryImages?: string[];
};
type ProductVariantInput = {
  title: string;
  sku?: string;
  price: number;
  quantity: number;
  images: string[];
  variantAttributes?: VariantAttribute[];
  variantCombinations?: VariantCombination[];
};

function cleanToken(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function skuPart(value: string) {
  const normalized = cleanToken(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "");
  if (!normalized) {
    return "OPT";
  }
  if (/^\d+$/.test(normalized)) {
    return normalized;
  }
  const consonants = normalized.replace(/[AEIOU]/g, "");
  return (consonants || normalized).slice(0, 4);
}

function buildBaseProductCode(input: ProductVariantInput) {
  const source = input.sku?.trim() || input.title;
  const words = source
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/[^A-Za-z0-9]/g, ""))
    .filter(Boolean);

  if (words.length > 1) {
    return words
      .map((word) => word[0])
      .join("")
      .toUpperCase()
      .slice(0, 8);
  }

  return (words[0] ?? "SKU").toUpperCase().slice(0, 8);
}

function normalizeVariantAttributes(attributes?: VariantAttribute[]): VariantAttribute[] | undefined {
  const normalized = (attributes ?? [])
    .map((attribute) => {
      const name = cleanToken(attribute.name);
      const seen = new Set<string>();
      const values = attribute.values
        .map(cleanToken)
        .filter(Boolean)
        .filter((value) => {
          const key = value.toLowerCase();
          if (seen.has(key)) {
            return false;
          }
          seen.add(key);
          return true;
        });

      return { name, values };
    })
    .filter((attribute) => attribute.name && attribute.values.length > 0);

  return normalized.length > 0 ? normalized : undefined;
}

function buildCombinationId(attributes: Array<{ name: string; value: string }>) {
  return attributes
    .map((attribute) => `${skuPart(attribute.name)}-${skuPart(attribute.value)}`)
    .join("_")
    .toLowerCase();
}

function buildCombinationSku(productInput: ProductVariantInput, attributes: Array<{ name: string; value: string }>) {
  const base = buildBaseProductCode(productInput);
  return [base, ...attributes.map((attribute) => skuPart(attribute.value))].join("-");
}

function expandVariantCombinations(
  productInput: ProductVariantInput,
  attributes: VariantAttribute[]
): VariantCombination[] {
  const combinations = attributes.reduce<Array<Array<{ name: string; value: string }>>>(
    (current, attribute) => {
      const next: Array<Array<{ name: string; value: string }>> = [];
      for (const combination of current) {
        for (const value of attribute.values) {
          next.push([...combination, { name: attribute.name, value }]);
        }
      }
      return next;
    },
    [[]]
  );

  return combinations.map((combination) => ({
    id: buildCombinationId(combination),
    sku: buildCombinationSku(productInput, combination),
    attributes: combination,
    price: productInput.price,
    stock: productInput.quantity,
    status: productInput.quantity > 0 ? "active" : "out_of_stock",
    primaryImage: productInput.images[0],
  }));
}

function normalizeVariantCombinations(
  productInput: ProductVariantInput,
  attributes?: VariantAttribute[]
): VariantCombination[] | undefined {
  if (!attributes || attributes.length === 0) {
    return undefined;
  }

  const allowedValues = new Map(
    attributes.map((attribute) => [
      attribute.name.toLowerCase(),
      new Set(attribute.values.map((value) => value.toLowerCase())),
    ])
  );

  const combinations =
    productInput.variantCombinations && productInput.variantCombinations.length > 0
      ? productInput.variantCombinations
      : expandVariantCombinations(productInput, attributes);

  const seenIds = new Set<string>();
  const seenSkus = new Set<string>();

  return combinations.map((combination) => {
    const normalizedAttributes = combination.attributes.map((attribute) => ({
      name: cleanToken(attribute.name),
      value: cleanToken(attribute.value),
    }));

    if (normalizedAttributes.length !== attributes.length) {
      throw new Error("Each variant combination must include every selected attribute");
    }

    for (const attribute of normalizedAttributes) {
      const values = allowedValues.get(attribute.name.toLowerCase());
      if (!values?.has(attribute.value.toLowerCase())) {
        throw new Error(`Invalid variant value: ${attribute.name} ${attribute.value}`);
      }
    }

    const id = cleanToken(combination.id) || buildCombinationId(normalizedAttributes);
    const sku = cleanToken(combination.sku) || buildCombinationSku(productInput, normalizedAttributes);
    const skuKey = sku.toUpperCase();

    if (seenIds.has(id)) {
      throw new Error(`Duplicate variant ID: ${id}`);
    }
    if (seenSkus.has(skuKey)) {
      throw new Error(`Duplicate variant SKU: ${sku}`);
    }

    seenIds.add(id);
    seenSkus.add(skuKey);

    const stock = Math.max(0, Math.trunc(combination.stock));
    return {
      ...combination,
      id,
      sku,
      attributes: normalizedAttributes,
      price: Math.max(0, combination.price),
      stock,
      status: stock <= 0 ? "out_of_stock" : combination.status,
    };
  });
}

async function ensureUniqueProductSkus(
  ctx: MutationCtx,
  productInput: ProductVariantInput,
  currentProductId?: Id<"products">
) {
  const skus = [productInput.sku, ...(productInput.variantCombinations ?? []).map((combination) => combination.sku)]
    .map((sku) => sku?.trim())
    .filter((sku): sku is string => Boolean(sku));
  const uniqueSkus = new Set(skus.map((sku) => sku.toUpperCase()));

  if (uniqueSkus.size !== skus.length) {
    throw new Error("Product and variant SKUs must be unique");
  }

  const products = await ctx.db.query("products").collect();
  for (const product of products) {
    if (currentProductId && product._id === currentProductId) {
      continue;
    }

    const otherSkus = [
      product.sku,
      ...((product.variantCombinations ?? []) as VariantCombination[]).map((combination) => combination.sku),
    ]
      .map((sku) => sku?.trim().toUpperCase())
      .filter((sku): sku is string => Boolean(sku));

    for (const sku of otherSkus) {
      if (uniqueSkus.has(sku)) {
        throw new Error(`SKU already exists: ${sku}`);
      }
    }
  }
}

async function normalizeProductVariantFields(
  ctx: MutationCtx,
  productInput: ProductVariantInput,
  currentProductId?: Id<"products">
) {
  const variantAttributes = normalizeVariantAttributes(productInput.variantAttributes);
  const variantCombinations = normalizeVariantCombinations({ ...productInput, variantAttributes }, variantAttributes);

  const normalizedProductInput = {
    ...productInput,
    variantAttributes,
    variantCombinations,
  };

  await ensureUniqueProductSkus(ctx, normalizedProductInput, currentProductId);

  return {
    variantAttributes,
    variantCombinations,
    quantity: variantCombinations
      ? variantCombinations.reduce((sum, combination) => sum + combination.stock, 0)
      : productInput.quantity,
  };
}

async function notifyUser(
  ctx: MutationCtx,
  userId: ProductDoc["sellerId"],
  type: "product_submitted" | "listing_approved" | "listing_rejected" | "listing_changes_requested" | "low_stock",
  title: string,
  message: string,
  data?: Record<string, unknown>
) {
  await ctx.db.insert("notifications", {
    userId,
    type,
    title,
    message,
    data,
    isRead: false,
    createdAt: Date.now(),
  });
}

async function notifyReviewers(ctx: MutationCtx, product: Pick<ProductDoc, "_id" | "title" | "sellerId">) {
  const reviewerGroups = await Promise.all([
    ctx.db
      .query("users")
      .withIndex("by_role", (q) => q.eq("role", "admin"))
      .collect(),
    ctx.db
      .query("users")
      .withIndex("by_role", (q) => q.eq("role", "moderator"))
      .collect(),
  ]);
  const reviewers = reviewerGroups.flat();

  await Promise.all(
    reviewers.map((reviewer) =>
      notifyUser(
        ctx,
        reviewer._id,
        "product_submitted",
        "Listing submitted for review",
        `${product.title} is waiting for moderation.`,
        { productId: product._id, sellerId: product.sellerId }
      )
    )
  );
}

async function isProductPublic(ctx: ReaderCtx, product: Pick<ProductDoc, "sellerId" | "status">) {
  return product.status === "active" && (await isPublicStorefrontSeller(ctx, product.sellerId));
}

// The one rule for a product's customer-facing fields: public listings, plus the owner and staff viewers. Pass the
// verified viewer from `optionalUser` or `requireUser`. Never pass a caller-supplied user.
export async function canViewerSeeProduct(ctx: ReaderCtx, product: ProductDoc, viewer: Doc<"users"> | null) {
  if (canViewerInspectProduct(product, viewer)) {
    return true;
  }
  return await isProductPublic(ctx, product);
}

async function enrichProduct(ctx: ReaderCtx, product: ProductDoc) {
  const seller = await buildSellerPublicProfile(ctx, product.sellerId);
  const category = await ctx.db.get(product.categoryId);
  const subcategory = product.subcategoryId ? await ctx.db.get(product.subcategoryId) : null;
  const classification = product.classificationId ? await ctx.db.get(product.classificationId) : null;

  return {
    ...product,
    seller,
    category,
    subcategory,
    classification,
  };
}

function hasCustomerFacingChanges(updates: Record<string, unknown>) {
  const customerFacingKeys = [
    "title",
    "brand",
    "sku",
    "shortDescription",
    "description",
    "keyFeatures",
    "price",
    "compareAtPrice",
    "categoryId",
    "subcategoryId",
    "classificationId",
    "images",
    "imageMetadata",
    "condition",
    "quantity",
    "lowStockThreshold",
    "availabilityStatus",
    "preorder",
    "variants",
    "variantAttributes",
    "variantCombinations",
    "addOns",
    "bulkPricing",
    "dimensions",
    "weightKg",
    "packageDimensions",
    "packageWeightKg",
    "warranty",
    "countryOfOrigin",
    "modelNumber",
    "manufacturerPartNumber",
    "material",
    "color",
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
    ...productMutationArgs,
    status: v.optional(v.union(v.literal("draft"), v.literal("pending_review"))),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const listingActor = await resolveListingActor(ctx, actor);
    const { status, ...productInput } = args;
    const nextStatus = status ?? "draft";
    const now = Date.now();
    const normalizedVariantFields = await normalizeProductVariantFields(ctx, productInput);
    const normalizedProductInput = {
      ...productInput,
      ...normalizedVariantFields,
    };

    const productId = await ctx.db.insert("products", {
      ...normalizedProductInput,
      sellerId: listingActor.sellerId,
      managedByUserId: actor._id,
      status: nextStatus,
      submittedAt: nextStatus === "pending_review" ? now : undefined,
      views: 0,
      createdAt: now,
      updatedAt: now,
    });

    if (nextStatus === "pending_review") {
      await notifyReviewers(ctx, {
        _id: productId,
        title: normalizedProductInput.title,
        sellerId: listingActor.sellerId,
      });
    }

    return productId;
  },
});

// Get product by ID
export const getProduct = query({
  args: {
    productId: v.id("products"),
  },
  handler: async (ctx, args) => {
    const product = await ctx.db.get(args.productId);
    if (!product) {
      return null;
    }

    const viewer = await optionalUser(ctx);
    const canInspectHidden = canViewerInspectProduct(product, viewer);

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
  },
  handler: async (ctx, args) => {
    let productsQuery = ctx.db.query("products").withIndex("by_seller", (q) => q.eq("sellerId", args.sellerId));

    if (args.status) {
      productsQuery = productsQuery.filter((q) => q.eq(q.field("status"), args.status));
    }

    const products = await productsQuery.order("desc").collect();
    const viewer = await optionalUser(ctx);
    const canInspectHidden = viewer !== null && (viewer._id === args.sellerId || isStaffViewer(viewer));

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
    status: v.optional(productStatusValidator),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const listingActor = await resolveListingActor(ctx, actor);
    const sellerId = listingActor.sellerId;

    let productsQuery = ctx.db.query("products").withIndex("by_seller", (q) => q.eq("sellerId", sellerId));

    if (args.status) {
      productsQuery = productsQuery.filter((q) => q.eq(q.field("status"), args.status));
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
      await Promise.all(products.map(async (product) => ((await isProductPublic(ctx, product)) ? product : null)))
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
      await Promise.all(products.map(async (product) => ((await isProductPublic(ctx, product)) ? product : null)))
    ).filter((product) => product !== null);

    return visibleProducts.slice(0, limit);
  },
});

// Get products by L3 classification
export const getProductsByClassification = query({
  args: {
    classificationId: v.id("categories"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 20;

    const products = await ctx.db
      .query("products")
      .withIndex("by_classification", (q) => q.eq("classificationId", args.classificationId))
      .filter((q) => q.eq(q.field("status"), "active"))
      .order("desc")
      .take(limit * 3);

    const visibleProducts = (
      await Promise.all(products.map(async (product) => ((await isProductPublic(ctx, product)) ? product : null)))
    ).filter((product) => product !== null);

    return visibleProducts.slice(0, limit);
  },
});

export const getProductsByBrand = query({
  args: {
    brand: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;
    const normalizedBrand = args.brand.trim().toLowerCase();

    if (!normalizedBrand) {
      return [];
    }

    const products = await ctx.db
      .query("products")
      .withIndex("by_status_created", (q) => q.eq("status", "active"))
      .order("desc")
      .take(limit * 6);

    const visibleProducts = (
      await Promise.all(
        products.map(async (product) => {
          const matchesBrand = product.brand?.trim().toLowerCase() === normalizedBrand;
          if (!matchesBrand || !(await isProductPublic(ctx, product))) {
            return null;
          }
          return product;
        })
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
    subcategoryId: v.optional(v.id("categories")),
    classificationId: v.optional(v.id("categories")),
    condition: v.optional(productConditionValidator),
    minPrice: v.optional(v.number()),
    maxPrice: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 20;

    const searchQuery = ctx.db.query("products").withSearchIndex("search_products", (q) => {
      let search = q.search("title", args.query);
      if (args.categoryId) {
        search = search.eq("categoryId", args.categoryId);
      }
      if (args.subcategoryId) {
        search = search.eq("subcategoryId", args.subcategoryId);
      }
      if (args.classificationId) {
        search = search.eq("classificationId", args.classificationId);
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
      await Promise.all(results.map(async (product) => ((await isProductPublic(ctx, product)) ? product : null)))
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
      await Promise.all(products.map(async (product) => ((await isProductPublic(ctx, product)) ? product : null)))
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
      await Promise.all(products.map(async (product) => ((await isProductPublic(ctx, product)) ? product : null)))
    ).filter((product) => product !== null);

    return visibleProducts.sort((left, right) => right.views - left.views).slice(0, limit);
  },
});

// Update product
export const updateProduct = mutation({
  args: {
    productId: v.id("products"),
    title: v.optional(v.string()),
    brand: v.optional(v.string()),
    sku: v.optional(v.string()),
    shortDescription: v.optional(v.string()),
    description: v.optional(v.string()),
    keyFeatures: v.optional(v.array(v.string())),
    price: v.optional(v.number()),
    compareAtPrice: v.optional(v.number()),
    categoryId: v.optional(v.id("categories")),
    subcategoryId: v.optional(v.id("categories")),
    classificationId: v.optional(v.id("categories")),
    images: v.optional(v.array(v.string())),
    imageMetadata: v.optional(v.array(productImageMetadataValidator)),
    condition: v.optional(productConditionValidator),
    quantity: v.optional(v.number()),
    lowStockThreshold: v.optional(v.number()),
    availabilityStatus: v.optional(availabilityStatusValidator),
    preorder: v.optional(
      v.object({
        isPreorder: v.boolean(),
        expectedShipDate: v.optional(v.number()),
        depositPercent: v.optional(v.number()),
      })
    ),
    variants: v.optional(v.array(productVariantValidator)),
    variantAttributes: v.optional(v.array(variantAttributeValidator)),
    variantCombinations: v.optional(v.array(variantCombinationValidator)),
    addOns: v.optional(v.array(productAddOnValidator)),
    bulkPricing: v.optional(v.array(bulkPricingTierValidator)),
    dimensions: v.optional(dimensionsValidator),
    weightKg: v.optional(v.number()),
    packageDimensions: v.optional(dimensionsValidator),
    packageWeightKg: v.optional(v.number()),
    warranty: v.optional(warrantyValidator),
    countryOfOrigin: v.optional(v.string()),
    modelNumber: v.optional(v.string()),
    manufacturerPartNumber: v.optional(v.string()),
    material: v.optional(v.string()),
    color: v.optional(v.string()),
    specifications: v.optional(v.array(v.object({ key: v.string(), value: v.string() }))),
    tags: v.optional(v.array(v.string())),
    location: v.optional(v.object({ city: v.string(), province: v.string() })),
    shippingOptions: v.optional(v.array(shippingOptionValidator)),
    status: v.optional(v.union(v.literal("draft"), v.literal("pending_review"))),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const product = await ctx.db.get(args.productId);
    if (!product) {
      throw new Error("Product not found");
    }

    const canManage = await canActorManageProduct(ctx, actor, product);
    if (!canManage) {
      throw new Error("Unauthorized");
    }

    const { productId, status, ...updates } = args;
    const filteredUpdates = Object.fromEntries(Object.entries(updates).filter(([_, value]) => value !== undefined));
    const mergedProductInput = {
      title: (filteredUpdates.title as string | undefined) ?? product.title,
      sku: (filteredUpdates.sku as string | undefined) ?? product.sku,
      price: (filteredUpdates.price as number | undefined) ?? product.price,
      quantity: (filteredUpdates.quantity as number | undefined) ?? product.quantity,
      images: (filteredUpdates.images as string[] | undefined) ?? product.images,
      variantAttributes:
        (filteredUpdates.variantAttributes as VariantAttribute[] | undefined) ?? product.variantAttributes,
      variantCombinations:
        (filteredUpdates.variantCombinations as VariantCombination[] | undefined) ?? product.variantCombinations,
    };
    const normalizedVariantFields = await normalizeProductVariantFields(ctx, mergedProductInput, productId);
    const normalizedUpdates =
      "variantAttributes" in filteredUpdates ||
      "variantCombinations" in filteredUpdates ||
      "quantity" in filteredUpdates ||
      "price" in filteredUpdates ||
      "sku" in filteredUpdates ||
      "title" in filteredUpdates ||
      "images" in filteredUpdates
        ? { ...filteredUpdates, ...normalizedVariantFields }
        : filteredUpdates;

    const now = Date.now();
    const shouldResubmitActiveListing = product.status === "active" && hasCustomerFacingChanges(normalizedUpdates);

    await ctx.db.patch(productId, {
      ...normalizedUpdates,
      managedByUserId: actor._id,
      status: status ?? (shouldResubmitActiveListing ? "pending_review" : product.status),
      submittedAt: status === "pending_review" || shouldResubmitActiveListing ? now : product.submittedAt,
      updatedAt: now,
    });

    if (status === "pending_review" || shouldResubmitActiveListing) {
      await notifyReviewers(ctx, {
        _id: productId,
        title: (filteredUpdates.title as string | undefined) ?? product.title,
        sellerId: product.sellerId,
      });
    }

    return await ctx.db.get(productId);
  },
});

export const submitForReview = mutation({
  args: {
    productId: v.id("products"),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const product = await ctx.db.get(args.productId);
    if (!product) {
      throw new Error("Product not found");
    }

    const canManage = await canActorManageProduct(ctx, actor, product);
    if (!canManage) {
      throw new Error("Unauthorized");
    }

    if (!["draft", "changes_requested"].includes(product.status)) {
      throw new Error("Only draft or changes-requested listings can be submitted");
    }

    await ctx.db.patch(args.productId, {
      status: "pending_review",
      submittedAt: Date.now(),
      managedByUserId: actor._id,
      updatedAt: Date.now(),
    });

    await notifyReviewers(ctx, product);

    return await ctx.db.get(args.productId);
  },
});

export const getPendingReviewListings = query({
  args: {
    reviewerId: v.id("users"),
    status: v.optional(v.union(v.literal("pending_review"), v.literal("changes_requested"))),
  },
  handler: async (ctx, args) => {
    await ensureReviewerActor(ctx);
    const status = args.status ?? "pending_review";

    const products = await ctx.db
      .query("products")
      .withIndex("by_status", (q) => q.eq("status", status))
      .order("desc")
      .collect();

    return await Promise.all(products.map(async (product) => enrichProduct(ctx, product)));
  },
});

export const reviewListing = mutation({
  args: {
    productId: v.id("products"),
    reviewerId: v.id("users"),
    decision: v.union(
      v.literal("approved"),
      v.literal("changes_requested"),
      v.literal("rejected"),
      v.literal("suspended")
    ),
    reviewNotes: v.optional(v.string()),
    correctedCategoryId: v.optional(v.id("categories")),
    correctedSubcategoryId: v.optional(v.id("categories")),
    correctedClassificationId: v.optional(v.id("categories")),
    skuOverride: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const reviewer = await ensureReviewerActor(ctx);

    const product = await ctx.db.get(args.productId);
    if (!product) {
      throw new Error("Product not found");
    }

    const status =
      args.decision === "approved"
        ? "active"
        : args.decision === "changes_requested"
          ? "changes_requested"
          : args.decision === "rejected"
            ? "rejected"
            : "suspended";

    await ctx.db.patch(args.productId, {
      status,
      reviewNotes: args.reviewNotes,
      categoryId: args.correctedCategoryId ?? product.categoryId,
      subcategoryId: args.correctedSubcategoryId ?? product.subcategoryId,
      classificationId: args.correctedClassificationId ?? product.classificationId,
      sku: args.skuOverride?.trim() || product.sku,
      reviewedByUserId: reviewer._id,
      reviewedAt: Date.now(),
      updatedAt: Date.now(),
    });

    if (args.decision === "approved") {
      await notifyUser(
        ctx,
        product.sellerId,
        "listing_approved",
        "Listing approved",
        `${product.title} is now live on Gettitonline.`,
        { productId: product._id }
      );
    } else if (args.decision === "changes_requested") {
      await notifyUser(
        ctx,
        product.sellerId,
        "listing_changes_requested",
        "Listing changes requested",
        args.reviewNotes ?? "Please update your listing and resubmit it for review.",
        { productId: product._id }
      );
    } else if (args.decision === "rejected") {
      await notifyUser(
        ctx,
        product.sellerId,
        "listing_rejected",
        "Listing rejected",
        args.reviewNotes ?? "This listing does not meet Gettitonline publishing standards.",
        { productId: product._id }
      );
    }

    return await ctx.db.get(args.productId);
  },
});

export const bulkReviewListings = mutation({
  args: {
    productIds: v.array(v.id("products")),
    reviewerId: v.id("users"),
    decision: v.union(
      v.literal("approved"),
      v.literal("changes_requested"),
      v.literal("rejected"),
      v.literal("suspended")
    ),
    reviewNotes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const reviewer = await ensureReviewerActor(ctx);

    const status =
      args.decision === "approved"
        ? "active"
        : args.decision === "changes_requested"
          ? "changes_requested"
          : args.decision === "rejected"
            ? "rejected"
            : "suspended";
    const updatedProductIds: Array<Id<"products">> = [];
    const now = Date.now();

    for (const productId of args.productIds) {
      const product = await ctx.db.get(productId);
      if (!product) {
        continue;
      }

      await ctx.db.patch(productId, {
        status,
        reviewNotes: args.reviewNotes,
        reviewedByUserId: reviewer._id,
        reviewedAt: now,
        updatedAt: now,
      });

      if (args.decision === "approved") {
        await notifyUser(
          ctx,
          product.sellerId,
          "listing_approved",
          "Listing approved",
          `${product.title} is now live on Gettitonline.`,
          { productId: product._id }
        );
      } else if (args.decision === "changes_requested") {
        await notifyUser(
          ctx,
          product.sellerId,
          "listing_changes_requested",
          "Listing changes requested",
          args.reviewNotes ?? "Please update your listing and resubmit it for review.",
          { productId: product._id }
        );
      } else if (args.decision === "rejected") {
        await notifyUser(
          ctx,
          product.sellerId,
          "listing_rejected",
          "Listing rejected",
          args.reviewNotes ?? "This listing does not meet Gettitonline publishing standards.",
          { productId: product._id }
        );
      }

      updatedProductIds.push(productId);
    }

    return { updatedCount: updatedProductIds.length, updatedProductIds };
  },
});

// Legacy moderation write, internal only: no client can call it. Its only caller, the retired Railway route, is gone, so
// the result rules of aiModerationData apply here too. The reviewer is rechecked by id, an error status is refused, and the
// summary and flags are normalised and checked. It keeps updatedAt, because moderation metadata is not a listing edit. It
// has no revision check, so it must not gain callers that write results for listings the seller may have changed.
export const storeListingModerationResult = internalMutation({
  args: {
    productId: v.id("products"),
    reviewerId: v.id("users"),
    status: aiModerationStatusValidator,
    summary: v.string(),
    flags: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const reviewer = await ctx.db.get(args.reviewerId);
    const decision = decideAccess({ subject: reviewer?.clerkId ?? null, user: reviewer });
    if (!decision.ok || !isReviewerRole(decision.user.role)) {
      throw new Error("Unauthorized");
    }

    const product = await ctx.db.get(args.productId);
    if (!product) {
      throw new Error("Product not found");
    }

    const summary = normalizeSummary(args.summary);
    if (args.status === "error" || summary === null || !areStorableFlags(args.flags)) {
      throw new Error("Invalid moderation result");
    }

    await ctx.db.patch(args.productId, {
      aiModerationStatus: args.status,
      aiModerationSummary: summary,
      aiModerationFlags: args.flags,
    });

    return await ctx.db.get(args.productId);
  },
});

// Delete product
export const deleteProduct = mutation({
  args: {
    productId: v.id("products"),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const product = await ctx.db.get(args.productId);
    if (!product) {
      throw new Error("Product not found");
    }

    const canManage = await canActorManageProduct(ctx, actor, product);
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
    if (!product || !(await isProductPublic(ctx, product))) {
      return;
    }

    await ctx.db.patch(args.productId, {
      views: product.views + 1,
    });
  },
});

// Mark product as sold
export const markAsSold = mutation({
  args: {
    productId: v.id("products"),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const product = await ctx.db.get(args.productId);
    if (!product) {
      throw new Error("Product not found");
    }

    const canManage = await canActorManageProduct(ctx, actor, product);
    if (!canManage) {
      throw new Error("Unauthorized");
    }

    await ctx.db.patch(args.productId, {
      status: "sold",
      managedByUserId: actor._id,
      updatedAt: Date.now(),
    });
  },
});

export const getManagedCatalogProducts = query({
  args: {
    status: v.optional(productStatusValidator),
  },
  handler: async (ctx, args) => {
    await ensureCatalogActor(ctx);
    const settings = await getPlatformSettings(ctx);
    if (!settings) {
      return [];
    }

    let productsQuery = ctx.db
      .query("products")
      .withIndex("by_seller", (q) => q.eq("sellerId", settings.companySellerUserId));

    if (args.status) {
      productsQuery = productsQuery.filter((q) => q.eq(q.field("status"), args.status));
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
    const moderator = await ensureReviewerActor(ctx);

    await ctx.db.patch(args.productId, {
      status: "suspended",
      reviewedByUserId: moderator._id,
      reviewedAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});

// Decrease product quantity
export const decreaseQuantity = internalMutation({
  args: {
    productId: v.id("products"),
    amount: v.number(),
  },
  handler: async (ctx, args) => {
    const product = await ctx.db.get(args.productId);
    if (!product) {
      throw new Error("Product not found");
    }

    const newQuantity = product.quantity - args.amount;
    if (newQuantity < 0) {
      throw new Error("Insufficient quantity");
    }

    await ctx.db.patch(args.productId, {
      quantity: newQuantity,
      status: newQuantity === 0 ? "sold" : product.status,
      availabilityStatus:
        newQuantity === 0
          ? "out_of_stock"
          : product.lowStockThreshold !== undefined && newQuantity <= product.lowStockThreshold
            ? "low_stock"
            : product.availabilityStatus,
      updatedAt: Date.now(),
    });

    if (
      product.lowStockThreshold !== undefined &&
      newQuantity <= product.lowStockThreshold &&
      product.quantity > product.lowStockThreshold
    ) {
      await notifyUser(
        ctx,
        product.sellerId,
        "low_stock",
        "Low stock alert",
        `${product.title} has ${newQuantity} unit(s) remaining.`,
        { productId: product._id, quantity: newQuantity }
      );
    }
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
        products.map(async (product) => (product && (await isProductPublic(ctx, product)) ? product : null))
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
        allProducts.map(async (product) => (product && (await isProductPublic(ctx, product)) ? product : null))
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

    return uniqueProducts.sort(() => Math.random() - 0.5).slice(0, limit);
  },
});
