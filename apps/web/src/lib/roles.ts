import type { UserRole } from "@/types";

export const PRD_ROLE_LABELS: Record<UserRole, string> = {
  user: "Customer",
  catalog_manager: "Product Uploader",
  moderator: "Reviewer-Approver",
  admin: "Super Admin",
};

export function getRoleLabel(role?: UserRole | null) {
  return role ? PRD_ROLE_LABELS[role] : "Customer";
}

export function canManageCatalog(role?: UserRole | null) {
  return role === "admin" || role === "catalog_manager";
}

export function isReviewerRole(role?: UserRole | null) {
  return role === "admin" || role === "moderator";
}

export function canAccessSellerSurface(role?: UserRole | null) {
  return Boolean(role) && role !== "moderator";
}

export function canManageListings(
  role?: UserRole | null,
  vendorStatus?: "pending" | "approved" | "changes_requested" | "suspended" | null
) {
  return canManageCatalog(role) || vendorStatus === "approved";
}

export function isStaffRole(role?: UserRole | null) {
  return (
    role === "admin" ||
    role === "catalog_manager" ||
    role === "moderator"
  );
}
