"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../../../../../convex/_generated/api";
import { Id } from "../../../../../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  Package,
  Clock,
  Truck,
  CheckCircle,
  XCircle,
  AlertTriangle,
  MapPin,
  Phone,
  MessageSquare,
  Shield,
  Copy,
  ExternalLink,
  Loader2,
} from "lucide-react";
import { ROUTES } from "@/lib/constants";
import { formatZMW } from "@gettitonline/shared";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";
import { format } from "date-fns";

type OrderStatus =
  | "pending_payment"
  | "paid"
  | "processing"
  | "shipped"
  | "delivered"
  | "completed"
  | "cancelled"
  | "disputed";

const STATUS_CONFIG: Record<
  OrderStatus,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline"; icon: React.ElementType; color: string }
> = {
  pending_payment: { label: "Pending Payment", variant: "outline", icon: Clock, color: "text-yellow-600" },
  paid: { label: "Paid", variant: "secondary", icon: CheckCircle, color: "text-blue-600" },
  processing: { label: "Processing", variant: "secondary", icon: Package, color: "text-blue-600" },
  shipped: { label: "Shipped", variant: "default", icon: Truck, color: "text-purple-600" },
  delivered: { label: "Delivered", variant: "default", icon: CheckCircle, color: "text-green-600" },
  completed: { label: "Completed", variant: "default", icon: CheckCircle, color: "text-green-600" },
  cancelled: { label: "Cancelled", variant: "destructive", icon: XCircle, color: "text-red-600" },
  disputed: { label: "Disputed", variant: "destructive", icon: AlertTriangle, color: "text-red-600" },
};

const ORDER_STEPS = [
  { status: ["paid", "processing", "shipped", "delivered", "completed"], label: "Order Placed", icon: CheckCircle },
  { status: ["processing", "shipped", "delivered", "completed"], label: "Processing", icon: Package },
  { status: ["shipped", "delivered", "completed"], label: "Shipped", icon: Truck },
  { status: ["delivered", "completed"], label: "Delivered", icon: CheckCircle },
  { status: ["completed"], label: "Completed", icon: CheckCircle },
];

export default function OrderDetailPage() {
  const params = useParams();
  const router = useRouter();
  const orderId = params.id as Id<"orders">;
  const { user, isSignedIn, isLoading: authLoading } = useAuth();

  const [isProcessing, setIsProcessing] = useState(false);

  // Get order details
  const order = useQuery(api.orders.getOrder, { orderId });

  // Mutations
  const confirmDelivery = useMutation(api.orders.confirmDelivery);
  const completeOrder = useMutation(api.orders.completeOrder);
  const cancelOrder = useMutation(api.orders.cancelOrder);

  const handleConfirmDelivery = async () => {
    if (!user || !order) return;
    setIsProcessing(true);

    try {
      await confirmDelivery({ orderId: order._id, buyerId: user._id });
      toast.success("Delivery confirmed!");
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : "Failed to confirm delivery";
      toast.error(errorMessage);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCompleteOrder = async () => {
    if (!user || !order) return;
    setIsProcessing(true);

    try {
      await completeOrder({ orderId: order._id, buyerId: user._id });
      toast.success("Order completed! Payment released to the store.");
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : "Failed to complete order";
      toast.error(errorMessage);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCancelOrder = async () => {
    if (!user || !order) return;
    setIsProcessing(true);

    try {
      await cancelOrder({ orderId: order._id, userId: user._id });
      toast.success("Order cancelled");
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : "Failed to cancel order";
      toast.error(errorMessage);
    } finally {
      setIsProcessing(false);
    }
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    toast.success(`${label} copied to clipboard`);
  };

  // Loading state
  if (authLoading || order === undefined) {
    return <OrderDetailSkeleton />;
  }

  // Not signed in
  if (!isSignedIn) {
    return (
      <div className="container flex flex-col items-center justify-center py-16">
        <Package className="h-16 w-16 text-muted-foreground" />
        <h1 className="mt-4 text-2xl font-bold">Order Details</h1>
        <p className="mt-2 text-muted-foreground">
          Please sign in to view this order
        </p>
        <Button asChild className="mt-6">
          <Link href={ROUTES.SIGN_IN}>Sign In</Link>
        </Button>
      </div>
    );
  }

  // Order not found
  if (order === null) {
    return (
      <div className="container flex flex-col items-center justify-center py-16">
        <Package className="h-16 w-16 text-muted-foreground" />
        <h1 className="mt-4 text-2xl font-bold">Order Not Found</h1>
        <p className="mt-2 text-muted-foreground">
          This order doesn&apos;t exist or you don&apos;t have access to it
        </p>
        <Button asChild className="mt-6">
          <Link href={ROUTES.ORDERS}>Back to Orders</Link>
        </Button>
      </div>
    );
  }

  // Check if user is the buyer
  const isBuyer = order.buyerId === user?._id;
  if (!isBuyer && user?.role !== "admin") {
    router.push(ROUTES.ORDERS);
    return null;
  }

  const statusConfig = STATUS_CONFIG[order.status as OrderStatus];
  const StatusIcon = statusConfig?.icon || Package;

  // Determine available actions
  const canCancel = ["pending_payment", "paid", "processing"].includes(order.status);
  const canConfirmDelivery = order.status === "shipped";
  const canComplete = order.status === "delivered";
  const canDispute = order.status === "delivered";

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
            <BreadcrumbLink href={ROUTES.ORDERS}>My Orders</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>#{order.orderNumber}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {/* Order Header */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">Order #{order.orderNumber}</h1>
            <Badge variant={statusConfig?.variant}>
              <StatusIcon className="mr-1 h-3 w-3" />
              {statusConfig?.label}
            </Badge>
          </div>
          <p className="mt-1 text-muted-foreground">
            Placed on {format(order.createdAt, "MMMM d, yyyy 'at' h:mm a")}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => copyToClipboard(order.orderNumber, "Order number")}
        >
          <Copy className="mr-2 h-4 w-4" />
          Copy Order #
        </Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Main Content */}
        <div className="lg:col-span-2 space-y-6">
          {/* Order Progress */}
          {!["cancelled", "disputed"].includes(order.status) && (
            <Card>
              <CardHeader>
                <CardTitle>Order Progress</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between">
                  {ORDER_STEPS.map((step, index) => {
                    const isCompleted = step.status.includes(order.status);
                    const StepIcon = step.icon;

                    return (
                      <div key={step.label} className="flex flex-1 items-center">
                        <div className="flex flex-col items-center">
                          <div
                            className={`flex h-10 w-10 items-center justify-center rounded-full border-2 ${
                              isCompleted
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-muted bg-background text-muted-foreground"
                            }`}
                          >
                            <StepIcon className="h-5 w-5" />
                          </div>
                          <p
                            className={`mt-2 text-xs font-medium ${
                              isCompleted ? "text-primary" : "text-muted-foreground"
                            }`}
                          >
                            {step.label}
                          </p>
                        </div>
                        {index < ORDER_STEPS.length - 1 && (
                          <div
                            className={`mx-2 h-0.5 flex-1 ${
                              step.status.includes(order.status)
                                ? "bg-primary"
                                : "bg-muted"
                            }`}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Order Items */}
          <Card>
            <CardHeader>
              <CardTitle>Order Items</CardTitle>
              <CardDescription>
                {order.items.length} {order.items.length === 1 ? "item" : "items"} from store{" "}
                {order.seller?.firstName} {order.seller?.lastName}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {order.items.map((item, index) => (
                <div key={index} className="flex gap-4">
                  <Link href={ROUTES.PRODUCT(item.productId)}>
                    <div className="h-20 w-20 shrink-0 overflow-hidden rounded-lg bg-muted">
                      <img
                        src={item.image || "/placeholder.png"}
                        alt={item.title}
                        className="h-full w-full object-cover"
                      />
                    </div>
                  </Link>
                  <div className="flex-1 min-w-0">
                    <Link
                      href={ROUTES.PRODUCT(item.productId)}
                      className="font-medium hover:underline line-clamp-2"
                    >
                      {item.title}
                    </Link>
                    <p className="text-sm text-muted-foreground mt-1">
                      Qty: {item.quantity} x {formatZMW(item.price)}
                    </p>
                  </div>
                  <p className="font-medium">{formatZMW(item.price * item.quantity)}</p>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Shipping Info */}
          <Card>
            <CardHeader>
              <CardTitle>Shipping Information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-start gap-3">
                <MapPin className="h-5 w-5 text-muted-foreground shrink-0" />
                <div>
                  <p className="font-medium">Delivery Address</p>
                  <p className="text-muted-foreground">
                    {order.shippingAddress.street}
                    <br />
                    {order.shippingAddress.city}, {order.shippingAddress.province}
                    <br />
                    {order.shippingAddress.country}
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Phone className="h-5 w-5 text-muted-foreground shrink-0" />
                <div>
                  <p className="font-medium">Phone</p>
                  <p className="text-muted-foreground">{order.shippingAddress.phone}</p>
                </div>
              </div>
              {order.trackingNumber && (
                <div className="flex items-start gap-3">
                  <Truck className="h-5 w-5 text-muted-foreground shrink-0" />
                  <div>
                    <p className="font-medium">Tracking Number</p>
                    <div className="flex items-center gap-2">
                      <p className="text-muted-foreground">{order.trackingNumber}</p>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={() => copyToClipboard(order.trackingNumber!, "Tracking number")}
                      >
                        <Copy className="h-3 w-3" />
                      </Button>
                    </div>
                    {order.shippingCarrier && (
                      <p className="text-sm text-muted-foreground">
                        via {order.shippingCarrier}
                      </p>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Sidebar */}
        <div className="lg:col-span-1 space-y-6">
          {/* Order Summary */}
          <Card>
            <CardHeader>
              <CardTitle>Order Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Subtotal</span>
                <span>{formatZMW(order.subtotal)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Shipping</span>
                <span>
                  {order.shippingCost > 0 ? formatZMW(order.shippingCost) : "Free"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Platform Fee</span>
                <span>{formatZMW(order.platformFee)}</span>
              </div>
              <Separator />
              <div className="flex justify-between font-semibold text-lg">
                <span>Total</span>
                <span className="text-primary">{formatZMW(order.totalAmount)}</span>
              </div>
            </CardContent>
          </Card>

          {/* Actions */}
          <Card>
            <CardHeader>
              <CardTitle>Actions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* Confirm Delivery */}
              {canConfirmDelivery && (
                <Button
                  className="w-full"
                  onClick={handleConfirmDelivery}
                  disabled={isProcessing}
                >
                  {isProcessing ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <CheckCircle className="mr-2 h-4 w-4" />
                  )}
                  Confirm Delivery
                </Button>
              )}

              {/* Complete Order */}
              {canComplete && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button className="w-full" disabled={isProcessing}>
                      <Shield className="mr-2 h-4 w-4" />
                      Complete & Release Payment
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Complete this order?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This will release the payment ({formatZMW(order.sellerPayout)}) to the store.
                        Only complete the order if you&apos;re satisfied with your purchase.
                        This action cannot be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={handleCompleteOrder}>
                        Complete Order
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}

              {/* Dispute */}
              {canDispute && (
                <Button variant="outline" className="w-full" asChild>
                  <Link href={`${ROUTES.DISPUTES}/new?order=${order._id}`}>
                    <AlertTriangle className="mr-2 h-4 w-4" />
                    Open Dispute
                  </Link>
                </Button>
              )}

              {/* Contact Store */}
              <Button variant="outline" className="w-full" asChild>
                <Link href={`${ROUTES.MESSAGES}?user=${order.sellerId}`}>
                  <MessageSquare className="mr-2 h-4 w-4" />
                  Contact Store
                </Link>
              </Button>

              {/* Cancel Order */}
              {canCancel && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="destructive" className="w-full" disabled={isProcessing}>
                      <XCircle className="mr-2 h-4 w-4" />
                      Cancel Order
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Cancel this order?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This will cancel your order and refund your payment.
                        This action cannot be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Keep Order</AlertDialogCancel>
                      <AlertDialogAction onClick={handleCancelOrder}>
                        Cancel Order
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </CardContent>
          </Card>

          {/* Escrow Info */}
          {["paid", "processing", "shipped", "delivered"].includes(order.status) && (
            <Card className="bg-green-50 dark:bg-green-950/20">
              <CardContent className="flex items-start gap-3 p-4">
                <Shield className="h-5 w-5 shrink-0 text-green-600" />
                <div>
                  <p className="font-medium text-green-800 dark:text-green-400">
                    Payment Protected
                  </p>
                  <p className="text-sm text-green-700 dark:text-green-500">
                    {formatZMW(order.totalAmount)} is held in escrow and will be
                    released to the store once you complete the order.
                  </p>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function OrderDetailSkeleton() {
  return (
    <div className="container py-6">
      <Skeleton className="mb-6 h-4 w-48" />
      <div className="mb-6 flex items-center gap-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-6 w-24" />
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <Skeleton className="h-40 w-full rounded-lg" />
          <Skeleton className="h-64 w-full rounded-lg" />
          <Skeleton className="h-48 w-full rounded-lg" />
        </div>
        <div className="lg:col-span-1 space-y-6">
          <Skeleton className="h-48 w-full rounded-lg" />
          <Skeleton className="h-40 w-full rounded-lg" />
        </div>
      </div>
    </div>
  );
}
