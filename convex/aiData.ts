import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { internalQuery } from "./_generated/server";
import { decideAccess, loadAccountState, type AccessDenial } from "./lib/auth";
import {
  CART_KEYWORDS,
  CHAT_LIMITS,
  LISTING_KEYWORDS,
  ORDER_KEYWORDS,
  mentionsAny,
  searchTerms,
  type CatalogItem,
  type ChatAccountActivity,
  type ChatContext,
  type OrderCounts,
} from "./lib/aiChatPolicy";
import { isPublicStorefrontSeller } from "./lib/platform";

// Internal reads for Pinkie's chat action. The action passes the caller it verified itself; a guest caller carries no
// account id, so guest context cannot include any account data.

const CATALOG_SCAN_LIMIT = 200;
const MATCH_LIMIT = 10;
const RECENT_LIMIT = 10;
const CATEGORY_LIMIT = 10;
const ACCOUNT_SCAN_LIMIT = 500;
const CART_SCAN_LIMIT = 200;

const PENDING_STATUSES = new Set<string>(["pending_payment", "paid", "processing", "shipped"]);
const COMPLETED_STATUSES = new Set<string>(["delivered", "completed"]);

export type ChatAccountResolution = { ok: true; userId: Id<"users"> } | { ok: false; reason: AccessDenial };

export const resolveChatAccount = internalQuery({
  args: { clerkId: v.string() },
  handler: async (ctx, args): Promise<ChatAccountResolution> => {
    const user = await loadAccountState(ctx, args.clerkId);
    const decision = decideAccess({ subject: args.clerkId, user });
    return decision.ok ? { ok: true, userId: decision.user._id } : { ok: false, reason: decision.reason };
  },
});

const chatCallerValidator = v.union(
  v.object({ kind: v.literal("account"), userId: v.id("users") }),
  v.object({ kind: v.literal("guest") })
);

function truncate(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) : text;
}

async function categoryNames(ctx: QueryCtx, products: Doc<"products">[]): Promise<Map<Id<"categories">, string>> {
  const names = new Map<Id<"categories">, string>();
  for (const product of products) {
    if (names.has(product.categoryId)) {
      continue;
    }
    const category = await ctx.db.get(product.categoryId);
    names.set(product.categoryId, category?.name ?? "Uncategorized");
  }
  return names;
}

// Active products from public sellers only, newest first. Seller visibility is checked once per seller. `truncated` is
// true when the scan hit its limit, so the listing count is a sample of the newest listings.
async function visibleActiveProducts(ctx: QueryCtx): Promise<{ products: Doc<"products">[]; truncated: boolean }> {
  const products = await ctx.db
    .query("products")
    .withIndex("by_status_created", (q) => q.eq("status", "active"))
    .order("desc")
    .take(CATALOG_SCAN_LIMIT);

  const publicSellers = new Map<Id<"users">, boolean>();
  const visible: Doc<"products">[] = [];
  for (const product of products) {
    let isPublic = publicSellers.get(product.sellerId);
    if (isPublic === undefined) {
      isPublic = await isPublicStorefrontSeller(ctx, product.sellerId);
      publicSellers.set(product.sellerId, isPublic);
    }
    if (isPublic) {
      visible.push(product);
    }
  }
  return { products: visible, truncated: products.length >= CATALOG_SCAN_LIMIT };
}

function toCatalogItem(
  product: Doc<"products">,
  categories: Map<Id<"categories">, string>,
  description: string
): CatalogItem {
  return {
    id: product._id,
    title: product.title,
    price: product.price,
    category: categories.get(product.categoryId) ?? "Uncategorized",
    condition: product.condition,
    description,
  };
}

function topCategories(
  products: Doc<"products">[],
  categories: Map<Id<"categories">, string>
): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const product of products) {
    const name = categories.get(product.categoryId) ?? "Uncategorized";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, CATEGORY_LIMIT);
}

function matchesTerms(item: CatalogItem, terms: string[]): boolean {
  const haystack = `${item.title} ${item.category}`.toLowerCase();
  return terms.some((term) => haystack.includes(term));
}

async function publicProductContext(ctx: QueryCtx, productId: Id<"products"> | undefined): Promise<CatalogItem | null> {
  if (productId === undefined) {
    return null;
  }
  const product = await ctx.db.get(productId);
  if (!product || product.status !== "active" || !(await isPublicStorefrontSeller(ctx, product.sellerId))) {
    return null;
  }
  const categories = await categoryNames(ctx, [product]);
  return toCatalogItem(product, categories, truncate(product.description, CHAT_LIMITS.itemDescriptionLength));
}

// `truncated` is set when the scan hit its limit, so every count is a lower bound over the newest rows.
function countOrders(orders: Array<Pick<Doc<"orders">, "status">>, scanLimit: number): OrderCounts {
  return {
    total: orders.length,
    pending: orders.filter((order) => PENDING_STATUSES.has(order.status)).length,
    completed: orders.filter((order) => COMPLETED_STATUSES.has(order.status)).length,
    disputed: orders.filter((order) => order.status === "disputed").length,
    truncated: orders.length >= scanLimit,
  };
}

// Counts only what the message asks about. Every count is over the caller's own rows, newest first, and capped.
async function accountActivity(ctx: QueryCtx, userId: Id<"users">, message: string): Promise<ChatAccountActivity> {
  const asksOrders = mentionsAny(message, ORDER_KEYWORDS);
  const asksListings = mentionsAny(message, LISTING_KEYWORDS);
  const asksCart = mentionsAny(message, CART_KEYWORDS);

  const [buyerOrders, sellerOrders, listings, cartLines] = await Promise.all([
    asksOrders
      ? ctx.db
          .query("orders")
          .withIndex("by_buyer", (q) => q.eq("buyerId", userId))
          .order("desc")
          .take(ACCOUNT_SCAN_LIMIT)
      : Promise.resolve(null),
    asksOrders
      ? ctx.db
          .query("orders")
          .withIndex("by_seller", (q) => q.eq("sellerId", userId))
          .order("desc")
          .take(ACCOUNT_SCAN_LIMIT)
      : Promise.resolve(null),
    asksListings
      ? ctx.db
          .query("products")
          .withIndex("by_seller", (q) => q.eq("sellerId", userId))
          .order("desc")
          .take(ACCOUNT_SCAN_LIMIT)
      : Promise.resolve(null),
    asksCart
      ? ctx.db
          .query("cartItems")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .take(CART_SCAN_LIMIT)
      : Promise.resolve(null),
  ]);

  return {
    orders: buyerOrders ? countOrders(buyerOrders, ACCOUNT_SCAN_LIMIT) : null,
    sellerOrders: sellerOrders ? countOrders(sellerOrders, ACCOUNT_SCAN_LIMIT) : null,
    listings: listings
      ? {
          total: listings.length,
          active: listings.filter((product) => product.status === "active").length,
          truncated: listings.length >= ACCOUNT_SCAN_LIMIT,
        }
      : null,
    cart: cartLines
      ? {
          items: cartLines.reduce((sum, line) => sum + line.quantity, 0),
          truncated: cartLines.length >= CART_SCAN_LIMIT,
        }
      : null,
  };
}

export const chatContext = internalQuery({
  args: {
    caller: chatCallerValidator,
    message: v.string(),
    productId: v.optional(v.id("products")),
  },
  handler: async (ctx, args): Promise<ChatContext> => {
    const { products: visible, truncated } = await visibleActiveProducts(ctx);
    const categories = await categoryNames(ctx, visible);
    const terms = searchTerms(args.message);
    const items = visible.map((product) =>
      toCatalogItem(
        product,
        categories,
        truncate(product.shortDescription ?? product.description, CHAT_LIMITS.itemDescriptionLength)
      )
    );
    const matches = items.filter((item) => matchesTerms(item, terms)).slice(0, MATCH_LIMIT);

    return {
      catalog: {
        activeListingCount: visible.length,
        truncated,
        categories: topCategories(visible, categories),
        matches,
        recent: items.slice(0, RECENT_LIMIT),
      },
      product: await publicProductContext(ctx, args.productId),
      account: args.caller.kind === "account" ? await accountActivity(ctx, args.caller.userId, args.message) : null,
    };
  },
});
