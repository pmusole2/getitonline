"use client";

import Link from "next/link";
import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Heart, Eye, MapPin, ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from "lucide-react";
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
    variantCombinations?: Array<{ price: number; status: string; primaryImage?: string; galleryImages?: string[] }>;
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
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [zoom, setZoom] = useState(1);
  const cardImages = product.images?.length ? product.images : [];
  const lightboxImages = cardImages.length ? cardImages : ["/placeholder.png"];
  const activeVariantPrices = product.variantCombinations
    ?.filter((variant) => variant.status === "active")
    .map((variant) => variant.price) ?? [];
  const minVariantPrice =
    activeVariantPrices.length > 0 ? Math.min(...activeVariantPrices) : product.price;
  const maxVariantPrice =
    activeVariantPrices.length > 0 ? Math.max(...activeVariantPrices) : product.price;
  const priceLabel =
    minVariantPrice !== maxVariantPrice
      ? `From ${formatZMW(minVariantPrice)}`
      : formatZMW(product.price);

  // Check if favorited
  const isFavorited = useQuery(
    api.favorites.isFavorited,
    user?._id ? { productId: product._id } : "skip"
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
      await toggleFavorite({ productId: product._id });
      toast.success(isFavorited ? "Removed from favorites" : "Added to favorites");
    } catch (error) {
      toast.error("Failed to update favorites");
    }
  };

  return (
    <>
      <Card
        className={cn(
          "group flex h-full min-h-[326px] overflow-hidden rounded-lg border border-border/70 shadow-none transition-colors hover:border-primary/60",
          className
        )}
      >
        {/* Image */}
        <div className="relative h-[200px] w-full overflow-hidden bg-muted">
          <button
            type="button"
            className="h-full w-full p-2 text-left"
            onClick={() => {
              setLightboxIndex(0);
              setZoom(1);
              setIsLightboxOpen(true);
            }}
          >
            {product.images?.[0] ? (
              <img
                src={product.images[0]}
                alt={product.title}
                className="h-full w-full object-contain transition-transform group-hover:scale-[1.02]"
              />
            ) : (
              <div className="flex h-full items-center justify-center">
                <span className="text-4xl text-muted-foreground/30">📦</span>
              </div>
            )}
          </button>

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
        <CardContent className="flex flex-1 flex-col p-4">
          <h3 className="min-h-[2.5rem] font-medium leading-tight">
            <Link
              href={ROUTES.PRODUCT(product._id)}
              className="line-clamp-2 hover:underline"
            >
              {product.title}
            </Link>
          </h3>

          <p className="mt-2 text-lg font-bold text-foreground">
            {priceLabel}
          </p>

          <div className="mt-auto flex flex-wrap items-center gap-2 pt-3">
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
    <Dialog open={isLightboxOpen} onOpenChange={setIsLightboxOpen}>
      <DialogContent className="h-[92vh] max-w-[96vw] border-0 bg-black/92 p-0 shadow-none" showCloseButton>
        <DialogTitle className="sr-only">{product.title}</DialogTitle>
        <div className="relative flex h-full items-center justify-center overflow-hidden">
          <img
            src={lightboxImages[lightboxIndex]}
            alt={product.title}
            className="max-h-full max-w-full object-contain transition-transform"
            style={{ transform: `scale(${zoom})` }}
          />
          {lightboxImages.length > 1 && (
            <>
              <Button
                type="button"
                variant="secondary"
                size="icon"
                className="absolute left-4 top-1/2 -translate-y-1/2"
                onClick={() => {
                  setZoom(1);
                  setLightboxIndex((index) =>
                    index === 0 ? lightboxImages.length - 1 : index - 1
                  );
                }}
              >
                <ChevronLeft className="h-5 w-5" />
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="icon"
                className="absolute right-4 top-1/2 -translate-y-1/2"
                onClick={() => {
                  setZoom(1);
                  setLightboxIndex((index) =>
                    index === lightboxImages.length - 1 ? 0 : index + 1
                  );
                }}
              >
                <ChevronRight className="h-5 w-5" />
              </Button>
            </>
          )}
          <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-white/10 p-2">
            <Button
              type="button"
              variant="secondary"
              size="icon"
              onClick={() => setZoom((value) => Math.max(1, value - 0.25))}
            >
              <ZoomOut className="h-4 w-4" />
            </Button>
            <span className="min-w-12 text-center text-xs font-medium text-white">
              {Math.round(zoom * 100)}%
            </span>
            <Button
              type="button"
              variant="secondary"
              size="icon"
              onClick={() => setZoom((value) => Math.min(3, value + 0.25))}
            >
              <ZoomIn className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
    </>
  );
}

// Skeleton loader for ProductCard
export function ProductCardSkeleton() {
  return (
    <Card className="min-h-[326px] overflow-hidden rounded-lg border border-border/70 shadow-none">
      <div className="h-[200px] animate-pulse bg-muted" />
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
