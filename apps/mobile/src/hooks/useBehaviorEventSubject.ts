import { resolveBehaviorEventSubject } from '@gettitonline/shared';
import { useConvexAuth } from 'convex/react';
import type { useAppAuth } from '../context/AuthProvider';

export function useBehaviorEventSubject(auth: ReturnType<typeof useAppAuth>): string | null | undefined {
  const convex = useConvexAuth();

  return resolveBehaviorEventSubject({
    isLoading: auth.isLoading,
    isSignedIn: auth.isSignedIn,
    syncFailed: auth.authSyncError !== null,
    clerkId: auth.clerkUser?.id ?? null,
    user: auth.user,
    convexLoading: convex.isLoading,
    convexAuthenticated: convex.isAuthenticated,
  });
}
