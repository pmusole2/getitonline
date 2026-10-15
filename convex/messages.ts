import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, internalMutation } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { requireUser } from "./lib/auth";
import { canReadDispute, speakerSideOf, speakerSideOfMessage } from "./lib/disputeAccess";

// The dispute whose conversation the actor may read. A missing dispute holds no private data, so it reads as null;
// an existing dispute the actor may not read is refused.
async function readableDispute(ctx: QueryCtx, actor: Doc<"users">, disputeId: Id<"disputes">) {
  const dispute = await ctx.db.get(disputeId);
  if (!dispute) {
    return null;
  }
  if (!(await canReadDispute(ctx, actor, dispute))) {
    throw new Error("Unauthorized");
  }
  return dispute;
}

// Send message in dispute conversation
export const sendMessage = mutation({
  args: {
    disputeId: v.id("disputes"),
    content: v.string(),
    originalContent: v.optional(v.string()), // if AI suggested rephrasing
    attachments: v.optional(
      v.array(
        v.object({
          type: v.union(v.literal("image"), v.literal("video")),
          url: v.string(),
        })
      )
    ),
    aiRephraseAccepted: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const dispute = await ctx.db.get(args.disputeId);
    if (!dispute) {
      throw new Error("Dispute not found");
    }

    // Reviewers, the buyer, and the seller side may reply. The seller side includes catalog staff delegated for the
    // company seller account, and nobody else.
    if (!(await canReadDispute(ctx, actor, dispute))) {
      throw new Error("Unauthorized: You are not a participant in this dispute");
    }
    const speakerSide = await speakerSideOf(ctx, actor, dispute);
    const isParticipant = speakerSide !== "moderator";

    // Don't allow messages in resolved/closed disputes
    if (dispute.status === "resolved" || dispute.status === "closed") {
      throw new Error("Cannot send messages to resolved or closed disputes");
    }

    // If it's the first message from either party after opening, update status
    if (dispute.status === "open") {
      await ctx.db.patch(args.disputeId, {
        status: "in_discussion",
        updatedAt: Date.now(),
      });
    }

    const messageId = await ctx.db.insert("messages", {
      disputeId: args.disputeId,
      senderId: actor._id,
      content: args.content,
      originalContent: args.originalContent,
      attachments: args.attachments,
      isSystemMessage: false,
      aiRephraseAccepted: args.aiRephraseAccepted,
      speakerSide,
      createdAt: Date.now(),
    });

    // Update dispute updatedAt
    await ctx.db.patch(args.disputeId, {
      updatedAt: Date.now(),
    });

    // Notify the other party about the new message
    const senderName = `${actor.firstName} ${actor.lastName}`;
    const recipientId = actor._id === dispute.buyerId ? dispute.sellerId : dispute.buyerId;

    // Don't notify if sender is moderator messaging (they'll see it)
    if (isParticipant) {
      await ctx.db.insert("notifications", {
        userId: recipientId,
        type: "new_message",
        title: "New Dispute Message",
        message: `${senderName} sent a message in your dispute`,
        data: { disputeId: args.disputeId },
        isRead: false,
        createdAt: Date.now(),
      });
    }

    return messageId;
  },
});

// Get messages for a dispute (realtime subscription)
export const getMessages = query({
  args: { disputeId: v.id("disputes") },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    if (!(await readableDispute(ctx, actor, args.disputeId))) {
      return [];
    }

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_dispute_created", (q) => q.eq("disputeId", args.disputeId))
      .order("asc")
      .collect();

    // Add sender info to each message
    return await Promise.all(
      messages.map(async (message) => {
        const sender = await ctx.db.get(message.senderId);
        return {
          ...message,
          sender: sender
            ? {
                _id: sender._id,
                firstName: sender.firstName,
                lastName: sender.lastName,
                avatar: sender.avatar,
                role: sender.role,
              }
            : null,
        };
      })
    );
  },
});

// Get messages with pagination
export const getMessagesPaginated = query({
  args: {
    disputeId: v.id("disputes"),
    limit: v.optional(v.number()),
    cursor: v.optional(v.id("messages")),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    if (!(await readableDispute(ctx, actor, args.disputeId))) {
      return { messages: [], hasMore: false, nextCursor: null };
    }

    const limit = args.limit ?? 50;

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_dispute_created", (q) => q.eq("disputeId", args.disputeId))
      .order("desc")
      .take(limit + 1);

    const hasMore = messages.length > limit;
    const items = hasMore ? messages.slice(0, -1) : messages;

    // Reverse to get chronological order
    items.reverse();

    // Add sender info
    const messagesWithSenders = await Promise.all(
      items.map(async (message) => {
        const sender = await ctx.db.get(message.senderId);
        return {
          ...message,
          sender: sender
            ? {
                _id: sender._id,
                firstName: sender.firstName,
                lastName: sender.lastName,
                avatar: sender.avatar,
                role: sender.role,
              }
            : null,
        };
      })
    );

    const firstItem = items[0];
    return {
      messages: messagesWithSenders,
      hasMore,
      nextCursor: hasMore && firstItem ? firstItem._id : null,
    };
  },
});

// Get message count for dispute
export const getMessageCount = query({
  args: { disputeId: v.id("disputes") },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    if (!(await readableDispute(ctx, actor, args.disputeId))) {
      return 0;
    }

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_dispute", (q) => q.eq("disputeId", args.disputeId))
      .collect();

    return messages.length;
  },
});

// Get last message for dispute (for preview in list)
export const getLastMessage = query({
  args: { disputeId: v.id("disputes") },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    if (!(await readableDispute(ctx, actor, args.disputeId))) {
      return null;
    }

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_dispute_created", (q) => q.eq("disputeId", args.disputeId))
      .order("desc")
      .take(1);

    const message = messages[0];
    if (!message) {
      return null;
    }

    const sender = await ctx.db.get(message.senderId);

    return {
      ...message,
      sender: sender
        ? {
            _id: sender._id,
            firstName: sender.firstName,
            lastName: sender.lastName,
          }
        : null,
    };
  },
});

// Add system message
export const addSystemMessage = internalMutation({
  args: {
    disputeId: v.id("disputes"),
    content: v.string(),
    senderId: v.id("users"), // Usually the system/moderator
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("messages", {
      disputeId: args.disputeId,
      senderId: args.senderId,
      content: args.content,
      isSystemMessage: true,
      createdAt: Date.now(),
    });
  },
});

// Get all messages for AI analysis
export const getMessagesForAnalysis = query({
  args: { disputeId: v.id("disputes") },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const dispute = await readableDispute(ctx, actor, args.disputeId);
    if (!dispute) {
      return null;
    }

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_dispute_created", (q) => q.eq("disputeId", args.disputeId))
      .order("asc")
      .collect();

    const buyer = await ctx.db.get(dispute.buyerId);
    const seller = await ctx.db.get(dispute.sellerId);

    return {
      dispute: {
        title: dispute.title,
        description: dispute.description,
        category: dispute.category,
        status: dispute.status,
      },
      participants: {
        buyer: buyer ? { _id: buyer._id, name: `${buyer.firstName} ${buyer.lastName}` } : null,
        seller: seller ? { _id: seller._id, name: `${seller.firstName} ${seller.lastName}` } : null,
      },
      messages: messages.map((msg) => ({
        senderId: msg.senderId,
        senderRole: speakerSideOfMessage(msg, dispute),
        content: msg.content,
        isSystemMessage: msg.isSystemMessage,
        timestamp: msg.createdAt,
      })),
      evidenceCount: dispute.evidence.length,
    };
  },
});

// Mark messages as sent with AI rephrase. Only the author changes their own message, and only while they can read
// its dispute.
export const updateMessageWithRephrase = mutation({
  args: {
    messageId: v.id("messages"),
    aiRephraseAccepted: v.boolean(),
    originalContent: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const message = await ctx.db.get(args.messageId);
    if (!message) {
      throw new Error("Message not found");
    }
    if (message.senderId !== actor._id) {
      throw new Error("Unauthorized: Only the sender can change this message");
    }

    const dispute = await ctx.db.get(message.disputeId);
    if (!dispute || !(await canReadDispute(ctx, actor, dispute))) {
      throw new Error("Unauthorized");
    }

    await ctx.db.patch(args.messageId, {
      aiRephraseAccepted: args.aiRephraseAccepted,
      originalContent: args.originalContent,
    });

    return await ctx.db.get(args.messageId);
  },
});
