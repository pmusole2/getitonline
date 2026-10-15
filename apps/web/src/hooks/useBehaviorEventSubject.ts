import { resolveBehaviorEventSubject } from "@gettitonline/shared";
import { useConvexAuth } from "convex/react";
import type { useAuth } from "./useAuth";

export function useBehaviorEventSubject(
  auth: ReturnType<typeof useAuth>,
): string | null | undefined {
  const convex = useConvexAuth();

  return resolveBehaviorEventSubject({
    isLoading: auth.isLoading,
    isSignedIn: auth.isSignedIn,
    syncFailed: auth.syncFailed,
    clerkId: auth.clerkUser?.id ?? null,
    user: auth.user,
    convexLoading: convex.isLoading,
    convexAuthenticated: convex.isAuthenticated,
  });
}
