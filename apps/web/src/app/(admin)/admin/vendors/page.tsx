"use client";

import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../../../../convex/_generated/api";
import { Id } from "../../../../../../../convex/_generated/dataModel";
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

export default function AdminVendorsPage() {
  const { user, isLoading: authLoading } = useAuth();
  const applications = useQuery(
    api.vendors.getPendingApplications,
    user?._id ? { adminId: user._id } : "skip"
  );
  const reviewApplication = useMutation(api.vendors.reviewApplication);

  if (authLoading || (user?.role === "admin" && applications === undefined)) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (user?.role !== "admin") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Access Restricted</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Only Super Admins can review vendor applications.
        </CardContent>
      </Card>
    );
  }

  const handleReview = async (
    vendorProfileId: string,
    decision: "approved" | "changes_requested" | "suspended"
  ) => {
    try {
      await reviewApplication({
        adminId: user._id,
        vendorProfileId: vendorProfileId as Id<"vendorProfiles">,
        decision,
        reviewNotes:
          decision === "changes_requested"
            ? "Please update your store details and resubmit."
            : undefined,
      });
      toast.success("Vendor application updated.");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to review application";
      toast.error(message);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Vendor Applications</h1>
        <p className="text-muted-foreground">
          Review new storefront applications before vendors can list products.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Pending Applications</CardTitle>
        </CardHeader>
        <CardContent>
          {applications && applications.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Store</TableHead>
                  <TableHead>Applicant</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {applications.map((application) => (
                  <TableRow key={application._id}>
                    <TableCell>
                      <div>
                        <p className="font-medium">{application.storeName}</p>
                        <p className="text-sm text-muted-foreground">
                          {application.address.city}, {application.address.province}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell>
                      {application.owner
                        ? `${application.owner.firstName} ${application.owner.lastName}`
                        : "Unknown user"}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">Pending</Badge>
                    </TableCell>
                    <TableCell>{application.contactEmail}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          onClick={() =>
                            handleReview(application._id, "approved")
                          }
                        >
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            handleReview(application._id, "changes_requested")
                          }
                        >
                          Request Changes
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() =>
                            handleReview(application._id, "suspended")
                          }
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
              No pending vendor applications.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
