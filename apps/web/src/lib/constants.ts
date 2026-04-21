// App constants
export const APP_NAME = "Gettitonline";
export const APP_DESCRIPTION =
  "A mobile-first online store for fashion, electronics, lifestyle products, and more";

// Currency
export const CURRENCY_CODE = "ZMW";
export const CURRENCY_SYMBOL = "K";
export const CURRENCY_LOCALE = "en-ZM";

// Platform fee
export const PLATFORM_FEE_PERCENTAGE = 0.05; // 5%

// Pagination
export const DEFAULT_PAGE_SIZE = 12;
export const PAGE_SIZE_OPTIONS = [12, 24, 48, 96];

// Image upload
export const MAX_IMAGES_PER_PRODUCT = 10;
export const MAX_IMAGE_SIZE_MB = 5;
export const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

// Product conditions display names
export const CONDITION_DISPLAY_NAMES: Record<string, string> = {
  new: "New",
  like_new: "Like New",
  good: "Good",
  fair: "Fair",
};

// Order status display names
export const ORDER_STATUS_DISPLAY_NAMES: Record<string, string> = {
  pending_payment: "Pending Payment",
  paid: "Paid",
  processing: "Processing",
  shipped: "Shipped",
  delivered: "Delivered",
  completed: "Completed",
  cancelled: "Cancelled",
  disputed: "Disputed",
};

// Dispute status display names
export const DISPUTE_STATUS_DISPLAY_NAMES: Record<string, string> = {
  open: "Open",
  in_discussion: "In Discussion",
  moderator_review: "Under Review",
  resolved: "Resolved",
  closed: "Closed",
};

// Dispute category display names
export const DISPUTE_CATEGORY_DISPLAY_NAMES: Record<string, string> = {
  not_received: "Item Not Received",
  defective: "Defective Item",
  not_as_described: "Not as Described",
  other: "Other",
};

// Escrow status display names
export const ESCROW_STATUS_DISPLAY_NAMES: Record<string, string> = {
  held: "Held",
  released: "Released",
  refunded: "Refunded",
  partially_refunded: "Partially Refunded",
  disputed: "Disputed",
};

// Mobile money providers
export const MOBILE_MONEY_PROVIDERS = [
  { id: "mtn", name: "MTN Mobile Money", color: "#FFCC00" },
  { id: "airtel", name: "Airtel Money", color: "#ED1C24" },
  { id: "zamtel", name: "Zamtel Kwacha", color: "#00A651" },
] as const;

// Zambian provinces
export const ZAMBIAN_PROVINCES = [
  "Central",
  "Copperbelt",
  "Eastern",
  "Luapula",
  "Lusaka",
  "Muchinga",
  "Northern",
  "North-Western",
  "Southern",
  "Western",
] as const;

// Routes
export const ROUTES = {
  // Public
  HOME: "/",
  BROWSE: "/browse",
  SEARCH: "/search",
  PRODUCT: (id: string) => `/product/${id}`,
  SELLER: (id: string) => `/seller/${id}`,
  CATEGORY: (slug: string) => `/browse/${slug}`,

  // Auth
  SIGN_IN: "/sign-in",
  SIGN_UP: "/sign-up",
  FORGOT_PASSWORD: "/forgot-password",

  // Protected - Shopping
  CART: "/cart",
  CHECKOUT: "/checkout",
  ORDERS: "/orders",
  ORDER: (id: string) => `/orders/${id}`,
  ORDER_DETAIL: (id: string) => `/orders/${id}`,

  // Protected - Selling
  SELL: "/sell",
  SELLER_ORDERS: "/sell/orders",
  CREATE_LISTING: "/sell/new",
  EDIT_LISTING: (id: string) => `/sell/${id}/edit`,
  CREATE_PRODUCT: "/sell/new",
  EDIT_PRODUCT: (id: string) => `/sell/${id}/edit`,

  // Protected - Communication
  MESSAGES: "/messages",
  CONVERSATION: (id: string) => `/messages/${id}`,

  // Protected - Disputes
  DISPUTES: "/disputes",
  DISPUTE_DETAIL: (id: string) => `/disputes/${id}`,
  CREATE_DISPUTE: (orderId: string) => `/disputes/new?orderId=${orderId}`,

  // Protected - Account
  WALLET: "/wallet",
  FAVORITES: "/favorites",
  NOTIFICATIONS: "/notifications",
  PROFILE: "/profile",
  EDIT_PROFILE: "/profile/edit",
  SETTINGS: "/settings",

  // Admin
  ADMIN_DASHBOARD: "/admin",
  ADMIN_USERS: "/admin/users",
  ADMIN_VENDOR_APPLICATIONS: "/admin/vendors",
  ADMIN_USER_DETAIL: (id: string) => `/admin/users/${id}`,
  ADMIN_PRODUCTS: "/admin/products",
  ADMIN_LISTING_REVIEW: "/admin/products/review",
  ADMIN_ORDERS: "/admin/orders",
  ADMIN_CATEGORIES: "/admin/categories",
  ADMIN_DISPUTES: "/admin/disputes",
  ADMIN_TRANSACTIONS: "/admin/transactions",
  ADMIN_ESCROW: "/admin/escrow",
  ADMIN_ANALYTICS: "/admin/analytics",
  ADMIN_REPORTS: "/admin/reports",
  ADMIN_SETTINGS: "/admin/settings",
} as const;
