import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useAuth, useUser } from '@clerk/clerk-expo';
import { useConvexAuth, useQuery, useMutation } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { User } from '../types';
import { setAIConsentSubject } from '../services/aiConsent';

interface ClerkUserType {
  id: string;
  primaryEmailAddress?: { emailAddress: string };
  firstName: string | null;
  lastName: string | null;
  imageUrl?: string;
}

interface AuthContextType {
  isLoading: boolean;
  isSignedIn: boolean;
  user: User | null;
  clerkUser: ClerkUserType | null;
  authSyncError: string | null;
  postAuthDestination: 'Cart' | 'Checkout' | null;
  setPostAuthDestination: React.Dispatch<
    React.SetStateAction<'Cart' | 'Checkout' | null>
  >;
  retryUserSync: () => void;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const ACCOUNT_SYNC_ERROR =
  'We could not finish setting up your account. Check your connection and try again.';

// Account sync state belongs to the Clerk subject that started it (null when signed out). Any other subject reads
// it as unsettled, with no profile and no error, so one account's result cannot reach another account or a signed-out session.
interface SyncState {
  readonly subject: string | null;
  readonly profile: User | null;
  readonly error: string | null;
  readonly settled: boolean;
}

const NO_SYNC: SyncState = { subject: null, profile: null, error: null, settled: false };

function syncFor(state: SyncState, subject: string | null): SyncState {
  return state.subject === subject ? state : { subject, profile: null, error: null, settled: false };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn, signOut: clerkSignOut } = useAuth();
  const { user: clerkUser } = useUser();
  const { isLoading: convexAuthLoading, isAuthenticated: convexAuthenticated } = useConvexAuth();
  const [syncState, setSyncState] = useState<SyncState>(NO_SYNC);
  const [syncAttempt, setSyncAttempt] = useState(0);
  const [postAuthDestination, setPostAuthDestination] = useState<
    'Cart' | 'Checkout' | null
  >(null);

  const currentSubject = clerkUser?.id ?? null;
  const subjectRef = useRef(currentSubject);
  const sync = syncFor(syncState, currentSubject);

  // The profile is requested only once Convex holds an authenticated token, so it cannot fail as Unauthenticated.
  const profileReady = currentSubject !== null && convexAuthenticated && !convexAuthLoading;
  const convexUser = useQuery(api.users.getUserByClerkId, profileReady ? { clerkId: currentSubject } : 'skip');
  // A server profile is trusted only for the subject it was requested for, and only while Convex is authenticated.
  const profileForSubject =
    convexAuthenticated && convexUser && convexUser.clerkId === currentSubject ? convexUser : null;
  // Pending is undefined. Null is the server's answer that no account exists for this subject, and it counts only after
  // this subject's sync has settled, so a profile that is not created yet is not mistaken for a deleted one.
  const profileMissing = profileReady && sync.settled && convexUser === null;

  // Mutation to upsert user
  const upsertUser = useMutation(api.users.upsertUser);

  useEffect(() => {
    setAIConsentSubject(
      clerkUser?.id ? `account:${clerkUser.id}` : 'guest',
    );
  }, [clerkUser?.id]);

  useEffect(() => {
    subjectRef.current = currentSubject;
  }, [currentSubject]);

  // Keeps the last profile the server verified for this subject, which a pending reload falls back to. An authoritative
  // missing answer drops it, so the deleted account is not shown from the cache.
  useEffect(() => {
    if (profileForSubject !== null) {
      setSyncState((prev) =>
        prev.subject === currentSubject && prev.profile === profileForSubject
          ? prev
          : { ...syncFor(prev, currentSubject), profile: profileForSubject },
      );
    } else if (profileMissing) {
      setSyncState((prev) => (prev.profile === null ? prev : { ...prev, profile: null }));
    }
  }, [currentSubject, profileForSubject, profileMissing]);

  // Sync Clerk user with Convex
  useEffect(() => {
    let isCancelled = false;

    async function syncUser() {
      if (!isLoaded) {
        return;
      }

      if (!isSignedIn || !clerkUser) {
        if (!isCancelled) {
          setSyncState({ subject: null, profile: null, error: null, settled: true });
        }
        return;
      }

      // Wait for Convex to attach the Clerk token, then require it: without it, protected calls fail.
      if (convexAuthLoading) {
        return;
      }

      const subject = clerkUser.id;
      // A reply applies only if its subject is still current when it arrives.
      const isCurrent = () => !isCancelled && subjectRef.current === subject;

      if (!convexAuthenticated) {
        if (isCurrent()) {
          setSyncState((prev) => ({
            ...syncFor(prev, subject),
            profile: null,
            error: ACCOUNT_SYNC_ERROR,
            settled: true,
          }));
        }
        return;
      }

      if (isCurrent()) {
        setSyncState((prev) => ({ ...syncFor(prev, subject), error: null, settled: false }));
      }

      try {
        await upsertUser({
          email: clerkUser.primaryEmailAddress?.emailAddress || '',
          firstName: clerkUser.firstName || '',
          lastName: clerkUser.lastName || '',
          avatar: clerkUser.imageUrl,
        });

        // The reply holds only an ID, which is not proof of ownership. The profile is exposed only when the server returns
        // it for this subject, so this sync records completion and nothing else.
        if (isCurrent()) {
          setSyncState((prev) => ({ ...syncFor(prev, subject), error: null, settled: true }));
        }
      } catch (error) {
        console.error('Failed to sync user with Convex:', error);
        if (isCurrent()) {
          setSyncState((prev) => ({
            ...syncFor(prev, subject),
            profile: null,
            error: ACCOUNT_SYNC_ERROR,
            settled: true,
          }));
        }
      }
    }

    void syncUser();

    return () => {
      isCancelled = true;
    };
  }, [isLoaded, isSignedIn, clerkUser, syncAttempt, upsertUser, convexAuthLoading, convexAuthenticated]);

  const handleSignOut = async () => {
    try {
      setSyncState({ subject: null, profile: null, error: null, settled: true });
      setAIConsentSubject('guest');
      await clerkSignOut();
    } catch (error) {
      console.error('Sign out error:', error);
    }
  };

  const retryUserSync = () => {
    setSyncState((prev) => (prev.subject === currentSubject ? { ...prev, error: null } : prev));
    setSyncAttempt((currentAttempt) => currentAttempt + 1);
  };

  // A cached profile is not proof of a live session: expose the user only while Convex is authenticated. The cache serves
  // only while the server is still pending for this subject. An authoritative missing account exposes no user and
  // surfaces the sync error, which routes to the recovery screen.
  const user =
    convexAuthenticated && !profileMissing
      ? (profileForSubject ?? (convexUser === undefined ? sync.profile : null))
      : null;
  const authSyncError = profileForSubject ? null : profileMissing ? ACCOUNT_SYNC_ERROR : sync.error;
  const isInitialized = sync.settled;
  const isLoading =
    !isLoaded ||
    !isInitialized ||
    convexAuthLoading ||
    (Boolean(isSignedIn) && !user && !authSyncError);

  const clerkUserData: ClerkUserType | null = clerkUser ? {
    id: clerkUser.id,
    primaryEmailAddress: clerkUser.primaryEmailAddress ? { emailAddress: clerkUser.primaryEmailAddress.emailAddress } : undefined,
    firstName: clerkUser.firstName,
    lastName: clerkUser.lastName,
    imageUrl: clerkUser.imageUrl,
  } : null;

  return (
    <AuthContext.Provider
      value={{
        isLoading,
        isSignedIn: isSignedIn ?? false,
        user,
        clerkUser: clerkUserData,
        authSyncError,
        postAuthDestination,
        setPostAuthDestination,
        retryUserSync,
        signOut: handleSignOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAppAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAppAuth must be used within an AuthProvider');
  }
  return context;
}
