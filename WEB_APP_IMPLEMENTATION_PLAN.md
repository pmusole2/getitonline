# Gettitonline - Web App Implementation Plan

## Overview

A web application for the Gettitonline platform with full marketplace functionality (mirroring the mobile app) plus a comprehensive admin panel for platform management.

**Currency:** ZMW (Zambian Kwacha)
**Target Market:** Zambia

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Framework | Next.js 14+ (App Router) |
| Language | TypeScript |
| UI Components | shadcn/ui + Radix UI |
| Styling | Tailwind CSS |
| State Management | Zustand + React Query (TanStack Query) |
| Database | Convex (shared with mobile) |
| Authentication | Clerk (shared with mobile) |
| Forms | React Hook Form + Zod |
| Tables | TanStack Table |
| Charts | Recharts |
| File Upload | Convex file storage |
| Notifications | Sonner (toasts) |
| Icons | Lucide React |

---

## Project Structure

```
apps/web/
├── public/
│   ├── images/
│   └── icons/
├── src/
│   ├── app/                          # Next.js App Router
│   │   ├── (auth)/                   # Auth routes (public)
│   │   │   ├── sign-in/
│   │   │   ├── sign-up/
│   │   │   ├── forgot-password/
│   │   │   └── verify-email/
│   │   ├── (main)/                   # Main marketplace routes
│   │   │   ├── page.tsx              # Home
│   │   │   ├── browse/
│   │   │   ├── product/[id]/
│   │   │   ├── search/
│   │   │   ├── cart/
│   │   │   ├── checkout/
│   │   │   ├── orders/
│   │   │   ├── sell/
│   │   │   ├── messages/
│   │   │   ├── disputes/
│   │   │   ├── wallet/
│   │   │   ├── favorites/
│   │   │   ├── notifications/
│   │   │   ├── profile/
│   │   │   ├── settings/
│   │   │   └── seller/[id]/
│   │   ├── (admin)/                  # Admin panel routes
│   │   │   └── admin/
│   │   │       ├── page.tsx          # Dashboard
│   │   │       ├── users/
│   │   │       ├── products/
│   │   │       ├── orders/
│   │   │       ├── categories/
│   │   │       ├── disputes/
│   │   │       ├── transactions/
│   │   │       ├── escrow/
│   │   │       ├── analytics/
│   │   │       ├── reports/
│   │   │       └── settings/
│   │   ├── api/                      # API routes (if needed)
│   │   ├── layout.tsx
│   │   └── globals.css
│   ├── components/
│   │   ├── ui/                       # shadcn/ui components
│   │   ├── common/                   # Shared components
│   │   │   ├── Header.tsx
│   │   │   ├── Footer.tsx
│   │   │   ├── Sidebar.tsx
│   │   │   ├── SearchBar.tsx
│   │   │   ├── LoadingSpinner.tsx
│   │   │   ├── EmptyState.tsx
│   │   │   ├── ErrorBoundary.tsx
│   │   │   └── Pagination.tsx
│   │   ├── auth/                     # Auth components
│   │   ├── home/                     # Home page components
│   │   ├── product/                  # Product components
│   │   ├── cart/                     # Cart components
│   │   ├── checkout/                 # Checkout components
│   │   ├── orders/                   # Order components
│   │   ├── sell/                     # Sell/listing components
│   │   ├── messages/                 # Messaging components
│   │   ├── disputes/                 # Dispute components
│   │   ├── wallet/                   # Wallet components
│   │   ├── profile/                  # Profile components
│   │   ├── admin/                    # Admin panel components
│   │   │   ├── layout/
│   │   │   ├── dashboard/
│   │   │   ├── users/
│   │   │   ├── products/
│   │   │   ├── orders/
│   │   │   ├── categories/
│   │   │   ├── disputes/
│   │   │   ├── transactions/
│   │   │   ├── analytics/
│   │   │   └── settings/
│   │   └── ai/                       # AI assistant components
│   ├── hooks/                        # Custom React hooks
│   │   ├── useAuth.ts
│   │   ├── useCart.ts
│   │   ├── useWallet.ts
│   │   ├── usePayment.ts
│   │   ├── useAIRecommendations.ts
│   │   ├── useNotifications.ts
│   │   ├── useDebounce.ts
│   │   └── useMediaQuery.ts
│   ├── lib/                          # Utilities
│   │   ├── utils.ts
│   │   ├── api.ts
│   │   ├── convex.ts
│   │   └── constants.ts
│   ├── providers/                    # Context providers
│   │   ├── ConvexProvider.tsx
│   │   ├── AuthProvider.tsx
│   │   ├── ThemeProvider.tsx
│   │   └── QueryProvider.tsx
│   ├── stores/                       # Zustand stores
│   │   ├── cartStore.ts
│   │   ├── uiStore.ts
│   │   └── filterStore.ts
│   └── types/                        # TypeScript types
│       └── index.ts
├── .env.local
├── next.config.js
├── tailwind.config.js
├── tsconfig.json
└── package.json
```

---

## Feature Mapping: Mobile to Web

### Authentication Features

| # | Feature | Mobile | Web | Notes |
|---|---------|--------|-----|-------|
| 1 | Welcome/landing page | ✅ | ✅ | Web gets full marketing landing page |
| 2 | Email/password sign up | ✅ | ✅ | |
| 3 | Email verification | ✅ | ✅ | |
| 4 | Email/password sign in | ✅ | ✅ | |
| 5 | Google OAuth | ✅ | ✅ | |
| 6 | Forgot password | ✅ | ✅ | |
| 7 | Session persistence | ✅ | ✅ | |
| 8 | Auto-sync user to Convex | ✅ | ✅ | |

### Home & Discovery Features

| # | Feature | Mobile | Web | Notes |
|---|---------|--------|-----|-------|
| 9 | Personalized greeting | ✅ | ✅ | |
| 10 | Search bar | ✅ | ✅ | Enhanced with autocomplete |
| 11 | AI Insight Card | ✅ | ✅ | |
| 12 | AI recommendations | ✅ | ✅ | |
| 13 | Category browsing | ✅ | ✅ | Grid layout on web |
| 14 | Trust badges | ✅ | ✅ | |
| 15 | Recent listings | ✅ | ✅ | |
| 16 | Cart icon with badge | ✅ | ✅ | In header |
| 17 | Notifications icon | ✅ | ✅ | Dropdown on web |
| 18 | AI Assistant | ✅ | ✅ | Floating widget or sidebar |

### Browse & Search Features

| # | Feature | Mobile | Web | Notes |
|---|---------|--------|-----|-------|
| 19 | Categories grid | ✅ | ✅ | Sidebar + grid on web |
| 20 | Subcategories | ✅ | ✅ | |
| 21 | Quick filters | ✅ | ✅ | |
| 22 | Full-text search | ✅ | ✅ | |
| 23 | Filter by category | ✅ | ✅ | Sidebar filters on web |
| 24 | Filter by condition | ✅ | ✅ | |
| 25 | Filter by price range | ✅ | ✅ | Range slider |
| 26 | Sort options | ✅ | ✅ | |
| 27 | Grid/list view toggle | ✅ | ✅ | |
| 28 | Pagination | ✅ | ✅ | Traditional pagination on web |
| 29 | Search suggestions | ✅ | ✅ | Autocomplete dropdown |

### Product Details Features

| # | Feature | Mobile | Web | Notes |
|---|---------|--------|-----|-------|
| 30 | Image gallery | ✅ | ✅ | Lightbox on web |
| 31 | Image zoom | ❌ | ✅ | Web-specific |
| 32 | Product info display | ✅ | ✅ | |
| 33 | Specifications table | ✅ | ✅ | |
| 34 | Seller card | ✅ | ✅ | |
| 35 | Contact seller | ✅ | ✅ | |
| 36 | Favorite toggle | ✅ | ✅ | |
| 37 | Add to cart | ✅ | ✅ | |
| 38 | Buy now | ✅ | ✅ | |
| 39 | Product stats | ✅ | ✅ | |
| 40 | Escrow info | ✅ | ✅ | |
| 41 | AI price analysis | ✅ | ✅ | |
| 42 | Shipping options | ✅ | ✅ | |
| 43 | Similar products | ✅ | ✅ | |
| 44 | Share buttons | ✅ | ✅ | Social sharing on web |
| 45 | Breadcrumb navigation | ❌ | ✅ | Web-specific |

### Selling / Product Management Features

| # | Feature | Mobile | Web | Notes |
|---|---------|--------|-----|-------|
| 46 | Seller dashboard | ✅ | ✅ | Enhanced on web |
| 47 | Stats cards | ✅ | ✅ | |
| 48 | AI selling tips | ✅ | ✅ | |
| 49 | Product list with filters | ✅ | ✅ | Table view on web |
| 50 | Create product | ✅ | ✅ | Multi-step form |
| 51 | Multi-image upload | ✅ | ✅ | Drag & drop on web |
| 52 | Image reordering | ✅ | ✅ | Drag & drop |
| 53 | All product fields | ✅ | ✅ | |
| 54 | Shipping options builder | ✅ | ✅ | |
| 55 | Specifications builder | ✅ | ✅ | |
| 56 | Draft saving | ✅ | ✅ | |
| 57 | Edit product | ✅ | ✅ | |
| 58 | Delete product | ✅ | ✅ | |
| 59 | Mark as sold | ✅ | ✅ | |
| 60 | Duplicate listing | ✅ | ✅ | |
| 61 | Bulk actions | ❌ | ✅ | Web-specific |

### Shopping Cart Features

| # | Feature | Mobile | Web | Notes |
|---|---------|--------|-----|-------|
| 62 | Cart items list | ✅ | ✅ | |
| 63 | Quantity controls | ✅ | ✅ | |
| 64 | Remove item | ✅ | ✅ | |
| 65 | Shipping selector | ✅ | ✅ | |
| 66 | Order summary | ✅ | ✅ | |
| 67 | Clear cart | ✅ | ✅ | |
| 68 | Stock validation | ✅ | ✅ | |
| 69 | Mini cart dropdown | ❌ | ✅ | Web-specific |

### Checkout & Payment Features

| # | Feature | Mobile | Web | Notes |
|---|---------|--------|-----|-------|
| 70 | Shipping address form | ✅ | ✅ | |
| 71 | Saved addresses | ✅ | ✅ | |
| 72 | Payment selection | ✅ | ✅ | |
| 73 | Wallet payment | ✅ | ✅ | |
| 74 | Mobile Money | ✅ | ✅ | MTN, Airtel, Zamtel |
| 75 | Card payment | ✅ | ✅ | |
| 76 | Platform fee display | ✅ | ✅ | |
| 77 | Order summary | ✅ | ✅ | |
| 78 | Place order | ✅ | ✅ | |
| 79 | Order confirmation | ✅ | ✅ | Confirmation page |
| 80 | Payment status | ✅ | ✅ | |

### Orders Management Features

| # | Feature | Mobile | Web | Notes |
|---|---------|--------|-----|-------|
| 81 | Purchases/Sales toggle | ✅ | ✅ | Tabs on web |
| 82 | Order cards | ✅ | ✅ | Table view option |
| 83 | Status badges | ✅ | ✅ | |
| 84 | Order filters | ✅ | ✅ | |
| 85 | Order search | ✅ | ✅ | |
| 86 | Order details page | ✅ | ✅ | |
| 87 | Order timeline | ✅ | ✅ | |
| 88 | Buyer actions | ✅ | ✅ | |
| 89 | Seller actions | ✅ | ✅ | |
| 90 | Add tracking | ✅ | ✅ | |
| 91 | Open dispute | ✅ | ✅ | |
| 92 | Print order/invoice | ❌ | ✅ | Web-specific |

### Wallet Features

| # | Feature | Mobile | Web | Notes |
|---|---------|--------|-----|-------|
| 93 | Balance display | ✅ | ✅ | |
| 94 | Transaction history | ✅ | ✅ | Table with filters |
| 95 | Top-up mobile money | ✅ | ✅ | |
| 96 | Top-up card | ✅ | ✅ | |
| 97 | Withdraw mobile money | ✅ | ✅ | |
| 98 | Withdraw bank | ✅ | ✅ | |
| 99 | Activity timeline | ✅ | ✅ | |
| 100 | Transaction details | ✅ | ✅ | Modal on web |
| 101 | Export transactions | ❌ | ✅ | Web-specific (CSV) |

### Conversations Features

| # | Feature | Mobile | Web | Notes |
|---|---------|--------|-----|-------|
| 102 | Conversations list | ✅ | ✅ | Sidebar + chat view |
| 103 | Real-time chat | ✅ | ✅ | |
| 104 | Message history | ✅ | ✅ | |
| 105 | Unread indicators | ✅ | ✅ | |
| 106 | Product context | ✅ | ✅ | |
| 107 | Attachments | ✅ | ✅ | |
| 108 | Message search | ❌ | ✅ | Web-specific |

### Disputes Features

| # | Feature | Mobile | Web | Notes |
|---|---------|--------|-----|-------|
| 109 | Disputes list | ✅ | ✅ | Table view |
| 110 | Status filters | ✅ | ✅ | |
| 111 | Create dispute | ✅ | ✅ | |
| 112 | Category selector | ✅ | ✅ | |
| 113 | Evidence upload | ✅ | ✅ | Drag & drop |
| 114 | Dispute details | ✅ | ✅ | |
| 115 | Dispute chat | ✅ | ✅ | |
| 116 | AI analysis | ✅ | ✅ | |
| 117 | AI suggestions | ✅ | ✅ | |
| 118 | AI message rephrase | ✅ | ✅ | |

### Favorites Features

| # | Feature | Mobile | Web | Notes |
|---|---------|--------|-----|-------|
| 119 | Favorites list | ✅ | ✅ | Grid view |
| 120 | Add/remove favorite | ✅ | ✅ | |
| 121 | Favorites count | ✅ | ✅ | |

### Reviews Features

| # | Feature | Mobile | Web | Notes |
|---|---------|--------|-----|-------|
| 122 | Leave review | ✅ | ✅ | Modal on web |
| 123 | View seller reviews | ✅ | ✅ | |
| 124 | Rating display | ✅ | ✅ | |
| 125 | Rating distribution | ✅ | ✅ | Chart on web |

### Notifications Features

| # | Feature | Mobile | Web | Notes |
|---|---------|--------|-----|-------|
| 126 | Notifications list | ✅ | ✅ | Page + dropdown |
| 127 | Mark read/unread | ✅ | ✅ | |
| 128 | Delete notifications | ✅ | ✅ | |
| 129 | Filter by type | ✅ | ✅ | |
| 130 | Unread badge | ✅ | ✅ | |
| 131 | Real-time updates | ✅ | ✅ | |

### Profile Features

| # | Feature | Mobile | Web | Notes |
|---|---------|--------|-----|-------|
| 132 | Profile display | ✅ | ✅ | |
| 133 | Verification badge | ✅ | ✅ | |
| 134 | Stats display | ✅ | ✅ | |
| 135 | Edit profile | ✅ | ✅ | |
| 136 | Avatar upload | ✅ | ✅ | |
| 137 | Address management | ✅ | ✅ | |

### Settings Features

| # | Feature | Mobile | Web | Notes |
|---|---------|--------|-----|-------|
| 138 | Theme toggle | ✅ | ✅ | |
| 139 | Notification preferences | ✅ | ✅ | |
| 140 | Privacy settings | ✅ | ✅ | |
| 141 | Language selection | ✅ | ✅ | |
| 142 | Delete account | ✅ | ✅ | |

### Seller Profile (View Others) Features

| # | Feature | Mobile | Web | Notes |
|---|---------|--------|-----|-------|
| 143 | Seller profile page | ✅ | ✅ | |
| 144 | Seller stats | ✅ | ✅ | |
| 145 | Seller products | ✅ | ✅ | |
| 146 | Contact seller | ✅ | ✅ | |

### AI Features

| # | Feature | Mobile | Web | Notes |
|---|---------|--------|-----|-------|
| 147 | AI recommendations | ✅ | ✅ | |
| 148 | AI similar products | ✅ | ✅ | |
| 149 | AI dispute analysis | ✅ | ✅ | |
| 150 | AI resolution suggestions | ✅ | ✅ | |
| 151 | AI message rephrase | ✅ | ✅ | |
| 152 | AI chat assistant | ✅ | ✅ | Chat widget |
| 153 | AI price insights | ✅ | ✅ | |
| 154 | AI selling tips | ✅ | ✅ | |

---

## Admin Panel Features (Web Only)

### Dashboard

| # | Feature | Description |
|---|---------|-------------|
| 1 | Overview cards | Total users, products, orders, revenue |
| 2 | Revenue chart | Daily/weekly/monthly revenue trends |
| 3 | Orders chart | Order volume over time |
| 4 | Recent orders | Latest orders quick view |
| 5 | Recent users | Newly registered users |
| 6 | Dispute alerts | Open disputes requiring attention |
| 7 | Escrow summary | Funds held, released, refunded |
| 8 | Quick actions | Common admin tasks |
| 9 | System health | API status, database status |
| 10 | Real-time updates | Live data refresh |

### User Management

| # | Feature | Description |
|---|---------|-------------|
| 11 | Users table | Paginated, sortable, filterable |
| 12 | Search users | By name, email, phone |
| 13 | Filter by role | User, Moderator, Admin |
| 14 | Filter by status | Active, Banned, Verified |
| 15 | View user details | Full profile view |
| 16 | Edit user | Modify user information |
| 17 | Change user role | Promote/demote users |
| 18 | Ban/unban user | Account suspension |
| 19 | Verify user | Manual verification |
| 20 | View user orders | User's order history |
| 21 | View user products | User's listings |
| 22 | View user wallet | Wallet balance and history |
| 23 | View user disputes | Disputes involved in |
| 24 | User activity log | Actions taken by user |
| 25 | Export users | CSV export |
| 26 | Bulk actions | Ban, verify, role change |

### Product Management

| # | Feature | Description |
|---|---------|-------------|
| 27 | Products table | All listings with filters |
| 28 | Search products | By title, seller, category |
| 29 | Filter by status | Draft, Active, Sold, Suspended |
| 30 | Filter by category | Category hierarchy |
| 31 | View product details | Full product view |
| 32 | Edit product | Modify any product |
| 33 | Suspend product | Remove from marketplace |
| 34 | Restore product | Reactivate suspended |
| 35 | Delete product | Permanent removal |
| 36 | Feature product | Mark as featured (future) |
| 37 | Product reports | Reported products queue |
| 38 | View product stats | Views, favorites, orders |
| 39 | Export products | CSV export |
| 40 | Bulk suspend | Mass suspension |

### Category Management

| # | Feature | Description |
|---|---------|-------------|
| 41 | Categories tree | Hierarchical view |
| 42 | Create category | Add new category |
| 43 | Create subcategory | Add under parent |
| 44 | Edit category | Modify name, slug, image |
| 45 | Delete category | Remove (with checks) |
| 46 | Reorder categories | Drag & drop ordering |
| 47 | Toggle active | Enable/disable category |
| 48 | Category images | Upload/change images |
| 49 | View category products | Products in category |
| 50 | Category stats | Product count, order count |

### Order Management

| # | Feature | Description |
|---|---------|-------------|
| 51 | Orders table | All orders with filters |
| 52 | Search orders | By order number, buyer, seller |
| 53 | Filter by status | All order statuses |
| 54 | Filter by date range | Date picker |
| 55 | View order details | Full order view |
| 56 | Order timeline | Status history |
| 57 | Update order status | Manual status change |
| 58 | Cancel order | Admin cancellation |
| 59 | View order escrow | Escrow details |
| 60 | View order dispute | Linked dispute |
| 61 | Contact buyer/seller | Send message |
| 62 | Order notes | Admin notes |
| 63 | Export orders | CSV export |
| 64 | Order analytics | Charts and stats |

### Dispute Management

| # | Feature | Description |
|---|---------|-------------|
| 65 | Disputes table | All disputes |
| 66 | Filter by status | Open, In Discussion, Review, Resolved |
| 67 | Filter by category | Dispute types |
| 68 | Dispute queue | Unassigned disputes |
| 69 | My disputes | Moderator's assigned |
| 70 | View dispute details | Full dispute view |
| 71 | Dispute chat | View/participate in conversation |
| 72 | Assign moderator | Assign to self or others |
| 73 | AI analysis view | View AI summary |
| 74 | Resolve dispute | Issue resolution |
| 75 | Full refund | Refund to buyer |
| 76 | Partial refund | Custom refund amount |
| 77 | No refund | Close in seller's favor |
| 78 | Add moderator notes | Internal notes |
| 79 | View evidence | All uploaded evidence |
| 80 | Dispute timeline | Status history |
| 81 | Export disputes | CSV export |
| 82 | Dispute analytics | Resolution stats |

### Transaction Management

| # | Feature | Description |
|---|---------|-------------|
| 83 | Transactions table | All payment transactions |
| 84 | Filter by status | Pending, Successful, Failed |
| 85 | Filter by type | Collection, Transfer, Refund |
| 86 | Filter by method | Mobile Money, Card, Wallet |
| 87 | Search transactions | By reference, user |
| 88 | View transaction details | Full transaction view |
| 89 | Transaction timeline | Status changes |
| 90 | Linked order | View associated order |
| 91 | Retry failed | Retry failed transactions |
| 92 | Export transactions | CSV export |
| 93 | Transaction analytics | Volume, success rate |

### Escrow Management

| # | Feature | Description |
|---|---------|-------------|
| 94 | Escrow table | All escrow records |
| 95 | Filter by status | Held, Released, Refunded, Disputed |
| 96 | View escrow details | Full escrow view |
| 97 | Manual release | Force release funds |
| 98 | Manual refund | Force refund |
| 99 | Escrow timeline | Status history |
| 100 | Platform fees | Fee breakdown |
| 101 | Export escrow | CSV export |
| 102 | Escrow analytics | Funds flow |

### Wallet Management

| # | Feature | Description |
|---|---------|-------------|
| 103 | Wallets table | All user wallets |
| 104 | Search wallets | By user |
| 105 | View wallet details | Balance, history |
| 106 | Wallet transactions | Transaction list |
| 107 | Freeze wallet | Suspend wallet |
| 108 | Unfreeze wallet | Reactivate |
| 109 | Admin adjustment | Credit/debit wallet |
| 110 | Export wallets | CSV export |

### Analytics & Reports

| # | Feature | Description |
|---|---------|-------------|
| 111 | Revenue dashboard | Revenue metrics |
| 112 | Sales by category | Category breakdown |
| 113 | Sales by location | Geographic data |
| 114 | User growth | Registration trends |
| 115 | Order trends | Order volume over time |
| 116 | Product trends | Listing trends |
| 117 | Dispute metrics | Resolution times, rates |
| 118 | Payment metrics | Success rates, methods |
| 119 | Platform fees | Fee revenue |
| 120 | Custom date ranges | Date picker for all reports |
| 121 | Export reports | PDF, CSV export |
| 122 | Scheduled reports | Email reports (future) |

### Platform Settings

| # | Feature | Description |
|---|---------|-------------|
| 123 | General settings | Platform name, currency |
| 124 | Fee settings | Platform fee percentage |
| 125 | Payment settings | Payment methods enabled |
| 126 | Notification templates | Email/push templates |
| 127 | Content moderation | Banned words, rules |
| 128 | System logs | Activity logs |
| 129 | API logs | API request logs |
| 130 | Backup settings | Database backup (future) |

### Moderator Features

| # | Feature | Description |
|---|---------|-------------|
| 131 | Moderator dashboard | Dispute-focused view |
| 132 | Dispute queue | Unassigned disputes |
| 133 | My cases | Assigned disputes |
| 134 | Quick resolve | Fast resolution actions |
| 135 | Performance stats | Resolution metrics |
| 136 | Reported content | Flagged products/users |

---

## Page Components Breakdown

### Public Pages

#### Landing Page (`/`)
- Hero section with CTA
- Feature highlights (Escrow, AI, Categories)
- How it works steps
- Featured categories
- Recent listings preview
- Trust badges
- Testimonials (future)
- Download app CTA
- Footer

#### Browse Page (`/browse`)
- Category sidebar (collapsible)
- Filter panel (price, condition, location)
- Sort dropdown
- View toggle (grid/list)
- Product grid
- Pagination
- Active filters display
- Clear filters button

#### Product Detail Page (`/product/[id]`)
- Breadcrumb navigation
- Image gallery with thumbnails
- Image lightbox/zoom
- Product info section
- Price and condition
- Quantity selector
- Add to cart / Buy now buttons
- Favorite button
- Share buttons
- Seller card with rating
- Contact seller button
- Product specifications table
- Product description
- Shipping options
- Escrow protection info
- AI price analysis
- Similar products carousel
- Reviews section

#### Search Page (`/search`)
- Search input (pre-filled)
- Search suggestions
- Filter sidebar
- Results grid
- No results state
- Pagination

### Authenticated Pages

#### Cart Page (`/cart`)
- Cart items list
- Item image, title, price
- Quantity controls
- Remove button
- Shipping selector per item
- Order summary sidebar
- Subtotal, shipping, total
- Proceed to checkout button
- Continue shopping link
- Empty cart state

#### Checkout Page (`/checkout`)
- Stepper (Shipping → Payment → Review)
- Shipping address form
- Saved addresses selector
- Payment method tabs
- Wallet balance display
- Mobile money form
- Card payment form
- Order review section
- Platform fee breakdown
- Place order button
- Escrow explanation

#### Orders Page (`/orders`)
- Tabs: Purchases / Sales
- Orders table/cards
- Status filter tabs
- Search orders
- Order card with:
  - Order number
  - Date
  - Status badge
  - Items preview
  - Total
  - View details link

#### Order Detail Page (`/orders/[id]`)
- Order header (number, date, status)
- Status timeline
- Order items table
- Shipping address
- Payment summary
- Tracking info
- Action buttons (based on role/status)
- Dispute button
- Print invoice button

#### Sell Dashboard (`/sell`)
- Stats cards
- Product filters
- Products table
- Status badges
- Actions column
- Create product button
- AI tips section

#### Create/Edit Product (`/sell/new`, `/sell/[id]/edit`)
- Multi-step form OR single page form
- Image uploader (drag & drop)
- Image reorder
- Title, description
- Category/subcategory selectors
- Condition selector
- Price inputs
- Quantity input
- Location input
- Specifications builder
- Shipping options builder
- Preview mode
- Save draft / Publish buttons

#### Messages Page (`/messages`)
- Conversations sidebar
- Chat area
- Message input
- Product context header
- Empty state

#### Disputes Page (`/disputes`)
- Disputes table
- Status filters
- Create dispute button

#### Dispute Detail (`/disputes/[id]`)
- Dispute info header
- Status badge
- Order summary
- Evidence gallery
- Chat thread
- AI analysis section
- Resolution actions (if moderator)

#### Wallet Page (`/wallet`)
- Balance card
- Quick actions (Top up, Withdraw)
- Transaction history table
- Filters (type, date)
- Transaction details modal

#### Favorites Page (`/favorites`)
- Products grid
- Remove from favorites
- Empty state

#### Notifications Page (`/notifications`)
- Notifications list
- Type filters
- Mark all read
- Notification cards

#### Profile Page (`/profile`)
- Profile header
- Stats
- Edit profile button
- Menu items

#### Edit Profile (`/profile/edit`)
- Avatar upload
- Form fields
- Save button

#### Settings Page (`/settings`)
- Theme toggle
- Notification preferences
- Privacy settings
- Delete account

#### Seller Profile (`/seller/[id]`)
- Seller header
- Rating
- Stats
- Products grid
- Contact button

### Admin Pages

#### Admin Dashboard (`/admin`)
- Stats cards row
- Revenue chart
- Orders chart
- Recent orders table
- Recent users table
- Dispute alerts
- Quick actions

#### Admin Users (`/admin/users`)
- Users data table
- Search, filter, sort
- Bulk actions
- User detail drawer/modal

#### Admin Products (`/admin/products`)
- Products data table
- Search, filter, sort
- Bulk actions
- Product detail drawer/modal

#### Admin Categories (`/admin/categories`)
- Category tree view
- Add/edit modals
- Drag & drop reorder

#### Admin Orders (`/admin/orders`)
- Orders data table
- Full filters
- Order detail drawer/modal

#### Admin Disputes (`/admin/disputes`)
- Disputes data table
- Queue view
- Dispute detail drawer/modal
- Resolution actions

#### Admin Transactions (`/admin/transactions`)
- Transactions data table
- Status filters
- Detail modal

#### Admin Escrow (`/admin/escrow`)
- Escrow data table
- Status filters
- Manual actions

#### Admin Analytics (`/admin/analytics`)
- Revenue charts
- User charts
- Order charts
- Category breakdown
- Geographic breakdown
- Date range picker

#### Admin Settings (`/admin/settings`)
- Platform settings form
- Fee configuration
- Payment method toggles

---

## Implementation Phases

### Phase 1: Project Setup & Core Infrastructure
- [ ] Initialize Next.js project with TypeScript
- [ ] Set up Tailwind CSS
- [ ] Install and configure shadcn/ui
- [ ] Set up Convex integration
- [ ] Set up Clerk authentication
- [ ] Create basic layout components (Header, Footer, Sidebar)
- [ ] Set up routing structure
- [ ] Create providers (Convex, Auth, Theme, Query)
- [ ] Set up environment variables
- [ ] Configure ESLint and Prettier

### Phase 2: Authentication
- [ ] Landing page
- [ ] Sign in page
- [ ] Sign up page
- [ ] Email verification
- [ ] Forgot password
- [ ] Auth middleware/guards
- [ ] Redirect logic

### Phase 3: Core Marketplace (Browse & Product)
- [ ] Home page with categories
- [ ] Browse page with filters
- [ ] Search page with results
- [ ] Product detail page
- [ ] Category pages
- [ ] Seller profile page

### Phase 4: Shopping & Checkout
- [ ] Cart page
- [ ] Cart functionality (add, update, remove)
- [ ] Checkout page
- [ ] Shipping address form
- [ ] Payment integration (Wallet, Mobile Money, Card)
- [ ] Order confirmation

### Phase 5: Orders & Wallet
- [ ] Orders list page
- [ ] Order detail page
- [ ] Order actions (confirm, complete, cancel)
- [ ] Wallet page
- [ ] Top-up flow
- [ ] Withdrawal flow
- [ ] Transaction history

### Phase 6: Selling
- [ ] Sell dashboard
- [ ] Create product page
- [ ] Edit product page
- [ ] Product management actions
- [ ] Image upload with drag & drop

### Phase 7: Communication
- [ ] Messages page
- [ ] Real-time chat
- [ ] Conversation list
- [ ] AI assistant widget

### Phase 8: Disputes
- [ ] Disputes list page
- [ ] Create dispute page
- [ ] Dispute detail page
- [ ] Dispute chat
- [ ] AI analysis display

### Phase 9: Profile & Settings
- [ ] Profile page
- [ ] Edit profile page
- [ ] Favorites page
- [ ] Notifications page
- [ ] Settings page

### Phase 10: Admin Panel - Setup
- [ ] Admin layout
- [ ] Admin sidebar
- [ ] Admin header
- [ ] Role-based access control
- [ ] Admin routing

### Phase 11: Admin Panel - Dashboard
- [ ] Stats cards
- [ ] Revenue chart
- [ ] Orders chart
- [ ] Recent activity tables
- [ ] Quick actions

### Phase 12: Admin Panel - User Management
- [ ] Users data table
- [ ] User search/filter
- [ ] User detail view
- [ ] User actions (ban, verify, role change)
- [ ] User activity

### Phase 13: Admin Panel - Product & Category Management
- [ ] Products data table
- [ ] Product actions (suspend, delete)
- [ ] Category tree management
- [ ] Category CRUD

### Phase 14: Admin Panel - Order & Transaction Management
- [ ] Orders data table
- [ ] Order detail view
- [ ] Transaction table
- [ ] Escrow management

### Phase 15: Admin Panel - Dispute Management
- [ ] Disputes queue
- [ ] Dispute detail view
- [ ] Resolution actions
- [ ] Moderator assignment

### Phase 16: Admin Panel - Analytics & Settings
- [ ] Analytics dashboard
- [ ] Reports generation
- [ ] Platform settings
- [ ] Export functionality

### Phase 17: Polish & Optimization
- [ ] Loading states
- [ ] Error handling
- [ ] Empty states
- [ ] Responsive design
- [ ] Performance optimization
- [ ] SEO optimization
- [ ] Accessibility

### Phase 18: Testing & Deployment
- [ ] Unit tests
- [ ] Integration tests
- [ ] E2E tests
- [ ] Production build
- [ ] Deployment configuration

---

## Component Library (shadcn/ui)

### Required Components
- [ ] Button
- [ ] Input
- [ ] Textarea
- [ ] Select
- [ ] Checkbox
- [ ] Radio Group
- [ ] Switch
- [ ] Slider
- [ ] Card
- [ ] Dialog / Modal
- [ ] Sheet (drawer)
- [ ] Dropdown Menu
- [ ] Tabs
- [ ] Table
- [ ] Data Table
- [ ] Form
- [ ] Badge
- [ ] Avatar
- [ ] Tooltip
- [ ] Popover
- [ ] Command (search)
- [ ] Breadcrumb
- [ ] Pagination
- [ ] Skeleton
- [ ] Toast (Sonner)
- [ ] Alert
- [ ] Progress
- [ ] Separator
- [ ] Accordion
- [ ] Collapsible
- [ ] Scroll Area
- [ ] Aspect Ratio

---

## API Services (Shared with Mobile)

The web app will use the same:
- Convex queries and mutations
- NestJS API for AI features
- Payment service integration

---

## Summary

| Category | Mobile Features | Web Features | Admin Features |
|----------|-----------------|--------------|----------------|
| Auth | 8 | 8 | - |
| Marketplace | 45 | 48 | - |
| Shopping | 18 | 20 | - |
| Orders | 12 | 14 | 14 |
| Wallet | 9 | 11 | 8 |
| Communication | 11 | 13 | - |
| Disputes | 18 | 18 | 18 |
| Profile | 14 | 14 | - |
| AI | 8 | 8 | - |
| Dashboard | - | - | 10 |
| User Mgmt | - | - | 16 |
| Product Mgmt | - | - | 14 |
| Category Mgmt | - | - | 10 |
| Analytics | - | - | 12 |
| Settings | - | - | 8 |
| **Total** | ~154 | ~166 | ~110 |

**Grand Total: ~276 features for web app (marketplace + admin)**

---

*Document Version: 1.0*
*Created: November 2024*
