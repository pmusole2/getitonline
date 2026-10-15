import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { denialMessage, loadAccountState, requireRole, requireUser } from "./lib/auth";
import { isReviewerRole, userRoleValidator } from "./lib/platform";

// Create or update the signed-in user's own record. The Clerk subject comes from the verified token.
export const upsertUser = mutation({
  args: {
    email: v.string(),
    firstName: v.string(),
    lastName: v.string(),
    avatar: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Unauthenticated");
    }
    // A banned account may not rewrite its own record. Deleted accounts keep their own refusal in upsertClerkUser.
    // The check runs before any write. The verified webhook path below still syncs banned accounts.
    const existing = await loadAccountState(ctx, identity.subject);
    if (existing?.deletedAt === undefined && existing?.isBanned) {
      throw new Error(denialMessage("banned"));
    }
    const userId = await upsertClerkUser(ctx, { ...args, clerkId: identity.subject });
    if (!userId) {
      throw new Error(denialMessage("deleted"));
    }
    return userId;
  },
});

// Create or update user from a verified Clerk webhook
export const upsertUserFromClerkWebhook = internalMutation({
  args: {
    clerkId: v.string(),
    email: v.string(),
    firstName: v.string(),
    lastName: v.string(),
    avatar: v.optional(v.string()),
  },
  handler: async (ctx, args) => upsertClerkUser(ctx, args),
});

// Returns null for deleted accounts so a stale token or late webhook cannot restore personal data.
async function upsertClerkUser(
  ctx: MutationCtx,
  args: {
    clerkId: string;
    email: string;
    firstName: string;
    lastName: string;
    avatar?: string;
  }
): Promise<Id<"users"> | null> {
  const existingUser = await loadAccountState(ctx, args.clerkId);

  if (existingUser?.deletedAt !== undefined) {
    return null;
  }

  if (existingUser) {
    await ctx.db.patch(existingUser._id, {
      email: args.email,
      firstName: args.firstName,
      lastName: args.lastName,
      avatar: args.avatar,
      updatedAt: Date.now(),
    });
    return existingUser._id;
  }

  return await ctx.db.insert("users", {
    clerkId: args.clerkId,
    email: args.email,
    firstName: args.firstName,
    lastName: args.lastName,
    avatar: args.avatar,
    role: "user",
    totalSales: 0,
    totalPurchases: 0,
    isVerified: false,
    isBanned: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

// Get user by Clerk ID
// Returns the record only to the signed-in subject itself; anyone else (or no sign-in) gets null.
export const getUserByClerkId = query({
  args: { clerkId: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || identity.subject !== args.clerkId) {
      return null;
    }
    const user = await loadAccountState(ctx, args.clerkId);
    return user?.deletedAt === undefined ? user : null;
  },
});

// Get a user record by ID. The record holds contact details, so an account reads its own, and reviewers and admins read
// any. The ID names the record wanted; it never grants access. A missing record reads as null.
export const getUser = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const user = await ctx.db.get(args.userId);
    if (!user) {
      return null;
    }
    if (user._id !== actor._id && !isReviewerRole(actor.role)) {
      throw new Error("Unauthorized");
    }
    return user;
  },
});

// Update the signed-in user's own profile. The account comes from the verified token, and only the listed fields change.
export const updateProfile = mutation({
  args: {
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    phone: v.optional(v.string()),
    avatar: v.optional(v.string()),
    address: v.optional(
      v.object({
        street: v.string(),
        city: v.string(),
        province: v.string(),
        country: v.string(),
      })
    ),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const filteredUpdates = Object.fromEntries(
      Object.entries({
        firstName: args.firstName,
        lastName: args.lastName,
        phone: args.phone,
        avatar: args.avatar,
        address: args.address,
      }).filter(([_, value]) => value !== undefined)
    );

    await ctx.db.patch(actor._id, {
      ...filteredUpdates,
      updatedAt: Date.now(),
    });

    return await ctx.db.get(actor._id);
  },
});

// Update the signed-in user's interests (category preferences)
export const updateInterests = mutation({
  args: {
    interests: v.array(v.id("categories")),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    await ctx.db.patch(actor._id, {
      interests: args.interests,
      updatedAt: Date.now(),
    });
    return await ctx.db.get(actor._id);
  },
});

// Update user role (admin only)
export const updateUserRole = mutation({
  args: {
    targetUserId: v.id("users"),
    newRole: userRoleValidator,
  },
  handler: async (ctx, args) => {
    await requireRole(ctx, ["admin"]);

    await ctx.db.patch(args.targetUserId, {
      role: args.newRole,
      updatedAt: Date.now(),
    });

    return await ctx.db.get(args.targetUserId);
  },
});

// Ban/unban user (admin only)
export const toggleUserBan = mutation({
  args: {
    targetUserId: v.id("users"),
    isBanned: v.boolean(),
  },
  handler: async (ctx, args) => {
    await requireRole(ctx, ["admin"]);

    await ctx.db.patch(args.targetUserId, {
      isBanned: args.isBanned,
      updatedAt: Date.now(),
    });

    return await ctx.db.get(args.targetUserId);
  },
});

// Get all users (admin only, with pagination)
export const getAllUsers = query({
  args: {
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireRole(ctx, ["admin"]);

    const limit = args.limit ?? 20;
    const users = await ctx.db
      .query("users")
      .order("desc")
      .take(limit + 1);

    const hasMore = users.length > limit;
    const items = hasMore ? users.slice(0, -1) : users;

    const lastItem = items[items.length - 1];
    return {
      items,
      hasMore,
      nextCursor: hasMore && lastItem ? lastItem._id : null,
    };
  },
});

// Get users by role (admin only)
export const getUsersByRole = query({
  args: {
    role: userRoleValidator,
  },
  handler: async (ctx, args) => {
    await requireRole(ctx, ["admin"]);
    return await ctx.db
      .query("users")
      .withIndex("by_role", (q) => q.eq("role", args.role))
      .collect();
  },
});

// Update user rating (called after review)
export const updateUserRating = internalMutation({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const reviews = await ctx.db
      .query("reviews")
      .withIndex("by_reviewee", (q) => q.eq("revieweeId", args.userId))
      .collect();

    if (reviews.length === 0) {
      return;
    }

    const totalRating = reviews.reduce((sum, review) => sum + review.rating, 0);
    const averageRating = totalRating / reviews.length;

    await ctx.db.patch(args.userId, {
      rating: Math.round(averageRating * 10) / 10, // Round to 1 decimal
      updatedAt: Date.now(),
    });
  },
});

// Increment sales count
export const incrementSales = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) {
      throw new Error("User not found");
    }

    await ctx.db.patch(args.userId, {
      totalSales: user.totalSales + 1,
      updatedAt: Date.now(),
    });
  },
});

// Increment purchases count
export const incrementPurchases = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) {
      throw new Error("User not found");
    }

    await ctx.db.patch(args.userId, {
      totalPurchases: user.totalPurchases + 1,
      updatedAt: Date.now(),
    });
  },
});

// Delete user (for GDPR compliance)
export const deleteUser = internalMutation({
  args: {
    userId: v.id("users"),
    clerkId: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user || user.clerkId !== args.clerkId) {
      throw new Error("Unauthorized");
    }

    // A live checkout reservation must never lose its owner row. In this
    // pre-settlement slice every checkout link requires retention: no
    // trusted release/accounting marker exists yet, so even a
    // terminal-looking local label still refuses hard deletion and later
    // settlement keeps its tombstone linkage. No historical repair.
    const operations = await ctx.db
      .query("paymentOperations")
      .withIndex("by_owner", (q) => q.eq("ownerId", user._id))
      .collect();
    for (const operation of operations) {
      if (operation.kind !== "checkout_collection") {
        continue;
      }
      throw new Error("This owner has an unresolved checkout and cannot be deleted yet.");
    }

    // Note: In production, you'd want to handle related data
    // (orders, products, etc.) according to your data retention policy
    await ctx.db.delete(args.userId);
  },
});

// Anonymize app-side user data after Clerk confirms account deletion.
export const anonymizeDeletedUserByClerkId = internalMutation({
  args: {
    clerkId: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", args.clerkId))
      .first();

    // The deletion can arrive before the first sync. Record a tombstone so a later sync or
    // creation webhook for this subject is refused instead of creating an active account.
    if (!user) {
      const now = Date.now();
      await ctx.db.insert("users", {
        clerkId: args.clerkId,
        email: "deleted@deleted.gettitonline.local",
        firstName: "Deleted",
        lastName: "User",
        role: "user",
        totalSales: 0,
        totalPurchases: 0,
        isVerified: false,
        isBanned: true,
        isDeleted: true,
        deletedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      return { status: "tombstoned" as const };
    }

    const now = Date.now();
    const anonymizedEmail = `deleted-${user._id}@deleted.gettitonline.local`;

    const cartItems = await ctx.db
      .query("cartItems")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    for (const item of cartItems) {
      await ctx.db.delete(item._id);
    }

    const favorites = await ctx.db
      .query("favorites")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    for (const favorite of favorites) {
      await ctx.db.delete(favorite._id);
    }

    const notificationDevices = await ctx.db
      .query("notificationDevices")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    for (const device of notificationDevices) {
      await ctx.db.delete(device._id);
    }

    const notifications = await ctx.db
      .query("notifications")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    for (const notification of notifications) {
      await ctx.db.delete(notification._id);
    }

    const paymentAccounts = await ctx.db
      .query("paymentAccounts")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    for (const account of paymentAccounts) {
      await ctx.db.delete(account._id);
    }

    const loyaltyTransactions = await ctx.db
      .query("loyaltyTransactions")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    // Outstanding operation-linked reserved loyalty rows are preserved for
    // later settlement, with the numeric account they debit. A valid
    // reserved record keeps its actual owned checkout-operation linkage; a
    // malformed unresolved linkage is conservatively held (retained), never
    // silently discarded. All other loyalty history is removed as before. No
    // new active loyalty account is created for the deleted subject, and
    // repeat anonymization stays safe.
    const retainedAccountIds = new Set<string>();
    for (const transaction of loyaltyTransactions) {
      if (transaction.status === "reserved") {
        const linkedId = transaction.operationId;
        const linked = linkedId === undefined ? null : await ctx.db.get(linkedId);
        if (
          linked &&
          linked.kind === "checkout_collection" &&
          linked.ownerId === user._id &&
          linked.loyaltyTransactionId === transaction._id &&
          (linked.status === "reserved" || linked.status === "attempted" || linked.status === "unknown")
        ) {
          retainedAccountIds.add(transaction.accountId);
          continue;
        }
        // Malformed unresolved linkage: hold for review instead of
        // discarding a possible financial claim or restoring access.
        retainedAccountIds.add(transaction.accountId);
        continue;
      }
      await ctx.db.delete(transaction._id);
    }

    const loyaltyAccounts = await ctx.db
      .query("loyaltyAccounts")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    for (const account of loyaltyAccounts) {
      if (retainedAccountIds.has(account._id)) {
        continue;
      }
      await ctx.db.delete(account._id);
    }

    const behaviorEvents = await ctx.db
      .query("behaviorEvents")
      .withIndex("by_user_created", (q) => q.eq("userId", user._id))
      .collect();
    for (const event of behaviorEvents) {
      await ctx.db.patch(event._id, {
        userId: undefined,
        anonymousId: `deleted-user-${user._id}`,
        metadata: undefined,
      });
    }

    const notificationLogs = await ctx.db
      .query("notificationDeliveryLogs")
      .withIndex("by_user_created", (q) => q.eq("userId", user._id))
      .collect();
    for (const log of notificationLogs) {
      await ctx.db.delete(log._id);
    }

    const products = await ctx.db
      .query("products")
      .withIndex("by_seller", (q) => q.eq("sellerId", user._id))
      .collect();
    for (const product of products) {
      if (product.status !== "sold") {
        await ctx.db.patch(product._id, {
          status: "suspended",
          reviewNotes: "Seller account was deleted.",
          updatedAt: now,
        });
      }
    }

    const vendorProfiles = await ctx.db
      .query("vendorProfiles")
      .withIndex("by_owner", (q) => q.eq("ownerUserId", user._id))
      .collect();
    for (const profile of vendorProfiles) {
      await ctx.db.patch(profile._id, {
        storeName: "Deleted Seller",
        description: "This seller account has been deleted.",
        contactEmail: anonymizedEmail,
        contactPhone: undefined,
        logoUrl: undefined,
        bannerUrl: undefined,
        socialLinks: undefined,
        status: "suspended",
        reviewNotes: "Owner account was deleted.",
        updatedAt: now,
      });
    }

    const wallets = await ctx.db
      .query("wallets")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    for (const wallet of wallets) {
      await ctx.db.patch(wallet._id, {
        isActive: false,
        isFrozen: true,
        freezeReason: "Account deleted",
        updatedAt: now,
      });
    }

    const transactions = await ctx.db
      .query("transactions")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    for (const transaction of transactions) {
      await ctx.db.patch(transaction._id, {
        mobileNumber: undefined,
        metadata: undefined,
        updatedAt: now,
      });
    }

    const disputeMessages = await ctx.db
      .query("messages")
      .withIndex("by_sender", (q) => q.eq("senderId", user._id))
      .collect();
    for (const message of disputeMessages) {
      await ctx.db.patch(message._id, {
        content: "Message removed after account deletion.",
        originalContent: undefined,
        attachments: undefined,
      });
    }

    const conversationMessages = await ctx.db
      .query("conversationMessages")
      .withIndex("by_sender", (q) => q.eq("senderId", user._id))
      .collect();
    for (const message of conversationMessages) {
      await ctx.db.patch(message._id, {
        content: "Message removed after account deletion.",
        attachments: undefined,
      });
    }

    const buyerConversations = await ctx.db
      .query("conversations")
      .withIndex("by_buyer", (q) => q.eq("buyerId", user._id))
      .collect();
    const sellerConversations = await ctx.db
      .query("conversations")
      .withIndex("by_seller", (q) => q.eq("sellerId", user._id))
      .collect();
    const conversationIds = new Set([
      ...buyerConversations.map((conversation) => conversation._id),
      ...sellerConversations.map((conversation) => conversation._id),
    ]);
    for (const conversationId of conversationIds) {
      await ctx.db.patch(conversationId, {
        status: "blocked",
        lastMessagePreview: "Conversation closed after account deletion.",
        buyerUnreadCount: 0,
        sellerUnreadCount: 0,
        updatedAt: now,
      });
    }

    // The clerkId stays in place so later syncs for this subject find the deletion marker.
    await ctx.db.patch(user._id, {
      email: anonymizedEmail,
      firstName: "Deleted",
      lastName: "User",
      phone: undefined,
      avatar: undefined,
      interests: undefined,
      address: undefined,
      preferences: {
        themeMode: user.preferences?.themeMode ?? "system",
        notificationsEnabled: false,
        language: user.preferences?.language,
      },
      isVerified: false,
      isBanned: true,
      isDeleted: true,
      deletedAt: now,
      updatedAt: now,
    });

    return { status: "anonymized" as const, userId: user._id };
  },
});

// Get the signed-in user's preferences
export const getPreferences = query({
  args: {},
  handler: async (ctx) => {
    const actor = await requireUser(ctx);
    return (
      actor.preferences ?? {
        themeMode: "system" as const,
        notificationsEnabled: true,
      }
    );
  },
});

// Update the signed-in user's preferences (syncs across devices)
export const updatePreferences = mutation({
  args: {
    preferences: v.object({
      themeMode: v.optional(v.union(v.literal("light"), v.literal("dark"), v.literal("system"))),
      notificationsEnabled: v.optional(v.boolean()),
      language: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);

    const currentPrefs = actor.preferences ?? {
      themeMode: "system" as const,
      notificationsEnabled: true,
    };

    const updatedPrefs = {
      ...currentPrefs,
      ...Object.fromEntries(Object.entries(args.preferences).filter(([_, value]) => value !== undefined)),
    };

    await ctx.db.patch(actor._id, {
      preferences: updatedPrefs,
      updatedAt: Date.now(),
    });

    return updatedPrefs;
  },
});

// Update the signed-in user's theme mode specifically (convenience method)
export const updateThemeMode = mutation({
  args: {
    themeMode: v.union(v.literal("light"), v.literal("dark"), v.literal("system")),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);

    const currentPrefs = actor.preferences ?? {
      themeMode: "system" as const,
      notificationsEnabled: true,
    };

    await ctx.db.patch(actor._id, {
      preferences: {
        ...currentPrefs,
        themeMode: args.themeMode,
      },
      updatedAt: Date.now(),
    });

    return args.themeMode;
  },
});
