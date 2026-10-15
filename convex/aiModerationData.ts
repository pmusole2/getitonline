import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery } from "./_generated/server";
import { decideAccess } from "./lib/auth";
import { isReviewerRole } from "./lib/platform";
import {
  MODERATION_LIMITS,
  areStorableFlags,
  listingRevision,
  normalizeSummary,
  type StoredListing,
} from "./lib/aiModerationPolicy";

// Internal reads and the one persistence write for Pinkie's listing moderation. The action passes the account it verified
// itself, and each function rechecks that account against the reviewer role, so a non-reviewer is refused before any
// listing read or write. The listing revision is updatedAt plus a fingerprint of the reviewed content, so an edit is
// detected even when updatedAt does not move. A save is refused unless the revision recomputed from the stored document
// matches the one the action read. Moderation metadata and unreviewed fields do not change the revision.

export type ListingRead =
  | { ok: true; revision: string; updatedAt: number; listing: StoredListing }
  | { ok: false; code: "forbidden" | "not_found" | "listing_invalid" };

export type SaveResult =
  | { saved: true }
  | { saved: false; reason: "forbidden" | "not_found" | "stale" | "invalid_output" };

// The account must be current, not banned or deleted, and an admin or moderator. Anything else is treated as forbidden.
async function reviewerOf(ctx: QueryCtx | MutationCtx, userId: Id<"users">): Promise<Doc<"users"> | null> {
  const user = await ctx.db.get(userId);
  const decision = decideAccess({ subject: user?.clerkId ?? null, user });
  return decision.ok && isReviewerRole(decision.user.role) ? decision.user : null;
}

// The revision of a stored listing, recomputed from the document. The category name is included because the model reads it.
function revisionOf(product: Doc<"products">, categoryName: string): string {
  return listingRevision({
    updatedAt: product.updatedAt,
    title: product.title,
    description: product.description,
    price: product.price,
    quantity: product.quantity,
    categoryId: product.categoryId,
    categoryName,
    images: product.images,
    status: product.status,
  });
}

export const listingForModeration = internalQuery({
  args: { userId: v.id("users"), productId: v.id("products") },
  handler: async (ctx, args): Promise<ListingRead> => {
    if ((await reviewerOf(ctx, args.userId)) === null) {
      return { ok: false, code: "forbidden" };
    }
    const product = await ctx.db.get(args.productId);
    if (!product) {
      return { ok: false, code: "not_found" };
    }
    // A listing whose reviewed numbers are not finite is refused before any model call, so no reviewer sees a model verdict on a
    // value that cannot be a real price, quantity, or revision stamp.
    if (!Number.isFinite(product.price) || !Number.isFinite(product.quantity) || !Number.isFinite(product.updatedAt)) {
      return { ok: false, code: "listing_invalid" };
    }
    const category = await ctx.db.get(product.categoryId);
    return {
      ok: true,
      revision: revisionOf(product, category?.name ?? ""),
      updatedAt: product.updatedAt,
      listing: {
        title: product.title.slice(0, MODERATION_LIMITS.titleLength),
        description: product.description.slice(0, MODERATION_LIMITS.descriptionLength),
        price: product.price,
        quantity: product.quantity,
        imageUrls: product.images.slice(0, MODERATION_LIMITS.imageUrlCount),
        imageCount: product.images.length,
        categoryName: (category?.name ?? "").slice(0, MODERATION_LIMITS.categoryLength),
      },
    };
  },
});

// The only write moderation makes. It rechecks the reviewer, then the revision, and writes only a clear or flagged result.
// Refusals write nothing, so a stale result cannot overwrite a listing the seller has since changed.
export const saveModerationResult = internalMutation({
  args: {
    productId: v.id("products"),
    revision: v.string(),
    status: v.union(v.literal("clear"), v.literal("flagged")),
    summary: v.string(),
    flags: v.array(v.string()),
    reviewerId: v.id("users"),
  },
  handler: async (ctx, args): Promise<SaveResult> => {
    if ((await reviewerOf(ctx, args.reviewerId)) === null) {
      return { saved: false, reason: "forbidden" };
    }
    const product = await ctx.db.get(args.productId);
    if (!product) {
      return { saved: false, reason: "not_found" };
    }
    const category = await ctx.db.get(product.categoryId);
    if (revisionOf(product, category?.name ?? "") !== args.revision) {
      return { saved: false, reason: "stale" };
    }
    const summary = normalizeSummary(args.summary);
    if (summary === null || !areStorableFlags(args.flags)) {
      return { saved: false, reason: "invalid_output" };
    }
    await ctx.db.patch(args.productId, {
      aiModerationStatus: args.status,
      aiModerationSummary: summary,
      aiModerationFlags: args.flags,
    });
    return { saved: true };
  },
});
