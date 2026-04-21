"use client";

import { useState } from "react";
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
import { formatZMW } from "@gettitonline/shared";
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
  const managesCurrentStoreProduct = Boolean(
    canManageCatalog(user?.role) && product?.seller?.isCompanyStore
  );
  const isOwnProduct = Boolean(
    user?._id === product?.sellerId || managesCurrentStoreProduct
  );

  // Increment views on mount
  // useEffect(() => {
  //   if (product?._id) {
  //     incrementViews({ productId: product._id });
  //   }
  // }, [product?._id]);

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

  const handleAddToCart = async () => {
    if (!product) {
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
        });
      } else {
        addGuestCartItem({
          productId: product._id,
          quantity,
          selectedShipping: {
            name: shipping.name,
            price: shipping.price,
          },
          product: {
            _id: product._id,
            sellerId: product.sellerId,
            sellerName: product.seller?.displayName || "Gettitonline",
            title: product.title,
            price: product.price,
            images: product.images,
            quantity: product.quantity,
            status: product.status,
            shippingOptions: product.shippingOptions ?? [],
          },
          addedAt: Date.now(),
        });
      }

      toast.success("Added to cart!");
      return true;
    } catch {
      toast.error("Failed to add to cart");
      return false;
    }
  };

  const handleBuyNow = async () => {
    const addedToCart = await handleAddToCart();
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

  const images = product.images?.length ? product.images : ["/placeholder.png"];

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
              <h1 className="text-2xl font-bold lg:text-3xl">{product.title}</h1>
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
          <p className="mt-4 text-3xl font-bold text-primary">
            {formatZMW(product.price)}
          </p>

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
          </div>

          <Separator className="my-6" />

          {/* Quantity & Shipping */}
          <div className="space-y-4">
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
                    setQuantity(Math.min(product.quantity || 1, quantity + 1))
                  }
                  disabled={quantity >= (product.quantity || 1)}
                >
                  +
                </Button>
                <span className="text-sm text-muted-foreground">
                  {product.quantity} available
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
          </div>

          {/* Action Buttons */}
          {!isOwnProduct ? (
            <div className="mt-6 flex gap-3">
              <Button size="lg" className="flex-1 gap-2" onClick={handleAddToCart}>
                <ShoppingCart className="h-5 w-5" />
                Add to Cart
              </Button>
              <Button
                size="lg"
                variant="secondary"
                className="flex-1"
                onClick={handleBuyNow}
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

      {/* Description & Specifications */}
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

        {/* Specifications */}
        {product.specifications && product.specifications.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Specifications</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="space-y-2">
                {product.specifications.map((spec, index) => (
                  <div
                    key={index}
                    className="flex justify-between border-b py-2 last:border-0"
                  >
                    <dt className="text-muted-foreground">{spec.key}</dt>
                    <dd className="font-medium">{spec.value}</dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>
        )}
      </div>

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
