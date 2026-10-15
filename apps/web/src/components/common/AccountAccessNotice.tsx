"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { AccountAccessControl } from "@/hooks/useAccountAccess";
import { ROUTES } from "@/lib/constants";

interface AccountAccessNoticeProps {
  readonly access: AccountAccessControl;
  readonly heading: string;
  readonly signInMessage: string;
  readonly signInHref?: string;
}

// Stands in for a protected page whose account is not ready. Renders nothing for a ready account.
export function AccountAccessNotice({
  access,
  heading,
  signInMessage,
  signInHref = ROUTES.SIGN_IN,
}: AccountAccessNoticeProps) {
  if (access.status === "ready") {
    return null;
  }

  if (access.status === "loading") {
    return (
      <div className="container space-y-6 py-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  return (
    <div className="container flex flex-col items-center justify-center py-16">
      {access.status === "signed-out" && (
        <>
          <h1 className="mt-4 text-2xl font-bold">{heading}</h1>
          <p className="mt-2 text-muted-foreground">{signInMessage}</p>
          <Button asChild className="mt-6">
            <Link href={signInHref}>Sign In</Link>
          </Button>
        </>
      )}

      {access.status === "recovery" && (
        <>
          <h1 className="mt-4 text-2xl font-bold">
            Account setup did not finish
          </h1>
          <p className="mt-2 text-center text-muted-foreground">
            We could not finish setting up your account. Check your connection
            and try again.
          </p>
          <div className="mt-6 flex gap-3">
            <Button onClick={() => access.retry()}>Try again</Button>
            <Button variant="outline" onClick={() => void access.signOut()}>
              Sign out
            </Button>
          </div>
        </>
      )}

      {access.status === "unavailable" && (
        <>
          <h1 className="mt-4 text-2xl font-bold">Account unavailable</h1>
          <p className="mt-2 text-center text-muted-foreground">
            This account cannot use this area. If you think this is a mistake,
            contact support.
          </p>
          <div className="mt-6 flex gap-3">
            <Button variant="outline" onClick={() => void access.signOut()}>
              Sign out
            </Button>
            <Button asChild variant="ghost">
              <Link href={ROUTES.HOME}>Back to home</Link>
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
