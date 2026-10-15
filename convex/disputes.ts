import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, mutation, query } from "./_generated/server";
import { actsAsDisputeSeller, canReadDispute, isDisputeBuyer, speakerSideOf } from "./lib/disputeAccess";
import { ensureAdminActor, ensureReviewerActor, isReviewerRole } from "./lib/platform";
import type { MutationCtx } from "./_generated/server";
import { requireRole, requireUser } from "./lib/auth";
import { applyEscrowAccounting } from "./lib/escrowAccounting";

// Escrow still holds the buyer's funds only while it is held or disputed, the same states the refund flows accept.
// Released, refunded, and partially refunded escrow is final, and a dispute decision must not reopen it.
function escrowHoldsFunds(status: Doc<"escrow">["status"]): boolean {
  return status === "held" || status === "disputed";
}

// Public decisions also preflight nonmoney agreed_refund, which must not
// bypass a sealed financial approval or erase a recorded legacy resolution.
async function disputeDecisionRecords(ctx: MutationCtx, dispute: Doc<"disputes">): Promise<Doc<"escrow">> {
  if (dispute.resolution !== undefined) {
    throw new Error("Dispute already has a recorded resolution and needs review");
  }
  const escrow = await ctx.db.get(dispute.escrowId);
  if (!escrow) {
    throw new Error("Escrow not found");
  }
  if (!escrowHoldsFunds(escrow.status)) {
    throw new Error("Escrow is no longer holding funds for this dispute");
  }
  const order = await ctx.db.get(dispute.orderId);
  const escrows = await ctx.db
    .query("escrow")
    .withIndex("by_order", (q) => q.eq("orderId", dispute.orderId))
    .collect();
  const disputes = await ctx.db
    .query("disputes")
    .withIndex("by_order", (q) => q.eq("orderId", dispute.orderId))
    .collect();
  if (
    !order ||
    order.status !== "disputed" ||
    escrow.orderId !== order._id ||
    order.buyerId !== dispute.buyerId ||
    order.sellerId !== dispute.sellerId ||
    escrow.buyerId !== dispute.buyerId ||
    escrow.sellerId !== dispute.sellerId ||
    escrows.length !== 1 ||
    escrows[0]?._id !== escrow._id ||
    disputes.length !== 1 ||
    disputes[0]?._id !== dispute._id
  ) {
    throw new Error("Dispute records need review");
  }
  return escrow;
}

// Create a new dispute
export const createDispute = mutation({
  args: {
    orderId: v.id("orders"),
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
    const actor = await requireUser(ctx);
    const order = await ctx.db.get(args.orderId);
    if (!order) {
      throw new Error("Order not found");
    }
    if (order.buyerId !== actor._id) {
      throw new Error("Unauthorized");
    }
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
    // Only held escrow can be disputed, the rule escrow.markAsDisputed applies. Refunded, released, partially refunded,
    // and already disputed escrow are refused before anything is written.
    if (escrow.status !== "held") {
      throw new Error("Escrow cannot be disputed in current state");
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
      buyerId: actor._id,
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
      senderId: actor._id,
      content: `Dispute opened: ${args.title}`,
      isSystemMessage: true,
      speakerSide: "buyer",
      createdAt: Date.now(),
    });

    // Buyer name for the seller's notification
    const buyerName = `${actor.firstName} ${actor.lastName}`;

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
    const actor = await requireUser(ctx);
    const dispute = await ctx.db.get(args.disputeId);
    if (!dispute) {
      return null;
    }
    if (!(await canReadDispute(ctx, actor, dispute))) {
      throw new Error("Unauthorized");
    }

    const order = await ctx.db.get(dispute.orderId);
    const escrow = await ctx.db.get(dispute.escrowId);
    const buyer = await ctx.db.get(dispute.buyerId);
    const seller = await ctx.db.get(dispute.sellerId);
    const moderator = dispute.moderatorId ? await ctx.db.get(dispute.moderatorId) : null;

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
    const actor = await requireUser(ctx);
    const dispute = await ctx.db
      .query("disputes")
      .withIndex("by_order", (q) => q.eq("orderId", args.orderId))
      .first();

    if (!dispute) {
      return null;
    }
    if (!(await canReadDispute(ctx, actor, dispute))) {
      throw new Error("Unauthorized");
    }

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
      buyer: buyer ? { _id: buyer._id, firstName: buyer.firstName, lastName: buyer.lastName } : null,
      seller: seller ? { _id: seller._id, firstName: seller.firstName, lastName: seller.lastName } : null,
    };
  },
});

// Get disputes by buyer
export const getBuyerDisputes = query({
  args: {
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
    const actor = await requireUser(ctx);
    let disputesQuery = ctx.db.query("disputes").withIndex("by_buyer", (q) => q.eq("buyerId", actor._id));

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
          seller: seller ? { _id: seller._id, firstName: seller.firstName, lastName: seller.lastName } : null,
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
    const actor = await requireUser(ctx);
    if (!(await actsAsDisputeSeller(ctx, actor, args.sellerId)) && !isReviewerRole(actor.role)) {
      throw new Error("Unauthorized");
    }

    let disputesQuery = ctx.db.query("disputes").withIndex("by_seller", (q) => q.eq("sellerId", args.sellerId));

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
          buyer: buyer ? { _id: buyer._id, firstName: buyer.firstName, lastName: buyer.lastName } : null,
        };
      })
    );
  },
});

// Get all open disputes (for moderators)
export const getOpenDisputes = query({
  args: { moderatorId: v.id("users") },
  handler: async (ctx) => {
    await ensureReviewerActor(ctx);

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
          buyer: buyer ? { _id: buyer._id, firstName: buyer.firstName, lastName: buyer.lastName } : null,
          seller: seller ? { _id: seller._id, firstName: seller.firstName, lastName: seller.lastName } : null,
        };
      })
    );
  },
});

// Get disputes assigned to moderator
export const getModeratorDisputes = query({
  args: { moderatorId: v.id("users") },
  handler: async (ctx) => {
    const moderator = await ensureReviewerActor(ctx);

    return await ctx.db
      .query("disputes")
      .withIndex("by_moderator", (q) => q.eq("moderatorId", moderator._id))
      .filter((q) => q.or(q.eq(q.field("status"), "moderator_review"), q.eq(q.field("status"), "in_discussion")))
      .order("desc")
      .collect();
  },
});

// Update dispute status
export const updateDisputeStatus = mutation({
  args: {
    disputeId: v.id("disputes"),
    status: v.union(
      v.literal("in_discussion"),
      v.literal("moderator_review"),
      v.literal("resolved"),
      v.literal("closed")
    ),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const dispute = await ctx.db.get(args.disputeId);
    if (!dispute) {
      throw new Error("Dispute not found");
    }

    // The buyer and the seller side may move a dispute, and reviewers may too. Anyone else is refused before any
    // transition is checked or written.
    const isParty = isDisputeBuyer(actor, dispute) || (await actsAsDisputeSeller(ctx, actor, dispute.sellerId));
    const isReviewer = isReviewerRole(actor.role);
    if (!isParty && !isReviewer) {
      throw new Error("Unauthorized");
    }

    // Validate status transition
    if (args.status === "in_discussion" && dispute.status !== "open") {
      throw new Error("Can only move to in_discussion from open status");
    }

    if (args.status === "moderator_review" && !isParty) {
      throw new Error("Only buyer or seller can request moderator review");
    }

    if ((args.status === "resolved" || args.status === "closed") && !isReviewer) {
      throw new Error("Only moderators can resolve or close disputes");
    }

    // A dispute is decided only through resolveDispute, which records the decision and settles the escrow.
    if (args.status === "resolved") {
      throw new Error("Resolve a dispute through resolveDispute, which records the decision and settles escrow");
    }
    // A resolved dispute holds a recorded decision, and a closed one is final. A reviewer may only archive a resolved
    // dispute by closing it, so any other change is refused before anything is written.
    if (dispute.status === "closed" || (dispute.status === "resolved" && args.status !== "closed")) {
      throw new Error("Resolved or closed disputes cannot be reopened");
    }

    await ctx.db.patch(args.disputeId, {
      status: args.status,
      updatedAt: Date.now(),
    });

    // Add system message
    await ctx.db.insert("messages", {
      disputeId: args.disputeId,
      senderId: actor._id,
      content: `Dispute status changed to: ${args.status}`,
      isSystemMessage: true,
      speakerSide: await speakerSideOf(ctx, actor, dispute),
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
    const moderator = await ensureReviewerActor(ctx);

    const dispute = await ctx.db.get(args.disputeId);
    if (!dispute) {
      throw new Error("Dispute not found");
    }

    // Assigning a moderator sends the dispute back into review, so a decided or closed dispute is refused first.
    if (dispute.status === "resolved" || dispute.status === "closed") {
      throw new Error("Resolved or closed disputes cannot be reopened");
    }

    await ctx.db.patch(args.disputeId, {
      moderatorId: moderator._id,
      status: "moderator_review",
      updatedAt: Date.now(),
    });

    // Add system message
    await ctx.db.insert("messages", {
      disputeId: args.disputeId,
      senderId: moderator._id,
      content: `Moderator ${moderator.firstName} ${moderator.lastName} has been assigned to this dispute`,
      isSystemMessage: true,
      speakerSide: "moderator",
      createdAt: Date.now(),
    });

    return await ctx.db.get(args.disputeId);
  },
});

// Resolve dispute
export const resolveDispute = mutation({
  args: {
    disputeId: v.id("disputes"),
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
    const moderator = await requireRole(ctx, ["moderator", "admin"]);

    const dispute = await ctx.db.get(args.disputeId);
    if (!dispute) {
      throw new Error("Dispute not found");
    }

    // Check the dispute and its escrow are still open to a decision before anything is written.
    if (dispute.status === "resolved" || dispute.status === "closed") {
      throw new Error("Dispute is already resolved or closed");
    }

    if (!["open", "in_discussion", "moderator_review"].includes(dispute.status)) {
      throw new Error("This dispute cannot be resolved at this stage");
    }
    if (args.resolutionType === "mutual_agreement") {
      throw new Error("Unsupported dispute resolution");
    }
    const escrow = await disputeDecisionRecords(ctx, dispute);
    const result = await applyEscrowAccounting(
      ctx,
      escrow,
      moderator,
      args.resolutionType === "no_refund" ? "release" : args.resolutionType,
      args.resolutionType === "partial_refund" ? args.refundAmount : undefined,
      { kind: "reviewer_dispute", dispute, resolutionType: args.resolutionType }
    );
    if (result.application === "review") {
      return { ...dispute, accountingOutcome: "review" as const };
    }
    // Proof owns first approval/time; resolution records this verified processor
    // and processing time, including a later authorized retry after a hold.
    const now = result.escrow.updatedAt;

    // Update dispute
    await ctx.db.patch(args.disputeId, {
      status: "resolved",
      resolution: {
        type: args.resolutionType,
        ...(args.resolutionType === "no_refund" ? {} : { refundAmount: result.escrow.refundAmount }),
        resolvedBy: moderator._id,
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
      senderId: moderator._id,
      content: `Dispute resolved: ${args.resolutionType}. ${args.notes}`,
      isSystemMessage: true,
      speakerSide: "moderator",
      createdAt: now,
    });

    return { ...(await ctx.db.get(args.disputeId)), accountingOutcome: "applied" as const };
  },
});

// Buyer resolves dispute (mutual agreement reached)
export const buyerResolveDispute = mutation({
  args: {
    disputeId: v.id("disputes"),
    resolutionType: v.union(
      v.literal("withdraw"), // Buyer withdraws complaint, funds released to seller
      v.literal("received_item"), // Item was eventually received
      v.literal("issue_resolved"), // Seller resolved the issue
      v.literal("agreed_refund") // Agreed on refund (handled separately by seller/admin)
    ),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const dispute = await ctx.db.get(args.disputeId);
    if (!dispute) {
      throw new Error("Dispute not found");
    }

    // Only the buyer can resolve via this method
    if (dispute.buyerId !== actor._id) {
      throw new Error("Only the buyer can resolve this dispute");
    }

    // Can only resolve open or in_discussion disputes
    if (!["open", "in_discussion", "moderator_review"].includes(dispute.status)) {
      throw new Error("This dispute cannot be resolved at this stage");
    }

    const escrow = await disputeDecisionRecords(ctx, dispute);
    if (args.resolutionType === "agreed_refund" && escrow.lifecycleProof !== undefined) {
      throw new Error("Escrow decision conflicts with the immutable approved decision");
    }
    if (
      args.resolutionType === "agreed_refund" &&
      (escrow.refundAmount !== undefined ||
        escrow.releasedAt !== undefined ||
        escrow.sellerPayoutTransactionId !== undefined)
    ) {
      throw new Error("Dispute records need review");
    }
    let now = Date.now();
    if (args.resolutionType !== "agreed_refund") {
      const result = await applyEscrowAccounting(ctx, escrow, actor, "release", undefined, {
        kind: "buyer_dispute",
        dispute,
        resolutionType: args.resolutionType,
      });
      if (result.application === "review") {
        return { ...dispute, accountingOutcome: "review" as const };
      }
      now = result.escrow.updatedAt;
      await ctx.db.patch(dispute.orderId, { status: "completed", updatedAt: now });
    }
    const buyerName = `${actor.firstName} ${actor.lastName}`;

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
      resolution:
        args.resolutionType !== "agreed_refund"
          ? {
              type: "mutual_agreement" as const,
              resolvedBy: actor._id,
              notes: resolutionNotes,
              resolvedAt: now,
            }
          : undefined,
      updatedAt: now,
    });

    // Add system message
    await ctx.db.insert("messages", {
      disputeId: args.disputeId,
      senderId: actor._id,
      content: `${resolutionText[args.resolutionType]}${args.notes ? `: ${args.notes}` : ""}`,
      isSystemMessage: true,
      speakerSide: "buyer",
      createdAt: now,
    });

    // Notify seller
    await ctx.db.insert("notifications", {
      userId: dispute.sellerId,
      type: "dispute_update",
      title: args.resolutionType === "agreed_refund" ? "Refund Agreement Pending" : "Dispute Resolved",
      message:
        args.resolutionType === "agreed_refund"
          ? `${buyerName} has agreed to a refund. Please coordinate with support.`
          : `${buyerName} has resolved the dispute. Funds have been released to you.`,
      data: { disputeId: args.disputeId },
      isRead: false,
      createdAt: now,
    });

    const fresh = await ctx.db.get(args.disputeId);
    return args.resolutionType === "agreed_refund" ? fresh : { ...fresh, accountingOutcome: "applied" as const };
  },
});

// Add evidence to dispute
export const addEvidence = mutation({
  args: {
    disputeId: v.id("disputes"),
    evidence: v.object({
      type: v.union(v.literal("image"), v.literal("video")),
      url: v.string(),
      uploadedAt: v.number(),
    }),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const dispute = await ctx.db.get(args.disputeId);
    if (!dispute) {
      throw new Error("Dispute not found");
    }

    // Only the parties write evidence. Reviewers can read and review a dispute without adding to it.
    if (!isDisputeBuyer(actor, dispute) && !(await actsAsDisputeSeller(ctx, actor, dispute.sellerId))) {
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

// Update AI summary and suggestions. Internal only: any client could otherwise overwrite any dispute's AI text. The
// dispute actions store validated model output through aiDisputesData.persistAnalysis, which rechecks the caller.
export const updateAISummary = internalMutation({
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
  handler: async (ctx) => {
    await ensureAdminActor(ctx);

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
          if (dispute.resolution?.type === "full_refund") {
            stats.fullRefunds++;
          }
          if (dispute.resolution?.type === "partial_refund") {
            stats.partialRefunds++;
          }
          if (dispute.resolution?.type === "no_refund") {
            stats.noRefunds++;
          }
          break;
        case "closed":
          stats.closed++;
          break;
      }
    }

    return stats;
  },
});
