import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";

async function markSuccessfulOrderTransactionsRefunded(
  ctx: MutationCtx,
  orderId: Id<"orders">,
  now: number
) {
  const transactions = await ctx.db
    .query("transactions")
    .withIndex("by_order", (q) => q.eq("orderId", orderId))
    .collect();

  await Promise.all(
    transactions.map(async (transaction) => {
      if (transaction.status !== "successful") {
        return;
      }

      await ctx.db.patch(transaction._id, {
        status: "refunded",
        completedAt: now,
        updatedAt: now,
      });
    })
  );
}

// Create a new dispute
export const createDispute = mutation({
  args: {
    orderId: v.id("orders"),
    buyerId: v.id("users"),
    title: v.string(),
    description: v.string(),
    category: v.union(
      v.literal("not_received"),
      v.literal("defective"),
      v.literal("not_as_described"),
      v.literal("other")
    ),
    evidence: v.array(
      v.object({
        type: v.union(v.literal("image"), v.literal("video")),
        url: v.string(),
        uploadedAt: v.number(),
      })
    ),
  },
  handler: async (ctx, args) => {
    const order = await ctx.db.get(args.orderId);
    if (!order) throw new Error("Order not found");
    if (order.buyerId !== args.buyerId) throw new Error("Unauthorized");
    if (!["delivered", "shipped"].includes(order.status)) {
      throw new Error("Order must be delivered or shipped to open a dispute");
    }

    // Check if dispute already exists
    const existingDispute = await ctx.db
      .query("disputes")
      .withIndex("by_order", (q) => q.eq("orderId", args.orderId))
      .first();

    if (existingDispute) {
      throw new Error("Dispute already exists for this order");
    }

    // Get escrow for this order
    const escrow = await ctx.db
      .query("escrow")
      .withIndex("by_order", (q) => q.eq("orderId", args.orderId))
      .first();

    if (!escrow) {
      throw new Error("Escrow not found for this order");
    }

    // Mark escrow as disputed
    await ctx.db.patch(escrow._id, {
      status: "disputed",
      updatedAt: Date.now(),
    });

    // Update order status
    await ctx.db.patch(args.orderId, {
      status: "disputed",
      updatedAt: Date.now(),
    });

    // Create dispute
    const disputeId = await ctx.db.insert("disputes", {
      orderId: args.orderId,
      escrowId: escrow._id,
      buyerId: args.buyerId,
      sellerId: order.sellerId,
      title: args.title,
      description: args.description,
      category: args.category,
      evidence: args.evidence,
      status: "open",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Create system message
    await ctx.db.insert("messages", {
      disputeId,
      senderId: args.buyerId,
      content: `Dispute opened: ${args.title}`,
      isSystemMessage: true,
      createdAt: Date.now(),
    });

    // Get buyer name for notification
    const buyer = await ctx.db.get(args.buyerId);
    const buyerName = buyer ? `${buyer.firstName} ${buyer.lastName}` : "A buyer";

    // Notify seller about the dispute
    await ctx.db.insert("notifications", {
      userId: order.sellerId,
      type: "dispute_update",
      title: "Dispute Opened",
      message: `${buyerName} has opened a dispute for order #${order.orderNumber}: ${args.title}`,
      data: { disputeId, orderId: args.orderId },
      isRead: false,
      createdAt: Date.now(),
    });

    return disputeId;
  },
});

// Get dispute by ID
export const getDispute = query({
  args: { disputeId: v.id("disputes") },
  handler: async (ctx, args) => {
    const dispute = await ctx.db.get(args.disputeId);
    if (!dispute) return null;

    const order = await ctx.db.get(dispute.orderId);
    const escrow = await ctx.db.get(dispute.escrowId);
    const buyer = await ctx.db.get(dispute.buyerId);
    const seller = await ctx.db.get(dispute.sellerId);
    const moderator = dispute.moderatorId
      ? await ctx.db.get(dispute.moderatorId)
      : null;

    return {
      ...dispute,
      order,
      escrow,
      buyer: buyer
        ? { _id: buyer._id, firstName: buyer.firstName, lastName: buyer.lastName, avatar: buyer.avatar }
        : null,
      seller: seller
        ? { _id: seller._id, firstName: seller.firstName, lastName: seller.lastName, avatar: seller.avatar }
        : null,
      moderator: moderator
        ? { _id: moderator._id, firstName: moderator.firstName, lastName: moderator.lastName }
        : null,
    };
  },
});

// Get dispute by order ID (for order detail screen)
export const getDisputeByOrder = query({
  args: { orderId: v.id("orders") },
  handler: async (ctx, args) => {
    const dispute = await ctx.db
      .query("disputes")
      .withIndex("by_order", (q) => q.eq("orderId", args.orderId))
      .first();

    if (!dispute) return null;

    const buyer = await ctx.db.get(dispute.buyerId);
    const seller = await ctx.db.get(dispute.sellerId);

    return {
      _id: dispute._id,
      title: dispute.title,
      category: dispute.category,
      status: dispute.status,
      description: dispute.description,
      resolution: dispute.resolution,
      createdAt: dispute.createdAt,
      buyer: buyer
        ? { _id: buyer._id, firstName: buyer.firstName, lastName: buyer.lastName }
        : null,
      seller: seller
        ? { _id: seller._id, firstName: seller.firstName, lastName: seller.lastName }
        : null,
    };
  },
});

// Get disputes by buyer
export const getBuyerDisputes = query({
  args: {
    buyerId: v.id("users"),
    status: v.optional(
      v.union(
        v.literal("open"),
        v.literal("in_discussion"),
        v.literal("moderator_review"),
        v.literal("resolved"),
        v.literal("closed")
      )
    ),
  },
  handler: async (ctx, args) => {
    let disputesQuery = ctx.db
      .query("disputes")
      .withIndex("by_buyer", (q) => q.eq("buyerId", args.buyerId));

    if (args.status) {
      disputesQuery = disputesQuery.filter((q) => q.eq(q.field("status"), args.status));
    }

    const disputes = await disputesQuery.order("desc").collect();

    return await Promise.all(
      disputes.map(async (dispute) => {
        const order = await ctx.db.get(dispute.orderId);
        const seller = await ctx.db.get(dispute.sellerId);
        return {
          ...dispute,
          order,
          seller: seller
            ? { _id: seller._id, firstName: seller.firstName, lastName: seller.lastName }
            : null,
        };
      })
    );
  },
});

// Get disputes by seller
export const getSellerDisputes = query({
  args: {
    sellerId: v.id("users"),
    status: v.optional(
      v.union(
        v.literal("open"),
        v.literal("in_discussion"),
        v.literal("moderator_review"),
        v.literal("resolved"),
        v.literal("closed")
      )
    ),
  },
  handler: async (ctx, args) => {
    let disputesQuery = ctx.db
      .query("disputes")
      .withIndex("by_seller", (q) => q.eq("sellerId", args.sellerId));

    if (args.status) {
      disputesQuery = disputesQuery.filter((q) => q.eq(q.field("status"), args.status));
    }

    const disputes = await disputesQuery.order("desc").collect();

    return await Promise.all(
      disputes.map(async (dispute) => {
        const order = await ctx.db.get(dispute.orderId);
        const buyer = await ctx.db.get(dispute.buyerId);
        return {
          ...dispute,
          order,
          buyer: buyer
            ? { _id: buyer._id, firstName: buyer.firstName, lastName: buyer.lastName }
            : null,
        };
      })
    );
  },
});

// Get all open disputes (for moderators)
export const getOpenDisputes = query({
  args: { moderatorId: v.id("users") },
  handler: async (ctx, args) => {
    const moderator = await ctx.db.get(args.moderatorId);
    if (!moderator || (moderator.role !== "moderator" && moderator.role !== "admin")) {
      throw new Error("Unauthorized");
    }

    const disputes = await ctx.db
      .query("disputes")
      .filter((q) =>
        q.or(
          q.eq(q.field("status"), "open"),
          q.eq(q.field("status"), "in_discussion"),
          q.eq(q.field("status"), "moderator_review")
        )
      )
      .order("desc")
      .collect();

    return await Promise.all(
      disputes.map(async (dispute) => {
        const order = await ctx.db.get(dispute.orderId);
        const buyer = await ctx.db.get(dispute.buyerId);
        const seller = await ctx.db.get(dispute.sellerId);
        return {
          ...dispute,
          order,
          buyer: buyer
            ? { _id: buyer._id, firstName: buyer.firstName, lastName: buyer.lastName }
            : null,
          seller: seller
            ? { _id: seller._id, firstName: seller.firstName, lastName: seller.lastName }
            : null,
        };
      })
    );
  },
});

// Get disputes assigned to moderator
export const getModeratorDisputes = query({
  args: { moderatorId: v.id("users") },
  handler: async (ctx, args) => {
    const moderator = await ctx.db.get(args.moderatorId);
    if (!moderator || (moderator.role !== "moderator" && moderator.role !== "admin")) {
      throw new Error("Unauthorized");
    }

    return await ctx.db
      .query("disputes")
      .withIndex("by_moderator", (q) => q.eq("moderatorId", args.moderatorId))
      .filter((q) =>
        q.or(
          q.eq(q.field("status"), "moderator_review"),
          q.eq(q.field("status"), "in_discussion")
        )
      )
      .order("desc")
      .collect();
  },
});

// Update dispute status
export const updateDisputeStatus = mutation({
  args: {
    disputeId: v.id("disputes"),
    userId: v.id("users"),
    status: v.union(
      v.literal("in_discussion"),
      v.literal("moderator_review"),
      v.literal("resolved"),
      v.literal("closed")
    ),
  },
  handler: async (ctx, args) => {
    const dispute = await ctx.db.get(args.disputeId);
    if (!dispute) throw new Error("Dispute not found");

    const user = await ctx.db.get(args.userId);
    if (!user) throw new Error("User not found");

    const isBuyer = dispute.buyerId === args.userId;
    const isSeller = dispute.sellerId === args.userId;
    const isModerator = user.role === "moderator" || user.role === "admin";

    // Validate status transition
    if (args.status === "in_discussion" && dispute.status !== "open") {
      throw new Error("Can only move to in_discussion from open status");
    }

    if (args.status === "moderator_review") {
      if (!isBuyer && !isSeller) {
        throw new Error("Only buyer or seller can request moderator review");
      }
    }

    if ((args.status === "resolved" || args.status === "closed") && !isModerator) {
      throw new Error("Only moderators can resolve or close disputes");
    }

    await ctx.db.patch(args.disputeId, {
      status: args.status,
      updatedAt: Date.now(),
    });

    // Add system message
    await ctx.db.insert("messages", {
      disputeId: args.disputeId,
      senderId: args.userId,
      content: `Dispute status changed to: ${args.status}`,
      isSystemMessage: true,
      createdAt: Date.now(),
    });

    return await ctx.db.get(args.disputeId);
  },
});

// Assign moderator to dispute
export const assignModerator = mutation({
  args: {
    disputeId: v.id("disputes"),
    moderatorId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const moderator = await ctx.db.get(args.moderatorId);
    if (!moderator || (moderator.role !== "moderator" && moderator.role !== "admin")) {
      throw new Error("Unauthorized");
    }

    const dispute = await ctx.db.get(args.disputeId);
    if (!dispute) throw new Error("Dispute not found");

    await ctx.db.patch(args.disputeId, {
      moderatorId: args.moderatorId,
      status: "moderator_review",
      updatedAt: Date.now(),
    });

    // Add system message
    await ctx.db.insert("messages", {
      disputeId: args.disputeId,
      senderId: args.moderatorId,
      content: `Moderator ${moderator.firstName} ${moderator.lastName} has been assigned to this dispute`,
      isSystemMessage: true,
      createdAt: Date.now(),
    });

    return await ctx.db.get(args.disputeId);
  },
});

// Resolve dispute
export const resolveDispute = mutation({
  args: {
    disputeId: v.id("disputes"),
    moderatorId: v.id("users"),
    resolutionType: v.union(
      v.literal("full_refund"),
      v.literal("partial_refund"),
      v.literal("no_refund"),
      v.literal("mutual_agreement")
    ),
    refundAmount: v.optional(v.number()),
    notes: v.string(),
  },
  handler: async (ctx, args) => {
    const moderator = await ctx.db.get(args.moderatorId);
    if (!moderator || (moderator.role !== "moderator" && moderator.role !== "admin")) {
      throw new Error("Unauthorized");
    }

    const dispute = await ctx.db.get(args.disputeId);
    if (!dispute) throw new Error("Dispute not found");

    const escrow = await ctx.db.get(dispute.escrowId);
    if (!escrow) throw new Error("Escrow not found");
    const now = Date.now();

    // Process escrow based on resolution type
    if (args.resolutionType === "full_refund") {
      await ctx.db.patch(dispute.escrowId, {
        status: "refunded",
        refundAmount: escrow.amount,
        updatedAt: now,
      });
      await markSuccessfulOrderTransactionsRefunded(ctx, dispute.orderId, now);
    } else if (args.resolutionType === "partial_refund") {
      if (!args.refundAmount || args.refundAmount <= 0 || args.refundAmount > escrow.amount) {
        throw new Error("Invalid refund amount");
      }
      await ctx.db.patch(dispute.escrowId, {
        status: "partially_refunded",
        refundAmount: args.refundAmount,
        releasedAt: now,
        updatedAt: now,
      });
    } else if (args.resolutionType === "no_refund") {
      await ctx.db.patch(dispute.escrowId, {
        status: "released",
        releasedAt: now,
        updatedAt: now,
      });
    }

    // Update dispute
    await ctx.db.patch(args.disputeId, {
      status: "resolved",
      resolution: {
        type: args.resolutionType,
        refundAmount: args.refundAmount,
        resolvedBy: args.moderatorId,
        notes: args.notes,
        resolvedAt: now,
      },
      updatedAt: now,
    });

    // Update order status
    await ctx.db.patch(dispute.orderId, {
      status: args.resolutionType === "full_refund" ? "cancelled" : "completed",
      updatedAt: now,
    });

    // Add system message
    await ctx.db.insert("messages", {
      disputeId: args.disputeId,
      senderId: args.moderatorId,
      content: `Dispute resolved: ${args.resolutionType}. ${args.notes}`,
      isSystemMessage: true,
      createdAt: now,
    });

    return await ctx.db.get(args.disputeId);
  },
});

// Buyer resolves dispute (mutual agreement reached)
export const buyerResolveDispute = mutation({
  args: {
    disputeId: v.id("disputes"),
    buyerId: v.id("users"),
    resolutionType: v.union(
      v.literal("withdraw"), // Buyer withdraws complaint, funds released to seller
      v.literal("received_item"), // Item was eventually received
      v.literal("issue_resolved"), // Seller resolved the issue
      v.literal("agreed_refund") // Agreed on refund (handled separately by seller/admin)
    ),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const dispute = await ctx.db.get(args.disputeId);
    if (!dispute) throw new Error("Dispute not found");

    // Only the buyer can resolve via this method
    if (dispute.buyerId !== args.buyerId) {
      throw new Error("Only the buyer can resolve this dispute");
    }

    // Can only resolve open or in_discussion disputes
    if (!["open", "in_discussion", "moderator_review"].includes(dispute.status)) {
      throw new Error("This dispute cannot be resolved at this stage");
    }

    const escrow = await ctx.db.get(dispute.escrowId);
    if (!escrow) throw new Error("Escrow not found");

    const buyer = await ctx.db.get(args.buyerId);
    const buyerName = buyer ? `${buyer.firstName} ${buyer.lastName}` : "Buyer";

    const now = Date.now();

    // For withdraw, received_item, or issue_resolved - release funds to seller
    if (["withdraw", "received_item", "issue_resolved"].includes(args.resolutionType)) {
      await ctx.db.patch(dispute.escrowId, {
        status: "released",
        releasedAt: now,
        updatedAt: now,
      });

      // Update order to completed
      await ctx.db.patch(dispute.orderId, {
        status: "completed",
        updatedAt: now,
      });
    }

    // Map resolution types to readable text
    const resolutionText: Record<string, string> = {
      withdraw: "Buyer withdrew the dispute",
      received_item: "Buyer confirmed item was received",
      issue_resolved: "Issue was resolved by the seller",
      agreed_refund: "Parties agreed on a refund (pending processing)",
    };

    // Get the resolution notes - ensure it's always a string
    const resolutionNotes = args.notes || resolutionText[args.resolutionType] || "Dispute resolved by buyer";

    // Update dispute
    await ctx.db.patch(args.disputeId, {
      status: args.resolutionType === "agreed_refund" ? "in_discussion" : "resolved",
      resolution: args.resolutionType !== "agreed_refund" ? {
        type: "mutual_agreement" as const,
        resolvedBy: args.buyerId,
        notes: resolutionNotes,
        resolvedAt: now,
      } : undefined,
      updatedAt: now,
    });

    // Add system message
    await ctx.db.insert("messages", {
      disputeId: args.disputeId,
      senderId: args.buyerId,
      content: `${resolutionText[args.resolutionType]}${args.notes ? `: ${args.notes}` : ''}`,
      isSystemMessage: true,
      createdAt: now,
    });

    // Notify seller
    await ctx.db.insert("notifications", {
      userId: dispute.sellerId,
      type: "dispute_update",
      title: args.resolutionType === "agreed_refund" ? "Refund Agreement Pending" : "Dispute Resolved",
      message: args.resolutionType === "agreed_refund"
        ? `${buyerName} has agreed to a refund. Please coordinate with support.`
        : `${buyerName} has resolved the dispute. Funds have been released to you.`,
      data: { disputeId: args.disputeId },
      isRead: false,
      createdAt: now,
    });

    return await ctx.db.get(args.disputeId);
  },
});

// Add evidence to dispute
export const addEvidence = mutation({
  args: {
    disputeId: v.id("disputes"),
    userId: v.id("users"),
    evidence: v.object({
      type: v.union(v.literal("image"), v.literal("video")),
      url: v.string(),
      uploadedAt: v.number(),
    }),
  },
  handler: async (ctx, args) => {
    const dispute = await ctx.db.get(args.disputeId);
    if (!dispute) throw new Error("Dispute not found");

    if (dispute.buyerId !== args.userId && dispute.sellerId !== args.userId) {
      throw new Error("Unauthorized");
    }

    if (dispute.status === "resolved" || dispute.status === "closed") {
      throw new Error("Cannot add evidence to resolved dispute");
    }

    await ctx.db.patch(args.disputeId, {
      evidence: [...dispute.evidence, args.evidence],
      updatedAt: Date.now(),
    });

    return await ctx.db.get(args.disputeId);
  },
});

// Update AI summary and suggestions
export const updateAISummary = mutation({
  args: {
    disputeId: v.id("disputes"),
    aiSummary: v.string(),
    aiSuggestions: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.disputeId, {
      aiSummary: args.aiSummary,
      aiSuggestions: args.aiSuggestions,
      updatedAt: Date.now(),
    });

    return await ctx.db.get(args.disputeId);
  },
});

// Get dispute statistics
export const getDisputeStats = query({
  args: { adminId: v.id("users") },
  handler: async (ctx, args) => {
    const admin = await ctx.db.get(args.adminId);
    if (!admin || admin.role !== "admin") {
      throw new Error("Unauthorized");
    }

    const allDisputes = await ctx.db.query("disputes").collect();

    const stats = {
      total: allDisputes.length,
      open: 0,
      inDiscussion: 0,
      moderatorReview: 0,
      resolved: 0,
      closed: 0,
      fullRefunds: 0,
      partialRefunds: 0,
      noRefunds: 0,
    };

    for (const dispute of allDisputes) {
      switch (dispute.status) {
        case "open":
          stats.open++;
          break;
        case "in_discussion":
          stats.inDiscussion++;
          break;
        case "moderator_review":
          stats.moderatorReview++;
          break;
        case "resolved":
          stats.resolved++;
          if (dispute.resolution?.type === "full_refund") stats.fullRefunds++;
          if (dispute.resolution?.type === "partial_refund") stats.partialRefunds++;
          if (dispute.resolution?.type === "no_refund") stats.noRefunds++;
          break;
        case "closed":
          stats.closed++;
          break;
      }
    }

    return stats;
  },
});
