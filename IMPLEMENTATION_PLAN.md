# Gettitonline - MVP Implementation Plan

## Project Overview

A mobile-first marketplace application where users can list and purchase items (products, accessories, tech products, etc.) with an escrow-based payment system and AI-powered features.

**Currency:** ZMW (Zambian Kwacha)
**Target Market:** Zambia (initial launch)

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Mobile App | Expo + React Native |
| UI Components | React Native Paper |
| Database | Convex (realtime) |
| Authentication | Clerk |
| Backend API | NestJS |
| AI Integration | OpenAI API (via NestJS) |

---

## User Roles & Permissions

| Role | Permissions |
|------|-------------|
| **User** | List items, browse, purchase, manage cart, open disputes, participate in dispute conversations |
| **Moderator** | All user permissions + resolve disputes, view all disputes, issue refunds |
| **Admin** | All permissions + manage users, manage categories, platform settings, view analytics |

---

## Phase 1: Project Setup & Infrastructure

### 1.1 Expo/React Native Setup
- [ ] Initialize Expo project with TypeScript template
- [ ] Configure app.json with app name, slug, and bundle identifiers
- [ ] Set up folder structure:
  ```
  /src
    /components
    /screens
    /navigation
    /hooks
    /utils
    /constants
    /types
    /services
    /stores
  ```
- [ ] Install and configure React Native Paper
- [ ] Set up custom theme (colors, typography, spacing)
- [ ] Configure React Navigation (stack, tab, drawer navigators)
- [ ] Set up environment variables (.env) for different environments

### 1.2 Convex Setup
- [ ] Create Convex project
- [ ] Install Convex React Native client
- [ ] Configure Convex provider in app entry point
- [ ] Set up Convex schema file structure:
  ```
  /convex
    /schema.ts
    /users.ts
    /products.ts
    /categories.ts
    /orders.ts
    /cart.ts
    /disputes.ts
    /messages.ts
    /escrow.ts
  ```
- [ ] Configure Convex authentication with Clerk

### 1.3 Clerk Authentication Setup
- [ ] Create Clerk application
- [ ] Install Clerk Expo SDK
- [ ] Configure Clerk provider
- [ ] Set up Clerk + Convex integration
- [ ] Configure OAuth providers (Google, Apple - optional for MVP)
- [ ] Set up email/password authentication

### 1.4 NestJS API Setup
- [ ] Initialize NestJS project with TypeScript
- [ ] Set up folder structure:
  ```
  /src
    /modules
      /ai
      /webhooks
      /health
    /common
      /guards
      /interceptors
      /filters
      /decorators
    /config
  ```
- [ ] Configure environment variables
- [ ] Set up OpenAI SDK integration
- [ ] Configure CORS for mobile app
- [ ] Set up health check endpoints
- [ ] Configure logging (Winston/Pino)
- [ ] Set up API versioning

---

## Phase 2: Database Schema (Convex)

### 2.1 Users Schema
- [ ] Define users table:
  ```typescript
  users: defineTable({
    clerkId: v.string(),
    email: v.string(),
    firstName: v.string(),
    lastName: v.string(),
    phone: v.optional(v.string()),
    avatar: v.optional(v.string()),
    role: v.union(v.literal("user"), v.literal("moderator"), v.literal("admin")),
    interests: v.optional(v.array(v.id("categories"))),
    address: v.optional(v.object({
      street: v.string(),
      city: v.string(),
      province: v.string(),
      country: v.string(),
    })),
    rating: v.optional(v.number()),
    totalSales: v.number(),
    totalPurchases: v.number(),
    isVerified: v.boolean(),
    isBanned: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
  ```
- [ ] Create user indexes (by clerkId, email, role)
- [ ] Implement user CRUD functions
- [ ] Implement user interests management functions

### 2.2 Categories Schema
- [ ] Define categories table:
  ```typescript
  categories: defineTable({
    name: v.string(),
    slug: v.string(),
    description: v.optional(v.string()),
    image: v.optional(v.string()),
    parentId: v.optional(v.id("categories")),
    isActive: v.boolean(),
    sortOrder: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
  ```
- [ ] Create category indexes (by slug, parentId)
- [ ] Implement category CRUD functions
- [ ] Implement subcategory retrieval functions
- [ ] Seed initial categories:
  - Auto Parts (Suspension, Engine, Brakes, Electrical, Body Parts, Oils & Lubricants)
  - Accessories (Interior, Exterior, Electronics)
  - Tech Products (Phones, Laptops, Tablets, Accessories)
  - General (Other items)

### 2.3 Products Schema
- [ ] Define products table:
  ```typescript
  products: defineTable({
    sellerId: v.id("users"),
    title: v.string(),
    description: v.string(),
    price: v.number(), // in ZMW
    compareAtPrice: v.optional(v.number()),
    categoryId: v.id("categories"),
    subcategoryId: v.optional(v.id("categories")),
    images: v.array(v.string()),
    condition: v.union(
      v.literal("new"),
      v.literal("like_new"),
      v.literal("good"),
      v.literal("fair")
    ),
    quantity: v.number(),
    specifications: v.optional(v.array(v.object({
      key: v.string(),
      value: v.string(),
    }))),
    tags: v.optional(v.array(v.string())),
    location: v.optional(v.object({
      city: v.string(),
      province: v.string(),
    })),
    shippingOptions: v.array(v.object({
      name: v.string(),
      price: v.number(),
      estimatedDays: v.string(),
    })),
    status: v.union(
      v.literal("draft"),
      v.literal("active"),
      v.literal("sold"),
      v.literal("suspended")
    ),
    views: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
  ```
- [ ] Create product indexes (by sellerId, categoryId, status, createdAt)
- [ ] Implement product CRUD functions
- [ ] Implement product search function
- [ ] Implement product filtering function
- [ ] Implement product view tracking

### 2.4 Cart Schema
- [ ] Define cart table:
  ```typescript
  cartItems: defineTable({
    userId: v.id("users"),
    productId: v.id("products"),
    quantity: v.number(),
    selectedShipping: v.object({
      name: v.string(),
      price: v.number(),
    }),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
  ```
- [ ] Create cart indexes (by userId)
- [ ] Implement add to cart function
- [ ] Implement update cart quantity function
- [ ] Implement remove from cart function
- [ ] Implement get cart with product details function
- [ ] Implement clear cart function

### 2.5 Orders Schema
- [ ] Define orders table:
  ```typescript
  orders: defineTable({
    orderNumber: v.string(),
    buyerId: v.id("users"),
    sellerId: v.id("users"),
    items: v.array(v.object({
      productId: v.id("products"),
      title: v.string(),
      price: v.number(),
      quantity: v.number(),
      image: v.string(),
    })),
    subtotal: v.number(),
    shippingCost: v.number(),
    totalAmount: v.number(),
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
  ```
- [ ] Create order indexes (by buyerId, sellerId, orderNumber, status)
- [ ] Implement create order function
- [ ] Implement update order status function
- [ ] Implement get orders by user function
- [ ] Implement order number generation

### 2.6 Escrow Schema
- [ ] Define escrow table:
  ```typescript
  escrow: defineTable({
    orderId: v.id("orders"),
    buyerId: v.id("users"),
    sellerId: v.id("users"),
    amount: v.number(),
    status: v.union(
      v.literal("held"),
      v.literal("released"),
      v.literal("refunded"),
      v.literal("partially_refunded"),
      v.literal("disputed")
    ),
    refundAmount: v.optional(v.number()),
    releasedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
  ```
- [ ] Create escrow indexes (by orderId, buyerId, sellerId, status)
- [ ] Implement create escrow hold function
- [ ] Implement release funds function
- [ ] Implement refund function (full/partial)

### 2.7 Disputes Schema
- [ ] Define disputes table:
  ```typescript
  disputes: defineTable({
    orderId: v.id("orders"),
    escrowId: v.id("escrow"),
    buyerId: v.id("users"),
    sellerId: v.id("users"),
    title: v.string(),
    description: v.string(),
    evidence: v.array(v.object({
      type: v.union(v.literal("image"), v.literal("video")),
      url: v.string(),
      uploadedAt: v.number(),
    })),
    status: v.union(
      v.literal("open"),
      v.literal("in_discussion"),
      v.literal("moderator_review"),
      v.literal("resolved"),
      v.literal("closed")
    ),
    resolution: v.optional(v.object({
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
    })),
    aiSummary: v.optional(v.string()),
    aiSuggestions: v.optional(v.array(v.string())),
    moderatorId: v.optional(v.id("users")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
  ```
- [ ] Create dispute indexes (by orderId, buyerId, sellerId, status, moderatorId)
- [ ] Implement create dispute function
- [ ] Implement update dispute status function
- [ ] Implement assign moderator function
- [ ] Implement resolve dispute function

### 2.8 Messages Schema (Dispute Conversations)
- [ ] Define messages table:
  ```typescript
  messages: defineTable({
    disputeId: v.id("disputes"),
    senderId: v.id("users"),
    content: v.string(),
    originalContent: v.optional(v.string()), // if AI suggested rephrasing
    attachments: v.optional(v.array(v.object({
      type: v.union(v.literal("image"), v.literal("video")),
      url: v.string(),
    }))),
    isSystemMessage: v.boolean(),
    aiRephraseAccepted: v.optional(v.boolean()),
    createdAt: v.number(),
  })
  ```
- [ ] Create message indexes (by disputeId, senderId)
- [ ] Implement send message function
- [ ] Implement get messages by dispute function (with realtime subscription)

### 2.9 Favorites/Wishlist Schema
- [ ] Define favorites table:
  ```typescript
  favorites: defineTable({
    userId: v.id("users"),
    productId: v.id("products"),
    createdAt: v.number(),
  })
  ```
- [ ] Create favorites indexes (by userId, productId)
- [ ] Implement add/remove favorite functions
- [ ] Implement get user favorites function

### 2.10 Reviews Schema
- [ ] Define reviews table:
  ```typescript
  reviews: defineTable({
    orderId: v.id("orders"),
    reviewerId: v.id("users"),
    revieweeId: v.id("users"),
    productId: v.id("products"),
    rating: v.number(), // 1-5
    title: v.optional(v.string()),
    comment: v.optional(v.string()),
    createdAt: v.number(),
  })
  ```
- [ ] Create review indexes (by revieweeId, productId)
- [ ] Implement create review function
- [ ] Implement get reviews function
- [ ] Implement calculate average rating function

---

## Phase 3: Authentication Flow

### 3.1 Auth Screens
- [ ] Create Welcome/Onboarding screen
- [ ] Create Sign Up screen
  - [ ] Email input with validation
  - [ ] Password input with requirements display
  - [ ] First name and last name inputs
  - [ ] Terms and conditions checkbox
  - [ ] Sign up button with loading state
  - [ ] Link to Sign In screen
- [ ] Create Sign In screen
  - [ ] Email input
  - [ ] Password input
  - [ ] Forgot password link
  - [ ] Sign in button with loading state
  - [ ] Link to Sign Up screen
- [ ] Create Forgot Password screen
  - [ ] Email input
  - [ ] Send reset link button
  - [ ] Success message display
- [ ] Create Email Verification screen
- [ ] Implement Clerk authentication hooks
- [ ] Handle auth state persistence
- [ ] Implement protected route navigation

### 3.2 User Onboarding
- [ ] Create interests selection screen (category selection)
- [ ] Create location setup screen
- [ ] Create profile completion screen
- [ ] Implement onboarding flow navigation

---

## Phase 4: Core App Screens

### 4.1 Navigation Structure
- [ ] Implement bottom tab navigator:
  - Home
  - Browse/Categories
  - Sell (Create Listing)
  - Orders
  - Profile
- [ ] Implement stack navigators for each tab
- [ ] Implement drawer navigator for additional options
- [ ] Handle deep linking

### 4.2 Home Screen
- [ ] Create home screen layout
- [ ] Implement search bar component
- [ ] Create featured categories horizontal scroll
- [ ] Create "Recommended for You" section (AI-powered)
- [ ] Create "Recently Listed" section
- [ ] Create "Popular Items" section
- [ ] Implement pull-to-refresh
- [ ] Implement lazy loading/pagination

### 4.3 Browse/Categories Screen
- [ ] Create categories grid view
- [ ] Create subcategories list view
- [ ] Create products list/grid view with toggle
- [ ] Implement search functionality
- [ ] Implement filters:
  - [ ] Price range (ZMW)
  - [ ] Condition
  - [ ] Location
  - [ ] Sort by (newest, price low-high, price high-low, popular)
- [ ] Create filter modal/bottom sheet
- [ ] Implement search suggestions

### 4.4 Product Details Screen
- [ ] Create image carousel/gallery
- [ ] Display product information:
  - [ ] Title
  - [ ] Price (ZMW format)
  - [ ] Condition badge
  - [ ] Description
  - [ ] Specifications list
  - [ ] Seller information card
  - [ ] Seller rating display
  - [ ] Location
  - [ ] Shipping options
- [ ] Implement "Add to Cart" button
- [ ] Implement "Buy Now" button
- [ ] Implement "Add to Favorites" button
- [ ] Implement "Share" functionality
- [ ] Create seller profile quick view
- [ ] Display similar products section

### 4.5 Cart Screen
- [ ] Create cart items list
- [ ] Display cart item:
  - [ ] Product image
  - [ ] Product title
  - [ ] Price
  - [ ] Quantity selector
  - [ ] Shipping option selector
  - [ ] Remove button
- [ ] Calculate and display subtotal
- [ ] Calculate and display shipping total
- [ ] Calculate and display grand total
- [ ] Create "Proceed to Checkout" button
- [ ] Handle empty cart state
- [ ] Implement cart item validation (check stock)

### 4.6 Checkout Screen
- [ ] Create order summary section
- [ ] Create shipping address form/selector
- [ ] Create shipping method selector (per seller if multiple)
- [ ] Display order totals breakdown
- [ ] Create payment method placeholder (post-MVP)
- [ ] Implement order placement (mock payment for MVP)
- [ ] Create order confirmation screen
- [ ] Send order confirmation (push notification)

### 4.7 Create Listing Screen
- [ ] Create multi-step form:
  - [ ] Step 1: Images (up to 10)
    - [ ] Image picker integration
    - [ ] Image reordering
    - [ ] Image deletion
  - [ ] Step 2: Basic Info
    - [ ] Title input
    - [ ] Description input (rich text optional)
    - [ ] Category selector
    - [ ] Subcategory selector
  - [ ] Step 3: Details
    - [ ] Condition selector
    - [ ] Price input (ZMW)
    - [ ] Compare at price (optional)
    - [ ] Quantity input
    - [ ] Specifications builder
  - [ ] Step 4: Shipping
    - [ ] Location selector
    - [ ] Shipping options builder
  - [ ] Step 5: Review & Publish
- [ ] Implement draft saving
- [ ] Implement form validation
- [ ] Implement image upload to Convex storage

### 4.8 My Listings Screen
- [ ] Create listings list with status tabs (Active, Draft, Sold, Suspended)
- [ ] Display listing card:
  - [ ] Image
  - [ ] Title
  - [ ] Price
  - [ ] Status badge
  - [ ] Views count
  - [ ] Created date
- [ ] Implement edit listing
- [ ] Implement delete listing
- [ ] Implement mark as sold
- [ ] Implement duplicate listing

### 4.9 Orders Screen
- [ ] Create orders tabs (Purchases, Sales)
- [ ] Create order card component:
  - [ ] Order number
  - [ ] Date
  - [ ] Items preview
  - [ ] Total amount
  - [ ] Status badge
- [ ] Implement order filtering by status
- [ ] Create order search

### 4.10 Order Details Screen
- [ ] Display order information:
  - [ ] Order number
  - [ ] Order date
  - [ ] Status with timeline
  - [ ] Items list
  - [ ] Shipping address
  - [ ] Payment summary
  - [ ] Tracking information (if available)
- [ ] For Buyers:
  - [ ] "Confirm Receipt" button (releases escrow)
  - [ ] "Open Dispute" button
  - [ ] "Leave Review" button (after completion)
- [ ] For Sellers:
  - [ ] "Mark as Shipped" button
  - [ ] Add tracking number input
  - [ ] Contact buyer option

### 4.11 Profile Screen
- [ ] Display user information:
  - [ ] Avatar
  - [ ] Name
  - [ ] Rating
  - [ ] Member since
  - [ ] Total sales/purchases
- [ ] Create menu items:
  - [ ] Edit Profile
  - [ ] My Listings
  - [ ] Favorites/Wishlist
  - [ ] My Reviews
  - [ ] Disputes
  - [ ] Settings
  - [ ] Help & Support
  - [ ] Log Out

### 4.12 Edit Profile Screen
- [ ] Avatar upload
- [ ] First name / Last name inputs
- [ ] Phone number input
- [ ] Address form
- [ ] Interests/Categories selection
- [ ] Save changes button

### 4.13 Favorites Screen
- [ ] Create favorites list/grid view
- [ ] Display favorite product cards
- [ ] Implement remove from favorites
- [ ] Handle empty state

### 4.14 Settings Screen
- [ ] Notification preferences
- [ ] Language selection (future)
- [ ] Currency display (future)
- [ ] Privacy settings
- [ ] Delete account option
- [ ] App version display

---

## Phase 5: Dispute System

### 5.1 Open Dispute Screen
- [ ] Create dispute form:
  - [ ] Title input
  - [ ] Description textarea
  - [ ] Evidence upload (images/videos)
  - [ ] Category selector (not received, defective, not as described, other)
- [ ] Implement evidence file upload
- [ ] Submit dispute button
- [ ] Display dispute guidelines

### 5.2 Disputes List Screen
- [ ] Create disputes list with status tabs
- [ ] Display dispute card:
  - [ ] Order reference
  - [ ] Title
  - [ ] Status badge
  - [ ] Last message preview
  - [ ] Created date
- [ ] Implement filtering

### 5.3 Dispute Details Screen
- [ ] Display dispute information:
  - [ ] Title
  - [ ] Description
  - [ ] Evidence gallery
  - [ ] Status
  - [ ] Order details summary
- [ ] Display AI summary (for moderators)
- [ ] Display AI resolution suggestions (for moderators)
- [ ] Create messages/conversation section (realtime)
- [ ] Create message input with:
  - [ ] Text input
  - [ ] Attachment button
  - [ ] Send button
  - [ ] AI rephrase suggestion display
- [ ] Moderator actions:
  - [ ] Take over case
  - [ ] Issue full refund
  - [ ] Issue partial refund
  - [ ] Close case (no refund)
  - [ ] Request more information

### 5.4 Dispute Resolution Modal
- [ ] Resolution type selector
- [ ] Partial refund amount input (if applicable)
- [ ] Resolution notes textarea
- [ ] Confirm resolution button

---

## Phase 6: NestJS API & AI Integration

### 6.1 API Module Structure
- [ ] Create AI module
- [ ] Create webhooks module (for Clerk events)
- [ ] Create health module
- [ ] Set up Swagger documentation

### 6.2 AI Service - Product Recommendations
- [ ] Create product recommendations endpoint
- [ ] Implement recommendation logic:
  - [ ] Fetch user interests from Convex
  - [ ] Fetch user purchase history
  - [ ] Fetch user browsing history (viewed products)
  - [ ] Create prompt for OpenAI with context
  - [ ] Return recommended product IDs
- [ ] Implement caching for recommendations
- [ ] Create fallback for new users (popular items)

### 6.3 AI Service - Message Rephrasing
- [ ] Create message rephrase endpoint
- [ ] Implement rephrasing logic:
  - [ ] Receive original message
  - [ ] Analyze for professionalism
  - [ ] Generate cleaner alternative
  - [ ] Return original + suggested message
- [ ] Handle edge cases (already professional, too short)

### 6.4 AI Service - Dispute Analysis
- [ ] Create dispute analysis endpoint
- [ ] Implement analysis logic:
  - [ ] Fetch dispute details
  - [ ] Fetch all messages in dispute
  - [ ] Fetch order details
  - [ ] Generate summary of situation
  - [ ] Generate resolution suggestions
  - [ ] Return analysis object
- [ ] Trigger analysis on:
  - [ ] Dispute creation
  - [ ] Moderator assignment
  - [ ] Significant conversation updates

### 6.5 Webhook Handlers
- [ ] Clerk user created webhook
- [ ] Clerk user updated webhook
- [ ] Clerk user deleted webhook

---

## Phase 7: Admin & Moderator Features

### 7.1 Admin Dashboard (Basic for MVP)
- [ ] Create admin navigation
- [ ] Platform statistics overview:
  - [ ] Total users
  - [ ] Total listings
  - [ ] Total orders
  - [ ] Total disputes
  - [ ] Revenue in escrow
- [ ] User management:
  - [ ] User list with search
  - [ ] View user details
  - [ ] Change user role
  - [ ] Ban/unban user
- [ ] Category management:
  - [ ] Category list
  - [ ] Add category/subcategory
  - [ ] Edit category
  - [ ] Reorder categories
  - [ ] Disable category
- [ ] Reported listings management

### 7.2 Moderator Dashboard
- [ ] Active disputes queue
- [ ] Assigned disputes list
- [ ] Dispute priority indicators
- [ ] Quick actions for dispute resolution
- [ ] Statistics:
  - [ ] Disputes resolved today
  - [ ] Average resolution time
  - [ ] Pending disputes count

---

## Phase 8: Notifications & Realtime Features

### 8.1 Push Notifications Setup
- [ ] Configure Expo notifications
- [ ] Set up push notification tokens storage
- [ ] Create notification service in NestJS
- [ ] Implement notification types:
  - [ ] Order placed (for seller)
  - [ ] Order status update (for buyer)
  - [ ] New message in dispute
  - [ ] Dispute resolution
  - [ ] Funds released
  - [ ] New review received

### 8.2 In-App Notifications
- [ ] Create notifications screen
- [ ] Create notification list item component
- [ ] Implement mark as read
- [ ] Implement notification badge on tab

### 8.3 Realtime Features
- [ ] Dispute messages realtime subscription
- [ ] Order status updates subscription
- [ ] Cart sync across devices
- [ ] Product stock updates

---

## Phase 9: File Storage & Media

### 9.1 Convex File Storage
- [ ] Configure Convex file storage
- [ ] Create image upload utility
- [ ] Create video upload utility
- [ ] Implement image compression before upload
- [ ] Implement file type validation
- [ ] Set up file size limits

### 9.2 Media Components
- [ ] Create image picker component
- [ ] Create video picker component
- [ ] Create image gallery/carousel component
- [ ] Create full-screen image viewer
- [ ] Create video player component
- [ ] Implement image caching

---

## Phase 10: Testing & Quality Assurance

### 10.1 Unit Testing
- [ ] Set up Jest for React Native
- [ ] Test utility functions
- [ ] Test Convex functions
- [ ] Test NestJS services
- [ ] Test AI integration mocks

### 10.2 Integration Testing
- [ ] Test authentication flows
- [ ] Test order placement flow
- [ ] Test dispute creation flow
- [ ] Test cart operations

### 10.3 End-to-End Testing
- [ ] Set up Detox for E2E testing
- [ ] Test critical user journeys:
  - [ ] Sign up and onboarding
  - [ ] Browse and purchase item
  - [ ] Create listing
  - [ ] Open and resolve dispute

---

## Phase 11: Performance & Optimization

### 11.1 App Performance
- [ ] Implement list virtualization (FlashList)
- [ ] Optimize image loading
- [ ] Implement skeleton loaders
- [ ] Reduce bundle size
- [ ] Profile and fix performance issues

### 11.2 API Performance
- [ ] Implement response caching
- [ ] Optimize database queries
- [ ] Set up rate limiting
- [ ] Monitor API response times

---

## Phase 12: Deployment & DevOps

### 12.1 Mobile App Deployment
- [ ] Configure EAS Build
- [ ] Set up development builds
- [ ] Set up preview builds
- [ ] Configure production builds
- [ ] Set up OTA updates
- [ ] Prepare App Store listing
- [ ] Prepare Play Store listing

### 12.2 Backend Deployment
- [ ] Deploy Convex to production
- [ ] Deploy NestJS to hosting (Railway/Render/AWS)
- [ ] Configure production environment variables
- [ ] Set up monitoring and logging
- [ ] Configure backups

---

## Phase 13: Polish & Launch Preparation

### 13.1 UI/UX Polish
- [ ] Review all screens for consistency
- [ ] Add loading states everywhere
- [ ] Add error states everywhere
- [ ] Add empty states everywhere
- [ ] Implement haptic feedback
- [ ] Add micro-animations
- [ ] Ensure accessibility (a11y)

### 13.2 Content & Copy
- [ ] Review all UI copy
- [ ] Create Terms of Service
- [ ] Create Privacy Policy
- [ ] Create FAQ content
- [ ] Create Help documentation

### 13.3 Pre-Launch Checklist
- [ ] Security audit
- [ ] Performance audit
- [ ] Legal compliance review
- [ ] Beta testing with real users
- [ ] Fix critical bugs from beta
- [ ] Prepare launch marketing materials

---

## Data Models Reference

### Currency Formatting
```typescript
// ZMW Currency Formatter
const formatZMW = (amount: number): string => {
  return new Intl.NumberFormat('en-ZM', {
    style: 'currency',
    currency: 'ZMW',
  }).format(amount);
};
```

### Product Conditions
| Value | Display |
|-------|---------|
| `new` | New |
| `like_new` | Like New |
| `good` | Good |
| `fair` | Fair |

### Order Statuses Flow
```
pending_payment → paid → processing → shipped → delivered → completed
                                                    ↓
                                                disputed → resolved
```

### Dispute Statuses Flow
```
open → in_discussion → moderator_review → resolved/closed
```

---

## Environment Variables

### React Native (.env)
```
CLERK_PUBLISHABLE_KEY=
CONVEX_URL=
API_URL=
```

### NestJS (.env)
```
PORT=3000
OPENAI_API_KEY=
CONVEX_URL=
CONVEX_DEPLOY_KEY=
CLERK_SECRET_KEY=
CLERK_WEBHOOK_SECRET=
```

---

## Initial Categories Seed Data

```javascript
const categories = [
  {
    name: "Auto Parts",
    slug: "auto-parts",
    subcategories: [
      { name: "Engine Parts", slug: "engine-parts" },
      { name: "Suspension", slug: "suspension" },
      { name: "Brakes", slug: "brakes" },
      { name: "Electrical", slug: "electrical" },
      { name: "Body Parts", slug: "body-parts" },
      { name: "Oils & Lubricants", slug: "oils-lubricants" },
      { name: "Filters", slug: "filters" },
      { name: "Transmission", slug: "transmission" },
    ]
  },
  {
    name: "Car Accessories",
    slug: "car-accessories",
    subcategories: [
      { name: "Interior", slug: "interior" },
      { name: "Exterior", slug: "exterior" },
      { name: "Car Electronics", slug: "car-electronics" },
      { name: "Car Care", slug: "car-care" },
    ]
  },
  {
    name: "Tech & Electronics",
    slug: "tech-electronics",
    subcategories: [
      { name: "Phones", slug: "phones" },
      { name: "Laptops", slug: "laptops" },
      { name: "Tablets", slug: "tablets" },
      { name: "Accessories", slug: "tech-accessories" },
      { name: "Gaming", slug: "gaming" },
    ]
  },
  {
    name: "General",
    slug: "general",
    subcategories: [
      { name: "Home & Garden", slug: "home-garden" },
      { name: "Fashion", slug: "fashion" },
      { name: "Sports", slug: "sports" },
      { name: "Other", slug: "other" },
    ]
  }
];
```

---

## MVP Scope Summary

### Included in MVP:
- User authentication (Clerk)
- User roles (User, Moderator, Admin)
- Product listings CRUD
- Categories and subcategories
- Product browsing and search
- Shopping cart
- Order placement (mock payment)
- Escrow system (mock)
- Order tracking
- Dispute system
- Dispute messaging (realtime)
- AI product recommendations
- AI message rephrasing
- AI dispute analysis
- Basic admin panel
- Moderator tools
- Push notifications

### Post-MVP (Not included):
- Payment gateway integration
- Multiple currencies
- Advanced analytics
- Seller verification badges
- Promoted listings
- In-app wallet
- Multi-language support
- Advanced shipping integrations
- Seller subscription tiers

---

## Estimated Component Count

| Category | Count |
|----------|-------|
| Screens | ~35 |
| Reusable Components | ~40 |
| Convex Functions | ~50 |
| NestJS Endpoints | ~15 |
| Database Tables | 10 |

---

*Document Version: 1.0*
*Last Updated: November 2024*
