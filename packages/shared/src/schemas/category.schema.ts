import { z } from "zod";

export const CategoryLevelSchema = z.enum(["l1", "l2", "l3"]);
export type CategoryLevel = z.infer<typeof CategoryLevelSchema>;

// Create category (admin)
export const CreateCategorySchema = z.object({
  name: z.string().min(1, "Name is required").max(100, "Name too long"),
  slug: z
    .string()
    .min(1, "Slug is required")
    .max(100, "Slug too long")
    .regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with dashes"),
  description: z.string().max(500, "Description too long").optional(),
  image: z.string().url("Invalid image URL").optional(),
  parentId: z.string().optional(),
  level: CategoryLevelSchema.optional(),
  requiresApproval: z.boolean().optional().default(false),
  sortOrder: z.number().int().optional().default(0),
});
export type CreateCategory = z.infer<typeof CreateCategorySchema>;

// Update category (admin)
export const UpdateCategorySchema = CreateCategorySchema.partial().extend({
  isActive: z.boolean().optional(),
});
export type UpdateCategory = z.infer<typeof UpdateCategorySchema>;

// Category output
export const CategorySchema = z.object({
  _id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().optional().nullable(),
  image: z.string().optional().nullable(),
  parentId: z.string().optional().nullable(),
  level: CategoryLevelSchema.optional().nullable(),
  requiresApproval: z.boolean().optional().nullable(),
  approvedByUserId: z.string().optional().nullable(),
  approvedAt: z.number().optional().nullable(),
  isActive: z.boolean(),
  sortOrder: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Category = z.infer<typeof CategorySchema>;

// Category with subcategories
export const CategoryWithClassificationsSchema = CategorySchema.extend({
  classifications: z.array(CategorySchema).optional(),
});
export type CategoryWithClassifications = z.infer<
  typeof CategoryWithClassificationsSchema
>;

export const CategoryWithSubcategoriesSchema = CategorySchema.extend({
  subcategories: z.array(CategoryWithClassificationsSchema).optional(),
});
export type CategoryWithSubcategories = z.infer<typeof CategoryWithSubcategoriesSchema>;
