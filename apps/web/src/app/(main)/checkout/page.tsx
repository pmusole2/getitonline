"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../../../../convex/_generated/api";
import { Id } from "../../../../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
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
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  ShoppingCart,
  Wallet,
  Shield,
  Package,
  Loader2,
  CheckCircle,
  AlertTriangle,
} from "lucide-react";
import { ROUTES, ZAMBIAN_PROVINCES } from "@/lib/constants";
import { formatZMW } from "@gettitonline/shared";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";
import { useGuestCart } from "@/providers/GuestCartProvider";

// Platform fee percentage
const PLATFORM_FEE_PERCENTAGE = 0.05;

interface ShippingAddress {
  street: string;
  city: string;
  province: string;
  country: string;
  phone: string;
}

export default function CheckoutPage() {
  const router = useRouter();
  const { user, isSignedIn, isLoading: authLoading } = useAuth();
  const {
    isHydrated: guestCartHydrated,
    isMerging: guestCartMerging,
    hasPendingMerge,
  } = useGuestCart();

  const [isProcessing, setIsProcessing] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<"wallet">("wallet");
  const [shippingAddress, setShippingAddress] = useState<ShippingAddress>({
    street: "",
    city: "",
    province: "",
    country: "Zambia",
    phone: "",
  });
  const [errors, setErrors] = useState<Partial<ShippingAddress>>({});

  // Get cart grouped by seller
  const cartBySeller = useQuery(
    api.cart.getCartBySeller,
    user?._id ? { userId: user._id } : "skip"
  );

  // Get cart totals
  const cart = useQuery(
    api.cart.getCart,
    user?._id ? { userId: user._id } : "skip"
  );

  // Validate cart
  const validation = useQuery(
    api.cart.validateCart,
    user?._id ? { userId: user._id } : "skip"
  );

  // Get wallet balance
  const wallet = useQuery(
    api.wallet.getWallet,
    user?._id ? { userId: user._id } : "skip"
  );

  // Mutations
  const createOrder = useMutation(api.orders.createOrder);
  const markPaidByWallet = useMutation(api.orders.markPaidByWallet);
  const debitWallet = useMutation(api.wallet.debitWallet);
  const clearCart = useMutation(api.cart.clearCart);

  // Load user's saved address if available
  useEffect(() => {
    if (user?.address) {
      setShippingAddress({
        street: user.address.street || "",
        city: user.address.city || "",
        province: user.address.province || "",
        country: user.address.country || "Zambia",
        phone: user.phone || "",
      });
    }
  }, [user]);

  // Calculate totals
  const subtotal = cart?.subtotal || 0;
  const shippingTotal = cart?.shippingTotal || 0;
  const platformFee = Math.ceil(subtotal * PLATFORM_FEE_PERCENTAGE * 100) / 100;
  const totalAmount = subtotal + shippingTotal + platformFee;

  const validateForm = (): boolean => {
    const newErrors: Partial<ShippingAddress> = {};

    if (!shippingAddress.street.trim()) {
      newErrors.street = "Street address is required";
    }
    if (!shippingAddress.city.trim()) {
      newErrors.city = "City is required";
    }
    if (!shippingAddress.province) {
      newErrors.province = "Province is required";
    }
    if (!shippingAddress.phone.trim()) {
      newErrors.phone = "Phone number is required";
    } else if (!/^(\+260|0)?[79]\d{8}$/.test(shippingAddress.phone.replace(/\s/g, ""))) {
      newErrors.phone = "Please enter a valid Zambian phone number";
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handlePlaceOrder = async () => {
    if (!user || !cartBySeller || cartBySeller.length === 0) return;

    if (!validateForm()) {
      toast.error("Please fill in all required fields");
      return;
    }

    if (validation && !validation.isValid) {
      toast.error("Some items in your cart are no longer available");
      return;
    }

    // Check wallet balance
    if (paymentMethod === "wallet") {
      if (!wallet || wallet.balance < totalAmount) {
        toast.error("Insufficient wallet balance");
        return;
      }
    }

    setIsProcessing(true);

    try {
      const orderIds: Id<"orders">[] = [];

      // Create orders for each seller
      for (const sellerGroup of cartBySeller) {
        const sellerSubtotal = sellerGroup.subtotal;
        const sellerShipping = sellerGroup.shippingTotal;

        const orderId = await createOrder({
          buyerId: user._id,
          sellerId: sellerGroup.sellerId as Id<"users">,
          items: sellerGroup.items.map((item) => ({
            productId: item.productId as Id<"products">,
            title: item.product.title,
            price: item.product.price,
            quantity: item.quantity,
            image: item.product.images?.[0] || "",
          })),
          subtotal: sellerSubtotal,
          shippingCost: sellerShipping,
          shippingAddress,
        });

        orderIds.push(orderId);
      }

      // Process wallet payment
      if (paymentMethod === "wallet") {
        // Deduct from wallet
        await debitWallet({
          userId: user._id,
          amount: totalAmount,
          source: "purchase",
          description: `Payment for orders`,
        });

        // Mark orders as paid
        for (const orderId of orderIds) {
          await markPaidByWallet({
            orderId,
            walletReference: `WALLET-${Date.now()}`,
          });
        }
      }

      // Clear cart
      await clearCart({ userId: user._id });

      toast.success("Order placed successfully!");

      // Redirect to order confirmation
      if (orderIds.length === 1) {
        router.push(ROUTES.ORDER(orderIds[0]));
      } else {
        router.push(ROUTES.ORDERS);
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : "Failed to place order";
      toast.error(errorMessage);
    } finally {
      setIsProcessing(false);
    }
  };

  // Loading state
  if (
    !guestCartHydrated ||
    authLoading ||
    (isSignedIn &&
      (cart === undefined || guestCartMerging || hasPendingMerge))
  ) {
    return <CheckoutSkeleton />;
  }

  // Not signed in
  if (!isSignedIn) {
    return (
      <div className="container flex flex-col items-center justify-center py-16">
        <ShoppingCart className="h-16 w-16 text-muted-foreground" />
        <h1 className="mt-4 text-2xl font-bold">Checkout</h1>
        <p className="mt-2 text-muted-foreground">
          Please sign in to complete your purchase
        </p>
        <Button asChild className="mt-6">
          <Link
            href={`${ROUTES.SIGN_IN}?redirect_url=${encodeURIComponent(
              ROUTES.CHECKOUT
            )}`}
          >
            Sign In
          </Link>
        </Button>
      </div>
    );
  }

  // Empty cart
  if (!cart || cart.items.length === 0) {
    return (
      <div className="container flex flex-col items-center justify-center py-16">
        <Package className="h-16 w-16 text-muted-foreground" />
        <h1 className="mt-4 text-2xl font-bold">Your cart is empty</h1>
        <p className="mt-2 text-muted-foreground">
          Add some items to your cart before checkout
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
            <BreadcrumbLink href={ROUTES.CART}>Cart</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Checkout</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <h1 className="mb-6 text-2xl font-bold">Checkout</h1>

      {/* Validation Issues */}
      {validation && !validation.isValid && (
        <Card className="mb-6 border-destructive">
          <CardContent className="flex items-start gap-3 p-4">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            <div>
              <p className="font-medium text-destructive">Cart Issues</p>
              <ul className="mt-1 text-sm text-muted-foreground list-disc list-inside">
                {validation.issues.map((issue, index) => (
                  <li key={index}>{issue.issue}</li>
                ))}
              </ul>
              <Button asChild variant="outline" size="sm" className="mt-3">
                <Link href={ROUTES.CART}>Return to Cart</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Main Content */}
        <div className="lg:col-span-2 space-y-6">
          {/* Shipping Address */}
          <Card>
            <CardHeader>
              <CardTitle>Shipping Address</CardTitle>
              <CardDescription>
                Where should we deliver your order?
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="street">Street Address *</Label>
                <Input
                  id="street"
                  placeholder="123 Main Street, Apt 4"
                  value={shippingAddress.street}
                  onChange={(e) =>
                    setShippingAddress({ ...shippingAddress, street: e.target.value })
                  }
                  className={errors.street ? "border-destructive" : ""}
                />
                {errors.street && (
                  <p className="text-sm text-destructive">{errors.street}</p>
                )}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="city">City *</Label>
                  <Input
                    id="city"
                    placeholder="Lusaka"
                    value={shippingAddress.city}
                    onChange={(e) =>
                      setShippingAddress({ ...shippingAddress, city: e.target.value })
                    }
                    className={errors.city ? "border-destructive" : ""}
                  />
                  {errors.city && (
                    <p className="text-sm text-destructive">{errors.city}</p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="province">Province *</Label>
                  <Select
                    value={shippingAddress.province}
                    onValueChange={(value) =>
                      setShippingAddress({ ...shippingAddress, province: value })
                    }
                  >
                    <SelectTrigger className={errors.province ? "border-destructive" : ""}>
                      <SelectValue placeholder="Select province" />
                    </SelectTrigger>
                    <SelectContent>
                      {ZAMBIAN_PROVINCES.map((province) => (
                        <SelectItem key={province} value={province}>
                          {province}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {errors.province && (
                    <p className="text-sm text-destructive">{errors.province}</p>
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="phone">Phone Number *</Label>
                <Input
                  id="phone"
                  placeholder="+260 97 1234567"
                  value={shippingAddress.phone}
                  onChange={(e) =>
                    setShippingAddress({ ...shippingAddress, phone: e.target.value })
                  }
                  className={errors.phone ? "border-destructive" : ""}
                />
                {errors.phone && (
                  <p className="text-sm text-destructive">{errors.phone}</p>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Order Items by Seller */}
          <Card>
            <CardHeader>
              <CardTitle>Order Items</CardTitle>
              <CardDescription>
                {cartBySeller?.length === 1
                  ? "Your items from 1 store"
                  : `Your items from ${cartBySeller?.length || 0} stores`}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Accordion type="multiple" defaultValue={cartBySeller?.map((_, i) => `seller-${i}`)}>
                {cartBySeller?.map((sellerGroup, index) => (
                  <AccordionItem key={sellerGroup.sellerId} value={`seller-${index}`}>
                    <AccordionTrigger>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{sellerGroup.sellerName}</span>
                        <span className="text-sm text-muted-foreground">
                          ({sellerGroup.items.length} {sellerGroup.items.length === 1 ? "item" : "items"})
                        </span>
                      </div>
                    </AccordionTrigger>
                    <AccordionContent>
                      <div className="space-y-3">
                        {sellerGroup.items.map((item) => (
                          <div key={item._id} className="flex gap-3">
                            <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-muted">
                              <img
                                src={item.product.images?.[0] || "/placeholder.png"}
                                alt={item.product.title}
                                className="h-full w-full object-cover"
                              />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="font-medium line-clamp-1">
                                {item.product.title}
                              </p>
                              <p className="text-sm text-muted-foreground">
                                Qty: {item.quantity} x {formatZMW(item.product.price)}
                              </p>
                            </div>
                            <p className="font-medium">
                              {formatZMW(item.product.price * item.quantity)}
                            </p>
                          </div>
                        ))}
                        <Separator />
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">Subtotal</span>
                          <span>{formatZMW(sellerGroup.subtotal)}</span>
                        </div>
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">Shipping</span>
                          <span>
                            {sellerGroup.shippingTotal > 0
                              ? formatZMW(sellerGroup.shippingTotal)
                              : "Free"}
                          </span>
                        </div>
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            </CardContent>
          </Card>

          {/* Payment Method */}
          <Card>
            <CardHeader>
              <CardTitle>Payment Method</CardTitle>
              <CardDescription>
                Choose how you want to pay
              </CardDescription>
            </CardHeader>
            <CardContent>
              <RadioGroup
                value={paymentMethod}
                onValueChange={(value) => setPaymentMethod(value as "wallet")}
              >
                <div className="flex items-start space-x-3 p-4 rounded-lg border">
                  <RadioGroupItem value="wallet" id="wallet" className="mt-1" />
                  <div className="flex-1">
                    <Label htmlFor="wallet" className="flex items-center gap-2 cursor-pointer">
                      <Wallet className="h-5 w-5" />
                      Pay with Wallet
                    </Label>
                    <p className="text-sm text-muted-foreground mt-1">
                      Current balance: {formatZMW(wallet?.balance || 0)}
                    </p>
                    {wallet && wallet.balance < totalAmount && (
                      <p className="text-sm text-destructive mt-1">
                        Insufficient balance. You need {formatZMW(totalAmount - wallet.balance)} more.
                      </p>
                    )}
                  </div>
                </div>
              </RadioGroup>

              {/* Escrow Notice */}
              <div className="mt-4 rounded-lg bg-green-50 dark:bg-green-950/20 p-4">
                <div className="flex gap-3">
                  <Shield className="h-5 w-5 shrink-0 text-green-600" />
                  <div>
                    <p className="font-medium text-green-800 dark:text-green-400">
                      Secure Escrow Protection
                    </p>
                    <p className="text-sm text-green-700 dark:text-green-500 mt-1">
                      Your payment will be held securely in escrow until you confirm
                      receipt of your order. The seller only receives payment after
                      you&apos;re satisfied.
                    </p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Order Summary */}
        <div className="lg:col-span-1">
          <Card className="sticky top-4">
            <CardHeader>
              <CardTitle>Order Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  Subtotal ({cart.itemCount} items)
                </span>
                <span>{formatZMW(subtotal)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Shipping</span>
                <span>
                  {shippingTotal > 0 ? formatZMW(shippingTotal) : "Free"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  Platform Fee (5%)
                </span>
                <span>{formatZMW(platformFee)}</span>
              </div>
              <Separator />
              <div className="flex justify-between font-semibold text-lg">
                <span>Total</span>
                <span className="text-primary">{formatZMW(totalAmount)}</span>
              </div>
            </CardContent>
            <CardFooter className="flex-col gap-3">
              <Button
                className="w-full"
                size="lg"
                onClick={handlePlaceOrder}
                disabled={
                  isProcessing ||
                  (validation !== undefined && validation !== null && !validation.isValid) ||
                  (wallet !== null && wallet !== undefined && wallet.balance < totalAmount)
                }
              >
                {isProcessing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Processing...
                  </>
                ) : (
                  <>
                    <CheckCircle className="mr-2 h-4 w-4" />
                    Place Order
                  </>
                )}
              </Button>
              <p className="text-xs text-center text-muted-foreground">
                By placing your order, you agree to our Terms of Service and
                Privacy Policy
              </p>
            </CardFooter>
          </Card>
        </div>
      </div>
    </div>
  );
}

function CheckoutSkeleton() {
  return (
    <div className="container py-6">
      <Skeleton className="mb-6 h-4 w-48" />
      <Skeleton className="mb-6 h-8 w-32" />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <Skeleton className="h-80 w-full rounded-lg" />
          <Skeleton className="h-64 w-full rounded-lg" />
          <Skeleton className="h-48 w-full rounded-lg" />
        </div>
        <div className="lg:col-span-1">
          <Skeleton className="h-72 w-full rounded-lg" />
        </div>
      </div>
    </div>
  );
}
