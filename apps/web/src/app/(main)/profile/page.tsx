"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
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
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
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
  User,
  Mail,
  Phone,
  MapPin,
  Calendar,
  Star,
  Package,
  ShoppingBag,
  Settings,
  Edit,
  Shield,
} from "lucide-react";
import { ROUTES } from "@/lib/constants";
import { useAuth } from "@/hooks/useAuth";
import { format } from "date-fns";
import { canManageCatalog } from "@/lib/roles";

export default function ProfilePage() {
  const { user, isSignedIn, isLoading: authLoading, clerkUser } = useAuth();
  const hasCatalogAccess = canManageCatalog(user?.role);

  // Get user's stats
  const products = useQuery(
    api.products.getManagedCatalogProducts,
    user?._id && hasCatalogAccess ? { actorUserId: user._id, status: "active" } : "skip"
  );

  const orders = useQuery(
    api.orders.getBuyerOrders,
    user?._id ? { buyerId: user._id } : "skip"
  );

  // Loading state
  if (authLoading || (isSignedIn && user === undefined)) {
    return <ProfileSkeleton />;
  }

  // Not signed in
  if (!isSignedIn || !user) {
    return (
      <div className="container flex flex-col items-center justify-center py-16">
        <User className="h-16 w-16 text-muted-foreground" />
        <h1 className="mt-4 text-2xl font-bold">Profile</h1>
        <p className="mt-2 text-muted-foreground">
          Please sign in to view your profile
        </p>
        <Button asChild className="mt-6">
          <Link href={ROUTES.SIGN_IN}>Sign In</Link>
        </Button>
      </div>
    );
  }

  const stats = {
    activeListings: products?.length || 0,
    totalPurchases: user.totalPurchases || 0,
    totalSales: user.totalSales || 0,
    rating: user.rating || 0,
    reviewCount: 0,
  };

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
            <BreadcrumbPage>Profile</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Profile Card */}
        <div className="lg:col-span-1">
          <Card>
            <CardContent className="pt-6">
              <div className="flex flex-col items-center text-center">
                <Avatar className="h-24 w-24">
                  <AvatarImage src={user.avatar || clerkUser?.imageUrl} />
                  <AvatarFallback className="text-2xl">
                    {user.firstName?.[0]}
                    {user.lastName?.[0]}
                  </AvatarFallback>
                </Avatar>

                <h1 className="mt-4 text-xl font-bold">
                  {user.firstName} {user.lastName}
                </h1>

                <div className="flex items-center gap-2 mt-1">
                  {user.isVerified && (
                    <Badge variant="secondary" className="gap-1">
                      <Shield className="h-3 w-3" />
                      Verified
                    </Badge>
                  )}
                  {user.role === "admin" && (
                    <Badge variant="default">Admin</Badge>
                  )}
                  {user.role === "catalog_manager" && (
                    <Badge variant="secondary">Catalog Manager</Badge>
                  )}
                  {user.role === "moderator" && (
                    <Badge variant="secondary">Moderator</Badge>
                  )}
                </div>

                {stats.rating > 0 && (
                  <div className="flex items-center gap-1 mt-3">
                    <Star className="h-4 w-4 fill-yellow-400 text-yellow-400" />
                    <span className="font-medium">{stats.rating.toFixed(1)}</span>
                    <span className="text-muted-foreground">
                      ({stats.reviewCount} reviews)
                    </span>
                  </div>
                )}

                <p className="text-sm text-muted-foreground mt-2">
                  <Calendar className="inline h-3 w-3 mr-1" />
                  Member since {format(user.createdAt, "MMMM yyyy")}
                </p>

                <Separator className="my-4" />

                <div className="grid grid-cols-3 gap-4 w-full text-center">
                  <div>
                    <p className="text-2xl font-bold">{stats.activeListings}</p>
                    <p className="text-xs text-muted-foreground">
                      {hasCatalogAccess ? "Catalog" : "Listings"}
                    </p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold">{stats.totalSales}</p>
                    <p className="text-xs text-muted-foreground">Sales</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold">{stats.totalPurchases}</p>
                    <p className="text-xs text-muted-foreground">Purchases</p>
                  </div>
                </div>

                <Separator className="my-4" />

                <div className="flex gap-2 w-full">
                  <Button variant="outline" className="flex-1" asChild>
                    <Link href={ROUTES.EDIT_PROFILE}>
                      <Edit className="mr-2 h-4 w-4" />
                      Edit Profile
                    </Link>
                  </Button>
                  <Button variant="outline" asChild>
                    <Link href={ROUTES.SETTINGS}>
                      <Settings className="h-4 w-4" />
                    </Link>
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Details */}
        <div className="lg:col-span-2 space-y-6">
          {/* Contact Info */}
          <Card>
            <CardHeader>
              <CardTitle>Contact Information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-3">
                <Mail className="h-5 w-5 text-muted-foreground" />
                <div>
                  <p className="text-sm text-muted-foreground">Email</p>
                  <p className="font-medium">{user.email}</p>
                </div>
              </div>

              {user.phone && (
                <div className="flex items-center gap-3">
                  <Phone className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="text-sm text-muted-foreground">Phone</p>
                    <p className="font-medium">{user.phone}</p>
                  </div>
                </div>
              )}

              {user.address && (
                <div className="flex items-center gap-3">
                  <MapPin className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="text-sm text-muted-foreground">Location</p>
                    <p className="font-medium">
                      {user.address.city && `${user.address.city}, `}
                      {user.address.province}
                    </p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Quick Links */}
          <Card>
            <CardHeader>
              <CardTitle>Quick Links</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 sm:grid-cols-2">
                <Button variant="outline" className="justify-start h-auto py-4" asChild>
                  <Link href={ROUTES.ORDERS}>
                    <ShoppingBag className="mr-3 h-5 w-5" />
                    <div className="text-left">
                      <p className="font-medium">My Orders</p>
                      <p className="text-xs text-muted-foreground">
                        View purchase history
                      </p>
                    </div>
                  </Link>
                </Button>

                {hasCatalogAccess && (
                  <Button variant="outline" className="justify-start h-auto py-4" asChild>
                    <Link href={ROUTES.SELL}>
                      <Package className="mr-3 h-5 w-5" />
                      <div className="text-left">
                        <p className="font-medium">Catalog</p>
                        <p className="text-xs text-muted-foreground">
                          Manage storefront products
                        </p>
                      </div>
                    </Link>
                  </Button>
                )}

                <Button variant="outline" className="justify-start h-auto py-4" asChild>
                  <Link href={ROUTES.WALLET}>
                    <svg
                      className="mr-3 h-5 w-5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      viewBox="0 0 24 24"
                    >
                      <rect x="2" y="6" width="20" height="12" rx="2" />
                      <circle cx="16" cy="12" r="2" />
                    </svg>
                    <div className="text-left">
                      <p className="font-medium">Wallet</p>
                      <p className="text-xs text-muted-foreground">
                        Manage your funds
                      </p>
                    </div>
                  </Link>
                </Button>

                <Button variant="outline" className="justify-start h-auto py-4" asChild>
                  <Link href={ROUTES.FAVORITES}>
                    <svg
                      className="mr-3 h-5 w-5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      viewBox="0 0 24 24"
                    >
                      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                    </svg>
                    <div className="text-left">
                      <p className="font-medium">Favorites</p>
                      <p className="text-xs text-muted-foreground">
                        Saved products
                      </p>
                    </div>
                  </Link>
                </Button>
              </div>
            </CardContent>
          </Card>

        </div>
      </div>
    </div>
  );
}

function ProfileSkeleton() {
  return (
    <div className="container py-6">
      <Skeleton className="mb-6 h-4 w-32" />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-1">
          <Skeleton className="h-96 w-full rounded-lg" />
        </div>
        <div className="lg:col-span-2 space-y-6">
          <Skeleton className="h-48 w-full rounded-lg" />
          <Skeleton className="h-64 w-full rounded-lg" />
        </div>
      </div>
    </div>
  );
}
