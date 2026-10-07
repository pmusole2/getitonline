import { z } from "zod";

export const PromotionBannerPlacementSchema = z.enum([
  "home_hero",
  "home_monthly",
  "home_strip",
  "category",
  "pdp",
]);
export type PromotionBannerPlacement = z.infer<
  typeof PromotionBannerPlacementSchema
>;

export const PromotionTypeSchema = z.enum([
  "deal_of_day",
  "flash_sale",
  "weekend_sale",
  "sponsored_product",
  "seller_campaign",
]);
export type PromotionType = z.infer<typeof PromotionTypeSchema>;

export const PromoDiscountTypeSchema = z.enum([
  "percent",
  "fixed_amount",
  "compare_at",
]);
export type PromoDiscountType = z.infer<typeof PromoDiscountTypeSchema>;

export const PromotionBannerSchema = z.object({
  _id: z.string(),
  title: z.string(),
  subtitle: z.string().optional().nullable(),
  imageUrl: z.string().url(),
  targetUrl: z.string().optional().nullable(),
  placement: PromotionBannerPlacementSchema,
  categoryId: z.string().optional().nullable(),
  startsAt: z.number(),
  endsAt: z.number().optional().nullable(),
  isActive: z.boolean(),
  sortOrder: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type PromotionBanner = z.infer<typeof PromotionBannerSchema>;

export const PromotionSchema = z.object({
  _id: z.string(),
  name: z.string(),
  type: PromotionTypeSchema,
  sellerId: z.string().optional().nullable(),
  categoryId: z.string().optional().nullable(),
  productIds: z.array(z.string()),
  discountType: PromoDiscountTypeSchema,
  discountValue: z.number().optional().nullable(),
  startsAt: z.number(),
  endsAt: z.number().optional().nullable(),
  isActive: z.boolean(),
  priority: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Promotion = z.infer<typeof PromotionSchema>;

export const PromoCodeScopeSchema = z.enum([
  "platform",
  "seller",
  "category",
  "product",
]);
export type PromoCodeScope = z.infer<typeof PromoCodeScopeSchema>;

export const PromoCodeSchema = z.object({
  _id: z.string(),
  code: z.string(),
  title: z.string(),
  description: z.string().optional().nullable(),
  scope: PromoCodeScopeSchema,
  sellerId: z.string().optional().nullable(),
  categoryId: z.string().optional().nullable(),
  productId: z.string().optional().nullable(),
  discountType: z.enum(["percent", "fixed_amount"]),
  discountValue: z.number(),
  minimumSubtotal: z.number().optional().nullable(),
  maxDiscount: z.number().optional().nullable(),
  usageLimit: z.number().optional().nullable(),
  perUserLimit: z.number().optional().nullable(),
  startsAt: z.number(),
  endsAt: z.number().optional().nullable(),
  isActive: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type PromoCode = z.infer<typeof PromoCodeSchema>;

export const PromoValidationResultSchema = z.discriminatedUnion("valid", [
  z.object({
    valid: z.literal(false),
    reason: z.string(),
  }),
  z.object({
    valid: z.literal(true),
    promoCodeId: z.string(),
    code: z.string(),
    title: z.string(),
    discountAmount: z.number(),
    totalAfterDiscount: z.number(),
  }),
]);
export type PromoValidationResult = z.infer<typeof PromoValidationResultSchema>;
