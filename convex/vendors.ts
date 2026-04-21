import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import {
  DEFAULT_COMPANY_DISPLAY_NAME,
  ensureAdminActor,
  getCompanySellerUserId,
  getPlatformSettings,
  getUserOrThrow,
  getVendorProfileByOwnerId,
  isStaffViewer,
  vendorStatusValidator,
} from "./lib/platform";

function slugifyStoreName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "store";
}

async function ensureUniqueSlug(
  ctx: QueryCtx | MutationCtx,
  baseSlug: string,
  currentVendorProfileId?: Id<"vendorProfiles">
) {
  let slug = baseSlug;
  let suffix = 1;

  while (true) {
    const existing = await ctx.db
      .query("vendorProfiles")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();

    if (!existing || existing._id === currentVendorProfileId) {
      return slug;
    }

    suffix += 1;
    slug = `${baseSlug}-${suffix}`;
  }
}

const vendorApplicationArgs = {
  ownerUserId: v.id("users"),
  storeName: v.string(),
  description: v.string(),
  logoUrl: v.optional(v.string()),
  bannerUrl: v.optional(v.string()),
  contactEmail: v.string(),
  contactPhone: v.optional(v.string()),
  address: v.object({
    street: v.string(),
    city: v.string(),
    province: v.string(),
    country: v.string(),
  }),
  socialLinks: v.optional(
    v.object({
      website: v.optional(v.string()),
      instagram: v.optional(v.string()),
      facebook: v.optional(v.string()),
    })
  ),
};

export const submitApplication = mutation({
  args: vendorApplicationArgs,
  handler: async (ctx, args) => {
    const user = await getUserOrThrow(ctx, args.ownerUserId);
    if (user.isBanned) {
      throw new Error("Banned users cannot submit vendor applications");
    }

    const existingProfile = await getVendorProfileByOwnerId(ctx, args.ownerUserId);
    const now = Date.now();
    const slug = await ensureUniqueSlug(
      ctx,
      slugifyStoreName(args.storeName),
      existingProfile?._id
    );

    const nextStatus =
      existingProfile?.status === "approved" ? "approved" : "pending";

    if (existingProfile) {
      await ctx.db.patch(existingProfile._id, {
        ...args,
        slug,
        status: nextStatus,
        updatedAt: now,
      });

      return await ctx.db.get(existingProfile._id);
    }

    const vendorProfileId = await ctx.db.insert("vendorProfiles", {
      ...args,
      slug,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });

    return await ctx.db.get(vendorProfileId);
  },
});

export const getMyVendorProfile = query({
  args: {
    ownerUserId: v.id("users"),
  },
  handler: async (ctx, args) => {
    return await getVendorProfileByOwnerId(ctx, args.ownerUserId);
  },
});

export const getVendorStorefront = query({
  args: {
    sellerId: v.id("users"),
    viewerUserId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    const settings = await getPlatformSettings(ctx);
    const seller = await ctx.db.get(args.sellerId);
    if (!seller) {
      return null;
    }

    if (settings?.companySellerUserId === args.sellerId) {
      return {
        sellerId: args.sellerId,
        ownerUserId: args.sellerId,
        storeName: settings.companyDisplayName,
        displayName: settings.companyDisplayName,
        description: `${settings.companyDisplayName} official storefront`,
        logoUrl: seller.avatar,
        bannerUrl: undefined,
        slug: "official-store",
        contactEmail: seller.email,
        contactPhone: seller.phone,
        address: seller.address ?? null,
        socialLinks: undefined,
        status: "approved" as const,
        isCompanyStore: true,
        rating: seller.rating,
        totalSales: seller.totalSales,
      };
    }

    const vendorProfile = await getVendorProfileByOwnerId(ctx, args.sellerId);
    if (!vendorProfile) {
      return null;
    }

    const canView = vendorProfile.status === "approved" ||
      args.viewerUserId === args.sellerId ||
      (await isStaffViewer(ctx, args.viewerUserId));

    if (!canView) {
      return null;
    }

    return {
      sellerId: args.sellerId,
      ownerUserId: vendorProfile.ownerUserId,
      storeName: vendorProfile.storeName,
      displayName: vendorProfile.storeName,
      description: vendorProfile.description,
      logoUrl: vendorProfile.logoUrl ?? seller.avatar,
      bannerUrl: vendorProfile.bannerUrl,
      slug: vendorProfile.slug,
      contactEmail: vendorProfile.contactEmail,
      contactPhone: vendorProfile.contactPhone,
      address: vendorProfile.address,
      socialLinks: vendorProfile.socialLinks,
      status: vendorProfile.status,
      reviewNotes: vendorProfile.reviewNotes,
      isCompanyStore: false,
      rating: seller.rating,
      totalSales: seller.totalSales,
    };
  },
});

export const getPendingApplications = query({
  args: {
    adminId: v.id("users"),
    status: v.optional(vendorStatusValidator),
  },
  handler: async (ctx, args) => {
    await ensureAdminActor(ctx, args.adminId);

    const status = args.status ?? "pending";
    const applications = await ctx.db
      .query("vendorProfiles")
      .withIndex("by_status", (q) => q.eq("status", status))
      .order("desc")
      .collect();

    return await Promise.all(
      applications.map(async (application) => ({
        ...application,
        owner: await ctx.db.get(application.ownerUserId),
      }))
    );
  },
});

export const reviewApplication = mutation({
  args: {
    adminId: v.id("users"),
    vendorProfileId: v.id("vendorProfiles"),
    decision: v.union(
      v.literal("approved"),
      v.literal("changes_requested"),
      v.literal("suspended")
    ),
    reviewNotes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ensureAdminActor(ctx, args.adminId);

    const vendorProfile = await ctx.db.get(args.vendorProfileId);
    if (!vendorProfile) {
      throw new Error("Vendor application not found");
    }

    await ctx.db.patch(args.vendorProfileId, {
      status: args.decision,
      reviewNotes: args.reviewNotes,
      reviewedByUserId: args.adminId,
      reviewedAt: Date.now(),
      updatedAt: Date.now(),
    });

    return await ctx.db.get(args.vendorProfileId);
  },
});

export const migrateLegacyVendorListings = mutation({
  args: {
    adminId: v.id("users"),
  },
  handler: async (ctx, args) => {
    await ensureAdminActor(ctx, args.adminId);

    const companySellerUserId = await getCompanySellerUserId(ctx);
    if (!companySellerUserId) {
      throw new Error("Company storefront is not configured");
    }

    const legacyStatuses = ["active", "draft", "suspended"] as const;
    const products = await Promise.all(
      legacyStatuses.map((status) =>
        ctx.db
          .query("products")
          .withIndex("by_status", (q) => q.eq("status", status))
          .collect()
      )
    );

    const legacyProducts = products
      .flat()
      .filter((product) => product.sellerId !== companySellerUserId);

    const now = Date.now();

    for (const product of legacyProducts) {
      await ctx.db.patch(product._id, {
        status: "changes_requested",
        reviewNotes:
          "This listing was moved to the new vendor workflow. Apply as a vendor and resubmit it for review.",
        reviewedAt: now,
        reviewedByUserId: args.adminId,
        updatedAt: now,
      });
    }

    return {
      migratedCount: legacyProducts.length,
      companyDisplayName:
        (await getPlatformSettings(ctx))?.companyDisplayName ??
        DEFAULT_COMPANY_DISPLAY_NAME,
    };
  },
});
