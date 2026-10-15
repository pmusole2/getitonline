import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { optionalUser, requireUser } from "./lib/auth";
import { isReviewerRole } from "./lib/platform";

// A file with no `storageFiles` row is legacy: listing and profile images uploaded before ownership was recorded. Legacy
// and public files resolve for everyone. A private file resolves only for its owner and reviewers (admin, moderator).
// Storage ids are unguessable capabilities, but listing URLs expose them, so the claim window below limits what a
// registration can take over.
const CLAIM_WINDOW_MS = 10 * 60 * 1000;

const purposeValidator = v.union(v.literal("public"), v.literal("private"));

async function findOwnership(ctx: QueryCtx | MutationCtx, storageId: Id<"_storage">) {
  return await ctx.db
    .query("storageFiles")
    .withIndex("by_storage_id", (q) => q.eq("storageId", storageId))
    .first();
}

function canRead(row: Doc<"storageFiles"> | null, viewer: Doc<"users"> | null) {
  if (!row || row.purpose === "public") {
    return true;
  }
  if (!viewer) {
    return false;
  }
  return row.ownerUserId === viewer._id || isReviewerRole(viewer.role);
}

async function readableUrl(ctx: QueryCtx, storageId: Id<"_storage">, viewer: Doc<"users"> | null) {
  const row = await findOwnership(ctx, storageId);
  return canRead(row, viewer) ? await ctx.storage.getUrl(storageId) : null;
}

// Generate upload URL for client-side uploads. Only active accounts may upload.
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

// Get URL for a stored file, or null when the caller may not read it.
export const getUrl = query({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    const viewer = await optionalUser(ctx);
    return await readableUrl(ctx, args.storageId, viewer);
  },
});

// Get URLs for stored files. Files the caller may not read are omitted, as missing files are.
export const getUrls = query({
  args: { storageIds: v.array(v.id("_storage")) },
  handler: async (ctx, args) => {
    const viewer = await optionalUser(ctx);
    const urls = await Promise.all(args.storageIds.map((id) => readableUrl(ctx, id, viewer)));
    return urls.filter((url): url is string => url !== null);
  },
});

// Delete a stored file. The recorded owner or an admin may delete it; a legacy file with no row is admin-only.
export const deleteFile = mutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const row = await findOwnership(ctx, args.storageId);
    const allowed = row ? row.ownerUserId === actor._id || actor.role === "admin" : actor.role === "admin";
    if (!allowed) {
      throw new Error("Unauthorized");
    }

    await ctx.storage.delete(args.storageId);
    if (row) {
      await ctx.db.delete(row._id);
    }
  },
});

// Register an uploaded file to the signed-in caller. The owner is the verified caller, never a request argument.
// Only an unregistered file uploaded within the claim window can be registered; a registered file can be registered
// again only by its owner, and an owner can make their file private but not public again.
export const saveImageMetadata = mutation({
  args: {
    storageId: v.id("_storage"),
    fileName: v.string(),
    contentType: v.string(),
    size: v.number(),
    purpose: v.optional(purposeValidator),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const file = await ctx.db.system.get(args.storageId);
    if (!file) {
      throw new Error("File not found");
    }

    const row = await findOwnership(ctx, args.storageId);
    if (row) {
      if (row.ownerUserId !== actor._id) {
        throw new Error("Unauthorized");
      }
    } else if (Date.now() - file._creationTime > CLAIM_WINDOW_MS) {
      throw new Error("Unauthorized");
    }

    const purpose = args.purpose ?? "public";
    if (!row) {
      await ctx.db.insert("storageFiles", {
        storageId: args.storageId,
        ownerUserId: actor._id,
        purpose,
        createdAt: Date.now(),
      });
    } else if (purpose === "private" && row.purpose === "public") {
      await ctx.db.patch(row._id, { purpose: "private" });
    }

    return {
      storageId: args.storageId,
      url: await ctx.storage.getUrl(args.storageId),
      fileName: args.fileName,
      contentType: args.contentType,
      size: args.size,
    };
  },
});
