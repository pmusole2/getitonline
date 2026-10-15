"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "../../../../../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
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
  Package,
  Clock,
  Truck,
  CheckCircle,
  XCircle,
  AlertTriangle,
  ShoppingBag,
  ChevronRight,
} from "lucide-react";
import { ROUTES } from "@/lib/constants";
import { formatZMW } from "@gettitonline/shared";
import { useAuth } from "@/hooks/useAuth";
import { formatDistanceToNow } from "date-fns";

type OrderStatus =
  | "pending_payment"
  | "paid"
  | "processing"
  | "shipped"
  | "delivered"
  | "completed"
  | "cancelled"
  | "disputed";

const STATUS_CONFIG: Record<OrderStatus, { label: string; variant: "default" | "secondary" | "destructive" | "outline"; icon: React.ElementType }> = {
  pending_payment: { label: "Pending Payment", variant: "outline", icon: Clock },
  paid: { label: "Paid", variant: "secondary", icon: CheckCircle },
  processing: { label: "Processing", variant: "secondary", icon: Package },
  shipped: { label: "Shipped", variant: "default", icon: Truck },
  delivered: { label: "Delivered", variant: "default", icon: CheckCircle },
  completed: { label: "Completed", variant: "default", icon: CheckCircle },
  cancelled: { label: "Cancelled", variant: "destructive", icon: XCircle },
  disputed: { label: "Disputed", variant: "destructive", icon: AlertTriangle },
};

export default function OrdersPage() {
  const { user, isSignedIn, isLoading: authLoading } = useAuth();
  const [activeTab, setActiveTab] = useState<"all" | "active" | "completed">("all");

  // Get buyer orders
  const orders = useQuery(
    api.orders.getBuyerOrders,
    user?._id ? {} : "skip"
  );

  // Loading state
  if (authLoading || (isSignedIn && orders === undefined)) {
    return <OrdersSkeleton />;
  }

  // Not signed in
  if (!isSignedIn) {
    return (
      <div className="container flex flex-col items-center justify-center py-16">
        <Package className="h-16 w-16 text-muted-foreground" />
        <h1 className="mt-4 text-2xl font-bold">My Orders</h1>
        <p className="mt-2 text-muted-foreground">
          Please sign in to view your orders
        </p>
        <Button asChild className="mt-6">
          <Link href={ROUTES.SIGN_IN}>Sign In</Link>
        </Button>
      </div>
    );
  }

  // Filter orders based on tab
  const filteredOrders = orders?.filter((order) => {
    if (activeTab === "all") return true;
    if (activeTab === "active") {
      return ["pending_payment", "paid", "processing", "shipped", "delivered"].includes(order.status);
    }
    if (activeTab === "completed") {
      return ["completed", "cancelled"].includes(order.status);
    }
    return true;
  });

  // Empty state
  if (!orders || orders.length === 0) {
    return (
      <div className="container flex flex-col items-center justify-center py-16">
        <ShoppingBag className="h-16 w-16 text-muted-foreground" />
        <h1 className="mt-4 text-2xl font-bold">No orders yet</h1>
        <p className="mt-2 text-muted-foreground">
          Start shopping to see your orders here
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
            <BreadcrumbPage>My Orders</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <h1 className="mb-6 text-2xl font-bold">My Orders</h1>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)}>
        <TabsList className="mb-6">
          <TabsTrigger value="all">
            All Orders ({orders.length})
          </TabsTrigger>
          <TabsTrigger value="active">
            Active ({orders.filter((o) => ["pending_payment", "paid", "processing", "shipped", "delivered"].includes(o.status)).length})
          </TabsTrigger>
          <TabsTrigger value="completed">
            Completed ({orders.filter((o) => ["completed", "cancelled"].includes(o.status)).length})
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
                        <p className="font-semibold">{formatZMW(order.totalAmount)}</p>
                        <p className="text-xs text-muted-foreground">
                          Store: {order.seller?.firstName} {order.seller?.lastName}
                        </p>
                      </div>
                    </div>

                    {/* Order Items */}
                    <div className="p-4">
                      <div className="flex gap-4">
                        {/* Product Images (show first 3) */}
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

                          {/* Tracking Info */}
                          {order.trackingNumber && (
                            <p className="text-sm text-muted-foreground mt-2">
                              Tracking: {order.trackingNumber}
                            </p>
                          )}
                        </div>

                        {/* Actions */}
                        <div className="flex items-center">
                          <Button variant="ghost" size="sm" asChild>
                            <Link href={ROUTES.ORDER(order._id)}>
                              View Details
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
    </div>
  );
}

function OrdersSkeleton() {
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
