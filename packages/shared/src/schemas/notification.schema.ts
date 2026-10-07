import { z } from "zod";

// Notification type
export const NotificationTypeSchema = z.enum([
  "order_placed",
  "order_status_update",
  "new_message",
  "dispute_update",
  "funds_released",
  "new_review",
  "product_sold",
  "payment_received",
  "payment_failed",
  "wallet_credit",
  "wallet_debit",
  "withdrawal_initiated",
  "withdrawal_completed",
  "withdrawal_failed",
  "product_submitted",
  "listing_approved",
  "listing_rejected",
  "listing_changes_requested",
  "low_stock",
  "cart_reminder",
  "price_drop",
  "product_recommendation",
  "scarcity_alert",
  "promo_code",
  "flash_sale",
  "delivery_update",
  "return_update",
  "system",
]);
export type NotificationType = z.infer<typeof NotificationTypeSchema>;

// Create notification
export const CreateNotificationSchema = z.object({
  userId: z.string().min(1, "User ID is required"),
  type: NotificationTypeSchema,
  title: z.string().min(1, "Title is required").max(100),
  message: z.string().min(1, "Message is required").max(500),
  data: z.record(z.any()).optional(),
});
export type CreateNotification = z.infer<typeof CreateNotificationSchema>;

// Notification output
export const NotificationSchema = z.object({
  _id: z.string(),
  userId: z.string(),
  type: NotificationTypeSchema,
  title: z.string(),
  message: z.string(),
  data: z.any().optional().nullable(),
  isRead: z.boolean(),
  createdAt: z.number(),
});
export type Notification = z.infer<typeof NotificationSchema>;
