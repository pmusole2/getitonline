"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ProductGrid } from "@/components/product/ProductGrid";
import { ROUTES } from "@/lib/constants";
import { aiFailureMessage, formatZMW } from "@gettitonline/shared";
import {
  assertVisualSearchFile,
  encodeVisualSearchImage,
  VisualSearchImageError,
} from "../../../../../packages/shared/src/ai/aiSearchImage";
import { useAiActions } from "@/hooks/useAiActions";
import { useAiConsentGate } from "@/hooks/useAiConsentGate";
import { useQuery } from "convex/react";
import {
  Camera,
  Car,
  ChevronRight,
  Laptop,
  Loader2,
  Package,
  Search,
  Tag,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type ChangeEvent,
  type ElementType,
  type FormEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "../../../../../convex/_generated/api";

const categoryIcons: Record<string, ElementType> = {
  "auto-parts": Car,
  "car-accessories": Wrench,
  "tech-electronics": Laptop,
};

const popularSearches = [
  "Sneakers",
  "Phone Accessories",
  "Kitchen Essentials",
  "Beauty Picks",
];

function normalizeImageUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function formatPromotionDiscount(promotion: {
  discountType: string;
  discountValue?: number;
}) {
  if (promotion.discountType === "percent" && promotion.discountValue) {
    return `${promotion.discountValue}% off`;
  }

  if (promotion.discountType === "fixed_amount" && promotion.discountValue) {
    return `${formatZMW(promotion.discountValue)} off`;
  }

  if (promotion.discountType === "compare_at") {
    return "Special pricing";
  }

  return "Limited offer";
}

async function fileToSearchDataUrl(file: File): Promise<string> {
  // Refused before decoding, so an oversized or non-image file costs no memory.
  assertVisualSearchFile(file);

  const objectUrl = URL.createObjectURL(file);

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("Could not read image."));
      element.src = objectUrl;
    });

    // The shared encoder bounds both edges and lowers quality until the data URL fits the backend limit.
    return encodeVisualSearchImage(
      { width: image.naturalWidth, height: image.naturalHeight },
      (size, quality) => {
        const canvas = document.createElement("canvas");
        canvas.width = size.width;
        canvas.height = size.height;

        const context = canvas.getContext("2d");
        if (!context) {
          throw new Error("Could not prepare image search.");
        }

        context.drawImage(image, 0, 0, size.width, size.height);
        return canvas.toDataURL("image/jpeg", quality);
      },
    );
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export default function HomePage() {
  const router = useRouter();
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [imageSearchLoading, setImageSearchLoading] = useState(false);
  const [imageSearchError, setImageSearchError] = useState<string | null>(null);
  const ai = useAiActions();
  const aiGate = useAiConsentGate(ai.subject);

  const categories = useQuery(api.categories.getParentCategories);
  const recentProducts = useQuery(api.products.getRecentProducts, { limit: 8 });
  const homeBanners = useQuery(api.promotions.listActiveBanners, {});
  const deals = useQuery(api.promotions.listActivePromotions, {
    type: "deal_of_day",
    limit: 6,
  });
  const monthlyCarouselBanners = useMemo(() => {
    if (!homeBanners) return undefined;
    const monthly = homeBanners.filter((banner) => banner.placement === "home_monthly");
    return monthly.length > 0
      ? monthly
      : homeBanners.filter((banner) => banner.placement === "home_hero");
  }, [homeBanners]);
  const stripBanners = useMemo(
    () => homeBanners?.filter((banner) => banner.placement === "home_strip"),
    [homeBanners]
  );
  const dealProductIds = useMemo(
    () =>
      Array.from(new Set((deals ?? []).flatMap((deal) => deal.productIds))).slice(
        0,
        8
      ),
    [deals]
  );
  const dealProducts = useQuery(
    api.products.getProductsByIds,
    dealProductIds.length > 0 ? { productIds: dealProductIds } : "skip"
  );

  const handleSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedQuery = searchQuery.trim();
    if (trimmedQuery) {
      router.push(`${ROUTES.SEARCH}?q=${encodeURIComponent(trimmedQuery)}`);
    }
  };

  const runImageSearch = async (file: File) => {
    setImageSearchLoading(true);
    setImageSearchError(null);

    try {
      const imageDataUrl = await fileToSearchDataUrl(file);
      const result = await ai.visualSearch({ imageDataUrl });
      // A result for a previous account must not navigate the new account to its search.
      if (!ai.isCurrent()) return;
      const visualQuery = result.query.trim();

      if (!visualQuery) {
        setImageSearchError("Image search could not find search words in this photo. Try a text search instead.");
        return;
      }

      router.push(`${ROUTES.SEARCH}?q=${encodeURIComponent(visualQuery)}`);
    } catch (error: unknown) {
      // A photo that cannot be prepared is explained as it is. A result for a previous account shows nothing.
      const message =
        error instanceof VisualSearchImageError
          ? error.message
          : aiFailureMessage(error);
      if (message !== null && ai.isCurrent()) {
        setImageSearchError(`${message} Try a text search instead.`);
      }
    } finally {
      setImageSearchLoading(false);
    }
  };

  const handleImageSearch = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    try {
      await aiGate.runWithConsent(
        "image_search",
        () => runImageSearch(file),
        () => setImageSearchError("Image search is off until you allow AI features. Try a text search instead."),
      );
    } finally {
      setImageSearchLoading(false);
    }
  };

  return (
    <main className="bg-background">
      {aiGate.consentDialog}
      <section className="border-b bg-muted/25 py-6">
        <div className="container space-y-6">
          <form onSubmit={handleSearch} className="flex flex-col gap-3 sm:flex-row">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                placeholder="Search for products..."
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                className="h-12 pl-10 pr-12 text-base"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-1 top-1/2 h-10 w-10 -translate-y-1/2"
                onClick={() => imageInputRef.current?.click()}
                disabled={imageSearchLoading}
                aria-label="Search by image"
              >
                {imageSearchLoading ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <Camera className="h-5 w-5" />
                )}
              </Button>
              <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="sr-only"
                onChange={(event) => void handleImageSearch(event)}
              />
            </div>
            <Button type="submit" size="lg" className="h-12 px-8">
              Search
            </Button>
          </form>

          {imageSearchError ? (
            <p className="text-sm text-destructive">{imageSearchError}</p>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">Popular:</span>
            {popularSearches.map((term) => (
              <Button key={term} variant="outline" size="sm" asChild>
                <Link href={`${ROUTES.SEARCH}?q=${encodeURIComponent(term)}`}>
                  {term}
                </Link>
              </Button>
            ))}
          </div>

          <div>
            <div className="mb-3 flex items-center justify-between">
              <h1 className="text-xl font-semibold">Categories</h1>
              <Button variant="ghost" size="sm" asChild>
                <Link href={ROUTES.BROWSE}>
                  See All
                  <ChevronRight className="ml-1 h-4 w-4" />
                </Link>
              </Button>
            </div>

            <div className="flex gap-3 overflow-x-auto pb-1">
              {categories === undefined
                ? Array.from({ length: 6 }).map((_, index) => (
                    <Skeleton key={index} className="h-28 w-28 shrink-0 rounded-lg" />
                  ))
                : categories.map((category) => {
                    const Icon = categoryIcons[category.slug] || Package;
                    return (
                      <Link
                        key={category._id}
                        href={ROUTES.CATEGORY(category.slug)}
                        className="group w-28 shrink-0"
                      >
                        <Card className="h-full overflow-hidden rounded-lg transition-colors group-hover:border-primary/70">
                          <CardContent className="p-2">
                            <div className="flex aspect-square items-center justify-center overflow-hidden rounded-md bg-muted">
                              {category.image ? (
                                <img
                                  src={normalizeImageUrl(category.image)}
                                  alt={category.name}
                                  className="h-full w-full object-cover"
                                />
                              ) : (
                                <Icon className="h-8 w-8 text-muted-foreground" />
                              )}
                            </div>
                            <p className="mt-2 line-clamp-2 text-center text-xs font-medium leading-tight">
                              {category.name}
                            </p>
                          </CardContent>
                        </Card>
                      </Link>
                    );
                  })}
            </div>
          </div>
        </div>
      </section>

      {monthlyCarouselBanners === undefined ? (
        <section className="container py-6">
          <Skeleton className="h-52 w-full rounded-lg" />
        </section>
      ) : monthlyCarouselBanners.length > 0 ? (
        <section className="container py-6">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-xl font-semibold">Monthly Specials</h2>
            <Badge variant="secondary">Carousel</Badge>
          </div>
          <div className="flex snap-x gap-4 overflow-x-auto pb-1">
            {monthlyCarouselBanners.slice(0, 5).map((banner) => (
              <Link
                key={banner._id}
                href={banner.targetUrl || ROUTES.BROWSE}
                className="min-w-[82vw] snap-start sm:min-w-[520px] lg:min-w-[640px]"
              >
                <Card className="overflow-hidden rounded-lg">
                  <CardContent className="p-0">
                    <div className="relative h-52 overflow-hidden bg-muted">
                      <img
                        src={normalizeImageUrl(banner.imageUrl)}
                        alt={banner.title}
                        className="h-full w-full object-cover"
                      />
                      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-5 text-white">
                        <h3 className="max-w-xl text-2xl font-semibold">
                          {banner.title}
                        </h3>
                        {banner.subtitle ? (
                          <p className="mt-1 max-w-xl text-sm text-white/85">
                            {banner.subtitle}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {stripBanners && stripBanners.length > 0 ? (
        <section className="container pb-6">
          {stripBanners.slice(0, 1).map((banner) => (
            <Link key={banner._id} href={banner.targetUrl || ROUTES.BROWSE}>
              <div className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3">
                <Tag className="h-5 w-5 text-primary" />
                <div className="min-w-0">
                  <p className="font-medium">{banner.title}</p>
                  {banner.subtitle ? (
                    <p className="truncate text-sm text-muted-foreground">
                      {banner.subtitle}
                    </p>
                  ) : null}
                </div>
              </div>
            </Link>
          ))}
        </section>
      ) : null}

      <section className="border-y bg-muted/25 py-8">
        <div className="container">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-xl font-semibold">Deals of the Day</h2>
              <p className="text-sm text-muted-foreground">
                Current specials and limited-time offers.
              </p>
            </div>
            <Button variant="ghost" size="sm" asChild>
              <Link href={ROUTES.BROWSE}>
                See All
                <ChevronRight className="ml-1 h-4 w-4" />
              </Link>
            </Button>
          </div>

          {deals === undefined ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 3 }).map((_, index) => (
                <Skeleton key={index} className="h-28 rounded-lg" />
              ))}
            </div>
          ) : dealProducts !== undefined && dealProducts.length > 0 ? (
            <ProductGrid products={dealProducts} columns={4} />
          ) : deals.length > 0 ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {deals.map((deal) => (
                <Card key={deal._id} className="rounded-lg">
                  <CardContent className="flex items-center gap-4 p-4">
                    <div className="flex h-12 w-12 items-center justify-center rounded-md bg-primary/10">
                      <Tag className="h-6 w-6 text-primary" />
                    </div>
                    <div className="min-w-0">
                      <h3 className="truncate font-semibold">{deal.name}</h3>
                      <p className="text-sm text-muted-foreground">
                        {formatPromotionDiscount(deal)}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <Card className="rounded-lg">
              <CardContent className="flex items-center gap-3 p-4 text-sm text-muted-foreground">
                <Tag className="h-5 w-5" />
                No Deal of the Day promotions are active right now.
              </CardContent>
            </Card>
          )}
        </div>
      </section>

      <section className="container py-8">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold">Recommended For You</h2>
            <p className="text-sm text-muted-foreground">
              Browse more products to get personalized recommendations.
            </p>
          </div>
          <Button variant="ghost" size="sm" asChild>
            <Link href={ROUTES.BROWSE}>
              See All
              <ChevronRight className="ml-1 h-4 w-4" />
            </Link>
          </Button>
        </div>
        <ProductGrid products={recentProducts} columns={4} />
      </section>
    </main>
  );
}
