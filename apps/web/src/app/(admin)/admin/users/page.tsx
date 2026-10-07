"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../../../../convex/_generated/api";
import { Id } from "../../../../../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";
import { UserRole } from "@/types";
import { getRoleLabel } from "@/lib/roles";

const ROLE_OPTIONS: UserRole[] = [
  "user",
  "catalog_manager",
  "moderator",
  "admin",
];

export default function AdminUsersPage() {
  const { user, isLoading: authLoading } = useAuth();
  const [companyDisplayName, setCompanyDisplayName] = useState("Gettitonline");
  const [selectedCompanySellerId, setSelectedCompanySellerId] = useState("");
  const [roleDrafts, setRoleDrafts] = useState<Record<string, UserRole>>({});
  const [savingUserId, setSavingUserId] = useState<string | null>(null);
  const [savingStorefront, setSavingStorefront] = useState(false);

  const usersResult = useQuery(
    api.users.getAllUsers,
    user?._id ? { adminId: user._id, limit: 100 } : "skip"
  );
  const platformSettings = useQuery(
    api.platform.getPlatformSettingsForAdmin,
    user?._id ? { adminId: user._id } : "skip"
  );

  const updateUserRole = useMutation(api.users.updateUserRole);
  const toggleUserBan = useMutation(api.users.toggleUserBan);
  const updatePlatformSettings = useMutation(api.platform.updatePlatformSettings);

  const users = usersResult?.items ?? [];
  const storefrontSettings = platformSettings ?? {
    companyDisplayName: "Gettitonline",
    companySellerUserId: null,
    companySeller: null,
    isConfigured: false,
  };
  const sortedUsers = useMemo(
    () =>
      [...users].sort((left, right) =>
        `${left.firstName} ${left.lastName}`.localeCompare(
          `${right.firstName} ${right.lastName}`
        )
      ),
    [users]
  );

  useEffect(() => {
    if (!platformSettings) {
      return;
    }

    setCompanyDisplayName(platformSettings.companyDisplayName);
    setSelectedCompanySellerId(platformSettings.companySellerUserId ?? "");
  }, [platformSettings]);

  if (authLoading || (user && (usersResult === undefined || platformSettings === undefined))) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-12 w-72" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (user?.role !== "admin") {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>Access Restricted</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Only Super Admins can manage users and the company seller account.
          </CardContent>
        </Card>
      </div>
    );
  }

  const handleSaveStorefront = async () => {
    if (!selectedCompanySellerId) {
      toast.error("Select a company seller account first");
      return;
    }

    setSavingStorefront(true);

    try {
      await updatePlatformSettings({
        adminId: user._id,
        companySellerUserId: selectedCompanySellerId as Id<"users">,
        companyDisplayName: companyDisplayName.trim() || "Gettitonline",
      });

      toast.success("Storefront updated.");
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to update storefront";
      toast.error(message);
    } finally {
      setSavingStorefront(false);
    }
  };

  const handleRoleSave = async (targetUserId: string, currentRole: UserRole) => {
    const nextRole = roleDrafts[targetUserId] ?? currentRole;
    if (nextRole === currentRole) {
      return;
    }

    setSavingUserId(targetUserId);

    try {
      await updateUserRole({
        adminId: user._id,
        targetUserId: targetUserId as Id<"users">,
        newRole: nextRole,
      });
      toast.success("User role updated");
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to update role";
      toast.error(message);
    } finally {
      setSavingUserId(null);
    }
  };

  const handleBanToggle = async (targetUserId: string, isBanned: boolean) => {
    setSavingUserId(targetUserId);

    try {
      await toggleUserBan({
        adminId: user._id,
        targetUserId: targetUserId as Id<"users">,
        isBanned: !isBanned,
      });
      toast.success(isBanned ? "User unbanned" : "User banned");
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to update ban status";
      toast.error(message);
    } finally {
      setSavingUserId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Users</h1>
        <p className="text-muted-foreground">
          Manage roles, bans, and the dedicated company seller account.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Storefront Settings</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="company-display-name">Store Display Name</Label>
            <Input
              id="company-display-name"
              value={companyDisplayName}
              onChange={(event) => setCompanyDisplayName(event.target.value)}
              placeholder="Gettitonline"
            />
          </div>

          <div className="space-y-2">
            <Label>Company Seller Account</Label>
            <Select
              value={selectedCompanySellerId || undefined}
              onValueChange={setSelectedCompanySellerId}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select an internal user" />
              </SelectTrigger>
              <SelectContent>
                {sortedUsers.map((listedUser) => (
                  <SelectItem key={listedUser._id} value={listedUser._id}>
                    {listedUser.firstName} {listedUser.lastName} ({listedUser.email})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="md:col-span-2 flex items-center justify-between rounded-lg border p-4">
            <div>
              <p className="font-medium">
                Current Storefront: {storefrontSettings.companyDisplayName}
              </p>
              <p className="text-sm text-muted-foreground">
                {storefrontSettings.companySeller
                  ? `${storefrontSettings.companySeller.firstName} ${storefrontSettings.companySeller.lastName} (${storefrontSettings.companySeller.email})`
                  : "No company seller configured yet"}
              </p>
            </div>
            <Button onClick={handleSaveStorefront} disabled={savingStorefront}>
              {savingStorefront ? "Saving..." : "Save Storefront"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>User Management</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Storefront</TableHead>
                <TableHead className="w-[280px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedUsers.map((listedUser) => {
                const draftRole = roleDrafts[listedUser._id] ?? listedUser.role;
                const isCurrentCompanySeller =
                  listedUser._id === storefrontSettings.companySellerUserId;

                return (
                  <TableRow key={listedUser._id}>
                    <TableCell>
                      <div className="space-y-1">
                        <p className="font-medium">
                          {listedUser.firstName} {listedUser.lastName}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {listedUser.email}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Select
                        value={draftRole}
                        onValueChange={(value) =>
                          setRoleDrafts((current) => ({
                            ...current,
                            [listedUser._id]: value as UserRole,
                          }))
                        }
                      >
                        <SelectTrigger className="w-[180px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ROLE_OPTIONS.map((role) => (
                            <SelectItem key={role} value={role}>
                              {getRoleLabel(role)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      {listedUser.isBanned ? (
                        <Badge variant="destructive">Banned</Badge>
                      ) : (
                        <Badge variant="secondary">Active</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {isCurrentCompanySeller ? (
                        <Badge>Company Seller</Badge>
                      ) : (
                        <span className="text-sm text-muted-foreground">No</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={savingUserId === listedUser._id}
                          onClick={() => handleRoleSave(listedUser._id, listedUser.role)}
                        >
                          Save Role
                        </Button>
                        <Button
                          variant={listedUser.isBanned ? "outline" : "destructive"}
                          size="sm"
                          disabled={savingUserId === listedUser._id}
                          onClick={() => handleBanToggle(listedUser._id, listedUser.isBanned)}
                        >
                          {listedUser.isBanned ? "Unban" : "Ban"}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
