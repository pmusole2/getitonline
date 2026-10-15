import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { optionalUser, requireUser } from "./lib/auth";
import {
  DEFAULT_COMPANY_DISPLAY_NAME,
  ensureAdminActor,
  getCompanySellerUserId,
  getPlatformSettings,
  getVendorProfileByOwnerId,
  isStaffViewer,
  normalizeOptionalExternalUrl,
  vendorStatusValidator,
} from "./lib/platform";

function slugifyStoreName(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "store"
  );
}

async function ensureUniqueSlug(
  ctx: QueryCtx | MutationCtx,
  baseSlug: string,
  currentVendorProfileId?: Id<"vendorProfiles">
) {
  let slug = baseSlug;
  let suffix = 1;

  for (;;) {
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
    const applicant = await requireUser(ctx);
    const existingProfile = await getVendorProfileByOwnerId(ctx, applicant._id);
    const now = Date.now();
    const slug = await ensureUniqueSlug(ctx, slugifyStoreName(args.storeName), existingProfile?._id);

    const nextStatus = existingProfile?.status === "approved" ? "approved" : "pending";
    const normalizedArgs = {
      ...args,
      logoUrl: normalizeOptionalExternalUrl(args.logoUrl),
      bannerUrl: normalizeOptionalExternalUrl(args.bannerUrl),
      socialLinks: args.socialLinks
        ? {
            website: normalizeOptionalExternalUrl(args.socialLinks.website),
            instagram: normalizeOptionalExternalUrl(args.socialLinks.instagram),
            facebook: normalizeOptionalExternalUrl(args.socialLinks.facebook),
          }
        : undefined,
    };

    if (existingProfile) {
      await ctx.db.patch(existingProfile._id, {
        ...normalizedArgs,
        ownerUserId: applicant._id,
        slug,
        status: nextStatus,
        updatedAt: now,
      });

      return await ctx.db.get(existingProfile._id);
    }

    const vendorProfileId = await ctx.db.insert("vendorProfiles", {
      ...normalizedArgs,
      ownerUserId: applicant._id,
      slug,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });

    return await ctx.db.get(vendorProfileId);
  },
});

export const getMyVendorProfile = query({
  args: {},
  handler: async (ctx) => {
    const vendor = await requireUser(ctx);
    return await getVendorProfileByOwnerId(ctx, vendor._id);
  },
});

export const getVendorStorefront = query({
  args: {
    sellerId: v.id("users"),
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

    const viewer = await optionalUser(ctx);
    const canView = vendorProfile.status === "approved" || viewer?._id === args.sellerId || isStaffViewer(viewer);

    if (!canView) {
      return null;
    }

    return {
      sellerId: args.sellerId,
      ownerUserId: vendorProfile.ownerUserId,
      storeName: vendorProfile.storeName,
      displayName: vendorProfile.storeName,
      description: vendorProfile.description,
      logoUrl: normalizeOptionalExternalUrl(vendorProfile.logoUrl) ?? seller.avatar,
      bannerUrl: normalizeOptionalExternalUrl(vendorProfile.bannerUrl),
      slug: vendorProfile.slug,
      socialLinks: vendorProfile.socialLinks,
      status: vendorProfile.status,
      reviewNotes: vendorProfile.reviewNotes,
      isCompanyStore: false,
      rating: seller.rating,
      totalSales: seller.totalSales,
    };
  },
});

export const listPublicStorefronts = query({
  args: {},
  handler: async (ctx) => {
    const settings = await getPlatformSettings(ctx);
    const approvedVendorProfiles = await ctx.db
      .query("vendorProfiles")
      .withIndex("by_status", (q) => q.eq("status", "approved"))
      .collect();

    const companyStore = settings?.companySellerUserId ? await ctx.db.get(settings.companySellerUserId) : null;

    const vendorStores = await Promise.all(
      approvedVendorProfiles
        .filter((vendorProfile) => vendorProfile.ownerUserId !== settings?.companySellerUserId)
        .map(async (vendorProfile) => {
          const owner = await ctx.db.get(vendorProfile.ownerUserId);
          if (!owner) {
            return null;
          }

          return {
            sellerId: vendorProfile.ownerUserId,
            displayName: vendorProfile.storeName,
            description: vendorProfile.description,
            logoUrl: normalizeOptionalExternalUrl(vendorProfile.logoUrl) ?? owner.avatar,
            bannerUrl: normalizeOptionalExternalUrl(vendorProfile.bannerUrl),
            slug: vendorProfile.slug,
            isCompanyStore: false,
            rating: owner.rating,
            totalSales: owner.totalSales,
          };
        })
    );

    const publicStores = vendorStores
      .filter((storefront) => storefront !== null)
      .sort((left, right) => left.displayName.localeCompare(right.displayName));

    if (!settings?.companySellerUserId || !companyStore) {
      return publicStores;
    }

    return [
      {
        sellerId: settings.companySellerUserId,
        displayName: settings.companyDisplayName,
        description: `${settings.companyDisplayName} official storefront`,
        logoUrl: companyStore.avatar,
        bannerUrl: undefined,
        slug: "official-store",
        isCompanyStore: true,
        rating: companyStore.rating,
        totalSales: companyStore.totalSales,
      },
      ...publicStores,
    ];
  },
});

export const getPendingApplications = query({
  args: {
    adminId: v.id("users"),
    status: v.optional(vendorStatusValidator),
  },
  handler: async (ctx, args) => {
    await ensureAdminActor(ctx);

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

export const listVendorStoresForAdmin = query({
  args: {
    adminId: v.id("users"),
  },
  handler: async (ctx) => {
    await ensureAdminActor(ctx);

    const vendorProfiles = await ctx.db.query("vendorProfiles").collect();
    const counts = {
      all: vendorProfiles.length,
      pending: 0,
      approved: 0,
      changes_requested: 0,
      suspended: 0,
    };

    const items = await Promise.all(
      vendorProfiles.map(async (vendorProfile) => {
        counts[vendorProfile.status] += 1;

        const owner = await ctx.db.get(vendorProfile.ownerUserId);
        const ownerName = owner ? `${owner.firstName} ${owner.lastName}`.trim() || "Unknown user" : "Unknown user";

        return {
          vendorProfileId: vendorProfile._id,
          ownerUserId: vendorProfile.ownerUserId,
          ownerName,
          ownerEmail: owner?.email ?? vendorProfile.contactEmail,
          storeName: vendorProfile.storeName,
          description: vendorProfile.description,
          logoUrl: normalizeOptionalExternalUrl(vendorProfile.logoUrl),
          bannerUrl: normalizeOptionalExternalUrl(vendorProfile.bannerUrl),
          status: vendorProfile.status,
          reviewNotes: vendorProfile.reviewNotes,
          reviewedAt: vendorProfile.reviewedAt,
          contactEmail: vendorProfile.contactEmail,
          contactPhone: vendorProfile.contactPhone,
          address: vendorProfile.address,
          slug: vendorProfile.slug,
          updatedAt: vendorProfile.updatedAt,
        };
      })
    );

    return {
      counts,
      items: items.sort((left, right) => right.updatedAt - left.updatedAt),
    };
  },
});

export const reviewApplication = mutation({
  args: {
    adminId: v.id("users"),
    vendorProfileId: v.id("vendorProfiles"),
    decision: v.union(v.literal("approved"), v.literal("changes_requested"), v.literal("suspended")),
    reviewNotes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const admin = await ensureAdminActor(ctx);

    const vendorProfile = await ctx.db.get(args.vendorProfileId);
    if (!vendorProfile) {
      throw new Error("Vendor application not found");
    }

    await ctx.db.patch(args.vendorProfileId, {
      status: args.decision,
      reviewNotes: args.reviewNotes,
      reviewedByUserId: admin._id,
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
  handler: async (ctx) => {
    const admin = await ensureAdminActor(ctx);

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

    const legacyProducts = products.flat().filter((product) => product.sellerId !== companySellerUserId);

    const now = Date.now();

    for (const product of legacyProducts) {
      await ctx.db.patch(product._id, {
        status: "changes_requested",
        reviewNotes: "This listing was moved to the new vendor workflow. Apply as a vendor and resubmit it for review.",
        reviewedAt: now,
        reviewedByUserId: admin._id,
        updatedAt: now,
      });
    }

    return {
      migratedCount: legacyProducts.length,
      companyDisplayName: (await getPlatformSettings(ctx))?.companyDisplayName ?? DEFAULT_COMPANY_DISPLAY_NAME,
    };
  },
});
