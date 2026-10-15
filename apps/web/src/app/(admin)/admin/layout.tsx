"use client";

import { useState } from "react";
import { useAccountAccess, type AccountUser } from "@/hooks/useAccountAccess";
import { AccountAccessNotice } from "@/components/common/AccountAccessNotice";
import { AdminSidebar } from "@/components/admin/layout/AdminSidebar";
import { AdminHeader } from "@/components/admin/layout/AdminHeader";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { redirect } from "next/navigation";
import { ROUTES } from "@/lib/constants";

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
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

  if (user.role !== "admin" && user.role !== "moderator") {
    redirect(ROUTES.HOME);
    return null;
  }

  return (
    <AdminShell key={user._id} user={user} signOut={access.signOut}>
      {children}
    </AdminShell>
  );
}

function AdminShell({
  children,
  user,
  signOut,
}: {
  children: React.ReactNode;
  user: AccountUser;
  signOut: () => Promise<void>;
}) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Desktop Sidebar */}
      <AdminSidebar className="hidden w-64 lg:flex" />

      {/* Mobile Sidebar */}
      <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
        <SheetContent side="left" className="w-64 p-0">
          <AdminSidebar />
        </SheetContent>
      </Sheet>

      {/* Main Content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <AdminHeader
          user={user}
          signOut={signOut}
          onMenuClick={() => setSidebarOpen(true)}
        />
        <main className="flex-1 overflow-y-auto bg-muted/30 p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
