"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../../../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  Wallet,
  ArrowUpRight,
  ArrowDownLeft,
  TrendingUp,
  Clock,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Plus,
  Minus,
  History,
} from "lucide-react";
import { ROUTES } from "@/lib/constants";
import { formatZMW } from "@gettitonline/shared";
import { useAuth } from "@/hooks/useAuth";
import { formatDistanceToNow, format } from "date-fns";

type TransactionType = "credit" | "debit" | "hold" | "release" | "refund";
type TransactionStatus = "pending" | "completed" | "failed" | "cancelled";

const TYPE_CONFIG: Record<TransactionType, { label: string; icon: React.ElementType; color: string }> = {
  credit: { label: "Credit", icon: ArrowDownLeft, color: "text-green-600" },
  debit: { label: "Debit", icon: ArrowUpRight, color: "text-red-600" },
  hold: { label: "Hold", icon: Clock, color: "text-amber-600" },
  release: { label: "Release", icon: CheckCircle, color: "text-blue-600" },
  refund: { label: "Refund", icon: ArrowDownLeft, color: "text-green-600" },
};

const STATUS_CONFIG: Record<TransactionStatus, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  pending: { label: "Pending", variant: "outline" },
  completed: { label: "Completed", variant: "default" },
  failed: { label: "Failed", variant: "destructive" },
  cancelled: { label: "Cancelled", variant: "secondary" },
};

export default function WalletPage() {
  const { user, isSignedIn, isLoading: authLoading } = useAuth();

  // Get wallet data
  const wallet = useQuery(
    api.wallet.getWallet,
    user?._id ? { userId: user._id } : "skip"
  );

  // Get wallet activity
  const activity = useQuery(
    api.wallet.getWalletActivity,
    user?._id ? {} : "skip"
  );

  // Get transactions
  const transactions = useQuery(
    api.wallet.getWalletTransactions,
    user?._id ? { limit: 20 } : "skip"
  );

  // Create wallet mutation
  const createWallet = useMutation(api.wallet.createWallet);

  const handleCreateWallet = async () => {
    if (!user) return;
    await createWallet({});
  };

  // Loading state
  if (authLoading || (isSignedIn && wallet === undefined)) {
    return <WalletSkeleton />;
  }

  // Not signed in
  if (!isSignedIn) {
    return (
      <div className="container flex flex-col items-center justify-center py-16">
        <Wallet className="h-16 w-16 text-muted-foreground" />
        <h1 className="mt-4 text-2xl font-bold">My Wallet</h1>
        <p className="mt-2 text-muted-foreground">
          Please sign in to view your wallet
        </p>
        <Button asChild className="mt-6">
          <Link href={ROUTES.SIGN_IN}>Sign In</Link>
        </Button>
      </div>
    );
  }

  // No wallet yet
  if (wallet === null) {
    return (
      <div className="container flex flex-col items-center justify-center py-16">
        <Wallet className="h-16 w-16 text-muted-foreground" />
        <h1 className="mt-4 text-2xl font-bold">Get Started with Wallet</h1>
        <p className="mt-2 text-muted-foreground text-center max-w-md">
          Create your wallet to receive payments from sales, make purchases,
          and manage your funds securely.
        </p>
        <Button onClick={handleCreateWallet} className="mt-6">
          <Plus className="mr-2 h-4 w-4" />
          Create Wallet
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
            <BreadcrumbPage>Wallet</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <h1 className="mb-6 text-2xl font-bold">My Wallet</h1>

      {/* Frozen Warning */}
      {wallet?.isFrozen && (
        <Card className="mb-6 border-destructive bg-destructive/10">
          <CardContent className="flex items-center gap-3 p-4">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            <div>
              <p className="font-medium text-destructive">Wallet Frozen</p>
              <p className="text-sm text-muted-foreground">
                {wallet?.freezeReason || "Your wallet has been frozen. Please contact support."}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Balance Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4 mb-8">
        <Card className="bg-gradient-to-br from-primary/10 to-primary/5">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Available Balance</CardTitle>
            <Wallet className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-primary">{formatZMW(wallet?.balance ?? 0)}</div>
            <p className="text-xs text-muted-foreground mt-1">
              Ready to use
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Pending Balance</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatZMW(wallet?.pendingBalance ?? 0)}</div>
            <p className="text-xs text-muted-foreground mt-1">
              Awaiting release
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Total Earned</CardTitle>
            <TrendingUp className="h-4 w-4 text-green-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatZMW(wallet?.totalEarned ?? 0)}</div>
            <p className="text-xs text-muted-foreground mt-1">
              From sales
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Total Spent</CardTitle>
            <Minus className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatZMW(wallet?.totalSpent ?? 0)}</div>
            <p className="text-xs text-muted-foreground mt-1">
              On purchases
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Quick Stats */}
      {activity && (
        <div className="grid gap-4 md:grid-cols-3 mb-8">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
                  <ArrowDownLeft className="h-5 w-5 text-green-600" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">This Month&apos;s Earnings</p>
                  <p className="text-xl font-bold">{formatZMW(activity.thisMonthEarnings)}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30">
                  <ArrowUpRight className="h-5 w-5 text-red-600" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">This Month&apos;s Withdrawals</p>
                  <p className="text-xl font-bold">{formatZMW(activity.thisMonthWithdrawals)}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/30">
                  <Clock className="h-5 w-5 text-amber-600" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Pending Withdrawals</p>
                  <p className="text-xl font-bold">{formatZMW(activity.pendingWithdrawals)}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Transaction History */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Transaction History</CardTitle>
              <CardDescription>Your recent wallet activity</CardDescription>
            </div>
            <History className="h-5 w-5 text-muted-foreground" />
          </div>
        </CardHeader>
        <CardContent>
          {!transactions || transactions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <History className="h-12 w-12 text-muted-foreground" />
              <p className="mt-4 text-muted-foreground">No transactions yet</p>
              <p className="text-sm text-muted-foreground">
                Your transaction history will appear here
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {transactions.map((tx) => {
                const typeConfig = TYPE_CONFIG[tx.type as TransactionType] || TYPE_CONFIG.credit;
                const statusConfig = STATUS_CONFIG[tx.status as TransactionStatus] || STATUS_CONFIG.pending;
                const TypeIcon = typeConfig.icon;

                return (
                  <div
                    key={tx._id}
                    className="flex items-center justify-between border-b pb-4 last:border-0 last:pb-0"
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className={`flex h-10 w-10 items-center justify-center rounded-full bg-muted`}
                      >
                        <TypeIcon className={`h-5 w-5 ${typeConfig.color}`} />
                      </div>
                      <div>
                        <p className="font-medium">{tx.description}</p>
                        <p className="text-sm text-muted-foreground">
                          {format(tx.createdAt, "MMM d, yyyy 'at' h:mm a")}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p
                        className={`font-semibold ${
                          tx.type === "credit" || tx.type === "refund" || tx.type === "release"
                            ? "text-green-600"
                            : "text-red-600"
                        }`}
                      >
                        {tx.type === "credit" || tx.type === "refund" || tx.type === "release"
                          ? "+"
                          : "-"}
                        {formatZMW(tx.amount)}
                      </p>
                      <Badge variant={statusConfig.variant} className="text-xs">
                        {statusConfig.label}
                      </Badge>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function WalletSkeleton() {
  return (
    <div className="container py-6">
      <Skeleton className="mb-6 h-4 w-32" />
      <Skeleton className="mb-6 h-8 w-32" />
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4 mb-8">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-32 w-full rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-96 w-full rounded-lg" />
    </div>
  );
}
