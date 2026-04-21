"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  Search,
  ShoppingCart,
  Bell,
  Menu,
  Plus,
  Package,
  Heart,
  MessageSquare,
  Wallet,
  Settings,
  LogOut,
  User,
  LayoutDashboard,
} from "lucide-react";
import { ROUTES } from "@/lib/constants";
import { useQuery } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { cn } from "@/lib/utils";
import { useGuestCart } from "@/providers/GuestCartProvider";
import {
  canAccessSellerSurface,
  canManageCatalog,
  canManageListings,
} from "@/lib/roles";

export function Header() {
  const pathname = usePathname();
  const { isSignedIn, user, clerkUser, signOut } = useAuth();
  const { summary: guestCartSummary } = useGuestCart();

  // Get cart count
  const signedInCartCount = useQuery(
    api.cart.getCartCount,
    user?._id ? { userId: user._id } : "skip"
  );
  const cartCount = isSignedIn
    ? signedInCartCount ?? 0
    : guestCartSummary.itemCount;

  // Get unread notifications count
  const unreadCount = useQuery(
    api.notifications.getUnreadCount,
    user?._id ? { userId: user._id } : "skip"
  );
  const vendorProfile = useQuery(
    api.vendors.getMyVendorProfile,
    user?._id ? { ownerUserId: user._id } : "skip"
  );

  const canAccessAdminDashboard =
    user?.role === "admin" || user?.role === "moderator";
  const hasCatalogAccess = canManageCatalog(user?.role);
  const hasListingAccess = canManageListings(
    user?.role,
    vendorProfile?.status ?? null
  );
  const canAccessSell = canAccessSellerSurface(user?.role);
  const navigation = [
    { name: "Home", href: ROUTES.HOME },
    { name: "Browse", href: ROUTES.BROWSE },
    ...(isSignedIn && canAccessSell ? [{ name: "Sell", href: ROUTES.SELL }] : []),
  ];

  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-16 items-center justify-between">
        {/* Logo */}
        <div className="flex items-center gap-6">
          <Link href={ROUTES.HOME} className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-full border border-primary/20 bg-primary shadow-[0_10px_30px_rgba(7,149,249,0.22)]">
              <span className="text-lg font-bold text-primary-foreground">
                G
              </span>
            </div>
            <span className="hidden font-semibold tracking-[0.08em] sm:inline-block">
              Gettitonline
            </span>
          </Link>

          {/* Desktop Navigation */}
          <nav className="hidden items-center gap-6 md:flex">
            {navigation.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "text-sm font-medium transition-colors hover:text-primary",
                  pathname === item.href
                    ? "text-primary"
                    : "text-muted-foreground"
                )}
              >
                {item.name}
              </Link>
            ))}
          </nav>
        </div>

        {/* Search Bar */}
        <div className="hidden flex-1 items-center justify-center px-6 lg:flex">
          <div className="relative w-full max-w-md">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search Gettitonline"
              className="w-full border-primary/15 bg-card/90 pl-10"
            />
          </div>
        </div>

        {/* Right Side Actions */}
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" asChild className="relative">
            <Link href={ROUTES.CART}>
              <ShoppingCart className="h-5 w-5" />
              {cartCount > 0 && (
                <Badge
                  variant="destructive"
                  className="absolute -right-1 -top-1 h-5 w-5 rounded-full p-0 text-xs"
                >
                  {cartCount > 99 ? "99+" : cartCount}
                </Badge>
              )}
            </Link>
          </Button>

          {isSignedIn ? (
            <>
              {hasListingAccess && (
                <Button
                  asChild
                  size="sm"
                  className="hidden gap-2 md:inline-flex"
                >
                  <Link href={ROUTES.CREATE_PRODUCT}>
                    <Plus className="h-4 w-4" />
                    Add Listing
                  </Link>
                </Button>
              )}

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
                  <Button
                    variant="ghost"
                    className="relative h-8 w-8 rounded-full"
                  >
                    <Avatar className="h-8 w-8">
                      <AvatarImage
                        src={clerkUser?.imageUrl}
                        alt={user?.firstName || "User"}
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
                        {clerkUser?.primaryEmailAddress?.emailAddress}
                      </p>
                    </div>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {canAccessAdminDashboard && (
                    <>
                      <DropdownMenuItem asChild>
                        <Link href={ROUTES.ADMIN_DASHBOARD}>
                          <LayoutDashboard className="mr-2 h-4 w-4" />
                          Admin Dashboard
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                    </>
                  )}
                  <DropdownMenuItem asChild>
                    <Link href={ROUTES.PROFILE}>
                      <User className="mr-2 h-4 w-4" />
                      Profile
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href={ROUTES.ORDERS}>
                      <Package className="mr-2 h-4 w-4" />
                      Orders
                    </Link>
                  </DropdownMenuItem>
                  {canAccessSell && (
                    <DropdownMenuItem asChild>
                      <Link href={ROUTES.SELL}>
                        <Plus className="mr-2 h-4 w-4" />
                        Sell
                      </Link>
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem asChild>
                    <Link href={ROUTES.FAVORITES}>
                      <Heart className="mr-2 h-4 w-4" />
                      Favorites
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href={ROUTES.MESSAGES}>
                      <MessageSquare className="mr-2 h-4 w-4" />
                      Messages
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href={ROUTES.WALLET}>
                      <Wallet className="mr-2 h-4 w-4" />
                      Wallet
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <Link href={ROUTES.SETTINGS}>
                      <Settings className="mr-2 h-4 w-4" />
                      Settings
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => signOut()}>
                    <LogOut className="mr-2 h-4 w-4" />
                    Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          ) : (
            <>
              <Button variant="ghost" asChild>
                <Link href={ROUTES.SIGN_IN}>Sign in</Link>
              </Button>
              <Button asChild>
                <Link href={ROUTES.SIGN_UP}>Sign up</Link>
              </Button>
            </>
          )}

          {/* Mobile Menu */}
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="md:hidden">
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="right">
              <SheetHeader>
                <SheetTitle>Menu</SheetTitle>
              </SheetHeader>
              <div className="mt-6 flex flex-col gap-4">
                {/* Mobile Search */}
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    type="search"
                    placeholder="Search Gettitonline"
                    className="w-full border-primary/15 bg-card/90 pl-10"
                  />
                </div>

                {/* Mobile Navigation */}
                <nav className="flex flex-col gap-2">
                  {navigation.map((item) => (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={cn(
                        "rounded-lg px-3 py-2 text-sm font-medium transition-colors hover:bg-accent",
                        pathname === item.href
                          ? "bg-accent text-accent-foreground"
                          : "text-muted-foreground"
                      )}
                    >
                      {item.name}
                    </Link>
                  ))}
                </nav>
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}
