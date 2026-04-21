import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  DEFAULT_COMPANY_DISPLAY_NAME,
  ensureAdminActor,
  getPlatformSettings,
} from "./lib/platform";

export const getStorefront = query({
  args: {},
  handler: async (ctx) => {
    const settings = await getPlatformSettings(ctx);

    return {
      companyDisplayName:
        settings?.companyDisplayName ?? DEFAULT_COMPANY_DISPLAY_NAME,
      companySellerUserId: settings?.companySellerUserId ?? null,
      isConfigured: Boolean(settings?.companySellerUserId),
    };
  },
});

export const getPlatformSettingsForAdmin = query({
  args: {
    adminId: v.id("users"),
  },
  handler: async (ctx, args) => {
    await ensureAdminActor(ctx, args.adminId);

    const settings = await getPlatformSettings(ctx);
    const companySeller = settings?.companySellerUserId
      ? await ctx.db.get(settings.companySellerUserId)
      : null;

    return {
      companyDisplayName:
        settings?.companyDisplayName ?? DEFAULT_COMPANY_DISPLAY_NAME,
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
    await ensureAdminActor(ctx, args.adminId);

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
