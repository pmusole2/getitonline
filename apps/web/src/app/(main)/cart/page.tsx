"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../../../../convex/_generated/api";
import { Id } from "../../../../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Trash2,
  Plus,
  Minus,
  ShoppingBag,
  AlertTriangle,
  Shield,
  Truck,
} from "lucide-react";
import { ROUTES } from "@/lib/constants";
import { formatZMW } from "@gettitonline/shared";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";
import { useGuestCart } from "@/providers/GuestCartProvider";

interface SelectedVariant {
  variantId?: string;
  sku?: string;
  attributes: Array<{ name: string; value: string }>;
  price?: number;
  image?: string;
}

interface CartLineItem {
  key: string;
  cartItemId?: Id<"cartItems">;
  productId: string;
  quantity: number;
  selectedShipping: { name: string; price: number };
  selectedVariant?: SelectedVariant;
  selectedVariantOptions?: Array<{ name: string; value: string; sku?: string; priceDelta?: number }>;
  selectedAddOns?: Array<{ name: string; description?: string; price: number }>;
  lineUnitPrice: number;
  product: {
    _id: string;
    title: string;
    price: number;
    images: string[];
    quantity: number;
    sellerName: string;
    shippingOptions?: Array<{
      name: string;
      price: number;
      estimatedDays?: string;
    }>;
  };
}

export default function CartPage() {
  const router = useRouter();
  const { user, isSignedIn, isLoading: authLoading } = useAuth();
  const {
    items: guestCartItems,
    summary: guestCartSummary,
    isHydrated: guestCartHydrated,
    isMerging: guestCartMerging,
    hasPendingMerge,
    updateQuantity: updateGuestQuantity,
    updateShipping: updateGuestShipping,
    removeItem: removeGuestItem,
    clear: clearGuestCart,
  } = useGuestCart();
  const [removingItems, setRemovingItems] = useState<Set<string>>(new Set());

  // Get cart data
  const cart = useQuery(
    api.cart.getCart,
    user?._id ? {} : "skip"
  );

  // Validate cart
  const validation = useQuery(
    api.cart.validateCart,
    user?._id ? {} : "skip"
  );

  // Mutations
  const updateQuantity = useMutation(api.cart.updateCartQuantity);
  const updateShipping = useMutation(api.cart.updateCartShipping);
  const removeFromCart = useMutation(api.cart.removeFromCart);
  const clearCart = useMutation(api.cart.clearCart);

  const cartItems: CartLineItem[] = isSignedIn
    ? ((cart?.items ?? []) as Array<{
        _id: string;
        productId: string;
        quantity: number;
        selectedShipping: { name: string; price: number };
        selectedVariant?: SelectedVariant;
        selectedVariantOptions?: Array<{ name: string; value: string; sku?: string; priceDelta?: number }>;
        selectedAddOns?: Array<{ name: string; description?: string; price: number }>;
        lineUnitPrice?: number;
        product: {
          _id: string;
          title: string;
          price: number;
          images: string[];
          quantity: number;
          sellerName: string;
          shippingOptions?: Array<{
            name: string;
            price: number;
            estimatedDays?: string;
          }>;
        };
      }>).map((item) => ({
        key: item._id,
        cartItemId: item._id as Id<"cartItems">,
        productId: item.productId,
        quantity: item.quantity,
        selectedShipping: item.selectedShipping,
        selectedVariant: item.selectedVariant,
        selectedVariantOptions: item.selectedVariantOptions,
        selectedAddOns: item.selectedAddOns,
        lineUnitPrice: item.lineUnitPrice ?? item.product.price,
        product: item.product,
      }))
    : guestCartItems.map((item) => ({
        key: item.customizationKey ?? item.productId,
        productId: item.productId,
        quantity: item.quantity,
        selectedShipping: item.selectedShipping,
        selectedVariant: item.selectedVariant,
        selectedVariantOptions: item.selectedVariantOptions,
        selectedAddOns: item.selectedAddOns,
        lineUnitPrice: item.product.price,
        product: item.product,
      }));
  const cartSummary = isSignedIn
    ? {
        subtotal: cart?.subtotal ?? 0,
        shippingTotal: cart?.shippingTotal ?? 0,
        total: cart?.total ?? 0,
        itemCount: cart?.itemCount ?? 0,
      }
    : guestCartSummary;

  const handleQuantityChange = async (item: CartLineItem, newQuantity: number) => {
    if (!isSignedIn) {
      updateGuestQuantity(item.key, newQuantity);
      return;
    }

    if (!user || !item.cartItemId) return;

    try {
      await updateQuantity({
        cartItemId: item.cartItemId,
        quantity: newQuantity,
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : "Failed to update quantity";
      toast.error(errorMessage);
    }
  };

  const handleShippingChange = async (
    item: CartLineItem,
    shippingName: string,
    shippingPrice: number
  ) => {
    if (!isSignedIn) {
      updateGuestShipping(item.key, {
        name: shippingName,
        price: shippingPrice,
      });
      return;
    }

    if (!user || !item.cartItemId) return;

    try {
      await updateShipping({
        cartItemId: item.cartItemId,
        selectedShipping: { name: shippingName, price: shippingPrice },
      });
    } catch {
      toast.error("Failed to update shipping option");
    }
  };

  const handleRemoveItem = async (item: CartLineItem) => {
    if (!isSignedIn) {
      removeGuestItem(item.key);
      toast.success("Item removed from cart");
      return;
    }

    if (!user || !item.cartItemId) return;

    setRemovingItems((prev) => new Set(prev).add(item.key));

    try {
      await removeFromCart({ cartItemId: item.cartItemId });
      toast.success("Item removed from cart");
    } catch {
      toast.error("Failed to remove item");
    } finally {
      setRemovingItems((prev) => {
        const next = new Set(prev);
        next.delete(item.key);
        return next;
      });
    }
  };

  const handleClearCart = async () => {
    if (!isSignedIn) {
      clearGuestCart();
      toast.success("Cart cleared");
      return;
    }

    if (!user) return;

    try {
      await clearCart({});
      toast.success("Cart cleared");
    } catch {
      toast.error("Failed to clear cart");
    }
  };

  const handleProceedToCheckout = () => {
    if (!isSignedIn) {
      router.push(
        `${ROUTES.SIGN_IN}?redirect_url=${encodeURIComponent(ROUTES.CHECKOUT)}`
      );
      return;
    }

    if (validation && !validation.isValid) {
      toast.error("Please resolve cart issues before checkout");
      return;
    }
    router.push(ROUTES.CHECKOUT);
  };

  // Loading state
  if (
    !guestCartHydrated ||
    authLoading ||
    (isSignedIn &&
      (cart === undefined || guestCartMerging || hasPendingMerge))
  ) {
    return <CartSkeleton />;
  }

  // Empty cart
  if (cartItems.length === 0) {
    return (
      <div className="container flex flex-col items-center justify-center py-16">
        <ShoppingBag className="h-16 w-16 text-muted-foreground" />
        <h1 className="mt-4 text-2xl font-bold">Your cart is empty</h1>
        <p className="mt-2 text-muted-foreground">
          Browse our marketplace to find great deals
        </p>
        <Button asChild className="mt-6">
          <Link href={ROUTES.BROWSE}>Browse Products</Link>
        </Button>
      </div>
    );
  }

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
            <BreadcrumbPage>Shopping Cart</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">
          Shopping Cart ({cartSummary.itemCount} {cartSummary.itemCount === 1 ? "item" : "items"})
        </h1>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="sm" className="text-destructive">
              Clear Cart
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Clear your cart?</AlertDialogTitle>
              <AlertDialogDescription>
                This will remove all items from your cart. This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleClearCart}>
                Clear Cart
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {/* Validation Issues */}
      {isSignedIn && validation && !validation.isValid && (
        <Alert variant="destructive" className="mb-6">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            <strong>Some items in your cart have issues:</strong>
            <ul className="mt-2 list-disc list-inside">
              {validation.issues.map((issue, index) => (
                <li key={index}>{issue.issue}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Cart Items */}
        <div className="lg:col-span-2 space-y-4">
          {cartItems.map((item) => (
            <Card key={item.key} className={removingItems.has(item.key) ? "opacity-50" : ""}>
              <CardContent className="p-4">
                <div className="flex gap-4">
                  {/* Product Image */}
                  <Link href={ROUTES.PRODUCT(item.product._id)} className="shrink-0">
                    <div className="h-24 w-24 overflow-hidden rounded-lg bg-muted">
                      <img
                        src={item.selectedVariant?.image || item.product.images?.[0] || "/placeholder.png"}
                        alt={item.product.title}
                        className="h-full w-full object-contain"
                      />
                    </div>
                  </Link>

                  {/* Product Details */}
                  <div className="flex-1 min-w-0">
                    <Link
                      href={ROUTES.PRODUCT(item.product._id)}
                      className="font-medium hover:underline line-clamp-2"
                    >
                      {item.product.title}
                    </Link>
                    <p className="text-sm text-muted-foreground mt-1">
                      Store: {item.product.sellerName}
                    </p>
                    <p className="font-semibold text-primary mt-2">
                      {formatZMW(item.lineUnitPrice)}
                    </p>
                    {item.selectedVariant?.attributes?.length ? (
                      <p className="mt-1 text-sm text-muted-foreground">
                        {item.selectedVariant.attributes
                          .map((attribute) => `${attribute.name}: ${attribute.value}`)
                          .join(" • ")}
                      </p>
                    ) : null}
                    {item.selectedVariant?.sku ? (
                      <p className="text-xs text-muted-foreground">
                        SKU: {item.selectedVariant.sku}
                      </p>
                    ) : null}
                    {item.selectedVariantOptions && item.selectedVariantOptions.length > 0 ? (
                      <p className="mt-1 text-sm text-muted-foreground">
                        {item.selectedVariantOptions
                          .map((option) => `${option.name}: ${option.value}`)
                          .join(" • ")}
                      </p>
                    ) : null}

                    {/* Shipping Option */}
                    {item.product.shippingOptions && item.product.shippingOptions.length > 0 && (
                      <div className="mt-2">
                        <Select
                          value={item.selectedShipping.name}
                          onValueChange={(value) => {
                            const option = item.product.shippingOptions?.find(
                              (o) => o.name === value
                            );
                            if (option) {
                              handleShippingChange(
                                item,
                                option.name,
                                option.price
                              );
                            }
                          }}
                        >
                          <SelectTrigger className="w-[200px] h-8 text-sm">
                            <Truck className="h-3 w-3 mr-2" />
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {item.product.shippingOptions.map((option) => (
                              <SelectItem key={option.name} value={option.name}>
                                {option.name} - {formatZMW(option.price)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                  </div>

                  {/* Quantity & Remove */}
                  <div className="flex flex-col items-end gap-2">
                    {/* Quantity Controls */}
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-8 w-8"
                          onClick={() =>
                            handleQuantityChange(item, item.quantity - 1)
                          }
                          disabled={item.quantity <= 1}
                      >
                        <Minus className="h-3 w-3" />
                      </Button>
                      <span className="w-8 text-center">{item.quantity}</span>
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-8 w-8"
                          onClick={() =>
                            handleQuantityChange(item, item.quantity + 1)
                          }
                          disabled={item.quantity >= item.product.quantity}
                      >
                        <Plus className="h-3 w-3" />
                      </Button>
                    </div>

                    {/* Stock Warning */}
                    {item.quantity >= item.product.quantity && (
                      <p className="text-xs text-amber-600">Max stock</p>
                    )}

                    {/* Item Total */}
                    <p className="font-semibold">
                      {formatZMW(item.lineUnitPrice * item.quantity)}
                    </p>

                    {/* Remove Button */}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive h-8"
                      onClick={() => handleRemoveItem(item)}
                      disabled={removingItems.has(item.key)}
                    >
                      <Trash2 className="h-4 w-4 mr-1" />
                      Remove
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Order Summary */}
        <div className="lg:col-span-1">
          <Card className="sticky top-4">
            <CardHeader>
              <CardTitle>Order Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Subtotal</span>
                <span>{formatZMW(cartSummary.subtotal)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Shipping</span>
                <span>
                  {cartSummary.shippingTotal > 0 ? formatZMW(cartSummary.shippingTotal) : "Free"}
                </span>
              </div>
              <Separator />
              <div className="flex justify-between font-semibold text-lg">
                <span>Total</span>
                <span className="text-primary">{formatZMW(cartSummary.total)}</span>
              </div>

              {/* Escrow Notice */}
              <div className="rounded-lg bg-green-50 dark:bg-green-950/20 p-3 mt-4">
                <div className="flex gap-2">
                  <Shield className="h-4 w-4 shrink-0 text-green-600 mt-0.5" />
                  <div className="text-sm">
                    <p className="font-medium text-green-800 dark:text-green-400">
                      Secure Escrow Payment
                    </p>
                    <p className="text-green-700 dark:text-green-500 mt-1">
                      Your payment is protected until you confirm receipt
                    </p>
                  </div>
                </div>
              </div>
            </CardContent>
            <CardFooter>
              <Button
                className="w-full"
                size="lg"
                onClick={handleProceedToCheckout}
                disabled={Boolean(isSignedIn && validation && !validation.isValid)}
              >
                {isSignedIn ? "Proceed to Checkout" : "Sign In to Checkout"}
              </Button>
            </CardFooter>
          </Card>
        </div>
      </div>
    </div>
  );
}

function CartSkeleton() {
  return (
    <div className="container py-6">
      <Skeleton className="mb-6 h-4 w-48" />
      <Skeleton className="mb-6 h-8 w-64" />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-4">
                <div className="flex gap-4">
                  <Skeleton className="h-24 w-24 rounded-lg" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-5 w-3/4" />
                    <Skeleton className="h-4 w-1/4" />
                    <Skeleton className="h-5 w-1/3" />
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
        <div className="lg:col-span-1">
          <Skeleton className="h-80 w-full rounded-lg" />
        </div>
      </div>
    </div>
  );
}
