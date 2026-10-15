import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { DEFAULT_COMPANY_DISPLAY_NAME, ensureAdminActor, getPlatformSettings } from "./lib/platform";
import { requireRole } from "./lib/auth";

export const getStorefront = query({
  args: {},
  handler: async (ctx) => {
    const settings = await getPlatformSettings(ctx);

    return {
      companyDisplayName: settings?.companyDisplayName ?? DEFAULT_COMPANY_DISPLAY_NAME,
      companySellerUserId: settings?.companySellerUserId ?? null,
      isConfigured: Boolean(settings?.companySellerUserId),
    };
  },
});

export const getPlatformSettingsForAdmin = query({
  args: {},
  handler: async (ctx) => {
    await requireRole(ctx, ["admin"]);

    const settings = await getPlatformSettings(ctx);
    const companySeller = settings?.companySellerUserId ? await ctx.db.get(settings.companySellerUserId) : null;

    return {
      companyDisplayName: settings?.companyDisplayName ?? DEFAULT_COMPANY_DISPLAY_NAME,
      companySellerUserId: settings?.companySellerUserId ?? null,
      companySeller,
      isConfigured: Boolean(settings?.companySellerUserId),
    };
  },
});

export const updatePlatformSettings = mutation({
  args: {
    adminId: v.id("users"),
    companySellerUserId: v.id("users"),
    companyDisplayName: v.string(),
  },
  handler: async (ctx, args) => {
    const _admin = await ensureAdminActor(ctx);

    const companySeller = await ctx.db.get(args.companySellerUserId);
    if (!companySeller) {
      throw new Error("Company seller user not found");
    }

    const now = Date.now();
    const existingSettings = await getPlatformSettings(ctx);

    if (existingSettings) {
      await ctx.db.patch(existingSettings._id, {
        companySellerUserId: args.companySellerUserId,
        companyDisplayName: args.companyDisplayName.trim() || DEFAULT_COMPANY_DISPLAY_NAME,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("platformSettings", {
        key: "singleton",
        companySellerUserId: args.companySellerUserId,
        companyDisplayName: args.companyDisplayName.trim() || DEFAULT_COMPANY_DISPLAY_NAME,
        createdAt: now,
        updatedAt: now,
      });
    }

    return {
      companyDisplayName: args.companyDisplayName.trim() || DEFAULT_COMPANY_DISPLAY_NAME,
      companySellerUserId: args.companySellerUserId,
    };
  },
});
