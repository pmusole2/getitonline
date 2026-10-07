import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { canActAsCompanySeller } from "./lib/platform";

async function ensureAdmin(ctx: QueryCtx | MutationCtx, userId: Id<"users">) {
  const user = await ctx.db.get(userId);
  if (!user || user.role !== "admin") {
    throw new Error("Unauthorized: Only admins can manage delivery settings");
  }
  return user;
}

async function notifyUser(
  ctx: MutationCtx,
  userId: Id<"users">,
  type: "delivery_update" | "return_update",
  title: string,
  message: string,
  data?: Record<string, unknown>
) {
  await ctx.db.insert("notifications", {
    userId,
    type,
    title,
    message,
    data,
    isRead: false,
    createdAt: Date.now(),
  });
}

export const listDeliveryZones = query({
  args: { includeInactive: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const zones = await ctx.db.query("deliveryZones").collect();
    return zones
      .filter((zone) => args.includeInactive || zone.isActive)
      .sort((left, right) => left.sortOrder - right.sortOrder);
  },
});

export const listDeliveryMethods = query({
  args: {
    zoneId: v.optional(v.id("deliveryZones")),
    includeInactive: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const methods = args.zoneId
      ? await ctx.db
          .query("deliveryMethods")
          .withIndex("by_zone", (q) => q.eq("zoneId", args.zoneId))
          .collect()
      : await ctx.db.query("deliveryMethods").collect();

    return methods.filter((method) => args.includeInactive || method.isActive);
  },
});

export const listPickupPoints = query({
  args: {
    zoneId: v.optional(v.id("deliveryZones")),
    includeInactive: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const pickupPoints = args.zoneId
      ? await ctx.db
          .query("pickupPoints")
          .withIndex("by_zone", (q) => q.eq("zoneId", args.zoneId))
          .collect()
      : await ctx.db.query("pickupPoints").collect();

    return pickupPoints.filter((point) => args.includeInactive || point.isActive);
  },
});

export const calculateDeliveryQuote = query({
  args: {
    zoneId: v.optional(v.id("deliveryZones")),
    province: v.optional(v.string()),
    city: v.optional(v.string()),
    subtotal: v.number(),
    weightKg: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const weightKg = args.weightKg ?? 0;
    const zones = await ctx.db.query("deliveryZones").collect();
    const matchingZoneIds = new Set(
      zones
        .filter((zone) => {
          if (!zone.isActive) return false;
          if (args.zoneId) return zone._id === args.zoneId;
          const provinceMatches =
            !zone.province ||
            !args.province ||
            zone.province.toLowerCase() === args.province.toLowerCase();
          const cityMatches =
            !zone.city ||
            !args.city ||
            zone.city.toLowerCase() === args.city.toLowerCase();
          return provinceMatches && cityMatches;
        })
        .map((zone) => zone._id)
    );

    const methods = await ctx.db.query("deliveryMethods").collect();

    return methods
      .filter((method) => {
        if (!method.isActive) return false;
        if (!method.zoneId) return true;
        return matchingZoneIds.has(method.zoneId);
      })
      .map((method) => {
        const weightedFee = (method.perKgFee ?? 0) * weightKg;
        const fee =
          method.freeAboveSubtotal !== undefined &&
          args.subtotal >= method.freeAboveSubtotal
            ? 0
            : method.baseFee + weightedFee;

        return {
          methodId: method._id,
          name: method.name,
          code: method.code,
          type: method.type,
          fee,
          minDays: method.minDays,
          maxDays: method.maxDays,
          courierName: method.courierName,
        };
      });
  },
});

export const upsertDeliveryZone = mutation({
  args: {
    adminId: v.id("users"),
    zoneId: v.optional(v.id("deliveryZones")),
    name: v.string(),
    slug: v.string(),
    province: v.optional(v.string()),
    city: v.optional(v.string()),
    postalCodePattern: v.optional(v.string()),
    isActive: v.boolean(),
    sortOrder: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ensureAdmin(ctx, args.adminId);
    const now = Date.now();
    const { adminId, zoneId, ...zoneInput } = args;

    if (zoneId) {
      await ctx.db.patch(zoneId, {
        ...zoneInput,
        sortOrder: zoneInput.sortOrder ?? 0,
        updatedAt: now,
      });
      return await ctx.db.get(zoneId);
    }

    return await ctx.db.insert("deliveryZones", {
      ...zoneInput,
      sortOrder: zoneInput.sortOrder ?? 0,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const upsertDeliveryMethod = mutation({
  args: {
    adminId: v.id("users"),
    methodId: v.optional(v.id("deliveryMethods")),
    zoneId: v.optional(v.id("deliveryZones")),
    name: v.string(),
    code: v.string(),
    type: v.union(
      v.literal("standard"),
      v.literal("express"),
      v.literal("same_day"),
      v.literal("pickup")
    ),
    baseFee: v.number(),
    perKgFee: v.optional(v.number()),
    freeAboveSubtotal: v.optional(v.number()),
    minDays: v.number(),
    maxDays: v.number(),
    courierName: v.optional(v.string()),
    isActive: v.boolean(),
  },
  handler: async (ctx, args) => {
    await ensureAdmin(ctx, args.adminId);
    const now = Date.now();
    const { adminId, methodId, ...methodInput } = args;

    if (methodId) {
      await ctx.db.patch(methodId, {
        ...methodInput,
        updatedAt: now,
      });
      return await ctx.db.get(methodId);
    }

    return await ctx.db.insert("deliveryMethods", {
      ...methodInput,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const upsertPickupPoint = mutation({
  args: {
    adminId: v.id("users"),
    pickupPointId: v.optional(v.id("pickupPoints")),
    zoneId: v.optional(v.id("deliveryZones")),
    name: v.string(),
    code: v.string(),
    address: v.object({
      street: v.string(),
      city: v.string(),
      province: v.string(),
      country: v.string(),
    }),
    contactPhone: v.optional(v.string()),
    openingHours: v.optional(v.string()),
    isActive: v.boolean(),
  },
  handler: async (ctx, args) => {
    await ensureAdmin(ctx, args.adminId);
    const now = Date.now();
    const { adminId, pickupPointId, ...pickupPointInput } = args;

    if (pickupPointId) {
      await ctx.db.patch(pickupPointId, {
        ...pickupPointInput,
        updatedAt: now,
      });
      return await ctx.db.get(pickupPointId);
    }

    return await ctx.db.insert("pickupPoints", {
      ...pickupPointInput,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const addOrderTrackingEvent = mutation({
  args: {
    actorUserId: v.id("users"),
    orderId: v.id("orders"),
    status: v.union(
      v.literal("order_placed"),
      v.literal("payment_confirmed"),
      v.literal("processing"),
      v.literal("ready_for_pickup"),
      v.literal("picked_up"),
      v.literal("in_transit"),
      v.literal("out_for_delivery"),
      v.literal("delivered"),
      v.literal("delivery_failed"),
      v.literal("return_requested"),
      v.literal("return_received"),
      v.literal("refunded")
    ),
    message: v.string(),
    location: v.optional(v.object({ city: v.string(), province: v.string() })),
    carrier: v.optional(v.string()),
    trackingNumber: v.optional(v.string()),
    occurredAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const actor = await ctx.db.get(args.actorUserId);
    const order = await ctx.db.get(args.orderId);
    if (!actor || !order) {
      throw new Error("Order not found");
    }

    const canUpdate =
      actor.role === "admin" ||
      actor.role === "moderator" ||
      order.sellerId === args.actorUserId ||
      (await canActAsCompanySeller(ctx, args.actorUserId, order.sellerId)) ||
      (order.buyerId === args.actorUserId && args.status === "return_requested");
    if (!canUpdate) {
      throw new Error("Unauthorized");
    }

    const now = Date.now();
    const eventId = await ctx.db.insert("orderTrackingEvents", {
      orderId: args.orderId,
      status: args.status,
      message: args.message,
      location: args.location,
      carrier: args.carrier,
      trackingNumber: args.trackingNumber,
      createdByUserId: args.actorUserId,
      occurredAt: args.occurredAt ?? now,
      createdAt: now,
    });

    await notifyUser(
      ctx,
      order.buyerId,
      "delivery_update",
      "Delivery update",
      args.message,
      {
        orderId: order._id,
        trackingEventId: eventId,
        status: args.status,
      }
    );

    return eventId;
  },
});

export const getOrderTrackingEvents = query({
  args: {
    orderId: v.id("orders"),
    viewerUserId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const viewer = await ctx.db.get(args.viewerUserId);
    const order = await ctx.db.get(args.orderId);
    if (!viewer || !order) {
      throw new Error("Order not found");
    }

    const canView =
      viewer.role === "admin" ||
      viewer.role === "moderator" ||
      order.buyerId === args.viewerUserId ||
      order.sellerId === args.viewerUserId ||
      (await canActAsCompanySeller(ctx, args.viewerUserId, order.sellerId));
    if (!canView) {
      throw new Error("Unauthorized");
    }

    return await ctx.db
      .query("orderTrackingEvents")
      .withIndex("by_order_occurred", (q) => q.eq("orderId", args.orderId))
      .order("asc")
      .collect();
  },
});

export const requestReturn = mutation({
  args: {
    buyerId: v.id("users"),
    orderId: v.id("orders"),
    reason: v.union(
      v.literal("wrong_item"),
      v.literal("defective"),
      v.literal("not_as_described"),
      v.literal("damaged_in_transit"),
      v.literal("changed_mind"),
      v.literal("other")
    ),
    requestedItems: v.array(
      v.object({
        productId: v.id("products"),
        quantity: v.number(),
      })
    ),
    description: v.string(),
    evidenceUrls: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const order = await ctx.db.get(args.orderId);
    if (!order || order.buyerId !== args.buyerId) {
      throw new Error("Order not found");
    }

    const now = Date.now();
    const returnRequestId = await ctx.db.insert("returnRequests", {
      orderId: args.orderId,
      buyerId: args.buyerId,
      sellerId: order.sellerId,
      status: "requested",
      reason: args.reason,
      requestedItems: args.requestedItems,
      description: args.description,
      evidenceUrls: args.evidenceUrls,
      createdAt: now,
      updatedAt: now,
    });

    await notifyUser(
      ctx,
      order.sellerId,
      "return_update",
      "Return requested",
      `A buyer requested a return for order ${order.orderNumber}.`,
      { orderId: order._id, returnRequestId }
    );

    return returnRequestId;
  },
});

export const reviewReturnRequest = mutation({
  args: {
    actorUserId: v.id("users"),
    returnRequestId: v.id("returnRequests"),
    status: v.union(
      v.literal("approved"),
      v.literal("rejected"),
      v.literal("received"),
      v.literal("refunded"),
      v.literal("closed")
    ),
    resolution: v.optional(
      v.object({
        type: v.union(
          v.literal("refund"),
          v.literal("replacement"),
          v.literal("store_credit"),
          v.literal("rejected")
        ),
        amount: v.optional(v.number()),
        notes: v.optional(v.string()),
      })
    ),
  },
  handler: async (ctx, args) => {
    const actor = await ctx.db.get(args.actorUserId);
    const returnRequest = await ctx.db.get(args.returnRequestId);
    if (!actor || !returnRequest) {
      throw new Error("Return request not found");
    }

    const canReview =
      actor.role === "admin" ||
      actor.role === "moderator" ||
      returnRequest.sellerId === args.actorUserId ||
      (await canActAsCompanySeller(ctx, args.actorUserId, returnRequest.sellerId));
    if (!canReview) {
      throw new Error("Unauthorized");
    }

    await ctx.db.patch(args.returnRequestId, {
      status: args.status,
      resolution: args.resolution
        ? {
            ...args.resolution,
            resolvedByUserId: args.actorUserId,
            resolvedAt: Date.now(),
          }
        : returnRequest.resolution,
      updatedAt: Date.now(),
    });

    await notifyUser(
      ctx,
      returnRequest.buyerId,
      "return_update",
      "Return request updated",
      `Your return request is now ${args.status.replace(/_/g, " ")}.`,
      { returnRequestId: returnRequest._id, status: args.status }
    );

    return await ctx.db.get(args.returnRequestId);
  },
});

export const getReturnRequests = query({
  args: {
    viewerUserId: v.id("users"),
    status: v.optional(
      v.union(
        v.literal("requested"),
        v.literal("approved"),
        v.literal("rejected"),
        v.literal("in_transit"),
        v.literal("received"),
        v.literal("refunded"),
        v.literal("closed")
      )
    ),
  },
  handler: async (ctx, args) => {
    const viewer = await ctx.db.get(args.viewerUserId);
    if (!viewer) {
      throw new Error("Unauthorized");
    }

    const allRequests = await ctx.db.query("returnRequests").collect();
    const visibleRequests = [];

    for (const request of allRequests) {
      if (args.status && request.status !== args.status) continue;
      if (viewer.role === "admin" || viewer.role === "moderator") {
        visibleRequests.push(request);
        continue;
      }

      if (
        request.buyerId === args.viewerUserId ||
        request.sellerId === args.viewerUserId ||
        (await canActAsCompanySeller(ctx, args.viewerUserId, request.sellerId))
      ) {
        visibleRequests.push(request);
      }
    }

    return visibleRequests.sort((left, right) => right.createdAt - left.createdAt);
  },
});

export const getOrderReturnRequests = query({
  args: {
    orderId: v.id("orders"),
    viewerUserId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const viewer = await ctx.db.get(args.viewerUserId);
    const order = await ctx.db.get(args.orderId);
    if (!viewer || !order) {
      throw new Error("Order not found");
    }

    const canView =
      viewer.role === "admin" ||
      viewer.role === "moderator" ||
      order.buyerId === args.viewerUserId ||
      order.sellerId === args.viewerUserId ||
      (await canActAsCompanySeller(ctx, args.viewerUserId, order.sellerId));
    if (!canView) {
      throw new Error("Unauthorized");
    }

    return await ctx.db
      .query("returnRequests")
      .withIndex("by_order", (q) => q.eq("orderId", args.orderId))
      .order("desc")
      .collect();
  },
});
