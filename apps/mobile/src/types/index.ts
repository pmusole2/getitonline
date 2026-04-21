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

// Enum types derived from schema
export type UserRole = User['role'];
export type ProductCondition = Product['condition'];
export type ProductStatus = Product['status'];
export type OrderStatus = Order['status'];
export type EscrowStatus = Escrow['status'];
export type DisputeStatus = Dispute['status'];
export type DisputeCategory = Dispute['category'];
export type NotificationType = Notification['type'];

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
export interface CategoryTreeItem extends Category {
  subcategories: Category[];
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

// Navigation types
export type RootStackParamList = {
  Auth: NavigatorScreenParams<AuthStackParamList> | undefined;
  Main: undefined;
  ProductDetail: { productId: string };
  CreateProduct: undefined;
  EditProduct: { productId: string };
  OrderDetail: { orderId: string };
  DisputeDetail: { disputeId: string };
  CreateDispute: { orderId: string };
  Chat: { disputeId: string };
  SellerProfile: { sellerId: string };
  Search: { query?: string; categoryId?: string };
  CategoryProducts: { categoryId: string; categoryName: string };
  Cart: undefined;
  Checkout: undefined;
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
  Sell: undefined;
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
