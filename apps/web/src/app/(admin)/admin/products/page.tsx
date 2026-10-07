import { redirect } from "next/navigation";
import { ROUTES } from "@/lib/constants";

export default function AdminProductsPage() {
  redirect(ROUTES.ADMIN_LISTING_REVIEW);
}
