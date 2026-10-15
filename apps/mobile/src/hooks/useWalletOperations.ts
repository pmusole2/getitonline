import AsyncStorage from '@react-native-async-storage/async-storage';
import { resolveAccountAccess, type AccountAccessStatus } from '@gettitonline/shared';
import { useConvex, useConvexAuth, useQueries, type RequestForQueries } from 'convex/react';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { randomUUID } from 'expo-crypto';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { api } from '../../../../convex/_generated/api';
import { useAppAuth } from '../context/AuthProvider';
import { checkoutPayerPhoneValid } from '../services/checkoutOperationState';
import {
  claimWalletRecovery,
  clearWalletRecovery,
  readWalletRecovery,
  resolvedWalletAccount,
  walletAmountCents,
  walletOutcome,
  type PaymentAccount,
  type WalletOperationKind,
  type WalletRecovery,
  type WalletStatus,
} from '../services/walletOperationState';
import { usePaymentAvailability } from './usePaymentAvailability';

type Destination = FunctionArgs<typeof api.providerOperations.registerPaymentAccount>['destination'];
type Operator = FunctionArgs<typeof api.providerOperations.initiateTopUpCollection>['operator'];
type Bank = FunctionReturnType<typeof api.providerOperations.listBanks>['banks'][number];
type Client = ReturnType<typeof useConvex>;
interface Session {
  readonly owner: string | null;
  readonly client: Client;
  readonly key: number;
  readonly staleAccounts: unknown;
  readonly staleStatus: unknown;
}
interface Work {
  readonly session: Session;
  readonly epoch: number;
}
interface State {
  readonly session: Session;
  readonly loaded: boolean;
  readonly recovery: WalletRecovery | null;
  readonly error: string | null;
  readonly working: boolean;
  readonly banks: Bank[];
  readonly accounts: PaymentAccount[] | null;
  readonly checked: WalletStatus | Error | undefined;
  readonly checkedAgainst: unknown;
  readonly approvalRevision: number;
}
let sessionSequence = 0;
const NO_REQUESTS: RequestForQueries = {};

function initial(session: Session): State {
  return {
    session,
    loaded: false,
    recovery: null,
    error: null,
    working: false,
    banks: [],
    accounts: null,
    checked: undefined,
    checkedAgainst: undefined,
    approvalRevision: 0,
  };
}

export interface WalletOperations {
  readonly access: AccountAccessStatus;
  readonly sessionKey: number;
  readonly isCurrent: () => boolean;
  readonly ready: boolean;
  readonly working: boolean;
  readonly error: string | null;
  readonly recovery: WalletRecovery | null;
  readonly outcome: ReturnType<typeof walletOutcome>;
  readonly status: WalletStatus | Error | undefined;
  readonly banks: Bank[];
  readonly accounts: PaymentAccount[];
  readonly accountsPending: boolean;
  readonly accountsError: boolean;
  readonly approvalRevision: number;
  loadBanks(): Promise<void>;
  registerDestination(destination: Destination): Promise<void>;
  topUp(amount: string, phone: string, operator: Operator): Promise<void>;
  withdraw(
    amount: string,
    accountId: FunctionArgs<typeof api.providerOperations.initiateWithdrawal>['paymentAccountId'],
    expectedDestinationKey: string,
  ): Promise<void>;
  checkStatus(): Promise<void>;
  newSubmission(): Promise<void>;
  cancelDraft(): void;
}

export function useWalletOperations(): WalletOperations {
  const auth = useAppAuth();
  const client = useConvex();
  const convexAuth = useConvexAuth();
  const available = usePaymentAvailability() === 'available';
  const resolvedAccess = resolveAccountAccess({
    isLoading: auth.isLoading,
    isSignedIn: auth.isSignedIn,
    syncFailed: auth.authSyncError !== null,
    user: auth.user,
  });
  const profileAccess: AccountAccessStatus =
    auth.authSyncError !== null && resolvedAccess === 'ready' ? 'recovery' : resolvedAccess;
  const matches = typeof auth.clerkUser?.id === 'string' && auth.user?.clerkId === auth.clerkUser.id;
  const owner =
    profileAccess === 'ready' && matches && convexAuth.isAuthenticated && !convexAuth.isLoading
      ? (auth.clerkUser?.id ?? null)
      : null;
  const access: AccountAccessStatus =
    profileAccess !== 'ready' ? profileAccess : convexAuth.isLoading ? 'loading' : owner ? 'ready' : 'recovery';
  const lastResults = useRef<{ accounts: unknown; status: unknown }>({ accounts: undefined, status: undefined });
  const session = useMemo<Session>(
    () => ({
      owner,
      client,
      key: ++sessionSequence,
      staleAccounts: lastResults.current.accounts,
      staleStatus: lastResults.current.status,
    }),
    [owner, client, auth.user?._id],
  );
  const [stored, setStored] = useState<State>(() => initial(session));
  const state = stored.session === session ? stored : initial(session);
  if (stored.session !== session) setStored(state);
  const committed = useRef<Session | null>(null);
  const allowed = useRef(false);
  const busy = useRef<Work | null>(null);
  const epoch = useRef(0);
  useLayoutEffect(() => {
    committed.current = session;
    return () => {
      if (committed.current === session) committed.current = null;
    };
  }, [session]);
  useLayoutEffect(() => {
    allowed.current = available;
  }, [available]);
  const current = useCallback(() => committed.current === session && session.owner !== null, [session]);
  const patch = useCallback(
    (update: Partial<State>) => {
      if (!current()) return;
      setStored((previous) => (previous.session === session ? { ...previous, ...update } : previous));
    },
    [current, session],
  );
  const requests = useMemo<RequestForQueries>(() => {
    if (!owner) return NO_REQUESTS;
    return {
      accounts: { query: api.providerOperations.listPaymentAccounts, args: {} },
      ...(state.recovery
        ? { status: { query: api.paymentReconciliation.getStatus, args: { requestId: state.recovery.requestId } } }
        : {}),
    };
  }, [owner, state.recovery?.requestId]);
  const results = useQueries(requests);
  const liveAccounts: PaymentAccount[] | Error | undefined = results.accounts;
  const liveStatus: WalletStatus | Error | undefined = results.status;
  useLayoutEffect(() => {
    lastResults.current = {
      accounts: liveAccounts === undefined ? lastResults.current.accounts : liveAccounts,
      status: liveStatus === undefined ? lastResults.current.status : liveStatus,
    };
  });
  const accountResult = liveAccounts !== session.staleAccounts ? liveAccounts : undefined;
  const accounts =
    accountResult instanceof Error
      ? null
      : owner && Array.isArray(accountResult)
        ? accountResult
        : owner
          ? state.accounts
          : null;
  const freshStatus = owner && liveStatus !== session.staleStatus ? liveStatus : undefined;
  const status = state.checked !== undefined && state.checkedAgainst === liveStatus ? state.checked : freshStatus;
  const outcome = walletOutcome(state.recovery, status);
  // Track each destination's committed approval history; unrelated accounts and display names do not revoke it.
  const approvalFacts = Array.isArray(accountResult)
    ? new Map(accountResult.filter(resolvedWalletAccount).map((account) => [account.accountId, account.destinationKey]))
    : null;
  const ownedApproval = useRef({ facts: approvalFacts, generations: new Map<string, number>() });
  const latest = useRef({
    loaded: state.loaded,
    recovery: state.recovery,
    accounts,
    banks: state.banks,
    outcome,
    approvalRevision: state.approvalRevision,
  });
  useLayoutEffect(() => {
    const previousFacts = ownedApproval.current.facts;
    const generations = ownedApproval.current.generations;
    for (const accountId of new Set([...(previousFacts?.keys() ?? []), ...(approvalFacts?.keys() ?? [])])) {
      if (previousFacts?.get(accountId) !== approvalFacts?.get(accountId)) {
        generations.set(accountId, (generations.get(accountId) ?? 0) + 1);
      }
    }
    ownedApproval.current = { facts: approvalFacts, generations };
    latest.current = {
      loaded: state.loaded,
      recovery: state.recovery,
      accounts,
      banks: state.banks,
      outcome,
      approvalRevision: state.approvalRevision,
    };
  });

  useEffect(() => {
    if (!owner) return;
    void readWalletRecovery(AsyncStorage, owner).then(
      (recovery) => patch({ loaded: true, recovery }),
      () =>
        patch({
          error: 'Wallet recovery could not be read. Check storage or contact support; no new payment was sent.',
        }),
    );
  }, [owner, patch]);

  const renderedEpoch = epoch.current;
  const start = useCallback((): Work | null => {
    if (renderedEpoch !== epoch.current || !current() || busy.current?.session === session) return null;
    epoch.current += 1;
    const work: Work = { session, epoch: epoch.current };
    busy.current = work;
    patch({ working: true, error: null });
    return work;
  }, [current, patch, session, renderedEpoch]);
  const workCurrent = useCallback((work: Work): boolean => current() && work.epoch === epoch.current, [current]);
  const finish = useCallback(
    (work: Work): void => {
      if (busy.current !== work) return;
      busy.current = null;
      if (workCurrent(work)) patch({ working: false });
    },
    [patch, workCurrent],
  );
  const retireWork = useCallback(
    (work: Work): void => {
      if (!workCurrent(work) || busy.current !== work) return;
      epoch.current += 1;
      busy.current = null;
      patch({ working: false, error: null });
    },
    [patch, workCurrent],
  );

  const cancelDraft = useCallback((): void => {
    if (!current() || renderedEpoch !== epoch.current) return;
    epoch.current += 1;
    busy.current = null;
    patch({ working: false, error: null });
  }, [current, patch, renderedEpoch]);

  const loadBanks = useCallback(async (): Promise<void> => {
    const work = start();
    if (!work) return;
    try {
      const result = await client.action(api.providerOperations.listBanks, {});
      if (!workCurrent(work)) return;
      patch({ banks: result.banks });
    } catch {
      if (workCurrent(work)) patch({ error: 'Bank directory unavailable. Try loading it again.' });
    } finally {
      finish(work);
    }
  }, [client, current, finish, patch, start, workCurrent]);

  const registerDestination = useCallback(
    async (destination: Destination): Promise<void> => {
      const work = start();
      if (!work) return;
      try {
        if (
          destination.type === 'bank_account' &&
          !latest.current.banks.some((bank) => bank.id === destination.bankId)
        ) {
          patch({ error: 'Select a bank from the current directory.' });
          return;
        }
        const registered = await client.action(api.providerOperations.registerPaymentAccount, { destination });
        if (!workCurrent(work)) return;
        const owned = await client.query(api.providerOperations.listPaymentAccounts, {});
        if (!workCurrent(work)) return;
        const resolved = owned.find(
          (account) =>
            account.accountId === registered.accountId &&
            account.destinationKey === registered.destinationKey &&
            resolvedWalletAccount(account),
        );
        patch({
          accounts: owned === session.staleAccounts ? null : owned,
          approvalRevision: state.approvalRevision + 1,
          error: resolved
            ? 'Destination resolved. Select it below and review the amount before approving withdrawal.'
            : 'Waiting for the owned resolved destination. Check destinations before approving.',
        });
      } catch {
        if (workCurrent(work)) patch({ error: 'Destination could not be resolved. No withdrawal was submitted.' });
      } finally {
        finish(work);
      }
    },
    [client, current, finish, patch, session, start, workCurrent, state.approvalRevision, state.banks],
  );

  const initiate = useCallback(
    async (
      kind: WalletOperationKind,
      send: (requestId: string) => Promise<FunctionReturnType<typeof api.providerOperations.initiateTopUpCollection>>,
      approvalCurrent: () => boolean = () => true,
    ): Promise<void> => {
      if (!current() || !allowed.current || !latest.current.loaded || latest.current.recovery || !owner) return;
      const work = start();
      if (!work) return;
      try {
        const claimed = await claimWalletRecovery(AsyncStorage, owner, kind, randomUUID, current);
        if (!current() || !claimed) return;
        patch({ recovery: claimed.recovery, checked: undefined });
        if (!claimed.created || !allowed.current || !workCurrent(work)) return;
        if (!approvalCurrent()) {
          patch({
            error: 'Destination approval changed. Keep this recovery and contact support before a new withdrawal.',
          });
          return;
        }

        // Identity is durable before the SDK action. Unknown replies never cause another POST.
        const result = await send(claimed.recovery.requestId);
        if (!workCurrent(work)) return;
        if (!result.ok) {
          // This exact backend outcome guarantees zero writes and zero provider POST. Require a new explicit review.
          await clearWalletRecovery(
            AsyncStorage,
            owner,
            claimed.recovery,
            () => workCurrent(work),
            () => {
              retireWork(work);
              patch({
                recovery: null,
                approvalRevision: state.approvalRevision + 1,
                error: 'Destination changed. Review the current owned destination and explicitly approve again.',
              });
            },
          );
        }
      } catch {
        if (workCurrent(work))
          patch({
            error: 'The request could not be confirmed. Keep this recovery and check status before any new payment.',
          });
      } finally {
        finish(work);
      }
    },
    [
      current,
      state.loaded,
      state.recovery,
      state.approvalRevision,
      start,
      owner,
      patch,
      finish,
      workCurrent,
      retireWork,
    ],
  );

  const topUp = useCallback(
    async (amount: string, phone: string, operator: Operator): Promise<void> => {
      if (!current() || renderedEpoch !== epoch.current || !allowed.current) return;
      const amountCents = walletAmountCents(amount);
      if (amountCents === null || !checkoutPayerPhoneValid(phone) || !['airtel', 'mtn', 'zamtel'].includes(operator)) {
        patch({ error: 'Enter a positive amount with at most two decimal places and a mobile money destination.' });
        return;
      }
      await initiate('top_up_collection', (requestId) =>
        client.action(api.providerOperations.initiateTopUpCollection, { requestId, amountCents, phone, operator }),
      );
    },
    [client, current, initiate, patch, renderedEpoch],
  );

  const withdraw = useCallback(
    async (
      amount: string,
      paymentAccountId: FunctionArgs<typeof api.providerOperations.initiateWithdrawal>['paymentAccountId'],
      expectedDestinationKey: string,
    ): Promise<void> => {
      if (!current() || renderedEpoch !== epoch.current || !allowed.current) return;
      const amountCents = walletAmountCents(amount);
      const account = latest.current.accounts?.find(
        (entry) => resolvedWalletAccount(entry) && entry.accountId === paymentAccountId,
      );
      if (
        amountCents === null ||
        ownedApproval.current.facts === null ||
        !account ||
        !resolvedWalletAccount(account) ||
        account.destinationKey !== expectedDestinationKey
      ) {
        patch({ error: 'Review a current owned resolved destination and a valid amount before approving.' });
        return;
      }
      const approvalGeneration = ownedApproval.current.generations.get(paymentAccountId) ?? 0;
      const approvalRevision = latest.current.approvalRevision;
      await initiate(
        'withdrawal_transfer',
        (requestId) =>
          client.action(api.providerOperations.initiateWithdrawal, {
            requestId,
            amountCents,
            paymentAccountId,
            expectedDestinationKey,
          }),
        () =>
          ownedApproval.current.facts?.get(paymentAccountId) === expectedDestinationKey &&
          (ownedApproval.current.generations.get(paymentAccountId) ?? 0) === approvalGeneration &&
          latest.current.approvalRevision === approvalRevision &&
          latest.current.accounts?.some(
            (entry) =>
              resolvedWalletAccount(entry) &&
              entry.accountId === paymentAccountId &&
              entry.destinationKey === expectedDestinationKey,
          ) === true,
      );
    },
    [accounts, client, current, initiate, patch, renderedEpoch],
  );

  const checkStatus = useCallback(async (): Promise<void> => {
    if (!state.recovery) return;
    const work = start();
    if (!work) return;
    const observedStatus = lastResults.current.status;
    try {
      const checked = await client.action(api.paymentReconciliation.refresh, { requestId: state.recovery.requestId });
      if (!workCurrent(work)) return;
      if (lastResults.current.status === observedStatus) patch({ checked, checkedAgainst: liveStatus });
    } catch {
      if (workCurrent(work))
        patch({ error: 'Status could not be checked. The request remains recoverable; try checking again.' });
    } finally {
      finish(work);
    }
  }, [client, current, finish, patch, start, state.recovery, liveStatus, workCurrent]);

  const newSubmission = useCallback(async (): Promise<void> => {
    const recovery = state.recovery;
    const terminal = () =>
      current() &&
      latest.current.recovery?.requestId === recovery?.requestId &&
      (latest.current.outcome === 'completed' || latest.current.outcome === 'failed');
    if (!recovery || !terminal() || !owner) return;
    const work = start();
    if (!work) return;
    try {
      await clearWalletRecovery(
        AsyncStorage,
        owner,
        recovery,
        () => workCurrent(work) && terminal(),
        () => {
          retireWork(work);
          patch({ recovery: null, checked: undefined, error: null });
        },
      );
    } catch {
      if (workCurrent(work))
        patch({ error: 'Recovery could not be cleared. Check storage or contact support; no new payment was sent.' });
    } finally {
      finish(work);
    }
  }, [current, finish, outcome, owner, patch, start, state.recovery, workCurrent, retireWork]);

  return {
    access,
    sessionKey: session.key,
    isCurrent: current,
    ready: owner !== null && state.loaded,
    working: owner !== null && state.working,
    error: owner ? state.error : null,
    recovery: owner ? state.recovery : null,
    outcome,
    status: owner ? status : undefined,
    banks: owner ? state.banks : [],
    accounts: accounts ?? [],
    accountsPending: owner !== null && accounts === null,
    accountsError: owner !== null && accountResult instanceof Error,
    approvalRevision: state.approvalRevision,
    loadBanks,
    registerDestination,
    topUp,
    withdraw,
    checkStatus,
    newSubmission,
    cancelDraft,
  };
}
