"use client";

import { ChangeEvent, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../../../../convex/_generated/api";
import type { Id } from "../../../../../../../convex/_generated/dataModel";
import { useAccountAccess, type AccountUser } from "@/hooks/useAccountAccess";
import { AccountAccessNotice } from "@/components/common/AccountAccessNotice";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { formatZMW } from "@gettitonline/shared";
import { toast } from "sonner";
import {
  storageUploadMessage,
  useStorageUpload,
} from "@/hooks/useStorageUpload";

type PromoScope = "platform" | "seller" | "category" | "product";
type PromoDiscountType = "percent" | "fixed_amount";
type BannerPlacement =
  | "home_hero"
  | "home_monthly"
  | "home_strip"
  | "category"
  | "pdp";
type CampaignType =
  | "cart_reminder"
  | "low_stock"
  | "price_drop"
  | "product_recommendation";
type CampaignAudience =
  | "all_opted_in"
  | "cart_abandoners"
  | "product_viewers"
  | "category_browsers"
  | "past_buyers";

const nowLocal = () => new Date(Date.now()).toISOString().slice(0, 16);
const nextWeekLocal = () =>
  new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 16);

const initialPromoForm = {
  code: "",
  title: "",
  description: "",
  scope: "platform" as PromoScope,
  categoryId: "",
  discountType: "percent" as PromoDiscountType,
  discountValue: "",
  minimumSubtotal: "",
  maxDiscount: "",
  usageLimit: "",
  perUserLimit: "1",
  startsAt: nowLocal(),
  endsAt: nextWeekLocal(),
};

const initialBannerForm = {
  title: "",
  subtitle: "",
  imageUrl: "",
  targetUrl: "",
  placement: "home_hero" as BannerPlacement,
  categoryId: "",
  startsAt: nowLocal(),
  endsAt: nextWeekLocal(),
};

const initialCampaignForm = {
  name: "",
  type: "product_recommendation" as CampaignType,
  audienceSegment: "all_opted_in" as CampaignAudience,
  title: "",
  message: "",
  aiSuggestion: "",
  maxPerUserPerDay: "3",
  includeMobilePush: true,
  includeWebPush: true,
};

function parseOptionalNumber(value: string) {
  return value.trim() ? Number(value) : undefined;
}

function parseDateTime(value: string) {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function formatDateTime(timestamp: number | undefined) {
  if (!timestamp) return "No end date";
  return new Date(timestamp).toLocaleString();
}

function normalizeImageUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Banner image URL is required");
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const parsed = new URL(withProtocol);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Banner image URL must start with http:// or https://");
  }
  return parsed.toString();
}

function safeImageUrl(value: string) {
  try {
    return normalizeImageUrl(value);
  } catch {
    return value.trim();
  }
}

export default function AdminPromotionsPage() {
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

  if (user?.role !== "admin") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Access Restricted</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Only Super Admins can manage promotions.
        </CardContent>
      </Card>
    );
  }

  return <AdminPromotionsPageContent key={user._id} user={user} />;
}

function AdminPromotionsPageContent({ user }: { user: AccountUser }) {
  const [promoForm, setPromoForm] = useState(initialPromoForm);
  const [bannerForm, setBannerForm] = useState(initialBannerForm);
  const [campaignForm, setCampaignForm] = useState(initialCampaignForm);
  const [isSavingPromo, setIsSavingPromo] = useState(false);
  const [isSavingBanner, setIsSavingBanner] = useState(false);
  const [isUploadingBannerImage, setIsUploadingBannerImage] = useState(false);
  const [isSavingCampaign, setIsSavingCampaign] = useState(false);
  const [sendingCampaignId, setSendingCampaignId] = useState<string | null>(
    null,
  );

  const promoCodes = useQuery(
    api.promotions.listPromoCodesForAdmin,
    user?._id ? { adminId: user._id } : "skip",
  );
  const banners = useQuery(
    api.promotions.listPromotionBannersForAdmin,
    user?._id ? { adminId: user._id } : "skip",
  );
  const campaigns = useQuery(
    api.notifications.listNotificationCampaignsForAdmin,
    user?._id ? { adminId: user._id } : "skip",
  );
  const categories = useQuery(api.categories.getParentCategories);
  const upsertPromoCode = useMutation(api.promotions.upsertPromoCode);
  const upsertPromotionBanner = useMutation(
    api.promotions.upsertPromotionBanner,
  );
  const uploadFile = useStorageUpload();
  const upsertNotificationCampaign = useMutation(
    api.notifications.upsertNotificationCampaign,
  );
  const sendNotificationCampaign = useMutation(
    api.notifications.sendNotificationCampaign,
  );

  if (
    promoCodes === undefined ||
    banners === undefined ||
    campaigns === undefined ||
    categories === undefined
  ) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const savePromoCode = async () => {
    const discountValue = Number(promoForm.discountValue);
    if (
      !promoForm.code.trim() ||
      !promoForm.title.trim() ||
      discountValue <= 0
    ) {
      toast.error("Promo code, title, and discount value are required");
      return;
    }

    setIsSavingPromo(true);
    try {
      await upsertPromoCode({
        adminId: user._id,
        code: promoForm.code,
        title: promoForm.title.trim(),
        description: promoForm.description.trim() || undefined,
        scope: promoForm.scope,
        categoryId:
          promoForm.scope === "category" && promoForm.categoryId
            ? (promoForm.categoryId as Id<"categories">)
            : undefined,
        discountType: promoForm.discountType,
        discountValue,
        minimumSubtotal: parseOptionalNumber(promoForm.minimumSubtotal),
        maxDiscount: parseOptionalNumber(promoForm.maxDiscount),
        usageLimit: parseOptionalNumber(promoForm.usageLimit),
        perUserLimit: parseOptionalNumber(promoForm.perUserLimit),
        startsAt: parseDateTime(promoForm.startsAt),
        endsAt: promoForm.endsAt ? parseDateTime(promoForm.endsAt) : undefined,
        isActive: true,
      });
      setPromoForm(initialPromoForm);
      toast.success("Promo code saved");
    } catch (error: unknown) {
      toast.error(
        error instanceof Error ? error.message : "Failed to save promo code",
      );
    } finally {
      setIsSavingPromo(false);
    }
  };

  const uploadBannerImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setIsUploadingBannerImage(true);
    try {
      // The URL is used only once the banner image is registered to the signed-in owner.
      const outcome = await uploadFile(file);
      if (outcome.status !== "uploaded") {
        toast.error(storageUploadMessage(outcome));
        return;
      }

      setBannerForm((current) => ({ ...current, imageUrl: outcome.url }));
      toast.success("Banner image uploaded");
    } finally {
      setIsUploadingBannerImage(false);
    }
  };

  const saveBanner = async () => {
    if (!bannerForm.title.trim() || !bannerForm.imageUrl.trim()) {
      toast.error("Banner title and image URL are required");
      return;
    }

    setIsSavingBanner(true);
    try {
      const imageUrl = normalizeImageUrl(bannerForm.imageUrl);
      await upsertPromotionBanner({
        adminId: user._id,
        title: bannerForm.title.trim(),
        subtitle: bannerForm.subtitle.trim() || undefined,
        imageUrl,
        targetUrl: bannerForm.targetUrl.trim() || undefined,
        placement: bannerForm.placement,
        categoryId:
          bannerForm.placement === "category" && bannerForm.categoryId
            ? (bannerForm.categoryId as Id<"categories">)
            : undefined,
        startsAt: parseDateTime(bannerForm.startsAt),
        endsAt: bannerForm.endsAt
          ? parseDateTime(bannerForm.endsAt)
          : undefined,
        isActive: true,
        sortOrder: banners.length,
      });
      setBannerForm(initialBannerForm);
      toast.success("Banner saved");
    } catch (error: unknown) {
      toast.error(
        error instanceof Error ? error.message : "Failed to save banner",
      );
    } finally {
      setIsSavingBanner(false);
    }
  };

  const saveCampaign = async () => {
    if (
      !campaignForm.name.trim() ||
      !campaignForm.title.trim() ||
      !campaignForm.message.trim()
    ) {
      toast.error("Campaign name, title, and message are required");
      return;
    }

    setIsSavingCampaign(true);
    try {
      await upsertNotificationCampaign({
        adminId: user._id,
        name: campaignForm.name.trim(),
        type: campaignForm.type,
        status: "draft",
        audienceSegment: campaignForm.audienceSegment,
        title: campaignForm.title.trim(),
        message: campaignForm.message.trim(),
        aiSuggestion: campaignForm.aiSuggestion.trim() || undefined,
        channels: [
          "in_app",
          ...(campaignForm.includeMobilePush ? (["mobile_push"] as const) : []),
          ...(campaignForm.includeWebPush ? (["web_push"] as const) : []),
        ],
        maxPerUserPerDay: Number(campaignForm.maxPerUserPerDay) || 3,
        isAutomatic: false,
      });
      setCampaignForm(initialCampaignForm);
      toast.success("Notification campaign saved");
    } catch (error: unknown) {
      toast.error(
        error instanceof Error ? error.message : "Failed to save campaign",
      );
    } finally {
      setIsSavingCampaign(false);
    }
  };

  const sendCampaign = async (campaignId: Id<"notificationCampaigns">) => {
    setSendingCampaignId(campaignId);
    try {
      const result = await sendNotificationCampaign({
        adminId: user._id,
        campaignId,
      });
      toast.success(
        `Campaign sent: ${result.sent} in-app, ${result.queued} queued, ${result.skipped} skipped`,
      );
    } catch (error: unknown) {
      toast.error(
        error instanceof Error ? error.message : "Failed to send campaign",
      );
    } finally {
      setSendingCampaignId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Promotions</h1>
        <p className="text-muted-foreground">
          Manage promo codes and merchandising banners.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Create Promo Code</CardTitle>
            <CardDescription>
              Codes are validated during checkout and stored on orders.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="promoCode">Code</Label>
                <Input
                  id="promoCode"
                  value={promoForm.code}
                  onChange={(event) =>
                    setPromoForm({ ...promoForm, code: event.target.value })
                  }
                  placeholder="WELCOME10"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="promoTitle">Title</Label>
                <Input
                  id="promoTitle"
                  value={promoForm.title}
                  onChange={(event) =>
                    setPromoForm({ ...promoForm, title: event.target.value })
                  }
                  placeholder="Welcome offer"
                />
              </div>
            </div>

            <Input
              value={promoForm.description}
              onChange={(event) =>
                setPromoForm({ ...promoForm, description: event.target.value })
              }
              placeholder="Short internal description"
            />

            <div className="grid gap-4 sm:grid-cols-3">
              <Select
                value={promoForm.scope}
                onValueChange={(scope) =>
                  setPromoForm({ ...promoForm, scope: scope as PromoScope })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="platform">Platform</SelectItem>
                  <SelectItem value="category">Category</SelectItem>
                  <SelectItem value="seller">Seller</SelectItem>
                  <SelectItem value="product">Product</SelectItem>
                </SelectContent>
              </Select>

              <Select
                value={promoForm.discountType}
                onValueChange={(discountType) =>
                  setPromoForm({
                    ...promoForm,
                    discountType: discountType as PromoDiscountType,
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="percent">Percent</SelectItem>
                  <SelectItem value="fixed_amount">Fixed Amount</SelectItem>
                </SelectContent>
              </Select>

              <Input
                type="number"
                min="0"
                value={promoForm.discountValue}
                onChange={(event) =>
                  setPromoForm({
                    ...promoForm,
                    discountValue: event.target.value,
                  })
                }
                placeholder="Discount"
              />
            </div>

            {promoForm.scope === "category" && (
              <Select
                value={promoForm.categoryId}
                onValueChange={(categoryId) =>
                  setPromoForm({ ...promoForm, categoryId })
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select category" />
                </SelectTrigger>
                <SelectContent>
                  {categories.map((category) => (
                    <SelectItem key={category._id} value={category._id}>
                      {category.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            <div className="grid gap-4 sm:grid-cols-4">
              <Input
                type="number"
                min="0"
                value={promoForm.minimumSubtotal}
                onChange={(event) =>
                  setPromoForm({
                    ...promoForm,
                    minimumSubtotal: event.target.value,
                  })
                }
                placeholder="Min subtotal"
              />
              <Input
                type="number"
                min="0"
                value={promoForm.maxDiscount}
                onChange={(event) =>
                  setPromoForm({
                    ...promoForm,
                    maxDiscount: event.target.value,
                  })
                }
                placeholder="Max discount"
              />
              <Input
                type="number"
                min="0"
                value={promoForm.usageLimit}
                onChange={(event) =>
                  setPromoForm({ ...promoForm, usageLimit: event.target.value })
                }
                placeholder="Usage limit"
              />
              <Input
                type="number"
                min="0"
                value={promoForm.perUserLimit}
                onChange={(event) =>
                  setPromoForm({
                    ...promoForm,
                    perUserLimit: event.target.value,
                  })
                }
                placeholder="Per user"
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Starts</Label>
                <Input
                  type="datetime-local"
                  value={promoForm.startsAt}
                  onChange={(event) =>
                    setPromoForm({ ...promoForm, startsAt: event.target.value })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label>Ends</Label>
                <Input
                  type="datetime-local"
                  value={promoForm.endsAt}
                  onChange={(event) =>
                    setPromoForm({ ...promoForm, endsAt: event.target.value })
                  }
                />
              </div>
            </div>

            <Button onClick={savePromoCode} disabled={isSavingPromo}>
              {isSavingPromo ? "Saving..." : "Save Promo Code"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Create Banner</CardTitle>
            <CardDescription>
              Banners power homepage, category, and PDP merchandising slots.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                value={bannerForm.title}
                onChange={(event) =>
                  setBannerForm({ ...bannerForm, title: event.target.value })
                }
                placeholder="Banner title"
              />
              <Select
                value={bannerForm.placement}
                onValueChange={(placement) =>
                  setBannerForm({
                    ...bannerForm,
                    placement: placement as BannerPlacement,
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="home_hero">Home Hero</SelectItem>
                  <SelectItem value="home_monthly">Monthly Carousel</SelectItem>
                  <SelectItem value="home_strip">Home Strip</SelectItem>
                  <SelectItem value="category">Category</SelectItem>
                  <SelectItem value="pdp">PDP</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Input
              value={bannerForm.subtitle}
              onChange={(event) =>
                setBannerForm({ ...bannerForm, subtitle: event.target.value })
              }
              placeholder="Subtitle"
            />
            <Input
              value={bannerForm.imageUrl}
              onChange={(event) =>
                setBannerForm({ ...bannerForm, imageUrl: event.target.value })
              }
              placeholder="Image URL or upload an image below"
            />
            <div className="space-y-2">
              <Label>Upload Banner Image</Label>
              <Input
                type="file"
                accept="image/*"
                onChange={(event) => void uploadBannerImage(event)}
                disabled={isUploadingBannerImage}
              />
              {isUploadingBannerImage && (
                <p className="text-sm text-muted-foreground">
                  Uploading banner image...
                </p>
              )}
              {bannerForm.imageUrl && (
                <div className="overflow-hidden rounded-lg border bg-muted">
                  <img
                    src={safeImageUrl(bannerForm.imageUrl)}
                    alt="Banner preview"
                    className="h-32 w-full object-cover"
                  />
                </div>
              )}
            </div>
            <Input
              value={bannerForm.targetUrl}
              onChange={(event) =>
                setBannerForm({ ...bannerForm, targetUrl: event.target.value })
              }
              placeholder="Target URL"
            />

            {bannerForm.placement === "category" && (
              <Select
                value={bannerForm.categoryId}
                onValueChange={(categoryId) =>
                  setBannerForm({ ...bannerForm, categoryId })
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select category" />
                </SelectTrigger>
                <SelectContent>
                  {categories.map((category) => (
                    <SelectItem key={category._id} value={category._id}>
                      {category.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                type="datetime-local"
                value={bannerForm.startsAt}
                onChange={(event) =>
                  setBannerForm({ ...bannerForm, startsAt: event.target.value })
                }
              />
              <Input
                type="datetime-local"
                value={bannerForm.endsAt}
                onChange={(event) =>
                  setBannerForm({ ...bannerForm, endsAt: event.target.value })
                }
              />
            </div>

            <Button onClick={saveBanner} disabled={isSavingBanner}>
              {isSavingBanner ? "Saving..." : "Save Banner"}
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Notification Campaigns</CardTitle>
          <CardDescription>
            Create segmented campaigns for cart reminders, recommendations,
            price drops, and scarcity alerts.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-4">
              <Input
                value={campaignForm.name}
                onChange={(event) =>
                  setCampaignForm({ ...campaignForm, name: event.target.value })
                }
                placeholder="Internal campaign name"
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <Select
                  value={campaignForm.type}
                  onValueChange={(type) =>
                    setCampaignForm({
                      ...campaignForm,
                      type: type as CampaignType,
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cart_reminder">Cart Reminder</SelectItem>
                    <SelectItem value="low_stock">Scarcity Alert</SelectItem>
                    <SelectItem value="price_drop">Price Drop</SelectItem>
                    <SelectItem value="product_recommendation">
                      Recommendation
                    </SelectItem>
                  </SelectContent>
                </Select>
                <Select
                  value={campaignForm.audienceSegment}
                  onValueChange={(audienceSegment) =>
                    setCampaignForm({
                      ...campaignForm,
                      audienceSegment: audienceSegment as CampaignAudience,
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all_opted_in">All opted-in</SelectItem>
                    <SelectItem value="cart_abandoners">
                      Cart abandoners
                    </SelectItem>
                    <SelectItem value="product_viewers">
                      Product viewers
                    </SelectItem>
                    <SelectItem value="category_browsers">
                      Category browsers
                    </SelectItem>
                    <SelectItem value="past_buyers">Past buyers</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Input
                value={campaignForm.title}
                onChange={(event) =>
                  setCampaignForm({
                    ...campaignForm,
                    title: event.target.value,
                  })
                }
                placeholder="Notification title"
              />
              <Input
                value={campaignForm.message}
                onChange={(event) =>
                  setCampaignForm({
                    ...campaignForm,
                    message: event.target.value,
                  })
                }
                placeholder="Notification message"
              />
              <Input
                value={campaignForm.aiSuggestion}
                onChange={(event) =>
                  setCampaignForm({
                    ...campaignForm,
                    aiSuggestion: event.target.value,
                  })
                }
                placeholder="AI suggestion/source copy"
              />
              <div className="grid gap-4 sm:grid-cols-3">
                <Input
                  type="number"
                  min="1"
                  value={campaignForm.maxPerUserPerDay}
                  onChange={(event) =>
                    setCampaignForm({
                      ...campaignForm,
                      maxPerUserPerDay: event.target.value,
                    })
                  }
                  placeholder="Daily cap"
                />
                <Button
                  type="button"
                  variant={
                    campaignForm.includeMobilePush ? "default" : "outline"
                  }
                  onClick={() =>
                    setCampaignForm({
                      ...campaignForm,
                      includeMobilePush: !campaignForm.includeMobilePush,
                    })
                  }
                >
                  Mobile Push
                </Button>
                <Button
                  type="button"
                  variant={campaignForm.includeWebPush ? "default" : "outline"}
                  onClick={() =>
                    setCampaignForm({
                      ...campaignForm,
                      includeWebPush: !campaignForm.includeWebPush,
                    })
                  }
                >
                  Web Push
                </Button>
              </div>
              <Button onClick={saveCampaign} disabled={isSavingCampaign}>
                {isSavingCampaign ? "Saving..." : "Save Campaign"}
              </Button>
            </div>

            <div className="space-y-2">
              {campaigns.map((campaign) => (
                <div key={campaign._id} className="rounded-lg border p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-medium">{campaign.name}</p>
                      <p className="text-sm text-muted-foreground">
                        {campaign.type} • {campaign.audienceSegment} • cap{" "}
                        {campaign.maxPerUserPerDay}/day
                      </p>
                    </div>
                    <Badge
                      variant={
                        campaign.status === "active" ? "default" : "secondary"
                      }
                    >
                      {campaign.status}
                    </Badge>
                  </div>
                  <p className="mt-2 text-sm">{campaign.title}</p>
                  <p className="text-sm text-muted-foreground">
                    {campaign.message}
                  </p>
                  <div className="mt-3 flex items-center justify-between">
                    <p className="text-xs text-muted-foreground">
                      Channels: {campaign.channels.join(", ")}
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => sendCampaign(campaign._id)}
                      disabled={sendingCampaignId === campaign._id}
                    >
                      {sendingCampaignId === campaign._id
                        ? "Sending..."
                        : "Send"}
                    </Button>
                  </div>
                </div>
              ))}
              {campaigns.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No notification campaigns yet.
                </p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Configured Promotions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div>
            <h2 className="mb-3 font-medium">Promo Codes</h2>
            <div className="space-y-2">
              {promoCodes.map((promoCode) => (
                <div
                  key={promoCode._id}
                  className="flex items-center justify-between rounded-lg border p-3"
                >
                  <div>
                    <p className="font-medium">{promoCode.code}</p>
                    <p className="text-sm text-muted-foreground">
                      {promoCode.title} •{" "}
                      {promoCode.discountType === "percent"
                        ? `${promoCode.discountValue}%`
                        : formatZMW(promoCode.discountValue)}
                      {" • "}
                      Ends {formatDateTime(promoCode.endsAt)}
                    </p>
                  </div>
                  <Badge variant={promoCode.isActive ? "default" : "secondary"}>
                    {promoCode.scope}
                  </Badge>
                </div>
              ))}
              {promoCodes.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No promo codes yet.
                </p>
              )}
            </div>
          </div>

          <Separator />

          <div>
            <h2 className="mb-3 font-medium">Banners</h2>
            <div className="space-y-2">
              {banners.map((banner) => (
                <div
                  key={banner._id}
                  className="flex items-center justify-between rounded-lg border p-3"
                >
                  <div>
                    <p className="font-medium">{banner.title}</p>
                    <p className="text-sm text-muted-foreground">
                      {banner.placement} • Ends {formatDateTime(banner.endsAt)}
                    </p>
                  </div>
                  <Badge variant={banner.isActive ? "default" : "secondary"}>
                    {banner.isActive ? "Active" : "Inactive"}
                  </Badge>
                </div>
              ))}
              {banners.length === 0 && (
                <p className="text-sm text-muted-foreground">No banners yet.</p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
