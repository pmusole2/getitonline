"use client";

import { ChangeEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useConvex, useMutation, useQuery } from "convex/react";
import { api } from "../../../../../../convex/_generated/api";
import { Id } from "../../../../../../convex/_generated/dataModel";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Building2,
  ClipboardCheck,
  Loader2,
  Package,
  ShieldCheck,
  ShoppingBag,
  Store,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { formatZMW } from "@gettitonline/shared";
import { ROUTES } from "@/lib/constants";
import {
  canManageCatalog,
  canManageListings,
  isReviewerRole,
} from "@/lib/roles";

type VendorStatus =
  | "pending"
  | "approved"
  | "changes_requested"
  | "suspended";

type ProductStatus =
  | "draft"
  | "pending_review"
  | "changes_requested"
  | "active"
  | "sold"
  | "suspended";

const vendorStatusCopy: Record<
  VendorStatus,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  pending: { label: "Pending Review", variant: "outline" },
  approved: { label: "Approved", variant: "default" },
  changes_requested: { label: "Changes Requested", variant: "secondary" },
  suspended: { label: "Suspended", variant: "destructive" },
};

const productStatusCopy: Record<
  ProductStatus,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  draft: { label: "Draft", variant: "outline" },
  pending_review: { label: "Pending Review", variant: "secondary" },
  changes_requested: { label: "Changes Requested", variant: "secondary" },
  active: { label: "Active", variant: "default" },
  sold: { label: "Sold", variant: "secondary" },
  suspended: { label: "Suspended", variant: "destructive" },
};

type VendorApplicationForm = {
  storeName: string;
  description: string;
  logoUrl: string;
  bannerUrl: string;
  contactEmail: string;
  contactPhone: string;
  street: string;
  city: string;
  province: string;
  country: string;
  website: string;
  instagram: string;
  facebook: string;
};

const emptyVendorForm: VendorApplicationForm = {
  storeName: "",
  description: "",
  logoUrl: "",
  bannerUrl: "",
  contactEmail: "",
  contactPhone: "",
  street: "",
  city: "",
  province: "",
  country: "Zambia",
  website: "",
  instagram: "",
  facebook: "",
};

function ListingTable({
  products,
}: {
  products: Array<{
    _id: string;
    title: string;
    price: number;
    quantity: number;
    status: ProductStatus;
    updatedAt: number;
  }>;
}) {
  if (products.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        No listings yet.
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Listing</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Price</TableHead>
          <TableHead>Stock</TableHead>
          <TableHead>Updated</TableHead>
          <TableHead className="text-right">Open</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {products.map((product) => (
          <TableRow key={product._id}>
            <TableCell className="font-medium">{product.title}</TableCell>
            <TableCell>
              <Badge variant={productStatusCopy[product.status].variant}>
                {productStatusCopy[product.status].label}
              </Badge>
            </TableCell>
            <TableCell>{formatZMW(product.price)}</TableCell>
            <TableCell>{product.quantity}</TableCell>
            <TableCell>
              {formatDistanceToNow(new Date(product.updatedAt), {
                addSuffix: true,
              })}
            </TableCell>
            <TableCell className="text-right">
              <Button variant="ghost" size="sm" asChild>
                <Link href={ROUTES.PRODUCT(product._id)}>View</Link>
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default function SellDashboardPage() {
  const { user, isSignedIn, isLoading: authLoading } = useAuth();
  const convex = useConvex();
  const vendorProfile = useQuery(
    api.vendors.getMyVendorProfile,
    user?._id ? { ownerUserId: user._id } : "skip"
  );
  const submitApplication = useMutation(api.vendors.submitApplication);
  const generateUploadUrl = useMutation(api.storage.generateUploadUrl);

  const isCompanyCatalogManager = canManageCatalog(user?.role);
  const isReviewerOnly = isReviewerRole(user?.role) && !isCompanyCatalogManager;
  const hasListingAccess = canManageListings(
    user?.role,
    vendorProfile?.status ?? null
  );

  const companyProducts = useQuery(
    api.products.getManagedCatalogProducts,
    user?._id && isCompanyCatalogManager ? { actorUserId: user._id } : "skip"
  );
  const companyOrders = useQuery(
    api.orders.getManagedCatalogOrders,
    user?._id && isCompanyCatalogManager ? { actorUserId: user._id } : "skip"
  );
  const vendorProducts = useQuery(
    api.products.getMyListings,
    user?._id && !isCompanyCatalogManager && vendorProfile?.status === "approved"
      ? { actorUserId: user._id }
      : "skip"
  );
  const vendorOrders = useQuery(
    api.orders.getSellerOrders,
    user?._id && !isCompanyCatalogManager && vendorProfile?.status === "approved"
      ? { sellerId: user._id }
      : "skip"
  );

  const [form, setForm] = useState<VendorApplicationForm>(emptyVendorForm);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [uploadingField, setUploadingField] = useState<
    "logoUrl" | "bannerUrl" | null
  >(null);

  useEffect(() => {
    if (!vendorProfile) {
      return;
    }

    setForm({
      storeName: vendorProfile.storeName,
      description: vendorProfile.description,
      logoUrl: vendorProfile.logoUrl ?? "",
      bannerUrl: vendorProfile.bannerUrl ?? "",
      contactEmail: vendorProfile.contactEmail,
      contactPhone: vendorProfile.contactPhone ?? "",
      street: vendorProfile.address.street,
      city: vendorProfile.address.city,
      province: vendorProfile.address.province,
      country: vendorProfile.address.country,
      website: vendorProfile.socialLinks?.website ?? "",
      instagram: vendorProfile.socialLinks?.instagram ?? "",
      facebook: vendorProfile.socialLinks?.facebook ?? "",
    });
  }, [vendorProfile]);

  const listings = useMemo(
    () => (isCompanyCatalogManager ? companyProducts ?? [] : vendorProducts ?? []),
    [companyProducts, isCompanyCatalogManager, vendorProducts]
  );
  const orders = useMemo(
    () => (isCompanyCatalogManager ? companyOrders ?? [] : vendorOrders ?? []),
    [companyOrders, isCompanyCatalogManager, vendorOrders]
  );

  const stats = useMemo(
    () => ({
      listings: listings.length,
      active: listings.filter((product) => product.status === "active").length,
      pending: listings.filter((product) => product.status === "pending_review")
        .length,
      actionRequired: listings.filter(
        (product) => product.status === "changes_requested"
      ).length,
      orders: orders.length,
    }),
    [listings, orders]
  );

  const uploadBrandAsset = async (
    event: ChangeEvent<HTMLInputElement>,
    field: "logoUrl" | "bannerUrl"
  ) => {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    try {
      setUploadingField(field);
      const uploadUrl = await generateUploadUrl();
      const response = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          "Content-Type": file.type,
        },
        body: file,
      });

      if (!response.ok) {
        throw new Error("Upload failed");
      }

      const { storageId } = (await response.json()) as {
        storageId: Id<"_storage">;
      };
      const publicUrl = await convex.query(api.storage.getUrl, { storageId });

      if (!publicUrl) {
        throw new Error("Uploaded asset URL is unavailable");
      }

      setForm((current) => ({
        ...current,
        [field]: publicUrl,
      }));
      toast.success(field === "logoUrl" ? "Logo uploaded" : "Banner uploaded");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to upload asset";
      toast.error(message);
    } finally {
      setUploadingField(null);
    }
  };

  const handleApplicationSubmit = async () => {
    if (!user) {
      return;
    }

    if (
      !form.storeName.trim() ||
      !form.description.trim() ||
      !form.contactEmail.trim() ||
      !form.street.trim() ||
      !form.city.trim() ||
      !form.province.trim() ||
      !form.country.trim()
    ) {
      toast.error("Complete the required store details first.");
      return;
    }

    setIsSubmitting(true);

    try {
      await submitApplication({
        ownerUserId: user._id,
        storeName: form.storeName.trim(),
        description: form.description.trim(),
        logoUrl: form.logoUrl.trim() || undefined,
        bannerUrl: form.bannerUrl.trim() || undefined,
        contactEmail: form.contactEmail.trim(),
        contactPhone: form.contactPhone.trim() || undefined,
        address: {
          street: form.street.trim(),
          city: form.city.trim(),
          province: form.province.trim(),
          country: form.country.trim(),
        },
        socialLinks: {
          website: form.website.trim() || undefined,
          instagram: form.instagram.trim() || undefined,
          facebook: form.facebook.trim() || undefined,
        },
      });

      toast.success(
        vendorProfile
          ? "Vendor application resubmitted."
          : "Vendor application submitted."
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to submit application";
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (
    authLoading ||
    (isSignedIn &&
      (vendorProfile === undefined ||
        (isCompanyCatalogManager &&
          (companyProducts === undefined || companyOrders === undefined)) ||
        (vendorProfile?.status === "approved" &&
          !isCompanyCatalogManager &&
          (vendorProducts === undefined || vendorOrders === undefined))))
  ) {
    return (
      <div className="container space-y-6 py-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid gap-4 md:grid-cols-3">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
        <Skeleton className="h-96" />
      </div>
    );
  }

  if (!isSignedIn) {
    return (
      <div className="container flex flex-col items-center justify-center py-16">
        <Store className="h-16 w-16 text-muted-foreground" />
        <h1 className="mt-4 text-2xl font-bold">Sell on Gettitonline</h1>
        <p className="mt-2 text-muted-foreground">
          Sign in to apply as a vendor or manage your listings.
        </p>
        <Button asChild className="mt-6">
          <Link href={ROUTES.SIGN_IN}>Sign In</Link>
        </Button>
      </div>
    );
  }

  if (isReviewerOnly) {
    return (
      <div className="container py-6">
        <Breadcrumb className="mb-6">
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href={ROUTES.HOME}>Home</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>Seller Operations</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>

        <Card>
          <CardHeader>
            <CardTitle>Review Operations</CardTitle>
            <CardDescription>
              Moderators handle vendor and listing review from the admin tools.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 sm:flex-row">
            <Button asChild>
              <Link href={ROUTES.ADMIN_LISTING_REVIEW}>Review Listings</Link>
            </Button>
            <Button variant="outline" asChild>
              <Link href={ROUTES.ADMIN_DASHBOARD}>Open Admin Dashboard</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (hasListingAccess) {
    const title = isCompanyCatalogManager
      ? "Company Catalog"
      : vendorProfile?.storeName || "My Store";
    const subtitle = isCompanyCatalogManager
      ? "Manage official Gettitonline inventory."
      : "Manage your vendor catalog and monitor review status.";

    return (
      <div className="container py-6">
        <Breadcrumb className="mb-6">
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href={ROUTES.HOME}>Home</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{title}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>

        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold">{title}</h1>
            <p className="text-muted-foreground">{subtitle}</p>
          </div>
          <Button asChild>
            <Link href={ROUTES.CREATE_LISTING}>Add Listing</Link>
          </Button>
        </div>

        <div className="mb-6 grid gap-4 md:grid-cols-5">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Listings</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-bold">{stats.listings}</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Active</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-bold">{stats.active}</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Pending Review</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-bold">{stats.pending}</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Action Needed</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-bold">{stats.actionRequired}</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Orders</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-bold">{stats.orders}</CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Listings</CardTitle>
            <CardDescription>
              Drafts stay private. Submitted listings stay hidden until staff
              approval.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ListingTable products={listings} />
          </CardContent>
        </Card>
      </div>
    );
  }

  const vendorStatus = vendorProfile?.status as VendorStatus | undefined;

  return (
    <div className="container py-6">
      <Breadcrumb className="mb-6">
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href={ROUTES.HOME}>Home</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Vendor Application</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="grid gap-6 lg:grid-cols-[1.3fr_0.7fr]">
        <Card>
          <CardHeader>
            <CardTitle>Apply to Become a Vendor</CardTitle>
            <CardDescription>
              Set up your store details, branding, and contact information for
              admin review.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="storeName">Store Name</Label>
                <Input
                  id="storeName"
                  value={form.storeName}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      storeName: event.target.value,
                    }))
                  }
                />
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="description">Store Description</Label>
                <Textarea
                  id="description"
                  rows={5}
                  value={form.description}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      description: event.target.value,
                    }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="contactEmail">Contact Email</Label>
                <Input
                  id="contactEmail"
                  type="email"
                  value={form.contactEmail}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      contactEmail: event.target.value,
                    }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="contactPhone">Contact Phone</Label>
                <Input
                  id="contactPhone"
                  value={form.contactPhone}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      contactPhone: event.target.value,
                    }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="street">Street</Label>
                <Input
                  id="street"
                  value={form.street}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      street: event.target.value,
                    }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="city">City</Label>
                <Input
                  id="city"
                  value={form.city}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      city: event.target.value,
                    }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="province">Province</Label>
                <Input
                  id="province"
                  value={form.province}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      province: event.target.value,
                    }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="country">Country</Label>
                <Input
                  id="country"
                  value={form.country}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      country: event.target.value,
                    }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="website">Website</Label>
                <Input
                  id="website"
                  value={form.website}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      website: event.target.value,
                    }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="instagram">Instagram</Label>
                <Input
                  id="instagram"
                  value={form.instagram}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      instagram: event.target.value,
                    }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="facebook">Facebook</Label>
                <Input
                  id="facebook"
                  value={form.facebook}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      facebook: event.target.value,
                    }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label>Store Logo</Label>
                <Input
                  type="file"
                  accept="image/*"
                  onChange={(event) => void uploadBrandAsset(event, "logoUrl")}
                />
                {uploadingField === "logoUrl" && (
                  <p className="text-sm text-muted-foreground">Uploading logo…</p>
                )}
                {form.logoUrl && (
                  <img
                    src={form.logoUrl}
                    alt="Store logo preview"
                    className="h-20 w-20 rounded-lg border object-cover"
                  />
                )}
              </div>
              <div className="space-y-2">
                <Label>Store Banner</Label>
                <Input
                  type="file"
                  accept="image/*"
                  onChange={(event) => void uploadBrandAsset(event, "bannerUrl")}
                />
                {uploadingField === "bannerUrl" && (
                  <p className="text-sm text-muted-foreground">Uploading banner…</p>
                )}
                {form.bannerUrl && (
                  <img
                    src={form.bannerUrl}
                    alt="Store banner preview"
                    className="h-24 w-full rounded-lg border object-cover"
                  />
                )}
              </div>
            </div>

            <Button onClick={handleApplicationSubmit} disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {vendorProfile ? "Resubmit Vendor Application" : "Submit Vendor Application"}
            </Button>
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Application Status</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {vendorStatus ? (
                <>
                  <Badge variant={vendorStatusCopy[vendorStatus].variant}>
                    {vendorStatusCopy[vendorStatus].label}
                  </Badge>
                  {vendorProfile?.reviewNotes && (
                    <p className="text-sm text-muted-foreground">
                      {vendorProfile.reviewNotes}
                    </p>
                  )}
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  You have not submitted a vendor application yet.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>What Happens Next</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <div className="flex items-start gap-3">
                <Building2 className="mt-0.5 h-4 w-4 text-primary" />
                <p>Admins review your store identity, branding, and contact details.</p>
              </div>
              <div className="flex items-start gap-3">
                <ShieldCheck className="mt-0.5 h-4 w-4 text-primary" />
                <p>Approved vendors can create listings, but every listing still needs staff approval before going live.</p>
              </div>
              <div className="flex items-start gap-3">
                <ClipboardCheck className="mt-0.5 h-4 w-4 text-primary" />
                <p>If changes are requested, update your details here and resubmit.</p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
