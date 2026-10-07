import { Id } from "../../../../convex/_generated/dataModel";

// Re-export types from shared package
export type {
  User,
  Product,
  VendorProfile,
  Order,
  CartItem,
  Category,
  Escrow,
  Dispute,
  Message,
  Notification,
  Review,
} from "@gettitonline/shared";

// Convex ID types
export type UserId = Id<"users">;
export type ProductId = Id<"products">;
export type OrderId = Id<"orders">;
export type CategoryId = Id<"categories">;
export type DisputeId = Id<"disputes">;
export type EscrowId = Id<"escrow">;
export type WalletId = Id<"wallets">;
export type TransactionId = Id<"transactions">;
export type ConversationId = Id<"conversations">;

// User roles
export type UserRole = "user" | "catalog_manager" | "moderator" | "admin";

export type VendorStatus =
  | "pending"
  | "approved"
  | "changes_requested"
  | "suspended";

// Product status
export type ProductStatus =
  | "draft"
  | "pending_review"
  | "changes_requested"
  | "rejected"
  | "active"
  | "sold"
  | "suspended";

// Product condition
export type ProductCondition = "new" | "like_new" | "good" | "fair";

// Order status
export type OrderStatus =
  | "pending_payment"
  | "paid"
  | "processing"
  | "shipped"
  | "delivered"
  | "completed"
  | "cancelled"
  | "disputed";

// Dispute status
export type DisputeStatus =
  | "open"
  | "in_discussion"
  | "moderator_review"
  | "resolved"
  | "closed";

// Dispute category
export type DisputeCategory =
  | "not_received"
  | "defective"
  | "not_as_described"
  | "other";

// Escrow status
export type EscrowStatus =
  | "held"
  | "released"
  | "refunded"
  | "partially_refunded"
  | "disputed";

// Payment method
export type PaymentMethod = "mobile_money" | "card" | "wallet";

// Mobile money provider
export type MobileMoneyProvider = "mtn" | "airtel" | "zamtel";

// Navigation types
export interface NavItem {
  title: string;
  href: string;
  icon?: React.ComponentType<{ className?: string }>;
  badge?: number;
  disabled?: boolean;
}

export interface NavSection {
  title: string;
  items: NavItem[];
}

// Table types
export interface DataTableColumn<T> {
  key: keyof T | string;
  title: string;
  sortable?: boolean;
  render?: (item: T) => React.ReactNode;
}

// Pagination types
export interface PaginationState {
  page: number;
  pageSize: number;
  total: number;
}

// Filter types
export interface FilterState {
  search?: string;
  category?: string;
  status?: string;
  dateRange?: {
    from: Date;
    to: Date;
  };
  priceRange?: {
    min: number;
    max: number;
  };
  condition?: ProductCondition[];
  sortBy?: string;
  sortOrder?: "asc" | "desc";
}
