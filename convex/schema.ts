import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  aiModerationStatusValidator,
  productStatusValidator,
  userRoleValidator,
  vendorStatusValidator,
} from "./lib/platform";

export default defineSchema({
  // Users table
  users: defineTable({
    clerkId: v.string(),
    email: v.string(),
    firstName: v.string(),
    lastName: v.string(),
    phone: v.optional(v.string()),
    avatar: v.optional(v.string()),
    role: userRoleValidator,
    interests: v.optional(v.array(v.id("categories"))),
    address: v.optional(
      v.object({
        street: v.string(),
        city: v.string(),
        province: v.string(),
        country: v.string(),
      })
    ),
    // User preferences (synced across devices)
    preferences: v.optional(
      v.object({
        themeMode: v.union(v.literal("light"), v.literal("dark"), v.literal("system")),
        notificationsEnabled: v.boolean(),
        language: v.optional(v.string()),
      })
    ),
    rating: v.optional(v.number()),
    totalSales: v.number(),
    totalPurchases: v.number(),
    isVerified: v.boolean(),
    isBanned: v.boolean(),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_clerk_id", ["clerkId"])
    .index("by_email", ["email"])
    .index("by_role", ["role"]),

  // Categories table (supports PRD L1/L2/L3 taxonomy via parentId)
  categories: defineTable({
    name: v.string(),
    slug: v.string(),
    description: v.optional(v.string()),
    image: v.optional(v.string()),
    parentId: v.optional(v.id("categories")),
    level: v.optional(v.union(v.literal("l1"), v.literal("l2"), v.literal("l3"))),
    requiresApproval: v.optional(v.boolean()),
    approvedByUserId: v.optional(v.id("users")),
    approvedAt: v.optional(v.number()),
    isActive: v.boolean(),
    sortOrder: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_parent", ["parentId"])
    .index("by_active", ["isActive"]),

  // Products table
  products: defineTable({
    sellerId: v.id("users"),
    managedByUserId: v.optional(v.id("users")),
    title: v.string(),
    brand: v.optional(v.string()),
    sku: v.optional(v.string()),
    shortDescription: v.optional(v.string()),
    description: v.string(),
    keyFeatures: v.optional(v.array(v.string())),
    price: v.number(), // in ZMW
    compareAtPrice: v.optional(v.number()),
    categoryId: v.id("categories"),
    subcategoryId: v.optional(v.id("categories")),
    classificationId: v.optional(v.id("categories")),
    images: v.array(v.string()),
    imageMetadata: v.optional(
      v.array(
        v.object({
          url: v.string(),
          width: v.optional(v.number()),
          height: v.optional(v.number()),
          sizeBytes: v.optional(v.number()),
          mimeType: v.optional(v.string()),
          isPrimary: v.boolean(),
          hasWhiteBackground: v.optional(v.boolean()),
        })
      )
    ),
    condition: v.union(
      v.literal("new"),
      v.literal("like_new"),
      v.literal("good"),
      v.literal("fair")
    ),
    quantity: v.number(),
    lowStockThreshold: v.optional(v.number()),
    availabilityStatus: v.optional(
      v.union(
        v.literal("in_stock"),
        v.literal("low_stock"),
        v.literal("out_of_stock"),
        v.literal("preorder")
      )
    ),
    preorder: v.optional(
      v.object({
        isPreorder: v.boolean(),
        expectedShipDate: v.optional(v.number()),
        depositPercent: v.optional(v.number()),
      })
    ),
    variants: v.optional(
      v.array(
        v.object({
          name: v.string(),
          options: v.array(
            v.object({
              name: v.string(),
              value: v.string(),
              sku: v.optional(v.string()),
              priceDelta: v.optional(v.number()),
              quantity: v.optional(v.number()),
              imageUrl: v.optional(v.string()),
            })
          ),
        })
      )
    ),
    variantAttributes: v.optional(
      v.array(
        v.object({
          name: v.string(),
          values: v.array(v.string()),
        })
      )
    ),
    variantCombinations: v.optional(
      v.array(
        v.object({
          id: v.string(),
          sku: v.string(),
          attributes: v.array(
            v.object({
              name: v.string(),
              value: v.string(),
            })
          ),
          price: v.number(),
          stock: v.number(),
          status: v.union(
            v.literal("active"),
            v.literal("inactive"),
            v.literal("out_of_stock")
          ),
          primaryImage: v.optional(v.string()),
          galleryImages: v.optional(v.array(v.string())),
        })
      )
    ),
    addOns: v.optional(
      v.array(
        v.object({
          name: v.string(),
          description: v.optional(v.string()),
          price: v.number(),
          isRequired: v.boolean(),
        })
      )
    ),
    bulkPricing: v.optional(
      v.array(
        v.object({
          minQuantity: v.number(),
          unitPrice: v.number(),
        })
      )
    ),
    dimensions: v.optional(
      v.object({
        lengthCm: v.number(),
        widthCm: v.number(),
        heightCm: v.number(),
      })
    ),
    weightKg: v.optional(v.number()),
    packageDimensions: v.optional(
      v.object({
        lengthCm: v.number(),
        widthCm: v.number(),
        heightCm: v.number(),
      })
    ),
    packageWeightKg: v.optional(v.number()),
    warranty: v.optional(
      v.object({
        type: v.union(
          v.literal("manufacturer"),
          v.literal("seller"),
          v.literal("none")
        ),
        durationDays: v.optional(v.number()),
        provider: v.optional(v.string()),
        terms: v.optional(v.string()),
      })
    ),
    countryOfOrigin: v.optional(v.string()),
    modelNumber: v.optional(v.string()),
    manufacturerPartNumber: v.optional(v.string()),
    material: v.optional(v.string()),
    color: v.optional(v.string()),
    specifications: v.optional(
      v.array(
        v.object({
          key: v.string(),
          value: v.string(),
        })
      )
    ),
    tags: v.optional(v.array(v.string())),
    location: v.optional(
      v.object({
        city: v.string(),
        province: v.string(),
      })
    ),
    shippingOptions: v.array(
      v.object({
        name: v.string(),
        price: v.number(),
        estimatedDays: v.string(),
      })
    ),
    status: productStatusValidator,
    submittedAt: v.optional(v.number()),
    reviewedAt: v.optional(v.number()),
    reviewedByUserId: v.optional(v.id("users")),
    reviewNotes: v.optional(v.string()),
    aiModerationStatus: v.optional(aiModerationStatusValidator),
    aiModerationSummary: v.optional(v.string()),
    aiModerationFlags: v.optional(v.array(v.string())),
    views: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_seller", ["sellerId"])
    .index("by_manager", ["managedByUserId"])
    .index("by_category", ["categoryId"])
    .index("by_subcategory", ["subcategoryId"])
    .index("by_classification", ["classificationId"])
    .index("by_status", ["status"])
    .index("by_created", ["createdAt"])
    .index("by_status_created", ["status", "createdAt"])
    .searchIndex("search_products", {
      searchField: "title",
      filterFields: ["categoryId", "subcategoryId", "classificationId", "status", "condition"],
    }),

  // Singleton platform settings
  platformSettings: defineTable({
    key: v.literal("singleton"),
    companySellerUserId: v.id("users"),
    companyDisplayName: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  vendorProfiles: defineTable({
    ownerUserId: v.id("users"),
    storeName: v.string(),
    slug: v.string(),
    description: v.string(),
    logoUrl: v.optional(v.string()),
    bannerUrl: v.optional(v.string()),
    contactEmail: v.string(),
    contactPhone: v.optional(v.string()),
    address: v.object({
      street: v.string(),
      city: v.string(),
      province: v.string(),
      country: v.string(),
    }),
    socialLinks: v.optional(
      v.object({
        website: v.optional(v.string()),
        instagram: v.optional(v.string()),
        facebook: v.optional(v.string()),
      })
    ),
    status: vendorStatusValidator,
    reviewNotes: v.optional(v.string()),
    reviewedByUserId: v.optional(v.id("users")),
    reviewedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner", ["ownerUserId"])
    .index("by_slug", ["slug"])
    .index("by_status", ["status"]),

  // Cart items table
  cartItems: defineTable({
    userId: v.id("users"),
    productId: v.id("products"),
    quantity: v.number(),
    selectedShipping: v.object({
      name: v.string(),
      price: v.number(),
    }),
    selectedVariantOptions: v.optional(
      v.array(
        v.object({
          name: v.string(),
          value: v.string(),
          sku: v.optional(v.string()),
          priceDelta: v.optional(v.number()),
        })
      )
    ),
    selectedVariant: v.optional(
      v.object({
        variantId: v.string(),
        sku: v.string(),
        attributes: v.array(
          v.object({
            name: v.string(),
            value: v.string(),
          })
        ),
        price: v.number(),
        image: v.optional(v.string()),
      })
    ),
    selectedAddOns: v.optional(
      v.array(
        v.object({
          name: v.string(),
          description: v.optional(v.string()),
          price: v.number(),
        })
      )
    ),
    customizationKey: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_product", ["userId", "productId"]),

  // Orders table
  orders: defineTable({
    orderNumber: v.string(),
    buyerId: v.id("users"),
    sellerId: v.id("users"),
    items: v.array(
      v.object({
        productId: v.id("products"),
        title: v.string(),
        price: v.number(), // Original seller price
        quantity: v.number(),
        image: v.string(),
        selectedVariantOptions: v.optional(
          v.array(
            v.object({
              name: v.string(),
              value: v.string(),
              sku: v.optional(v.string()),
              priceDelta: v.optional(v.number()),
            })
          )
        ),
        selectedVariant: v.optional(
          v.object({
            variantId: v.string(),
            sku: v.string(),
            attributes: v.array(
              v.object({
                name: v.string(),
                value: v.string(),
              })
            ),
            price: v.number(),
            image: v.optional(v.string()),
          })
        ),
        selectedAddOns: v.optional(
          v.array(
            v.object({
              name: v.string(),
              description: v.optional(v.string()),
              price: v.number(),
            })
          )
        ),
        customizationKey: v.optional(v.string()),
      })
    ),
    // Financial breakdown
    subtotal: v.number(), // Sum of (price * quantity) for all items
    discountAmount: v.optional(v.number()),
    promoCodeId: v.optional(v.id("promoCodes")),
    promoCode: v.optional(v.string()),
    shippingCost: v.number(),
    platformFee: v.number(), // 5% of subtotal for transaction fees
    totalAmount: v.number(), // subtotal + shippingCost + platformFee (buyer pays this)
    sellerPayout: v.number(), // subtotal + shippingCost (seller receives this)
    deliveryMethodId: v.optional(v.id("deliveryMethods")),
    deliveryMethodName: v.optional(v.string()),
    deliveryEta: v.optional(
      v.object({
        minDays: v.number(),
        maxDays: v.number(),
      })
    ),
    pickupPointId: v.optional(v.id("pickupPoints")),

    shippingAddress: v.object({
      street: v.string(),
      city: v.string(),
      province: v.string(),
      country: v.string(),
      phone: v.string(),
    }),
    status: v.union(
      v.literal("pending_payment"),
      v.literal("paid"),
      v.literal("processing"),
      v.literal("shipped"),
      v.literal("delivered"),
      v.literal("completed"),
      v.literal("cancelled"),
      v.literal("disputed")
    ),
    trackingNumber: v.optional(v.string()),
    shippingCarrier: v.optional(v.string()),
    notes: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_buyer", ["buyerId"])
    .index("by_seller", ["sellerId"])
    .index("by_order_number", ["orderNumber"])
    .index("by_status", ["status"])
    .index("by_buyer_status", ["buyerId", "status"])
    .index("by_seller_status", ["sellerId", "status"]),

  // Escrow table - holds funds securely until order completion
  escrow: defineTable({
    orderId: v.id("orders"),
    buyerId: v.id("users"),
    sellerId: v.id("users"),

    // Fund breakdown (prevents any shortfall)
    grossAmount: v.number(), // Total received from buyer (totalAmount)
    platformFee: v.number(), // 5% fee retained by platform
    sellerAmount: v.number(), // Amount to be paid to seller (subtotal + shipping)

    // Legacy field for backwards compatibility
    amount: v.number(), // Same as grossAmount

    status: v.union(
      v.literal("held"), // Funds received, awaiting delivery
      v.literal("released"), // Funds released to seller
      v.literal("refunded"), // Full refund to buyer
      v.literal("partially_refunded"), // Partial refund
      v.literal("disputed") // Under dispute review
    ),
    refundAmount: v.optional(v.number()),

    // Payout tracking
    sellerPayoutTransactionId: v.optional(v.id("transactions")),
    releasedAt: v.optional(v.number()),

    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_order", ["orderId"])
    .index("by_buyer", ["buyerId"])
    .index("by_seller", ["sellerId"])
    .index("by_status", ["status"]),

  // Disputes table
  disputes: defineTable({
    orderId: v.id("orders"),
    escrowId: v.id("escrow"),
    buyerId: v.id("users"),
    sellerId: v.id("users"),
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
    status: v.union(
      v.literal("open"),
      v.literal("in_discussion"),
      v.literal("moderator_review"),
      v.literal("resolved"),
      v.literal("closed")
    ),
    resolution: v.optional(
      v.object({
        type: v.union(
          v.literal("full_refund"),
          v.literal("partial_refund"),
          v.literal("no_refund"),
          v.literal("mutual_agreement")
        ),
        refundAmount: v.optional(v.number()),
        resolvedBy: v.optional(v.id("users")),
        notes: v.string(),
        resolvedAt: v.number(),
      })
    ),
    aiSummary: v.optional(v.string()),
    aiSuggestions: v.optional(v.array(v.string())),
    moderatorId: v.optional(v.id("users")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_order", ["orderId"])
    .index("by_buyer", ["buyerId"])
    .index("by_seller", ["sellerId"])
    .index("by_status", ["status"])
    .index("by_moderator", ["moderatorId"]),

  // Messages table (for dispute conversations)
  messages: defineTable({
    disputeId: v.id("disputes"),
    senderId: v.id("users"),
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
    isSystemMessage: v.boolean(),
    aiRephraseAccepted: v.optional(v.boolean()),
    createdAt: v.number(),
  })
    .index("by_dispute", ["disputeId"])
    .index("by_sender", ["senderId"])
    .index("by_dispute_created", ["disputeId", "createdAt"]),

  // Favorites/Wishlist table
  favorites: defineTable({
    userId: v.id("users"),
    productId: v.id("products"),
    createdAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_product", ["productId"])
    .index("by_user_product", ["userId", "productId"]),

  // Reviews table
  reviews: defineTable({
    orderId: v.id("orders"),
    reviewerId: v.id("users"),
    revieweeId: v.id("users"),
    productId: v.id("products"),
    rating: v.number(), // 1-5
    title: v.optional(v.string()),
    comment: v.optional(v.string()),
    photoUrls: v.optional(v.array(v.string())),
    createdAt: v.number(),
  })
    .index("by_reviewee", ["revieweeId"])
    .index("by_product", ["productId"])
    .index("by_reviewer", ["reviewerId"])
    .index("by_order", ["orderId"]),

  // Notifications table
  notifications: defineTable({
    userId: v.id("users"),
    type: v.union(
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
    ),
    title: v.string(),
    message: v.string(),
    data: v.optional(v.any()), // JSON data for navigation
    isRead: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_read", ["userId", "isRead"])
    .index("by_user_created", ["userId", "createdAt"]),

  behaviorEvents: defineTable({
    userId: v.optional(v.id("users")),
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
    createdAt: v.number(),
  })
    .index("by_user_created", ["userId", "createdAt"])
    .index("by_product_created", ["productId", "createdAt"])
    .index("by_category_created", ["categoryId", "createdAt"])
    .index("by_event_created", ["eventType", "createdAt"]),

  notificationDevices: defineTable({
    userId: v.id("users"),
    channel: v.union(v.literal("mobile_push"), v.literal("web_push")),
    token: v.optional(v.string()),
    subscription: v.optional(v.any()),
    platform: v.optional(v.string()),
    isOptedIn: v.boolean(),
    lastSeenAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_channel", ["userId", "channel"])
    .index("by_token", ["token"]),

  notificationCampaigns: defineTable({
    name: v.string(),
    type: v.union(
      v.literal("cart_reminder"),
      v.literal("low_stock"),
      v.literal("price_drop"),
      v.literal("product_recommendation")
    ),
    status: v.union(v.literal("draft"), v.literal("active"), v.literal("paused")),
    audienceSegment: v.union(
      v.literal("all_opted_in"),
      v.literal("cart_abandoners"),
      v.literal("product_viewers"),
      v.literal("category_browsers"),
      v.literal("past_buyers")
    ),
    productId: v.optional(v.id("products")),
    categoryId: v.optional(v.id("categories")),
    title: v.string(),
    message: v.string(),
    aiSuggestion: v.optional(v.string()),
    channels: v.array(
      v.union(v.literal("in_app"), v.literal("mobile_push"), v.literal("web_push"))
    ),
    maxPerUserPerDay: v.number(),
    isAutomatic: v.boolean(),
    createdByUserId: v.id("users"),
    lastSentAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_status", ["status"])
    .index("by_type", ["type"])
    .index("by_created_by", ["createdByUserId"]),

  notificationDeliveryLogs: defineTable({
    campaignId: v.optional(v.id("notificationCampaigns")),
    userId: v.id("users"),
    notificationId: v.optional(v.id("notifications")),
    channel: v.union(v.literal("in_app"), v.literal("mobile_push"), v.literal("web_push")),
    status: v.union(v.literal("queued"), v.literal("sent"), v.literal("skipped"), v.literal("failed")),
    reason: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_campaign", ["campaignId"])
    .index("by_user_created", ["userId", "createdAt"]),

  // Wallets table - one wallet per user
  wallets: defineTable({
    userId: v.id("users"),

    // Balance tracking (all in ZMW)
    balance: v.number(), // Current available balance
    pendingBalance: v.number(), // Funds in escrow not yet released
    totalEarned: v.number(), // Lifetime earnings
    totalWithdrawn: v.number(), // Lifetime withdrawals
    totalSpent: v.number(), // Lifetime spent on purchases

    // Status
    isActive: v.boolean(),
    isFrozen: v.boolean(), // Frozen due to suspicious activity
    freezeReason: v.optional(v.string()),

    // Timestamps
    lastTransactionAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"]),

  // Wallet transactions table
  walletTransactions: defineTable({
    walletId: v.id("wallets"),
    userId: v.id("users"),

    // Transaction type
    type: v.union(
      v.literal("credit"), // Money coming in (from sales, top-up)
      v.literal("debit"), // Money going out (purchases, withdrawals)
      v.literal("hold"), // Funds held pending escrow release
      v.literal("release"), // Funds released from escrow
      v.literal("refund") // Refund back to wallet
    ),

    // Source/destination of funds
    source: v.union(
      v.literal("sale"), // From completed sale
      v.literal("top_up_mobile_money"), // Manual top-up via mobile money
      v.literal("top_up_card"), // Manual top-up via card
      v.literal("top_up_bank"), // Manual top-up via bank transfer
      v.literal("refund"), // Refund from cancelled order
      v.literal("withdrawal_reversal"), // Failed withdrawal reversed
      v.literal("admin_adjustment"), // Manual adjustment by admin
      v.literal("purchase"), // Payment for purchase
      v.literal("withdrawal_mobile_money"), // Withdrawal to mobile money
      v.literal("withdrawal_bank"), // Withdrawal to bank account
      v.literal("escrow_hold"), // Held in escrow
      v.literal("escrow_release") // Released from escrow
    ),

    // Amount (positive for credits, positive for debits - type determines direction)
    amount: v.number(),

    // Balance after transaction
    balanceAfter: v.number(),

    // Related entities
    orderId: v.optional(v.id("orders")),
    escrowId: v.optional(v.id("escrow")),
    paymentAccountId: v.optional(v.id("paymentAccounts")),

    // External references
    reference: v.string(), // Internal transaction reference
    externalReference: v.optional(v.string()), // Lenco transaction ID

    // Status
    status: v.union(
      v.literal("pending"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("cancelled")
    ),
    failureReason: v.optional(v.string()),

    // Description
    description: v.string(),

    // Metadata
    metadata: v.optional(v.any()),

    // Timestamps
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_wallet", ["walletId"])
    .index("by_user", ["userId"])
    .index("by_reference", ["reference"])
    .index("by_order", ["orderId"])
    .index("by_type", ["type"])
    .index("by_status", ["status"])
    .index("by_created", ["createdAt"])
    .index("by_user_created", ["userId", "createdAt"]),

  // Transactions table (Lenco payment gateway records)
  transactions: defineTable({
    // Reference IDs
    orderId: v.optional(v.id("orders")), // Optional for top-ups (no order)
    userId: v.id("users"), // The user who initiated the payment
    escrowId: v.optional(v.id("escrow")),

    // Transaction identifiers
    reference: v.string(), // Our internal reference
    lencoTransactionId: v.optional(v.string()), // Lenco's transaction ID
    lencoCollectionId: v.optional(v.string()), // Lenco collection ID

    // Payment details
    type: v.union(
      v.literal("collection"), // Incoming payment
      v.literal("transfer"), // Outgoing payment (seller payout)
      v.literal("refund") // Refund to buyer
    ),
    paymentMethod: v.union(
      v.literal("mobile_money"),
      v.literal("card"),
      v.literal("bank_transfer")
    ),

    // Mobile money specific
    mobileMoneyProvider: v.optional(
      v.union(
        v.literal("mtn"),
        v.literal("airtel"),
        v.literal("zamtel")
      )
    ),
    mobileNumber: v.optional(v.string()),

    // Card specific (masked for security)
    cardLast4: v.optional(v.string()),
    cardBrand: v.optional(v.string()), // visa, mastercard, etc.

    // Amounts (all in ZMW)
    amount: v.number(), // Gross amount transacted
    platformFee: v.optional(v.number()), // 5% platform fee (for collections)
    gatewayFee: v.optional(v.number()), // Lenco/bank processing fee
    netAmount: v.optional(v.number()), // Amount after all fees
    sellerPayout: v.optional(v.number()), // Amount to be paid to seller (for collections)

    // Legacy field
    fee: v.optional(v.number()), // Same as gatewayFee for backwards compatibility

    // Currency
    currency: v.string(), // ZMW

    // Status tracking
    status: v.union(
      v.literal("pending"),
      v.literal("processing"),
      v.literal("successful"),
      v.literal("failed"),
      v.literal("cancelled"),
      v.literal("refunded")
    ),
    failureReason: v.optional(v.string()),

    // Metadata
    description: v.optional(v.string()),
    metadata: v.optional(v.any()), // Additional data from Lenco

    // Timestamps
    initiatedAt: v.number(),
    completedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_order", ["orderId"])
    .index("by_user", ["userId"])
    .index("by_reference", ["reference"])
    .index("by_lenco_id", ["lencoTransactionId"])
    .index("by_lenco_collection", ["lencoCollectionId"])
    .index("by_status", ["status"])
    .index("by_type", ["type"])
    .index("by_user_status", ["userId", "status"])
    .index("by_created", ["createdAt"]),

  // Payment accounts table (for seller payouts)
  paymentAccounts: defineTable({
    userId: v.id("users"),

    // Account type
    type: v.union(
      v.literal("mobile_money"),
      v.literal("bank_account")
    ),

    // Mobile money details
    mobileMoneyProvider: v.optional(
      v.union(
        v.literal("mtn"),
        v.literal("airtel"),
        v.literal("zamtel")
      )
    ),
    mobileNumber: v.optional(v.string()),

    // Bank account details
    bankCode: v.optional(v.string()),
    bankName: v.optional(v.string()),
    accountNumber: v.optional(v.string()),
    accountName: v.optional(v.string()),

    // Lenco recipient ID (for transfers)
    lencoRecipientId: v.optional(v.string()),

    // Status
    isDefault: v.boolean(),
    isVerified: v.boolean(),

    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_default", ["userId", "isDefault"])
    .index("by_lenco_recipient", ["lencoRecipientId"]),

  // Delivery zones for PRD zone-based delivery and pickup
  deliveryZones: defineTable({
    name: v.string(),
    slug: v.string(),
    province: v.optional(v.string()),
    city: v.optional(v.string()),
    postalCodePattern: v.optional(v.string()),
    isActive: v.boolean(),
    sortOrder: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_active", ["isActive"])
    .index("by_province_city", ["province", "city"]),

  deliveryMethods: defineTable({
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
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_code", ["code"])
    .index("by_active", ["isActive"])
    .index("by_zone", ["zoneId"]),

  pickupPoints: defineTable({
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
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_code", ["code"])
    .index("by_active", ["isActive"])
    .index("by_zone", ["zoneId"]),

  orderTrackingEvents: defineTable({
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
    location: v.optional(
      v.object({
        city: v.string(),
        province: v.string(),
      })
    ),
    carrier: v.optional(v.string()),
    trackingNumber: v.optional(v.string()),
    createdByUserId: v.optional(v.id("users")),
    occurredAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_order", ["orderId"])
    .index("by_status", ["status"])
    .index("by_order_occurred", ["orderId", "occurredAt"]),

  returnRequests: defineTable({
    orderId: v.id("orders"),
    buyerId: v.id("users"),
    sellerId: v.id("users"),
    status: v.union(
      v.literal("requested"),
      v.literal("approved"),
      v.literal("rejected"),
      v.literal("in_transit"),
      v.literal("received"),
      v.literal("refunded"),
      v.literal("closed")
    ),
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
        resolvedByUserId: v.optional(v.id("users")),
        resolvedAt: v.optional(v.number()),
      })
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_order", ["orderId"])
    .index("by_buyer", ["buyerId"])
    .index("by_seller", ["sellerId"])
    .index("by_status", ["status"]),

  promotionBanners: defineTable({
    title: v.string(),
    subtitle: v.optional(v.string()),
    imageUrl: v.string(),
    targetUrl: v.optional(v.string()),
    placement: v.union(
      v.literal("home_hero"),
      v.literal("home_monthly"),
      v.literal("home_strip"),
      v.literal("category"),
      v.literal("pdp")
    ),
    categoryId: v.optional(v.id("categories")),
    startsAt: v.number(),
    endsAt: v.optional(v.number()),
    isActive: v.boolean(),
    sortOrder: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_active", ["isActive"])
    .index("by_placement", ["placement"])
    .index("by_category", ["categoryId"]),

  promotions: defineTable({
    name: v.string(),
    type: v.union(
      v.literal("deal_of_day"),
      v.literal("flash_sale"),
      v.literal("weekend_sale"),
      v.literal("sponsored_product"),
      v.literal("seller_campaign")
    ),
    sellerId: v.optional(v.id("users")),
    categoryId: v.optional(v.id("categories")),
    productIds: v.array(v.id("products")),
    discountType: v.union(
      v.literal("percent"),
      v.literal("fixed_amount"),
      v.literal("compare_at")
    ),
    discountValue: v.optional(v.number()),
    startsAt: v.number(),
    endsAt: v.optional(v.number()),
    isActive: v.boolean(),
    priority: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_active", ["isActive"])
    .index("by_type", ["type"])
    .index("by_seller", ["sellerId"])
    .index("by_category", ["categoryId"]),

  promoCodes: defineTable({
    code: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    scope: v.union(
      v.literal("platform"),
      v.literal("seller"),
      v.literal("category"),
      v.literal("product")
    ),
    sellerId: v.optional(v.id("users")),
    categoryId: v.optional(v.id("categories")),
    productId: v.optional(v.id("products")),
    discountType: v.union(v.literal("percent"), v.literal("fixed_amount")),
    discountValue: v.number(),
    minimumSubtotal: v.optional(v.number()),
    maxDiscount: v.optional(v.number()),
    usageLimit: v.optional(v.number()),
    perUserLimit: v.optional(v.number()),
    startsAt: v.number(),
    endsAt: v.optional(v.number()),
    isActive: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_code", ["code"])
    .index("by_active", ["isActive"])
    .index("by_seller", ["sellerId"])
    .index("by_category", ["categoryId"])
    .index("by_product", ["productId"]),

  promoCodeRedemptions: defineTable({
    promoCodeId: v.id("promoCodes"),
    userId: v.id("users"),
    orderId: v.optional(v.id("orders")),
    discountAmount: v.number(),
    redeemedAt: v.number(),
  })
    .index("by_promo_code", ["promoCodeId"])
    .index("by_user", ["userId"])
    .index("by_order", ["orderId"]),

  loyaltyAccounts: defineTable({
    userId: v.id("users"),
    pointsBalance: v.number(),
    lifetimeEarned: v.number(),
    lifetimeRedeemed: v.number(),
    tier: v.union(
      v.literal("bronze"),
      v.literal("silver"),
      v.literal("gold"),
      v.literal("platinum")
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_tier", ["tier"]),

  loyaltyTransactions: defineTable({
    accountId: v.id("loyaltyAccounts"),
    userId: v.id("users"),
    type: v.union(
      v.literal("earn"),
      v.literal("redeem"),
      v.literal("expire"),
      v.literal("adjust")
    ),
    points: v.number(),
    orderId: v.optional(v.id("orders")),
    reason: v.string(),
    createdAt: v.number(),
  })
    .index("by_account", ["accountId"])
    .index("by_user", ["userId"])
    .index("by_order", ["orderId"])
    .index("by_created", ["createdAt"]),

  // Conversations table (pre-purchase messaging between buyer and seller)
  conversations: defineTable({
    productId: v.id("products"),
    buyerId: v.id("users"), // The user asking about the product
    sellerId: v.id("users"), // The product owner

    // Conversation status
    status: v.union(
      v.literal("active"),
      v.literal("archived"),
      v.literal("blocked")
    ),

    // Optional link to order if purchase was made
    orderId: v.optional(v.id("orders")),

    // Message counts for unread tracking
    buyerUnreadCount: v.number(),
    sellerUnreadCount: v.number(),

    // Last activity
    lastMessageAt: v.optional(v.number()),
    lastMessagePreview: v.optional(v.string()),

    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_product", ["productId"])
    .index("by_buyer", ["buyerId"])
    .index("by_seller", ["sellerId"])
    .index("by_buyer_product", ["buyerId", "productId"])
    .index("by_seller_product", ["sellerId", "productId"])
    .index("by_last_message", ["lastMessageAt"]),

  // Conversation messages table
  conversationMessages: defineTable({
    conversationId: v.id("conversations"),
    senderId: v.id("users"),
    content: v.string(),

    // Attachments (images)
    attachments: v.optional(
      v.array(
        v.object({
          type: v.union(v.literal("image"), v.literal("video")),
          url: v.string(),
        })
      )
    ),

    // Read status
    isRead: v.boolean(),
    readAt: v.optional(v.number()),

    // System message flag
    isSystemMessage: v.boolean(),

    createdAt: v.number(),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_conversation_created", ["conversationId", "createdAt"])
    .index("by_sender", ["senderId"]),
});
