import { z } from "zod";
import {
  SelectedAddOnSchema,
  SelectedVariantOptionSchema,
  SelectedVariantSchema,
} from "./cart.schema";
import { AddressSchema } from "./user.schema";

// Order status
export const OrderStatusSchema = z.enum([
  "pending_payment",
  "paid",
  "processing",
  "shipped",
  "delivered",
  "completed",
  "cancelled",
  "disputed",
]);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

// Shipping address with phone
export const ShippingAddressSchema = AddressSchema.extend({
  phone: z.string().regex(/^\+?[0-9]{10,15}$/, "Invalid phone number"),
});
export type ShippingAddress = z.infer<typeof ShippingAddressSchema>;

// Order item
export const OrderItemSchema = z.object({
  productId: z.string(),
  title: z.string(),
  price: z.number(),
  quantity: z.number().int().positive(),
  image: z.string(),
  selectedVariantOptions: z.array(SelectedVariantOptionSchema).optional(),
  selectedVariant: SelectedVariantSchema.optional(),
  selectedAddOns: z.array(SelectedAddOnSchema).optional(),
  customizationKey: z.string().optional(),
});
export type OrderItem = z.infer<typeof OrderItemSchema>;

// Create order
export const CreateOrderSchema = z.object({
  sellerId: z.string().min(1, "Seller ID is required"),
  items: z.array(OrderItemSchema).min(1, "At least one item is required"),
  subtotal: z.number().positive(),
  discountAmount: z.number().min(0).optional(),
  promoCodeId: z.string().optional(),
  promoCode: z.string().optional(),
  shippingCost: z.number().min(0),
  deliveryMethodId: z.string().optional(),
  deliveryMethodName: z.string().optional(),
  deliveryEta: z
    .object({
      minDays: z.number().int().nonnegative(),
      maxDays: z.number().int().nonnegative(),
    })
    .optional(),
  pickupPointId: z.string().optional(),
  totalAmount: z.number().positive(),
  shippingAddress: ShippingAddressSchema,
});
export type CreateOrder = z.infer<typeof CreateOrderSchema>;

// Update order status
export const UpdateOrderStatusSchema = z.object({
  orderId: z.string().min(1, "Order ID is required"),
  status: OrderStatusSchema,
});
export type UpdateOrderStatus = z.infer<typeof UpdateOrderStatusSchema>;

// Add tracking info
export const AddTrackingInfoSchema = z.object({
  orderId: z.string().min(1, "Order ID is required"),
  trackingNumber: z.string().min(1, "Tracking number is required"),
  shippingCarrier: z.string().optional(),
});
export type AddTrackingInfo = z.infer<typeof AddTrackingInfoSchema>;

// Order output
export const OrderSchema = z.object({
  _id: z.string(),
  orderNumber: z.string(),
  buyerId: z.string(),
  sellerId: z.string(),
  items: z.array(OrderItemSchema),
  subtotal: z.number(),
  discountAmount: z.number().optional().nullable(),
  promoCodeId: z.string().optional().nullable(),
  promoCode: z.string().optional().nullable(),
  shippingCost: z.number(),
  platformFee: z.number().optional(),
  sellerPayout: z.number().optional(),
  deliveryMethodId: z.string().optional().nullable(),
  deliveryMethodName: z.string().optional().nullable(),
  deliveryEta: z
    .object({
      minDays: z.number(),
      maxDays: z.number(),
    })
    .optional()
    .nullable(),
  pickupPointId: z.string().optional().nullable(),
  totalAmount: z.number(),
  shippingAddress: ShippingAddressSchema,
  status: OrderStatusSchema,
  trackingNumber: z.string().optional().nullable(),
  shippingCarrier: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Order = z.infer<typeof OrderSchema>;

// Order with user info
export const OrderWithUsersSchema = OrderSchema.extend({
  buyer: z
    .object({
      _id: z.string(),
      firstName: z.string(),
      lastName: z.string(),
    })
    .nullable(),
  seller: z
    .object({
      _id: z.string(),
      firstName: z.string(),
      lastName: z.string(),
    })
    .nullable(),
});
export type OrderWithUsers = z.infer<typeof OrderWithUsersSchema>;
