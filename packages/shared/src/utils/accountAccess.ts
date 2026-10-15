// Settles the client's view of the signed-in account so protected screens can tell
// "still loading" apart from "access denied" and "no record". Pure: the caller supplies auth state.
export type AccountAccessStatus =
  | "loading"
  | "signed-out"
  | "recovery"
  | "unavailable"
  | "ready";

export interface AccountAccessSnapshot {
  readonly isLoading: boolean;
  readonly isSignedIn: boolean;
  readonly syncFailed: boolean;
  readonly user: {
    readonly isBanned: boolean;
    readonly deletedAt?: number;
  } | null;
}

export function resolveAccountAccess(
  snapshot: AccountAccessSnapshot,
): AccountAccessStatus {
  if (snapshot.isLoading) {
    return "loading";
  }

  if (snapshot.user) {
    // A cached account is not proof of a live session.
    if (!snapshot.isSignedIn) {
      return "signed-out";
    }
    return snapshot.user.isBanned || snapshot.user.deletedAt !== undefined
      ? "unavailable"
      : "ready";
  }

  return snapshot.isSignedIn || snapshot.syncFailed ? "recovery" : "signed-out";
}
