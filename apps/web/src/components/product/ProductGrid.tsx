"use client";

import { ProductCard, ProductCardSkeleton } from "./ProductCard";
import { Id } from "../../../../../convex/_generated/dataModel";

interface Product {
  _id: Id<"products">;
  title: string;
  price: number;
  images?: string[];
  condition: "new" | "like_new" | "good" | "fair";
  location?: { city?: string; province?: string };
  views?: number;
  status?: string;
  variantCombinations?: Array<{ price: number; status: string; primaryImage?: string; galleryImages?: string[] }>;
}

interface ProductGridProps {
  products: Product[] | undefined;
  isLoading?: boolean;
  emptyMessage?: string;
  columns?: 2 | 3 | 4;
}

export function ProductGrid({
  products,
  isLoading,
  emptyMessage = "No products found",
  columns = 4,
}: ProductGridProps) {
  const gridCols = {
    2: "grid-cols-2",
    3: "grid-cols-2 md:grid-cols-3",
    4: "grid-cols-2 md:grid-cols-3 xl:grid-cols-4",
  };

  if (isLoading || products === undefined) {
    return (
      <div className={`grid gap-4 ${gridCols[columns]}`}>
        {Array.from({ length: 8 }).map((_, i) => (
          <ProductCardSkeleton key={i} />
        ))}
      </div>
    );
  }

  if (products.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <span className="text-6xl">📦</span>
        <h3 className="mt-4 text-lg font-semibold">{emptyMessage}</h3>
        <p className="mt-2 text-muted-foreground">
          Try adjusting your filters or search terms
        </p>
      </div>
    );
  }

  return (
    <div className={`grid gap-4 ${gridCols[columns]}`}>
      {products.map((product) => (
        <ProductCard key={product._id} product={product} />
      ))}
    </div>
  );
}
