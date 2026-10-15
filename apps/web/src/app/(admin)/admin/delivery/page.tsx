"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../../../../convex/_generated/api";
import type { Id } from "../../../../../../../convex/_generated/dataModel";
import { useAuth } from "@/hooks/useAuth";
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
import { ZAMBIAN_PROVINCES } from "@/lib/constants";
import { formatZMW } from "@gettitonline/shared";
import { toast } from "sonner";

type MethodType = "standard" | "express" | "same_day" | "pickup";

const initialZoneForm = {
  name: "",
  slug: "",
  province: "",
  city: "",
};

const initialMethodForm = {
  zoneId: "",
  name: "",
  code: "",
  type: "standard" as MethodType,
  baseFee: "",
  perKgFee: "",
  freeAboveSubtotal: "",
  minDays: "2",
  maxDays: "5",
  courierName: "",
};

export default function AdminDeliveryPage() {
  const { user, isLoading } = useAuth();
  const [zoneForm, setZoneForm] = useState(initialZoneForm);
  const [methodForm, setMethodForm] = useState(initialMethodForm);
  const [isSavingZone, setIsSavingZone] = useState(false);
  const [isSavingMethod, setIsSavingMethod] = useState(false);

  // The backend refuses includeInactive for non-admins, so the queries wait until the user is known to be an admin.
  const isAdmin = !isLoading && user?.role === "admin";
  const inactiveArgs = isAdmin ? { includeInactive: true } : "skip";
  const zones = useQuery(api.delivery.listDeliveryZones, inactiveArgs);
  const methods = useQuery(api.delivery.listDeliveryMethods, inactiveArgs);
  const upsertDeliveryZone = useMutation(api.delivery.upsertDeliveryZone);
  const upsertDeliveryMethod = useMutation(api.delivery.upsertDeliveryMethod);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-64 w-full" />
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
          Only Super Admins can manage delivery settings.
        </CardContent>
      </Card>
    );
  }

  if (zones === undefined || methods === undefined) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const saveZone = async () => {
    if (!zoneForm.name.trim() || !zoneForm.slug.trim()) {
      toast.error("Zone name and slug are required");
      return;
    }

    setIsSavingZone(true);
    try {
      await upsertDeliveryZone({
        adminId: user._id,
        name: zoneForm.name.trim(),
        slug: zoneForm.slug.trim().toLowerCase(),
        province: zoneForm.province || undefined,
        city: zoneForm.city.trim() || undefined,
        isActive: true,
        sortOrder: zones.length,
      });
      setZoneForm(initialZoneForm);
      toast.success("Delivery zone saved");
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Failed to save zone");
    } finally {
      setIsSavingZone(false);
    }
  };

  const saveMethod = async () => {
    if (!methodForm.name.trim() || !methodForm.code.trim()) {
      toast.error("Method name and code are required");
      return;
    }

    const baseFee = Number(methodForm.baseFee);
    const minDays = Number(methodForm.minDays);
    const maxDays = Number(methodForm.maxDays);
    if (!Number.isFinite(baseFee) || baseFee < 0 || minDays < 0 || maxDays < minDays) {
      toast.error("Enter valid delivery fees and ETA");
      return;
    }

    setIsSavingMethod(true);
    try {
      await upsertDeliveryMethod({
        adminId: user._id,
        zoneId: methodForm.zoneId
          ? (methodForm.zoneId as Id<"deliveryZones">)
          : undefined,
        name: methodForm.name.trim(),
        code: methodForm.code.trim().toUpperCase(),
        type: methodForm.type,
        baseFee,
        perKgFee: methodForm.perKgFee ? Number(methodForm.perKgFee) : undefined,
        freeAboveSubtotal: methodForm.freeAboveSubtotal
          ? Number(methodForm.freeAboveSubtotal)
          : undefined,
        minDays,
        maxDays,
        courierName: methodForm.courierName.trim() || undefined,
        isActive: true,
      });
      setMethodForm(initialMethodForm);
      toast.success("Delivery method saved");
    } catch (error: unknown) {
      toast.error(
        error instanceof Error ? error.message : "Failed to save delivery method"
      );
    } finally {
      setIsSavingMethod(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Delivery Settings</h1>
        <p className="text-muted-foreground">
          Configure zones and delivery methods used at checkout.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Create Zone</CardTitle>
            <CardDescription>
              Zones can be province-wide or narrowed to a city.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="zoneName">Name</Label>
                <Input
                  id="zoneName"
                  value={zoneForm.name}
                  onChange={(event) =>
                    setZoneForm({ ...zoneForm, name: event.target.value })
                  }
                  placeholder="Lusaka Metro"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="zoneSlug">Slug</Label>
                <Input
                  id="zoneSlug"
                  value={zoneForm.slug}
                  onChange={(event) =>
                    setZoneForm({ ...zoneForm, slug: event.target.value })
                  }
                  placeholder="lusaka-metro"
                />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Province</Label>
                <Select
                  value={zoneForm.province}
                  onValueChange={(province) =>
                    setZoneForm({ ...zoneForm, province })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Any province" />
                  </SelectTrigger>
                  <SelectContent>
                    {ZAMBIAN_PROVINCES.map((province) => (
                      <SelectItem key={province} value={province}>
                        {province}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="zoneCity">City</Label>
                <Input
                  id="zoneCity"
                  value={zoneForm.city}
                  onChange={(event) =>
                    setZoneForm({ ...zoneForm, city: event.target.value })
                  }
                  placeholder="Optional"
                />
              </div>
            </div>
            <Button onClick={saveZone} disabled={isSavingZone}>
              {isSavingZone ? "Saving..." : "Save Zone"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Create Method</CardTitle>
            <CardDescription>
              Methods define fee rules and ETA for matching zones.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Zone</Label>
                <Select
                  value={methodForm.zoneId}
                  onValueChange={(zoneId) =>
                    setMethodForm({ ...methodForm, zoneId })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="All zones" />
                  </SelectTrigger>
                  <SelectContent>
                    {zones.map((zone) => (
                      <SelectItem key={zone._id} value={zone._id}>
                        {zone.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Type</Label>
                <Select
                  value={methodForm.type}
                  onValueChange={(type) =>
                    setMethodForm({ ...methodForm, type: type as MethodType })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="standard">Standard</SelectItem>
                    <SelectItem value="express">Express</SelectItem>
                    <SelectItem value="same_day">Same Day</SelectItem>
                    <SelectItem value="pickup">Pickup</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                value={methodForm.name}
                onChange={(event) =>
                  setMethodForm({ ...methodForm, name: event.target.value })
                }
                placeholder="Standard Delivery"
              />
              <Input
                value={methodForm.code}
                onChange={(event) =>
                  setMethodForm({ ...methodForm, code: event.target.value })
                }
                placeholder="STD-LSK"
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <Input
                type="number"
                min="0"
                value={methodForm.baseFee}
                onChange={(event) =>
                  setMethodForm({ ...methodForm, baseFee: event.target.value })
                }
                placeholder="Base fee"
              />
              <Input
                type="number"
                min="0"
                value={methodForm.perKgFee}
                onChange={(event) =>
                  setMethodForm({ ...methodForm, perKgFee: event.target.value })
                }
                placeholder="Per kg fee"
              />
              <Input
                type="number"
                min="0"
                value={methodForm.freeAboveSubtotal}
                onChange={(event) =>
                  setMethodForm({
                    ...methodForm,
                    freeAboveSubtotal: event.target.value,
                  })
                }
                placeholder="Free above"
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <Input
                type="number"
                min="0"
                value={methodForm.minDays}
                onChange={(event) =>
                  setMethodForm({ ...methodForm, minDays: event.target.value })
                }
                placeholder="Min days"
              />
              <Input
                type="number"
                min="0"
                value={methodForm.maxDays}
                onChange={(event) =>
                  setMethodForm({ ...methodForm, maxDays: event.target.value })
                }
                placeholder="Max days"
              />
              <Input
                value={methodForm.courierName}
                onChange={(event) =>
                  setMethodForm({
                    ...methodForm,
                    courierName: event.target.value,
                  })
                }
                placeholder="Courier"
              />
            </div>
            <Button onClick={saveMethod} disabled={isSavingMethod}>
              {isSavingMethod ? "Saving..." : "Save Method"}
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Configured Delivery</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div>
            <h2 className="mb-3 font-medium">Zones</h2>
            <div className="space-y-2">
              {zones.map((zone) => (
                <div
                  key={zone._id}
                  className="flex items-center justify-between rounded-lg border p-3"
                >
                  <div>
                    <p className="font-medium">{zone.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {[zone.city, zone.province].filter(Boolean).join(", ") ||
                        "All locations"}
                    </p>
                  </div>
                  <Badge variant={zone.isActive ? "default" : "secondary"}>
                    {zone.isActive ? "Active" : "Inactive"}
                  </Badge>
                </div>
              ))}
              {zones.length === 0 && (
                <p className="text-sm text-muted-foreground">No zones yet.</p>
              )}
            </div>
          </div>

          <Separator />

          <div>
            <h2 className="mb-3 font-medium">Methods</h2>
            <div className="space-y-2">
              {methods.map((method) => (
                <div
                  key={method._id}
                  className="flex items-center justify-between rounded-lg border p-3"
                >
                  <div>
                    <p className="font-medium">{method.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {method.code} • {method.minDays}-{method.maxDays} days •{" "}
                      {formatZMW(method.baseFee)}
                    </p>
                  </div>
                  <Badge variant={method.isActive ? "default" : "secondary"}>
                    {method.type}
                  </Badge>
                </div>
              ))}
              {methods.length === 0 && (
                <p className="text-sm text-muted-foreground">No methods yet.</p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
