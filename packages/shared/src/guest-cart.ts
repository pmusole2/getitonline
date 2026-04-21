import { z } from "zod";
import { SelectedShippingSchema } from "./schemas/cart.schema";
import {
  ProductStatusSchema,
  ShippingOptionSchema,
} from "./schemas/product.schema";

export const GETTITONLINE_GUEST_CART_STORAGE_KEY =
  "gettitonline_guest_cart_v1";

export const GuestCartProductSnapshotSchema = z.object({
  _id: z.string().min(1, "Product ID is required"),
  sellerId: z.string().min(1, "Seller ID is required"),
  sellerName: z.string().min(1, "Seller name is required"),
  title: z.string().min(1, "Product title is required"),
  price: z.number().min(0, "Product price cannot be negative"),
  images: z.array(z.string()),
  quantity: z.number().int().nonnegative(),
  status: ProductStatusSchema,
  shippingOptions: z.array(ShippingOptionSchema),
});
export type GuestCartProductSnapshot = z.infer<
  typeof GuestCartProductSnapshotSchema
>;

export const GuestCartItemSchema = z.object({
  productId: z.string().min(1, "Product ID is required"),
  quantity: z.number().int().positive("Quantity must be at least 1"),
  selectedShipping: SelectedShippingSchema,
  product: GuestCartProductSnapshotSchema,
  addedAt: z.number(),
});
export type GuestCartItem = z.infer<typeof GuestCartItemSchema>;

export const GuestCartItemArraySchema = z.array(GuestCartItemSchema);

export const GuestCartSummarySchema = z.object({
  items: GuestCartItemArraySchema,
  subtotal: z.number(),
  shippingTotal: z.number(),
  total: z.number(),
  itemCount: z.number(),
});
export type GuestCartSummary = z.infer<typeof GuestCartSummarySchema>;

export const MergeGuestCartSkipReasonSchema = z.enum([
  "product_missing",
  "inactive",
  "seller_owned",
  "out_of_stock",
]);
export type MergeGuestCartSkipReason = z.infer<
  typeof MergeGuestCartSkipReasonSchema
>;

export const MergeGuestCartSkippedItemSchema = z.object({
  productId: z.string().min(1, "Product ID is required"),
  reason: MergeGuestCartSkipReasonSchema,
});
export type MergeGuestCartSkippedItem = z.infer<
  typeof MergeGuestCartSkippedItemSchema
>;

export const MergeGuestCartResultSchema = z.object({
  mergedCount: z.number().int().nonnegative(),
  skipped: z.array(MergeGuestCartSkippedItemSchema),
});
export type MergeGuestCartResult = z.infer<typeof MergeGuestCartResultSchema>;

export function calculateGuestCartSummary(
  items: GuestCartItem[]
): GuestCartSummary {
  const subtotal = items.reduce(
    (sum, item) => sum + item.product.price * item.quantity,
    0
  );
  const shippingTotal = items.reduce(
    (sum, item) => sum + item.selectedShipping.price,
    0
  );

  return {
    items,
    subtotal,
    shippingTotal,
    total: subtotal + shippingTotal,
    itemCount: items.length,
  };
}

export function getMergeGuestCartSkipReasonMessage(
  reason: MergeGuestCartSkipReason
): string {
  switch (reason) {
    case "product_missing":
      return "Product no longer exists";
    case "inactive":
      return "Product is no longer available";
    case "seller_owned":
      return "You cannot add your own product";
    case "out_of_stock":
      return "Product is out of stock";
    default:
      return "Product could not be merged";
  }
}
