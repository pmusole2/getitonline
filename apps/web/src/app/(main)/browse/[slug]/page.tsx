"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../../../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ProductGrid } from "@/components/product/ProductGrid";
import {
  ProductFilters,
  ProductSortSelect,
  FilterState,
} from "@/components/product/ProductFilters";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { LayoutGrid, List } from "lucide-react";
import { ROUTES } from "@/lib/constants";
import { useAuth } from "@/hooks/useAuth";
import { useBehaviorEventSubject } from "@/hooks/useBehaviorEventSubject";

export default function CategoryPage() {
  const params = useParams();
  const slug = params.slug as string;
  const auth = useAuth();
  const behaviorSubject = useBehaviorEventSubject(auth);

  const [filters, setFilters] = useState<FilterState>({
    conditions: [],
    priceMin: 0,
    priceMax: 100000,
    province: "",
    sortBy: "newest",
  });
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");

  // Get category by slug
  const category = useQuery(api.categories.getCategoryBySlug, { slug });

  // Get subcategories
  const subcategories = useQuery(
    api.categories.getSubcategories,
    category?._id ? { parentId: category._id } : "skip",
  );

  // Get products in category
  const products = useQuery(
    api.products.getProductsByCategory,
    category?._id
      ? {
          categoryId: category._id,
          limit: 24,
        }
      : "skip",
  );
  const recordBehaviorEvent = useMutation(
    api.notifications.recordBehaviorEvent,
  );

  useEffect(() => {
    if (!category?._id || behaviorSubject === undefined) return;
    void recordBehaviorEvent({
      expectedClerkId: behaviorSubject,
      eventType: "category_browse",
      categoryId: category._id,
    }).catch(() => undefined);
  }, [behaviorSubject, category?._id, recordBehaviorEvent]);

  const isLoading = category === undefined;

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
            <BreadcrumbLink href={ROUTES.BROWSE}>Browse</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            {isLoading ? (
              <Skeleton className="h-4 w-24" />
            ) : (
              <BreadcrumbPage>{category?.name}</BreadcrumbPage>
            )}
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {/* Category Header */}
      <div className="mb-6">
        {isLoading ? (
          <>
            <Skeleton className="mb-2 h-8 w-48" />
            <Skeleton className="h-4 w-64" />
          </>
        ) : (
          <>
            <h1 className="text-3xl font-bold">{category?.name}</h1>
            {category?.description && (
              <p className="mt-1 text-muted-foreground">
                {category.description}
              </p>
            )}
          </>
        )}
      </div>

      {/* Subcategories */}
      {subcategories && subcategories.length > 0 && (
        <div className="mb-6">
          <h2 className="mb-3 text-sm font-medium text-muted-foreground">
            Subcategories
          </h2>
          <div className="flex flex-wrap gap-2">
            {subcategories.map((sub) => (
              <Link key={sub._id} href={ROUTES.CATEGORY(sub.slug)}>
                <Badge
                  variant="secondary"
                  className="cursor-pointer px-3 py-1.5 text-sm hover:bg-secondary/80"
                >
                  {sub.name}
                </Badge>
              </Link>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-6 lg:flex-row">
        {/* Sidebar - Filters */}
        <aside className="w-full lg:w-64 lg:shrink-0">
          <div className="hidden lg:block">
            <h2 className="mb-4 text-lg font-semibold">Filters</h2>
            <ProductFilters filters={filters} onFiltersChange={setFilters} />
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1">
          {/* Header */}
          <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
            <p className="text-muted-foreground">
              {products?.items?.length ?? 0} products found
            </p>

            <div className="flex items-center gap-2">
              {/* Mobile Filters */}
              <div className="lg:hidden">
                <ProductFilters
                  filters={filters}
                  onFiltersChange={setFilters}
                />
              </div>

              {/* Sort */}
              <ProductSortSelect
                value={filters.sortBy}
                onChange={(value) => setFilters({ ...filters, sortBy: value })}
              />

              {/* View Mode Toggle */}
              <div className="hidden items-center rounded-lg border p-1 sm:flex">
                <Button
                  variant={viewMode === "grid" ? "secondary" : "ghost"}
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => setViewMode("grid")}
                >
                  <LayoutGrid className="h-4 w-4" />
                </Button>
                <Button
                  variant={viewMode === "list" ? "secondary" : "ghost"}
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => setViewMode("list")}
                >
                  <List className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>

          {/* Products Grid */}
          <ProductGrid
            products={products?.items}
            isLoading={category === undefined}
            columns={viewMode === "grid" ? 3 : 2}
            emptyMessage={`No products found in ${category?.name || "this category"}`}
          />

          {/* Load More */}
          {products?.hasMore && (
            <div className="mt-8 flex justify-center">
              <Button variant="outline">Load More Products</Button>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
