"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../../../../../convex/_generated/api";
import { Id } from "../../../../../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Package,
  Clock,
  Truck,
  CheckCircle,
  XCircle,
  AlertTriangle,
  ShoppingBag,
  ChevronRight,
  MessageSquare,
  Loader2,
} from "lucide-react";
import { ROUTES } from "@/lib/constants";
import { formatZMW } from "@gettitonline/shared";
import { AccountAccessNotice } from "@/components/common/AccountAccessNotice";
import { useAccountAccess, type AccountUser } from "@/hooks/useAccountAccess";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { canManageCatalog } from "@/lib/roles";

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
  { label: string; variant: "default" | "secondary" | "destructive" | "outline"; icon: React.ElementType }
> = {
  pending_payment: { label: "Pending Payment", variant: "outline", icon: Clock },
  paid: { label: "Paid", variant: "secondary", icon: CheckCircle },
  processing: { label: "Processing", variant: "secondary", icon: Package },
  shipped: { label: "Shipped", variant: "default", icon: Truck },
  delivered: { label: "Delivered", variant: "default", icon: CheckCircle },
  completed: { label: "Completed", variant: "default", icon: CheckCircle },
  cancelled: { label: "Cancelled", variant: "destructive", icon: XCircle },
  disputed: { label: "Disputed", variant: "destructive", icon: AlertTriangle },
};

export default function SellerOrdersPage() {
  const access = useAccountAccess();
  if (access.status !== "ready" || access.user === null) {
    return (
      <AccountAccessNotice
        access={access}
        heading="Seller Orders"
        signInMessage="Please sign in to view your orders"
      />
    );
  }
  return <SellerOrdersContent user={access.user} />;
}

function SellerOrdersContent({ user }: { user: AccountUser }) {
  const hasCatalogAccess = canManageCatalog(user?.role);
  const [activeTab, setActiveTab] = useState<"pending" | "shipped" | "completed" | "all">("pending");
  const [shippingDialogOpen, setShippingDialogOpen] = useState(false);
  const [selectedOrderId, setSelectedOrderId] = useState<Id<"orders"> | null>(null);
  const [trackingNumber, setTrackingNumber] = useState("");
  const [shippingCarrier, setShippingCarrier] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);

  // Get seller's orders
  const orders = useQuery(
    api.orders.getManagedCatalogOrders,
    user?._id && hasCatalogAccess ? {} : "skip"
  );

  // Mutations
  const updateOrderStatus = useMutation(api.orders.updateOrderStatus);
  const markAsShipped = useMutation(api.orders.markAsShipped);

  const handleMarkProcessing = async (orderId: Id<"orders">) => {
    if (!user) return;
    setIsProcessing(true);

    try {
      await updateOrderStatus({
        orderId,
        status: "processing",
      });
      toast.success("Order marked as processing");
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : "Failed to update order";
      toast.error(errorMessage);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleMarkShipped = async () => {
    if (!user || !selectedOrderId) return;
    setIsProcessing(true);

    try {
      await markAsShipped({
        orderId: selectedOrderId,
        trackingNumber: trackingNumber || undefined,
        shippingCarrier: shippingCarrier || undefined,
      });
      toast.success("Order marked as shipped");
      setShippingDialogOpen(false);
      setTrackingNumber("");
      setShippingCarrier("");
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : "Failed to update order";
      toast.error(errorMessage);
    } finally {
      setIsProcessing(false);
    }
  };

  const openShippingDialog = (orderId: Id<"orders">) => {
    setSelectedOrderId(orderId);
    setShippingDialogOpen(true);
  };

  // Loading state
  if (hasCatalogAccess && orders === undefined) {
    return <SellerOrdersSkeleton />;
  }

  if (!hasCatalogAccess) {
    return (
      <div className="container flex flex-col items-center justify-center py-16">
        <Package className="h-16 w-16 text-muted-foreground" />
        <h1 className="mt-4 text-2xl font-bold">Catalog Access Restricted</h1>
        <p className="mt-2 text-center text-muted-foreground">
          Only Super Admins and Product Uploaders can manage storefront orders.
        </p>
      </div>
    );
  }

  // Filter orders based on tab
  const filteredOrders = orders?.filter((order) => {
    if (activeTab === "all") return true;
    if (activeTab === "pending") {
      return ["paid", "processing"].includes(order.status);
    }
    if (activeTab === "shipped") {
      return ["shipped", "delivered"].includes(order.status);
    }
    if (activeTab === "completed") {
      return ["completed", "cancelled"].includes(order.status);
    }
    return true;
  });

  // Calculate counts
  const pendingCount = orders?.filter((o) => ["paid", "processing"].includes(o.status)).length || 0;
  const shippedCount = orders?.filter((o) => ["shipped", "delivered"].includes(o.status)).length || 0;
  const completedCount = orders?.filter((o) => ["completed", "cancelled"].includes(o.status)).length || 0;

  // Empty state
  if (!orders || orders.length === 0) {
    return (
      <div className="container flex flex-col items-center justify-center py-16">
        <ShoppingBag className="h-16 w-16 text-muted-foreground" />
        <h1 className="mt-4 text-2xl font-bold">No sales yet</h1>
        <p className="mt-2 text-muted-foreground">
          When you make sales, they will appear here
        </p>
        <Button asChild className="mt-6">
          <Link href={ROUTES.SELL}>Manage Listings</Link>
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
            <BreadcrumbLink href={ROUTES.SELL}>Catalog</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Orders</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <h1 className="mb-6 text-2xl font-bold">Catalog Orders</h1>

      {/* Pending Orders Alert */}
      {pendingCount > 0 && (
        <Card className="mb-6 border-amber-200 bg-amber-50 dark:bg-amber-950/20">
          <CardContent className="flex items-center gap-3 p-4">
            <AlertTriangle className="h-5 w-5 text-amber-600" />
            <div>
              <p className="font-medium">
                You have {pendingCount} order{pendingCount > 1 ? "s" : ""} waiting to be processed
              </p>
              <p className="text-sm text-muted-foreground">
                Process orders quickly to maintain good ratings
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)}>
        <TabsList className="mb-6">
          <TabsTrigger value="pending">
            Pending ({pendingCount})
          </TabsTrigger>
          <TabsTrigger value="shipped">
            Shipped ({shippedCount})
          </TabsTrigger>
          <TabsTrigger value="completed">
            Completed ({completedCount})
          </TabsTrigger>
          <TabsTrigger value="all">
            All ({orders.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value={activeTab} className="space-y-4">
          {filteredOrders?.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-12">
                <Package className="h-12 w-12 text-muted-foreground" />
                <p className="mt-4 text-muted-foreground">
                  No orders in this category
                </p>
              </CardContent>
            </Card>
          ) : (
            filteredOrders?.map((order) => {
              const statusConfig = STATUS_CONFIG[order.status as OrderStatus];
              const StatusIcon = statusConfig?.icon || Package;
              const canProcess = order.status === "paid";
              const canShip = order.status === "processing" || order.status === "paid";

              return (
                <Card key={order._id} className="overflow-hidden">
                  <CardContent className="p-0">
                    {/* Order Header */}
                    <div className="flex flex-wrap items-center justify-between gap-4 border-b bg-muted/30 p-4">
                      <div className="flex flex-wrap items-center gap-4">
                        <div>
                          <p className="text-sm text-muted-foreground">
                            Order #{order.orderNumber}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {formatDistanceToNow(order.createdAt, { addSuffix: true })}
                          </p>
                        </div>
                        <Badge variant={statusConfig?.variant}>
                          <StatusIcon className="mr-1 h-3 w-3" />
                          {statusConfig?.label}
                        </Badge>
                      </div>
                      <div className="text-right">
                        <p className="font-semibold">{formatZMW(order.sellerPayout)}</p>
                        <p className="text-xs text-muted-foreground">
                          Buyer: {order.buyer?.firstName} {order.buyer?.lastName}
                        </p>
                      </div>
                    </div>

                    {/* Order Items */}
                    <div className="p-4">
                      <div className="flex gap-4">
                        {/* Product Images */}
                        <div className="flex -space-x-2">
                          {order.items.slice(0, 3).map((item, index) => (
                            <div
                              key={index}
                              className="h-16 w-16 shrink-0 overflow-hidden rounded-lg border-2 border-background bg-muted"
                            >
                              <img
                                src={item.image || "/placeholder.png"}
                                alt={item.title}
                                className="h-full w-full object-cover"
                              />
                            </div>
                          ))}
                          {order.items.length > 3 && (
                            <div className="flex h-16 w-16 items-center justify-center rounded-lg border-2 border-background bg-muted text-sm font-medium">
                              +{order.items.length - 3}
                            </div>
                          )}
                        </div>

                        {/* Order Details */}
                        <div className="flex-1 min-w-0">
                          <p className="font-medium line-clamp-1">
                            {order.items[0].title}
                            {order.items.length > 1 && ` and ${order.items.length - 1} more`}
                          </p>
                          <p className="text-sm text-muted-foreground mt-1">
                            {order.items.reduce((sum, item) => sum + item.quantity, 0)} items
                          </p>

                          {/* Shipping Address */}
                          <p className="text-sm text-muted-foreground mt-2">
                            Ship to: {order.shippingAddress.city}, {order.shippingAddress.province}
                          </p>
                        </div>

                        {/* Actions */}
                        <div className="flex flex-col gap-2">
                          {canProcess && (
                            <Button
                              size="sm"
                              onClick={() => handleMarkProcessing(order._id)}
                              disabled={isProcessing}
                            >
                              {isProcessing ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                "Start Processing"
                              )}
                            </Button>
                          )}

                          {canShip && (
                            <Button
                              size="sm"
                              onClick={() => openShippingDialog(order._id)}
                            >
                              <Truck className="mr-2 h-4 w-4" />
                              Mark Shipped
                            </Button>
                          )}

                          <Button variant="outline" size="sm" asChild>
                            <Link href={`${ROUTES.MESSAGES}?user=${order.buyerId}`}>
                              <MessageSquare className="mr-1 h-4 w-4" />
                              Message
                            </Link>
                          </Button>

                          <Button variant="ghost" size="sm" asChild>
                            <Link href={ROUTES.ORDER(order._id)}>
                              Details
                              <ChevronRight className="ml-1 h-4 w-4" />
                            </Link>
                          </Button>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })
          )}
        </TabsContent>
      </Tabs>

      {/* Shipping Dialog */}
      <Dialog open={shippingDialogOpen} onOpenChange={setShippingDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark Order as Shipped</DialogTitle>
            <DialogDescription>
              Add tracking information for the buyer (optional)
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="trackingNumber">Tracking Number</Label>
              <Input
                id="trackingNumber"
                placeholder="Enter tracking number"
                value={trackingNumber}
                onChange={(e) => setTrackingNumber(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="shippingCarrier">Shipping Carrier</Label>
              <Input
                id="shippingCarrier"
                placeholder="e.g., DHL, EMS, Local Courier"
                value={shippingCarrier}
                onChange={(e) => setShippingCarrier(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShippingDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button onClick={handleMarkShipped} disabled={isProcessing}>
              {isProcessing ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Updating...
                </>
              ) : (
                "Mark as Shipped"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SellerOrdersSkeleton() {
  return (
    <div className="container py-6">
      <Skeleton className="mb-6 h-4 w-48" />
      <Skeleton className="mb-6 h-8 w-40" />
      <Skeleton className="mb-6 h-10 w-96" />
      <div className="space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="p-0">
              <Skeleton className="h-16 w-full" />
              <div className="p-4">
                <div className="flex gap-4">
                  <Skeleton className="h-16 w-16 rounded-lg" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-5 w-3/4" />
                    <Skeleton className="h-4 w-1/4" />
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
