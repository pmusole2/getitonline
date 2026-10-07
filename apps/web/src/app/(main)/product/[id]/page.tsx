"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../../../../../convex/_generated/api";
import { Id } from "../../../../../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  Heart,
  Share2,
  ShoppingCart,
  MessageSquare,
  Shield,
  MapPin,
  Eye,
  Clock,
  Star,
  ChevronLeft,
  ChevronRight,
  Package,
} from "lucide-react";
import { ROUTES, CONDITION_DISPLAY_NAMES } from "@/lib/constants";
import { createCartCustomizationKey, formatZMW } from "@gettitonline/shared";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";
import { ProductGrid } from "@/components/product/ProductGrid";
import { formatDistanceToNow } from "date-fns";
import { useGuestCart } from "@/providers/GuestCartProvider";
import { canManageCatalog } from "@/lib/roles";

export default function ProductDetailPage() {
  const params = useParams();
  const router = useRouter();
  const productId = params.id as Id<"products">;
  const { user, isSignedIn } = useAuth();
  const { addItem: addGuestCartItem } = useGuestCart();

  const [selectedImage, setSelectedImage] = useState(0);
  const [selectedShipping, setSelectedShipping] = useState<string>("");
  const [quantity, setQuantity] = useState(1);
  const [selectedAttributes, setSelectedAttributes] = useState<Record<string, string>>({});
  const [cartDialogOpen, setCartDialogOpen] = useState(false);

  // Get product details
  const product = useQuery(api.products.getProduct, {
    productId,
    viewerUserId: user?._id,
  });

  // Check if favorited
  const isFavorited = useQuery(
    api.favorites.isFavorited,
    user?._id && product?._id
      ? { userId: user._id, productId: product._id }
      : "skip"
  );

  // Get similar products
  const similarProducts = useQuery(
    api.products.getProductsByCategory,
    product?.categoryId
      ? { categoryId: product.categoryId, limit: 4 }
      : "skip"
  );

  // Mutations
  const toggleFavorite = useMutation(api.favorites.toggleFavorite);
  const addToCart = useMutation(api.cart.addToCart);
  const incrementViews = useMutation(api.products.incrementViews);
  const recordBehaviorEvent = useMutation(api.notifications.recordBehaviorEvent);
  const managesCurrentStoreProduct = Boolean(
    canManageCatalog(user?.role) && product?.seller?.isCompanyStore
  );
  const isOwnProduct = Boolean(
    user?._id === product?.sellerId || managesCurrentStoreProduct
  );

  const variantCombinations = useMemo(
    () => product?.variantCombinations ?? [],
    [product?.variantCombinations]
  );
  const variantAttributes = useMemo(() => {
    if (!product) return [];
    if (product.variantAttributes?.length) return product.variantAttributes;

    const attributes = new Map<string, Set<string>>();
    for (const combination of variantCombinations) {
      for (const attribute of combination.attributes) {
        const values = attributes.get(attribute.name) ?? new Set<string>();
        values.add(attribute.value);
        attributes.set(attribute.name, values);
      }
    }

    return Array.from(attributes.entries()).map(([name, values]) => ({
      name,
      values: Array.from(values),
    }));
  }, [product, variantCombinations]);
  const selectedVariant = useMemo(() => {
    const selectedNames = Object.keys(selectedAttributes);
    if (!variantCombinations.length || selectedNames.length !== variantAttributes.length) {
      return null;
    }

    return (
      variantCombinations.find((combination) =>
        variantAttributes.every((attribute) =>
          combination.attributes.some(
            (candidate) =>
              candidate.name === attribute.name &&
              candidate.value === selectedAttributes[attribute.name]
          )
        )
      ) ?? null
    );
  }, [selectedAttributes, variantAttributes, variantCombinations]);
  const selectedVariantSnapshot = selectedVariant
    ? {
        variantId: selectedVariant.id,
        sku: selectedVariant.sku,
        attributes: selectedVariant.attributes,
        price: selectedVariant.price,
        image: selectedVariant.primaryImage,
      }
    : undefined;
  const selectedStock = selectedVariant ? selectedVariant.stock : product?.quantity ?? 0;
  const displayPrice = selectedVariant?.price ?? product?.price ?? 0;
  const images = selectedVariant
    ? [
        selectedVariant.primaryImage,
        ...(selectedVariant.galleryImages ?? []),
        ...(product?.images ?? []),
      ].filter((image): image is string => Boolean(image))
    : product?.images?.length
      ? product.images
      : ["/placeholder.png"];

  useEffect(() => {
    setSelectedImage(0);
  }, [selectedVariant?.id, product?._id]);

  useEffect(() => {
    setQuantity((current) => Math.min(Math.max(current, 1), Math.max(selectedStock, 1)));
  }, [selectedStock]);

  useEffect(() => {
    if (!product?._id || isOwnProduct) return;

    void incrementViews({ productId: product._id });
    void recordBehaviorEvent({
      userId: user?._id,
      eventType: "product_view",
      productId: product._id,
      categoryId: product.categoryId,
    });
  }, [incrementViews, isOwnProduct, product?._id, product?.categoryId, recordBehaviorEvent, user?._id]);

  useEffect(() => {
    if (!product?._id || isOwnProduct) return;

    const startedAt = Date.now();
    return () => {
      const durationMs = Date.now() - startedAt;
      if (durationMs < 1000) return;
      void recordBehaviorEvent({
        userId: user?._id,
        eventType: "product_time_spent",
        productId: product._id,
        categoryId: product.categoryId,
        durationMs,
      });
    };
  }, [isOwnProduct, product?._id, product?.categoryId, recordBehaviorEvent, user?._id]);

  const handleFavoriteClick = async () => {
    if (!isSignedIn || !user || !product) {
      toast.error("Please sign in to save favorites");
      return;
    }

    try {
      await toggleFavorite({ userId: user._id, productId: product._id });
      toast.success(
        isFavorited ? "Removed from favorites" : "Added to favorites"
      );
    } catch {
      toast.error("Failed to update favorites");
    }
  };

  const handleAddToCart = async (showCartDialog = true) => {
    if (!product) {
      return false;
    }

    if (variantCombinations.length > 0 && !selectedVariantSnapshot) {
      toast.error("Please select product options");
      return false;
    }

    if (selectedVariant && (selectedVariant.status !== "active" || selectedVariant.stock <= 0)) {
      toast.error("Selected variant is out of stock");
      return false;
    }

    if (!selectedShipping && product.shippingOptions?.length) {
      toast.error("Please select a shipping option");
      return false;
    }

    const shipping = product.shippingOptions?.find(
      (s) => s.name === selectedShipping
    ) || { name: "Standard", price: 0 };

    try {
      if (isSignedIn && user) {
        await addToCart({
          userId: user._id,
          productId: product._id,
          quantity,
          selectedShipping: {
            name: shipping.name,
            price: shipping.price,
          },
          selectedVariant: selectedVariantSnapshot,
        });
      } else {
        const customizationKey = createCartCustomizationKey({
          productId: product._id,
          selectedVariant: selectedVariantSnapshot,
        });

        addGuestCartItem({
          productId: product._id,
          quantity,
          selectedShipping: {
            name: shipping.name,
            price: shipping.price,
          },
          selectedVariant: selectedVariantSnapshot,
          customizationKey,
          product: {
            _id: product._id,
            sellerId: product.sellerId,
            sellerName: product.seller?.displayName || "Gettitonline",
            title: product.title,
            price: displayPrice,
            images,
            quantity: selectedStock,
            status: product.status,
            shippingOptions: product.shippingOptions ?? [],
          },
          addedAt: Date.now(),
        });
      }

      toast.success("Added to cart!");
      if (showCartDialog) {
        setCartDialogOpen(true);
      }
      return true;
    } catch {
      toast.error("Failed to add to cart");
      return false;
    }
  };

  const handleBuyNow = async () => {
    const addedToCart = await handleAddToCart(false);
    if (addedToCart) {
      router.push(ROUTES.CART);
    }
  };

  if (product === undefined) {
    return <ProductDetailSkeleton />;
  }

  if (product === null) {
    return (
      <div className="container flex flex-col items-center justify-center py-16">
        <Package className="h-16 w-16 text-muted-foreground" />
        <h1 className="mt-4 text-2xl font-bold">Product Not Found</h1>
        <p className="mt-2 text-muted-foreground">
          This product may have been removed or is no longer available.
        </p>
        <Button asChild className="mt-6">
          <Link href={ROUTES.BROWSE}>Browse Products</Link>
        </Button>
      </div>
    );
  }

  const hasDiscount =
    product.compareAtPrice !== undefined &&
    product.compareAtPrice > displayPrice;
  const discountPercent = hasDiscount
    ? Math.round(((product.compareAtPrice! - displayPrice) / product.compareAtPrice!) * 100)
    : 0;
  const isVariantProduct = variantCombinations.length > 0;
  const selectedSku = selectedVariant?.sku ?? product.sku;
  const stockLabel = isVariantProduct && !selectedVariant ? "Select options" : `${selectedStock} available`;
  const sellerDisplayName = product.seller?.displayName || product.seller?.firstName || "Gettitonline";
  const warrantySummary = product.warranty
    ? [
        product.warranty.type === "none" ? "No warranty" : product.warranty.type,
        product.warranty.durationDays ? `${product.warranty.durationDays} days` : undefined,
        product.warranty.provider,
      ]
        .filter(Boolean)
        .join(" • ")
    : undefined;
  const canSelectVariantValue = (attributeName: string, value: string) => {
    if (!isVariantProduct) return true;

    const nextSelection = { ...selectedAttributes, [attributeName]: value };
    return variantCombinations.some(
      (combination) =>
        combination.status === "active" &&
        combination.stock > 0 &&
        variantAttributes.every((attribute) => {
          const selectedValue = nextSelection[attribute.name];
          if (!selectedValue) return true;
          return combination.attributes.some(
            (candidate) =>
              candidate.name === attribute.name && candidate.value === selectedValue
          );
        })
      );
  };
  const productDetailRows = [
    product.brand ? { label: "Brand", value: product.brand } : null,
    product.classification ? { label: "Classification", value: product.classification.name } : null,
    product.modelNumber ? { label: "Model", value: product.modelNumber } : null,
    selectedSku ? { label: "SKU", value: selectedSku } : null,
    product.color ? { label: "Color", value: product.color } : null,
    product.material ? { label: "Material", value: product.material } : null,
    product.countryOfOrigin ? { label: "Country of origin", value: product.countryOfOrigin } : null,
    { label: "Condition", value: CONDITION_DISPLAY_NAMES[product.condition] },
    product.availabilityStatus
      ? { label: "Availability", value: product.availabilityStatus.replace(/_/g, " ") }
      : null,
    { label: "Stock", value: stockLabel },
    warrantySummary ? { label: "Warranty", value: warrantySummary } : null,
    ...(product.specifications ?? []).map((spec) => ({ label: spec.key, value: spec.value })),
  ].filter((row): row is { label: string; value: string } => Boolean(row?.label && row.value));

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
            <BreadcrumbPage className="max-w-[200px] truncate">
              {product.title}
            </BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="grid gap-8 lg:grid-cols-2">
        {/* Image Gallery */}
        <div>
          <div className="relative aspect-square overflow-hidden rounded-lg bg-muted">
            <img
              src={images[selectedImage]}
              alt={product.title}
              className="h-full w-full object-contain"
            />
            {hasDiscount && (
              <Badge variant="destructive" className="absolute right-3 top-3">
                {discountPercent}% OFF
              </Badge>
            )}

            {/* Navigation Arrows */}
            {images.length > 1 && (
              <>
                <Button
                  variant="secondary"
                  size="icon"
                  className="absolute left-2 top-1/2 -translate-y-1/2"
                  onClick={() =>
                    setSelectedImage((prev) =>
                      prev === 0 ? images.length - 1 : prev - 1
                    )
                  }
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="secondary"
                  size="icon"
                  className="absolute right-2 top-1/2 -translate-y-1/2"
                  onClick={() =>
                    setSelectedImage((prev) =>
                      prev === images.length - 1 ? 0 : prev + 1
                    )
                  }
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </>
            )}

            {/* Image Counter */}
            {images.length > 1 && (
              <div className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-black/50 px-2 py-1 text-xs text-white">
                {selectedImage + 1} / {images.length}
              </div>
            )}
          </div>

          {/* Thumbnails */}
          {images.length > 1 && (
            <div className="mt-4 flex gap-2 overflow-x-auto">
              {images.map((image, index) => (
                <button
                  key={index}
                  onClick={() => setSelectedImage(index)}
                  className={`h-20 w-20 shrink-0 overflow-hidden rounded-lg border-2 transition-colors ${
                    selectedImage === index
                      ? "border-primary"
                      : "border-transparent hover:border-muted-foreground/50"
                  }`}
                >
                  <img
                    src={image}
                    alt={`${product.title} ${index + 1}`}
                    className="h-full w-full object-cover"
                  />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Product Info */}
        <div>
          <div className="flex items-start justify-between gap-4">
            <div>
              <Badge className="mb-2">
                {CONDITION_DISPLAY_NAMES[product.condition]}
              </Badge>
              {product.brand && (
                <Link
                  href={`${ROUTES.SEARCH}?brand=${encodeURIComponent(product.brand)}`}
                  className="mb-1 block text-sm font-medium text-primary hover:underline"
                >
                  {product.brand}
                </Link>
              )}
              {product.seller && (
                <p className="mb-2 text-sm text-muted-foreground">
                  Sold by{" "}
                  <Link href={ROUTES.SELLER(product.seller._id)} className="font-medium text-primary hover:underline">
                    {sellerDisplayName}
                  </Link>
                </p>
              )}
              <h1 className="text-2xl font-bold lg:text-3xl">{product.title}</h1>
              {product.shortDescription && (
                <p className="mt-2 max-w-xl text-muted-foreground">
                  {product.shortDescription}
                </p>
              )}
            </div>
            <div className="flex gap-2">
              {!isOwnProduct && (
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handleFavoriteClick}
                >
                  <Heart
                    className={`h-5 w-5 ${
                      isFavorited ? "fill-red-500 text-red-500" : ""
                    }`}
                  />
                </Button>
              )}
              <Button variant="outline" size="icon">
                <Share2 className="h-5 w-5" />
              </Button>
            </div>
          </div>

          {/* Price */}
          <div className="mt-4 flex flex-wrap items-baseline gap-3">
            <p className="text-3xl font-bold text-foreground">
              {formatZMW(displayPrice)}
            </p>
            {hasDiscount && (
              <p className="text-lg text-muted-foreground line-through">
                {formatZMW(product.compareAtPrice!)}
              </p>
            )}
          </div>

          {/* Stats */}
          <div className="mt-4 flex flex-wrap gap-4 text-sm text-muted-foreground">
            {product.location?.city && (
              <span className="flex items-center gap-1">
                <MapPin className="h-4 w-4" />
                {product.location.city}, {product.location.province}
              </span>
            )}
            <span className="flex items-center gap-1">
              <Eye className="h-4 w-4" />
              {product.views || 0} views
            </span>
            <span className="flex items-center gap-1">
              <Clock className="h-4 w-4" />
              {formatDistanceToNow(product.createdAt, { addSuffix: true })}
            </span>
            {selectedSku && <span>SKU: {selectedSku}</span>}
          </div>

          <Separator className="my-6" />

          {/* Quantity & Shipping */}
          <div className="space-y-4">
            {variantAttributes.length > 0 && (
              <div className="space-y-4">
                {variantAttributes.map((attribute) => (
                  <div key={attribute.name}>
                    <label className="text-sm font-medium">{attribute.name}</label>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {attribute.values.map((value) => {
                        const isSelected = selectedAttributes[attribute.name] === value;
                        const isAvailable = canSelectVariantValue(attribute.name, value);

                        return (
                          <Button
                            key={`${attribute.name}-${value}`}
                            type="button"
                            variant={isSelected ? "default" : "outline"}
                            size="sm"
                            disabled={!isAvailable}
                            onClick={() =>
                              setSelectedAttributes((current) => ({
                                ...current,
                                [attribute.name]: value,
                              }))
                            }
                          >
                            {value}
                          </Button>
                        );
                      })}
                    </div>
                  </div>
                ))}
                {isVariantProduct && !selectedVariant && (
                  <p className="text-sm text-muted-foreground">
                    Select all product options to confirm price and availability.
                  </p>
                )}
              </div>
            )}

            {/* Quantity */}
            <div>
              <label className="text-sm font-medium">Quantity</label>
              <div className="mt-1 flex items-center gap-2">
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => setQuantity(Math.max(1, quantity - 1))}
                  disabled={quantity <= 1}
                >
                  -
                </Button>
                <span className="w-12 text-center">{quantity}</span>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() =>
                    setQuantity(Math.min(selectedStock || 1, quantity + 1))
                  }
                  disabled={quantity >= (selectedStock || 1) || (isVariantProduct && !selectedVariant)}
                >
                  +
                </Button>
                <span className="text-sm text-muted-foreground">
                  {stockLabel}
                </span>
              </div>
            </div>

            {/* Shipping Options */}
            {product.shippingOptions && product.shippingOptions.length > 0 && (
              <div>
                <label className="text-sm font-medium">Shipping Option</label>
                <Select
                  value={selectedShipping}
                  onValueChange={setSelectedShipping}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Select shipping" />
                  </SelectTrigger>
                  <SelectContent>
                    {product.shippingOptions.map((option) => (
                      <SelectItem key={option.name} value={option.name}>
                        <div className="flex items-center justify-between gap-4">
                          <span>{option.name}</span>
                          <span className="text-muted-foreground">
                            {formatZMW(option.price)} • {option.estimatedDays}
                          </span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {product.keyFeatures && product.keyFeatures.length > 0 && (
              <div>
                <p className="text-sm font-medium">Key Features</p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                  {product.keyFeatures.map((feature, index) => (
                    <li key={`${feature}-${index}`}>{feature}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Action Buttons */}
          {!isOwnProduct ? (
            <div className="mt-6 flex gap-3">
              <Button
                size="lg"
                className="flex-1 gap-2"
                onClick={() => void handleAddToCart()}
                disabled={selectedStock <= 0 || (isVariantProduct && !selectedVariant)}
              >
                <ShoppingCart className="h-5 w-5" />
                Add to Cart
              </Button>
              <Button
                size="lg"
                variant="secondary"
                className="flex-1"
                onClick={handleBuyNow}
                disabled={selectedStock <= 0 || (isVariantProduct && !selectedVariant)}
              >
                Buy Now
              </Button>
            </div>
          ) : (
            <Card className="mt-6 border-dashed">
              <CardContent className="p-4 text-sm text-muted-foreground">
                Catalog managers can edit this store item from the catalog dashboard instead of purchasing it.
              </CardContent>
            </Card>
          )}

          {/* Escrow Info */}
          <Card className="mt-6 bg-green-50 dark:bg-green-950/20">
            <CardContent className="flex items-start gap-3 p-4">
              <Shield className="h-5 w-5 shrink-0 text-green-600" />
              <div>
                <p className="font-medium text-green-800 dark:text-green-400">
                  Protected by Escrow
                </p>
                <p className="text-sm text-green-700 dark:text-green-500">
                  Your payment is held securely until you confirm receipt of
                  your order.
                </p>
              </div>
            </CardContent>
          </Card>

          <Separator className="my-6" />

          {/* Store Card */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Store</CardTitle>
            </CardHeader>
            <CardContent>
              {product.seller ? (
                <div className="flex items-center gap-4">
                  <Avatar className="h-12 w-12">
                    <AvatarImage src={product.seller.avatar} />
                    <AvatarFallback>
                      {product.seller.displayName?.[0] || product.seller.firstName?.[0]}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1">
                    <Link
                      href={ROUTES.SELLER(product.seller._id)}
                      className="font-medium hover:underline"
                    >
                      {product.seller.displayName || product.seller.firstName}
                    </Link>
                    <p className="text-sm text-muted-foreground">
                      {product.seller.isCompanyStore
                        ? "Official Gettitonline store"
                        : "Approved vendor storefront"}
                    </p>
                    {product.seller.rating && (
                      <div className="flex items-center gap-1 text-sm text-muted-foreground">
                        <Star className="h-4 w-4 fill-yellow-400 text-yellow-400" />
                        {product.seller.rating.toFixed(1)}
                      </div>
                    )}
                  </div>
                  <Button variant="outline" size="sm" asChild>
                    <Link href={ROUTES.SELLER(product.seller._id)}>
                      Visit Store
                    </Link>
                  </Button>
                </div>
              ) : (
                <Skeleton className="h-12 w-full" />
              )}

              {!isOwnProduct && (
                <Button className="mt-4 w-full gap-2" variant="outline" asChild>
                  <Link href={`${ROUTES.MESSAGES}?product=${product._id}`}>
                    <MessageSquare className="h-4 w-4" />
                    Contact Store
                  </Link>
                </Button>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Description & Product Details */}
      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        {/* Description */}
        <Card>
          <CardHeader>
            <CardTitle>Description</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-muted-foreground">
              {product.description}
            </p>
          </CardContent>
        </Card>

        {productDetailRows.length > 0 && (
          <Card>
            <CardContent>
              <details open className="group">
                <summary className="cursor-pointer list-none py-2 text-lg font-semibold">
                  Product Details
                </summary>
                <dl className="mt-2 divide-y">
                  {productDetailRows.map((row) => (
                    <div key={`${row.label}-${row.value}`} className="grid grid-cols-2 gap-4 py-3">
                      <dt className="text-muted-foreground">{row.label}</dt>
                      <dd className="text-right font-medium">{row.value}</dd>
                    </div>
                  ))}
                </dl>
              </details>
            </CardContent>
          </Card>
        )}
      </div>

      <Dialog open={cartDialogOpen} onOpenChange={setCartDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Added to cart</DialogTitle>
            <DialogDescription>
              Review your cart or continue shopping.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setCartDialogOpen(false)}>
              Continue
            </Button>
            <Button onClick={() => router.push(ROUTES.CART)}>
              Proceed to Cart
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Similar Products */}
      {similarProducts && similarProducts.items && similarProducts.items.length > 1 && (
        <div className="mt-12">
          <h2 className="mb-6 text-2xl font-bold">Similar Products</h2>
          <ProductGrid
            products={similarProducts.items.filter((p) => p._id !== product._id)}
            columns={4}
          />
        </div>
      )}
    </div>
  );
}

function ProductDetailSkeleton() {
  return (
    <div className="container py-6">
      <Skeleton className="mb-6 h-4 w-64" />
      <div className="grid gap-8 lg:grid-cols-2">
        <Skeleton className="aspect-square rounded-lg" />
        <div className="space-y-4">
          <Skeleton className="h-8 w-3/4" />
          <Skeleton className="h-10 w-1/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="mt-6 h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      </div>
    </div>
  );
}
