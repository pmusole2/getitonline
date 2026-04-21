import React, { createContext, useContext, useEffect, useState } from 'react';
import { useAuth, useUser } from '@clerk/clerk-expo';
import { useQuery, useMutation } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { User } from '../types';

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
  postAuthDestination: 'Cart' | 'Checkout' | null;
  setPostAuthDestination: React.Dispatch<
    React.SetStateAction<'Cart' | 'Checkout' | null>
  >;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn, signOut: clerkSignOut } = useAuth();
  const { user: clerkUser } = useUser();
  const [isInitialized, setIsInitialized] = useState(false);
  const [fallbackUser, setFallbackUser] = useState<User | null>(null);
  const [postAuthDestination, setPostAuthDestination] = useState<
    'Cart' | 'Checkout' | null
  >(null);

  // Query user from Convex
  const convexUser = useQuery(
    api.users.getUserByClerkId,
    clerkUser?.id ? { clerkId: clerkUser.id } : 'skip'
  );

  // Mutation to upsert user
  const upsertUser = useMutation(api.users.upsertUser);

  useEffect(() => {
    if (convexUser) {
      setFallbackUser(null);
    }
  }, [convexUser]);

  // Sync Clerk user with Convex
  useEffect(() => {
    let isCancelled = false;

    async function syncUser() {
      if (!isLoaded) {
        return;
      }

      if (!isSignedIn || !clerkUser) {
        if (!isCancelled) {
          setFallbackUser(null);
          setIsInitialized(true);
        }
        return;
      }

      if (!isCancelled) {
        setIsInitialized(false);
      }

      try {
        const userId = await upsertUser({
          clerkId: clerkUser.id,
          email: clerkUser.primaryEmailAddress?.emailAddress || '',
          firstName: clerkUser.firstName || '',
          lastName: clerkUser.lastName || '',
          avatar: clerkUser.imageUrl,
        });

        if (!isCancelled) {
          const now = Date.now();

          setFallbackUser((currentUser) => ({
            _id: userId,
            _creationTime: currentUser?._creationTime ?? now,
            clerkId: clerkUser.id,
            email: clerkUser.primaryEmailAddress?.emailAddress || '',
            firstName: clerkUser.firstName || '',
            lastName: clerkUser.lastName || '',
            avatar: clerkUser.imageUrl,
            role: currentUser?.role ?? 'user',
            totalSales: currentUser?.totalSales ?? 0,
            totalPurchases: currentUser?.totalPurchases ?? 0,
            isVerified: currentUser?.isVerified ?? false,
            isBanned: currentUser?.isBanned ?? false,
            createdAt: currentUser?.createdAt ?? now,
            updatedAt: now,
            phone: currentUser?.phone,
            interests: currentUser?.interests,
            address: currentUser?.address,
            preferences: currentUser?.preferences,
            rating: currentUser?.rating,
          }));
        }
      } catch (error) {
        console.error('Failed to sync user with Convex:', error);
      } finally {
        if (!isCancelled) {
          setIsInitialized(true);
        }
      }
    }

    void syncUser();

    return () => {
      isCancelled = true;
    };
  }, [isLoaded, isSignedIn, clerkUser, upsertUser]);

  const handleSignOut = async () => {
    try {
      await clerkSignOut();
    } catch (error) {
      console.error('Sign out error:', error);
    }
  };

  const user = convexUser ?? fallbackUser;
  const isLoading =
    !isLoaded || !isInitialized || (Boolean(isSignedIn) && !user);

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
        postAuthDestination,
        setPostAuthDestination,
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
