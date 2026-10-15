"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useConvex, useQueries } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import {
  browserCheckoutStorage,
  checkoutStorageKey,
  createCheckoutRecord,
  isCheckoutSuccess,
  normalizeCheckoutSelectors,
  parseCheckoutRecord,
  walletBalanceCents,
  type CheckoutQuote,
  type CheckoutQuoteResult,
  type CheckoutRecord,
  type CheckoutSelectors,
  type CheckoutStatus,
  type CheckoutStorage,
  type ExpectedPurchase,
} from "@/lib/walletCheckoutState";

export interface WalletCheckoutOptions {
  // Supplied only by the ready, verified account gate. Both subject and profile belong in the owner key.
  owner: string | null;
  selectors: CheckoutSelectors | null;
  cartIdentity: string;
  mergeReady: boolean;
  available: boolean;
  balance: number | undefined;
  storage?: CheckoutStorage;
}

interface Retained {
  record: CheckoutRecord;
  raw: string;
  expected?: ExpectedPurchase;
}

interface RetirementHold {
  retained: Retained;
  work: object | null;
}

type RestorationOutcome = "restored" | "unresolved" | "conflict";
type RetirementOutcome = "retired" | RestorationOutcome;

// Preserve both the native acknowledgement gap and unresolved compensation across module-local
// remounts/owner changes. An idle hold can be reclaimed by explicit current-owner recovery.
// This is neither durable storage nor a cross-tab lock; it grants no purchase authority.
const retirementHolds = new Map<string, RetirementHold>();

interface View {
  loaded: boolean;
  blocked: boolean;
  busy: boolean;
  retained: Retained | null;
  error: string | null;
  outcome: "idle" | "held" | "success" | "mismatch";
  status: CheckoutStatus | undefined;
}

const EMPTY: View = {
  loaded: false,
  blocked: false,
  busy: false,
  retained: null,
  error: null,
  outcome: "idle",
  status: undefined,
};

interface Facts {
  token: object;
  binding: string;
  selectors: CheckoutSelectors | null;
  quote: CheckoutQuote | null;
  available: boolean;
  eligible: boolean;
}

interface Session {
  active: boolean;
  facts: Facts | null;
  work: object | null;
  retained: Retained | null;
  loaded: boolean;
  blocked: boolean;
  approval: Facts | null;
}

export interface WalletCheckoutState extends View {
  quote: CheckoutQuote | null;
  quoteError: string | null;
  approved: boolean;
  canApprove: boolean;
  canSubmit: boolean;
  approve(): void;
  submit(): Promise<void>;
  refresh(): Promise<void>;
}

export function useWalletCheckout(
  options: WalletCheckoutOptions,
): WalletCheckoutState {
  const convex = useConvex();
  const storage = options.storage ?? browserCheckoutStorage;
  const owner = options.owner;
  const key = owner ? checkoutStorageKey(owner) : null;
  const committed = useRef<Session | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [view, setView] = useState<View>(EMPTY);
  const [approval, setApproval] = useState<Facts | null>(null);
  const [replacement, setReplacement] = useState<{
    selection: string;
    previousKey: string;
    quote: CheckoutQuote;
  } | null>(null);
  const {
    street = "",
    city = "",
    province = "",
    country = "",
    phone = "",
  } = options.selectors?.shippingAddress ?? {};
  const { deliveryMethodId, pickupPointId, promoCode } =
    options.selectors ?? {};
  const hasSelectors = options.selectors !== null;
  const selectors = useMemo(
    () =>
      hasSelectors
        ? normalizeCheckoutSelectors({
            source: "cart",
            shippingAddress: { street, city, province, country, phone },
            deliveryMethodId,
            pickupPointId,
            promoCode,
          })
        : null,
    [
      hasSelectors,
      street,
      city,
      province,
      country,
      phone,
      deliveryMethodId,
      pickupPointId,
      promoCode,
    ],
  );
  const selection = JSON.stringify([
    selectors,
    options.cartIdentity,
    options.mergeReady,
  ]);
  const requests = useMemo(() => {
    const next: Parameters<typeof useQueries>[0] = {};
    if (owner && selectors && options.mergeReady) {
      next.quote = { query: api.checkoutQuote.quoteCheckout, args: selectors };
    }

    return next;
  }, [owner, selectors, options.mergeReady]);
  const results = useQueries(requests);
  const result: CheckoutQuoteResult | Error | undefined = results.quote;
  const liveQuote: CheckoutQuote | null =
    result && !(result instanceof Error) && result.ok === true
      ? result.quote
      : null;
  const quote =
    replacement?.selection === selection &&
    replacement.previousKey === liveQuote?.quoteKey
      ? replacement.quote
      : liveQuote;
  const balance = walletBalanceCents(options.balance);
  const eligible = Boolean(
    owner &&
    selectors &&
    options.mergeReady &&
    quote &&
    balance !== null &&
    balance >= quote.totalAmountCents,
  );
  const binding = JSON.stringify([selection, quote?.quoteKey ?? null]);
  const token = useMemo(
    () => ({ binding, available: options.available, eligible }),
    [binding, options.available, eligible],
  );
  const facts = useMemo<Facts>(
    () => ({
      token,
      binding,
      selectors,
      quote,
      available: options.available,
      eligible,
    }),
    [token, binding, selectors, quote, options.available, eligible],
  );

  // Ownership is published only at commit. Cleanup/setup always creates a new object, including StrictMode and ABA.
  useLayoutEffect(() => {
    const next: Session = {
      active: true,
      facts: null,
      work: null,
      retained: null,
      loaded: false,
      blocked: false,
      approval: null,
    };
    committed.current = next;
    setSession(next);
    setView(EMPTY);
    setApproval(null);
    setReplacement(null);

    return () => {
      next.active = false;
      next.approval = null;
      if (committed.current === next) {
        committed.current = null;
      }
    };
  }, [convex, owner, storage]);

  useLayoutEffect(() => {
    const current = committed.current;
    if (!current) {
      return;
    }

    if (
      current.facts?.token !== facts.token ||
      !facts.eligible ||
      !facts.available
    ) {
      current.approval = null;
      setApproval(null);
    }
    current.facts = facts;
  }, [facts, session, convex, owner, storage]);

  const current = useCallback((target: Session | null): target is Session => {
    return target !== null && target.active && committed.current === target;
  }, []);

  const owns = useCallback(
    (target: Session, work: object, retained: Retained): boolean => {
      return (
        current(target) && target.work === work && target.retained === retained
      );
    },
    [current],
  );

  const publish = useCallback(
    (target: Session, patch: Partial<View>): void => {
      if (current(target)) {
        setView((previous) =>
          current(target) ? { ...previous, ...patch } : previous,
        );
      }
    },
    [current],
  );

  // Compensation may outlive its session, but must still own the exact hold/work at every boundary.
  // Confirm the SAME token after writing; a returned host write alone does not prove restoration.
  const restore = useCallback(
    async (hold: RetirementHold, work: object): Promise<RestorationOutcome> => {
      const held = (): boolean =>
        key !== null && retirementHolds.get(key) === hold && hold.work === work;

      if (!key || !held()) {
        return "unresolved";
      }
      try {
        const raw = await storage.getItem(key);
        if (!held()) {
          return "unresolved";
        }
        if (raw !== null && raw !== hold.retained.raw) {
          return "conflict";
        }
        if (raw === null) {
          await storage.setItem(key, hold.retained.raw);
          if (!held()) {
            return "unresolved";
          }
        }
        const confirmed = await storage.getItem(key);
        if (!held()) {
          return "unresolved";
        }

        return confirmed === hold.retained.raw
          ? "restored"
          : confirmed === null
            ? "unresolved"
            : "conflict";
      } catch {
        return "unresolved";
      }
    },
    [key, storage],
  );

  const retire = useCallback(
    async (
      target: Session,
      work: object,
      retained: Retained,
      proof: boolean,
    ): Promise<RetirementOutcome> => {
      if (!key || !owns(target, work, retained)) {
        return "unresolved";
      }
      const previous = retirementHolds.get(key);
      if (
        previous &&
        (previous.retained !== retained || previous.work !== null)
      ) {
        return "unresolved";
      }
      const hold = previous ?? { retained, work: null };
      hold.work = work;
      retirementHolds.set(key, hold);
      const held = (): boolean =>
        retirementHolds.get(key) === hold && hold.work === work;
      const owned = (): boolean => held() && owns(target, work, retained);
      let outcome: RetirementOutcome = "unresolved";
      const compensate = async (): Promise<RestorationOutcome> => {
        outcome = await restore(hold, work);

        return outcome;
      };

      try {
        // A recovered hold with an empty slot must regain confirmed storage before retirement.
        // Null is not proof that the earlier native removal safely completed.
        const raw = await storage.getItem(key);
        if (!owned() || raw !== retained.raw) {
          outcome = await compensate();
          if (!owned() || outcome !== "restored") {
            return outcome;
          }
        }
        if (proof) {
          const before = await convex.query(
            api.paymentReconciliation.getStatus,
            {
              requestId: retained.record.requestId,
            },
          );
          if (
            !owned() ||
            !isCheckoutSuccess(before, retained.record, retained.expected)
          ) {
            if (owned()) {
              publish(target, { status: before });
            }

            return await compensate();
          }
        }

        // Re-read after proof: a newer identity must never be deleted or overwritten.
        const beforeRaw = await storage.getItem(key);
        if (!owned() || beforeRaw !== retained.raw) {
          return await compensate();
        }
        outcome = "unresolved";
        await storage.removeItem(key, retained.raw);
        if (!owned()) {
          return await compensate();
        }
        if (proof) {
          const after = await convex.query(
            api.paymentReconciliation.getStatus,
            {
              requestId: retained.record.requestId,
            },
          );
          if (
            !owned() ||
            !isCheckoutSuccess(after, retained.record, retained.expected)
          ) {
            if (owned()) {
              publish(target, { status: after });
            }

            return await compensate();
          }
        }
        const afterRaw = await storage.getItem(key);
        if (!owned() || afterRaw !== null) {
          return await compensate();
        }

        target.retained = null;
        target.approval = null;
        setApproval(null);
        publish(target, { retained: null, status: undefined });
        outcome = "retired";

        return outcome;
      } catch {
        return await compensate();
      } finally {
        if (held()) {
          if (outcome === "retired" || outcome === "restored") {
            retirementHolds.delete(key);
          } else {
            // Retain identity, release only the completed work claim so foreground recovery stays live.
            hold.work = null;
          }
        }
        if (owns(target, work, retained)) {
          publish(target, {
            outcome: "held",
            error:
              outcome === "conflict"
                ? "Checkout storage contains a different identity. Keep this checkout and contact support."
                : "Checkout retirement could not be verified. Keep this checkout and refresh or contact support.",
          });
        }
      }
    },
    [key, owns, storage, convex, restore, publish],
  );

  const observe = useCallback(
    async (
      target: Session,
      work: object,
      retained: Retained,
      refresh: boolean,
    ): Promise<void> => {
      try {
        const selector = { requestId: retained.record.requestId };
        const status = refresh
          ? await convex.action(api.paymentReconciliation.refresh, selector)
          : await convex.query(api.paymentReconciliation.getStatus, selector);
        if (!owns(target, work, retained)) {
          return;
        }

        publish(target, { status, outcome: "held", error: null });
        if (isCheckoutSuccess(status, retained.record, retained.expected)) {
          if (
            (await retire(target, work, retained, true)) === "retired" &&
            current(target) &&
            target.work === work
          ) {
            publish(target, { outcome: "success", error: null });
          }
        }
      } catch {
        if (owns(target, work, retained)) {
          publish(target, {
            outcome: "held",
            error:
              "Status could not be verified. Keep this checkout and refresh or contact support.",
          });
        }
      }
    },
    [convex, owns, publish, retire, current],
  );

  useEffect(() => {
    const target = committed.current;
    if (!target || !owner || !key) {
      return;
    }
    const work = {};
    target.work = work;

    void (async () => {
      try {
        // Publish the existing hold even if native reads now fail or a different token appears.
        // Neither host failure nor another raw identity resolves the original uncertain request.
        const held = retirementHolds.get(key);
        if (held) {
          target.retained = held.retained;
          publish(target, { retained: held.retained, outcome: "held" });
        }
        const raw = await storage.getItem(key);
        if (!current(target) || target.work !== work) {
          return;
        }
        const latestHold = retirementHolds.get(key);
        if (latestHold) {
          target.retained = latestHold.retained;
          publish(target, {
            retained: latestHold.retained,
            outcome: "held",
            error:
              raw !== null && raw !== latestHold.retained.raw
                ? "Checkout storage contains a different identity. Keep this checkout and contact support."
                : null,
          });
        } else if (raw !== null) {
          const record = parseCheckoutRecord(raw);
          if (!record) {
            throw new Error("invalid retained record");
          }

          const retained = { raw, record };
          target.retained = retained;
          publish(target, { retained, outcome: "held" });
          await observe(target, work, retained, false);
        }
        if (!current(target) || target.work !== work) {
          return;
        }
        target.loaded = true;
        publish(target, { loaded: true });
      } catch {
        if (!current(target) || target.work !== work) {
          return;
        }
        target.loaded = true;
        target.blocked = target.retained === null;
        publish(target, {
          blocked: target.blocked,
          error:
            "Secure checkout storage is unavailable or contains an invalid record. Contact support before paying.",
          loaded: true,
        });
      } finally {
        if (current(target) && target.work === work) {
          target.work = null;
          publish(target, { busy: false });
        }
      }
    })();
    // The session owns this one bounded recovery read; selectors/availability do not restart it.
  }, [convex, owner, storage, key, current, publish, observe]);

  function approve(): void {
    if (
      !current(session) ||
      session.facts?.token !== facts.token ||
      !facts.available ||
      !facts.eligible ||
      !session.loaded ||
      session.blocked ||
      session.retained ||
      session.work
    ) {
      return;
    }
    session.approval = facts;
    setApproval(facts);
    publish(session, { outcome: "idle", error: null });
  }

  async function submit(): Promise<void> {
    const target = session;
    if (
      !current(target) ||
      target.facts?.token !== facts.token ||
      target.approval?.token !== facts.token ||
      !facts.available ||
      !facts.eligible ||
      !facts.selectors ||
      !facts.quote ||
      !target.loaded ||
      target.blocked ||
      target.retained ||
      target.work ||
      !key ||
      retirementHolds.has(key)
    ) {
      return;
    }

    const work = {};
    target.work = work; // Claim synchronously before any storage/SDK boundary.
    publish(target, { busy: true, error: null });
    let retained: Retained | null = null;
    try {
      const record = createCheckoutRecord();
      retained = {
        record,
        raw: JSON.stringify(record),
        expected: { quoteKey: facts.quote.quoteKey },
      };
      const previous = await storage.getItem(key);
      if (!current(target) || target.work !== work) {
        return;
      }
      const latest = await storage.getItem(key);
      if (!current(target) || target.work !== work) {
        return;
      }
      if (previous !== null || latest !== null) {
        target.blocked = true;
        publish(target, {
          blocked: true,
          error:
            "A retained checkout already exists. Reload to observe it before paying.",
        });
        return;
      }
      target.retained = retained;
      publish(target, { retained, outcome: "held" });
      await storage.setItem(key, retained.raw);
      if (!owns(target, work, retained)) {
        return;
      }
      const persisted = await storage.getItem(key);
      if (!owns(target, work, retained)) {
        return;
      }
      if (persisted !== retained.raw) {
        throw new Error("persistence not confirmed");
      }
      // Styling and captured callbacks cannot authorize dispatch. Revalidate the actual committed approval.
      if (
        target.facts?.token !== facts.token ||
        target.approval?.token !== facts.token ||
        !target.facts.available ||
        !target.facts.eligible
      ) {
        return;
      }

      const result = await convex.mutation(
        api.paymentOperations.purchaseWithWallet,
        {
          ...facts.selectors,
          requestId: record.requestId,
          expectedQuoteKey: facts.quote.quoteKey,
        },
      );
      if (!owns(target, work, retained)) {
        return;
      }
      target.approval = null;
      setApproval(null);
      if (!result.ok) {
        if (
          (await retire(target, work, retained, false)) === "retired" &&
          current(target) &&
          target.work === work
        ) {
          if (target.facts?.token !== facts.token) {
            return;
          }
          setReplacement({
            selection,
            previousKey: facts.quote.quoteKey,
            quote: result.quote,
          });
          publish(target, {
            outcome: "mismatch",
            error:
              "The quote changed. Review the current quote and explicitly approve again.",
          });
        }
        return;
      }
      retained.expected = {
        quoteKey: facts.quote.quoteKey,
        operationId: result.operationId,
        orderIds: result.orderIds,
      };
      // Initiation is never accounting proof, even when its status says succeeded.
      await observe(target, work, retained, false);
    } catch {
      if (!current(target) || target.work !== work) {
        return;
      }
      target.approval = null;
      setApproval(null);
      if (retained && target.retained === retained) {
        publish(target, {
          error:
            "Checkout is retained. Its outcome is not yet verified; refresh or contact support.",
          outcome: "held",
        });
      } else {
        target.blocked = true;
        publish(target, {
          blocked: true,
          error:
            "Secure randomness or storage is unavailable. No purchase was sent.",
        });
      }
    } finally {
      if (current(target) && target.work === work) {
        target.work = null;
        publish(target, { busy: false });
      }
    }
  }

  async function refresh(): Promise<void> {
    const target = session;
    if (!current(target) || target.work || !target.retained) {
      return;
    }
    const retained = target.retained;
    const work = {};
    target.work = work;
    publish(target, { busy: true });
    try {
      await observe(target, work, retained, true);
    } finally {
      if (current(target) && target.work === work) {
        target.work = null;
        publish(target, { busy: false });
      }
    }
  }

  const approved =
    approval !== null &&
    approval.token === facts.token &&
    options.available &&
    eligible;
  const canApprove =
    view.loaded &&
    !view.busy &&
    !view.retained &&
    !view.blocked &&
    eligible &&
    options.available;
  const quoteError =
    result instanceof Error
      ? "Quote could not be loaded. Correct your selections or try again later."
      : result && !result.ok
        ? `Quote unavailable (${result.code}). Correct the address, delivery or selected promo code.`
        : null;

  return {
    quote,
    quoteError,
    approved,
    canApprove,
    canSubmit: approved && canApprove,
    approve,
    submit,
    refresh,
    ...view,
  };
}
