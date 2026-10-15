"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../../../../convex/_generated/api";
import { Id } from "../../../../../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useAccountAccess, type AccountUser } from "@/hooks/useAccountAccess";
import { AccountAccessNotice } from "@/components/common/AccountAccessNotice";
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

  return <AdminUsersPageContent key={user._id} user={user} />;
}

function AdminUsersPageContent({ user }: { user: AccountUser }) {
  const [companyDisplayName, setCompanyDisplayName] = useState("Gettitonline");
  const [selectedCompanySellerId, setSelectedCompanySellerId] = useState("");
  const [roleDrafts, setRoleDrafts] = useState<Record<string, UserRole>>({});
  const [savingUserId, setSavingUserId] = useState<string | null>(null);
  const [savingStorefront, setSavingStorefront] = useState(false);

  const usersResult = useQuery(
    api.users.getAllUsers,
    user?._id ? { limit: 100 } : "skip",
  );
  const platformSettings = useQuery(
    api.platform.getPlatformSettingsForAdmin,
    user?._id ? {} : "skip",
  );

  const updateUserRole = useMutation(api.users.updateUserRole);
  const toggleUserBan = useMutation(api.users.toggleUserBan);
  const updatePlatformSettings = useMutation(
    api.platform.updatePlatformSettings,
  );
  const freezeWallet = useMutation(api.wallet.freezeWallet);
  const unfreezeWallet = useMutation(api.wallet.unfreezeWallet);

  const [walletUserId, setWalletUserId] = useState<Id<"users"> | null>(null);
  const [freezeReason, setFreezeReason] = useState("");
  const [freezeDialogOpen, setFreezeDialogOpen] = useState(false);
  const [savingWallet, setSavingWallet] = useState(false);

  // Only the selected user's wallet is read, so the page issues one wallet query at a time.
  const selectedWallet = useQuery(
    api.wallet.getWallet,
    walletUserId ? { userId: walletUserId } : "skip",
  );

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
          `${right.firstName} ${right.lastName}`,
        ),
      ),
    [users],
  );

  useEffect(() => {
    if (!platformSettings) {
      return;
    }

    setCompanyDisplayName(platformSettings.companyDisplayName);
    setSelectedCompanySellerId(platformSettings.companySellerUserId ?? "");
  }, [platformSettings]);

  if (usersResult === undefined || platformSettings === undefined) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-12 w-72" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-96 w-full" />
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

  const handleRoleSave = async (
    targetUserId: string,
    currentRole: UserRole,
  ) => {
    const nextRole = roleDrafts[targetUserId] ?? currentRole;
    if (nextRole === currentRole) {
      return;
    }

    setSavingUserId(targetUserId);

    try {
      await updateUserRole({
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

  const handleSelectWallet = (targetUserId: Id<"users">) => {
    setWalletUserId(targetUserId);
    setFreezeReason("");
    setFreezeDialogOpen(false);
  };

  // The reason is required, as the backend records it on the wallet and in the user's notification.
  const handleFreezeWallet = async (walletId: Id<"wallets">) => {
    const reason = freezeReason.trim();
    if (!reason) {
      return;
    }

    setSavingWallet(true);

    try {
      await freezeWallet({ walletId, reason });
      setFreezeDialogOpen(false);
      setFreezeReason("");
      toast.success("Wallet frozen");
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to freeze wallet";
      toast.error(message);
    } finally {
      setSavingWallet(false);
    }
  };

  const handleUnfreezeWallet = async (walletId: Id<"wallets">) => {
    setSavingWallet(true);

    try {
      await unfreezeWallet({ walletId });
      toast.success("Wallet unfrozen");
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to unfreeze wallet";
      toast.error(message);
    } finally {
      setSavingWallet(false);
    }
  };

  const walletUser =
    sortedUsers.find((listedUser) => listedUser._id === walletUserId) ?? null;

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
                    {listedUser.firstName} {listedUser.lastName} (
                    {listedUser.email})
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
                        <span className="text-sm text-muted-foreground">
                          No
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={savingUserId === listedUser._id}
                          onClick={() =>
                            handleRoleSave(listedUser._id, listedUser.role)
                          }
                        >
                          Save Role
                        </Button>
                        <Button
                          variant={
                            listedUser.isBanned ? "outline" : "destructive"
                          }
                          size="sm"
                          disabled={savingUserId === listedUser._id}
                          onClick={() =>
                            handleBanToggle(listedUser._id, listedUser.isBanned)
                          }
                        >
                          {listedUser.isBanned ? "Unban" : "Ban"}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleSelectWallet(listedUser._id)}
                        >
                          Wallet
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

      {walletUser ? (
        <Card>
          <CardHeader>
            <CardTitle>Wallet Controls</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {walletUser.firstName} {walletUser.lastName} ({walletUser.email})
            </p>
            {selectedWallet === undefined ? (
              <Skeleton className="h-16 w-full" />
            ) : selectedWallet === null ? (
              <p className="text-sm text-muted-foreground">
                No wallet yet for this user.
              </p>
            ) : (
              <div className="flex items-center justify-between rounded-lg border p-4">
                <div className="space-y-1">
                  <Badge
                    variant={
                      selectedWallet.isFrozen ? "destructive" : "secondary"
                    }
                  >
                    {selectedWallet.isFrozen ? "Frozen" : "Active"}
                  </Badge>
                  {selectedWallet.isFrozen && selectedWallet.freezeReason ? (
                    <p className="text-sm text-muted-foreground">
                      Reason: {selectedWallet.freezeReason}
                    </p>
                  ) : null}
                </div>
                {selectedWallet.isFrozen ? (
                  <Button
                    variant="outline"
                    disabled={savingWallet}
                    onClick={() => handleUnfreezeWallet(selectedWallet._id)}
                  >
                    Unfreeze wallet
                  </Button>
                ) : (
                  <Button
                    variant="destructive"
                    disabled={savingWallet}
                    onClick={() => setFreezeDialogOpen(true)}
                  >
                    Freeze wallet
                  </Button>
                )}
                <AlertDialog
                  open={freezeDialogOpen}
                  onOpenChange={setFreezeDialogOpen}
                >
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Freeze this wallet?</AlertDialogTitle>
                      <AlertDialogDescription>
                        The user cannot spend or withdraw until the wallet is
                        unfrozen. They are notified with the reason you enter.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <div className="space-y-2">
                      <Label htmlFor="wallet-freeze-reason">
                        Freeze reason
                      </Label>
                      <Input
                        id="wallet-freeze-reason"
                        value={freezeReason}
                        onChange={(event) =>
                          setFreezeReason(event.target.value)
                        }
                        placeholder="Explain why this wallet is frozen"
                      />
                    </div>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <Button
                        variant="destructive"
                        disabled={savingWallet || !freezeReason.trim()}
                        onClick={() => handleFreezeWallet(selectedWallet._id)}
                      >
                        Confirm freeze
                      </Button>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
