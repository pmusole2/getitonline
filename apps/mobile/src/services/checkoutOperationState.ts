import type { FunctionArgs, FunctionReturnType } from 'convex/server';

import type { api } from '../../../../convex/_generated/api';
import type { RecoveryStorage } from './walletOperationState';

export type CheckoutSelectors = FunctionArgs<typeof api.checkoutQuote.quoteCheckout>;
export type CheckoutQuoteResult = FunctionReturnType<typeof api.checkoutQuote.quoteCheckout>;
export type CheckoutQuote = Extract<CheckoutQuoteResult, { ok: true }>['quote'];
export type CheckoutStatus = FunctionReturnType<typeof api.paymentReconciliation.getStatus>;
export type CheckoutKind = 'wallet_purchase' | 'checkout_collection';
export interface CheckoutRecovery {
  readonly version: 1;
  readonly kind: CheckoutKind;
  readonly requestId: string;
}
export interface CheckoutProof {
  readonly selectors: CheckoutSelectors;
  readonly quote: CheckoutQuote;
  readonly requestIdentity?: string;
  readonly receipt?: FunctionReturnType<typeof api.paymentOperations.purchaseWithWallet>;
}
export type CheckoutOutcome = 'unknown' | 'pending' | 'review' | 'completed' | 'failed';

// Matches the frozen collection producer's normalizePhone/isValidPhone contract: trim only, then test.
// Keep this local boundary in parity tests; the private provider transport is not an app dependency.
export function checkoutPayerPhoneValid(phone: string | undefined): boolean {
  return typeof phone === 'string' && /^[0-9+][0-9+ ]{4,31}$/.test(phone.trim());
}

export function checkoutPoints(text: string): number | null {
  if (text === '') return 0;
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// Mirrors the frozen producers' price-free request fingerprint for comparison only. Never sent as actor authority.
// Keys (including address) are explicitly ordered as stableStringify; tests compare both real producer builders.
export function checkoutRequestDocument(
  actorId: string,
  kind: CheckoutKind,
  selectors: CheckoutSelectors,
  quoteKey: string,
  phone?: string,
  operator?: FunctionArgs<typeof api.checkoutCollection.initiateCheckoutCollection>['operator'] | null,
): string {
  return JSON.stringify({
    actor: actorId,
    address: {
      city: selectors.shippingAddress.city.trim(),
      country: selectors.shippingAddress.country.trim(),
      phone: selectors.shippingAddress.phone.trim(),
      province: selectors.shippingAddress.province.trim(),
      street: selectors.shippingAddress.street.trim(),
    },
    ...(kind === 'checkout_collection' ? { country: 'zm' } : {}),
    ...(selectors.deliveryMethodId === undefined ? {} : { deliveryMethodId: selectors.deliveryMethodId }),
    ...(kind === 'checkout_collection' ? { expectedQuoteKey: quoteKey, kind } : {}),
    loyaltyPoints: selectors.loyaltyPoints ?? 0,
    ...(kind === 'checkout_collection' ? { operator } : {}),
    orderIds: [...(selectors.orderIds ?? [])].sort(),
    ...(kind === 'checkout_collection' ? { phone: phone?.trim() } : {}),
    ...(selectors.pickupPointId === undefined ? {} : { pickupPointId: selectors.pickupPointId }),
    ...(selectors.promoCode === undefined ? {} : { promoCode: selectors.promoCode.trim().toUpperCase() }),
    source: selectors.source,
  });
}

function sameOrders(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && [...left].sort().every((id, index) => id === [...right].sort()[index]);
}

export function checkoutOutcome(
  recovery: CheckoutRecovery | null,
  status: CheckoutStatus | Error | undefined,
  proof?: CheckoutProof,
): CheckoutOutcome {
  if (!recovery || status === null || status === undefined || status instanceof Error) return 'unknown';
  if (status.result !== 'found') return 'review';
  if (status.requestId !== recovery.requestId || status.kind !== recovery.kind) return 'review';
  if (status.reviewNeeded !== false || typeof status.accountingApplied !== 'boolean' || status.application === 'review')
    return 'review';
  if (
    typeof status.requestIdentity !== 'string' ||
    !status.requestIdentity.trim() ||
    typeof status.quoteKey !== 'string' ||
    !status.quoteKey.trim() ||
    (status.source !== 'cart' && status.source !== 'pending_orders') ||
    !Array.isArray(status.orderIds) ||
    !status.orderIds.length ||
    status.orderIds.some((id) => typeof id !== 'string' || !id) ||
    new Set(status.orderIds).size !== status.orderIds.length ||
    !Number.isSafeInteger(status.amountCents) ||
    status.amountCents < 0
  )
    return 'review';
  if (proof) {
    const receipt = proof.receipt;
    if (
      (proof.requestIdentity !== undefined && status.requestIdentity !== proof.requestIdentity) ||
      status.source !== proof.selectors.source ||
      status.quoteKey !== proof.quote.quoteKey ||
      status.amountCents !== proof.quote.totalAmountCents ||
      (proof.selectors.source === 'pending_orders' && !sameOrders(status.orderIds, proof.selectors.orderIds ?? [])) ||
      (receipt?.ok &&
        (status.requestIdentity !== receipt.requestIdentity ||
          status.operationId !== receipt.operationId ||
          !sameOrders(status.orderIds, receipt.orderIds)))
    )
      return 'review';
  }
  if (status.application === 'applied' && status.accountingApplied) {
    if (status.status === 'succeeded') return 'completed';
    if (status.status === 'failed' || status.status === 'cancelled') return 'failed';
    return 'review';
  }
  return status.status === 'unknown' ? 'unknown' : 'pending';
}

function recoveryKey(owner: string): string {
  return `@gettit/checkout-operation/v1/${encodeURIComponent(owner)}`;
}

function parseRecovery(raw: string | null): CheckoutRecovery | null {
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    value.version !== 1 ||
    !('kind' in value) ||
    (value.kind !== 'wallet_purchase' && value.kind !== 'checkout_collection') ||
    !('requestId' in value) ||
    typeof value.requestId !== 'string' ||
    !/^checkout_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.requestId) ||
    Object.keys(value).length !== 3
  )
    throw new Error('Stored checkout recovery needs support review. No new payment was sent.');
  return { version: 1, kind: value.kind, requestId: value.requestId };
}

// Serialize only this namespace, across mounted consumers. A delayed old write/remove cannot overtake a newer claim.
// This is local coordination; backend idempotency remains the financial authority.
const queues = new Map<string, Promise<unknown>>();
// A destructive native call may fail after deleting bytes. Keep the verified token until preservation succeeds.
// This hold survives mounted consumers in this process; it cannot certify native disk reliability after app restart.
const preservationHolds = new Map<string, CheckoutRecovery>();

async function preserveCheckoutRecovery(storage: RecoveryStorage, owner: string): Promise<void> {
  const held = preservationHolds.get(owner);
  if (!held) return;

  const stored = parseRecovery(await storage.getItem(recoveryKey(owner)));
  if (stored && (stored.requestId !== held.requestId || stored.kind !== held.kind)) {
    throw new Error('Checkout recovery storage changed. Contact support; no new payment was sent.');
  }

  if (!stored) await storage.setItem(recoveryKey(owner), JSON.stringify(held));
  preservationHolds.delete(owner);
}

function serialized<T>(owner: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(owner) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(work);
  queues.set(owner, result);
  void result
    .finally(() => {
      if (queues.get(owner) === result) queues.delete(owner);
    })
    .catch(() => undefined);
  return result;
}

export function readCheckoutRecovery(storage: RecoveryStorage, owner: string): Promise<CheckoutRecovery | null> {
  return serialized(owner, async () => {
    await preserveCheckoutRecovery(storage, owner);
    return parseRecovery(await storage.getItem(recoveryKey(owner)));
  });
}

export function claimCheckoutRecovery(
  storage: RecoveryStorage,
  owner: string,
  kind: CheckoutKind,
  makeId: () => string,
  current: () => boolean,
): Promise<{ recovery: CheckoutRecovery; created: boolean } | null> {
  return serialized(owner, async () => {
    await preserveCheckoutRecovery(storage, owner);
    const existing = parseRecovery(await storage.getItem(recoveryKey(owner)));
    if (!current()) return null;
    if (existing) return { recovery: existing, created: false };
    const recovery: CheckoutRecovery = { version: 1, kind, requestId: `checkout_${makeId()}` };
    // Validate the generator before persisting; storage contains no intent payload or personal data.
    parseRecovery(JSON.stringify(recovery));
    preservationHolds.set(owner, recovery);
    await storage.setItem(recoveryKey(owner), JSON.stringify(recovery));
    preservationHolds.delete(owner);
    return { recovery, created: true };
  });
}

export function clearCheckoutRecovery(
  storage: RecoveryStorage,
  owner: string,
  expected: CheckoutRecovery,
  current: () => boolean,
  onCleared: () => void = () => undefined,
): Promise<boolean> {
  return serialized(owner, async () => {
    await preserveCheckoutRecovery(storage, owner);
    const stored = parseRecovery(await storage.getItem(recoveryKey(owner)));
    if (!current() || stored?.requestId !== expected.requestId || stored.kind !== expected.kind) return false;

    preservationHolds.set(owner, stored);
    try {
      await storage.removeItem(recoveryKey(owner));
      if (!current()) {
        await preserveCheckoutRecovery(storage, owner);
        return false;
      }

      // Commit the caller's reset synchronously under the same guard/queue, without another promise gap.
      onCleared();
      preservationHolds.delete(owner);
      return true;
    } catch {
      await preserveCheckoutRecovery(storage, owner);
      throw new Error(
        'Checkout recovery could not be cleared. Check storage or contact support; no new payment was sent.',
      );
    }
  });
}
