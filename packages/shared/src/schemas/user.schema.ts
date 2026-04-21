import { z } from "zod";

// User roles
export const UserRoleSchema = z.enum([
  "user",
  "catalog_manager",
  "moderator",
  "admin",
]);
export type UserRole = z.infer<typeof UserRoleSchema>;

// Address schema
export const AddressSchema = z.object({
  street: z.string().min(1, "Street is required"),
  city: z.string().min(1, "City is required"),
  province: z.string().min(1, "Province is required"),
  country: z.string().min(1, "Country is required").default("Zambia"),
});
export type Address = z.infer<typeof AddressSchema>;

// User registration
export const UserRegistrationSchema = z.object({
  email: z.string().email("Invalid email address"),
  firstName: z.string().min(1, "First name is required").max(50, "First name too long"),
  lastName: z.string().min(1, "Last name is required").max(50, "Last name too long"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
    .regex(/[a-z]/, "Password must contain at least one lowercase letter")
    .regex(/[0-9]/, "Password must contain at least one number"),
});
export type UserRegistration = z.infer<typeof UserRegistrationSchema>;

// User login
export const UserLoginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});
export type UserLogin = z.infer<typeof UserLoginSchema>;

// Update profile
export const UpdateProfileSchema = z.object({
  firstName: z.string().min(1).max(50).optional(),
  lastName: z.string().min(1).max(50).optional(),
  phone: z
    .string()
    .regex(/^\+?[0-9]{10,15}$/, "Invalid phone number")
    .optional()
    .nullable(),
  avatar: z.string().url("Invalid avatar URL").optional().nullable(),
  address: AddressSchema.optional().nullable(),
});
export type UpdateProfile = z.infer<typeof UpdateProfileSchema>;

// User interests update
export const UpdateInterestsSchema = z.object({
  interests: z.array(z.string()).min(1, "Select at least one interest"),
});
export type UpdateInterests = z.infer<typeof UpdateInterestsSchema>;

// User output (what gets returned from API)
export const UserSchema = z.object({
  _id: z.string(),
  clerkId: z.string(),
  email: z.string().email(),
  firstName: z.string(),
  lastName: z.string(),
  phone: z.string().optional().nullable(),
  avatar: z.string().optional().nullable(),
  role: UserRoleSchema,
  interests: z.array(z.string()).optional(),
  address: AddressSchema.optional().nullable(),
  rating: z.number().min(0).max(5).optional().nullable(),
  totalSales: z.number(),
  totalPurchases: z.number(),
  isVerified: z.boolean(),
  isBanned: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type User = z.infer<typeof UserSchema>;
