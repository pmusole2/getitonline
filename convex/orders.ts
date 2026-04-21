import { v } from "convex/values";
import { mutation, query, internalMutation } from "./_generated/server";
import {
  buildSellerPublicProfile,
  canActAsCompanySeller,
  ensureCatalogActor,
  getPlatformSettings,
} from "./lib/platform";

// Generate unique order number
function generateOrderNumber(): string {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `ORD-${timestamp}-${random}`;
}

// Platform fee percentage (5% to cover transaction fees and ensure no shortfall)
const PLATFORM_FEE_PERCENTAGE = 0.05;

// Calculate platform fee from subtotal
function calculatePlatformFee(subtotal: number): number {
  return Math.ceil(subtotal * PLATFORM_FEE_PERCENTAGE * 100) / 100; // Round up to nearest cent
}

// Create order from cart items (grouped by seller)
export const createOrder = mutation({
  args: {
    buyerId: v.id("users"),
    sellerId: v.id("users"),
    items: v.array(
      v.object({
        productId: v.id("products"),
        title: v.string(),
        price: v.number(),
        quantity: v.number(),
        image: v.string(),
      })
    ),
    subtotal: v.number(),
    shippingCost: v.number(),
    shippingAddress: v.object({
      street: v.string(),
      city: v.string(),
      province: v.string(),
      country: v.string(),
      phone: v.string(),
    }),
  },
  handler: async (ctx, args) => {
    const buyer = await ctx.db.get(args.buyerId);
    if (!buyer) throw new Error("Buyer not found");
    if (buyer.isBanned) throw new Error("User is banned");

    // Validate products and stock
    for (const item of args.items) {
      const product = await ctx.db.get(item.productId);
      if (!product) throw new Error(`Product ${item.productId} not found`);
      if (product.status !== "active") {
        throw new Error(`Product ${product.title} is no longer available`);
      }
      if (product.quantity < item.quantity) {
        throw new Error(`Insufficient stock for ${product.title}`);
      }
    }

    // Calculate financial breakdown
    // Platform fee: 5% of subtotal to cover bank/gateway fees
    const platformFee = calculatePlatformFee(args.subtotal);

    // Seller payout: subtotal + shipping (what seller receives)
    const sellerPayout = args.subtotal + args.shippingCost;

    // Total amount: what buyer pays (subtotal + shipping + platform fee)
    const totalAmount = args.subtotal + args.shippingCost + platformFee;

    // Create order with full financial breakdown
    const orderId = await ctx.db.insert("orders", {
      orderNumber: generateOrderNumber(),
      buyerId: args.buyerId,
      sellerId: args.sellerId,
      items: args.items,
      subtotal: args.subtotal,
      shippingCost: args.shippingCost,
      platformFee,
      totalAmount,
      sellerPayout,
      shippingAddress: args.shippingAddress,
      status: "pending_payment",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Decrease product quantities
    for (const item of args.items) {
      const product = await ctx.db.get(item.productId);
      if (product) {
        const newQuantity = product.quantity - item.quantity;
        await ctx.db.patch(item.productId, {
          quantity: newQuantity,
          status: newQuantity === 0 ? "sold" : product.status,
          updatedAt: Date.now(),
        });
      }
    }

    return orderId;
  },
});

// Get order by ID
export const getOrder = query({
  args: { orderId: v.id("orders") },
  handler: async (ctx, args) => {
    const order = await ctx.db.get(args.orderId);
    if (!order) return null;

    const buyer = await ctx.db.get(order.buyerId);
    const seller = await buildSellerPublicProfile(ctx, order.sellerId);

    return {
      ...order,
      buyer: buyer
        ? { _id: buyer._id, firstName: buyer.firstName, lastName: buyer.lastName }
        : null,
      seller,
    };
  },
});

// Get order by order number
export const getOrderByNumber = query({
  args: { orderNumber: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("orders")
      .withIndex("by_order_number", (q) => q.eq("orderNumber", args.orderNumber))
      .first();
  },
});

// Get buyer's orders
export const getBuyerOrders = query({
  args: {
    buyerId: v.id("users"),
    status: v.optional(
      v.union(
        v.literal("pending_payment"),
        v.literal("paid"),
        v.literal("processing"),
        v.literal("shipped"),
        v.literal("delivered"),
        v.literal("completed"),
        v.literal("cancelled"),
        v.literal("disputed")
      )
    ),
  },
  handler: async (ctx, args) => {
    let ordersQuery = ctx.db
      .query("orders")
      .withIndex("by_buyer", (q) => q.eq("buyerId", args.buyerId));

    if (args.status) {
      ordersQuery = ordersQuery.filter((q) => q.eq(q.field("status"), args.status));
    }

    const orders = await ordersQuery.order("desc").collect();

    // Add seller info
    return await Promise.all(
      orders.map(async (order) => {
        const seller = await buildSellerPublicProfile(ctx, order.sellerId);
        return {
          ...order,
          seller,
        };
      })
    );
  },
});

// Get seller's orders
export const getSellerOrders = query({
  args: {
    sellerId: v.id("users"),
    status: v.optional(
      v.union(
        v.literal("pending_payment"),
        v.literal("paid"),
        v.literal("processing"),
        v.literal("shipped"),
        v.literal("delivered"),
        v.literal("completed"),
        v.literal("cancelled"),
        v.literal("disputed")
      )
    ),
  },
  handler: async (ctx, args) => {
    let ordersQuery = ctx.db
      .query("orders")
      .withIndex("by_seller", (q) => q.eq("sellerId", args.sellerId));

    if (args.status) {
      ordersQuery = ordersQuery.filter((q) => q.eq(q.field("status"), args.status));
    }

    const orders = await ordersQuery.order("desc").collect();

    // Add buyer info
    return await Promise.all(
      orders.map(async (order) => {
        const buyer = await ctx.db.get(order.buyerId);
        return {
          ...order,
          buyer: buyer
            ? { _id: buyer._id, firstName: buyer.firstName, lastName: buyer.lastName }
            : null,
        };
      })
    );
  },
});

export const getManagedCatalogOrders = query({
  args: {
    actorUserId: v.id("users"),
    status: v.optional(
      v.union(
        v.literal("pending_payment"),
        v.literal("paid"),
        v.literal("processing"),
        v.literal("shipped"),
        v.literal("delivered"),
        v.literal("completed"),
        v.literal("cancelled"),
        v.literal("disputed")
      )
    ),
  },
  handler: async (ctx, args) => {
    await ensureCatalogActor(ctx, args.actorUserId);
    const settings = await getPlatformSettings(ctx);
    if (!settings) {
      return [];
    }

    let ordersQuery = ctx.db
      .query("orders")
      .withIndex("by_seller", (q) => q.eq("sellerId", settings.companySellerUserId));

    if (args.status) {
      ordersQuery = ordersQuery.filter((q) => q.eq(q.field("status"), args.status));
    }

    const orders = await ordersQuery.order("desc").collect();

    return await Promise.all(
      orders.map(async (order) => {
        const buyer = await ctx.db.get(order.buyerId);
        return {
          ...order,
          buyer: buyer
            ? { _id: buyer._id, firstName: buyer.firstName, lastName: buyer.lastName }
            : null,
        };
      })
    );
  },
});

// Update order status
export const updateOrderStatus = mutation({
  args: {
    orderId: v.id("orders"),
    userId: v.id("users"),
    status: v.union(
      v.literal("paid"),
      v.literal("processing"),
      v.literal("shipped"),
      v.literal("delivered"),
      v.literal("completed"),
      v.literal("cancelled"),
      v.literal("disputed")
    ),
  },
  handler: async (ctx, args) => {
    const order = await ctx.db.get(args.orderId);
    if (!order) throw new Error("Order not found");

    const user = await ctx.db.get(args.userId);
    if (!user) throw new Error("User not found");

    // Validate who can update to what status
    const isBuyer = order.buyerId === args.userId;
    const isSeller =
      order.sellerId === args.userId ||
      (await canActAsCompanySeller(ctx, args.userId, order.sellerId));
    const isModerator = user.role === "moderator" || user.role === "admin";

    // Status transition rules
    const allowedTransitions: Record<string, { buyer?: string[]; seller?: string[]; moderator?: string[] }> = {
      pending_payment: { buyer: ["cancelled"], seller: [], moderator: ["cancelled"] },
      paid: { buyer: [], seller: ["processing"], moderator: ["cancelled"] },
      processing: { buyer: [], seller: ["shipped"], moderator: ["cancelled"] },
      shipped: { buyer: ["delivered"], seller: [], moderator: [] },
      delivered: { buyer: ["completed", "disputed"], seller: [], moderator: [] },
      completed: { buyer: [], seller: [], moderator: [] },
      cancelled: { buyer: [], seller: [], moderator: [] },
      disputed: { buyer: [], seller: [], moderator: ["completed", "cancelled"] },
    };

    const currentAllowed = allowedTransitions[order.status];
    let canUpdate = false;

    if (currentAllowed) {
      if (isBuyer && currentAllowed.buyer?.includes(args.status)) canUpdate = true;
      if (isSeller && currentAllowed.seller?.includes(args.status)) canUpdate = true;
      if (isModerator && currentAllowed.moderator?.includes(args.status)) canUpdate = true;
    }

    if (!canUpdate) {
      throw new Error(`Cannot transition from ${order.status} to ${args.status}`);
    }

    await ctx.db.patch(args.orderId, {
      status: args.status,
      updatedAt: Date.now(),
    });

    return await ctx.db.get(args.orderId);
  },
});

// Add tracking information (seller only)
export const addTrackingInfo = mutation({
  args: {
    orderId: v.id("orders"),
    sellerId: v.id("users"),
    trackingNumber: v.string(),
    shippingCarrier: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const order = await ctx.db.get(args.orderId);
    if (!order) throw new Error("Order not found");
    if (!(await canActAsCompanySeller(ctx, args.sellerId, order.sellerId))) {
      throw new Error("Unauthorized");
    }

    await ctx.db.patch(args.orderId, {
      trackingNumber: args.trackingNumber,
      shippingCarrier: args.shippingCarrier,
      updatedAt: Date.now(),
    });

    return await ctx.db.get(args.orderId);
  },
});

// Mark order as shipped (seller)
export const markAsShipped = mutation({
  args: {
    orderId: v.id("orders"),
    sellerId: v.id("users"),
    trackingNumber: v.optional(v.string()),
    shippingCarrier: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const order = await ctx.db.get(args.orderId);
    if (!order) throw new Error("Order not found");
    if (!(await canActAsCompanySeller(ctx, args.sellerId, order.sellerId))) {
      throw new Error("Unauthorized");
    }
    if (order.status !== "processing" && order.status !== "paid") {
      throw new Error("Order must be in processing or paid status to mark as shipped");
    }

    await ctx.db.patch(args.orderId, {
      status: "shipped",
      trackingNumber: args.trackingNumber,
      shippingCarrier: args.shippingCarrier,
      updatedAt: Date.now(),
    });

    return await ctx.db.get(args.orderId);
  },
});

// Confirm delivery (buyer)
export const confirmDelivery = mutation({
  args: {
    orderId: v.id("orders"),
    buyerId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const order = await ctx.db.get(args.orderId);
    if (!order) throw new Error("Order not found");
    if (order.buyerId !== args.buyerId) throw new Error("Unauthorized");
    if (order.status !== "shipped") {
      throw new Error("Order must be shipped to confirm delivery");
    }

    await ctx.db.patch(args.orderId, {
      status: "delivered",
      updatedAt: Date.now(),
    });

    return await ctx.db.get(args.orderId);
  },
});

// Complete order and release funds (buyer)
export const completeOrder = mutation({
  args: {
    orderId: v.id("orders"),
    buyerId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const order = await ctx.db.get(args.orderId);
    if (!order) throw new Error("Order not found");
    if (order.buyerId !== args.buyerId) throw new Error("Unauthorized");
    if (order.status !== "delivered") {
      throw new Error("Order must be delivered to complete");
    }

    await ctx.db.patch(args.orderId, {
      status: "completed",
      updatedAt: Date.now(),
    });

    // Increment seller's sales and buyer's purchases
    const seller = await ctx.db.get(order.sellerId);
    const buyer = await ctx.db.get(order.buyerId);

    if (seller) {
      await ctx.db.patch(seller._id, {
        totalSales: seller.totalSales + 1,
        updatedAt: Date.now(),
      });
    }

    if (buyer) {
      await ctx.db.patch(buyer._id, {
        totalPurchases: buyer.totalPurchases + 1,
        updatedAt: Date.now(),
      });
    }

    return await ctx.db.get(args.orderId);
  },
});

// Cancel order
export const cancelOrder = mutation({
  args: {
    orderId: v.id("orders"),
    userId: v.id("users"),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const order = await ctx.db.get(args.orderId);
    if (!order) throw new Error("Order not found");

    const user = await ctx.db.get(args.userId);
    if (!user) throw new Error("User not found");

    const isBuyer = order.buyerId === args.userId;
    const isAdmin = user.role === "admin";

    if (!isBuyer && !isAdmin) {
      throw new Error("Unauthorized");
    }

    // Only allow cancellation before shipping
    if (!["pending_payment", "paid", "processing"].includes(order.status)) {
      throw new Error("Order cannot be cancelled at this stage");
    }

    // Restore product quantities
    for (const item of order.items) {
      const product = await ctx.db.get(item.productId);
      if (product) {
        await ctx.db.patch(item.productId, {
          quantity: product.quantity + item.quantity,
          status: product.status === "sold" ? "active" : product.status,
          updatedAt: Date.now(),
        });
      }
    }

    await ctx.db.patch(args.orderId, {
      status: "cancelled",
      notes: args.reason,
      updatedAt: Date.now(),
    });

    return await ctx.db.get(args.orderId);
  },
});

// Get order statistics (for admin dashboard)
export const getOrderStats = query({
  args: { adminId: v.id("users") },
  handler: async (ctx, args) => {
    const admin = await ctx.db.get(args.adminId);
    if (!admin || admin.role !== "admin") {
      throw new Error("Unauthorized");
    }

    const allOrders = await ctx.db.query("orders").collect();

    const stats = {
      total: allOrders.length,
      pendingPayment: 0,
      paid: 0,
      processing: 0,
      shipped: 0,
      delivered: 0,
      completed: 0,
      cancelled: 0,
      disputed: 0,
      totalRevenue: 0,
    };

    for (const order of allOrders) {
      switch (order.status) {
        case "pending_payment":
          stats.pendingPayment++;
          break;
        case "paid":
          stats.paid++;
          break;
        case "processing":
          stats.processing++;
          break;
        case "shipped":
          stats.shipped++;
          break;
        case "delivered":
          stats.delivered++;
          break;
        case "completed":
          stats.completed++;
          stats.totalRevenue += order.totalAmount;
          break;
        case "cancelled":
          stats.cancelled++;
          break;
        case "disputed":
          stats.disputed++;
          break;
      }
    }

    return stats;
  },
});

// Mark order as paid using wallet
export const markPaidByWallet = mutation({
  args: {
    orderId: v.id("orders"),
    walletReference: v.string(),
  },
  handler: async (ctx, args) => {
    const order = await ctx.db.get(args.orderId);
    if (!order) throw new Error("Order not found");
    if (order.status !== "pending_payment") {
      throw new Error("Order is not pending payment");
    }

    const now = Date.now();

    // Update order status to paid
    await ctx.db.patch(args.orderId, {
      status: "paid",
      updatedAt: now,
    });

    // Create escrow record
    await ctx.db.insert("escrow", {
      orderId: args.orderId,
      buyerId: order.buyerId,
      sellerId: order.sellerId,
      grossAmount: order.totalAmount,
      platformFee: order.platformFee,
      sellerAmount: order.sellerPayout,
      amount: order.totalAmount, // Legacy field
      status: "held",
      createdAt: now,
      updatedAt: now,
    });

    // Notify seller
    await ctx.db.insert("notifications", {
      userId: order.sellerId,
      type: "payment_received",
      title: "Payment Received (Wallet)",
      message: `Payment received for order #${order.orderNumber} via wallet. Please process the order.`,
      data: { orderId: args.orderId },
      isRead: false,
      createdAt: now,
    });

    // Notify buyer
    await ctx.db.insert("notifications", {
      userId: order.buyerId,
      type: "order_status_update",
      title: "Payment Successful",
      message: `Your wallet payment for order #${order.orderNumber} was successful.`,
      data: { orderId: args.orderId, walletReference: args.walletReference },
      isRead: false,
      createdAt: now,
    });

    return await ctx.db.get(args.orderId);
  },
});
