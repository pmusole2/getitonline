import { z } from "zod";

// Product condition
export const ProductConditionSchema = z.enum(["new", "like_new", "good", "fair"]);
export type ProductCondition = z.infer<typeof ProductConditionSchema>;

// Product status
export const ProductStatusSchema = z.enum([
  "draft",
  "pending_review",
  "changes_requested",
  "rejected",
  "active",
  "sold",
  "suspended",
]);
export type ProductStatus = z.infer<typeof ProductStatusSchema>;

export const AiModerationStatusSchema = z.enum(["clear", "flagged", "error"]);
export type AiModerationStatus = z.infer<typeof AiModerationStatusSchema>;

export const PRODUCT_IMAGE_RULES = {
  minCount: 3,
  maxCount: 8,
  maxSizeBytes: 5 * 1024 * 1024,
  minWidth: 1000,
  minHeight: 1000,
  acceptedMimeTypes: ["image/jpeg", "image/png"] as const,
};

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

export const ProductDimensionsSchema = z.object({
  lengthCm: z.number().positive("Length must be positive"),
  widthCm: z.number().positive("Width must be positive"),
  heightCm: z.number().positive("Height must be positive"),
});
export type ProductDimensions = z.infer<typeof ProductDimensionsSchema>;

export const ProductImageMetadataSchema = z.object({
  url: z.string().url("Invalid image URL"),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  sizeBytes: z.number().int().positive().optional(),
  mimeType: z.enum(PRODUCT_IMAGE_RULES.acceptedMimeTypes).optional(),
  isPrimary: z.boolean(),
  hasWhiteBackground: z.boolean().optional(),
});
export type ProductImageMetadata = z.infer<typeof ProductImageMetadataSchema>;

export const ProductVariantSchema = z.object({
  name: z.string().min(1, "Variant name is required"),
  options: z
    .array(
      z.object({
        name: z.string().min(1, "Option name is required"),
        value: z.string().min(1, "Option value is required"),
        sku: z.string().optional(),
        priceDelta: z.number().optional(),
        quantity: z.number().int().nonnegative().optional(),
        imageUrl: z.string().url().optional(),
      })
    )
    .min(1, "At least one variant option is required"),
});
export type ProductVariant = z.infer<typeof ProductVariantSchema>;

export const ProductVariantAttributeSchema = z.object({
  name: z.string().min(1, "Attribute name is required"),
  values: z.array(z.string().min(1, "Attribute value is required")).min(1),
});
export type ProductVariantAttribute = z.infer<
  typeof ProductVariantAttributeSchema
>;

export const ProductVariantCombinationSchema = z.object({
  id: z.string().min(1, "Variant ID is required"),
  sku: z.string().min(1, "Variant SKU is required"),
  attributes: z
    .array(
      z.object({
        name: z.string().min(1, "Attribute name is required"),
        value: z.string().min(1, "Attribute value is required"),
      })
    )
    .min(1),
  price: z.number().positive("Variant price must be positive"),
  stock: z.number().int().nonnegative("Variant stock cannot be negative"),
  status: z.enum(["active", "inactive", "out_of_stock"]),
  primaryImage: z.string().url().optional(),
  galleryImages: z.array(z.string().url()).optional(),
});
export type ProductVariantCombination = z.infer<
  typeof ProductVariantCombinationSchema
>;

export const ProductAddOnSchema = z.object({
  name: z.string().min(1, "Add-on name is required"),
  description: z.string().optional(),
  price: z.number().min(0, "Add-on price cannot be negative"),
  isRequired: z.boolean(),
});
export type ProductAddOn = z.infer<typeof ProductAddOnSchema>;

export const ProductWarrantySchema = z.object({
  type: z.enum(["manufacturer", "seller", "none"]),
  durationDays: z.number().int().positive().optional(),
  provider: z.string().optional(),
  terms: z.string().optional(),
});
export type ProductWarranty = z.infer<typeof ProductWarrantySchema>;

// Create product
export const CreateProductSchema = z.object({
  title: z
    .string()
    .min(3, "Title must be at least 3 characters")
    .max(200, "Title must be less than 200 characters"),
  brand: z.string().min(1, "Brand is required").max(120),
  sku: z.string().min(1, "SKU is required").max(80).optional(),
  shortDescription: z
    .string()
    .min(20, "Short description must be at least 20 characters")
    .max(240, "Short description must be less than 240 characters"),
  description: z
    .string()
    .min(50, "Description must be at least 50 characters")
    .max(5000, "Description must be less than 5000 characters"),
  keyFeatures: z
    .array(z.string().min(1, "Feature cannot be empty"))
    .min(3, "Add at least 3 key features")
    .max(5, "Maximum 5 key features allowed"),
  price: z
    .number()
    .positive("Price must be positive")
    .max(10000000, "Price too high"), // Max 10M ZMW
  compareAtPrice: z.number().positive().optional().nullable(),
  categoryId: z.string().min(1, "Category is required"),
  subcategoryId: z.string().min(1, "Subcategory is required"),
  classificationId: z.string().min(1, "Classification is required"),
  images: z
    .array(z.string().url("Invalid image URL"))
    .min(PRODUCT_IMAGE_RULES.minCount, "At least 3 images are required")
    .max(PRODUCT_IMAGE_RULES.maxCount, "Maximum 8 images allowed"),
  imageMetadata: z.array(ProductImageMetadataSchema).optional(),
  condition: ProductConditionSchema,
  quantity: z.number().int().positive("Quantity must be at least 1"),
  lowStockThreshold: z.number().int().nonnegative().optional(),
  availabilityStatus: z
    .enum(["in_stock", "low_stock", "out_of_stock", "preorder"])
    .optional(),
  preorder: z
    .object({
      isPreorder: z.boolean(),
      expectedShipDate: z.number().optional(),
      depositPercent: z.number().min(0).max(100).optional(),
    })
    .optional(),
  variants: z.array(ProductVariantSchema).optional(),
  variantAttributes: z.array(ProductVariantAttributeSchema).optional(),
  variantCombinations: z.array(ProductVariantCombinationSchema).optional(),
  addOns: z.array(ProductAddOnSchema).optional(),
  bulkPricing: z
    .array(
      z.object({
        minQuantity: z.number().int().positive(),
        unitPrice: z.number().positive(),
      })
    )
    .optional(),
  dimensions: ProductDimensionsSchema.optional(),
  weightKg: z.number().positive().optional(),
  packageDimensions: ProductDimensionsSchema.optional(),
  packageWeightKg: z.number().positive().optional(),
  warranty: ProductWarrantySchema.optional(),
  countryOfOrigin: z.string().optional(),
  modelNumber: z.string().optional(),
  manufacturerPartNumber: z.string().optional(),
  material: z.string().optional(),
  color: z.string().optional(),
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
  classificationId: z.string().optional(),
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
  brand: z.string().optional().nullable(),
  sku: z.string().optional().nullable(),
  shortDescription: z.string().optional().nullable(),
  description: z.string(),
  keyFeatures: z.array(z.string()).optional().nullable(),
  price: z.number(),
  compareAtPrice: z.number().optional().nullable(),
  categoryId: z.string(),
  subcategoryId: z.string().optional().nullable(),
  classificationId: z.string().optional().nullable(),
  images: z.array(z.string()),
  imageMetadata: z.array(ProductImageMetadataSchema).optional().nullable(),
  condition: ProductConditionSchema,
  quantity: z.number(),
  lowStockThreshold: z.number().optional().nullable(),
  availabilityStatus: z
    .enum(["in_stock", "low_stock", "out_of_stock", "preorder"])
    .optional()
    .nullable(),
  preorder: z
    .object({
      isPreorder: z.boolean(),
      expectedShipDate: z.number().optional().nullable(),
      depositPercent: z.number().optional().nullable(),
    })
    .optional()
    .nullable(),
  variants: z.array(ProductVariantSchema).optional().nullable(),
  variantAttributes: z.array(ProductVariantAttributeSchema).optional().nullable(),
  variantCombinations: z.array(ProductVariantCombinationSchema).optional().nullable(),
  addOns: z.array(ProductAddOnSchema).optional().nullable(),
  bulkPricing: z
    .array(z.object({ minQuantity: z.number(), unitPrice: z.number() }))
    .optional()
    .nullable(),
  dimensions: ProductDimensionsSchema.optional().nullable(),
  weightKg: z.number().optional().nullable(),
  packageDimensions: ProductDimensionsSchema.optional().nullable(),
  packageWeightKg: z.number().optional().nullable(),
  warranty: ProductWarrantySchema.optional().nullable(),
  countryOfOrigin: z.string().optional().nullable(),
  modelNumber: z.string().optional().nullable(),
  manufacturerPartNumber: z.string().optional().nullable(),
  material: z.string().optional().nullable(),
  color: z.string().optional().nullable(),
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
