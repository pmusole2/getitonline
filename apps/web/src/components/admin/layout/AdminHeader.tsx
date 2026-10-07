"use client";

import Link from "next/link";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Bell,
  Menu,
  Settings,
  LogOut,
  User,
  Store,
  Moon,
  Sun,
} from "lucide-react";
import { ROUTES } from "@/lib/constants";
import { getRoleLabel } from "@/lib/roles";
import { useTheme } from "next-themes";
import { useQuery } from "convex/react";
import { api } from "../../../../../../convex/_generated/api";

interface AdminHeaderProps {
  onMenuClick?: () => void;
}

export function AdminHeader({ onMenuClick }: AdminHeaderProps) {
  const { user, clerkUser, signOut } = useAuth();
  const { theme, setTheme } = useTheme();

  // Get unread notifications count
  const unreadCount = useQuery(
    api.notifications.getUnreadCount,
    user?._id ? { userId: user._id } : "skip"
  );

  // Get open disputes count for moderators/admins
  const openDisputes = useQuery(
    api.disputes.getOpenDisputes,
    user?._id ? { moderatorId: user._id } : "skip"
  );
  const disputeCount = openDisputes?.length ?? 0;

  return (
    <header className="flex h-16 items-center justify-between border-b bg-background px-4 lg:px-6">
      {/* Left Side */}
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="icon"
          className="lg:hidden"
          onClick={onMenuClick}
        >
          <Menu className="h-5 w-5" />
        </Button>
        <div>
          <h1 className="text-lg font-semibold">Admin Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Manage your marketplace
          </p>
        </div>
      </div>

      {/* Right Side */}
      <div className="flex items-center gap-2">
        {/* Open Disputes Badge */}
        {disputeCount > 0 && (
          <Button variant="outline" size="sm" asChild>
            <Link href={ROUTES.ADMIN_DISPUTES}>
              <Badge variant="destructive" className="mr-2">
                {disputeCount}
              </Badge>
              Open Disputes
            </Link>
          </Button>
        )}

        {/* Theme Toggle */}
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          <Sun className="h-5 w-5 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
          <Moon className="absolute h-5 w-5 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
          <span className="sr-only">Toggle theme</span>
        </Button>

        {/* Notifications */}
        <Button variant="ghost" size="icon" asChild className="relative">
          <Link href={ROUTES.NOTIFICATIONS}>
            <Bell className="h-5 w-5" />
            {unreadCount && unreadCount > 0 && (
              <Badge
                variant="destructive"
                className="absolute -right-1 -top-1 h-5 w-5 rounded-full p-0 text-xs"
              >
                {unreadCount > 99 ? "99+" : unreadCount}
              </Badge>
            )}
          </Link>
        </Button>

        {/* User Menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="relative h-8 w-8 rounded-full">
              <Avatar className="h-8 w-8">
                <AvatarImage
                  src={clerkUser?.imageUrl}
                  alt={user?.firstName || "Admin"}
                />
                <AvatarFallback>
                  {user?.firstName?.[0]}
                  {user?.lastName?.[0]}
                </AvatarFallback>
              </Avatar>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-56" align="end" forceMount>
            <DropdownMenuLabel className="font-normal">
              <div className="flex flex-col space-y-1">
                <p className="text-sm font-medium leading-none">
                  {user?.firstName} {user?.lastName}
                </p>
                <p className="text-xs leading-none text-muted-foreground">
                  {getRoleLabel(user?.role)}
                </p>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href={ROUTES.HOME}>
                <Store className="mr-2 h-4 w-4" />
                Marketplace
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={ROUTES.PROFILE}>
                <User className="mr-2 h-4 w-4" />
                Profile
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={ROUTES.ADMIN_SETTINGS}>
                <Settings className="mr-2 h-4 w-4" />
                Settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => signOut()}>
              <LogOut className="mr-2 h-4 w-4" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
