import { z } from "zod";

export const DeliveryMethodTypeSchema = z.enum([
  "standard",
  "express",
  "same_day",
  "pickup",
]);
export type DeliveryMethodType = z.infer<typeof DeliveryMethodTypeSchema>;

export const DeliveryZoneSchema = z.object({
  _id: z.string(),
  name: z.string(),
  slug: z.string(),
  province: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  postalCodePattern: z.string().optional().nullable(),
  isActive: z.boolean(),
  sortOrder: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type DeliveryZone = z.infer<typeof DeliveryZoneSchema>;

export const DeliveryMethodSchema = z.object({
  _id: z.string(),
  zoneId: z.string().optional().nullable(),
  name: z.string(),
  code: z.string(),
  type: DeliveryMethodTypeSchema,
  baseFee: z.number().min(0),
  perKgFee: z.number().min(0).optional().nullable(),
  freeAboveSubtotal: z.number().min(0).optional().nullable(),
  minDays: z.number().int().nonnegative(),
  maxDays: z.number().int().nonnegative(),
  courierName: z.string().optional().nullable(),
  isActive: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type DeliveryMethod = z.infer<typeof DeliveryMethodSchema>;

export const DeliveryQuoteSchema = z.object({
  methodId: z.string(),
  name: z.string(),
  code: z.string(),
  type: DeliveryMethodTypeSchema,
  fee: z.number().min(0),
  minDays: z.number().int().nonnegative(),
  maxDays: z.number().int().nonnegative(),
  courierName: z.string().optional().nullable(),
});
export type DeliveryQuote = z.infer<typeof DeliveryQuoteSchema>;

export const TrackingEventStatusSchema = z.enum([
  "order_placed",
  "payment_confirmed",
  "processing",
  "ready_for_pickup",
  "picked_up",
  "in_transit",
  "out_for_delivery",
  "delivered",
  "delivery_failed",
  "return_requested",
  "return_received",
  "refunded",
]);
export type TrackingEventStatus = z.infer<typeof TrackingEventStatusSchema>;

export const ReturnRequestStatusSchema = z.enum([
  "requested",
  "approved",
  "rejected",
  "in_transit",
  "received",
  "refunded",
  "closed",
]);
export type ReturnRequestStatus = z.infer<typeof ReturnRequestStatusSchema>;
