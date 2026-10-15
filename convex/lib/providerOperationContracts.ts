import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { isLosslessStoredMajorCents } from "./catalogMoney";
import { checkoutQuoteValidator, sha256Hex, stableStringify, type CheckoutQuote } from "./checkoutQuote";
import {
  isPositiveSafeCents,
  isSupportedOperator,
  isValidPhone,
  isValidProviderId,
  isValidReference,
} from "./lencoAdapter";

// Typed provider request/identity/receipt and safe owner projections.
// Task4A financial proof contracts are separate; checkout stays evidence-only.
// The wallet_purchase branch keeps its own request contracts.

export const PROVIDER_CURRENCY = "ZMW";
export const PROVIDER_COUNTRY = "zm";

export const TOP_UP_REFERENCE_PREFIX = "TOP-";
export const WITHDRAWAL_MM_REFERENCE_PREFIX = "WDR-MM-";
export const WITHDRAWAL_BANK_REFERENCE_PREFIX = "WDR-BK-";
export const CHECKOUT_REFERENCE_PREFIX = "TXN-";

export const zambiaOperatorValidator = v.union(v.literal("airtel"), v.literal("mtn"), v.literal("zamtel"));

export type ZambiaOperatorName = "airtel" | "mtn" | "zamtel";

// The payer destination for a top-up collection: explicit Zambian mobile
// money facts. The country is server-fixed, never caller authority.
export const collectionDestinationValidator = v.object({
  phone: v.string(),
  operator: zambiaOperatorValidator,
  country: v.literal("zm"),
});

export type CollectionDestinationFacts = {
  phone: string;
  operator: ZambiaOperatorName;
  country: "zm";
};

const mmWithdrawalDestinationValidator = v.object({
  phone: v.string(),
  operator: zambiaOperatorValidator,
  country: v.literal("zm"),
});

const bankWithdrawalDestinationValidator = v.object({
  bankId: v.string(),
  accountNumber: v.string(),
  country: v.literal("zm"),
});

// The frozen payout destination for a withdrawal: either resolved mobile
// money or a directory-resolved bank account. The bankId is the provider
// directory id, never a bankCode alias.
export const withdrawalDestinationValidator = v.union(
  mmWithdrawalDestinationValidator,
  bankWithdrawalDestinationValidator
);

export type WithdrawalDestinationFacts =
  | { phone: string; operator: ZambiaOperatorName; country: "zm" }
  | { bankId: string; accountNumber: string; country: "zm" };

export const providerReceiptStatusValidator = v.union(
  v.literal("successful"),
  v.literal("failed"),
  v.literal("pending")
);

// Complete typed collection receipt facts, mirroring the accepted adapter
// CollectionReceipt exactly: kind, id, nullable reference, minor amounts,
// currency/status, collection type/country/bearer/operator/phone, and
// failure/settlement markers. No raw payload, no unchecked JSON.
export const collectionReceiptValidator = v.object({
  kind: v.literal("collection"),
  id: v.string(),
  reference: v.union(v.string(), v.null()),
  amountMinor: v.number(),
  feeMinor: v.union(v.number(), v.null()),
  currency: v.literal("ZMW"),
  status: providerReceiptStatusValidator,
  collectionType: v.literal("mobile-money"),
  country: v.literal("zm"),
  bearer: v.literal("merchant"),
  operator: zambiaOperatorValidator,
  phone: v.string(),
  reasonForFailure: v.union(v.string(), v.null()),
  settlementStatus: v.union(v.string(), v.null()),
});

export const transferDestinationValidator = v.union(
  v.object({
    kind: v.literal("mobile-money"),
    phone: v.string(),
    operator: zambiaOperatorValidator,
    country: v.union(v.literal("zm"), v.null()),
  }),
  v.object({
    kind: v.literal("bank-account"),
    bankId: v.string(),
    accountNumber: v.string(),
    country: v.literal("zm"),
  })
);

// Complete typed transfer receipt facts, mirroring the accepted adapter
// TransferReceipt exactly. A null GET mobile-money country is stored only
// under the adapter's documented rule; initiation matching still requires
// the frozen "zm" destination and is never a wildcard.
export const transferReceiptValidator = v.object({
  kind: v.literal("transfer"),
  id: v.string(),
  reference: v.union(v.string(), v.null()),
  amountMinor: v.number(),
  feeMinor: v.number(),
  currency: v.literal("ZMW"),
  status: providerReceiptStatusValidator,
  transferType: v.union(v.literal("mobile-money"), v.literal("bank-account")),
  debitAccountId: v.string(),
  destination: transferDestinationValidator,
  reasonForFailure: v.union(v.string(), v.null()),
  settlementStatus: v.union(v.string(), v.null()),
});

export const providerReceiptValidator = v.union(collectionReceiptValidator, transferReceiptValidator);

export type ProviderReceiptFacts =
  | {
      kind: "collection";
      id: string;
      reference: string | null;
      amountMinor: number;
      feeMinor: number | null;
      currency: "ZMW";
      status: "successful" | "failed" | "pending";
      collectionType: "mobile-money";
      country: "zm";
      bearer: "merchant";
      operator: ZambiaOperatorName;
      phone: string;
      reasonForFailure: string | null;
      settlementStatus: string | null;
    }
  | {
      kind: "transfer";
      id: string;
      reference: string | null;
      amountMinor: number;
      feeMinor: number;
      currency: "ZMW";
      status: "successful" | "failed" | "pending";
      transferType: "mobile-money" | "bank-account";
      debitAccountId: string;
      destination:
        | { kind: "mobile-money"; phone: string; operator: ZambiaOperatorName; country: "zm" | null }
        | { kind: "bank-account"; bankId: string; accountNumber: string; country: "zm" };
      reasonForFailure: string | null;
      settlementStatus: string | null;
    };

// Only the consumed provider branches exist in this slice: top-up and
// withdrawal (Task3B1) plus the checkout collection (Task3B2). Settlement,
// refund, webhook, and client-cutover fields live nowhere here.
export const providerOperationKindValidator = v.union(
  v.literal("top_up_collection"),
  v.literal("withdrawal_transfer"),
  v.literal("checkout_collection")
);

export type ProviderOperationKind = "top_up_collection" | "withdrawal_transfer" | "checkout_collection";

// The full lifecycle states are typed so later settlement can consume them.
// Terminal top-up/withdrawal labels require reciprocal Task4A accounting.
// Checkout remains evidence-only until Task4B.
export const providerOperationStatusValidator = v.union(
  v.literal("reserved"),
  v.literal("attempted"),
  v.literal("unknown"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("cancelled")
);

export type ProviderOperationStatus = "reserved" | "attempted" | "unknown" | "succeeded" | "failed" | "cancelled";

// Public top-up args: an account-scoped request id plus the owner-selected
// amount and payer mobile-money facts. No userId, provider reference,
// status, fee, or debit-account authority exists on this input.
export const topUpRequestValidator = v.object({
  requestId: v.string(),
  amountCents: v.number(),
  phone: v.string(),
  operator: zambiaOperatorValidator,
});

export type TopUpRequestArgs = {
  requestId: string;
  amountCents: number;
  phone: string;
  operator: ZambiaOperatorName;
};

// Public withdrawal args: an account-scoped request id, the owner-selected
// amount, the owned resolved account selector, and the REQUIRED approved
// destination key the owner confirmed. No amounts from the client beyond the
// selected cents, and no debit-config or provider-status authority.
export const withdrawalRequestValidator = v.object({
  requestId: v.string(),
  amountCents: v.number(),
  paymentAccountId: v.id("paymentAccounts"),
  expectedDestinationKey: v.string(),
});

export type WithdrawalRequestArgs = {
  requestId: string;
  amountCents: number;
  paymentAccountId: Id<"paymentAccounts">;
  expectedDestinationKey: string;
};

// Public registration args: a root object with a nested discriminated
// mobile-money or bank destination. The caller can never set accountName,
// isVerified, owner, or debit facts: names are provider-resolved display only.
export const registerPaymentAccountValidator = v.object({
  destination: v.union(
    v.object({ type: v.literal("mobile_money"), phone: v.string(), operator: zambiaOperatorValidator }),
    v.object({ type: v.literal("bank_account"), bankId: v.string(), accountNumber: v.string() })
  ),
});

export type RegisterPaymentAccountArgs = {
  destination:
    | { type: "mobile_money"; phone: string; operator: ZambiaOperatorName }
    | { type: "bank_account"; bankId: string; accountNumber: string };
};

export const providerInitiateSuccessValidator = v.object({
  ok: v.literal(true),
  operationId: v.id("paymentOperations"),
  status: providerOperationStatusValidator,
  providerReference: v.string(),
});

export type ProviderInitiateSuccess = {
  ok: true;
  operationId: Id<"paymentOperations">;
  status: ProviderOperationStatus;
  providerReference: string;
};

// A destination mismatch recovers with the current owned key and zero
// writes, so the owner can review and re-approve the correct destination.
export const providerInitiateMismatchValidator = v.object({
  ok: v.literal(false),
  code: v.literal("destination_mismatch"),
  destinationKey: v.string(),
});

export const providerInitiateResultValidator = v.union(
  providerInitiateSuccessValidator,
  providerInitiateMismatchValidator
);

export type ProviderInitiateResult =
  | ProviderInitiateSuccess
  | { ok: false; code: "destination_mismatch"; destinationKey: string };

// Discriminated frozen-claim payloads for the single authorized POST. The
// mayPost:true edge carries exactly the frozen collection or withdrawal
// destination already on the row: transport consumes these facts with no
// invented operator/phone/account fallbacks. An unexpected variant fails
// safely at the action boundary with the claimed operation retained.
export const claimedTopUpResultValidator = v.object({
  mayPost: v.literal(true),
  kind: v.literal("top_up_collection"),
  operationId: v.id("paymentOperations"),
  providerReference: v.string(),
  amountCents: v.number(),
  collectionDestination: collectionDestinationValidator,
});

export const claimedWithdrawalResultValidator = v.object({
  mayPost: v.literal(true),
  kind: v.literal("withdrawal_transfer"),
  operationId: v.id("paymentOperations"),
  providerReference: v.string(),
  amountCents: v.number(),
  withdrawalDestination: withdrawalDestinationValidator,
});

export type ClaimedTopUpResult = {
  mayPost: true;
  kind: "top_up_collection";
  operationId: Id<"paymentOperations">;
  providerReference: string;
  amountCents: number;
  collectionDestination: CollectionDestinationFacts;
};

export type ClaimedWithdrawalResult = {
  mayPost: true;
  kind: "withdrawal_transfer";
  operationId: Id<"paymentOperations">;
  providerReference: string;
  amountCents: number;
  withdrawalDestination: WithdrawalDestinationFacts;
};

// Owner-only safe projection for provider operations. Exact cents, the
// immutable provider reference, and ledger links only: never raw receipts,
// config, addresses, or cross-account facts.
export const providerStatusProjectionValidator = v.object({
  operationId: v.id("paymentOperations"),
  kind: providerOperationKindValidator,
  status: providerOperationStatusValidator,
  amountCents: v.number(),
  providerReference: v.string(),
  destinationKey: v.string(),
  walletTransactionId: v.optional(v.id("walletTransactions")),
  transactionId: v.optional(v.id("transactions")),
  application: v.union(v.literal("pending"), v.literal("applied"), v.literal("evidence_only")),
  createdAt: v.number(),
});

export type ProviderStatusProjection = {
  operationId: Id<"paymentOperations">;
  kind: ProviderOperationKind;
  status: ProviderOperationStatus;
  amountCents: number;
  providerReference: string;
  destinationKey: string;
  walletTransactionId?: Id<"walletTransactions">;
  transactionId?: Id<"transactions">;
  application: "pending" | "applied" | "evidence_only";
  createdAt: number;
};

const mmAccountProjectionValidator = v.object({
  accountId: v.id("paymentAccounts"),
  type: v.literal("mobile_money"),
  destinationKey: v.string(),
  phone: v.string(),
  operator: zambiaOperatorValidator,
  accountName: v.union(v.string(), v.null()),
  isVerified: v.boolean(),
  providerResolvedAt: v.union(v.number(), v.null()),
});

const bankAccountProjectionValidator = v.object({
  accountId: v.id("paymentAccounts"),
  type: v.literal("bank_account"),
  destinationKey: v.string(),
  bankId: v.string(),
  bankName: v.union(v.string(), v.null()),
  accountNumber: v.string(),
  accountName: v.union(v.string(), v.null()),
  isVerified: v.boolean(),
  providerResolvedAt: v.union(v.number(), v.null()),
});

// Public account projections reveal only the owner's required
// display/approval facts, never credentials or provider secrets.
export const paymentAccountProjectionValidator = v.union(mmAccountProjectionValidator, bankAccountProjectionValidator);

export type PaymentAccountProjection =
  | {
      accountId: Id<"paymentAccounts">;
      type: "mobile_money";
      destinationKey: string;
      phone: string;
      operator: ZambiaOperatorName;
      accountName: string | null;
      isVerified: boolean;
      providerResolvedAt: number | null;
    }
  | {
      accountId: Id<"paymentAccounts">;
      type: "bank_account";
      destinationKey: string;
      bankId: string;
      bankName: string | null;
      accountNumber: string;
      accountName: string | null;
      isVerified: boolean;
      providerResolvedAt: number | null;
    };

export const PROVIDER_ERROR_CODES = [
  "not_started",
  "payments_disabled",
  "invalid_amount",
  "invalid_request",
  "invalid_destination",
  "destination_mismatch",
  "destination_changed",
  "account_not_found",
  "account_unverified",
  "resolution_failed",
  "conflicting_reuse",
  "review_needed",
  "wallet_missing",
  "wallet_inactive",
  "wallet_frozen",
  "wallet_malformed",
  "wallet_duplicate",
  "insufficient_funds",
  "quote_mismatch",
  "order_overlap",
  "evidence_review",
  "promo_invalid",
  "loyalty_invalid",
  "order_not_owned",
  "order_not_pending",
  "unavailable",
  "malformed_catalog",
  "malformed_money",
  "empty",
  "insufficient_stock",
  "invalid_variant",
  "invalid_addon",
  "invalid_delivery",
  "invalid_pickup",
  "self_purchase",
] as const;

export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

export type ProviderErrorData = {
  code: ProviderErrorCode;
  message: string;
};

export const providerErrorDataValidator = v.object({
  code: v.string(),
  message: v.string(),
});

export function isProviderErrorData(value: { code: string; message: string }): value is ProviderErrorData {
  return (PROVIDER_ERROR_CODES as ReadonlyArray<string>).includes(value.code);
}

export function isProviderErrorCode(code: string): code is ProviderErrorCode {
  return (PROVIDER_ERROR_CODES as ReadonlyArray<string>).includes(code);
}

// Typed application-error payload carried across the SDK boundary, matching
// the wallet slice pattern: plain server errors are redacted in production
// deployments, while ConvexError data is preserved.
export class OperationError extends ConvexError<ProviderErrorData> {
  readonly code: ProviderErrorCode;

  constructor(code: ProviderErrorCode, message?: string) {
    const resolved = message ?? code;
    super({ code, message: resolved });
    this.name = "OperationError";
    this.code = code;
  }
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export function normalizeRequestId(requestId: string): string {
  const trimmed = requestId.trim();
  if (!REQUEST_ID_PATTERN.test(trimmed)) {
    throw new OperationError(
      "invalid_request",
      "A request id of 1-128 letters, numbers, dots, dashes, or underscores is required."
    );
  }
  return trimmed;
}

export function normalizePhone(phone: string): string {
  const trimmed = phone.trim();
  if (!isValidPhone(trimmed)) {
    throw new OperationError("invalid_destination", "A valid Zambian mobile number is required.");
  }
  return trimmed;
}

export function normalizeOperator(operator: string): ZambiaOperatorName {
  if (!isSupportedOperator(operator)) {
    throw new OperationError("invalid_destination", "A supported Zambian operator is required.");
  }
  return operator;
}

// Owner-selected cents are legitimate input for top-up/withdrawal, but they
// must be positive safe integers that survive the round trip to stored and
// provider numeric majors with no cent loss.
export function validateProviderAmount(amountCents: number): number {
  if (!isPositiveSafeCents(amountCents) || !isLosslessStoredMajorCents(amountCents)) {
    throw new OperationError("invalid_amount", "An exact positive amount that round-trips losslessly is required.");
  }
  return amountCents;
}

// The approval key is computed from the actual authoritative destination,
// never from display names or cached values, so a client cannot change the
// destination or debit config through the key.
export function destinationKeyForMm(phone: string, operator: ZambiaOperatorName): string {
  return `mm:zm:${operator}:${normalizePhone(phone)}`;
}

export function destinationKeyForBank(bankId: string, accountNumber: string): string {
  const normalizedBankId = bankId.trim();
  const normalizedAccount = accountNumber.trim();
  if (normalizedBankId === "" || normalizedAccount === "") {
    throw new OperationError("invalid_destination", "A directory bank and account number are required.");
  }
  return `bank:zm:${normalizedBankId}:${normalizedAccount}`;
}

// Static price-free request identity for top-up: the verified actor plus the
// immutable kind, amount, and payer destination. Stored beside the operation
// so a reused request id with different inputs rejects as conflicting.
export async function buildTopUpRequestIdentity(input: {
  actorId: string;
  amountCents: number;
  phone: string;
  operator: ZambiaOperatorName;
}): Promise<string> {
  return sha256Hex(
    stableStringify({
      actor: input.actorId,
      kind: "top_up_collection",
      amountCents: input.amountCents,
      phone: normalizePhone(input.phone),
      operator: normalizeOperator(input.operator),
      country: PROVIDER_COUNTRY,
    })
  );
}

// Static price-free request identity for withdrawal: the verified actor plus
// the immutable kind, amount, account selector, and the original approved
// destination key.
export async function buildWithdrawalRequestIdentity(input: {
  actorId: string;
  amountCents: number;
  paymentAccountId: string;
  expectedDestinationKey: string;
}): Promise<string> {
  const key = input.expectedDestinationKey.trim();
  if (key === "") {
    throw new OperationError("invalid_request", "An approved destination key is required for withdrawal.");
  }
  return sha256Hex(
    stableStringify({
      actor: input.actorId,
      kind: "withdrawal_transfer",
      amountCents: input.amountCents,
      paymentAccountId: input.paymentAccountId,
      destinationKey: key,
    })
  );
}

function randomSuffix(): string {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `${timestamp}${random}`;
}

// Provider references carry no sensitive identifiers: a kind prefix plus a
// timestamp/random suffix. Uniqueness is enforced by indexed lookup before
// writes, not by randomness alone.
export function generateTopUpReference(): string {
  return `${TOP_UP_REFERENCE_PREFIX}${randomSuffix()}`;
}

export function generateWithdrawalReference(destination: "mobile_money" | "bank_account"): string {
  const prefix = destination === "mobile_money" ? WITHDRAWAL_MM_REFERENCE_PREFIX : WITHDRAWAL_BANK_REFERENCE_PREFIX;
  return `${prefix}${randomSuffix()}`;
}

export function isValidTopUpReference(reference: string): boolean {
  return reference.startsWith(TOP_UP_REFERENCE_PREFIX) && isValidReference(reference);
}

export function isValidWithdrawalReference(reference: string): boolean {
  const prefixed =
    reference.startsWith(WITHDRAWAL_MM_REFERENCE_PREFIX) || reference.startsWith(WITHDRAWAL_BANK_REFERENCE_PREFIX);
  return prefixed && isValidReference(reference);
}

export function isValidDebitAccountId(value: string): boolean {
  return isValidProviderId(value);
}

// Public checkout-collection args: an account-scoped request id plus the
// purchase selectors (mirroring purchaseRequestValidator) with a REQUIRED
// expected quote key, plus the payer mobile-money facts. No userId,
// sellerId, actor, amount, price, fee, status, or config authority exists on
// this input. Server country is zm, currency ZMW.
export const checkoutCollectionRequestValidator = v.object({
  requestId: v.string(),
  source: v.union(v.literal("cart"), v.literal("pending_orders")),
  orderIds: v.optional(v.array(v.id("orders"))),
  deliveryMethodId: v.optional(v.id("deliveryMethods")),
  pickupPointId: v.optional(v.id("pickupPoints")),
  shippingAddress: v.object({
    street: v.string(),
    city: v.string(),
    province: v.string(),
    country: v.string(),
    phone: v.string(),
  }),
  promoCode: v.optional(v.string()),
  loyaltyPoints: v.optional(v.number()),
  expectedQuoteKey: v.string(),
  phone: v.string(),
  operator: zambiaOperatorValidator,
});

export type CheckoutCollectionRequestArgs = {
  requestId: string;
  source: "cart" | "pending_orders";
  orderIds?: Array<Id<"orders">>;
  deliveryMethodId?: Id<"deliveryMethods">;
  pickupPointId?: Id<"pickupPoints">;
  shippingAddress: {
    street: string;
    city: string;
    province: string;
    country: string;
    phone: string;
  };
  promoCode?: string;
  loyaltyPoints?: number;
  expectedQuoteKey: string;
  phone: string;
  operator: ZambiaOperatorName;
};

export type NormalizedCheckoutCollectionRequest = {
  requestId: string;
  source: "cart" | "pending_orders";
  orderIds: Array<Id<"orders">> | undefined;
  deliveryMethodId: Id<"deliveryMethods"> | undefined;
  pickupPointId: Id<"pickupPoints"> | undefined;
  shippingAddress: {
    street: string;
    city: string;
    province: string;
    country: string;
    phone: string;
  };
  promoCode: string | undefined;
  loyaltyPoints: number | undefined;
  expectedQuoteKey: string;
  phone: string;
  operator: ZambiaOperatorName;
};

// Normalizes static checkout selectors exactly the way the quote prices
// them: trimmed addresses, uppercased promo codes, defaulted points, sorted
// order selectors, and a normalized payer destination. Dynamic cart contents
// stay out: the same request must still recover after its cart rows are
// captured and removed.
export function normalizeCheckoutCollectionRequest(
  args: CheckoutCollectionRequestArgs
): NormalizedCheckoutCollectionRequest {
  const requestId = normalizeRequestId(args.requestId);
  if (typeof args.expectedQuoteKey !== "string" || args.expectedQuoteKey === "") {
    throw new OperationError("invalid_request", "An expected quote key is required for checkout.");
  }
  return {
    requestId,
    source: args.source,
    orderIds: args.orderIds === undefined ? undefined : [...args.orderIds].sort(),
    deliveryMethodId: args.deliveryMethodId,
    pickupPointId: args.pickupPointId,
    shippingAddress: {
      street: args.shippingAddress.street.trim(),
      city: args.shippingAddress.city.trim(),
      province: args.shippingAddress.province.trim(),
      country: args.shippingAddress.country.trim(),
      phone: args.shippingAddress.phone.trim(),
    },
    promoCode: args.promoCode === undefined ? undefined : args.promoCode.trim().toUpperCase(),
    loyaltyPoints: args.loyaltyPoints,
    expectedQuoteKey: args.expectedQuoteKey,
    phone: normalizePhone(args.phone),
    operator: normalizeOperator(args.operator),
  };
}

// Static price-free request identity for a checkout collection: the verified
// actor plus the immutable kind, selectors, approved quote key, and
// normalized payer destination. No prices, no dynamic cart contents.
export async function buildCheckoutRequestIdentity(input: {
  actorId: string;
  request: NormalizedCheckoutCollectionRequest;
}): Promise<string> {
  return sha256Hex(
    stableStringify({
      actor: input.actorId,
      kind: "checkout_collection",
      source: input.request.source,
      orderIds: input.request.orderIds ?? [],
      ...(input.request.deliveryMethodId === undefined ? {} : { deliveryMethodId: input.request.deliveryMethodId }),
      ...(input.request.pickupPointId === undefined ? {} : { pickupPointId: input.request.pickupPointId }),
      address: {
        street: input.request.shippingAddress.street,
        city: input.request.shippingAddress.city,
        province: input.request.shippingAddress.province,
        country: input.request.shippingAddress.country,
        phone: input.request.shippingAddress.phone,
      },
      ...(input.request.promoCode === undefined ? {} : { promoCode: input.request.promoCode }),
      loyaltyPoints: input.request.loyaltyPoints ?? 0,
      expectedQuoteKey: input.request.expectedQuoteKey,
      phone: input.request.phone,
      operator: input.request.operator,
      country: PROVIDER_COUNTRY,
    })
  );
}

// Checkout provider references carry the TXN- prefix. Uniqueness is enforced
// by indexed lookup before writes, not by randomness alone.
export function generateCheckoutReference(): string {
  return `${CHECKOUT_REFERENCE_PREFIX}${randomSuffix()}`;
}

export function isValidCheckoutReference(reference: string): boolean {
  return reference.startsWith(CHECKOUT_REFERENCE_PREFIX) && isValidReference(reference);
}

// Discriminated frozen-claim payload for the single authorized checkout
// POST. The mayPost:true edge carries exactly the frozen collection
// destination already on the row: transport consumes these facts with no
// invented operator/phone fallbacks.
export const claimedCheckoutResultValidator = v.object({
  mayPost: v.literal(true),
  kind: v.literal("checkout_collection"),
  operationId: v.id("paymentOperations"),
  providerReference: v.string(),
  amountCents: v.number(),
  collectionDestination: collectionDestinationValidator,
});

export type ClaimedCheckoutResult = {
  mayPost: true;
  kind: "checkout_collection";
  operationId: Id<"paymentOperations">;
  providerReference: string;
  amountCents: number;
  collectionDestination: CollectionDestinationFacts;
};

// A stale expected key recovers with the fresh owned quote and zero writes,
// mirroring the read-only quote query contract.
export const checkoutMismatchValidator = v.object({
  ok: v.literal(false),
  code: v.literal("quote_mismatch"),
  quote: checkoutQuoteValidator,
});

export type CheckoutMismatch = {
  ok: false;
  code: "quote_mismatch";
  quote: CheckoutQuote;
};

export const checkoutInitiateResultValidator = v.union(providerInitiateSuccessValidator, checkoutMismatchValidator);

export type CheckoutInitiateResult = ProviderInitiateSuccess | CheckoutMismatch;
