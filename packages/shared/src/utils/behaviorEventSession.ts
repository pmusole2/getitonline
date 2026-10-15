// An assertion restricts which session may record an event. It is never server-side authority.
export interface BehaviorEventSessionSnapshot {
  readonly isLoading: boolean;
  readonly isSignedIn: boolean;
  readonly syncFailed: boolean;
  readonly clerkId: string | null;
  readonly convexLoading: boolean;
  readonly convexAuthenticated: boolean;
  readonly user: {
    readonly clerkId: string;
    readonly isBanned: boolean;
    readonly deletedAt?: number;
  } | null;
}

// undefined suppresses events during pending/denied sessions; null is a settled guest.
export function resolveBehaviorEventSubject(
  snapshot: BehaviorEventSessionSnapshot,
): string | null | undefined {
  if (snapshot.isLoading || snapshot.convexLoading || snapshot.syncFailed) {
    return undefined;
  }

  if (!snapshot.clerkId) {
    return !snapshot.isSignedIn &&
      !snapshot.convexAuthenticated &&
      snapshot.user === null
      ? null
      : undefined;
  }

  if (
    !snapshot.isSignedIn ||
    !snapshot.convexAuthenticated ||
    !snapshot.user ||
    snapshot.user.isBanned ||
    snapshot.user.deletedAt !== undefined ||
    snapshot.user.clerkId !== snapshot.clerkId
  ) {
    return undefined;
  }

  return snapshot.clerkId;
}
