"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Users,
  Package,
  ShoppingCart,
  AlertTriangle,
  Wallet,
  TrendingUp,
  TrendingDown,
  ArrowRight,
  ClipboardCheck,
} from "lucide-react";
import { useQuery } from "convex/react";
import { api } from "../../../../../../convex/_generated/api";
import Link from "next/link";
import { ROUTES } from "@/lib/constants";
import { formatZMW } from "@gettitonline/shared";
import { useAccountAccess, type AccountUser } from "@/hooks/useAccountAccess";
import { AccountAccessNotice } from "@/components/common/AccountAccessNotice";

export default function AdminDashboard() {
  const access = useAccountAccess();
  const user = access.user;

  if (access.status !== "ready" || !user) {
    return (
      <AccountAccessNotice
        access={access}
        heading="Staff workspace"
        signInMessage="Please sign in to use this area."
      />
    );
  }

  if (user.role === "moderator") {
    return <ReviewerDashboard key={user._id} user={user} />;
  }

  if (user.role !== "admin") {
    return <p>Access Restricted</p>;
  }

  return <AdminDashboardContent key={user._id} user={user} />;
}

function ReviewerDashboard({ user }: { user: AccountUser }) {
  const pendingListings = useQuery(api.products.getPendingReviewListings, {
    reviewerId: user._id,
    status: "pending_review",
  });
  const openDisputes = useQuery(api.disputes.getOpenDisputes, {
    moderatorId: user._id,
  });

  if (pendingListings === undefined || openDisputes === undefined) {
    return <Skeleton className="h-64 w-full" />;
  }

  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-bold">Review workspace</h1>
      <p>
        {pendingListings.length} pending listings · {openDisputes.length} open
        disputes
      </p>
      <Button asChild>
        <Link href={ROUTES.ADMIN_LISTING_REVIEW}>Review listings</Link>
      </Button>
    </div>
  );
}

function AdminDashboardContent({ user }: { user: AccountUser }) {
  // Get stats (only if user is available)
  const orderStats = useQuery(
    api.orders.getOrderStats,
    user?._id ? { adminId: user._id } : "skip",
  );
  const escrowStats = useQuery(
    api.escrow.getEscrowStats,
    user?._id ? { adminId: user._id } : "skip",
  );
  const disputeStats = useQuery(
    api.disputes.getDisputeStats,
    user?._id ? { adminId: user._id } : "skip",
  );
  const pendingListings = useQuery(
    api.products.getPendingReviewListings,
    user?._id ? { reviewerId: user._id, status: "pending_review" } : "skip",
  );

  // Get open disputes
  const openDisputes = useQuery(
    api.disputes.getOpenDisputes,
    user?._id ? { moderatorId: user._id } : "skip",
  );

  const isLoading =
    !orderStats || !escrowStats || !disputeStats || !pendingListings;

  const stats = [
    {
      title: "Total Orders",
      value: orderStats?.total ?? 0,
      icon: ShoppingCart,
      change: "+12%",
      trend: "up" as const,
      href: ROUTES.ADMIN_ORDERS,
    },
    {
      title: "Processing",
      value: orderStats?.processing ?? 0,
      icon: Package,
      change: "Active",
      trend: "up" as const,
      href: ROUTES.ADMIN_ORDERS,
    },
    {
      title: "Open Disputes",
      value: disputeStats?.open ?? 0,
      icon: AlertTriangle,
      change:
        disputeStats?.open && disputeStats.open > 0
          ? "Needs attention"
          : "All clear",
      trend:
        disputeStats?.open && disputeStats.open > 0
          ? ("down" as const)
          : ("up" as const),
      href: ROUTES.ADMIN_DISPUTES,
    },
    {
      title: "Pending Listings",
      value: pendingListings?.length ?? 0,
      icon: ClipboardCheck,
      change:
        pendingListings && pendingListings.length > 0
          ? "Approve now"
          : "All clear",
      trend:
        pendingListings && pendingListings.length > 0
          ? ("down" as const)
          : ("up" as const),
      href: ROUTES.ADMIN_LISTING_REVIEW,
    },
    {
      title: "Escrow Balance",
      value: formatZMW(escrowStats?.totalGrossHeld ?? 0),
      icon: Wallet,
      change: `${escrowStats?.heldCount ?? 0} held`,
      trend: "up" as const,
      href: ROUTES.ADMIN_ESCROW,
    },
  ];

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-3xl font-bold">Dashboard</h1>
        <p className="text-muted-foreground">
          Overview of your marketplace performance
        </p>
      </div>

      {/* Stats Grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {isLoading
          ? Array.from({ length: 5 }).map((_, i) => (
              <Card key={i}>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-8 w-8 rounded-full" />
                </CardHeader>
                <CardContent>
                  <Skeleton className="mb-2 h-8 w-20" />
                  <Skeleton className="h-3 w-16" />
                </CardContent>
              </Card>
            ))
          : stats.map((stat) => (
              <Link key={stat.title} href={stat.href}>
                <Card className="transition-colors hover:bg-muted/50">
                  <CardHeader className="flex flex-row items-center justify-between pb-2">
                    <CardTitle className="text-sm font-medium text-muted-foreground">
                      {stat.title}
                    </CardTitle>
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10">
                      <stat.icon className="h-4 w-4 text-primary" />
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">{stat.value}</div>
                    <div className="flex items-center gap-1 text-xs">
                      {stat.trend === "up" ? (
                        <TrendingUp className="h-3 w-3 text-green-500" />
                      ) : (
                        <TrendingDown className="h-3 w-3 text-red-500" />
                      )}
                      <span
                        className={
                          stat.trend === "up"
                            ? "text-green-500"
                            : "text-red-500"
                        }
                      >
                        {stat.change}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
      </div>

      {/* Content Grid */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Open Disputes */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Open Disputes</CardTitle>
            <Button variant="ghost" size="sm" asChild>
              <Link href={ROUTES.ADMIN_DISPUTES}>
                View All
                <ArrowRight className="ml-1 h-4 w-4" />
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            {!openDisputes ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-4">
                    <Skeleton className="h-10 w-10 rounded-full" />
                    <div className="flex-1">
                      <Skeleton className="mb-2 h-4 w-3/4" />
                      <Skeleton className="h-3 w-1/2" />
                    </div>
                  </div>
                ))}
              </div>
            ) : openDisputes.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/20">
                  <AlertTriangle className="h-6 w-6 text-green-600 dark:text-green-400" />
                </div>
                <p className="mt-4 font-medium">No open disputes</p>
                <p className="text-sm text-muted-foreground">
                  All disputes have been resolved
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {openDisputes.slice(0, 5).map((dispute) => (
                  <Link
                    key={dispute._id}
                    href={`${ROUTES.ADMIN_DISPUTES}/${dispute._id}`}
                    className="block"
                  >
                    <div className="flex items-start justify-between gap-4 rounded-lg border p-3 transition-colors hover:bg-muted/50">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{dispute.title}</p>
                        <p className="text-sm text-muted-foreground">
                          {dispute.category === "not_received"
                            ? "Item Not Received"
                            : dispute.category === "defective"
                              ? "Defective Item"
                              : dispute.category === "not_as_described"
                                ? "Not as Described"
                                : "Other"}
                        </p>
                      </div>
                      <Badge
                        variant={
                          dispute.status === "open"
                            ? "destructive"
                            : dispute.status === "moderator_review"
                              ? "default"
                              : "secondary"
                        }
                      >
                        {dispute.status === "open"
                          ? "Open"
                          : dispute.status === "in_discussion"
                            ? "In Discussion"
                            : dispute.status === "moderator_review"
                              ? "Under Review"
                              : dispute.status}
                      </Badge>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Quick Actions */}
        <Card>
          <CardHeader>
            <CardTitle>Quick Actions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2">
              <Button
                variant="outline"
                className="h-auto justify-start py-4"
                asChild
              >
                <Link href={ROUTES.ADMIN_USERS}>
                  <Users className="mr-2 h-5 w-5" />
                  <div className="text-left">
                    <div className="font-medium">Manage Users</div>
                    <div className="text-xs text-muted-foreground">
                      View and manage user accounts
                    </div>
                  </div>
                </Link>
              </Button>
              <Button
                variant="outline"
                className="h-auto justify-start py-4"
                asChild
              >
                <Link href={ROUTES.ADMIN_LISTING_REVIEW}>
                  <ClipboardCheck className="mr-2 h-5 w-5" />
                  <div className="text-left">
                    <div className="font-medium">Approve Listings</div>
                    <div className="text-xs text-muted-foreground">
                      Publish pending products to the store
                    </div>
                  </div>
                </Link>
              </Button>
              <Button
                variant="outline"
                className="h-auto justify-start py-4"
                asChild
              >
                <Link href={ROUTES.ADMIN_DISPUTES}>
                  <AlertTriangle className="mr-2 h-5 w-5" />
                  <div className="text-left">
                    <div className="font-medium">Dispute Queue</div>
                    <div className="text-xs text-muted-foreground">
                      Resolve pending disputes
                    </div>
                  </div>
                </Link>
              </Button>
              <Button
                variant="outline"
                className="h-auto justify-start py-4"
                asChild
              >
                <Link href={ROUTES.ADMIN_ANALYTICS}>
                  <TrendingUp className="mr-2 h-5 w-5" />
                  <div className="text-left">
                    <div className="font-medium">Analytics</div>
                    <div className="text-xs text-muted-foreground">
                      View performance metrics
                    </div>
                  </div>
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Escrow Summary */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Escrow Summary</CardTitle>
          <Button variant="ghost" size="sm" asChild>
            <Link href={ROUTES.ADMIN_ESCROW}>
              View Details
              <ArrowRight className="ml-1 h-4 w-4" />
            </Link>
          </Button>
        </CardHeader>
        <CardContent>
          {!escrowStats ? (
            <div className="grid gap-4 md:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="text-center">
                  <Skeleton className="mx-auto mb-2 h-8 w-24" />
                  <Skeleton className="mx-auto h-4 w-16" />
                </div>
              ))}
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-4">
              <div className="text-center">
                <div className="text-2xl font-bold text-yellow-600">
                  {formatZMW(escrowStats.totalGrossHeld)}
                </div>
                <p className="text-sm text-muted-foreground">
                  Held ({escrowStats.heldCount})
                </p>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-green-600">
                  {formatZMW(escrowStats.totalGrossReleased)}
                </div>
                <p className="text-sm text-muted-foreground">
                  Released ({escrowStats.releasedCount})
                </p>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-red-600">
                  {formatZMW(escrowStats.totalGrossRefunded)}
                </div>
                <p className="text-sm text-muted-foreground">
                  Refunded ({escrowStats.refundedCount})
                </p>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-orange-600">
                  {escrowStats.disputedCount}
                </div>
                <p className="text-sm text-muted-foreground">Disputed</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Platform Fees */}
      {escrowStats && (
        <Card>
          <CardHeader>
            <CardTitle>Platform Revenue</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-3">
              <div className="rounded-lg border p-4 text-center">
                <div className="text-2xl font-bold text-primary">
                  {formatZMW(escrowStats.totalPlatformFees)}
                </div>
                <p className="text-sm text-muted-foreground">
                  Total Platform Fees (5%)
                </p>
              </div>
              <div className="rounded-lg border p-4 text-center">
                <div className="text-2xl font-bold">
                  {formatZMW(escrowStats.totalSellerPayouts)}
                </div>
                <p className="text-sm text-muted-foreground">
                  Total Seller Payouts
                </p>
              </div>
              <div className="rounded-lg border p-4 text-center">
                <div className="text-2xl font-bold">
                  {formatZMW(escrowStats.totalSellerPending)}
                </div>
                <p className="text-sm text-muted-foreground">
                  Pending Seller Payouts
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
