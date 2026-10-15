import type { FunctionArgs, FunctionReturnType } from "convex/server";
import type { api } from "../../../../convex/_generated/api";

export type CheckoutSelectors = Pick<
  FunctionArgs<typeof api.checkoutQuote.quoteCheckout>,
  "shippingAddress" | "deliveryMethodId" | "pickupPointId" | "promoCode"
> & { source: "cart" };
export type CheckoutQuoteResult = FunctionReturnType<
  typeof api.checkoutQuote.quoteCheckout
>;
export type CheckoutQuote = Extract<
  FunctionReturnType<typeof api.checkoutQuote.quoteCheckout>,
  { ok: true }
>["quote"];
export type CheckoutStatus = FunctionReturnType<
  typeof api.paymentReconciliation.getStatus
>;
export type PurchaseResult = FunctionReturnType<
  typeof api.paymentOperations.purchaseWithWallet
>;

export interface CheckoutRecord {
  version: 1;
  kind: "wallet_purchase";
  requestId: string;
}

// Native Storage is synchronous. Awaiting this boundary also supports hosts that defer persistence;
// callers must revalidate committed ownership after every boundary, including a synchronous host.
export interface CheckoutStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string, expectedRaw: string): void | Promise<void>;
}

export const browserCheckoutStorage: CheckoutStorage = {
  getItem: (key) => window.localStorage.getItem(key),
  setItem: (key, value) => {
    const storage = window.localStorage;
    const previous = storage.getItem(key);
    if (previous !== null && previous !== value) {
      throw new Error("Retained checkout identity changed");
    }
    storage.setItem(key, value);
  },
  removeItem: (key, expectedRaw) => {
    const storage = window.localStorage;
    if (storage.getItem(key) !== expectedRaw) {
      throw new Error("Retained checkout identity changed");
    }
    storage.removeItem(key);
  },
};

export function checkoutStorageKey(owner: string): string {
  return `@gettit/web-wallet-checkout/v1/${encodeURIComponent(owner)}`;
}

export function parseCheckoutRecord(raw: string): CheckoutRecord | null {
  try {
    const value: unknown = JSON.parse(raw);

    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    if (Object.keys(value).sort().join(",") !== "kind,requestId,version") {
      return null;
    }
    if (
      !("version" in value) ||
      value.version !== 1 ||
      !("kind" in value) ||
      value.kind !== "wallet_purchase"
    ) {
      return null;
    }
    if (
      !("requestId" in value) ||
      typeof value.requestId !== "string" ||
      !/^checkout_[A-Za-z0-9._-]{1,119}$/.test(value.requestId)
    ) {
      return null;
    }

    return { version: 1, kind: "wallet_purchase", requestId: value.requestId };
  } catch {
    return null;
  }
}

export function createCheckoutRecord(): CheckoutRecord {
  // Never substitute Math.random, timestamps, or a counter for secure randomness.
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  const random = Array.from(bytes, (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");

  return {
    version: 1,
    kind: "wallet_purchase",
    requestId: `checkout_${random}`,
  };
}

export function normalizeCheckoutSelectors(
  value: CheckoutSelectors | null,
): CheckoutSelectors | null {
  if (!value) {
    return null;
  }

  const shippingAddress = {
    street: value.shippingAddress.street.trim(),
    city: value.shippingAddress.city.trim(),
    province: value.shippingAddress.province.trim(),
    country: value.shippingAddress.country.trim(),
    phone: value.shippingAddress.phone.trim(),
  };

  if (Object.values(shippingAddress).some((field) => field.length === 0)) {
    return null;
  }

  return {
    source: "cart",
    shippingAddress,
    ...(value.deliveryMethodId
      ? { deliveryMethodId: value.deliveryMethodId }
      : {}),
    ...(value.pickupPointId ? { pickupPointId: value.pickupPointId } : {}),
    ...(value.promoCode?.trim() ? { promoCode: value.promoCode.trim() } : {}),
  };
}

// Same strict decimal policy as stored catalogue/wallet money: no rounding of a third decimal,
// exponent expansion, or floating major*100. Concatenating decimal digits preserves exact cents in ES2017.
export function walletBalanceCents(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }

  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) {
    return null;
  }

  const cents = Number(`${match[1]}${(match[2] ?? "").padEnd(2, "0")}`);

  return Number.isSafeInteger(cents) ? cents : null;
}

export interface ExpectedPurchase {
  quoteKey: string;
  operationId?: Extract<PurchaseResult, { ok: true }>["operationId"];
  orderIds?: Extract<PurchaseResult, { ok: true }>["orderIds"];
}

export function isCheckoutSuccess(
  status: CheckoutStatus,
  record: CheckoutRecord,
  expected?: ExpectedPurchase,
): boolean {
  if (
    !status ||
    status.result !== "found" ||
    status.reviewNeeded ||
    status.application === "review"
  ) {
    return false;
  }
  if (
    status.requestId !== record.requestId ||
    status.kind !== "wallet_purchase" ||
    status.source !== "cart"
  ) {
    return false;
  }
  if (
    status.status !== "succeeded" ||
    status.application !== "applied" ||
    !status.accountingApplied
  ) {
    return false;
  }
  if (
    !status.quoteKey ||
    status.orderIds.length === 0 ||
    new Set(status.orderIds).size !== status.orderIds.length
  ) {
    return false;
  }
  if (expected && status.quoteKey !== expected.quoteKey) {
    return false;
  }
  if (expected?.operationId && status.operationId !== expected.operationId) {
    return false;
  }
  if (
    expected?.orderIds &&
    JSON.stringify([...status.orderIds].sort()) !==
      JSON.stringify([...expected.orderIds].sort())
  ) {
    return false;
  }

  return true;
}
