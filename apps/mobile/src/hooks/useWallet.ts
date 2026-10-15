/**
 * useWallet Hook - Wallet state management and operations
 */

import { useState, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useConvex, useConvexAuth, useMutation, useQueries, type RequestForQueries } from 'convex/react';
import { resolveAccountAccess } from '@gettitonline/shared';
import { api } from '../../../../convex/_generated/api';
import { useWalletOperations, type WalletOperations } from './useWalletOperations';
import { useAppAuth } from '../context/AuthProvider';
import { WalletBalance, WalletTransaction, WalletActivity } from '../services/wallet';

interface UseWalletReturn {
  // State
  balance: WalletBalance | null;
  activity: WalletActivity | null;
  transactions: WalletTransaction[];
  isLoading: boolean;
  error: string | null;

  // Actions
  refreshBalance: () => Promise<void>;
  refreshActivity: () => Promise<void>;
  refreshTransactions: (limit?: number) => Promise<void>;
  operations: WalletOperations;
  withdrawToMobileMoney: WalletOperations['withdraw'];
  withdrawToBank: WalletOperations['withdraw'];
  topUp: WalletOperations['topUp'];
  canPayWithWallet: (amount: number) => Promise<{
    canPay: boolean;
    reason?: string;
    currentBalance?: number;
    shortfall?: number;
  }>;
  ensureWallet: () => Promise<void>;
  clearError: () => void;
}

const TRANSACTION_LIMIT = 50;
const NO_REQUESTS: RequestForQueries = {};

// The three wallet reads. A one-off refresh and a realtime value are both tracked per read.
type ReadName = 'balance' | 'activity' | 'transactions';

// Realtime results for the three reads, as useQueries returns them: the value, an Error for a failed query, or
// undefined while the query is loading.
interface Readings {
  readonly balance: WalletBalance | Error | undefined;
  readonly activity: WalletActivity | Error | undefined;
  readonly transactions: WalletTransaction[] | Error | undefined;
}

const NO_READINGS: Readings = { balance: undefined, activity: undefined, transactions: undefined };

// Values one-off reads and failures put on screen for the verified account. They are dropped when a newer realtime value
// arrives for that read, and on an account change.
interface Owned {
  readonly balance?: WalletBalance;
  readonly activity?: WalletActivity;
  readonly transactions?: WalletTransaction[];
  // null means the error was dismissed. undefined means there is no action error.
  readonly error?: string | null;
}

// How many fresh realtime values each read has delivered for the verified account. Zero means its subscription has not
// produced a value since the account was verified.
interface Revisions {
  readonly balance: number;
  readonly activity: number;
  readonly transactions: number;
}

// The id of the latest one-off read started for each read. Zero means none has started for the verified account.
interface RequestIds {
  readonly balance: number;
  readonly activity: number;
  readonly transactions: number;
}

const NO_REVISIONS: Revisions = { balance: 0, activity: 0, transactions: 0 };
const NO_REQUEST_IDS: RequestIds = { balance: 0, activity: 0, transactions: 0 };

type ConvexClient = ReturnType<typeof useConvex>;

interface Tracker {
  // The verified account now. Null while readiness is unsettled, and then the held fields below are not shown.
  readonly subject: string | null;
  // The account the held fields belong to, and the client they came from. Both are kept through a temporary loss of
  // readiness, so the same account on the same client gets its values back without a new owner or client.
  readonly owner: string | null;
  readonly client: ConvexClient | null;
  // The realtime results held from an earlier owner or client. Convex keeps these until new results arrive, so an
  // object that is still one of these is not a result for the verified account.
  readonly stale: Readings;
  // The latest fresh realtime results for the held owner.
  readonly live: Readings;
  readonly revisions: Revisions;
  readonly requests: RequestIds;
  readonly owned: Owned;
}

const INITIAL_TRACKER: Tracker = {
  subject: null,
  owner: null,
  client: null,
  stale: NO_READINGS,
  live: NO_READINGS,
  revisions: NO_REVISIONS,
  requests: NO_REQUEST_IDS,
  owned: {},
};

const NO_OWNED: Owned = {};

// Convex keeps a query's last result when the auth token changes, until the new account's result arrives. A result that is
// still the same object as one held for an earlier account is therefore not shown.
function freshReading<T>(value: T | undefined, stale: T | undefined): T | undefined {
  return value === stale ? undefined : value;
}

// Folds the latest realtime results into the tracker. A read with a new fresh value gets a new revision, and the one-off
// value held for it is dropped, because the realtime value is at least as new.
function advance(tracker: Tracker, readings: Readings): Tracker {
  const balance = freshReading(readings.balance, tracker.stale.balance);
  const activity = freshReading(readings.activity, tracker.stale.activity);
  const transactions = freshReading(readings.transactions, tracker.stale.transactions);
  const balanceChanged = balance !== undefined && balance !== tracker.live.balance;
  const activityChanged = activity !== undefined && activity !== tracker.live.activity;
  const transactionsChanged = transactions !== undefined && transactions !== tracker.live.transactions;
  if (!balanceChanged && !activityChanged && !transactionsChanged) {
    return tracker;
  }
  return {
    ...tracker,
    live: {
      balance: balanceChanged ? balance : tracker.live.balance,
      activity: activityChanged ? activity : tracker.live.activity,
      transactions: transactionsChanged ? transactions : tracker.live.transactions,
    },
    revisions: {
      balance: tracker.revisions.balance + (balanceChanged ? 1 : 0),
      activity: tracker.revisions.activity + (activityChanged ? 1 : 0),
      transactions: tracker.revisions.transactions + (transactionsChanged ? 1 : 0),
    },
    owned: {
      balance: balanceChanged ? undefined : tracker.owned.balance,
      activity: activityChanged ? undefined : tracker.owned.activity,
      transactions: transactionsChanged ? undefined : tracker.owned.transactions,
      error: balanceChanged || activityChanged || transactionsChanged ? undefined : tracker.owned.error,
    },
  };
}

// Brings the tracker to the verified account and client. While readiness is unsettled the held fields stay, but are not
// shown. When the same account returns on the same client, they are kept and shown again. Another account or another
// client makes the held results stale, so none of them is shown until that owner's own results arrive.
function reconcile(tracker: Tracker, verified: string | null, client: ConvexClient): Tracker {
  if (verified === null) {
    return tracker.subject === null ? tracker : { ...tracker, subject: null };
  }
  if (tracker.owner === verified && tracker.client === client) {
    return tracker.subject === verified ? tracker : { ...tracker, subject: verified };
  }
  return {
    ...INITIAL_TRACKER,
    subject: verified,
    owner: verified,
    client,
    stale: {
      balance: tracker.live.balance ?? tracker.stale.balance,
      activity: tracker.live.activity ?? tracker.stale.activity,
      transactions: tracker.live.transactions ?? tracker.stale.transactions,
    },
  };
}

// A value for the screen from one read: a failed query shows no value, and a loading one shows none yet.
function valueOrNull<T>(reading: T | Error | undefined): T | null {
  if (reading === undefined || reading instanceof Error) {
    return null;
  }
  return reading;
}

// A one-off read is applied only if it is still the newest request for its read, the realtime value for that read has not
// changed since it started, and the account's subscription has produced a value. Until then the client may hold another
// account's result for the same query, so a refresh does not read at all.
interface ReadTicket {
  readonly owner: string;
  readonly id: number;
  readonly revision: number;
}

export function useWallet(): UseWalletReturn {
  const operations = useWalletOperations();
  const { user, clerkUser, isSignedIn, isLoading: authLoading, authSyncError } = useAppAuth();
  const convex = useConvex();
  const convexAuth = useConvexAuth();
  const [tracker, setTracker] = useState<Tracker>(INITIAL_TRACKER);

  // The account is verified when the synced user record belongs to the signed-in Clerk account, and Convex is
  // authenticated. Until then no wallet query is issued.
  const status = resolveAccountAccess({
    isLoading: authLoading,
    isSignedIn,
    syncFailed: authSyncError !== null,
    user,
  });
  const clerkId = clerkUser?.id;
  const accountSubject =
    status === 'ready' &&
    clerkId !== undefined &&
    user?.clerkId === clerkId &&
    convexAuth.isAuthenticated &&
    !convexAuth.isLoading
      ? clerkId
      : null;
  const settling = status === 'loading' || (isSignedIn && convexAuth.isLoading);

  // The request object is memoized on the account, so the realtime subscriptions keep their identity between renders.
  const requests = useMemo<RequestForQueries>(
    () =>
      accountSubject === null
        ? NO_REQUESTS
        : {
            balance: { query: api.wallet.getWalletBalance, args: {} },
            activity: { query: api.wallet.getWalletActivity, args: {} },
            transactions: { query: api.wallet.getWalletTransactions, args: { limit: TRANSACTION_LIMIT } },
          },
    [accountSubject],
  );
  // useQueries returns a failed query as an Error value, so a failed read shows an error state instead of throwing.
  const results = useQueries(requests);
  const readings: Readings = {
    balance: results.balance,
    activity: results.activity,
    transactions: results.transactions,
  };

  // Derived during render, so the first render after a change of account already shows nothing of the old one. The
  // stale results of an account are kept across a sign-out, so signing in as another account cannot read them back.
  let current = reconcile(tracker, accountSubject, convex);
  if (accountSubject !== null) {
    current = advance(current, readings);
  }
  if (current !== tracker) {
    setTracker(current);
  }

  // While readiness is unsettled nothing held is shown, even for the same account.
  const shownLive = current.subject === null ? NO_READINGS : current.live;
  const shownOwned = current.subject === null ? NO_OWNED : current.owned;
  const realtimeError = [shownLive.balance, shownLive.activity, shownLive.transactions].find(
    (value): value is Error => value instanceof Error,
  );
  const balance = shownOwned.balance ?? valueOrNull(shownLive.balance);
  const activity = shownOwned.activity ?? valueOrNull(shownLive.activity);
  const transactions = shownOwned.transactions ?? valueOrNull(shownLive.transactions);
  const error = shownOwned.error !== undefined ? shownOwned.error : (realtimeError?.message ?? null);
  const readsPending =
    accountSubject !== null && error === null && (balance === null || activity === null || transactions === null);

  // The committed tracker is published after each commit, so an event handler reads the state the screen shows.
  const committed = useRef(tracker);
  useLayoutEffect(() => {
    committed.current = tracker;
  });

  const subjectRef = useRef(accountSubject);
  useEffect(() => {
    subjectRef.current = accountSubject;
  }, [accountSubject]);

  const requestSeq = useRef(0);

  // Starts a one-off read. It returns null when no account is committed or its subscription has not produced a value yet.
  const beginRead = useCallback((read: ReadName): ReadTicket | null => {
    const owner = committed.current.subject;
    if (owner === null || committed.current.revisions[read] === 0) {
      return null;
    }
    requestSeq.current += 1;
    const id = requestSeq.current;
    setTracker((previous) =>
      previous.subject === owner ? { ...previous, requests: { ...previous.requests, [read]: id } } : previous,
    );
    return { owner, id, revision: committed.current.revisions[read] };
  }, []);

  // Applies a one-off reply only if it is still the newest request for its read, the account has not changed, and no
  // realtime value has arrived since it started. Otherwise the reply is dropped.
  const settleRead = useCallback((ticket: ReadTicket, read: ReadName, patch: Owned) => {
    setTracker((previous) =>
      previous.subject === ticket.owner &&
      previous.requests[read] === ticket.id &&
      previous.revisions[read] === ticket.revision
        ? { ...previous, owned: { ...previous.owned, ...patch } }
        : previous,
    );
  }, []);

  // Writes a read or an error for one account. It is dropped when that account is no longer the verified one.
  const patchOwned = useCallback((owner: string, patch: Owned) => {
    setTracker((previous) =>
      previous.subject === owner ? { ...previous, owned: { ...previous.owned, ...patch } } : previous,
    );
  }, []);

  // Convex mutations
  const ensureWalletMutation = useMutation(api.wallet.ensureWallet);

  // Refresh balance with a one-off Convex read
  const refreshBalance = useCallback(async () => {
    const ticket = beginRead('balance');
    if (ticket === null) return;
    try {
      const balanceResult = await convex.query(api.wallet.getWalletBalance, {});
      settleRead(ticket, 'balance', { balance: balanceResult, error: undefined });
    } catch (err) {
      settleRead(ticket, 'balance', {
        error: err instanceof Error ? err.message : 'Failed to refresh balance',
      });
    }
  }, [beginRead, settleRead, convex]);

  // Refresh activity with a one-off Convex read
  const refreshActivity = useCallback(async () => {
    const ticket = beginRead('activity');
    if (ticket === null) return;
    try {
      const activityResult = await convex.query(api.wallet.getWalletActivity, {});
      settleRead(ticket, 'activity', { activity: activityResult, error: undefined });
    } catch (err) {
      settleRead(ticket, 'activity', {
        error: err instanceof Error ? err.message : 'Failed to refresh activity',
      });
    }
  }, [beginRead, settleRead, convex]);

  // Refresh transactions with a one-off Convex read
  const refreshTransactions = useCallback(
    async (limit?: number) => {
      const ticket = beginRead('transactions');
      if (ticket === null) return;
      try {
        const transactionsResult = await convex.query(api.wallet.getWalletTransactions, {
          limit: limit ?? TRANSACTION_LIMIT,
        });
        settleRead(ticket, 'transactions', { transactions: transactionsResult, error: undefined });
      } catch (err) {
        settleRead(ticket, 'transactions', {
          error: err instanceof Error ? err.message : 'Failed to refresh transactions',
        });
      }
    },
    [beginRead, settleRead, convex],
  );

  // Check if can pay with wallet
  const canPayWithWallet = useCallback(
    async (amount: number) => {
      if (!user?._id) {
        return { canPay: false, reason: 'User not authenticated' };
      }
      if (!balance) {
        return { canPay: false, reason: 'Wallet not loaded' };
      }
      if (!balance.hasWallet) {
        return { canPay: false, reason: 'No wallet found' };
      }
      if (balance.isFrozen) {
        return { canPay: false, reason: 'Wallet is frozen' };
      }
      if (balance.balance < amount) {
        return {
          canPay: false,
          reason: 'Insufficient balance',
          currentBalance: balance.balance,
          shortfall: amount - balance.balance,
        };
      }
      return {
        canPay: true,
        currentBalance: balance.balance,
      };
    },
    [user?._id, balance],
  );

  // Ensure wallet exists. A reply for an account that is no longer verified reads and shows nothing.
  const ensureWallet = useCallback(async () => {
    if (accountSubject === null) return;
    const owner = accountSubject;
    try {
      await ensureWalletMutation({});
      if (subjectRef.current !== owner) return;
      await refreshBalance();
    } catch (err) {
      patchOwned(owner, { error: err instanceof Error ? err.message : 'Failed to create wallet' });
    }
  }, [accountSubject, ensureWalletMutation, refreshBalance, patchOwned]);

  // Clear error
  const clearError = useCallback(() => {
    setTracker((previous) => ({ ...previous, owned: { ...previous.owned, error: null } }));
  }, []);

  return {
    balance,
    activity,
    transactions: transactions ?? [],
    isLoading: settling || readsPending,
    error,
    refreshBalance,
    refreshActivity,
    refreshTransactions,
    operations,
    withdrawToMobileMoney: operations.withdraw,
    withdrawToBank: operations.withdraw,
    topUp: operations.topUp,
    canPayWithWallet,
    ensureWallet,
    clearError,
  };
}
