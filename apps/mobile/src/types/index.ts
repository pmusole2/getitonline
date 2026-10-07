import type { NavigatorScreenParams } from '@react-navigation/native';
import type { Doc, Id } from '../../../../convex/_generated/dataModel';

// Re-export Convex types for direct use
export type { Doc, Id };

// Document types from Convex schema
export type User = Doc<'users'>;
export type Category = Doc<'categories'>;
export type Product = Doc<'products'>;
export type VendorProfile = Doc<'vendorProfiles'>;
export type CartItem = Doc<'cartItems'>;
export type Order = Doc<'orders'>;
export type Escrow = Doc<'escrow'>;
export type Dispute = Doc<'disputes'>;
export type Message = Doc<'messages'>;
export type Favorite = Doc<'favorites'>;
export type Review = Doc<'reviews'>;
export type Notification = Doc<'notifications'>;
export type Transaction = Doc<'transactions'>;

// Enum types derived from schema
export type UserRole = User['role'];
export type ProductCondition = Product['condition'];
export type ProductStatus = Product['status'];
export type OrderStatus = Order['status'];
export type EscrowStatus = Escrow['status'];
export type DisputeStatus = Dispute['status'];
export type DisputeCategory = Dispute['category'];
export type NotificationType = Notification['type'];
export type VendorStatus = VendorProfile['status'];
export type TransactionStatus = Transaction['status'];
export type TransactionType = Transaction['type'];
export type PaymentMethod = Transaction['paymentMethod'];

// Extended types for API responses with related data
export interface UserPublic {
  _id: Id<'users'>;
  firstName: string;
  lastName: string;
  displayName?: string;
  avatar?: string;
  rating?: number;
  totalSales: number;
  isCompanyStore?: boolean;
  isVendorStore?: boolean;
  bannerUrl?: string;
  slug?: string;
  vendorStatus?: 'pending' | 'approved' | 'changes_requested' | 'suspended';
}

export interface ProductWithSeller extends Product {
  seller: UserPublic | null;
  category: Category | null;
  subcategory: Category | null;
}

export interface CategoryWithOptionalSubcategories extends Category {
  subcategories?: Category[];
}

export interface OrderWithParties extends Order {
  buyer: {
    _id: Id<'users'>;
    firstName: string;
    lastName: string;
  } | null;
  seller: {
    _id: Id<'users'>;
    firstName: string;
    lastName: string;
  } | null;
}

export interface MessageWithSender extends Message {
  sender: {
    _id: Id<'users'>;
    firstName: string;
    lastName: string;
    avatar?: string;
    role: UserRole;
  } | null;
}

// Return type from getCategoriesTree - category with embedded subcategories
export interface CategoryTreeChild extends Category {
  classifications?: Category[];
}

export interface CategoryTreeItem extends Category {
  subcategories: CategoryTreeChild[];
}

// Return type from getCategoryWithSubcategories
export interface CategoryWithSubcategories extends Category {
  subcategories: Category[];
}

// Return type from getProductsByCategory
export interface ProductsPaginatedResponse {
  items: Product[];
  hasMore: boolean;
  nextCursor: Id<'products'> | null;
}

export interface DisputeWithDetails extends Dispute {
  order: Order | null;
  buyer: {
    _id: Id<'users'>;
    firstName: string;
    lastName: string;
  } | null;
  seller: {
    _id: Id<'users'>;
    firstName: string;
    lastName: string;
  } | null;
  moderator?: {
    _id: Id<'users'>;
    firstName: string;
    lastName: string;
  } | null;
}

export interface ReviewWithReviewer extends Review {
  reviewer: {
    _id: Id<'users'>;
    firstName: string;
    lastName: string;
    avatar?: string;
  } | null;
}

export interface CartItemWithProduct extends CartItem {
  product: Product | null;
}

export interface StorefrontDirectoryItem {
  sellerId: Id<'users'>;
  displayName: string;
  description: string;
  logoUrl?: string;
  bannerUrl?: string;
  slug: string;
  isCompanyStore: boolean;
  rating?: number;
  totalSales: number;
}

export interface AdminVendorStoreItem {
  vendorProfileId: Id<'vendorProfiles'>;
  ownerUserId: Id<'users'>;
  ownerName: string;
  ownerEmail: string;
  storeName: string;
  description: string;
  logoUrl?: string;
  bannerUrl?: string;
  status: VendorStatus;
  reviewNotes?: string;
  reviewedAt?: number;
  contactEmail: string;
  contactPhone?: string;
  address: {
    street: string;
    city: string;
    province: string;
    country: string;
  };
  slug: string;
}

export interface AdminVendorStoreCounts {
  all: number;
  pending: number;
  approved: number;
  changes_requested: number;
  suspended: number;
}

export interface AdminOrderListItem {
  _id: Id<'orders'>;
  orderNumber: string;
  buyerId: Id<'users'>;
  sellerId: Id<'users'>;
  status: OrderStatus;
  totalAmount: number;
  subtotal: number;
  shippingCost: number;
  platformFee: number;
  createdAt: number;
  updatedAt: number;
  buyerName: string;
  buyerEmail: string;
  sellerName: string;
  sellerEmail: string;
  sellerDisplayName: string;
  isCompanyStore: boolean;
  shippingLocation: string;
  itemCount: number;
  itemPreview: string;
  escrowId?: Id<'escrow'>;
  escrowStatus?: EscrowStatus;
  disputeId?: Id<'disputes'>;
  disputeStatus?: DisputeStatus;
}

export interface AdminOrderCounts {
  all: number;
  pending_payment: number;
  paid: number;
  processing: number;
  shipped: number;
  delivered: number;
  completed: number;
  cancelled: number;
  disputed: number;
}

export interface AdminEscrowListItem {
  _id: Id<'escrow'>;
  orderId: Id<'orders'>;
  orderNumber: string;
  orderStatus?: OrderStatus;
  buyerId: Id<'users'>;
  buyerName: string;
  buyerEmail: string;
  sellerId: Id<'users'>;
  sellerName: string;
  sellerEmail: string;
  sellerDisplayName: string;
  isCompanyStore: boolean;
  status: EscrowStatus;
  grossAmount: number;
  sellerAmount: number;
  platformFee: number;
  refundAmount?: number;
  shippingLocation?: string;
  createdAt: number;
  updatedAt: number;
  releasedAt?: number;
  disputeId?: Id<'disputes'>;
  disputeStatus?: DisputeStatus;
}

export interface AdminEscrowCounts {
  all: number;
  held: number;
  released: number;
  refunded: number;
  partially_refunded: number;
  disputed: number;
}

export interface AdminTransactionListItem {
  _id: Id<'transactions'>;
  reference: string;
  orderId?: Id<'orders'>;
  orderNumber?: string;
  orderStatus?: OrderStatus;
  userId: Id<'users'>;
  userName: string;
  userEmail: string;
  type: TransactionType;
  paymentMethod: PaymentMethod;
  mobileMoneyProvider?: Transaction['mobileMoneyProvider'];
  amount: number;
  platformFee?: number;
  gatewayFee?: number;
  netAmount?: number;
  sellerPayout?: number;
  currency: string;
  status: TransactionStatus;
  description: string;
  initiatedAt: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  isTopUp: boolean;
}

export interface AdminTransactionCounts {
  all: number;
  pending: number;
  processing: number;
  successful: number;
  failed: number;
  cancelled: number;
  refunded: number;
}

export interface AdminTransactionTypeCounts {
  all: number;
  collection: number;
  transfer: number;
  refund: number;
}

// Navigation types
export type RootStackParamList = {
  Auth: NavigatorScreenParams<AuthStackParamList> | undefined;
  Main: undefined;
  ProductDetail: { productId: string };
  Sell: undefined;
  CreateProduct: undefined;
  EditProduct: { productId: string };
  OrderDetail: { orderId: string };
  DisputeDetail: { disputeId: string };
  CreateDispute: { orderId: string };
  Chat: { disputeId: string };
  SellerProfile: { sellerId: string };
  StoresDirectory: undefined;
  Workspace: undefined;
  Favorites: undefined;
  AdminDashboard: undefined;
  AdminOrders: undefined;
  AdminEscrow: undefined;
  AdminTransactions: undefined;
  AdminCategories: undefined;
  AdminUsers: undefined;
  AdminDelivery: undefined;
  AdminPromotions: undefined;
  SellerOperations: undefined;
  ListingReview: undefined;
  Search: { query?: string; categoryId?: string; brand?: string; imageUri?: string; imageDataUrl?: string };
  CategoryProducts: { categoryId: string; categoryName: string };
  Cart: undefined;
  Checkout: undefined;
  AdminStores: undefined;
  Settings: undefined;
  EditProfile: undefined;
  Notifications: undefined;
  // Conversations (pre-purchase messaging)
  Conversations: undefined;
  ConversationChat: { conversationId: string; productId?: string };
  // Disputes list
  Disputes: undefined;
  // Wallet
  Wallet: undefined;
  WalletTransactions: undefined;
};

export type MainTabParamList = {
  Home: undefined;
  Browse: undefined;
  Favorites: undefined;
  Orders: undefined;
  Profile: undefined;
};

export type AuthStackParamList = {
  Welcome: undefined;
  SignIn: undefined;
  SignUp: undefined;
};

// Helper type for theme
export type AppTheme = {
  colors: {
    primary: string;
    primaryContainer: string;
    secondary: string;
    secondaryContainer: string;
    tertiary: string;
    tertiaryContainer: string;
    surface: string;
    surfaceVariant: string;
    background: string;
    error: string;
    errorContainer: string;
    onPrimary: string;
    onPrimaryContainer: string;
    onSecondary: string;
    onSecondaryContainer: string;
    onTertiary: string;
    onTertiaryContainer: string;
    onSurface: string;
    onSurfaceVariant: string;
    onError: string;
    onErrorContainer: string;
    outline: string;
    outlineVariant: string;
    inverseSurface: string;
    inverseOnSurface: string;
    inversePrimary: string;
    shadow: string;
    scrim: string;
    backdrop: string;
  };
};
