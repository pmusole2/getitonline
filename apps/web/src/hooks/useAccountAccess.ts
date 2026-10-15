"use client";

import {
  resolveAccountAccess,
  type AccountAccessStatus,
} from "@gettitonline/shared";
import { useAuth } from "@/hooks/useAuth";

export type AccountUser = NonNullable<ReturnType<typeof useAuth>["user"]>;

export interface AccountAccessControl {
  readonly status: AccountAccessStatus;
  readonly user: AccountUser | null;
  readonly retry: () => void;
  readonly signOut: () => Promise<void>;
}

// Protected pages render their content only for a ready account. The user travels with the status, so the
// content does not open a second auth subscription.
export function useAccountAccess(): AccountAccessControl {
  const { isLoading, isSignedIn, syncFailed, user, retrySync, signOut } =
    useAuth();

  return {
    status: resolveAccountAccess({ isLoading, isSignedIn, syncFailed, user }),
    user,
    retry: retrySync,
    signOut,
  };
}
