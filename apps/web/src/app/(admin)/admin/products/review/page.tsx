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
import { aiFailureMessage } from "@gettitonline/shared";
import { useAiActions } from "@/hooks/useAiActions";
import { useAiConsentGate } from "@/hooks/useAiConsentGate";

export default function ListingReviewPage() {
  const { user, isLoading: authLoading } = useAuth();
  const listings = useQuery(
    api.products.getPendingReviewListings,
    user?._id ? { reviewerId: user._id } : "skip"
  );
  const reviewListing = useMutation(api.products.reviewListing);
  const [runningAiFor, setRunningAiFor] = useState<string | null>(null);
  const ai = useAiActions();
  const aiGate = useAiConsentGate(ai.subject);
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

    // Busy is set only when the action starts, so a disclosure that is still open never leaves the row stuck on running.
    await aiGate.runWithConsent(
      "listing_moderation",
      async () => {
        setRunningAiFor(listing._id);
        try {
          // The backend reads the stored listing, so only its id is sent.
          const result = await ai.moderateListing({ productId: listing._id });
          // A result for a previous account is not shown to the account that is active now.
          if (!ai.isCurrent()) return;
          if (result.saved) {
            toast.success(`AI moderation saved a ${result.status} result. ${result.summary}`);
          } else {
            // The fallback is not saved and is not a moderation decision.
            toast.error(`${result.summary} Nothing was saved.`);
          }
        } catch (error: unknown) {
          const message = aiFailureMessage(error);
          if (message !== null && ai.isCurrent()) {
            toast.error(message);
          }
        } finally {
          // Keyed by the listing, so this clears only this listing's busy mark, never another running check.
          setRunningAiFor((current) =>
            current === listing._id ? null : current,
          );
        }
      },
      () => undefined,
    );
  };

  return (
    <div className="space-y-6">
      {aiGate.consentDialog}
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
