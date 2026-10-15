"use client";

import { useAuth as useClerkAuth, useUser } from "@clerk/nextjs";
import { useConvexAuth, useQuery, useMutation } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { useEffect, useState } from "react";

export function useAuth() {
  const { isLoaded, isSignedIn, signOut: clerkSignOut } = useClerkAuth();
  const { user: clerkUser } = useUser();
  const { isLoading: convexAuthLoading, isAuthenticated: convexAuthenticated } = useConvexAuth();
  const [isInitialized, setIsInitialized] = useState(false);
  // A failure belongs to the Clerk subject that produced it, so it never describes the next account.
  const [failedSyncClerkId, setFailedSyncClerkId] = useState<string | null>(
    null,
  );
  const [syncAttempt, setSyncAttempt] = useState(0);
  const syncFailed =
    failedSyncClerkId !== null && failedSyncClerkId === (clerkUser?.id ?? null);

  // Protected reads wait for Convex to settle its auth. Clerk being loaded is not enough for the server to accept them.
  const convexAuthSettled = convexAuthenticated && !convexAuthLoading;

  // Query user from Convex
  const convexRow = useQuery(
    api.users.getUserByClerkId,
    clerkUser?.id && convexAuthSettled ? { clerkId: clerkUser.id } : "skip",
  );

  // A row is trusted only for the Clerk subject it names. A row left from a previous account reads as still loading.
  const convexUser =
    convexRow === undefined || convexRow === null
      ? convexRow
      : convexRow.clerkId === clerkUser?.id
        ? convexRow
        : undefined;

  // Mutation to upsert user
  const upsertUser = useMutation(api.users.upsertUser);

  // Sync Clerk user with Convex. A run owns its request: once a newer run supersedes it (sign-out, account
  // switch, retry), the late completion must not change the state that newer run settles.
  useEffect(() => {
    let isCancelled = false;

    async function syncUser() {
      if (!isLoaded || !isSignedIn || !clerkUser) {
        setFailedSyncClerkId(null);
        setIsInitialized(true);
        return;
      }

      // Wait for Convex to attach the Clerk token. Without it, the sync and protected queries fail.
      if (convexAuthLoading) {
        return;
      }

      const subject = clerkUser.id;
      if (!convexAuthenticated) {
        setFailedSyncClerkId(subject);
        setIsInitialized(true);
        return;
      }

      try {
        await upsertUser({
          email: clerkUser.primaryEmailAddress?.emailAddress || "",
          firstName: clerkUser.firstName || "",
          lastName: clerkUser.lastName || "",
          avatar: clerkUser.imageUrl,
        });
        if (!isCancelled) {
          setFailedSyncClerkId(null);
        }
      } catch (error) {
        if (isCancelled) {
          return;
        }
        // Clerk alone is not enough: without a confirmed Convex identity the app treats the user as signed out.
        console.error("Failed to sync user with Convex:", error);
        setFailedSyncClerkId(subject);
      }
      if (!isCancelled) {
        setIsInitialized(true);
      }
    }

    syncUser();

    return () => {
      isCancelled = true;
    };
  }, [isLoaded, isSignedIn, clerkUser, upsertUser, convexAuthLoading, convexAuthenticated, syncAttempt]);

  const handleSignOut = async () => {
    try {
      await clerkSignOut();
    } catch (error) {
      console.error("Sign out error:", error);
    }
  };

  const retrySync = () => {
    setFailedSyncClerkId(null);
    setSyncAttempt((attempt) => attempt + 1);
  };

  // A terminal sync failure settles the account, so an unresolved profile query must not keep the page loading.
  const isLoading =
    !isLoaded ||
    !isInitialized ||
    convexAuthLoading ||
    (isSignedIn && !syncFailed && convexUser === undefined);

  return {
    isLoading,
    isSignedIn: (isSignedIn ?? false) && !syncFailed,
    user: convexAuthSettled && !syncFailed ? (convexUser ?? null) : null,
    clerkUser: clerkUser ?? null,
    syncFailed,
    retrySync,
    signOut: handleSignOut,
  };
}
