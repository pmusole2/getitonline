import { z } from "zod";

// Product condition
export const ProductConditionSchema = z.enum(["new", "like_new", "good", "fair"]);
export type ProductCondition = z.infer<typeof ProductConditionSchema>;

// Product status
export const ProductStatusSchema = z.enum([
  "draft",
  "pending_review",
  "changes_requested",
  "active",
  "sold",
  "suspended",
]);
export type ProductStatus = z.infer<typeof ProductStatusSchema>;

export const AiModerationStatusSchema = z.enum(["clear", "flagged", "error"]);
export type AiModerationStatus = z.infer<typeof AiModerationStatusSchema>;

// Product specification
export const SpecificationSchema = z.object({
  key: z.string().min(1, "Key is required"),
  value: z.string().min(1, "Value is required"),
});
export type Specification = z.infer<typeof SpecificationSchema>;

// Product location
export const ProductLocationSchema = z.object({
  city: z.string().min(1, "City is required"),
  province: z.string().min(1, "Province is required"),
});
export type ProductLocation = z.infer<typeof ProductLocationSchema>;

// Shipping option
export const ShippingOptionSchema = z.object({
  name: z.string().min(1, "Shipping name is required"),
  price: z.number().min(0, "Shipping price must be positive"),
  estimatedDays: z.string().min(1, "Estimated days is required"),
});
export type ShippingOption = z.infer<typeof ShippingOptionSchema>;

// Create product
export const CreateProductSchema = z.object({
  title: z
    .string()
    .min(3, "Title must be at least 3 characters")
    .max(200, "Title must be less than 200 characters"),
  description: z
    .string()
    .min(10, "Description must be at least 10 characters")
    .max(5000, "Description must be less than 5000 characters"),
  price: z
    .number()
    .positive("Price must be positive")
    .max(10000000, "Price too high"), // Max 10M ZMW
  compareAtPrice: z.number().positive().optional().nullable(),
  categoryId: z.string().min(1, "Category is required"),
  subcategoryId: z.string().optional().nullable(),
  images: z
    .array(z.string().url("Invalid image URL"))
    .min(1, "At least one image is required")
    .max(10, "Maximum 10 images allowed"),
  condition: ProductConditionSchema,
  quantity: z.number().int().positive("Quantity must be at least 1"),
  specifications: z.array(SpecificationSchema).optional(),
  tags: z.array(z.string()).max(10, "Maximum 10 tags allowed").optional(),
  location: ProductLocationSchema.optional(),
  shippingOptions: z
    .array(ShippingOptionSchema)
    .min(1, "At least one shipping option is required"),
  status: z.enum(["draft", "pending_review"]).optional().default("draft"),
});
export type CreateProduct = z.infer<typeof CreateProductSchema>;

// Update product
export const UpdateProductSchema = CreateProductSchema.partial().extend({
  status: ProductStatusSchema.optional(),
});
export type UpdateProduct = z.infer<typeof UpdateProductSchema>;

// Search products
export const SearchProductsSchema = z.object({
  query: z.string().optional(),
  categoryId: z.string().optional(),
  subcategoryId: z.string().optional(),
  condition: ProductConditionSchema.optional(),
  minPrice: z.number().min(0).optional(),
  maxPrice: z.number().min(0).optional(),
  sortBy: z.enum(["newest", "oldest", "price_low", "price_high", "popular"]).optional(),
  page: z.number().int().positive().optional().default(1),
  limit: z.number().int().positive().max(50).optional().default(20),
});
export type SearchProducts = z.infer<typeof SearchProductsSchema>;

// Product output
export const ProductSchema = z.object({
  _id: z.string(),
  sellerId: z.string(),
  managedByUserId: z.string().optional().nullable(),
  title: z.string(),
  description: z.string(),
  price: z.number(),
  compareAtPrice: z.number().optional().nullable(),
  categoryId: z.string(),
  subcategoryId: z.string().optional().nullable(),
  images: z.array(z.string()),
  condition: ProductConditionSchema,
  quantity: z.number(),
  specifications: z.array(SpecificationSchema).optional(),
  tags: z.array(z.string()).optional(),
  location: ProductLocationSchema.optional().nullable(),
  shippingOptions: z.array(ShippingOptionSchema),
  status: ProductStatusSchema,
  submittedAt: z.number().optional().nullable(),
  reviewedAt: z.number().optional().nullable(),
  reviewedByUserId: z.string().optional().nullable(),
  reviewNotes: z.string().optional().nullable(),
  aiModerationStatus: AiModerationStatusSchema.optional().nullable(),
  aiModerationSummary: z.string().optional().nullable(),
  aiModerationFlags: z.array(z.string()).optional().nullable(),
  views: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Product = z.infer<typeof ProductSchema>;
