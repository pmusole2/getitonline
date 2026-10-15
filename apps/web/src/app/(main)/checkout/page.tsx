"use client";

import { useLayoutEffect, useMemo, useRef, useState, type JSX } from "react";
import Link from "next/link";
import { useConvex, useQuery } from "convex/react";
import { api } from "../../../../../../convex/_generated/api";
import type { Id } from "../../../../../../convex/_generated/dataModel";
import type { FunctionArgs } from "convex/server";
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
import { Skeleton } from "@/components/ui/skeleton";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ROUTES, ZAMBIAN_PROVINCES } from "@/lib/constants";
import { formatZMW } from "@gettitonline/shared";
import { useAccountAccess, type AccountUser } from "@/hooks/useAccountAccess";
import { usePaymentAvailability } from "@/hooks/usePaymentAvailability";
import { useWalletCheckout } from "@/hooks/useWalletCheckout";
import { walletBalanceCents } from "@/lib/walletCheckoutState";
import { AccountAccessNotice } from "@/components/common/AccountAccessNotice";
import { toast } from "sonner";
import { useGuestCart } from "@/providers/GuestCartProvider";

type ShippingAddress = FunctionArgs<
  typeof api.checkoutQuote.quoteCheckout
>["shippingAddress"];
interface AppliedPromo {
  code: string;
  title: string;
}

export default function CheckoutPage(): JSX.Element {
  const access = useAccountAccess();
  const user = access.user;

  if (access.status !== "ready" || !user) {
    return (
      <AccountAccessNotice
        access={access}
        heading="Checkout"
        signInMessage="Please sign in to complete your purchase"
        signInHref={`${ROUTES.SIGN_IN}?redirect_url=${encodeURIComponent(ROUTES.CHECKOUT)}`}
      />
    );
  }

  return <CheckoutContent key={`${user.clerkId}/${user._id}`} user={user} />;
}

function CheckoutContent({ user }: { user: AccountUser }): JSX.Element {
  const convex = useConvex();
  const guest = useGuestCart();
  const mergeReady =
    guest.isHydrated &&
    !guest.isMerging &&
    !guest.hasPendingMerge &&
    !guest.mergeFailed;
  const paymentsAvailable = usePaymentAvailability() === "available";
  const [shippingAddress, setShippingAddress] = useState<ShippingAddress>(
    () => ({
      street: user.address?.street ?? "",
      city: user.address?.city ?? "",
      province: user.address?.province ?? "",
      country: user.address?.country ?? "",
      phone: user.phone ?? "",
    }),
  );
  const [methodId, setMethodId] = useState<Id<"deliveryMethods"> | null>(null);
  const [pointId, setPointId] = useState<Id<"pickupPoints"> | null>(null);
  const [promoCodeInput, setPromoCodeInput] = useState("");
  const [appliedPromo, setAppliedPromo] = useState<AppliedPromo | null>(null);
  const [promoError, setPromoError] = useState<string | null>(null);
  const [isApplyingPromo, setIsApplyingPromo] = useState(false);
  const cart = useQuery(api.cart.getCart, user._id ? {} : "skip");
  const cartBySeller = useQuery(
    api.cart.getCartBySeller,
    user._id ? {} : "skip",
  );
  const validation = useQuery(api.cart.validateCart, user._id ? {} : "skip");
  const wallet = useQuery(
    api.wallet.getWallet,
    user._id ? { userId: user._id } : "skip",
  );
  const methods = useQuery(api.delivery.listDeliveryMethods, {});
  const subtotal = cart?.subtotal ?? 0;
  const deliveryWeightKg =
    cart?.items.reduce(
      (sum, item) => sum + (item.product.weightKg ?? 0) * item.quantity,
      0,
    ) ?? 0;
  const deliveryQuotes = useQuery(
    api.delivery.calculateDeliveryQuote,
    shippingAddress.province.trim() &&
      shippingAddress.city.trim() &&
      subtotal > 0
      ? {
          province: shippingAddress.province.trim(),
          city: shippingAddress.city.trim(),
          subtotal,
          weightKg: deliveryWeightKg,
        }
      : "skip",
  );
  const selectedMethod = methods?.find(
    (method) => method._id === methodId && method.isActive,
  );
  const selectedEligible =
    selectedMethod &&
    deliveryQuotes?.some((method) => method.methodId === selectedMethod._id);
  const pickup = selectedMethod?.type === "pickup";
  const points = useQuery(
    api.delivery.listPickupPoints,
    pickup && selectedEligible
      ? selectedMethod.zoneId
        ? { zoneId: selectedMethod.zoneId }
        : {}
      : "skip",
  );
  useLayoutEffect(() => {
    if (!selectedEligible || !pickup) {
      setPointId(null);
    }
  }, [selectedEligible, pickup, methodId]);
  const selectedPoint = points?.find(
    (point) =>
      point._id === pointId &&
      point.isActive &&
      (!selectedMethod?.zoneId || point.zoneId === selectedMethod.zoneId),
  );
  const deliveryReady =
    deliveryQuotes !== undefined &&
    methods !== undefined &&
    (deliveryQuotes.length === 0
      ? methodId === null
      : Boolean(selectedEligible && (!pickup || selectedPoint)));
  // Only stored row identity/quantity/custom selections retire approval. Names, thumbnails and preview totals do not.
  const cartIdentity = JSON.stringify(
    cart?.items
      .map((item) => ({
        id: item._id,
        productId: item.product._id,
        quantity: item.quantity,
        variantId:
          "selectedVariant" in item
            ? item.selectedVariant?.variantId
            : undefined,
        options:
          "selectedVariantOptions" in item
            ? item.selectedVariantOptions
                ?.map((option) => ({ name: option.name, value: option.value }))
                .sort(
                  (a, b) =>
                    a.name.localeCompare(b.name) ||
                    a.value.localeCompare(b.value),
                )
            : undefined,
        addOns:
          "selectedAddOns" in item
            ? item.selectedAddOns?.map((addon) => addon.name).sort()
            : undefined,
        shipping: item.selectedShipping?.name,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)) ?? null,
  );
  const checkout = useWalletCheckout({
    owner: `${user.clerkId}/${user._id}`,
    cartIdentity,
    mergeReady,
    selectors:
      deliveryReady && cart && cart.items.length > 0
        ? {
            source: "cart",
            shippingAddress,
            ...(selectedEligible
              ? { deliveryMethodId: selectedMethod._id }
              : {}),
            ...(pickup && selectedPoint
              ? { pickupPointId: selectedPoint._id }
              : {}),
            ...(appliedPromo ? { promoCode: appliedPromo.code } : {}),
          }
        : null,
    available: paymentsAvailable,
    balance: wallet?.balance,
  });
  const quote = checkout.quote;
  const balanceCents = walletBalanceCents(wallet?.balance);

  // Promo feedback owns a committed client/session AND a semantic draft generation. Render never publishes ownership.
  const mounted = useRef<object | null>(null);
  const [session, setSession] = useState<object | null>(null);
  useLayoutEffect(() => {
    const next = {};
    mounted.current = next;
    setSession(next);
    return () => {
      if (mounted.current === next) {
        mounted.current = null;
      }
    };
  }, [convex, user._id, user.clerkId]);
  const promoIdentity = JSON.stringify([
    shippingAddress,
    methodId,
    pointId,
    promoCodeInput.trim(),
    cartIdentity,
    mergeReady,
  ]);
  const promoContext = useMemo(
    () => ({ identity: promoIdentity }),
    [promoIdentity],
  );
  const committedPromo = useRef<object | null>(null);
  const promoWork = useRef<object | null>(null);
  useLayoutEffect(() => {
    committedPromo.current = promoContext;
    promoWork.current = null;
    setIsApplyingPromo(false);
    return () => {
      if (committedPromo.current === promoContext) {
        committedPromo.current = null;
      }
    };
  }, [promoContext]);

  const handleApplyPromo = async () => {
    if (
      !session ||
      mounted.current !== session ||
      committedPromo.current !== promoContext ||
      promoWork.current
    ) {
      return;
    }
    const code = promoCodeInput.trim();
    if (!code) {
      setPromoError("Enter a promo code");
      return;
    }
    const work = {};
    promoWork.current = work;
    const current = () =>
      mounted.current === session &&
      committedPromo.current === promoContext &&
      promoWork.current === work;
    const categoryIds = new Set<Id<"categories">>();
    const productIds: Id<"products">[] = [];
    for (const item of cart?.items ?? []) {
      productIds.push(item.product._id);
      categoryIds.add(item.product.categoryId);
      if (item.product.subcategoryId) {
        categoryIds.add(item.product.subcategoryId);
      }
      if (item.product.classificationId) {
        categoryIds.add(item.product.classificationId);
      }
    }
    setIsApplyingPromo(true);
    setPromoError(null);
    try {
      const result = await convex.query(api.promotions.validatePromoCode, {
        code,
        subtotal,
        categoryIds: Array.from(categoryIds),
        productIds,
      });
      if (!current()) {
        return;
      }
      if (
        result.valid !== true ||
        !result.code ||
        !result.title ||
        !result.promoCodeId ||
        typeof result.discountAmount !== "number"
      ) {
        setAppliedPromo(null);
        setPromoError(result.reason ?? "Promo code is not valid");
        return;
      }
      setAppliedPromo({ code: result.code, title: result.title });
      setPromoCodeInput(result.code);
      toast.success("Promo code applied");
    } catch {
      if (!current()) {
        return;
      }
      setPromoError("Failed to apply promo code");
      toast.error("Failed to apply promo code");
    } finally {
      if (current()) {
        promoWork.current = null;
        setIsApplyingPromo(false);
      }
    }
  };

  const recovery = (
    <>
      {checkout.retained && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Retained wallet checkout</CardTitle>
          </CardHeader>
          <CardContent>
            <p>
              This checkout is retained. Do not start another payment. Refresh
              its status or contact support.
            </p>
            {checkout.status?.result === "review" ||
            (checkout.status?.result === "found" &&
              (checkout.status.reviewNeeded ||
                checkout.status.application === "review")) ? (
              <p>
                Payment needs review. Accounting history does not confirm
                completion.
              </p>
            ) : (
              <p>Payment completion has not been verified.</p>
            )}
            {checkout.status?.result === "found" && (
              <p>
                Fee:{" "}
                {checkout.status.feeCents === null
                  ? "Unknown"
                  : formatZMW(checkout.status.feeCents / 100)}
              </p>
            )}
            <Button
              onClick={() => void checkout.refresh()}
              disabled={checkout.busy}
            >
              Refresh checkout status
            </Button>
          </CardContent>
        </Card>
      )}
      {checkout.error && (
        <p role="alert" className="mb-4 text-destructive">
          {checkout.error}
        </p>
      )}
      {checkout.outcome === "success" && (
        <Card className="mb-6">
          <CardContent>
            <p>
              Wallet purchase completed and accounting verified. Approved
              refunds are credited to your marketplace wallet.
            </p>
            <Link href={ROUTES.ORDERS}>View orders</Link>
          </CardContent>
        </Card>
      )}
    </>
  );

  return (
    <div className="container py-6">
      <h1 className="mb-6 text-2xl font-bold">Checkout</h1>
      {recovery}
      {!mergeReady ? (
        <Card>
          <CardContent>
            {guest.mergeFailed ? (
              <>
                <p>
                  Guest cart sync failed. Your guest items have not been
                  approved for checkout.
                </p>
                <Button
                  onClick={() => {
                    if (session && mounted.current === session) {
                      window.location.reload();
                    }
                  }}
                >
                  Reload to retry cart sync
                </Button>
              </>
            ) : (
              <p>
                {!guest.isHydrated
                  ? "Loading saved guest cart..."
                  : guest.isMerging
                    ? "Syncing guest cart..."
                    : "Guest cart sync is pending..."}
              </p>
            )}
          </CardContent>
        </Card>
      ) : cart === undefined ? (
        <CheckoutSkeleton />
      ) : !cart || cart.items.length === 0 ? (
        <div>
          <h2>Your cart is empty</h2>
          <Link href={ROUTES.BROWSE}>Browse Products</Link>
        </div>
      ) : (
        <>
          {validation && !validation.isValid && (
            <Card className="mb-6 border-destructive">
              <CardContent>
                <p>Cart Issues</p>
                {validation.issues.map((issue, index) => (
                  <p key={index}>{issue.issue}</p>
                ))}
                <Link href={ROUTES.CART}>Return to Cart</Link>
              </CardContent>
            </Card>
          )}
          <div className="grid gap-6 lg:grid-cols-3">
            <div className="space-y-6 lg:col-span-2">
              <Card>
                <CardHeader>
                  <CardTitle>Shipping Address</CardTitle>
                  <CardDescription>
                    All five fields are required, including for pickup.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {(["street", "city", "country", "phone"] as const).map(
                    (field) => (
                      <div key={field} className="space-y-2">
                        <Label htmlFor={field}>
                          {field === "street"
                            ? "Street Address"
                            : field === "phone"
                              ? "Phone Number"
                              : field === "country"
                                ? "Country"
                                : "City"}{" "}
                          *
                        </Label>
                        <Input
                          id={field}
                          value={shippingAddress[field]}
                          onChange={(event) =>
                            setShippingAddress({
                              ...shippingAddress,
                              [field]: event.target.value,
                            })
                          }
                        />
                      </div>
                    ),
                  )}
                  <Label htmlFor="province">Province *</Label>
                  <Select
                    value={shippingAddress.province}
                    onValueChange={(province) =>
                      setShippingAddress({ ...shippingAddress, province })
                    }
                  >
                    <SelectTrigger id="province">
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
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Delivery Option</CardTitle>
                </CardHeader>
                <CardContent>
                  {deliveryQuotes === undefined || methods === undefined ? (
                    <p>Set city and province to load delivery options.</p>
                  ) : deliveryQuotes.length === 0 ? (
                    <>
                      <p>
                        Seller-defined shipping will be reviewed in the
                        canonical quote.
                      </p>
                      {methodId && (
                        <Button
                          onClick={() => {
                            setMethodId(null);
                            setPointId(null);
                          }}
                        >
                          Use current seller shipping
                        </Button>
                      )}
                    </>
                  ) : (
                    <>
                      <p>
                        Choose an eligible delivery method. An invalidated
                        choice needs explicit correction.
                      </p>
                      <RadioGroup
                        aria-label="Delivery method"
                        value={methodId ?? ""}
                        onValueChange={(value) => {
                          const method = methods.find(
                            (candidate) =>
                              candidate._id === value &&
                              candidate.isActive &&
                              deliveryQuotes.some(
                                (item) => item.methodId === value,
                              ),
                          );
                          if (method) {
                            setMethodId(method._id);
                            setPointId(null);
                          }
                        }}
                      >
                        {deliveryQuotes
                          .filter((item) =>
                            methods.some(
                              (method) =>
                                method._id === item.methodId && method.isActive,
                            ),
                          )
                          .map((method) => (
                            <div key={method.methodId}>
                              <RadioGroupItem
                                id={`delivery-${method.methodId}`}
                                value={method.methodId}
                              />
                              <Label htmlFor={`delivery-${method.methodId}`}>
                                {method.name} (delivery preview)
                              </Label>
                            </div>
                          ))}
                      </RadioGroup>
                    </>
                  )}
                  {methodId && !selectedEligible && (
                    <p role="alert">
                      Selected delivery is no longer eligible. Choose a current
                      method.
                    </p>
                  )}
                  {pickup && selectedEligible && (
                    <>
                      <p>
                        Select an active pickup point. No point is selected
                        automatically.
                      </p>
                      <RadioGroup
                        aria-label="Pickup point"
                        value={pointId ?? ""}
                        onValueChange={(value) => {
                          const point = points?.find(
                            (candidate) =>
                              candidate._id === value &&
                              candidate.isActive &&
                              (!selectedMethod.zoneId ||
                                candidate.zoneId === selectedMethod.zoneId),
                          );
                          if (point) {
                            setPointId(point._id);
                          }
                        }}
                      >
                        {points
                          ?.filter(
                            (point) =>
                              point.isActive &&
                              (!selectedMethod.zoneId ||
                                point.zoneId === selectedMethod.zoneId),
                          )
                          .map((point) => (
                            <div key={point._id}>
                              <RadioGroupItem
                                id={`pickup-${point._id}`}
                                value={point._id}
                              />
                              <Label htmlFor={`pickup-${point._id}`}>
                                {point.name}
                              </Label>
                            </div>
                          ))}
                      </RadioGroup>
                      {!selectedPoint && (
                        <p>Choose an available pickup point before review.</p>
                      )}
                    </>
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Canonical order review</CardTitle>
                  <CardDescription>
                    Only the server quote below authorizes payment.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {!quote && (
                    <p>
                      Complete the address and delivery choices to load your
                      quote.
                    </p>
                  )}
                  {checkout.quoteError && (
                    <p role="alert">{checkout.quoteError}</p>
                  )}
                  {quote?.sellers.map((seller) => (
                    <section key={seller.sellerId}>
                      <h3 className="font-semibold">
                        {cartBySeller?.find(
                          (group) => group.sellerId === seller.sellerId,
                        )?.sellerName || "Seller"}
                      </h3>
                      {quote.lines
                        .filter((line) => line.sellerId === seller.sellerId)
                        .map((line, index) => (
                          <div
                            key={
                              line.cartItemId ??
                              `${line.customizationKey}/${index}`
                            }
                            className="my-3"
                          >
                            <p>
                              {line.title} — Qty: {line.quantity} ×{" "}
                              {formatZMW(line.unitCents / 100)} ={" "}
                              {formatZMW(line.lineTotalCents / 100)}
                            </p>
                            {line.variant && (
                              <p>
                                Variant:{" "}
                                {line.variant.attributes
                                  .map((item) => `${item.name}: ${item.value}`)
                                  .join(", ")}
                                ; SKU: {line.variant.sku}
                              </p>
                            )}
                            {line.optionPairs.map((option) => (
                              <p key={`${option.name}/${option.value}`}>
                                {option.name}: {option.value} (
                                {formatZMW(option.deltaCents / 100)})
                              </p>
                            ))}
                            {line.addOns.map((addon) => (
                              <p key={addon.name}>
                                {addon.name}:{" "}
                                {formatZMW(addon.priceCents / 100)}
                              </p>
                            ))}
                            {line.fallbackShipping && (
                              <p>
                                Shipping: {line.fallbackShipping.name} (
                                {formatZMW(
                                  line.fallbackShipping.priceCents / 100,
                                )}
                                )
                              </p>
                            )}
                          </div>
                        ))}
                      <p>
                        Seller subtotal {formatZMW(seller.subtotalCents / 100)};
                        shipping {formatZMW(seller.shippingCents / 100)}; total{" "}
                        {formatZMW(seller.totalAmountCents / 100)}
                      </p>
                    </section>
                  ))}
                  {quote && <p>Delivery: {quote.delivery.name}</p>}
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Pay with Wallet</CardTitle>
                </CardHeader>
                <CardContent>
                  <p>Current balance: {formatZMW(wallet?.balance ?? 0)}</p>
                  {quote &&
                    (balanceCents === null ||
                      balanceCents < quote.totalAmountCents) && (
                      <p>
                        Insufficient or unavailable wallet balance for this
                        canonical quote.
                      </p>
                    )}
                  <p>
                    Payment is held in escrow. Approved refunds credit your
                    marketplace wallet.
                  </p>
                </CardContent>
              </Card>
            </div>
            <Card className="h-fit">
              <CardHeader>
                <CardTitle>Order Summary</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <Label htmlFor="promoCode">Promo Code</Label>
                <div className="flex gap-2">
                  <Input
                    id="promoCode"
                    value={promoCodeInput}
                    placeholder="Enter code"
                    onChange={(event) => {
                      setPromoCodeInput(event.target.value);
                      setPromoError(null);
                    }}
                    disabled={Boolean(appliedPromo)}
                  />
                  {appliedPromo ? (
                    <Button
                      variant="outline"
                      onClick={() => {
                        setAppliedPromo(null);
                        setPromoError(null);
                      }}
                    >
                      Remove
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      onClick={() => void handleApplyPromo()}
                      disabled={isApplyingPromo || subtotal <= 0}
                    >
                      {isApplyingPromo ? "Applying..." : "Apply"}
                    </Button>
                  )}
                </div>
                {appliedPromo && (
                  <p>
                    {appliedPromo.title} selected; eligibility and discount come
                    from the quote. Remove or correct an invalid code.
                  </p>
                )}
                {promoError && <p role="alert">{promoError}</p>}
                {quote && (
                  <>
                    <p>Subtotal: {formatZMW(quote.subtotalCents / 100)}</p>
                    <p>Promo Discount: {formatZMW(quote.promoCents / 100)}</p>
                    <p>Shipping: {formatZMW(quote.shippingCents / 100)}</p>
                    <p>
                      Platform Fee: {formatZMW(quote.platformFeeCents / 100)}
                    </p>
                    <p className="font-semibold">
                      Total: {formatZMW(quote.totalAmountCents / 100)}
                    </p>
                  </>
                )}
              </CardContent>
              <CardFooter className="flex-col gap-3">
                {!paymentsAvailable && (
                  <p>
                    Payments are temporarily unavailable while we move them to a
                    new backend.
                  </p>
                )}
                <Button
                  onClick={checkout.approve}
                  disabled={!checkout.canApprove || checkout.approved}
                >
                  Approve{" "}
                  {quote ? formatZMW(quote.totalAmountCents / 100) : "quote"}
                </Button>
                <Button
                  className="w-full"
                  onClick={() => void checkout.submit()}
                  disabled={!checkout.canSubmit}
                >
                  {checkout.busy
                    ? "Processing..."
                    : checkout.approved && quote
                      ? `Pay ${formatZMW(quote.totalAmountCents / 100, { minimumFractionDigits: 2 })}`
                      : "Place Order"}
                </Button>
                <p className="text-xs">
                  Review the canonical items, address, delivery and total, then
                  explicitly approve before paying.
                </p>
              </CardFooter>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function CheckoutSkeleton(): JSX.Element {
  return (
    <div className="space-y-4">
      <Skeleton className="h-64 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}
