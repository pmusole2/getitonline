# Gettitonline Mobile App - Implementation Documentation

This is the detailed mobile implementation reference. For local setup, EAS/TestFlight flow, and release checks, start with the root [README.md](/Users/macbookair/Desktop/Auto%20Marketplace/README.md).

## Overview

**Framework:** React Native 0.81.5 with Expo
**Language:** TypeScript
**State Management:** Convex (real-time) + React Context
**Authentication:** Clerk
**UI Library:** React Native Paper (Material Design 3)

The mobile app is a full-featured marketplace application for buying and selling products in Zambia, featuring AI-powered recommendations, real-time messaging, escrow payments, and dispute resolution.

---

## Table of Contents

1. [Architecture](#architecture)
2. [Getting Started](#getting-started)
3. [Environment Variables](#environment-variables)
4. [Navigation Structure](#navigation-structure)
5. [Screens Reference](#screens-reference)
6. [State Management](#state-management)
7. [Custom Hooks](#custom-hooks)
8. [UI Components](#ui-components)
9. [External Integrations](#external-integrations)
10. [Theme System](#theme-system)
11. [Type Definitions](#type-definitions)

---

## Architecture

### Folder Structure

```
apps/mobile/
├── src/
│   ├── components/           # Reusable UI components
│   │   ├── ui/              # Design system components
│   │   │   ├── Header.tsx           # Multiple header variants
│   │   │   ├── AnimatedProductCard.tsx
│   │   │   ├── AIAssistant.tsx      # AI chat modal & FAB
│   │   │   └── Skeleton.tsx         # Loading placeholders
│   │   ├── common/          # Shared components
│   │   ├── product/         # Product-specific components
│   │   ├── cart/            # Cart components
│   │   └── dispute/         # Dispute components
│   │
│   ├── context/             # React Context providers
│   │   ├── AuthProvider.tsx         # User authentication state
│   │   ├── ThemeProvider.tsx        # Theme management
│   │   └── ConvexClientProvider.tsx # Convex client setup
│   │
│   ├── hooks/               # Custom React hooks
│   │   ├── useAIRecommendations.ts  # AI product recommendations
│   │   ├── usePayment.ts            # Payment processing
│   │   ├── useWallet.ts             # Wallet operations
│   │   ├── useImageUpload.ts        # Image picker & upload
│   │   ├── useOrderTotal.ts         # Order calculations
│   │   ├── usePushNotifications.ts  # Push notification handling
│   │   └── useWarmUpBrowser.ts      # OAuth optimization
│   │
│   ├── navigation/          # Navigation configuration
│   │   ├── RootNavigator.tsx        # Main navigator
│   │   ├── MainTabNavigator.tsx     # Bottom tab navigation
│   │   └── AuthNavigator.tsx        # Authentication flow
│   │
│   ├── screens/             # Application screens (28 total)
│   │   ├── auth/            # Welcome, SignIn, SignUp
│   │   ├── home/            # HomeScreen
│   │   ├── browse/          # Browse, Search, CategoryProducts
│   │   ├── product/         # Detail, Create, Edit, Sell
│   │   ├── cart/            # Cart, Checkout
│   │   ├── orders/          # Orders list, OrderDetail
│   │   ├── disputes/        # List, Detail, Create, Chat
│   │   ├── conversations/   # List, Chat
│   │   ├── profile/         # Profile, Edit, Settings, SellerProfile
│   │   ├── wallet/          # WalletScreen
│   │   └── notifications/   # NotificationsScreen
│   │
│   ├── services/            # API integration
│   │   ├── api.ts           # NestJS backend client
│   │   ├── payments.ts      # Payment service
│   │   └── wallet.ts        # Wallet service
│   │
│   ├── theme/               # Theme configuration
│   │   └── index.ts         # Colors, tokens, utilities
│   │
│   ├── types/               # TypeScript definitions
│   │   └── index.ts         # All type exports
│   │
│   └── utils/               # Utility functions
│
├── App.tsx                  # Root component with providers
├── index.ts                 # Expo entry point
├── app.json                 # Expo configuration
└── package.json
```

### Provider Hierarchy

```
ErrorBoundary
└─ ClerkProvider (authentication)
    └─ ClerkLoaded
        └─ ConvexClientProvider (real-time database)
            └─ AuthProvider (user sync & state)
                └─ SafeAreaProvider
                    └─ ThemeProvider (theme state)
                        └─ PaperProvider (UI theming)
                            └─ NavigationContainer
                                └─ RootNavigator
```

---

## Getting Started

### Prerequisites

- Node.js 18+
- Expo CLI (`npm install -g expo-cli`)
- iOS Simulator (Mac) or Android Emulator
- Clerk account
- Convex account

### Installation

```bash
cd apps/mobile
npm install
```

### Running the App

```bash
# Start Expo development server
npx expo start

# Run on iOS
npx expo run:ios

# Run on Android
npx expo run:android
```

### Building for Production

```bash
# EAS Build (recommended)
npx eas build --platform ios
npx eas build --platform android

# Local build
npx expo build:ios
npx expo build:android
```

---

## Environment Variables

Create environment variables in your Expo configuration:

```env
EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
EXPO_PUBLIC_CONVEX_URL=https://your-project.convex.cloud
EXPO_PUBLIC_API_URL=https://your-api.com  # Optional, computed from Expo host in dev
```

**Note:** All public environment variables must be prefixed with `EXPO_PUBLIC_`.

---

## Navigation Structure

### RootNavigator

The main navigator that handles authentication state and hosts all screens.

```typescript
// Conditional rendering based on auth state
if (!isSignedIn) {
  return <AuthNavigator />;
}
return <MainTabNavigator />;
```

### AuthNavigator (Pre-login)

| Screen | Route | Purpose |
|--------|-------|---------|
| WelcomeScreen | `Welcome` | Feature highlights, Get Started |
| SignInScreen | `SignIn` | Clerk sign-in |
| SignUpScreen | `SignUp` | Clerk sign-up |

### MainTabNavigator (Bottom Tabs)

| Tab | Icon | Screen | Badge |
|-----|------|--------|-------|
| Home | `home` | HomeScreen | - |
| Browse | `compass` | BrowseScreen | - |
| Sell | `plus` (FAB) | SellScreen | - |
| Orders | `receipt` | OrdersScreen | - |
| Profile | `account` | ProfileScreen | - |

**Features:**
- Glassmorphism tab bar with blur effect
- Animated tab icons with spring physics
- Centered "Sell" button with gradient and pulse effect
- Custom active indicator

### Modal Screens

All accessible from authenticated state via `navigation.navigate()`:

| Screen | Route | Params | Animation |
|--------|-------|--------|-----------|
| ProductDetail | `ProductDetail` | `{ productId }` | slide_from_bottom |
| CreateProduct | `CreateProduct` | - | slide_from_bottom |
| EditProduct | `EditProduct` | `{ productId }` | slide_from_bottom |
| Cart | `Cart` | - | slide_from_right |
| Checkout | `Checkout` | - | slide_from_bottom |
| OrderDetail | `OrderDetail` | `{ orderId }` | default |
| CreateDispute | `CreateDispute` | `{ orderId }` | slide_from_bottom |
| DisputeDetail | `DisputeDetail` | `{ disputeId }` | default |
| Chat | `Chat` | `{ disputeId }` | default |
| Conversations | `Conversations` | - | default |
| ConversationChat | `ConversationChat` | `{ conversationId, productId? }` | default |
| Wallet | `Wallet` | - | slide_from_bottom |
| Settings | `Settings` | - | default |
| EditProfile | `EditProfile` | - | slide_from_bottom |
| SellerProfile | `SellerProfile` | `{ sellerId }` | default |
| Search | `Search` | `{ query?, categoryId? }` | fade |
| CategoryProducts | `CategoryProducts` | `{ categoryId, categoryName }` | default |
| Notifications | `Notifications` | - | default |

---

## Screens Reference

### Authentication (3 screens)

#### WelcomeScreen
**File:** `src/screens/auth/WelcomeScreen.tsx`

- Feature highlights carousel
- "Get Started" button → SignUp
- "Already have an account" → SignIn

#### SignInScreen
**File:** `src/screens/auth/SignInScreen.tsx`

- Clerk sign-in integration
- Email/password or OAuth
- Forgot password link

#### SignUpScreen
**File:** `src/screens/auth/SignUpScreen.tsx`

- Clerk sign-up integration
- Email/password registration
- Terms acceptance

---

### Home & Discovery (4 screens)

#### HomeScreen
**File:** `src/screens/home/HomeScreen.tsx`

**Features:**
- Time-based greeting ("Good morning, John")
- Search bar (navigates to Search screen)
- Category chips (horizontal scroll)
- AI-powered product recommendations with reasoning
- Recent products grid
- Cart icon with count badge
- Notifications icon with unread count
- AI Assistant FAB

**Data Sources:**
- `api.products.getRecentProducts`
- `api.categories.getCategoriesTree`
- AI recommendations from NestJS API

#### BrowseScreen
**File:** `src/screens/browse/BrowseScreen.tsx`

**Features:**
- Searchable category list
- Category cards with icons
- Expandable subcategory chips
- Category icon mapping

**Data Sources:**
- `api.categories.getCategoriesTree`

#### SearchScreen
**File:** `src/screens/browse/SearchScreen.tsx`

**Features:**
- Search by keyword
- Filter by category
- Product grid results

**Data Sources:**
- `api.products.searchProducts`

#### CategoryProductsScreen
**File:** `src/screens/browse/CategoryProductsScreen.tsx`

**Features:**
- Products filtered by category/subcategory
- Pagination support

---

### Product Management (4 screens)

#### ProductDetailScreen
**File:** `src/screens/product/ProductDetailScreen.tsx`

**Features:**
- Image carousel with pagination
- Price display (includes 5% platform fee)
- Condition badge (new, like_new, good, fair)
- "New" badge for items < 48 hours old
- Seller info with rating
- Favorites toggle with animation
- Add to Cart / Buy Now buttons
- Message Seller button (→ ConversationChat)
- View count tracking
- Similar products section (AI-powered)

**Data Sources:**
- `api.products.getProduct`
- `api.users.getUser` (seller)
- `api.favorites.isFavorited`
- Similar products from NestJS API

#### CreateProductScreen
**File:** `src/screens/product/CreateProductScreen.tsx`

**Features:**
- Image upload (max 5 images)
- Image compression (1200px, 80% quality)
- Title, description, price inputs
- Category/subcategory selection
- Condition picker
- Shipping options configuration
- Draft vs publish option

**Mutations:**
- `api.products.createProduct`
- `api.storage.generateUploadUrl`

#### EditProductScreen
**File:** `src/screens/product/EditProductScreen.tsx`

**Features:**
- Same as CreateProduct with pre-filled data
- Update/delete options

**Mutations:**
- `api.products.updateProduct`
- `api.products.deleteProduct`

#### SellScreen
**File:** `src/screens/product/SellScreen.tsx`

**Features:**
- Seller dashboard entry point
- Quick stats
- "Create Listing" CTA

---

### Shopping (2 screens)

#### CartScreen
**File:** `src/screens/cart/CartScreen.tsx`

**Features:**
- Cart items list
- Quantity controls (+/-)
- Remove item / Clear cart
- Shipping option per item
- Platform fee breakdown (5%)
- Total calculation
- Checkout button

**Data Sources:**
- `api.cart.getCart`
- `api.cart.validateCart`

**Mutations:**
- `api.cart.updateCartQuantity`
- `api.cart.updateCartShipping`
- `api.cart.removeFromCart`
- `api.cart.clearCart`

#### CheckoutScreen
**File:** `src/screens/cart/CheckoutScreen.tsx`

**Features:**
- Order summary by seller
- Shipping address selection/entry
- Payment method selection:
  - Wallet (if sufficient balance)
  - Mobile Money (MTN, Airtel, Zamtel)
  - Card
- Phone number entry for mobile money
- Order confirmation

**Payment Flow:**
1. Validate cart
2. Create order(s) - one per seller
3. Create escrow hold
4. Process payment via selected method
5. Navigate to order confirmation

---

### Orders (2 screens)

#### OrdersScreen
**File:** `src/screens/orders/OrdersScreen.tsx`

**Features:**
- Tab filters (All, Active, Completed)
- Order cards with status badge
- Order total
- Quick actions (View, Track)

**Data Sources:**
- `api.orders.getBuyerOrders`

#### OrderDetailScreen
**File:** `src/screens/orders/OrderDetailScreen.tsx`

**Features:**
- Order items list
- Status timeline/tracking
- Shipping info & tracking number
- Total breakdown
- Actions:
  - Confirm Delivery (when shipped)
  - Complete Order (release funds)
  - Open Dispute
  - Contact Seller

**Data Sources:**
- `api.orders.getOrder`

---

### Disputes (4 screens)

#### DisputesListScreen
**File:** `src/screens/disputes/DisputesListScreen.tsx`

**Features:**
- All user disputes (as buyer or seller)
- Status filtering
- Dispute cards with summary

**Data Sources:**
- `api.disputes.getBuyerDisputes`
- `api.disputes.getSellerDisputes`

#### DisputeDetailScreen
**File:** `src/screens/disputes/DisputeDetailScreen.tsx`

**Features:**
- Dispute status and timeline
- AI dispute analysis:
  - Summary (personalized)
  - Key points (buyer vs seller claims)
  - Sentiment analysis
  - Suggested resolutions with fairness scores
  - Recommended action
- Evidence gallery
- Quick actions based on status

**Data Sources:**
- `api.disputes.getDispute`
- AI analysis from NestJS API

#### CreateDisputeScreen
**File:** `src/screens/disputes/CreateDisputeScreen.tsx`

**Features:**
- Order selection
- Dispute category:
  - `not_received` - Item not received
  - `defective` - Item defective
  - `not_as_described` - Not as described
  - `other` - Other issue
- Description with AI rephrasing suggestions
- Evidence upload (photos/videos)

**Mutations:**
- `api.disputes.createDispute`

#### ChatScreen (Dispute)
**File:** `src/screens/disputes/ChatScreen.tsx`

**Features:**
- Real-time messaging
- Message bubbles (own vs other)
- System messages
- Attachment support
- AI response suggestions
- Message rephrasing option

**Data Sources:**
- `api.messages.getMessages`

**Mutations:**
- `api.messages.sendMessage`

---

### Conversations (2 screens)

#### ConversationsListScreen
**File:** `src/screens/conversations/ConversationsListScreen.tsx`

**Features:**
- Pre-purchase chat list
- Product thumbnail
- Last message preview
- Unread indicators

**Data Sources:**
- `api.conversations.getUserConversations`

#### ConversationChatScreen
**File:** `src/screens/conversations/ConversationChatScreen.tsx`

**Features:**
- Chat with seller about product
- Product card header
- Real-time messaging
- Mark as read on view

**Data Sources:**
- `api.conversations.getConversation`
- `api.conversations.getConversationMessages`

**Mutations:**
- `api.conversations.sendConversationMessage`
- `api.conversations.markConversationRead`

---

### Profile & Settings (4 screens)

#### ProfileScreen
**File:** `src/screens/profile/ProfileScreen.tsx`

**Features:**
- User avatar and info
- Menu items:
  - Favorites (with count)
  - My Orders
  - My Disputes
  - Messages
  - Wallet
  - Notifications
  - Account Settings
  - Sign Out
- Animated menu items

#### EditProfileScreen
**File:** `src/screens/profile/EditProfileScreen.tsx`

**Features:**
- Avatar upload
- Name editing
- Phone number
- Address

**Mutations:**
- `api.users.updateProfile`

#### SettingsScreen
**File:** `src/screens/profile/SettingsScreen.tsx`

**Features:**
- Theme toggle (Light/Dark/System)
- Notification preferences
- Account settings
- About app

**Mutations:**
- `api.users.updateThemeMode`
- `api.users.updatePreferences`

#### SellerProfileScreen
**File:** `src/screens/profile/SellerProfileScreen.tsx`

**Features:**
- Public seller profile
- Rating and reviews
- Active listings
- Contact button

---

### Wallet (1 screen)

#### WalletScreen
**File:** `src/screens/wallet/WalletScreen.tsx`

**Features:**
- Balance display (available, pending)
- Earnings breakdown
- Transaction history
- Withdrawal options:
  - Mobile Money (MTN, Airtel, Zamtel)
  - Bank transfer
- Top-up wallet option

**Data Sources:**
- `api.wallet.getWallet`
- `api.wallet.getWalletTransactions`

---

### Notifications (1 screen)

#### NotificationsScreen
**File:** `src/screens/notifications/NotificationsScreen.tsx`

**Features:**
- Notification list
- Read/unread status
- Mark as read
- Clear all

**Data Sources:**
- `api.notifications.getUserNotifications`

**Mutations:**
- `api.notifications.markAsRead`
- `api.notifications.markAllAsRead`

---

## State Management

### AuthProvider

**File:** `src/context/AuthProvider.tsx`

```typescript
interface AuthContextType {
  isLoading: boolean;
  isSignedIn: boolean;
  user: User | null;              // Convex user document
  clerkUser: ClerkUserType | null; // Clerk user data
  signOut: () => Promise<void>;
}
```

**Responsibilities:**
- Syncs Clerk authentication with Convex database
- Auto-upserts user on sign-in
- Provides authentication state throughout app

**Usage:**
```typescript
import { useAppAuth } from '../context/AuthProvider';

function MyComponent() {
  const { user, isSignedIn, signOut } = useAppAuth();
  // ...
}
```

### ThemeProvider

**File:** `src/context/ThemeProvider.tsx`

```typescript
interface ThemeContextType {
  themeMode: 'light' | 'dark' | 'system';
  isDark: boolean;
  setThemeMode: (mode: ThemeMode) => void;
  toggleTheme: () => void;
  isSyncing: boolean;
}
```

**Responsibilities:**
- System theme detection
- Persistent local storage (AsyncStorage)
- Server sync via Convex

**Usage:**
```typescript
import { useAppTheme } from '../context/ThemeProvider';

function MyComponent() {
  const { isDark, toggleTheme } = useAppTheme();
  // ...
}
```

### ConvexClientProvider

**File:** `src/context/ConvexClientProvider.tsx`

Initializes Convex React client for real-time queries and mutations.

---

## Custom Hooks

### useAIRecommendations

**File:** `src/hooks/useAIRecommendations.ts`

```typescript
const {
  recommendations,  // Product[]
  isLoading,
  error,
  reasoning,        // AI explanation
  refetch
} = useAIRecommendations({ limit: 6, enabled: true });
```

### useSimilarProducts

```typescript
const {
  similarProducts,  // Product[]
  isLoading,
  error
} = useSimilarProducts({ productId: 'xxx', limit: 4 });
```

### usePayment

**File:** `src/hooks/usePayment.ts`

```typescript
const {
  isLoading,
  isPending,
  error,
  status,           // TransactionStatus
  paymentUrl,       // For card payments

  payWithMobileMoney({ orderId, amount, provider, mobileNumber }),
  payWithCard({ orderId, amount, email }),
  checkStatus(reference),
  verifyMobileAccount(phoneNumber, provider),
  resetState()
} = usePayment({ onSuccess, onError, onStatusChange });
```

**Helper Functions:**
- `formatZambianPhoneNumber(phone)` - Format to 260XXXXXXXXX
- `detectProvider(phone)` - Detect MTN/Airtel/Zamtel
- `getProviderName(provider)` - Human-readable name
- `getProviderColor(provider)` - Brand color

### useWallet

**File:** `src/hooks/useWallet.ts`

```typescript
const {
  balance,          // WalletBalance
  activity,         // WalletActivity
  transactions,     // WalletTransaction[]
  isLoading,
  error,

  refreshBalance(),
  refreshActivity(),
  withdrawToMobileMoney(amount, phone, provider),
  withdrawToBank(amount, bankCode, accountNumber, accountName),
  topUp(amount, method, ...),
  payWithWallet(orderId, amount),
  canPayWithWallet(amount),
  ensureWallet()
} = useWallet();
```

### useImageUpload

**File:** `src/hooks/useImageUpload.ts`

```typescript
const {
  images,           // UploadedImage[]
  isUploading,
  progress,         // 0-100

  pickImages(maxImages),
  pickFromCamera(),
  removeImage(index),
  clearImages(),
  uploadSingleImage(uri)
} = useImageUpload(initialImages);
```

**Features:**
- Image compression (1200px max, 80% quality)
- Multi-image upload to Convex storage
- Progress tracking

### useOrderTotal

**File:** `src/hooks/useOrderTotal.ts`

```typescript
const breakdown = useOrderTotal(displaySubtotal, shippingCost);
// Returns: OrderTotalBreakdown

// Helper functions:
calculateDisplayPrice(sellerPrice)   // Add 5% fee
calculateSellerPrice(displayPrice)   // Extract base
calculatePlatformFee(sellerPrice)    // Get fee amount
formatZMW(amount)                    // Format currency
```

### usePushNotifications

**File:** `src/hooks/usePushNotifications.ts`

```typescript
const {
  expoPushToken,
  notification,
  error,
  requestPermissions()
} = usePushNotifications(userId);

// Helpers:
sendLocalNotification(title, body, data)
scheduleNotification(title, body, trigger, data)
cancelAllNotifications()
getBadgeCount() / setBadgeCount(count)
```

---

## UI Components

### Header Components

**File:** `src/components/ui/Header.tsx`

```typescript
// Standard Header
<Header
  title="Screen Title"
  subtitle="Optional subtitle"
  variant="default|gradient|transparent|glass"
  size="compact|regular|large"
  showBackButton={true}
  onBackPress={() => navigation.goBack()}
  rightActions={[{ icon: 'cart', onPress: () => {} }]}
  showAIIndicator={true}
/>

// Tab Header (for main screens)
<TabHeader
  title="Home"
  greeting="Good morning"
  userName="John"
  showNotifications={true}
  notificationCount={5}
  onNotificationPress={() => {}}
  showCart={true}
  cartCount={3}
  onCartPress={() => {}}
/>

// Stack Header (for modal screens)
<StackHeader
  title="Product Details"
  onBackPress={() => navigation.goBack()}
/>
```

### AnimatedProductCard

**File:** `src/components/ui/AnimatedProductCard.tsx`

```typescript
<AnimatedProductCard
  product={product}
  index={0}                    // For staggered animation
  onPress={() => {}}
  onFavorite={() => {}}
  isFavorited={false}
/>
```

**Features:**
- Product image with placeholder
- Price (with 5% markup)
- Condition badge (color-coded)
- "New" badge (< 48 hours)
- Favorite button with spring animation
- Press animation

### AIAssistant

**File:** `src/components/ui/AIAssistant.tsx`

```typescript
// Floating Action Button
<AIAssistantFAB onPress={() => setModalVisible(true)} />

// Chat Modal
<AIAssistantModal
  visible={modalVisible}
  onClose={() => setModalVisible(false)}
  currentScreen="home"
  productId="optional"
  orderId="optional"
/>

// Insight Card (for displaying AI insights)
<AIInsightCard
  title="Recommendation"
  content="Based on your browsing..."
  icon="lightbulb"
/>
```

### Skeleton

**File:** `src/components/ui/Skeleton.tsx`

```typescript
<Skeleton width={100} height={20} />
<CategoryChipSkeleton />
<ListSkeleton />
```

---

## External Integrations

### 1. Clerk Authentication

**Package:** `@clerk/clerk-expo`

**Setup in App.tsx:**
```typescript
<ClerkProvider publishableKey={CLERK_KEY} tokenCache={tokenCache}>
  <ClerkLoaded>
    {/* App content */}
  </ClerkLoaded>
</ClerkProvider>
```

**Token Cache:** Uses `expo-secure-store` for secure token storage.

### 2. Convex Backend

**Package:** `convex`

**Queries Used:**
| Domain | Functions |
|--------|-----------|
| Users | `getUser`, `getUserByClerkId`, `upsertUser`, `updateProfile` |
| Products | `getProduct`, `searchProducts`, `createProduct`, `updateProduct` |
| Cart | `getCart`, `addToCart`, `updateCartQuantity`, `clearCart` |
| Orders | `getOrder`, `getBuyerOrders`, `createOrder` |
| Disputes | `getDispute`, `createDispute`, `getBuyerDisputes` |
| Wallet | `getWallet`, `getWalletTransactions` |
| Conversations | `getConversation`, `sendConversationMessage` |
| Categories | `getCategoriesTree`, `getCategory` |
| Favorites | `isFavorited`, `toggleFavorite`, `getUserFavorites` |
| Notifications | `getUserNotifications`, `markAsRead` |
| Storage | `generateUploadUrl`, `getUrl` |

### 3. NestJS API

**File:** `src/services/api.ts`

**Endpoints Used:**
- `POST /ai/recommendations` - Product recommendations
- `POST /ai/similar-products` - Similar products
- `POST /ai/rephrase-message` - Message analysis
- `POST /ai/analyze-dispute` - Dispute AI analysis
- `POST /ai/chat` - General chat
- `POST /payments/mobile-money` - Mobile money payment
- `POST /payments/card` - Card payment
- `GET /payments/status/:reference` - Payment status
- `POST /wallet/withdraw/*` - Withdrawals
- `POST /wallet/top-up` - Top-ups
- `POST /wallet/pay` - Pay with wallet

### 4. Push Notifications

**Package:** `expo-notifications`

**Android Channels:**
- `default` - General notifications
- `orders` - Order updates
- `disputes` - Dispute updates
- `messages` - New messages

---

## Theme System

**File:** `src/theme/index.ts`

### Color Palette

**Primary Colors:**
- Primary: `#0EA5E9` (Cyber Blue)
- Secondary: `#10B981` (Neon Green)
- Tertiary: `#A855F7` (Electric Purple)

**Light Theme:**
```typescript
{
  background: '#F8FAFC',
  surface: '#FFFFFF',
  onSurface: '#0F172A',
  outline: '#CBD5E1'
}
```

**Dark Theme:**
```typescript
{
  background: '#0A0F1A',
  surface: '#111827',
  onSurface: '#F1F5F9',
  outline: '#334155'
}
```

### Design Tokens

```typescript
designTokens = {
  radius: {
    xs: 4, sm: 8, md: 12, lg: 16, xl: 20, '2xl': 24, full: 9999
  },
  spacing: {
    xs: 4, sm: 8, md: 12, lg: 16, xl: 20, '2xl': 24, '3xl': 32, '4xl': 48
  },
  animation: {
    fast: 150, normal: 300, slow: 500, slower: 800
  },
  glow: {
    sm: { shadowRadius: 4, elevation: 4 },
    md: { shadowRadius: 8, elevation: 8 },
    lg: { shadowRadius: 16, elevation: 16 }
  },
  gradients: {
    primary: ['#0EA5E9', '#06B6D4'],
    secondary: ['#10B981', '#34D399'],
    ai: ['#0EA5E9', '#A855F7'],
    dark: ['#0A0F1A', '#1E293B']
  }
}
```

### Currency Formatting

```typescript
CURRENCY = {
  code: 'ZMW',
  symbol: 'K',
  locale: 'en-ZM'
}

formatPrice(1500) // → "K1,500.00"
```

---

## Type Definitions

**File:** `src/types/index.ts`

### Core Types

```typescript
// Re-exported from Convex
type User = Doc<'users'>;
type Product = Doc<'products'>;
type Order = Doc<'orders'>;
type Dispute = Doc<'disputes'>;
type Notification = Doc<'notifications'>;
// ... etc
```

### Extended Types

```typescript
interface ProductWithSeller extends Product {
  seller: UserPublic | null;
  category: Category | null;
  subcategory: Category | null;
}

interface OrderWithParties extends Order {
  buyer: { _id, firstName, lastName } | null;
  seller: { _id, firstName, lastName } | null;
}

interface DisputeWithDetails extends Dispute {
  order: Order | null;
  buyer: { _id, firstName, lastName } | null;
  seller: { _id, firstName, lastName } | null;
  moderator?: { _id, firstName, lastName } | null;
}
```

### Navigation Types

```typescript
type RootStackParamList = {
  Auth: undefined;
  Main: undefined;
  ProductDetail: { productId: string };
  CreateProduct: undefined;
  EditProduct: { productId: string };
  OrderDetail: { orderId: string };
  DisputeDetail: { disputeId: string };
  CreateDispute: { orderId: string };
  Chat: { disputeId: string };
  Cart: undefined;
  Checkout: undefined;
  Wallet: undefined;
  // ... more screens
};

type MainTabParamList = {
  Home: undefined;
  Browse: undefined;
  Sell: undefined;
  Orders: undefined;
  Profile: undefined;
};
```

---

## Key Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| react-native | 0.81.5 | Core framework |
| expo | ~54.0.0 | Development platform |
| @clerk/clerk-expo | 2.19.6 | Authentication |
| convex | 1.21.0 | Real-time backend |
| react-native-paper | 5.14.5 | UI components |
| @react-navigation/native | 7.1.22 | Navigation |
| react-native-reanimated | 4.1.5 | Animations |
| expo-image-picker | 17.0.8 | Image selection |
| expo-notifications | 0.32.13 | Push notifications |
| date-fns | 4.1.0 | Date formatting |

---

## Troubleshooting

### Common Issues

1. **Clerk authentication not working**
   - Verify `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` is set
   - Check Clerk dashboard for allowed origins

2. **Convex queries returning undefined**
   - Verify `EXPO_PUBLIC_CONVEX_URL` is correct
   - Check Convex deployment status
   - Ensure user is authenticated for protected queries

3. **Images not uploading**
   - Check Convex storage configuration
   - Verify `generateUploadUrl` mutation exists
   - Check image size limits

4. **Push notifications not working**
   - Request permissions first
   - Check Android notification channels
   - Verify Expo push token registration

5. **Payment status not updating**
   - Check API connectivity
   - Verify webhook configuration
   - Check Lenco dashboard for transaction status

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2024 | Initial release |
