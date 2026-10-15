import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { requireRole, requireUser } from "./auth";

export const DEFAULT_COMPANY_DISPLAY_NAME = "Gettitonline";

export const userRoleValidator = v.union(
  v.literal("user"),
  v.literal("catalog_manager"),
  v.literal("moderator"),
  v.literal("admin")
);

export type AppUserRole = "user" | "catalog_manager" | "moderator" | "admin";

export const vendorStatusValidator = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("changes_requested"),
  v.literal("suspended")
);

export type VendorStatus = "pending" | "approved" | "changes_requested" | "suspended";

export const productStatusValidator = v.union(
  v.literal("draft"),
  v.literal("pending_review"),
  v.literal("changes_requested"),
  v.literal("rejected"),
  v.literal("active"),
  v.literal("sold"),
  v.literal("suspended")
);

export type AppProductStatus =
  | "draft"
  | "pending_review"
  | "changes_requested"
  | "rejected"
  | "active"
  | "sold"
  | "suspended";

export const aiModerationStatusValidator = v.union(v.literal("clear"), v.literal("flagged"), v.literal("error"));

export type AiModerationStatus = "clear" | "flagged" | "error";

type ReaderLike = Pick<QueryCtx | MutationCtx, "db">;

type UserDoc = {
  _id: Id<"users">;
  firstName: string;
  lastName: string;
  role: AppUserRole;
  isBanned: boolean;
  avatar?: string;
  rating?: number;
  totalSales: number;
};

type VendorProfileDoc = {
  _id: Id<"vendorProfiles">;
  ownerUserId: Id<"users">;
  storeName: string;
  slug: string;
  description: string;
  logoUrl?: string;
  bannerUrl?: string;
  contactEmail: string;
  contactPhone?: string;
  address: {
    street: string;
    city: string;
    province: string;
    country: string;
  };
  socialLinks?: {
    website?: string;
    instagram?: string;
    facebook?: string;
  };
  status: VendorStatus;
  reviewNotes?: string;
  reviewedByUserId?: Id<"users">;
  reviewedAt?: number;
  createdAt: number;
  updatedAt: number;
};

type ProductDoc = {
  _id: Id<"products">;
  sellerId: Id<"users">;
};

export function normalizeOptionalExternalUrl(value?: string) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withProtocol);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return trimmed;
    }
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

type ListingActorContext =
  | {
      actor: UserDoc;
      actorType: "company_staff";
      sellerId: Id<"users">;
      vendorProfile: null;
    }
  | {
      actor: UserDoc;
      actorType: "vendor";
      sellerId: Id<"users">;
      vendorProfile: VendorProfileDoc;
    };

function formatUserName(user: Pick<UserDoc, "firstName" | "lastName">) {
  return `${user.firstName} ${user.lastName}`.trim() || "Unknown";
}

export function isCatalogManagerOrAdmin(role: AppUserRole) {
  return role === "admin" || role === "catalog_manager";
}

export function isStaffViewerRole(role: AppUserRole) {
  return role === "admin" || role === "catalog_manager" || role === "moderator";
}

export function isReviewerRole(role: AppUserRole) {
  return role === "admin" || role === "moderator";
}

export async function getPlatformSettings(ctx: ReaderLike) {
  return await ctx.db
    .query("platformSettings")
    .withIndex("by_key", (q) => q.eq("key", "singleton"))
    .first();
}

export async function getCompanyDisplayName(ctx: ReaderLike) {
  const settings = await getPlatformSettings(ctx);
  return settings?.companyDisplayName ?? DEFAULT_COMPANY_DISPLAY_NAME;
}

export async function getCompanySellerUserId(ctx: ReaderLike) {
  const settings = await getPlatformSettings(ctx);
  return settings?.companySellerUserId ?? null;
}

export async function getPlatformSettingsOrThrow(ctx: ReaderLike) {
  const settings = await getPlatformSettings(ctx);

  if (!settings) {
    throw new Error("Company seller account is not configured. Set it in the admin users page first.");
  }

  return settings;
}

export async function getUserOrThrow(ctx: ReaderLike, userId: Id<"users">, errorMessage = "User not found") {
  const user = await ctx.db.get(userId);
  if (!user) {
    throw new Error(errorMessage);
  }
  return user as UserDoc;
}

// Staff guards take the actor from the verified Clerk token only. A caller-supplied ID
// never grants authority, so a caller cannot act as another staff member by passing their ID.

export async function ensureAdminActor(ctx: QueryCtx | MutationCtx) {
  return await requireRole(ctx, ["admin"]);
}

export async function ensureCatalogActor(ctx: QueryCtx | MutationCtx) {
  const user = await requireUser(ctx);

  if (!isCatalogManagerOrAdmin(user.role)) {
    throw new Error("Unauthorized: Only admins and catalog managers can manage the catalog");
  }

  return user;
}

export async function ensureReviewerActor(ctx: QueryCtx | MutationCtx) {
  const user = await requireUser(ctx);

  if (!isReviewerRole(user.role)) {
    throw new Error("Unauthorized");
  }

  return user;
}

// Pass the verified viewer from `optionalUser(ctx)`. Never pass a caller-supplied user ID here.
export function isStaffViewer(viewer: Pick<UserDoc, "role"> | null) {
  return viewer !== null && isStaffViewerRole(viewer.role);
}

// The actor must be the verified caller, e.g. from `requireUser(ctx)`. Never pass a
// caller-supplied user ID here.
export async function canActAsCompanySeller(
  ctx: ReaderLike,
  actor: Pick<UserDoc, "_id" | "role">,
  sellerId: Id<"users">
) {
  if (sellerId === actor._id) {
    return true;
  }

  if (!isCatalogManagerOrAdmin(actor.role)) {
    return false;
  }

  const companySellerUserId = await getCompanySellerUserId(ctx);
  return companySellerUserId === sellerId;
}

export async function getVendorProfileByOwnerId(ctx: ReaderLike, ownerUserId: Id<"users">) {
  const vendorProfile = await ctx.db
    .query("vendorProfiles")
    .withIndex("by_owner", (q) => q.eq("ownerUserId", ownerUserId))
    .first();

  return (vendorProfile ?? null) as VendorProfileDoc | null;
}

export async function getApprovedVendorProfileByOwnerId(ctx: ReaderLike, ownerUserId: Id<"users">) {
  const vendorProfile = await getVendorProfileByOwnerId(ctx, ownerUserId);
  if (!vendorProfile || vendorProfile.status !== "approved") {
    return null;
  }

  return vendorProfile;
}

export async function isApprovedVendorStore(ctx: ReaderLike, ownerUserId: Id<"users">) {
  const vendorProfile = await getApprovedVendorProfileByOwnerId(ctx, ownerUserId);
  return Boolean(vendorProfile);
}

export async function isPublicStorefrontSeller(ctx: ReaderLike, sellerId: Id<"users">) {
  const companySellerUserId = await getCompanySellerUserId(ctx);
  if (companySellerUserId === sellerId) {
    return true;
  }

  return await isApprovedVendorStore(ctx, sellerId);
}

// The actor must be the verified caller, e.g. from `requireUser(ctx)`. Never pass a
// caller-supplied user ID here.
export async function resolveListingActor(ctx: ReaderLike, actor: UserDoc): Promise<ListingActorContext> {
  if (actor.isBanned) {
    throw new Error("User is banned from listing management");
  }

  if (isCatalogManagerOrAdmin(actor.role)) {
    const settings = await getPlatformSettingsOrThrow(ctx);
    return {
      actor,
      actorType: "company_staff",
      sellerId: settings.companySellerUserId,
      vendorProfile: null,
    };
  }

  if (actor.role === "moderator") {
    throw new Error("Moderators cannot manage listings");
  }

  const vendorProfile = await getVendorProfileByOwnerId(ctx, actor._id);
  if (!vendorProfile || vendorProfile.status !== "approved") {
    throw new Error("Only approved vendors can manage listings");
  }

  return {
    actor,
    actorType: "vendor",
    sellerId: actor._id,
    vendorProfile,
  };
}

export async function canActorManageProduct(ctx: ReaderLike, actor: UserDoc, product: ProductDoc) {
  const listingActor = await resolveListingActor(ctx, actor);
  return listingActor.sellerId === product.sellerId;
}

export function canViewerInspectProduct(product: ProductDoc, viewer: Pick<UserDoc, "_id" | "role"> | null) {
  if (!viewer) {
    return false;
  }

  if (viewer._id === product.sellerId) {
    return true;
  }

  return isStaffViewer(viewer);
}

export async function getSellerDisplayInfo(ctx: ReaderLike, sellerId: Id<"users">) {
  const seller = await ctx.db.get(sellerId);
  const settings = await getPlatformSettings(ctx);
  const vendorProfile = seller ? await getVendorProfileByOwnerId(ctx, sellerId) : null;

  if (!seller) {
    return {
      displayName: "Unknown",
      isCompanyStore: false,
      isVendorStore: false,
      bannerUrl: undefined,
      slug: undefined,
      vendorStatus: undefined,
      seller: null,
    };
  }

  if (settings?.companySellerUserId === sellerId) {
    return {
      displayName: settings.companyDisplayName,
      isCompanyStore: true,
      isVendorStore: false,
      bannerUrl: undefined,
      slug: undefined,
      vendorStatus: undefined,
      seller,
    };
  }

  if (vendorProfile) {
    return {
      displayName: vendorProfile.storeName,
      isCompanyStore: false,
      isVendorStore: true,
      bannerUrl: normalizeOptionalExternalUrl(vendorProfile.bannerUrl),
      slug: vendorProfile.slug,
      vendorStatus: vendorProfile.status,
      seller: {
        ...seller,
        avatar: normalizeOptionalExternalUrl(vendorProfile.logoUrl) ?? seller.avatar,
      },
    };
  }

  return {
    displayName: formatUserName(seller as UserDoc),
    isCompanyStore: false,
    isVendorStore: false,
    bannerUrl: undefined,
    slug: undefined,
    vendorStatus: undefined,
    seller,
  };
}

export async function buildSellerPublicProfile(ctx: ReaderLike, sellerId: Id<"users">) {
  const { seller, displayName, isCompanyStore, isVendorStore, bannerUrl, slug, vendorStatus } =
    await getSellerDisplayInfo(ctx, sellerId);

  if (!seller) {
    return null;
  }

  return {
    _id: seller._id,
    firstName: displayName,
    lastName: "",
    displayName,
    avatar: seller.avatar,
    rating: seller.rating,
    totalSales: seller.totalSales,
    isCompanyStore,
    isVendorStore,
    bannerUrl,
    slug,
    vendorStatus,
  };
}
