import type { Id, UserRole } from "../types";

export const PRD_ROLE_LABELS: Record<UserRole, string> = {
  user: "Customer",
  catalog_manager: "Product Uploader",
  moderator: "Reviewer-Approver",
  admin: "Super Admin",
};

export function getRoleLabel(role?: UserRole | null) {
  return role ? PRD_ROLE_LABELS[role] : "Customer";
}

export function getRoleDescription(role?: UserRole | null) {
  switch (role) {
    case "admin":
      return "Full marketplace control, role assignment, approvals, and operations";
    case "catalog_manager":
      return "Can upload and manage product listings before reviewer approval";
    case "moderator":
      return "Can review, approve, reject, and request listing changes";
    default:
      return "Can browse, buy, save favorites, and manage orders";
  }
}

export function canManageCatalog(role?: UserRole | null) {
  return role === "admin" || role === "catalog_manager";
}

export function isAdminRole(role?: UserRole | null) {
  return role === "admin";
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

export function canViewProductStats(
  viewer?: { _id: Id<"users">; role?: UserRole | null } | null,
  product?: { sellerId: Id<"users"> } | null
) {
  if (!viewer || !product) return false;
  return viewer._id === product.sellerId || isStaffRole(viewer.role);
}
