import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { ensureAdminActor } from "./lib/platform";

// Runtime configuration read by clients. The gate and payment availability are public so that builds without a
// session can still check them. Writes are admin-only, and each write validates everything before its first db write.

const PLATFORMS = ["ios", "android"] as const;

const platformValidator = v.union(v.literal("ios"), v.literal("android"));
const minimumBuildsValidator = v.object({ ios: v.number(), android: v.number() });
const storeUrlsValidator = v.object({ ios: v.optional(v.string()), android: v.optional(v.string()) });

type StoreUrls = { ios?: string; android?: string };

export type ClientGate = {
  updateRequired: boolean;
  minimumBuild: number;
  storeUrl: string | null;
  paymentsEnabled: boolean;
};

async function loadAppConfig(ctx: QueryCtx | MutationCtx): Promise<Doc<"appConfig"> | null> {
  return await ctx.db
    .query("appConfig")
    .withIndex("by_key", (q) => q.eq("key", "singleton"))
    .first();
}

function assertNonNegativeInteger(build: number): void {
  if (!Number.isInteger(build) || build < 0) {
    throw new Error("build must be a non-negative integer");
  }
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function isHttpsUrl(value: string): boolean {
  if (!value.startsWith("https://")) {
    return false;
  }
  try {
    // Store URLs are returned to every client, so credentials embedded in the URL are refused.
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

// A platform named in the update keeps its new URL. A platform left out keeps the stored one.
function mergeStoreUrls(current: StoreUrls | undefined, update: StoreUrls | undefined): StoreUrls | undefined {
  if (!update) {
    return current;
  }
  const merged: StoreUrls = { ...current };
  if (update.ios !== undefined) {
    merged.ios = update.ios;
  }
  if (update.android !== undefined) {
    merged.android = update.android;
  }
  return merged;
}

export const getClientGate = query({
  args: { platform: platformValidator, build: v.number() },
  handler: async (ctx, args): Promise<ClientGate> => {
    assertNonNegativeInteger(args.build);

    const config = await loadAppConfig(ctx);
    if (!config) {
      return { updateRequired: false, minimumBuild: 0, storeUrl: null, paymentsEnabled: false };
    }

    const minimumBuild = config.minimumBuilds[args.platform];
    return {
      updateRequired: args.build < minimumBuild,
      minimumBuild,
      storeUrl: config.storeUrls?.[args.platform] ?? null,
      paymentsEnabled: config.paymentsEnabled,
    };
  },
});

export const getPaymentAvailability = query({
  args: {},
  handler: async (ctx): Promise<{ paymentsEnabled: boolean }> => {
    const config = await loadAppConfig(ctx);
    return { paymentsEnabled: config?.paymentsEnabled ?? false };
  },
});

const configUpdateArgs = {
  minimumBuilds: v.optional(minimumBuildsValidator),
  storeUrls: v.optional(storeUrlsValidator),
  paymentsEnabled: v.optional(v.boolean()),
};

type ConfigUpdate = {
  minimumBuilds?: { ios: number; android: number };
  storeUrls?: StoreUrls;
  paymentsEnabled?: boolean;
};

// The one validation and merge path. Both the admin mutation and the operator mutation run it, so they cannot drift.
// Every check runs before the first write. `updatedBy` is set only from a verified admin, never from an argument.
async function applyConfigUpdate(
  ctx: MutationCtx,
  args: ConfigUpdate,
  updatedBy: Id<"users"> | undefined
): Promise<null> {
  if (args.minimumBuilds === undefined && args.storeUrls === undefined && args.paymentsEnabled === undefined) {
    throw new Error("Provide at least one field to update app config");
  }

  if (args.minimumBuilds) {
    for (const platform of PLATFORMS) {
      if (!isPositiveInteger(args.minimumBuilds[platform])) {
        throw new Error(`${platform} minimum build must be a positive integer`);
      }
    }
  }

  if (args.storeUrls) {
    for (const platform of PLATFORMS) {
      const url = args.storeUrls[platform];
      if (url !== undefined && !isHttpsUrl(url)) {
        throw new Error(`${platform} store URL must be an https URL`);
      }
    }
  }

  const existing = await loadAppConfig(ctx);
  const minimumBuilds = args.minimumBuilds ?? existing?.minimumBuilds;
  if (!minimumBuilds) {
    throw new Error("minimumBuilds is required before app config is first set");
  }

  // An operator write passes `undefined`, which clears any updatedBy an earlier admin write left behind.
  const fields = {
    minimumBuilds,
    storeUrls: mergeStoreUrls(existing?.storeUrls, args.storeUrls),
    paymentsEnabled: args.paymentsEnabled ?? existing?.paymentsEnabled ?? false,
    updatedAt: Date.now(),
    updatedBy,
  };

  if (existing) {
    await ctx.db.patch(existing._id, fields);
  } else {
    await ctx.db.insert("appConfig", { key: "singleton", ...fields });
  }
  return null;
}

export const setAppConfig = mutation({
  args: configUpdateArgs,
  handler: async (ctx, args): Promise<null> => {
    // The actor comes only from the verified token. Any caller-supplied identity in args is ignored.
    const actor = await ensureAdminActor(ctx);
    return await applyConfigUpdate(ctx, args, actor._id);
  },
});

// Operator path for cutover and emergency rollback, run from a shell against a deployment (see the release runbook).
// It is internal, so no client can call it. It has no caller identity, so it records no updatedBy.
export const applyAppConfig = internalMutation({
  args: configUpdateArgs,
  handler: async (ctx, args): Promise<null> => applyConfigUpdate(ctx, args, undefined),
});
