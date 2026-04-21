"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  LayoutDashboard,
  Users,
  Package,
  ClipboardCheck,
  ShoppingCart,
  FolderTree,
  AlertTriangle,
  CreditCard,
  Wallet,
  BarChart3,
  FileText,
  Settings,
  ChevronLeft,
  Store,
} from "lucide-react";
import { ROUTES } from "@/lib/constants";

const sidebarNav = [
  {
    title: "Overview",
    items: [
      {
        title: "Dashboard",
        href: ROUTES.ADMIN_DASHBOARD,
        icon: LayoutDashboard,
      },
    ],
  },
  {
    title: "Management",
    items: [
      {
        title: "Users",
        href: ROUTES.ADMIN_USERS,
        icon: Users,
      },
      {
        title: "Vendor Applications",
        href: ROUTES.ADMIN_VENDOR_APPLICATIONS,
        icon: Store,
      },
      {
        title: "Products",
        href: ROUTES.ADMIN_PRODUCTS,
        icon: Package,
      },
      {
        title: "Listing Review",
        href: ROUTES.ADMIN_LISTING_REVIEW,
        icon: ClipboardCheck,
      },
      {
        title: "Orders",
        href: ROUTES.ADMIN_ORDERS,
        icon: ShoppingCart,
      },
      {
        title: "Categories",
        href: ROUTES.ADMIN_CATEGORIES,
        icon: FolderTree,
      },
    ],
  },
  {
    title: "Disputes & Finance",
    items: [
      {
        title: "Disputes",
        href: ROUTES.ADMIN_DISPUTES,
        icon: AlertTriangle,
      },
      {
        title: "Transactions",
        href: ROUTES.ADMIN_TRANSACTIONS,
        icon: CreditCard,
      },
      {
        title: "Escrow",
        href: ROUTES.ADMIN_ESCROW,
        icon: Wallet,
      },
    ],
  },
  {
    title: "Analytics",
    items: [
      {
        title: "Analytics",
        href: ROUTES.ADMIN_ANALYTICS,
        icon: BarChart3,
      },
      {
        title: "Reports",
        href: ROUTES.ADMIN_REPORTS,
        icon: FileText,
      },
    ],
  },
  {
    title: "Settings",
    items: [
      {
        title: "Settings",
        href: ROUTES.ADMIN_SETTINGS,
        icon: Settings,
      },
    ],
  },
];

interface AdminSidebarProps {
  className?: string;
}

export function AdminSidebar({ className }: AdminSidebarProps) {
  const pathname = usePathname();

  return (
    <div className={cn("flex h-full flex-col border-r bg-background", className)}>
      {/* Header */}
      <div className="flex h-16 items-center justify-between border-b px-4">
        <Link href={ROUTES.ADMIN_DASHBOARD} className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-full border border-primary/20 bg-primary shadow-[0_10px_30px_rgba(7,149,249,0.22)]">
            <span className="text-lg font-bold text-primary-foreground">G</span>
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-semibold">Gettitonline</span>
            <span className="text-xs text-muted-foreground">Admin Panel</span>
          </div>
        </Link>
      </div>

      {/* Navigation */}
      <ScrollArea className="flex-1 py-4">
        <div className="space-y-6 px-3">
          {sidebarNav.map((section) => (
            <div key={section.title}>
              <h4 className="mb-2 px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {section.title}
              </h4>
              <div className="space-y-1">
                {section.items.map((item) => {
                  const isActive = pathname === item.href;
                  return (
                    <Button
                      key={item.href}
                      variant={isActive ? "secondary" : "ghost"}
                      className={cn(
                        "w-full justify-start",
                        isActive && "bg-secondary"
                      )}
                      asChild
                    >
                      <Link href={item.href}>
                        <item.icon className="mr-2 h-4 w-4" />
                        {item.title}
                      </Link>
                    </Button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>

      {/* Footer */}
      <div className="border-t p-4">
        <Button variant="outline" className="w-full justify-start" asChild>
          <Link href={ROUTES.HOME}>
            <Store className="mr-2 h-4 w-4" />
            Back to Store
          </Link>
        </Button>
      </div>
    </div>
  );
}
