import { z } from "zod";
import { AddressSchema } from "./user.schema";

export const VendorStatusSchema = z.enum([
  "pending",
  "approved",
  "changes_requested",
  "suspended",
]);
export type VendorStatus = z.infer<typeof VendorStatusSchema>;

export const VendorSocialLinksSchema = z
  .object({
    website: z.string().url("Invalid website URL").optional().nullable(),
    instagram: z.string().optional().nullable(),
    facebook: z.string().optional().nullable(),
  })
  .partial();
export type VendorSocialLinks = z.infer<typeof VendorSocialLinksSchema>;

export const VendorApplicationSchema = z.object({
  storeName: z.string().min(2, "Store name is required").max(120, "Store name too long"),
  description: z
    .string()
    .min(20, "Store description must be at least 20 characters")
    .max(4000, "Store description too long"),
  logoUrl: z.string().url("Invalid logo URL").optional().nullable(),
  bannerUrl: z.string().url("Invalid banner URL").optional().nullable(),
  contactEmail: z.string().email("Invalid contact email"),
  contactPhone: z.string().min(7, "Contact phone is required").optional().nullable(),
  address: AddressSchema,
  socialLinks: VendorSocialLinksSchema.optional().nullable(),
});
export type VendorApplication = z.infer<typeof VendorApplicationSchema>;

export const VendorProfileSchema = z.object({
  _id: z.string(),
  ownerUserId: z.string(),
  storeName: z.string(),
  slug: z.string(),
  description: z.string(),
  logoUrl: z.string().optional().nullable(),
  bannerUrl: z.string().optional().nullable(),
  contactEmail: z.string().email(),
  contactPhone: z.string().optional().nullable(),
  address: AddressSchema,
  socialLinks: VendorSocialLinksSchema.optional().nullable(),
  status: VendorStatusSchema,
  reviewNotes: z.string().optional().nullable(),
  reviewedByUserId: z.string().optional().nullable(),
  reviewedAt: z.number().optional().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type VendorProfile = z.infer<typeof VendorProfileSchema>;
