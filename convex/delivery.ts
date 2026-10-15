import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { requireUser } from "./lib/auth";
import { canActAsCompanySeller, ensureAdminActor } from "./lib/platform";

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

// Active zones, methods, and pickup points are public. Inactive ones are staff-only: asking for them runs the same
// admin check as the delivery mutations, before any table is read.
export const listDeliveryZones = query({
  args: { includeInactive: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    if (args.includeInactive) {
      await ensureAdminActor(ctx);
    }
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
    if (args.includeInactive) {
      await ensureAdminActor(ctx);
    }
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
    if (args.includeInactive) {
      await ensureAdminActor(ctx);
    }
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
          if (!zone.isActive) {
            return false;
          }
          if (args.zoneId) {
            return zone._id === args.zoneId;
          }
          const provinceMatches =
            !zone.province || !args.province || zone.province.toLowerCase() === args.province.toLowerCase();
          const cityMatches = !zone.city || !args.city || zone.city.toLowerCase() === args.city.toLowerCase();
          return provinceMatches && cityMatches;
        })
        .map((zone) => zone._id)
    );

    const methods = await ctx.db.query("deliveryMethods").collect();

    return methods
      .filter((method) => {
        if (!method.isActive) {
          return false;
        }
        if (!method.zoneId) {
          return true;
        }
        return matchingZoneIds.has(method.zoneId);
      })
      .map((method) => {
        const weightedFee = (method.perKgFee ?? 0) * weightKg;
        const fee =
          method.freeAboveSubtotal !== undefined && args.subtotal >= method.freeAboveSubtotal
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
    await ensureAdminActor(ctx);
    const now = Date.now();
    const { adminId: _adminId, zoneId, ...zoneInput } = args;

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
    type: v.union(v.literal("standard"), v.literal("express"), v.literal("same_day"), v.literal("pickup")),
    baseFee: v.number(),
    perKgFee: v.optional(v.number()),
    freeAboveSubtotal: v.optional(v.number()),
    minDays: v.number(),
    maxDays: v.number(),
    courierName: v.optional(v.string()),
    isActive: v.boolean(),
  },
  handler: async (ctx, args) => {
    await ensureAdminActor(ctx);
    const now = Date.now();
    const { adminId: _adminId, methodId, ...methodInput } = args;

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
    await ensureAdminActor(ctx);
    const now = Date.now();
    const { adminId: _adminId, pickupPointId, ...pickupPointInput } = args;

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
    const actor = await requireUser(ctx);
    const order = await ctx.db.get(args.orderId);
    if (!order) {
      throw new Error("Order not found");
    }

    const canUpdate =
      actor.role === "admin" ||
      actor.role === "moderator" ||
      order.sellerId === actor._id ||
      (await canActAsCompanySeller(ctx, actor, order.sellerId)) ||
      (order.buyerId === actor._id && args.status === "return_requested");
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
      createdByUserId: actor._id,
      occurredAt: args.occurredAt ?? now,
      createdAt: now,
    });

    await notifyUser(ctx, order.buyerId, "delivery_update", "Delivery update", args.message, {
      orderId: order._id,
      trackingEventId: eventId,
      status: args.status,
    });

    return eventId;
  },
});

export const getOrderTrackingEvents = query({
  args: {
    orderId: v.id("orders"),
  },
  handler: async (ctx, args) => {
    const viewer = await requireUser(ctx);
    const order = await ctx.db.get(args.orderId);
    if (!order) {
      throw new Error("Order not found");
    }

    const canView =
      viewer.role === "admin" ||
      viewer.role === "moderator" ||
      order.buyerId === viewer._id ||
      order.sellerId === viewer._id ||
      (await canActAsCompanySeller(ctx, viewer, order.sellerId));
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
    const actor = await requireUser(ctx);
    const order = await ctx.db.get(args.orderId);
    if (!order || order.buyerId !== actor._id) {
      throw new Error("Order not found");
    }

    const now = Date.now();
    const returnRequestId = await ctx.db.insert("returnRequests", {
      orderId: args.orderId,
      buyerId: actor._id,
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
        type: v.union(v.literal("refund"), v.literal("replacement"), v.literal("store_credit"), v.literal("rejected")),
        amount: v.optional(v.number()),
        notes: v.optional(v.string()),
      })
    ),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const returnRequest = await ctx.db.get(args.returnRequestId);
    if (!returnRequest) {
      throw new Error("Return request not found");
    }

    const canReview =
      actor.role === "admin" ||
      actor.role === "moderator" ||
      returnRequest.sellerId === actor._id ||
      (await canActAsCompanySeller(ctx, actor, returnRequest.sellerId));
    if (!canReview) {
      throw new Error("Unauthorized");
    }

    await ctx.db.patch(args.returnRequestId, {
      status: args.status,
      resolution: args.resolution
        ? {
            ...args.resolution,
            resolvedByUserId: actor._id,
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
    const viewer = await requireUser(ctx);

    const allRequests = await ctx.db.query("returnRequests").collect();
    const visibleRequests = [];

    for (const request of allRequests) {
      if (args.status && request.status !== args.status) {
        continue;
      }
      if (viewer.role === "admin" || viewer.role === "moderator") {
        visibleRequests.push(request);
        continue;
      }

      if (
        request.buyerId === viewer._id ||
        request.sellerId === viewer._id ||
        (await canActAsCompanySeller(ctx, viewer, request.sellerId))
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
  },
  handler: async (ctx, args) => {
    const viewer = await requireUser(ctx);
    const order = await ctx.db.get(args.orderId);
    if (!order) {
      throw new Error("Order not found");
    }

    const canView =
      viewer.role === "admin" ||
      viewer.role === "moderator" ||
      order.buyerId === viewer._id ||
      order.sellerId === viewer._id ||
      (await canActAsCompanySeller(ctx, viewer, order.sellerId));
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
