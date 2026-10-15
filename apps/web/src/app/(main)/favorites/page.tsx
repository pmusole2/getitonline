"use client";

import Link from "next/link";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../../../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Heart, ShoppingBag } from "lucide-react";
import { ROUTES } from "@/lib/constants";
import { useAuth } from "@/hooks/useAuth";
import { ProductGrid } from "@/components/product/ProductGrid";

export default function FavoritesPage() {
  const { user, isSignedIn, isLoading: authLoading } = useAuth();

  // Get favorites
  const favorites = useQuery(
    api.favorites.getUserFavorites,
    user?._id ? {} : "skip"
  );

  // Loading state
  if (authLoading || (isSignedIn && favorites === undefined)) {
    return <FavoritesSkeleton />;
  }

  // Not signed in
  if (!isSignedIn) {
    return (
      <div className="container flex flex-col items-center justify-center py-16">
        <Heart className="h-16 w-16 text-muted-foreground" />
        <h1 className="mt-4 text-2xl font-bold">Favorites</h1>
        <p className="mt-2 text-muted-foreground">
          Please sign in to view your favorites
        </p>
        <Button asChild className="mt-6">
          <Link href={ROUTES.SIGN_IN}>Sign In</Link>
        </Button>
      </div>
    );
  }

  // Empty state
  if (!favorites || favorites.length === 0) {
    return (
      <div className="container flex flex-col items-center justify-center py-16">
        <Heart className="h-16 w-16 text-muted-foreground" />
        <h1 className="mt-4 text-2xl font-bold">No favorites yet</h1>
        <p className="mt-2 text-muted-foreground">
          Save products you like by clicking the heart icon
        </p>
        <Button asChild className="mt-6">
          <Link href={ROUTES.BROWSE}>Browse Products</Link>
        </Button>
      </div>
    );
  }

  // Extract products from favorites
  const products = favorites
    .map((fav) => fav.product)
    .filter((p): p is NonNullable<typeof p> => p !== null && p !== undefined);

  return (
    <div className="container py-6">
      {/* Breadcrumb */}
      <Breadcrumb className="mb-6">
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href={ROUTES.HOME}>Home</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Favorites</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <h1 className="mb-6 text-2xl font-bold">
        My Favorites ({favorites.length})
      </h1>

      <ProductGrid
        products={products}
        columns={4}
        emptyMessage="No favorites to display"
      />
    </div>
  );
}

function FavoritesSkeleton() {
  return (
    <div className="container py-6">
      <Skeleton className="mb-6 h-4 w-32" />
      <Skeleton className="mb-6 h-8 w-48" />
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-80 w-full rounded-lg" />
        ))}
      </div>
    </div>
  );
}
