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

export default function SellerStorefrontPage() {
  const params = useParams();
  const sellerId = params.id as Id<"users">;
  const { user } = useAuth();

  const storefront = useQuery(api.vendors.getVendorStorefront, {
    sellerId,
    viewerUserId: user?._id,
  });
  const reviews = useQuery(api.reviews.getSellerReviews, { sellerId });

  if (storefront === undefined || reviews === undefined) {
    return (
      <div className="container space-y-6 py-6">
        <Skeleton className="h-56 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
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
          </div>
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Store Summary</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg border p-4">
              <p className="text-2xl font-bold">{storefront.totalSales}</p>
              <p className="text-sm text-muted-foreground">Total sales</p>
            </div>
            <div className="rounded-lg border p-4">
              <p className="text-2xl font-bold">
                {storefront.rating?.toFixed(1) || "N/A"}
              </p>
              <p className="text-sm text-muted-foreground">
                {reviews.length} ratings & reviews
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Ratings & Reviews</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {reviews.length > 0 ? (
            reviews.map((review) => (
              <div key={review._id} className="rounded-lg border p-4">
                <div className="flex items-center justify-between gap-4">
                  <p className="font-medium">
                    {review.reviewer
                      ? `${review.reviewer.firstName} ${review.reviewer.lastName}`
                      : "Anonymous"}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {review.rating}/5
                  </p>
                </div>
                {review.comment ? (
                  <p className="mt-2 text-sm text-muted-foreground">
                    {review.comment}
                  </p>
                ) : null}
              </div>
            ))
          ) : (
            <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              No reviews yet.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
