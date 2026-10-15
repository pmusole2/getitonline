import AsyncStorage from '@react-native-async-storage/async-storage';
import { resolveAccountAccess, type AccountAccessStatus } from '@gettitonline/shared';
import { useConvex, useConvexAuth, useQueries, type RequestForQueries } from 'convex/react';
import { randomUUID, digestStringAsync, CryptoDigestAlgorithm } from 'expo-crypto';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { api } from '../../../../convex/_generated/api';
import { useAppAuth } from '../context/AuthProvider';
import {
  claimCheckoutRecovery,
  clearCheckoutRecovery,
  readCheckoutRecovery,
  checkoutOutcome,
  checkoutRequestDocument,
  checkoutPayerPhoneValid,
  type CheckoutKind,
  type CheckoutProof,
  type CheckoutQuote,
  type CheckoutQuoteResult,
  type CheckoutRecovery,
  type CheckoutSelectors,
  type CheckoutStatus,
} from '../services/checkoutOperationState';
import type { MobileMoneyProvider } from '../services/payments';
import { usePaymentAvailability } from './usePaymentAvailability';

export interface PaymentOptions {
  readonly selectors: CheckoutSelectors | null;
  readonly kind: CheckoutKind;
  readonly phone?: string;
  readonly operator?: MobileMoneyProvider | null;
  readonly enabled: boolean;
  // Includes nonfinancial draft/cart changes which must retire captured Pay callbacks, never transmitted as authority.
  readonly contextKey?: string;
}
export interface CheckoutPayment {
  readonly access: AccountAccessStatus;
  readonly sessionKey: number;
  readonly ready: boolean;
  readonly working: boolean;
  readonly error: string | null;
  readonly recovery: CheckoutRecovery | null;
  readonly outcome: ReturnType<typeof checkoutOutcome>;
  readonly status: CheckoutStatus | Error | undefined;
  readonly quote: CheckoutQuote | null;
  readonly quoteResult: CheckoutQuoteResult | Error | undefined;
  isCurrent(): boolean;
  isCompleted(): boolean;
  submit(): Promise<void>;
  checkStatus(): Promise<void>;
  newSubmission(): Promise<void>;
  cancelDraft(): void;
}

interface Session {
  readonly owner: string | null;
  readonly client: ReturnType<typeof useConvex>;
  readonly key: number;
  readonly staleQuote: unknown;
  readonly staleStatus: unknown;
}
interface State {
  readonly session: Session;
  readonly loaded: boolean;
  readonly recovery: CheckoutRecovery | null;
  readonly proof?: CheckoutProof;
  readonly error: string | null;
  readonly working: boolean;
  readonly checked?: CheckoutStatus | Error;
  readonly checkedAgainst?: unknown;
}
interface Work {
  readonly epoch: number;
  readonly session: Session;
}
let sessionSequence = 0;
const NO_REQUESTS: RequestForQueries = {};
function initial(session: Session): State {
  return { session, loaded: false, recovery: null, error: null, working: false };
}

export function usePayment(options: PaymentOptions): CheckoutPayment {
  const auth = useAppAuth();
  const client = useConvex();
  const convexAuth = useConvexAuth();
  const available = usePaymentAvailability() === 'available';
  const profileAccess = resolveAccountAccess({
    isLoading: auth.isLoading,
    isSignedIn: auth.isSignedIn,
    syncFailed: auth.authSyncError !== null,
    user: auth.user,
  });
  const owner =
    profileAccess === 'ready' &&
    auth.authSyncError === null &&
    typeof auth.clerkUser?.id === 'string' &&
    auth.user?.clerkId === auth.clerkUser.id &&
    convexAuth.isAuthenticated &&
    !convexAuth.isLoading
      ? auth.clerkUser.id
      : null;
  const access: AccountAccessStatus =
    profileAccess !== 'ready' ? profileAccess : convexAuth.isLoading ? 'loading' : owner ? 'ready' : 'recovery';
  const lastResults = useRef<{ quote: unknown; status: unknown }>({ quote: undefined, status: undefined });
  const session = useMemo<Session>(
    () => ({
      owner,
      client,
      key: ++sessionSequence,
      staleQuote: lastResults.current.quote,
      staleStatus: lastResults.current.status,
    }),
    [owner, client, auth.user?._id],
  );
  const [stored, setStored] = useState<State>(() => initial(session));
  const state = stored.session === session ? stored : initial(session);
  if (stored.session !== session) setStored(state);
  const committed = useRef<Session | null>(null);
  const busy = useRef<Work | null>(null);
  const epoch = useRef(0);
  useLayoutEffect(() => {
    committed.current = session;
    return () => {
      if (committed.current === session) committed.current = null;
    };
  }, [session]);
  const current = useCallback(() => committed.current === session && session.owner !== null, [session]);
  const patch = useCallback(
    (update: Partial<State>): void => {
      if (current()) setStored((previous) => (previous.session === session ? { ...previous, ...update } : previous));
    },
    [current, session],
  );
  const selectorKey = JSON.stringify(options.selectors);
  const requests = useMemo<RequestForQueries>(
    () =>
      owner
        ? {
            ...(options.selectors
              ? { quote: { query: api.checkoutQuote.quoteCheckout, args: options.selectors } }
              : {}),
            ...(state.recovery
              ? {
                  status: { query: api.paymentReconciliation.getStatus, args: { requestId: state.recovery.requestId } },
                }
              : {}),
          }
        : NO_REQUESTS,
    [owner, selectorKey, state.recovery?.requestId],
  );
  const results = useQueries(requests);
  const liveQuote: CheckoutQuoteResult | Error | undefined = results.quote;
  const liveStatus: CheckoutStatus | Error | undefined = results.status;
  const quoteResult = owner && liveQuote !== session.staleQuote ? liveQuote : undefined;
  const quote = quoteResult && !(quoteResult instanceof Error) && quoteResult.ok ? quoteResult.quote : null;
  const freshStatus = owner && liveStatus !== session.staleStatus ? liveStatus : undefined;
  const status = state.checked !== undefined && state.checkedAgainst === liveStatus ? state.checked : freshStatus;
  const outcome = checkoutOutcome(state.recovery, status, state.proof);
  const fingerprint = JSON.stringify([
    selectorKey,
    options.kind,
    options.phone,
    options.operator,
    options.enabled,
    options.contextKey,
    quote?.quoteKey,
    quote?.inputIdentity,
    available,
  ]);
  const facts = useRef({ fingerprint, generation: 0 });
  const latest = useRef({ state, outcome, available, options, quote, status });
  useLayoutEffect(() => {
    if (facts.current.fingerprint !== fingerprint)
      facts.current = { fingerprint, generation: facts.current.generation + 1 };
    latest.current = { state, outcome, available, options, quote, status };
    lastResults.current = {
      quote: liveQuote === undefined ? lastResults.current.quote : liveQuote,
      status: liveStatus === undefined ? lastResults.current.status : liveStatus,
    };
  });
  useEffect(() => {
    if (!owner) return;
    void readCheckoutRecovery(AsyncStorage, owner).then(
      (recovery) => patch({ loaded: true, recovery }),
      () =>
        patch({
          error: 'Checkout recovery could not be read. Check storage or contact support; no new payment was sent.',
        }),
    );
  }, [owner, patch]);

  const renderedEpoch = epoch.current;
  const workCurrent = useCallback((work: Work): boolean => current() && epoch.current === work.epoch, [current]);
  const start = useCallback((): Work | null => {
    if (!current() || renderedEpoch !== epoch.current || busy.current?.session === session) return null;
    const work: Work = { epoch: ++epoch.current, session };
    busy.current = work;
    patch({ working: true, error: null });
    return work;
  }, [current, patch, renderedEpoch, session]);
  const finish = useCallback(
    (work: Work): void => {
      if (busy.current !== work) return;
      busy.current = null;
      if (workCurrent(work)) patch({ working: false });
    },
    [patch, workCurrent],
  );
  const retireWork = useCallback(
    (work: Work, update: Partial<State>): void => {
      if (!workCurrent(work) || busy.current !== work) return;
      epoch.current += 1;
      busy.current = null;
      patch({ ...update, working: false });
    },
    [patch, workCurrent],
  );
  const renderedGeneration = facts.current.generation + (facts.current.fingerprint === fingerprint ? 0 : 1);
  const cancelDraft = useCallback((): void => {
    if (!current() || renderedEpoch !== epoch.current) return;
    epoch.current += 1;
    busy.current = null;
    patch({ working: false, error: null });
  }, [current, patch, renderedEpoch]);
  const submit = useCallback(async (): Promise<void> => {
    const live = latest.current;
    if (
      !current() ||
      !owner ||
      !live.state.loaded ||
      live.state.recovery ||
      !live.available ||
      !live.options.enabled ||
      !live.quote ||
      !live.options.selectors ||
      facts.current.generation !== renderedGeneration ||
      facts.current.fingerprint !== fingerprint
    )
      return;
    // This Pay tap accepts only the quote and payment details from its committed render.
    const acceptedFacts = facts.current;
    const original = { ...live.options, selectors: live.options.selectors };
    const proof: CheckoutProof = { selectors: original.selectors, quote: live.quote };
    if (original.kind === 'checkout_collection' && (!checkoutPayerPhoneValid(original.phone) || !original.operator)) {
      patch({ error: 'Correct the Mobile Money number and select an operator, then tap Pay again.' });
      return;
    }
    const work = start();
    if (!work) return;
    const valid = (): boolean =>
      workCurrent(work) &&
      latest.current.available &&
      latest.current.options.enabled &&
      facts.current.generation === acceptedFacts.generation &&
      facts.current.fingerprint === acceptedFacts.fingerprint;
    let persisted = false;
    try {
      const requestIdentity = await digestStringAsync(
        CryptoDigestAlgorithm.SHA256,
        checkoutRequestDocument(
          auth.user?._id ?? '',
          original.kind,
          original.selectors,
          proof.quote.quoteKey,
          original.phone,
          original.operator,
        ),
      );
      if (!valid()) return;
      const ownedProof: CheckoutProof = { ...proof, requestIdentity };
      const claimed = await claimCheckoutRecovery(AsyncStorage, owner, original.kind, randomUUID, () =>
        workCurrent(work),
      );
      if (!current() || !claimed) return;
      persisted = true;
      // Publish retained identity even when the accepted quote retired during persistence. It is never silently replaced.
      patch({ recovery: claimed.recovery, proof: claimed.created ? ownedProof : undefined, checked: undefined });
      if (!claimed.created || !valid()) return;
      const args = {
        ...original.selectors,
        requestId: claimed.recovery.requestId,
        expectedQuoteKey: proof.quote.quoteKey,
      };
      const result =
        original.kind === 'wallet_purchase'
          ? await client.mutation(api.paymentOperations.purchaseWithWallet, args)
          : await client.action(api.checkoutCollection.initiateCheckoutCollection, {
              ...args,
              phone: original.phone ?? '',
              operator: original.operator ?? 'mtn',
            });
      if (!workCurrent(work)) return;
      if (
        result.ok === false &&
        result.code === 'quote_mismatch' &&
        result.quote &&
        typeof result.quote.quoteKey === 'string' &&
        result.quote.quoteKey.length > 0
      ) {
        await clearCheckoutRecovery(
          AsyncStorage,
          owner,
          claimed.recovery,
          () => workCurrent(work) && (latest.current.status === undefined || latest.current.status === null),
          () =>
            retireWork(work, {
              recovery: null,
              proof: undefined,
              checked: undefined,
              error: 'Quote changed. Review the updated quote, then tap Pay again.',
            }),
        );
      } else if (result.ok === true && 'requestIdentity' in result) {
        patch({ proof: { ...ownedProof, receipt: result } });
      }
    } catch {
      if (workCurrent(work))
        patch({
          loaded: persisted,
          error: 'The request could not be confirmed. Keep this recovery and check status before any new payment.',
        });
    } finally {
      finish(work);
    }
  }, [
    client,
    current,
    finish,
    fingerprint,
    owner,
    patch,
    renderedGeneration,
    retireWork,
    start,
    workCurrent,
    auth.user?._id,
  ]);

  const checkStatus = useCallback(async (): Promise<void> => {
    const recovery = latest.current.state.recovery;
    if (!recovery) return;
    const work = start();
    if (!work) return;
    const observed = lastResults.current.status;
    try {
      const checked = await client.action(api.paymentReconciliation.refresh, { requestId: recovery.requestId });
      if (!workCurrent(work)) return;
      if (lastResults.current.status === observed) patch({ checked, checkedAgainst: liveStatus });
    } catch {
      if (workCurrent(work)) patch({ error: 'Status could not be checked. The original request remains recoverable.' });
    } finally {
      finish(work);
    }
  }, [client, finish, liveStatus, patch, start, workCurrent]);
  const newSubmission = useCallback(async (): Promise<void> => {
    const recovery = state.recovery;
    const terminal = (): boolean =>
      current() &&
      latest.current.state.recovery?.requestId === recovery?.requestId &&
      (latest.current.outcome === 'completed' || latest.current.outcome === 'failed');
    if (!owner || !recovery || !terminal()) return;
    const work = start();
    if (!work) return;
    try {
      await clearCheckoutRecovery(
        AsyncStorage,
        owner,
        recovery,
        () => workCurrent(work) && terminal(),
        () => retireWork(work, { recovery: null, proof: undefined, checked: undefined, error: null }),
      );
    } catch {
      if (workCurrent(work))
        patch({ error: 'Recovery could not be cleared. Check storage or contact support before a new payment.' });
    } finally {
      finish(work);
    }
  }, [current, finish, owner, patch, retireWork, start, state.recovery, workCurrent]);
  // A deferred navigation/control callback must bind both session and work; same-owner ABA cannot revive it.
  const isCurrent = useCallback((): boolean => current() && renderedEpoch === epoch.current, [current, renderedEpoch]);
  const isCompleted = useCallback(
    (): boolean =>
      isCurrent() &&
      latest.current.state.recovery?.requestId === state.recovery?.requestId &&
      latest.current.outcome === 'completed',
    [isCurrent, state.recovery?.requestId],
  );
  return {
    access,
    isCompleted,
    sessionKey: session.key,
    isCurrent,
    ready: owner !== null && state.loaded,
    working: owner !== null && state.working,
    error: owner ? state.error : null,
    recovery: owner ? state.recovery : null,
    outcome,
    status: owner ? status : undefined,
    quote,
    quoteResult,
    submit,
    checkStatus,
    newSubmission,
    cancelDraft,
  };
}
/**
 * Get provider display name
 */
export function getProviderName(provider: MobileMoneyProvider): string {
  const names: Record<MobileMoneyProvider, string> = {
    mtn: 'MTN Mobile Money',
    airtel: 'Airtel Money',
    zamtel: 'Zamtel Kwacha',
  };
  return names[provider];
}

/**
 * Get provider color
 */
export function getProviderColor(provider: MobileMoneyProvider): string {
  const colors: Record<MobileMoneyProvider, string> = {
    mtn: '#FFCC00',
    airtel: '#ED1C24',
    zamtel: '#00A651',
  };
  return colors[provider];
}

/**
 * Format Zambian phone number
 */
export function formatZambianPhoneNumber(phone: string): string {
  // Remove all non-digits
  const digits = phone.replace(/\D/g, '');

  // If starts with 260, keep as is
  if (digits.startsWith('260')) {
    return digits;
  }

  // If starts with 0, replace with 260
  if (digits.startsWith('0')) {
    return '260' + digits.slice(1);
  }

  // Otherwise, assume it needs 260 prefix
  return '260' + digits;
}

/**
 * Detect mobile money provider from phone number
 */
export function detectProvider(phone: string): MobileMoneyProvider | null {
  const formatted = formatZambianPhoneNumber(phone);
  const prefix = formatted.slice(3, 5); // Get the 2 digits after 260

  // MTN prefixes: 96, 97
  if (['96', '97'].includes(prefix)) return 'mtn';

  // Airtel prefixes: 95, 77
  if (['95', '77'].includes(prefix)) return 'airtel';

  // Zamtel prefixes: 95 (some), 50, 51
  if (['50', '51'].includes(prefix)) return 'zamtel';

  return null;
}
