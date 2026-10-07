"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "../../../../../../convex/_generated/api";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Search, LayoutGrid, List } from "lucide-react";
import { ROUTES } from "@/lib/constants";
import { useRouter } from "next/navigation";

export default function SearchPage() {
  return (
    <Suspense fallback={<SearchPageSkeleton />}>
      <SearchPageContent />
    </Suspense>
  );
}

function SearchPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryParam = searchParams.get("q") || "";
  const brandParam = searchParams.get("brand") || "";

  const [searchQuery, setSearchQuery] = useState(queryParam);
  const [filters, setFilters] = useState<FilterState>({
    conditions: [],
    priceMin: 0,
    priceMax: 100000,
    province: "",
    sortBy: "newest",
  });
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");

  // Update search query when URL param changes
  useEffect(() => {
    setSearchQuery(queryParam);
  }, [queryParam]);

  // Search products
  const textSearchResults = useQuery(
    api.products.searchProducts,
    queryParam
      ? {
          query: queryParam,
          minPrice: filters.priceMin > 0 ? filters.priceMin : undefined,
          maxPrice: filters.priceMax < 100000 ? filters.priceMax : undefined,
        }
      : "skip"
  );
  const brandResults = useQuery(
    api.products.getProductsByBrand,
    !queryParam && brandParam
      ? {
          brand: brandParam,
          limit: 50,
        }
      : "skip"
  );
  const searchResults = queryParam ? textSearchResults : brandParam ? brandResults : undefined;

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      router.push(`${ROUTES.SEARCH}?q=${encodeURIComponent(searchQuery.trim())}`);
    }
  };

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
            <BreadcrumbPage>Search</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {/* Search Header */}
      <div className="mb-8">
        <h1 className="mb-4 text-2xl font-bold">
          {queryParam
            ? `Search results for "${queryParam}"`
            : brandParam
              ? `Products by "${brandParam}"`
            : "Search Products"}
        </h1>

        {/* Search Form */}
        <form onSubmit={handleSearch} className="flex max-w-xl gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search for products..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-12 pl-10"
            />
          </div>
          <Button type="submit" size="lg">
            Search
          </Button>
        </form>
      </div>

      {queryParam || brandParam ? (
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
                {searchResults?.length ?? 0} results found
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
                  onChange={(value) =>
                    setFilters({ ...filters, sortBy: value })
                  }
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

            {/* Results */}
            <ProductGrid
              products={searchResults}
              columns={viewMode === "grid" ? 3 : 2}
              emptyMessage={`No products found for "${queryParam || brandParam}"`}
            />
          </main>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Search className="h-16 w-16 text-muted-foreground/50" />
          <h2 className="mt-4 text-xl font-semibold">Search for products</h2>
          <p className="mt-2 text-muted-foreground">
            Enter a search term to find products
          </p>
        </div>
      )}
    </div>
  );
}

function SearchPageSkeleton() {
  return (
    <div className="container py-6">
      <Skeleton className="mb-6 h-4 w-32" />
      <Skeleton className="mb-4 h-8 w-64" />
      <Skeleton className="mb-8 h-12 w-full max-w-xl" />
      <div className="flex flex-col gap-6 lg:flex-row">
        <aside className="w-full lg:w-64 lg:shrink-0">
          <Skeleton className="h-64 w-full" />
        </aside>
        <main className="flex-1">
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-80 w-full rounded-lg" />
            ))}
          </div>
        </main>
      </div>
    </div>
  );
}
