import type { FunctionReturnType } from 'convex/server';

import type { api } from '../../../../convex/_generated/api';

export type WalletOperationKind = 'top_up_collection' | 'withdrawal_transfer';
export interface WalletRecovery {
  readonly version: 1;
  readonly kind: WalletOperationKind;
  readonly requestId: string;
}

export interface RecoveryStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export type WalletStatus = FunctionReturnType<typeof api.paymentReconciliation.getStatus>;
export type WalletOutcome = 'unknown' | 'pending' | 'review' | 'completed' | 'failed';
export type PaymentAccount = FunctionReturnType<typeof api.providerOperations.listPaymentAccounts>[number];

// No floating point parsing or rounding: fractional cents and unsafe integers are rejected.
export function walletAmountCents(text: string): number | null {
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return cents > 0n && cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null;
}

// Stored balances allow zero, but otherwise must match the backend's strict canonical decimal conversion.
export function storedMajorAmountCents(value: number): number | null {
  if (!Number.isFinite(value) || value < 0) return null;
  if (value === 0) return 0;

  return walletAmountCents(String(value));
}

// Numeric-major SDK payloads must preserve every parsed cent, including at the safe-integer boundary.
export function positiveDecimalMajorAmount(text: string): number | null {
  const cents = walletAmountCents(text.trim());
  if (cents === null) return null;
  const major = cents / 100;

  return storedMajorAmountCents(major) === cents ? major : null;
}

export function walletOutcome(
  recovery: WalletRecovery | null,
  status: WalletStatus | Error | undefined,
): WalletOutcome {
  if (!recovery || status === null || status === undefined || status instanceof Error) return 'unknown';
  if (status.result === 'review') return 'review';
  if (status.requestId !== recovery.requestId || status.kind !== recovery.kind) return 'review';
  if (status.reviewNeeded || status.application === 'review') return 'review';
  if (status.application === 'applied' && status.accountingApplied) {
    if (status.status === 'succeeded' && status.providerStatus === 'successful') return 'completed';
    if ((status.status === 'failed' || status.status === 'cancelled') && status.providerStatus === 'failed')
      return 'failed';
    return 'review';
  }
  return status.providerStatus === 'pending' ? 'pending' : status.status === 'unknown' ? 'unknown' : 'pending';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function resolvedWalletAccount(value: unknown): value is PaymentAccount {
  if (!isRecord(value)) return false;
  const account = value;
  return (
    typeof account.accountId === 'string' &&
    account.accountId.trim().length > 0 &&
    typeof account.destinationKey === 'string' &&
    account.destinationKey.trim().length > 0 &&
    account.isVerified === true &&
    typeof account.providerResolvedAt === 'number' &&
    Number.isFinite(account.providerResolvedAt) &&
    account.providerResolvedAt >= 0 &&
    (account.accountName === null ||
      (typeof account.accountName === 'string' && account.accountName.trim().length > 0)) &&
    (account.type === 'mobile_money'
      ? typeof account.phone === 'string' &&
        account.phone.length > 0 &&
        typeof account.operator === 'string' &&
        ['airtel', 'mtn', 'zamtel'].includes(account.operator)
      : account.type === 'bank_account' &&
        typeof account.bankId === 'string' &&
        account.bankId.length > 0 &&
        typeof account.accountNumber === 'string' &&
        account.accountNumber.length > 0 &&
        (account.bankName === null || (typeof account.bankName === 'string' && account.bankName.trim().length > 0)))
  );
}

function recoveryKey(owner: string): string {
  return `@gettit/wallet-operation/v1/${encodeURIComponent(owner)}`;
}

function parseRecovery(raw: string | null): WalletRecovery | null {
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    value.version !== 1 ||
    !('kind' in value) ||
    (value.kind !== 'top_up_collection' && value.kind !== 'withdrawal_transfer') ||
    !('requestId' in value) ||
    typeof value.requestId !== 'string' ||
    !/^wallet_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.requestId) ||
    Object.keys(value).length !== 3
  )
    throw new Error('Stored wallet recovery needs support review. No new payment was sent.');
  return { version: 1, kind: value.kind, requestId: value.requestId };
}

// Serialize only this namespace, across mounted consumers. A delayed old write/remove cannot overtake a newer claim.
// This is local coordination; backend idempotency remains the financial authority.
const queues = new Map<string, Promise<unknown>>();
// A destructive native call may fail after deleting bytes. Keep the verified token until preservation succeeds.
// This hold survives mounted consumers in this process; it cannot certify native disk reliability after app restart.
const preservationHolds = new Map<string, WalletRecovery>();

async function preserveWalletRecovery(storage: RecoveryStorage, owner: string): Promise<void> {
  const held = preservationHolds.get(owner);
  if (!held) return;

  const stored = parseRecovery(await storage.getItem(recoveryKey(owner)));
  if (stored && (stored.requestId !== held.requestId || stored.kind !== held.kind)) {
    throw new Error('Wallet recovery storage changed. Contact support; no new payment was sent.');
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

export function readWalletRecovery(storage: RecoveryStorage, owner: string): Promise<WalletRecovery | null> {
  return serialized(owner, async () => {
    await preserveWalletRecovery(storage, owner);
    return parseRecovery(await storage.getItem(recoveryKey(owner)));
  });
}

export function claimWalletRecovery(
  storage: RecoveryStorage,
  owner: string,
  kind: WalletOperationKind,
  makeId: () => string,
  current: () => boolean,
): Promise<{ recovery: WalletRecovery; created: boolean } | null> {
  return serialized(owner, async () => {
    await preserveWalletRecovery(storage, owner);
    const existing = parseRecovery(await storage.getItem(recoveryKey(owner)));
    if (!current()) return null;
    if (existing) return { recovery: existing, created: false };
    const recovery: WalletRecovery = { version: 1, kind, requestId: `wallet_${makeId()}` };
    // Validate the generator before persisting; storage contains no intent payload or personal data.
    parseRecovery(JSON.stringify(recovery));
    await storage.setItem(recoveryKey(owner), JSON.stringify(recovery));
    return { recovery, created: true };
  });
}

export function clearWalletRecovery(
  storage: RecoveryStorage,
  owner: string,
  expected: WalletRecovery,
  current: () => boolean,
  onCleared: () => void = () => undefined,
): Promise<boolean> {
  return serialized(owner, async () => {
    await preserveWalletRecovery(storage, owner);
    const stored = parseRecovery(await storage.getItem(recoveryKey(owner)));
    if (!current() || stored?.requestId !== expected.requestId || stored.kind !== expected.kind) return false;

    preservationHolds.set(owner, stored);
    try {
      await storage.removeItem(recoveryKey(owner));
      if (!current()) {
        await preserveWalletRecovery(storage, owner);
        return false;
      }

      // Commit the caller's reset synchronously under the same guard/queue, without another promise gap.
      onCleared();
      preservationHolds.delete(owner);
      return true;
    } catch {
      await preserveWalletRecovery(storage, owner);
      throw new Error(
        'Wallet recovery could not be cleared. Check storage or contact support; no new payment was sent.',
      );
    }
  });
}
