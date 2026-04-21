"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "../../../../../../../convex/_generated/api";
import { Id } from "../../../../../../../convex/_generated/dataModel";
import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ROUTES } from "@/lib/constants";
import { formatZMW } from "@gettitonline/shared";

export default function SellerStorefrontPage() {
  const params = useParams();
  const sellerId = params.id as Id<"users">;
  const { user } = useAuth();

  const storefront = useQuery(api.vendors.getVendorStorefront, {
    sellerId,
    viewerUserId: user?._id,
  });
  const products = useQuery(api.products.getProductsBySeller, {
    sellerId,
    status: "active",
    viewerUserId: user?._id,
  });

  if (storefront === undefined || products === undefined) {
    return (
      <div className="container space-y-6 py-6">
        <Skeleton className="h-56 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (!storefront) {
    return (
      <div className="container flex flex-col items-center justify-center py-16">
        <h1 className="text-2xl font-bold">Store not found</h1>
        <p className="mt-2 text-muted-foreground">
          This storefront is unavailable or not approved for public browsing.
        </p>
        <Button asChild className="mt-6">
          <Link href={ROUTES.BROWSE}>Browse Products</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="container py-6">
      {storefront.bannerUrl ? (
        <div className="mb-6 h-56 overflow-hidden rounded-2xl border">
          <img
            src={storefront.bannerUrl}
            alt={`${storefront.displayName} banner`}
            className="h-full w-full object-cover"
          />
        </div>
      ) : null}

      <Card className="mb-6">
        <CardContent className="flex flex-col gap-6 p-6 md:flex-row md:items-center">
          <Avatar className="h-20 w-20">
            <AvatarImage src={storefront.logoUrl || undefined} />
            <AvatarFallback>
              {storefront.displayName.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>

          <div className="flex-1">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-3xl font-bold">{storefront.displayName}</h1>
              <Badge variant={storefront.isCompanyStore ? "default" : "secondary"}>
                {storefront.isCompanyStore ? "Official Store" : "Approved Vendor"}
              </Badge>
            </div>
            <p className="mt-2 text-muted-foreground">{storefront.description}</p>
            <div className="mt-3 flex flex-wrap gap-4 text-sm text-muted-foreground">
              <span>{storefront.contactEmail}</span>
              {storefront.contactPhone ? <span>{storefront.contactPhone}</span> : null}
              {storefront.address ? (
                <span>
                  {storefront.address.city}, {storefront.address.province}
                </span>
              ) : null}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Available Listings</CardTitle>
        </CardHeader>
        <CardContent>
          {products.length > 0 ? (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {products.map((product) => (
                <Link key={product._id} href={ROUTES.PRODUCT(product._id)}>
                  <div className="overflow-hidden rounded-xl border transition-colors hover:bg-muted/40">
                    <div className="aspect-square bg-muted">
                      <img
                        src={product.images[0] || "/placeholder.png"}
                        alt={product.title}
                        className="h-full w-full object-cover"
                      />
                    </div>
                    <div className="space-y-2 p-4">
                      <p className="font-medium">{product.title}</p>
                      <p className="text-sm text-muted-foreground">
                        {formatZMW(product.price)}
                      </p>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              No active listings are available from this store yet.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
