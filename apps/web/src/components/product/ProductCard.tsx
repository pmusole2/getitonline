"use client";

import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Heart, Eye, MapPin } from "lucide-react";
import { ROUTES, CONDITION_DISPLAY_NAMES } from "@/lib/constants";
import { formatZMW } from "@gettitonline/shared";
import { cn } from "@/lib/utils";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";

interface ProductCardProps {
  product: {
    _id: Id<"products">;
    title: string;
    price: number;
    images?: string[];
    condition: "new" | "like_new" | "good" | "fair";
    location?: { city?: string; province?: string };
    views?: number;
    status?: string;
  };
  className?: string;
  showFavorite?: boolean;
}

export function ProductCard({
  product,
  className,
  showFavorite = true,
}: ProductCardProps) {
  const { user, isSignedIn } = useAuth();

  // Check if favorited
  const isFavorited = useQuery(
    api.favorites.isFavorited,
    user?._id ? { userId: user._id, productId: product._id } : "skip"
  );

  // Toggle favorite mutation
  const toggleFavorite = useMutation(api.favorites.toggleFavorite);

  const handleFavoriteClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (!isSignedIn || !user) {
      toast.error("Please sign in to save favorites");
      return;
    }

    try {
      await toggleFavorite({ userId: user._id, productId: product._id });
      toast.success(isFavorited ? "Removed from favorites" : "Added to favorites");
    } catch (error) {
      toast.error("Failed to update favorites");
    }
  };

  return (
    <Link href={ROUTES.PRODUCT(product._id)}>
      <Card
        className={cn(
          "group overflow-hidden transition-all hover:shadow-lg",
          className
        )}
      >
        {/* Image */}
        <div className="relative aspect-square overflow-hidden bg-muted">
          {product.images?.[0] ? (
            <img
              src={product.images[0]}
              alt={product.title}
              className="h-full w-full object-cover transition-transform group-hover:scale-105"
            />
          ) : (
            <div className="flex h-full items-center justify-center">
              <span className="text-4xl text-muted-foreground/30">📦</span>
            </div>
          )}

          {/* Favorite Button */}
          {showFavorite && (
            <Button
              variant="secondary"
              size="icon"
              className={cn(
                "absolute right-2 top-2 h-8 w-8 rounded-full opacity-0 transition-opacity group-hover:opacity-100",
                isFavorited && "opacity-100"
              )}
              onClick={handleFavoriteClick}
            >
              <Heart
                className={cn(
                  "h-4 w-4",
                  isFavorited && "fill-red-500 text-red-500"
                )}
              />
            </Button>
          )}

          {/* Status Badge */}
          {product.status && product.status !== "active" && (
            <Badge
              variant={product.status === "sold" ? "secondary" : "destructive"}
              className="absolute left-2 top-2"
            >
              {product.status === "sold" ? "Sold" : product.status}
            </Badge>
          )}
        </div>

        {/* Content */}
        <CardContent className="p-4">
          <h3 className="line-clamp-2 font-medium leading-tight">
            {product.title}
          </h3>

          <p className="mt-2 text-lg font-bold text-primary">
            {formatZMW(product.price)}
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="text-xs">
              {CONDITION_DISPLAY_NAMES[product.condition] || product.condition}
            </Badge>

            {product.location?.city && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <MapPin className="h-3 w-3" />
                {product.location.city}
              </span>
            )}

            {product.views !== undefined && product.views > 0 && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Eye className="h-3 w-3" />
                {product.views}
              </span>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

// Skeleton loader for ProductCard
export function ProductCardSkeleton() {
  return (
    <Card className="overflow-hidden">
      <div className="aspect-square animate-pulse bg-muted" />
      <CardContent className="p-4">
        <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
        <div className="mt-2 h-4 w-1/2 animate-pulse rounded bg-muted" />
        <div className="mt-2 h-5 w-1/3 animate-pulse rounded bg-muted" />
        <div className="mt-2 flex gap-2">
          <div className="h-5 w-16 animate-pulse rounded bg-muted" />
          <div className="h-5 w-20 animate-pulse rounded bg-muted" />
        </div>
      </CardContent>
    </Card>
  );
}
