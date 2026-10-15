import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireUser } from "./lib/auth";

type RequestCtx = QueryCtx | MutationCtx;
type ConversationDoc = Doc<"conversations">;
type ParticipantRole = "buyer" | "seller";

const reportReasonValidator = v.union(
  v.literal("harassment_or_abuse"),
  v.literal("spam_or_scam"),
  v.literal("unsafe_content"),
  v.literal("other")
);

async function assertRequestUser(ctx: RequestCtx, userId: Id<"users">) {
  const actor = await requireUser(ctx);
  if (actor._id !== userId) {
    throw new Error("Unauthorized");
  }
}

function getParticipantRole(conversation: ConversationDoc, userId: Id<"users">): ParticipantRole | null {
  if (conversation.buyerId === userId) {
    return "buyer";
  }
  if (conversation.sellerId === userId) {
    return "seller";
  }
  return null;
}

async function requireConversationParticipant(
  ctx: RequestCtx,
  conversationId: Id<"conversations">,
  userId: Id<"users">
) {
  await assertRequestUser(ctx, userId);

  const conversation = await ctx.db.get(conversationId);
  if (!conversation) {
    throw new Error("Conversation not found");
  }

  const role = getParticipantRole(conversation, userId);
  if (!role) {
    throw new Error("Unauthorized");
  }

  return { conversation, role };
}

// Start or get existing conversation
export const startConversation = mutation({
  args: {
    productId: v.id("products"),
    buyerId: v.id("users"),
    initialMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await assertRequestUser(ctx, args.buyerId);

    const product = await ctx.db.get(args.productId);
    if (!product) {
      throw new Error("Product not found");
    }
    if (product.status !== "active") {
      throw new Error("Product is not available");
    }

    // Can't message yourself
    if (product.sellerId === args.buyerId) {
      throw new Error("Cannot start conversation with yourself");
    }

    // Check if conversation already exists
    const existingConversation = await ctx.db
      .query("conversations")
      .withIndex("by_buyer_product", (q) => q.eq("buyerId", args.buyerId).eq("productId", args.productId))
      .first();

    if (existingConversation) {
      if (existingConversation.status === "blocked") {
        throw new Error("This conversation has been blocked");
      }

      // Reactivate if archived
      if (existingConversation.status === "archived") {
        await ctx.db.patch(existingConversation._id, {
          status: "active",
          updatedAt: Date.now(),
        });
      }
      return existingConversation._id;
    }

    // Create new conversation
    const now = Date.now();
    const conversationId = await ctx.db.insert("conversations", {
      productId: args.productId,
      buyerId: args.buyerId,
      sellerId: product.sellerId,
      status: "active",
      buyerUnreadCount: 0,
      sellerUnreadCount: args.initialMessage ? 1 : 0,
      lastMessageAt: args.initialMessage ? now : undefined,
      lastMessagePreview: args.initialMessage?.substring(0, 100),
      createdAt: now,
      updatedAt: now,
    });

    // Add initial message if provided
    if (args.initialMessage) {
      await ctx.db.insert("conversationMessages", {
        conversationId,
        senderId: args.buyerId,
        content: args.initialMessage,
        isRead: false,
        isSystemMessage: false,
        createdAt: now,
      });

      // Notify seller
      const buyer = await ctx.db.get(args.buyerId);
      const buyerName = buyer ? `${buyer.firstName} ${buyer.lastName}` : "Someone";

      await ctx.db.insert("notifications", {
        userId: product.sellerId,
        type: "new_message",
        title: "New Message",
        message: `${buyerName} is interested in "${product.title}"`,
        data: { conversationId, productId: args.productId },
        isRead: false,
        createdAt: now,
      });
    }

    return conversationId;
  },
});

// Send message in conversation
export const sendConversationMessage = mutation({
  args: {
    conversationId: v.id("conversations"),
    senderId: v.id("users"),
    content: v.string(),
    attachments: v.optional(
      v.array(
        v.object({
          type: v.union(v.literal("image"), v.literal("video")),
          url: v.string(),
        })
      )
    ),
  },
  handler: async (ctx, args) => {
    await assertRequestUser(ctx, args.senderId);
    const { conversation, role } = await requireConversationParticipant(ctx, args.conversationId, args.senderId);
    const isBuyer = role === "buyer";

    if (conversation.status === "blocked") {
      throw new Error("This conversation has been blocked");
    }

    const now = Date.now();

    // Create message
    const messageId = await ctx.db.insert("conversationMessages", {
      conversationId: args.conversationId,
      senderId: args.senderId,
      content: args.content,
      attachments: args.attachments,
      isRead: false,
      isSystemMessage: false,
      createdAt: now,
    });

    // Update conversation
    const recipientUnreadField = isBuyer ? "sellerUnreadCount" : "buyerUnreadCount";
    const currentUnread = isBuyer ? conversation.sellerUnreadCount : conversation.buyerUnreadCount;

    await ctx.db.patch(args.conversationId, {
      lastMessageAt: now,
      lastMessagePreview: args.content.substring(0, 100),
      [recipientUnreadField]: currentUnread + 1,
      status: "active", // Reactivate if was archived
      updatedAt: now,
    });

    // Notify recipient
    const sender = await ctx.db.get(args.senderId);
    const senderName = sender ? `${sender.firstName} ${sender.lastName}` : "Someone";
    const recipientId = isBuyer ? conversation.sellerId : conversation.buyerId;
    const product = await ctx.db.get(conversation.productId);

    await ctx.db.insert("notifications", {
      userId: recipientId,
      type: "new_message",
      title: "New Message",
      message: `${senderName}: ${args.content.substring(0, 50)}${args.content.length > 50 ? "..." : ""}`,
      data: {
        conversationId: args.conversationId,
        productId: conversation.productId,
        productTitle: product?.title,
      },
      isRead: false,
      createdAt: now,
    });

    return messageId;
  },
});

// Get conversation with full details
export const getConversation = query({
  args: {
    conversationId: v.id("conversations"),
    viewerId: v.id("users"),
  },
  handler: async (ctx, args) => {
    await assertRequestUser(ctx, args.viewerId);

    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) {
      return null;
    }

    if (!getParticipantRole(conversation, args.viewerId)) {
      throw new Error("Unauthorized");
    }

    const product = await ctx.db.get(conversation.productId);
    const buyer = await ctx.db.get(conversation.buyerId);
    const seller = await ctx.db.get(conversation.sellerId);

    return {
      ...conversation,
      product: product
        ? {
            _id: product._id,
            title: product.title,
            price: product.price,
            images: product.images,
            status: product.status,
          }
        : null,
      buyer: buyer
        ? {
            _id: buyer._id,
            firstName: buyer.firstName,
            lastName: buyer.lastName,
            avatar: buyer.avatar,
          }
        : null,
      seller: seller
        ? {
            _id: seller._id,
            firstName: seller.firstName,
            lastName: seller.lastName,
            avatar: seller.avatar,
          }
        : null,
    };
  },
});

// Get messages for conversation
export const getConversationMessages = query({
  args: {
    conversationId: v.id("conversations"),
    viewerId: v.id("users"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await assertRequestUser(ctx, args.viewerId);
    await requireConversationParticipant(ctx, args.conversationId, args.viewerId);

    const limit = Math.min(args.limit ?? 50, 100);

    const messages = await ctx.db
      .query("conversationMessages")
      .withIndex("by_conversation_created", (q) => q.eq("conversationId", args.conversationId))
      .order("asc")
      .take(limit);

    // Add sender info
    return await Promise.all(
      messages.map(async (msg) => {
        const sender = await ctx.db.get(msg.senderId);
        return {
          ...msg,
          sender: sender
            ? {
                _id: sender._id,
                firstName: sender.firstName,
                lastName: sender.lastName,
                avatar: sender.avatar,
              }
            : null,
        };
      })
    );
  },
});

// Get user's conversations (as buyer)
export const getBuyerConversations = query({
  args: {
    buyerId: v.id("users"),
    status: v.optional(v.union(v.literal("active"), v.literal("archived"))),
  },
  handler: async (ctx, args) => {
    await assertRequestUser(ctx, args.buyerId);

    let query = ctx.db.query("conversations").withIndex("by_buyer", (q) => q.eq("buyerId", args.buyerId));

    if (args.status) {
      query = query.filter((q) => q.eq(q.field("status"), args.status));
    } else {
      query = query.filter((q) => q.neq(q.field("status"), "blocked"));
    }

    const conversations = await query.order("desc").collect();

    return await Promise.all(
      conversations.map(async (conv) => {
        const product = await ctx.db.get(conv.productId);
        const seller = await ctx.db.get(conv.sellerId);
        return {
          ...conv,
          product: product
            ? {
                _id: product._id,
                title: product.title,
                price: product.price,
                images: product.images,
                status: product.status,
              }
            : null,
          seller: seller
            ? {
                _id: seller._id,
                firstName: seller.firstName,
                lastName: seller.lastName,
                avatar: seller.avatar,
              }
            : null,
        };
      })
    );
  },
});

// Get user's conversations (as seller)
export const getSellerConversations = query({
  args: {
    sellerId: v.id("users"),
    status: v.optional(v.union(v.literal("active"), v.literal("archived"))),
  },
  handler: async (ctx, args) => {
    await assertRequestUser(ctx, args.sellerId);

    let query = ctx.db.query("conversations").withIndex("by_seller", (q) => q.eq("sellerId", args.sellerId));

    if (args.status) {
      query = query.filter((q) => q.eq(q.field("status"), args.status));
    } else {
      query = query.filter((q) => q.neq(q.field("status"), "blocked"));
    }

    const conversations = await query.order("desc").collect();

    return await Promise.all(
      conversations.map(async (conv) => {
        const product = await ctx.db.get(conv.productId);
        const buyer = await ctx.db.get(conv.buyerId);
        return {
          ...conv,
          product: product
            ? {
                _id: product._id,
                title: product.title,
                price: product.price,
                images: product.images,
                status: product.status,
              }
            : null,
          buyer: buyer
            ? {
                _id: buyer._id,
                firstName: buyer.firstName,
                lastName: buyer.lastName,
                avatar: buyer.avatar,
              }
            : null,
        };
      })
    );
  },
});

// Get all user's conversations (both buyer and seller)
export const getUserConversations = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    await assertRequestUser(ctx, args.userId);

    // Get conversations where user is buyer
    const buyerConversations = await ctx.db
      .query("conversations")
      .withIndex("by_buyer", (q) => q.eq("buyerId", args.userId))
      .filter((q) => q.neq(q.field("status"), "blocked"))
      .collect();

    // Get conversations where user is seller
    const sellerConversations = await ctx.db
      .query("conversations")
      .withIndex("by_seller", (q) => q.eq("sellerId", args.userId))
      .filter((q) => q.neq(q.field("status"), "blocked"))
      .collect();

    // Combine and sort by last message
    const allConversations = [...buyerConversations, ...sellerConversations];
    allConversations.sort((a, b) => (b.lastMessageAt || b.createdAt) - (a.lastMessageAt || a.createdAt));

    return await Promise.all(
      allConversations.map(async (conv) => {
        const product = await ctx.db.get(conv.productId);
        const otherUserId = conv.buyerId === args.userId ? conv.sellerId : conv.buyerId;
        const otherUser = await ctx.db.get(otherUserId);
        const isBuyer = conv.buyerId === args.userId;

        return {
          ...conv,
          isBuyer,
          unreadCount: isBuyer ? conv.buyerUnreadCount : conv.sellerUnreadCount,
          product: product
            ? {
                _id: product._id,
                title: product.title,
                price: product.price,
                images: product.images,
                status: product.status,
              }
            : null,
          otherUser: otherUser
            ? {
                _id: otherUser._id,
                firstName: otherUser.firstName,
                lastName: otherUser.lastName,
                avatar: otherUser.avatar,
              }
            : null,
        };
      })
    );
  },
});

// Mark messages as read
export const markConversationRead = mutation({
  args: {
    conversationId: v.id("conversations"),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    await assertRequestUser(ctx, args.userId);
    const { role } = await requireConversationParticipant(ctx, args.conversationId, args.userId);
    const isBuyer = role === "buyer";

    // Mark all unread messages as read
    const unreadMessages = await ctx.db
      .query("conversationMessages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .filter((q) => q.and(q.eq(q.field("isRead"), false), q.neq(q.field("senderId"), args.userId)))
      .collect();

    const now = Date.now();
    for (const msg of unreadMessages) {
      await ctx.db.patch(msg._id, {
        isRead: true,
        readAt: now,
      });
    }

    // Reset unread count
    const unreadField = isBuyer ? "buyerUnreadCount" : "sellerUnreadCount";
    await ctx.db.patch(args.conversationId, {
      [unreadField]: 0,
      updatedAt: now,
    });

    return { markedRead: unreadMessages.length };
  },
});

// Archive conversation
export const archiveConversation = mutation({
  args: {
    conversationId: v.id("conversations"),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    await assertRequestUser(ctx, args.userId);
    const { conversation } = await requireConversationParticipant(ctx, args.conversationId, args.userId);

    if (conversation.status === "blocked") {
      throw new Error("This conversation has been blocked");
    }

    await ctx.db.patch(args.conversationId, {
      status: "archived",
      updatedAt: Date.now(),
    });

    return { success: true };
  },
});

// Block a buyer/seller conversation
export const blockConversation = mutation({
  args: {
    conversationId: v.id("conversations"),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    await assertRequestUser(ctx, args.userId);
    const { conversation } = await requireConversationParticipant(ctx, args.conversationId, args.userId);

    if (conversation.status === "blocked") {
      return { success: true };
    }

    await ctx.db.patch(args.conversationId, {
      status: "blocked",
      buyerUnreadCount: 0,
      sellerUnreadCount: 0,
      updatedAt: Date.now(),
    });

    return { success: true };
  },
});

// Report a buyer/seller conversation to moderators using the existing notifications table
export const reportConversation = mutation({
  args: {
    conversationId: v.id("conversations"),
    reporterId: v.id("users"),
    reason: v.optional(reportReasonValidator),
  },
  handler: async (ctx, args) => {
    const { conversation, role } = await requireConversationParticipant(ctx, args.conversationId, args.reporterId);
    const reportedUserId = role === "buyer" ? conversation.sellerId : conversation.buyerId;
    const reason = args.reason ?? "other";
    const now = Date.now();

    const moderators = await ctx.db
      .query("users")
      .withIndex("by_role", (q) => q.eq("role", "moderator"))
      .collect();
    const admins = await ctx.db
      .query("users")
      .withIndex("by_role", (q) => q.eq("role", "admin"))
      .collect();
    const reviewers = [...moderators, ...admins];

    for (const reviewer of reviewers) {
      await ctx.db.insert("notifications", {
        userId: reviewer._id,
        type: "system",
        title: "Conversation reported",
        message: "A buyer/seller conversation was reported for moderation.",
        data: {
          conversationId: args.conversationId,
          productId: conversation.productId,
          reporterId: args.reporterId,
          reportedUserId,
          reason,
        },
        isRead: false,
        createdAt: now,
      });
    }

    return { success: true, notifiedReviewers: reviewers.length };
  },
});

// Get conversation count (for badge)
export const getUnreadConversationCount = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    await assertRequestUser(ctx, args.userId);

    // Count unread as buyer
    const buyerConversations = await ctx.db
      .query("conversations")
      .withIndex("by_buyer", (q) => q.eq("buyerId", args.userId))
      .filter((q) => q.and(q.gt(q.field("buyerUnreadCount"), 0), q.neq(q.field("status"), "blocked")))
      .collect();

    // Count unread as seller
    const sellerConversations = await ctx.db
      .query("conversations")
      .withIndex("by_seller", (q) => q.eq("sellerId", args.userId))
      .filter((q) => q.and(q.gt(q.field("sellerUnreadCount"), 0), q.neq(q.field("status"), "blocked")))
      .collect();

    return buyerConversations.length + sellerConversations.length;
  },
});

// Get conversation history for a product (for AI context in disputes)
export const getProductConversationHistory = query({
  args: {
    productId: v.id("products"),
    buyerId: v.id("users"),
  },
  handler: async (ctx, args) => {
    await assertRequestUser(ctx, args.buyerId);

    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_buyer_product", (q) => q.eq("buyerId", args.buyerId).eq("productId", args.productId))
      .first();

    if (!conversation) {
      return null;
    }
    if (!getParticipantRole(conversation, args.buyerId)) {
      throw new Error("Unauthorized");
    }

    const messages = await ctx.db
      .query("conversationMessages")
      .withIndex("by_conversation_created", (q) => q.eq("conversationId", conversation._id))
      .order("asc")
      .collect();

    const buyer = await ctx.db.get(conversation.buyerId);
    const seller = await ctx.db.get(conversation.sellerId);

    return {
      conversationId: conversation._id,
      participants: {
        buyer: buyer ? `${buyer.firstName} ${buyer.lastName}` : "Unknown",
        seller: seller ? `${seller.firstName} ${seller.lastName}` : "Unknown",
      },
      messages: messages.map((msg) => ({
        sender: msg.senderId === conversation.buyerId ? "buyer" : "seller",
        content: msg.content,
        timestamp: msg.createdAt,
      })),
      messageCount: messages.length,
    };
  },
});

// Check if conversation exists for product/buyer combo
export const getExistingConversation = query({
  args: {
    productId: v.id("products"),
    buyerId: v.id("users"),
    viewerId: v.id("users"),
  },
  handler: async (ctx, args) => {
    await assertRequestUser(ctx, args.viewerId);
    if (args.viewerId !== args.buyerId) {
      throw new Error("Unauthorized");
    }

    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_buyer_product", (q) => q.eq("buyerId", args.buyerId).eq("productId", args.productId))
      .first();

    if (conversation && !getParticipantRole(conversation, args.viewerId)) {
      throw new Error("Unauthorized");
    }

    return conversation;
  },
});
