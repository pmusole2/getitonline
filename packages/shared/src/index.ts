// Schemas
export * from "./schemas";
export * from "./guest-cart";

// Utils
export * from "./utils";

// Constants
export const APP_NAME = "Gettitonline";
export const DEFAULT_CURRENCY = "ZMW";
export const DEFAULT_COUNTRY = "Zambia";

// Product conditions display names
export const CONDITION_DISPLAY_NAMES = {
  new: "New",
  like_new: "Like New",
  good: "Good",
  fair: "Fair",
} as const;

// Order status display names
export const ORDER_STATUS_DISPLAY_NAMES = {
  pending_payment: "Pending Payment",
  paid: "Paid",
  processing: "Processing",
  shipped: "Shipped",
  delivered: "Delivered",
  completed: "Completed",
  cancelled: "Cancelled",
  disputed: "Disputed",
} as const;

// Dispute status display names
export const DISPUTE_STATUS_DISPLAY_NAMES = {
  open: "Open",
  in_discussion: "In Discussion",
  moderator_review: "Under Review",
  resolved: "Resolved",
  closed: "Closed",
} as const;

// Dispute category display names
export const DISPUTE_CATEGORY_DISPLAY_NAMES = {
  not_received: "Item Not Received",
  defective: "Item Defective",
  not_as_described: "Not As Described",
  other: "Other",
} as const;

// Escrow status display names
export const ESCROW_STATUS_DISPLAY_NAMES = {
  held: "Held in Escrow",
  released: "Released",
  refunded: "Refunded",
  partially_refunded: "Partially Refunded",
  disputed: "Disputed",
} as const;

// Resolution type display names
export const RESOLUTION_TYPE_DISPLAY_NAMES = {
  full_refund: "Full Refund",
  partial_refund: "Partial Refund",
  no_refund: "No Refund",
  mutual_agreement: "Mutual Agreement",
} as const;
