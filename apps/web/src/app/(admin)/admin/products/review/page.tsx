"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../../../../../convex/_generated/api";
import { Id } from "../../../../../../../../convex/_generated/dataModel";
import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";

export default function ListingReviewPage() {
  const { user, isLoading: authLoading } = useAuth();
  const listings = useQuery(
    api.products.getPendingReviewListings,
    user?._id ? { reviewerId: user._id } : "skip"
  );
  const reviewListing = useMutation(api.products.reviewListing);
  const [runningAiFor, setRunningAiFor] = useState<string | null>(null);
  type ReviewListing = NonNullable<typeof listings>[number];

  if (
    authLoading ||
    ((user?.role === "admin" || user?.role === "moderator") &&
      listings === undefined)
  ) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (user?.role !== "admin" && user?.role !== "moderator") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Access Restricted</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Only Super Admins and Reviewer-Approvers can review listings.
        </CardContent>
      </Card>
    );
  }

  const handleReview = async (
    productId: string,
    decision: "approved" | "changes_requested" | "rejected" | "suspended"
  ) => {
    try {
      await reviewListing({
        productId: productId as Id<"products">,
        reviewerId: user._id,
        decision,
        reviewNotes:
          decision === "changes_requested"
            ? "Please improve listing accuracy or image quality and resubmit."
            : decision === "rejected"
              ? "Listing rejected because it does not meet Gettitonline publishing standards."
            : undefined,
      });
      toast.success("Listing review updated.");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to review listing";
      toast.error(message);
    }
  };

  const handleAiModeration = async (listing: ReviewListing) => {
    if (!user) {
      return;
    }

    const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
    const apiPrefixUrl = apiBaseUrl.endsWith("/api/v1")
      ? apiBaseUrl
      : `${apiBaseUrl.replace(/\/$/, "")}/api/v1`;
    setRunningAiFor(listing._id);

    try {
      const response = await fetch(`${apiPrefixUrl}/ai/moderate-listing`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          reviewerId: user._id,
          productId: listing._id,
          title: listing.title,
          description: listing.description,
          price: listing.price,
          quantity: listing.quantity,
          imageUrls: listing.images,
          categoryName: listing.category?.name,
        }),
      });

      if (!response.ok) {
        throw new Error("AI moderation request failed");
      }

      toast.success("AI moderation completed.");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to run AI moderation";
      toast.error(message);
    } finally {
      setRunningAiFor(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Listing Review</h1>
        <p className="text-muted-foreground">
          Review vendor and company listings before they become public.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Pending Review</CardTitle>
        </CardHeader>
        <CardContent>
          {listings && listings.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Listing</TableHead>
                  <TableHead>Store</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>AI</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {listings.map((listing) => (
                  <TableRow key={listing._id}>
                    <TableCell>
                      <div>
                        <p className="font-medium">{listing.title}</p>
                        <p className="text-sm text-muted-foreground">
                          {listing.price.toLocaleString()} ZMW
                        </p>
                      </div>
                    </TableCell>
                    <TableCell>{listing.seller?.displayName ?? "Unknown store"}</TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {listing.status === "pending_review"
                          ? "Pending Review"
                          : "Changes Requested"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {listing.aiModerationStatus ? (
                        <Badge
                          variant={
                            listing.aiModerationStatus === "flagged"
                              ? "destructive"
                              : listing.aiModerationStatus === "error"
                                ? "outline"
                                : "default"
                          }
                        >
                          {listing.aiModerationStatus}
                        </Badge>
                      ) : (
                        <span className="text-sm text-muted-foreground">
                          Not analyzed
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          onClick={() => handleReview(listing._id, "approved")}
                        >
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={runningAiFor === listing._id}
                          onClick={() => void handleAiModeration(listing)}
                        >
                          {runningAiFor === listing._id ? "Running AI..." : "Run AI Check"}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            handleReview(listing._id, "changes_requested")
                          }
                        >
                          Request Changes
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => handleReview(listing._id, "rejected")}
                        >
                          Reject
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleReview(listing._id, "suspended")}
                        >
                          Suspend
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              No pending listings.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
