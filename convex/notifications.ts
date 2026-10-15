import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query, internalMutation } from "./_generated/server";
import { requireUser } from "./lib/auth";
import { ensureAdminActor } from "./lib/platform";

const notificationTypeValidator = v.union(
  v.literal("order_placed"),
  v.literal("order_status_update"),
  v.literal("new_message"),
  v.literal("dispute_update"),
  v.literal("funds_released"),
  v.literal("new_review"),
  v.literal("product_sold"),
  v.literal("payment_received"),
  v.literal("payment_failed"),
  v.literal("wallet_credit"),
  v.literal("wallet_debit"),
  v.literal("withdrawal_initiated"),
  v.literal("withdrawal_completed"),
  v.literal("withdrawal_failed"),
  v.literal("product_submitted"),
  v.literal("listing_approved"),
  v.literal("listing_rejected"),
  v.literal("listing_changes_requested"),
  v.literal("low_stock"),
  v.literal("cart_reminder"),
  v.literal("price_drop"),
  v.literal("product_recommendation"),
  v.literal("scarcity_alert"),
  v.literal("promo_code"),
  v.literal("flash_sale"),
  v.literal("delivery_update"),
  v.literal("return_update"),
  v.literal("system")
);

const campaignTypeValidator = v.union(
  v.literal("cart_reminder"),
  v.literal("low_stock"),
  v.literal("price_drop"),
  v.literal("product_recommendation")
);

const campaignStatusValidator = v.union(v.literal("draft"), v.literal("active"), v.literal("paused"));

const audienceSegmentValidator = v.union(
  v.literal("all_opted_in"),
  v.literal("cart_abandoners"),
  v.literal("product_viewers"),
  v.literal("category_browsers"),
  v.literal("past_buyers")
);

const channelValidator = v.union(v.literal("in_app"), v.literal("mobile_push"), v.literal("web_push"));

function defaultPreferencesEnabled(user: { preferences?: { notificationsEnabled?: boolean } }) {
  return user.preferences?.notificationsEnabled !== false;
}

function campaignTypeToNotificationType(type: "cart_reminder" | "low_stock" | "price_drop" | "product_recommendation") {
  return type === "low_stock" ? "scarcity_alert" : type;
}

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

async function getOptedInUsers(ctx: QueryCtx | MutationCtx) {
  const users = await ctx.db.query("users").collect();
  return users.filter(defaultPreferencesEnabled);
}

async function getCampaignAudience(
  ctx: QueryCtx | MutationCtx,
  campaign: {
    audienceSegment: "all_opted_in" | "cart_abandoners" | "product_viewers" | "category_browsers" | "past_buyers";
    productId?: Id<"products">;
    categoryId?: Id<"categories">;
  }
) {
  const optedInUsers = await getOptedInUsers(ctx);
  const optedInIds = new Set(optedInUsers.map((user) => user._id));

  if (campaign.audienceSegment === "all_opted_in") {
    return optedInUsers;
  }

  if (campaign.audienceSegment === "cart_abandoners") {
    const cartItems = await ctx.db.query("cartItems").collect();
    const ids = new Set(cartItems.map((item) => item.userId));
    return optedInUsers.filter((user) => ids.has(user._id));
  }

  if (campaign.audienceSegment === "past_buyers") {
    const orders = await ctx.db.query("orders").collect();
    const ids = new Set(orders.map((order) => order.buyerId));
    return optedInUsers.filter((user) => ids.has(user._id));
  }

  const events = await ctx.db
    .query("behaviorEvents")
    .withIndex("by_event_created", (q) =>
      q.eq("eventType", campaign.audienceSegment === "product_viewers" ? "product_view" : "category_browse")
    )
    .collect();
  const ids = new Set(
    events
      .filter((event) => {
        if (!event.userId || !optedInIds.has(event.userId)) {
          return false;
        }
        if (campaign.audienceSegment === "product_viewers" && campaign.productId) {
          return event.productId === campaign.productId;
        }
        if (campaign.audienceSegment === "category_browsers" && campaign.categoryId) {
          return event.categoryId === campaign.categoryId;
        }
        return true;
      })
      .map((event) => event.userId as Id<"users">)
  );

  return optedInUsers.filter((user) => ids.has(user._id));
}

async function countDeliveriesToday(ctx: QueryCtx | MutationCtx, userId: Id<"users">) {
  const logs = await ctx.db
    .query("notificationDeliveryLogs")
    .withIndex("by_user_created", (q) => q.eq("userId", userId))
    .filter((q) => q.gte(q.field("createdAt"), startOfToday()))
    .collect();
  return logs.filter((log) => log.status === "sent" || log.status === "queued").length;
}

// Create notification
export const createNotification = internalMutation({
  args: {
    userId: v.id("users"),
    type: notificationTypeValidator,
    title: v.string(),
    message: v.string(),
    data: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("notifications", {
      userId: args.userId,
      type: args.type,
      title: args.title,
      message: args.message,
      data: args.data,
      isRead: false,
      createdAt: Date.now(),
    });
  },
});

export const recordBehaviorEvent = mutation({
  args: {
    // A queued event may reject a changed session; this assertion never grants authority.
    expectedClerkId: v.union(v.string(), v.null()),
    anonymousId: v.optional(v.string()),
    eventType: v.union(
      v.literal("product_view"),
      v.literal("product_time_spent"),
      v.literal("category_browse"),
      v.literal("add_to_cart"),
      v.literal("purchase")
    ),
    productId: v.optional(v.id("products")),
    categoryId: v.optional(v.id("categories")),
    variantId: v.optional(v.string()),
    durationMs: v.optional(v.number()),
    quantity: v.optional(v.number()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();

    if (args.expectedClerkId !== (identity?.subject ?? null)) {
      throw new Error("Authentication changed. Discard the obsolete behavior event.");
    }

    // Only an actual anonymous identity is a guest. Denied accounts must not fall back to guest writes.
    const actor = identity === null ? null : await requireUser(ctx);

    return await ctx.db.insert("behaviorEvents", {
      userId: actor?._id,
      anonymousId: args.anonymousId,
      eventType: args.eventType,
      productId: args.productId,
      categoryId: args.categoryId,
      variantId: args.variantId,
      durationMs: args.durationMs,
      quantity: args.quantity,
      metadata: args.metadata,
      createdAt: Date.now(),
    });
  },
});

export const getUserBehaviorSummary = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const limit = args.limit ?? 100;
    const events = await ctx.db
      .query("behaviorEvents")
      .withIndex("by_user_created", (q) => q.eq("userId", actor._id))
      .order("desc")
      .take(limit);

    const recentlyViewedProductIds: string[] = [];
    const recentlyViewedCategoryIds: string[] = [];
    const purchaseCategoryIds: string[] = [];
    const seenProducts = new Set<string>();
    const seenViewedCategories = new Set<string>();
    const seenPurchaseCategories = new Set<string>();

    for (const event of events) {
      if (event.eventType === "product_view" && event.productId) {
        if (!seenProducts.has(event.productId)) {
          seenProducts.add(event.productId);
          recentlyViewedProductIds.push(event.productId);
        }
      }

      if (
        (event.eventType === "product_view" ||
          event.eventType === "product_time_spent" ||
          event.eventType === "category_browse") &&
        event.categoryId &&
        !seenViewedCategories.has(event.categoryId)
      ) {
        seenViewedCategories.add(event.categoryId);
        recentlyViewedCategoryIds.push(event.categoryId);
      }

      if (event.eventType === "purchase" && event.categoryId && !seenPurchaseCategories.has(event.categoryId)) {
        seenPurchaseCategories.add(event.categoryId);
        purchaseCategoryIds.push(event.categoryId);
      }
    }

    return {
      recentlyViewedProductIds,
      recentlyViewedCategoryIds,
      purchaseCategoryIds,
    };
  },
});

export const upsertNotificationDevice = mutation({
  args: {
    channel: v.union(v.literal("mobile_push"), v.literal("web_push")),
    token: v.optional(v.string()),
    subscription: v.optional(v.any()),
    platform: v.optional(v.string()),
    isOptedIn: v.boolean(),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const now = Date.now();
    const existingByToken = args.token
      ? await ctx.db
          .query("notificationDevices")
          .withIndex("by_token", (q) => q.eq("token", args.token))
          .first()
      : null;

    if (existingByToken) {
      await ctx.db.patch(existingByToken._id, {
        userId: actor._id,
        channel: args.channel,
        token: args.token,
        subscription: args.subscription,
        platform: args.platform,
        isOptedIn: args.isOptedIn,
        lastSeenAt: now,
        updatedAt: now,
      });
      return existingByToken._id;
    }

    return await ctx.db.insert("notificationDevices", {
      ...args,
      userId: actor._id,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const upsertNotificationCampaign = mutation({
  args: {
    adminId: v.id("users"),
    campaignId: v.optional(v.id("notificationCampaigns")),
    name: v.string(),
    type: campaignTypeValidator,
    status: campaignStatusValidator,
    audienceSegment: audienceSegmentValidator,
    productId: v.optional(v.id("products")),
    categoryId: v.optional(v.id("categories")),
    title: v.string(),
    message: v.string(),
    aiSuggestion: v.optional(v.string()),
    channels: v.array(channelValidator),
    maxPerUserPerDay: v.optional(v.number()),
    isAutomatic: v.boolean(),
  },
  handler: async (ctx, args) => {
    const admin = await ensureAdminActor(ctx);
    const now = Date.now();
    const { adminId: _adminId, campaignId, ...campaignInput } = args;

    if (campaignId) {
      await ctx.db.patch(campaignId, {
        ...campaignInput,
        maxPerUserPerDay: campaignInput.maxPerUserPerDay ?? 3,
        updatedAt: now,
      });
      return await ctx.db.get(campaignId);
    }

    return await ctx.db.insert("notificationCampaigns", {
      ...campaignInput,
      maxPerUserPerDay: campaignInput.maxPerUserPerDay ?? 3,
      createdByUserId: admin._id,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const listNotificationCampaignsForAdmin = query({
  args: { adminId: v.id("users") },
  handler: async (ctx) => {
    await ensureAdminActor(ctx);
    return (await ctx.db.query("notificationCampaigns").collect()).sort(
      (left, right) => right.createdAt - left.createdAt
    );
  },
});

export const sendNotificationCampaign = mutation({
  args: {
    adminId: v.id("users"),
    campaignId: v.id("notificationCampaigns"),
  },
  handler: async (ctx, args) => {
    await ensureAdminActor(ctx);
    const campaign = await ctx.db.get(args.campaignId);
    if (!campaign) {
      throw new Error("Campaign not found");
    }
    if (campaign.status === "paused") {
      throw new Error("Campaign is paused");
    }

    const users = await getCampaignAudience(ctx, campaign);
    const notificationType = campaignTypeToNotificationType(campaign.type);
    const counts = { sent: 0, skipped: 0, queued: 0 };
    const now = Date.now();

    for (const user of users) {
      const sentToday = await countDeliveriesToday(ctx, user._id);
      if (sentToday >= campaign.maxPerUserPerDay) {
        await ctx.db.insert("notificationDeliveryLogs", {
          campaignId: campaign._id,
          userId: user._id,
          channel: "in_app",
          status: "skipped",
          reason: "daily_cap",
          createdAt: now,
        });
        counts.skipped += 1;
        continue;
      }

      const notificationId = await ctx.db.insert("notifications", {
        userId: user._id,
        type: notificationType,
        title: campaign.title,
        message: campaign.message,
        data: {
          campaignId: campaign._id,
          productId: campaign.productId,
          categoryId: campaign.categoryId,
        },
        isRead: false,
        createdAt: now,
      });

      for (const channel of campaign.channels) {
        if (channel === "in_app") {
          await ctx.db.insert("notificationDeliveryLogs", {
            campaignId: campaign._id,
            userId: user._id,
            notificationId,
            channel,
            status: "sent",
            createdAt: now,
          });
          counts.sent += 1;
          continue;
        }

        const devices = await ctx.db
          .query("notificationDevices")
          .withIndex("by_user_channel", (q) => q.eq("userId", user._id).eq("channel", channel))
          .collect();
        const hasOptedInDevice = devices.some((device) => device.isOptedIn);

        await ctx.db.insert("notificationDeliveryLogs", {
          campaignId: campaign._id,
          userId: user._id,
          notificationId,
          channel,
          status: hasOptedInDevice ? "queued" : "skipped",
          reason: hasOptedInDevice ? undefined : "no_opted_in_device",
          createdAt: now,
        });
        if (hasOptedInDevice) {
          counts.queued += 1;
        } else {
          counts.skipped += 1;
        }
      }
    }

    await ctx.db.patch(campaign._id, {
      lastSentAt: now,
      updatedAt: now,
    });

    return { audienceCount: users.length, ...counts };
  },
});

// Get user notifications
export const getUserNotifications = query({
  args: {
    limit: v.optional(v.number()),
    unreadOnly: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const limit = args.limit ?? 50;

    let notificationsQuery = ctx.db
      .query("notifications")
      .withIndex("by_user_created", (q) => q.eq("userId", actor._id));

    if (args.unreadOnly) {
      notificationsQuery = ctx.db
        .query("notifications")
        .withIndex("by_user_read", (q) => q.eq("userId", actor._id).eq("isRead", false));
    }

    return await notificationsQuery.order("desc").take(limit);
  },
});

// Mark notification as read
export const markAsRead = mutation({
  args: {
    notificationId: v.id("notifications"),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const notification = await ctx.db.get(args.notificationId);
    if (!notification) {
      throw new Error("Notification not found");
    }
    if (notification.userId !== actor._id) {
      throw new Error("Unauthorized");
    }

    await ctx.db.patch(args.notificationId, {
      isRead: true,
    });
  },
});

// Mark all notifications as read
export const markAllAsRead = mutation({
  args: {},
  handler: async (ctx) => {
    const actor = await requireUser(ctx);
    const unreadNotifications = await ctx.db
      .query("notifications")
      .withIndex("by_user_read", (q) => q.eq("userId", actor._id).eq("isRead", false))
      .collect();

    for (const notification of unreadNotifications) {
      await ctx.db.patch(notification._id, {
        isRead: true,
      });
    }

    return { marked: unreadNotifications.length };
  },
});

// Get unread count
export const getUnreadCount = query({
  args: {},
  handler: async (ctx) => {
    const actor = await requireUser(ctx);
    const unreadNotifications = await ctx.db
      .query("notifications")
      .withIndex("by_user_read", (q) => q.eq("userId", actor._id).eq("isRead", false))
      .collect();

    return unreadNotifications.length;
  },
});

// Delete notification
export const deleteNotification = mutation({
  args: {
    notificationId: v.id("notifications"),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const notification = await ctx.db.get(args.notificationId);
    if (!notification) {
      throw new Error("Notification not found");
    }
    if (notification.userId !== actor._id) {
      throw new Error("Unauthorized");
    }

    await ctx.db.delete(args.notificationId);
  },
});

// Delete all notifications for user
export const deleteAllNotifications = mutation({
  args: {},
  handler: async (ctx) => {
    const actor = await requireUser(ctx);
    const notifications = await ctx.db
      .query("notifications")
      .withIndex("by_user", (q) => q.eq("userId", actor._id))
      .collect();

    for (const notification of notifications) {
      await ctx.db.delete(notification._id);
    }

    return { deleted: notifications.length };
  },
});

// Helper: Create order notification for seller
export const notifyOrderPlaced = internalMutation({
  args: {
    sellerId: v.id("users"),
    orderNumber: v.string(),
    orderId: v.id("orders"),
    buyerName: v.string(),
    totalAmount: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("notifications", {
      userId: args.sellerId,
      type: "order_placed",
      title: "New Order Received",
      message: `${args.buyerName} placed an order #${args.orderNumber} for ZMW ${args.totalAmount.toFixed(2)}`,
      data: { orderId: args.orderId, orderNumber: args.orderNumber },
      isRead: false,
      createdAt: Date.now(),
    });
  },
});

// Helper: Create order status notification for buyer
export const notifyOrderStatusUpdate = internalMutation({
  args: {
    buyerId: v.id("users"),
    orderNumber: v.string(),
    orderId: v.id("orders"),
    newStatus: v.string(),
  },
  handler: async (ctx, args) => {
    const statusMessages: Record<string, string> = {
      paid: "Your payment has been confirmed",
      processing: "Your order is being processed",
      shipped: "Your order has been shipped",
      delivered: "Your order has been delivered",
      completed: "Your order is complete. Thank you!",
      cancelled: "Your order has been cancelled",
    };

    return await ctx.db.insert("notifications", {
      userId: args.buyerId,
      type: "order_status_update",
      title: `Order #${args.orderNumber} Update`,
      message: statusMessages[args.newStatus] || `Status changed to ${args.newStatus}`,
      data: { orderId: args.orderId, orderNumber: args.orderNumber, status: args.newStatus },
      isRead: false,
      createdAt: Date.now(),
    });
  },
});

// Helper: Create dispute notification
export const notifyDisputeUpdate = internalMutation({
  args: {
    userId: v.id("users"),
    disputeId: v.id("disputes"),
    title: v.string(),
    message: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("notifications", {
      userId: args.userId,
      type: "dispute_update",
      title: args.title,
      message: args.message,
      data: { disputeId: args.disputeId },
      isRead: false,
      createdAt: Date.now(),
    });
  },
});

// Helper: Create new message notification
export const notifyNewMessage = internalMutation({
  args: {
    userId: v.id("users"),
    disputeId: v.id("disputes"),
    senderName: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("notifications", {
      userId: args.userId,
      type: "new_message",
      title: "New Message",
      message: `${args.senderName} sent you a message`,
      data: { disputeId: args.disputeId },
      isRead: false,
      createdAt: Date.now(),
    });
  },
});

// Helper: Create funds released notification
export const notifyFundsReleased = internalMutation({
  args: {
    sellerId: v.id("users"),
    orderId: v.id("orders"),
    amount: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("notifications", {
      userId: args.sellerId,
      type: "funds_released",
      title: "Payment Released",
      message: `ZMW ${args.amount.toFixed(2)} has been released to your account`,
      data: { orderId: args.orderId },
      isRead: false,
      createdAt: Date.now(),
    });
  },
});

// Helper: Create new review notification
export const notifyNewReview = internalMutation({
  args: {
    sellerId: v.id("users"),
    reviewerName: v.string(),
    rating: v.number(),
    productTitle: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("notifications", {
      userId: args.sellerId,
      type: "new_review",
      title: "New Review",
      message: `${args.reviewerName} left a ${args.rating}-star review for "${args.productTitle}"`,
      data: { rating: args.rating },
      isRead: false,
      createdAt: Date.now(),
    });
  },
});

// Helper: Create product sold notification
export const notifyProductSold = internalMutation({
  args: {
    sellerId: v.id("users"),
    productTitle: v.string(),
    productId: v.id("products"),
    quantity: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("notifications", {
      userId: args.sellerId,
      type: "product_sold",
      title: "Product Sold",
      message: `${args.quantity}x "${args.productTitle}" has been sold`,
      data: { productId: args.productId },
      isRead: false,
      createdAt: Date.now(),
    });
  },
});
