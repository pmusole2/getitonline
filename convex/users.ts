import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { userRoleValidator } from "./lib/platform";

// Create or update user from Clerk webhook
export const upsertUser = mutation({
  args: {
    clerkId: v.string(),
    email: v.string(),
    firstName: v.string(),
    lastName: v.string(),
    avatar: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existingUser = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", args.clerkId))
      .first();

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
  },
});

// Get user by Clerk ID
export const getUserByClerkId = query({
  args: { clerkId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", args.clerkId))
      .first();
  },
});

// Get user by ID
export const getUser = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.userId);
  },
});

// Update user profile
export const updateProfile = mutation({
  args: {
    userId: v.id("users"),
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
    const { userId, ...updates } = args;
    const filteredUpdates = Object.fromEntries(
      Object.entries(updates).filter(([_, value]) => value !== undefined)
    );

    await ctx.db.patch(userId, {
      ...filteredUpdates,
      updatedAt: Date.now(),
    });

    return await ctx.db.get(userId);
  },
});

// Update user interests (category preferences)
export const updateInterests = mutation({
  args: {
    userId: v.id("users"),
    interests: v.array(v.id("categories")),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, {
      interests: args.interests,
      updatedAt: Date.now(),
    });
    return await ctx.db.get(args.userId);
  },
});

// Update user role (admin only)
export const updateUserRole = mutation({
  args: {
    adminId: v.id("users"),
    targetUserId: v.id("users"),
    newRole: userRoleValidator,
  },
  handler: async (ctx, args) => {
    const admin = await ctx.db.get(args.adminId);
    if (!admin || admin.role !== "admin") {
      throw new Error("Unauthorized: Only admins can change user roles");
    }

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
    adminId: v.id("users"),
    targetUserId: v.id("users"),
    isBanned: v.boolean(),
  },
  handler: async (ctx, args) => {
    const admin = await ctx.db.get(args.adminId);
    if (!admin || admin.role !== "admin") {
      throw new Error("Unauthorized: Only admins can ban/unban users");
    }

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
    adminId: v.id("users"),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const admin = await ctx.db.get(args.adminId);
    if (!admin || admin.role !== "admin") {
      throw new Error("Unauthorized: Only admins can view all users");
    }

    const limit = args.limit ?? 20;
    const users = await ctx.db.query("users").order("desc").take(limit + 1);

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

// Get users by role
export const getUsersByRole = query({
  args: {
    role: userRoleValidator,
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("users")
      .withIndex("by_role", (q) => q.eq("role", args.role))
      .collect();
  },
});

// Update user rating (called after review)
export const updateUserRating = mutation({
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
export const incrementSales = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) throw new Error("User not found");

    await ctx.db.patch(args.userId, {
      totalSales: user.totalSales + 1,
      updatedAt: Date.now(),
    });
  },
});

// Increment purchases count
export const incrementPurchases = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) throw new Error("User not found");

    await ctx.db.patch(args.userId, {
      totalPurchases: user.totalPurchases + 1,
      updatedAt: Date.now(),
    });
  },
});

// Delete user (for GDPR compliance)
export const deleteUser = mutation({
  args: {
    userId: v.id("users"),
    clerkId: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user || user.clerkId !== args.clerkId) {
      throw new Error("Unauthorized");
    }

    // Note: In production, you'd want to handle related data
    // (orders, products, etc.) according to your data retention policy
    await ctx.db.delete(args.userId);
  },
});

// Get user preferences
export const getPreferences = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) {
      return null;
    }
    return user.preferences ?? {
      themeMode: "system" as const,
      notificationsEnabled: true,
    };
  },
});

// Update user preferences (syncs across devices)
export const updatePreferences = mutation({
  args: {
    userId: v.id("users"),
    preferences: v.object({
      themeMode: v.optional(v.union(v.literal("light"), v.literal("dark"), v.literal("system"))),
      notificationsEnabled: v.optional(v.boolean()),
      language: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) {
      throw new Error("User not found");
    }

    const currentPrefs = user.preferences ?? {
      themeMode: "system" as const,
      notificationsEnabled: true,
    };

    const updatedPrefs = {
      ...currentPrefs,
      ...Object.fromEntries(
        Object.entries(args.preferences).filter(([_, value]) => value !== undefined)
      ),
    };

    await ctx.db.patch(args.userId, {
      preferences: updatedPrefs,
      updatedAt: Date.now(),
    });

    return updatedPrefs;
  },
});

// Update theme mode specifically (convenience method)
export const updateThemeMode = mutation({
  args: {
    userId: v.id("users"),
    themeMode: v.union(v.literal("light"), v.literal("dark"), v.literal("system")),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) {
      throw new Error("User not found");
    }

    const currentPrefs = user.preferences ?? {
      themeMode: "system" as const,
      notificationsEnabled: true,
    };

    await ctx.db.patch(args.userId, {
      preferences: {
        ...currentPrefs,
        themeMode: args.themeMode,
      },
      updatedAt: Date.now(),
    });

    return args.themeMode;
  },
});
