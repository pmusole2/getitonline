import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { action, internalMutation, internalQuery, query } from "./_generated/server";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";
import { requireUser } from "./lib/auth";
import { armFinancialPolling } from "./lib/paymentPolling";
import { centsToStoredMajor, majorNumberToCents } from "./lib/catalogMoney";
import { createLencoAdapter, isValidProviderId, type LencoFetch, type TransferReceipt } from "./lib/lencoAdapter";
import {
  buildTopUpRequestIdentity,
  buildWithdrawalRequestIdentity,
  claimedTopUpResultValidator,
  claimedWithdrawalResultValidator,
  destinationKeyForBank,
  destinationKeyForMm,
  generateTopUpReference,
  generateWithdrawalReference,
  isValidTopUpReference,
  isValidWithdrawalReference,
  normalizeOperator,
  normalizePhone,
  normalizeRequestId,
  OperationError,
  paymentAccountProjectionValidator,
  providerInitiateResultValidator,
  providerOperationKindValidator,
  providerOperationStatusValidator,
  providerReceiptValidator,
  providerStatusProjectionValidator,
  registerPaymentAccountValidator,
  topUpRequestValidator,
  validateProviderAmount,
  withdrawalRequestValidator,
  zambiaOperatorValidator,
  PROVIDER_CURRENCY,
  type ClaimedTopUpResult,
  type ClaimedWithdrawalResult,
  type CollectionDestinationFacts,
  type ProviderInitiateResult,
  type ProviderInitiateSuccess,
  type ProviderOperationKind,
  type ProviderReceiptFacts,
  type WithdrawalDestinationFacts,
  type ZambiaOperatorName,
} from "./lib/providerOperationContracts";
import { receiptMatchesIntent, retainReceiptEvidence } from "./lib/providerReceiptEvidence";
import { validateCheckoutAccounting } from "./lib/checkoutSettlement";
import { validateProviderAccounting } from "./providerSettlement";

// Verified-owner top-up and withdrawal initiation (Task3B1). Provider
// transport lives in actions; every durable decision lives in an
// authenticated internal mutation. One POST is authorized only by the single
// persist-and-claim edge inside the creating mutation; every reuse,
// ambiguity, timeout, or mismatch retains the reservation and never posts
// again. Trusted terminal receipts enter the single Task4A accounting writer.
// Checkout attachment remains evidence-only until Task4B.

export type ProviderDeps = {
  env: () => Record<string, string | undefined>;
  fetchImpl?: LencoFetch;
};

type ProviderActionCtx = Pick<ActionCtx, "auth" | "runQuery" | "runMutation">;

type ProviderOperation = Doc<"paymentOperations">;

type TopUpOperation = Extract<ProviderOperation, { kind: "top_up_collection" }>;
type WithdrawalOperation = Extract<ProviderOperation, { kind: "withdrawal_transfer" }>;
type CheckoutOperation = Extract<ProviderOperation, { kind: "checkout_collection" }>;
type ProviderBranch = TopUpOperation | WithdrawalOperation | CheckoutOperation;

function isProviderBranch(operation: ProviderOperation): operation is ProviderBranch {
  return (
    operation.kind === "top_up_collection" ||
    operation.kind === "withdrawal_transfer" ||
    operation.kind === "checkout_collection"
  );
}

async function assertSafeProviderOutcome(ctx: QueryCtx | MutationCtx, operation: ProviderBranch): Promise<void> {
  if (operation.kind === "checkout_collection") {
    // Task4B consumed proof: a bare terminal label, missing marker, or held
    // review without complete capture/release accounting never authorizes a
    // new financial interpretation.
    if (
      operation.reviewNeeded === true ||
      operation.status === "succeeded" ||
      operation.status === "failed" ||
      operation.status === "cancelled" ||
      operation.accounting !== undefined
    ) {
      if (!(await validateCheckoutAccounting(ctx, operation))) {
        throw new OperationError("review_needed", "This payment needs accounting review.");
      }
    }
    return;
  }
  if (
    operation.reviewNeeded === true ||
    ((operation.status === "succeeded" ||
      operation.status === "failed" ||
      operation.status === "cancelled" ||
      operation.accounting !== undefined) &&
      !(await validateProviderAccounting(ctx, operation)))
  ) {
    throw new OperationError("review_needed", "This payment needs accounting review.");
  }
}

function generateWalletDisplayReference(): string {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `WLT-${timestamp}-${random}`;
}

function centsToMajorOrThrow(cents: number): number {
  const major = centsToStoredMajor(cents);
  if (major === null) {
    throw new OperationError("invalid_amount", "An amount that round-trips losslessly is required.");
  }
  return major;
}

function readServerConfig(env: Record<string, string | undefined>): {
  apiKey: string;
  debitAccountId?: string;
  baseUrl?: string;
} {
  // Server-only configuration. Values are never logged, never returned, and
  // never pass through function arguments: only the constructed adapter sees
  // the key, and only the validated debit-account id reaches storage.
  const config: { apiKey: string; debitAccountId?: string; baseUrl?: string } = {
    apiKey: env["LENCO_API_KEY"] ?? "",
  };
  const debitAccountId = env["LENCO_ACCOUNT_ID"];
  if (debitAccountId !== undefined) {
    config.debitAccountId = debitAccountId;
  }
  const baseUrl = env["LENCO_BASE_URL"];
  if (baseUrl !== undefined) {
    config.baseUrl = baseUrl;
  }
  return config;
}

async function loadPaymentsSwitch(ctx: QueryCtx | MutationCtx): Promise<boolean> {
  const config = await ctx.db
    .query("appConfig")
    .withIndex("by_key", (q) => q.eq("key", "singleton"))
    .first();
  return config?.paymentsEnabled === true;
}

async function loadExistingRequest(
  ctx: QueryCtx | MutationCtx,
  ownerId: Id<"users">,
  requestId: string
): Promise<ProviderOperation[]> {
  return await ctx.db
    .query("paymentOperations")
    .withIndex("by_owner_request", (q) => q.eq("ownerId", ownerId).eq("requestId", requestId))
    .collect();
}

async function allocateTopUpReference(ctx: MutationCtx): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const reference = generateTopUpReference();
    if (!isValidTopUpReference(reference)) {
      continue;
    }
    const collision = await ctx.db
      .query("paymentOperations")
      .withIndex("by_provider_reference", (q) => q.eq("providerReference", reference))
      .first();
    if (collision === null) {
      return reference;
    }
  }
  throw new OperationError("review_needed", "This request needs review before a reference can be issued.");
}

async function allocateWithdrawalReference(
  ctx: MutationCtx,
  destination: "mobile_money" | "bank_account"
): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const reference = generateWithdrawalReference(destination);
    if (!isValidWithdrawalReference(reference)) {
      continue;
    }
    const collision = await ctx.db
      .query("paymentOperations")
      .withIndex("by_provider_reference", (q) => q.eq("providerReference", reference))
      .first();
    if (collision === null) {
      return reference;
    }
  }
  throw new OperationError("review_needed", "This request needs review before a reference can be issued.");
}

// The current approval key from the account's authoritative destination
// facts, never from display names or cached values. Returns null when the
// row lacks the facts a withdrawal requires.
function currentKeyOfAccount(account: Doc<"paymentAccounts">): string | null {
  if (account.type === "mobile_money") {
    if (account.mobileMoneyProvider === undefined || account.mobileNumber === undefined) {
      return null;
    }
    if (
      account.mobileMoneyProvider !== "airtel" &&
      account.mobileMoneyProvider !== "mtn" &&
      account.mobileMoneyProvider !== "zamtel"
    ) {
      return null;
    }
    return destinationKeyForMm(account.mobileNumber, account.mobileMoneyProvider);
  }
  if (account.bankId === undefined || account.accountNumber === undefined) {
    return null;
  }
  return destinationKeyForBank(account.bankId, account.accountNumber);
}

function frozenDestinationOfAccount(account: Doc<"paymentAccounts">): WithdrawalDestinationFacts | null {
  if (account.type === "mobile_money") {
    if (account.mobileMoneyProvider === undefined || account.mobileNumber === undefined) {
      return null;
    }
    const provider = account.mobileMoneyProvider;
    if (provider !== "airtel" && provider !== "mtn" && provider !== "zamtel") {
      return null;
    }
    return { phone: account.mobileNumber.trim(), operator: provider, country: "zm" };
  }
  if (account.bankId === undefined || account.accountNumber === undefined) {
    return null;
  }
  return { bankId: account.bankId.trim(), accountNumber: account.accountNumber.trim(), country: "zm" };
}

async function loadOwnedResolvedAccount(
  ctx: MutationCtx,
  actorId: Id<"users">,
  paymentAccountId: Id<"paymentAccounts">
): Promise<Doc<"paymentAccounts">> {
  const account = await ctx.db.get(paymentAccountId);
  if (!account || account.userId !== actorId) {
    throw new OperationError("account_not_found", "The selected payout account was not found.");
  }
  // Server resolution is the only usable marker. The legacy verified flag
  // alone never substitutes for it, and resolution never proves external
  // ownership: it only proves the provider resolved these facts.
  if (!account.isVerified || account.providerResolvedAt === undefined) {
    throw new OperationError("account_unverified", "The selected payout account needs server resolution first.");
  }
  return account;
}

type WalletCheck = {
  wallet: Doc<"wallets">;
  balanceCents: number;
  newBalanceCents: number;
  newBalanceMajor: number;
  newTotalWithdrawnMajor: number;
};

// Exact withdrawal reservation facts. The user debit equals the requested
// cents; a provider fee is receipt evidence only and never an extra debit.
// pendingBalance, totalSpent, and totalEarned are unchanged by withdrawals.
async function checkWithdrawalWallet(
  ctx: MutationCtx,
  actorId: Id<"users">,
  amountCents: number
): Promise<WalletCheck> {
  const wallets = await ctx.db
    .query("wallets")
    .withIndex("by_user", (q) => q.eq("userId", actorId))
    .collect();
  if (wallets.length > 1) {
    throw new OperationError("wallet_duplicate", "The wallet needs review before withdrawal.");
  }
  const wallet = wallets[0];
  if (!wallet) {
    throw new OperationError("wallet_missing", "No wallet exists for the signed-in owner.");
  }
  if (!wallet.isActive) {
    throw new OperationError("wallet_inactive", "The wallet is not active.");
  }
  if (wallet.isFrozen) {
    throw new OperationError("wallet_frozen", "The wallet is frozen.");
  }
  const balanceCents = majorNumberToCents(wallet.balance);
  const withdrawnCents = majorNumberToCents(wallet.totalWithdrawn);
  if (balanceCents === null || withdrawnCents === null) {
    throw new OperationError("wallet_malformed", "The wallet holds an amount that cannot be represented exactly.");
  }
  if (balanceCents < amountCents) {
    throw new OperationError("insufficient_funds", "The wallet balance does not cover this withdrawal.");
  }
  const newBalanceCents = balanceCents - amountCents;
  const newTotalWithdrawnCents = withdrawnCents + amountCents;
  const newBalanceMajor = centsToStoredMajor(newBalanceCents);
  const newTotalWithdrawnMajor = centsToStoredMajor(newTotalWithdrawnCents);
  if (newBalanceMajor === null || newTotalWithdrawnMajor === null) {
    throw new OperationError("wallet_malformed", "The wallet balance cannot be represented exactly.");
  }
  return { wallet, balanceCents, newBalanceCents, newBalanceMajor, newTotalWithdrawnMajor };
}

// A top-up moves no wallet money in this slice, but a frozen, inactive, or
// duplicated wallet denies initiation. An absent wallet is permitted without
// creating it here: legitimate first funding is credited by Task4.
async function checkTopUpWallet(ctx: MutationCtx, actorId: Id<"users">): Promise<void> {
  const wallets = await ctx.db
    .query("wallets")
    .withIndex("by_user", (q) => q.eq("userId", actorId))
    .collect();
  if (wallets.length > 1) {
    throw new OperationError("wallet_duplicate", "The wallet needs review before top-up.");
  }
  const wallet = wallets[0];
  if (!wallet) {
    return;
  }
  if (!wallet.isActive) {
    throw new OperationError("wallet_inactive", "The wallet is not active.");
  }
  if (wallet.isFrozen) {
    throw new OperationError("wallet_frozen", "The wallet is frozen.");
  }
}

// Stores only the adapter's typed receipt facts. Raw provider payloads never
// reach storage; this maps each known field explicitly instead of spreading.
function toStoredCollectionReceipt(receipt: {
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
}): ProviderReceiptFacts {
  return {
    kind: "collection",
    id: receipt.id,
    reference: receipt.reference,
    amountMinor: receipt.amountMinor,
    feeMinor: receipt.feeMinor,
    currency: PROVIDER_CURRENCY,
    status: receipt.status,
    collectionType: "mobile-money",
    country: "zm",
    bearer: "merchant",
    operator: receipt.operator,
    phone: receipt.phone,
    reasonForFailure: receipt.reasonForFailure,
    settlementStatus: receipt.settlementStatus,
  };
}

function toStoredTransferReceipt(receipt: TransferReceipt): ProviderReceiptFacts {
  const destination =
    receipt.destination.kind === "mobile-money"
      ? {
          kind: "mobile-money" as const,
          phone: receipt.destination.phone,
          operator: receipt.destination.operator as ZambiaOperatorName,
          country: receipt.destination.country,
        }
      : {
          kind: "bank-account" as const,
          bankId: receipt.destination.bankId,
          accountNumber: receipt.destination.accountNumber,
          country: "zm" as const,
        };
  return {
    kind: "transfer",
    id: receipt.id,
    reference: receipt.reference,
    amountMinor: receipt.amountMinor,
    feeMinor: receipt.feeMinor,
    currency: PROVIDER_CURRENCY,
    status: receipt.status,
    transferType: receipt.transferType,
    debitAccountId: receipt.debitAccountId,
    destination,
    reasonForFailure: receipt.reasonForFailure,
    settlementStatus: receipt.settlementStatus,
  };
}

const recoveryProjectionValidator = v.object({
  operationId: v.id("paymentOperations"),
  kind: providerOperationKindValidator,
  status: providerOperationStatusValidator,
  providerReference: v.string(),
});

type RecoveryProjection = {
  operationId: Id<"paymentOperations">;
  kind: ProviderOperationKind;
  status: "reserved" | "attempted" | "unknown" | "succeeded" | "failed" | "cancelled";
  providerReference: string;
};

const persistClaimResultValidator = v.union(
  claimedTopUpResultValidator,
  claimedWithdrawalResultValidator,
  v.object({
    mayPost: v.literal(false),
    operationId: v.id("paymentOperations"),
    status: providerOperationStatusValidator,
    providerReference: v.string(),
  }),
  v.object({
    ok: v.literal(false),
    code: v.literal("destination_mismatch"),
    destinationKey: v.string(),
  })
);

type PersistClaimResult =
  | ClaimedTopUpResult
  | ClaimedWithdrawalResult
  | {
      mayPost: false;
      operationId: Id<"paymentOperations">;
      status: RecoveryProjection["status"];
      providerReference: string;
    }
  | { ok: false; code: "destination_mismatch"; destinationKey: string };

function isDestinationMismatch(result: PersistClaimResult): result is Extract<PersistClaimResult, { ok: false }> {
  return "ok" in result && result.ok === false;
}

// The action obtains its actor through this authenticated internal query,
// never through database access in the action context or a borrowed uid.
export const resolveActor = internalQuery({
  args: {},
  returns: v.object({ userId: v.id("users") }),
  handler: async (ctx): Promise<{ userId: Id<"users"> }> => {
    const actor = await requireUser(ctx);
    return { userId: actor._id };
  },
});

// Account-scoped recovery: the immutable request is looked up before any
// wallet, account, config, or switch read. A matching request returns its
// stored status with no new write; a conflicting kind or identity rejects;
// duplicate rows fail to review.
export const recoverProviderRequest = internalQuery({
  args: {
    requestId: v.string(),
    kind: providerOperationKindValidator,
    requestIdentity: v.string(),
  },
  returns: v.union(recoveryProjectionValidator, v.null()),
  handler: async (ctx, args): Promise<RecoveryProjection | null> => {
    const actor = await requireUser(ctx);
    const requestId = normalizeRequestId(args.requestId);
    const existing = await loadExistingRequest(ctx, actor._id, requestId);
    if (existing.length > 1) {
      throw new OperationError("review_needed", "This request has duplicate records to review.");
    }
    const previous = existing[0];
    if (previous === undefined) {
      return null;
    }
    if (previous.kind === "wallet_purchase" || previous.kind !== args.kind) {
      throw new OperationError("conflicting_reuse", "This request id is already used with different inputs.");
    }
    if (previous.requestIdentity !== args.requestIdentity) {
      throw new OperationError("conflicting_reuse", "This request id is already used with different inputs.");
    }
    await assertSafeProviderOutcome(ctx, previous);
    return {
      operationId: previous._id,
      kind: previous.kind,
      status: previous.status,
      providerReference: previous.providerReference,
    };
  },
});

// One atomic top-up persist-and-claim. All business checks run before the
// first write; the reserved-to-attempted edge inside this mutation is the
// only transition that authorizes mayPost:true. A lost race against an
// identical concurrent request returns the stored row with mayPost:false
// instead of inserting a duplicate.
export const persistAndClaimTopUp = internalMutation({
  args: {
    expectedUserId: v.id("users"),
    requestId: v.string(),
    requestIdentity: v.string(),
    amountCents: v.number(),
    phone: v.string(),
    operator: zambiaOperatorValidator,
  },
  returns: persistClaimResultValidator,
  handler: async (ctx, args): Promise<PersistClaimResult> => {
    const actor = await requireUser(ctx);
    if (actor._id !== args.expectedUserId) {
      throw new Error("Unauthorized");
    }
    const requestId = normalizeRequestId(args.requestId);
    const amountCents = validateProviderAmount(args.amountCents);
    const phone = normalizePhone(args.phone);
    const operator = normalizeOperator(args.operator);

    const existing = await loadExistingRequest(ctx, actor._id, requestId);
    if (existing.length > 1) {
      throw new OperationError("review_needed", "This request has duplicate records to review.");
    }
    const previous = existing[0];
    if (previous !== undefined) {
      if (
        !isProviderBranch(previous) ||
        previous.kind !== "top_up_collection" ||
        previous.requestIdentity !== args.requestIdentity
      ) {
        throw new OperationError("conflicting_reuse", "This request id is already used with different inputs.");
      }
      await assertSafeProviderOutcome(ctx, previous);
      return {
        mayPost: false,
        operationId: previous._id,
        status: previous.status,
        providerReference: previous.providerReference,
      };
    }

    if (!(await loadPaymentsSwitch(ctx))) {
      throw new OperationError("payments_disabled", "Payments are currently disabled.");
    }
    await checkTopUpWallet(ctx, actor._id);

    const providerReference = await allocateTopUpReference(ctx);
    const destinationKey = destinationKeyForMm(phone, operator);
    const destination: CollectionDestinationFacts = { phone, operator, country: "zm" };
    const now = Date.now();
    const amountMajor = centsToMajorOrThrow(amountCents);

    // ---- First write below. Everything above denied before writing. ----
    const operationId = await ctx.db.insert("paymentOperations", {
      ownerId: actor._id,
      requestId,
      kind: "top_up_collection",
      status: "reserved",
      requestIdentity: args.requestIdentity,
      providerReference,
      amountCents,
      currency: PROVIDER_CURRENCY,
      destinationKey,
      collectionDestination: destination,
      createdAt: now,
      updatedAt: now,
    });
    // The linked pending collection companion carries the TOP provider
    // reference, exact majors, currency, and owner. No wallet credit, order,
    // escrow, or stock write happens in this slice.
    const companionId = await ctx.db.insert("transactions", {
      userId: actor._id,
      reference: providerReference,
      type: "collection",
      paymentMethod: "mobile_money",
      mobileMoneyProvider: operator,
      mobileNumber: phone,
      amount: amountMajor,
      currency: PROVIDER_CURRENCY,
      status: "pending",
      description: "Mobile-money top-up collection.",
      metadata: { operationId, topUp: true },
      operationId,
      initiatedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(operationId, { transactionId: companionId, updatedAt: now });
    await ctx.db.patch(operationId, { status: "attempted", attemptedAt: now, updatedAt: now });
    await armFinancialPolling(ctx, operationId);

    return {
      mayPost: true,
      operationId,
      kind: "top_up_collection",
      providerReference,
      amountCents,
      collectionDestination: destination,
    };
  },
});

// One atomic withdrawal persist, debit, and claim. The pending debit equals
// the requested cents exactly; the provider fee stays receipt evidence and
// never becomes an extra debit. The WLT ledger reference is a display
// reference distinct from the immutable WDR provider reference.
export const persistAndClaimWithdrawal = internalMutation({
  args: {
    expectedUserId: v.id("users"),
    requestId: v.string(),
    requestIdentity: v.string(),
    amountCents: v.number(),
    paymentAccountId: v.id("paymentAccounts"),
    expectedDestinationKey: v.string(),
    configuredDebitAccountId: v.string(),
  },
  returns: persistClaimResultValidator,
  handler: async (ctx, args): Promise<PersistClaimResult> => {
    const actor = await requireUser(ctx);
    if (actor._id !== args.expectedUserId) {
      throw new Error("Unauthorized");
    }
    const requestId = normalizeRequestId(args.requestId);
    const amountCents = validateProviderAmount(args.amountCents);
    if (!isValidProviderId(args.configuredDebitAccountId)) {
      throw new OperationError("not_started", "The provider transfer configuration is missing.");
    }

    const existing = await loadExistingRequest(ctx, actor._id, requestId);
    if (existing.length > 1) {
      throw new OperationError("review_needed", "This request has duplicate records to review.");
    }
    const previous = existing[0];
    if (previous !== undefined) {
      if (
        !isProviderBranch(previous) ||
        previous.kind !== "withdrawal_transfer" ||
        previous.requestIdentity !== args.requestIdentity
      ) {
        throw new OperationError("conflicting_reuse", "This request id is already used with different inputs.");
      }
      await assertSafeProviderOutcome(ctx, previous);
      return {
        mayPost: false,
        operationId: previous._id,
        status: previous.status,
        providerReference: previous.providerReference,
      };
    }

    if (!(await loadPaymentsSwitch(ctx))) {
      throw new OperationError("payments_disabled", "Payments are currently disabled.");
    }
    const account = await loadOwnedResolvedAccount(ctx, actor._id, args.paymentAccountId);
    const destination = frozenDestinationOfAccount(account);
    if (destination === null) {
      throw new OperationError("account_unverified", "The selected payout account needs server resolution first.");
    }
    const currentKey = currentKeyOfAccount(account);
    if (currentKey === null || currentKey !== args.expectedDestinationKey.trim()) {
      // No write has happened: the owner gets the current owned key to
      // review and re-approve.
      return {
        ok: false,
        code: "destination_mismatch",
        destinationKey: currentKey ?? "",
      };
    }
    const money = await checkWithdrawalWallet(ctx, actor._id, amountCents);
    const destinationType = "phone" in destination ? "mobile_money" : "bank_account";
    const providerReference = await allocateWithdrawalReference(ctx, destinationType);
    const now = Date.now();
    const amountMajor = centsToMajorOrThrow(amountCents);

    const walletReference = generateWalletDisplayReference();

    // ---- First write below. Everything above denied before writing. ----
    const ledgerId = await ctx.db.insert("walletTransactions", {
      walletId: money.wallet._id,
      userId: actor._id,
      type: "debit",
      source: destinationType === "mobile_money" ? "withdrawal_mobile_money" : "withdrawal_bank",
      amount: amountMajor,
      balanceAfter: money.newBalanceMajor,
      paymentAccountId: account._id,
      reference: walletReference,
      status: "pending",
      description: destinationType === "mobile_money" ? "Mobile-money withdrawal." : "Bank withdrawal.",
      metadata: { operationId: null },
      createdAt: now,
      updatedAt: now,
    });
    const operationId = await ctx.db.insert("paymentOperations", {
      ownerId: actor._id,
      requestId,
      kind: "withdrawal_transfer",
      status: "reserved",
      requestIdentity: args.requestIdentity,
      providerReference,
      amountCents,
      currency: PROVIDER_CURRENCY,
      destinationKey: currentKey,
      withdrawalDestination: destination,
      paymentAccountId: account._id,
      configuredDebitAccountId: args.configuredDebitAccountId,
      walletId: money.wallet._id,
      walletTransactionId: ledgerId,
      walletReference,
      debitAmountCents: amountCents,
      walletBalanceAfterCents: money.newBalanceCents,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(ledgerId, { operationId, metadata: { operationId }, updatedAt: now });
    await ctx.db.patch(money.wallet._id, {
      balance: money.newBalanceMajor,
      totalWithdrawn: money.newTotalWithdrawnMajor,
      lastTransactionAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(operationId, { status: "attempted", attemptedAt: now, updatedAt: now });
    await armFinancialPolling(ctx, operationId);

    return {
      mayPost: true,
      operationId,
      kind: "withdrawal_transfer",
      providerReference,
      amountCents,
      withdrawalDestination: destination,
    };
  },
});

const attachResultValidator = v.object({
  operationId: v.id("paymentOperations"),
  status: providerOperationStatusValidator,
});

// Post-transport attachment loads the immutable operation by id with no
// actor parameter and no requireUser, so it still runs after an owner ban,
// deletion, or sign-out. It persists normalized receipt facts and safe
// ambiguity state only. New receipt evidence is retained even after a
// terminal outcome, preserving the bound accounting proof and sticky review.
// Attachment never applies money or promotes an unproven old receipt;
// trusted top-up/withdrawal acquisition uses providerSettlement instead.
export const attachProviderResult = internalMutation({
  args: {
    operationId: v.id("paymentOperations"),
    receipt: v.optional(providerReceiptValidator),
    failureCode: v.optional(v.string()),
  },
  returns: attachResultValidator,
  handler: async (ctx, args): Promise<{ operationId: Id<"paymentOperations">; status: ProviderBranch["status"] }> => {
    const operation = await ctx.db.get(args.operationId);
    if (!operation || !isProviderBranch(operation)) {
      throw new OperationError("review_needed", "This operation needs review before attachment.");
    }
    const evidence = retainReceiptEvidence(
      operation,
      args.receipt,
      args.receipt !== undefined && receiptMatchesIntent(operation, args.receipt)
    );
    let failureCode = operation.failureCode;
    if (args.failureCode !== undefined && failureCode === undefined) {
      failureCode = args.failureCode;
    }
    await ctx.db.patch(operation._id, {
      ...evidence,
      ...(failureCode === undefined ? {} : { failureCode }),
      status:
        operation.status === "succeeded" || operation.status === "failed" || operation.status === "cancelled"
          ? operation.status
          : "unknown",
      updatedAt: Date.now(),
    });
    return {
      operationId: operation._id,
      status:
        operation.status === "succeeded" || operation.status === "failed" || operation.status === "cancelled"
          ? operation.status
          : "unknown",
    };
  },
});

// Crash healing without transport: a claimed-but-never-posted operation
// moves to unknown on next same-request reuse. No receipt, no POST, no
// reversal; terminal and review states are never regressed.
export const markUnknown = internalMutation({
  args: { operationId: v.id("paymentOperations") },
  returns: attachResultValidator,
  handler: async (ctx, args): Promise<{ operationId: Id<"paymentOperations">; status: ProviderBranch["status"] }> => {
    const operation = await ctx.db.get(args.operationId);
    if (!operation || !isProviderBranch(operation)) {
      throw new OperationError("review_needed", "This operation needs review before attachment.");
    }
    if (
      operation.reviewNeeded === true ||
      operation.accounting !== undefined ||
      operation.status === "succeeded" ||
      operation.status === "failed" ||
      operation.status === "cancelled"
    ) {
      return { operationId: operation._id, status: operation.status };
    }
    await ctx.db.patch(operation._id, { status: "unknown", updatedAt: Date.now() });
    return { operationId: operation._id, status: "unknown" };
  },
});

const storeAccountResultValidator = v.object({
  accountId: v.id("paymentAccounts"),
  destinationKey: v.string(),
});

// Server-side registration: the action resolved the destination through the
// validated adapter, and this mutation rechecks the same verified subject
// before storing actor-owned resolved facts. isVerified marks resolution
// only, never external ownership; providerResolvedAt is the usable marker
// withdrawals require.
export const storePaymentAccount = internalMutation({
  args: {
    expectedUserId: v.id("users"),
    type: v.union(v.literal("mobile_money"), v.literal("bank_account")),
    phone: v.optional(v.string()),
    operator: v.optional(zambiaOperatorValidator),
    bankId: v.optional(v.string()),
    accountNumber: v.optional(v.string()),
    accountName: v.optional(v.string()),
    bankName: v.optional(v.string()),
  },
  returns: storeAccountResultValidator,
  handler: async (ctx, args): Promise<{ accountId: Id<"paymentAccounts">; destinationKey: string }> => {
    const actor = await requireUser(ctx);
    if (actor._id !== args.expectedUserId) {
      throw new Error("Unauthorized");
    }
    let destinationKey: string;
    if (args.type === "mobile_money") {
      if (args.phone === undefined || args.operator === undefined) {
        throw new OperationError("invalid_destination", "A phone and operator are required.");
      }
      destinationKey = destinationKeyForMm(args.phone, args.operator);
    } else {
      if (args.bankId === undefined || args.accountNumber === undefined) {
        throw new OperationError("invalid_destination", "A directory bank and account number are required.");
      }
      destinationKey = destinationKeyForBank(args.bankId, args.accountNumber);
    }
    const owned = await ctx.db
      .query("paymentAccounts")
      .withIndex("by_user", (q) => q.eq("userId", actor._id))
      .collect();
    for (const row of owned) {
      if (currentKeyOfAccount(row) === destinationKey) {
        // Only an already usable resolved row is idempotent. A legacy row
        // with the same key but no server-resolution marker must not swallow
        // the fresh successful resolve: fall through and insert a new
        // resolved actor-owned resource, preserving the legacy row byte-for-byte.
        if (row.isVerified && row.providerResolvedAt !== undefined) {
          return { accountId: row._id, destinationKey };
        }
      }
    }
    const now = Date.now();
    const accountId =
      args.type === "mobile_money"
        ? await ctx.db.insert("paymentAccounts", {
            userId: actor._id,
            type: "mobile_money",
            mobileMoneyProvider: normalizeOperator(args.operator ?? ""),
            mobileNumber: normalizePhone(args.phone ?? ""),
            ...(args.accountName === undefined ? {} : { accountName: args.accountName }),
            isDefault: false,
            isVerified: true,
            providerResolvedAt: now,
            createdAt: now,
            updatedAt: now,
          })
        : await ctx.db.insert("paymentAccounts", {
            userId: actor._id,
            type: "bank_account",
            bankId: (args.bankId ?? "").trim(),
            ...(args.bankName === undefined ? {} : { bankName: args.bankName }),
            accountNumber: (args.accountNumber ?? "").trim(),
            ...(args.accountName === undefined ? {} : { accountName: args.accountName }),
            isDefault: false,
            isVerified: true,
            providerResolvedAt: now,
            createdAt: now,
            updatedAt: now,
          });
    return { accountId, destinationKey };
  },
});

async function reuseResult(ctx: ProviderActionCtx, found: RecoveryProjection): Promise<ProviderInitiateSuccess> {
  if (found.status === "attempted") {
    // Claim-then-crash heals to unknown with no POST.
    await ctx.runMutation(internal.providerOperations.markUnknown, { operationId: found.operationId });
    return { ok: true, operationId: found.operationId, status: "unknown", providerReference: found.providerReference };
  }
  return {
    ok: true,
    operationId: found.operationId,
    status: found.status,
    providerReference: found.providerReference,
  };
}

// Public top-up initiation. Recovery runs before config, wallet, or switch
// reads; a repeat returns its stored status with zero POST, debit, or new
// row. Missing or invalid private config yields safe not_started with none
// of those effects either. Exactly one POST follows the single new claim,
// and normalized trusted terminal receipts enter settlement. Absent or
// ambiguous receipt outcomes retain evidence only and stay unknown.
export function createTopUpAction(deps: ProviderDeps) {
  return action({
    args: topUpRequestValidator,
    returns: providerInitiateResultValidator,
    handler: async (ctx, args): Promise<ProviderInitiateResult> => {
      const actor = await ctx.runQuery(internal.providerOperations.resolveActor, {});
      const requestId = normalizeRequestId(args.requestId);
      const amountCents = validateProviderAmount(args.amountCents);
      const phone = normalizePhone(args.phone);
      const operator = normalizeOperator(args.operator);
      const requestIdentity = await buildTopUpRequestIdentity({ actorId: actor.userId, amountCents, phone, operator });

      const existing = await ctx.runQuery(internal.providerOperations.recoverProviderRequest, {
        requestId,
        kind: "top_up_collection",
        requestIdentity,
      });
      if (existing !== null) {
        return await reuseResult(ctx, existing);
      }

      const adapter = createLencoAdapter(readServerConfig(deps.env()), deps.fetchImpl);
      if (!adapter.configured) {
        throw new OperationError("not_started", "The provider is not configured.");
      }

      const persisted = await ctx.runMutation(internal.providerOperations.persistAndClaimTopUp, {
        expectedUserId: actor.userId,
        requestId,
        requestIdentity,
        amountCents,
        phone,
        operator,
      });
      if (isDestinationMismatch(persisted)) {
        return persisted;
      }
      if (!persisted.mayPost) {
        return {
          ok: true,
          operationId: persisted.operationId,
          status: persisted.status,
          providerReference: persisted.providerReference,
        };
      }

      if (persisted.kind !== "top_up_collection") {
        // Impossible through the typed persist edge: retain the claimed
        // operation for review instead of inventing a payout route.
        throw new OperationError("review_needed", "This request needs review before transport.");
      }

      let receipt: ProviderReceiptFacts | undefined;
      let failureCode: string | undefined;
      try {
        const result = await adapter.initiateMobileMoneyCollection({
          reference: persisted.providerReference,
          phone: persisted.collectionDestination.phone,
          operator: persisted.collectionDestination.operator,
          amountMinor: persisted.amountCents,
        });
        if (result.ok) {
          receipt = toStoredCollectionReceipt({
            kind: "collection",
            id: result.value.id,
            reference: result.value.reference,
            amountMinor: result.value.amountMinor,
            feeMinor: result.value.feeMinor,
            currency: PROVIDER_CURRENCY,
            status: result.value.status,
            collectionType: "mobile-money",
            country: "zm",
            bearer: "merchant",
            operator: result.value.operator,
            phone: result.value.phone,
            reasonForFailure: result.value.reasonForFailure,
            settlementStatus: result.value.settlementStatus,
          });
        } else {
          failureCode = result.code;
        }
      } catch {
        failureCode = "provider_error";
      }
      const attached =
        receipt === undefined
          ? await ctx.runMutation(internal.providerOperations.attachProviderResult, {
              operationId: persisted.operationId,
              ...(failureCode === undefined ? {} : { failureCode }),
            })
          : await ctx.runMutation(internal.providerSettlement.settleProviderReceipt, {
              operationId: persisted.operationId,
              receipt,
              acquisition: { kind: "initiation_post", operationId: persisted.operationId },
            });
      return {
        ok: true,
        operationId: persisted.operationId,
        status: attached.status,
        providerReference: persisted.providerReference,
      };
    },
  });
}

// Public withdrawal initiation. The destination comes from the owned
// server-resolved account and the REQUIRED approved key; a mismatch returns
// the current owned key with zero writes and zero POST.
export function createWithdrawalAction(deps: ProviderDeps) {
  return action({
    args: withdrawalRequestValidator,
    returns: providerInitiateResultValidator,
    handler: async (ctx, args): Promise<ProviderInitiateResult> => {
      const actor = await ctx.runQuery(internal.providerOperations.resolveActor, {});
      const requestId = normalizeRequestId(args.requestId);
      const amountCents = validateProviderAmount(args.amountCents);
      const expectedDestinationKey = args.expectedDestinationKey.trim();
      if (expectedDestinationKey === "") {
        throw new OperationError("invalid_request", "An approved destination key is required for withdrawal.");
      }
      const requestIdentity = await buildWithdrawalRequestIdentity({
        actorId: actor.userId,
        amountCents,
        paymentAccountId: args.paymentAccountId,
        expectedDestinationKey,
      });

      const existing = await ctx.runQuery(internal.providerOperations.recoverProviderRequest, {
        requestId,
        kind: "withdrawal_transfer",
        requestIdentity,
      });
      if (existing !== null) {
        return await reuseResult(ctx, existing);
      }

      const serverConfig = readServerConfig(deps.env());
      const adapter = createLencoAdapter(serverConfig, deps.fetchImpl);
      if (
        !adapter.configured ||
        serverConfig.debitAccountId === undefined ||
        !isValidProviderId(serverConfig.debitAccountId)
      ) {
        throw new OperationError("not_started", "The provider transfer configuration is missing.");
      }
      const configuredDebitAccountId = serverConfig.debitAccountId;

      const persisted = await ctx.runMutation(internal.providerOperations.persistAndClaimWithdrawal, {
        expectedUserId: actor.userId,
        requestId,
        requestIdentity,
        amountCents,
        paymentAccountId: args.paymentAccountId,
        expectedDestinationKey,
        configuredDebitAccountId,
      });
      if (isDestinationMismatch(persisted)) {
        return persisted;
      }
      if (!persisted.mayPost) {
        return {
          ok: true,
          operationId: persisted.operationId,
          status: persisted.status,
          providerReference: persisted.providerReference,
        };
      }

      if (persisted.kind !== "withdrawal_transfer") {
        // Impossible through the typed persist edge: retain the claimed
        // operation for review instead of inventing a payout route.
        throw new OperationError("review_needed", "This request needs review before transport.");
      }
      const frozenDestination = persisted.withdrawalDestination;

      let receipt: ProviderReceiptFacts | undefined;
      let failureCode: string | undefined;
      try {
        if ("phone" in frozenDestination) {
          const result = await adapter.initiateMobileMoneyTransfer({
            reference: persisted.providerReference,
            phone: frozenDestination.phone,
            operator: frozenDestination.operator,
            amountMinor: persisted.amountCents,
          });
          if (result.ok) {
            receipt = toStoredTransferReceipt(result.value);
          } else {
            failureCode = result.code;
          }
        } else {
          const result = await adapter.initiateBankTransfer({
            reference: persisted.providerReference,
            bankId: frozenDestination.bankId,
            accountNumber: frozenDestination.accountNumber,
            amountMinor: persisted.amountCents,
          });
          if (result.ok) {
            receipt = toStoredTransferReceipt(result.value);
          } else {
            failureCode = result.code;
          }
        }
      } catch {
        failureCode = "provider_error";
      }
      const attached =
        receipt === undefined
          ? await ctx.runMutation(internal.providerOperations.attachProviderResult, {
              operationId: persisted.operationId,
              ...(failureCode === undefined ? {} : { failureCode }),
            })
          : await ctx.runMutation(internal.providerSettlement.settleProviderReceipt, {
              operationId: persisted.operationId,
              receipt,
              acquisition: { kind: "initiation_post", operationId: persisted.operationId },
            });
      return {
        ok: true,
        operationId: persisted.operationId,
        status: attached.status,
        providerReference: persisted.providerReference,
      };
    },
  });
}

export const initiateTopUpCollection = createTopUpAction({ env: () => process.env });
export const initiateWithdrawal = createWithdrawalAction({ env: () => process.env });

// Public account registration. Resolution is not a financial POST, so this
// stays callable while initiation is disabled; it still requires an active
// verified actor. Provider names are display only and never transfer
// authority; the caller cannot set verification, ownership, or debit facts.
export function createRegisterAccountAction(deps: ProviderDeps) {
  return action({
    args: registerPaymentAccountValidator,
    returns: storeAccountResultValidator,
    handler: async (ctx, args): Promise<{ accountId: Id<"paymentAccounts">; destinationKey: string }> => {
      const actor = await ctx.runQuery(internal.providerOperations.resolveActor, {});
      const adapter = createLencoAdapter(readServerConfig(deps.env()), deps.fetchImpl);
      if (!adapter.configured) {
        throw new OperationError("not_started", "The provider is not configured.");
      }
      const destination = args.destination;
      if (destination.type === "mobile_money") {
        const phone = normalizePhone(destination.phone);
        const operator = normalizeOperator(destination.operator);
        const resolved = await adapter.resolveMobileMoney({ phone, operator });
        if (!resolved.ok) {
          throw new OperationError("resolution_failed", "The mobile-money account could not be resolved.");
        }
        if (resolved.value.phone !== phone || resolved.value.operator !== operator) {
          throw new OperationError("resolution_failed", "The resolved account does not match the selection.");
        }
        return await ctx.runMutation(internal.providerOperations.storePaymentAccount, {
          expectedUserId: actor.userId,
          type: "mobile_money",
          phone,
          operator,
          ...(resolved.value.accountName === null ? {} : { accountName: resolved.value.accountName }),
        });
      }
      const bankId = destination.bankId.trim();
      const accountNumber = destination.accountNumber.trim();
      if (bankId === "" || accountNumber === "") {
        throw new OperationError("invalid_destination", "A directory bank and account number are required.");
      }
      const resolved = await adapter.resolveBankAccount({ accountNumber, bankId });
      if (!resolved.ok) {
        throw new OperationError("resolution_failed", "The bank account could not be resolved.");
      }
      if (resolved.value.accountNumber !== accountNumber || resolved.value.bank.id !== bankId) {
        throw new OperationError("resolution_failed", "The resolved account does not match the selection.");
      }
      return await ctx.runMutation(internal.providerOperations.storePaymentAccount, {
        expectedUserId: actor.userId,
        type: "bank_account",
        bankId,
        accountNumber,
        ...(resolved.value.accountName === null ? {} : { accountName: resolved.value.accountName }),
        bankName: resolved.value.bank.name,
      });
    },
  });
}

export const registerPaymentAccount = createRegisterAccountAction({ env: () => process.env });

// Provider bank directory for account selection. A directory read, not a
// financial POST: callable while initiation is disabled by an active
// verified actor.
export function createListBanksAction(deps: ProviderDeps) {
  return action({
    args: {},
    returns: v.object({
      ok: v.literal(true),
      banks: v.array(v.object({ id: v.string(), name: v.string(), country: v.literal("zm") })),
    }),
    handler: async (ctx): Promise<{ ok: true; banks: Array<{ id: string; name: string; country: "zm" }> }> => {
      await ctx.runQuery(internal.providerOperations.resolveActor, {});
      const adapter = createLencoAdapter(readServerConfig(deps.env()), deps.fetchImpl);
      const result = await adapter.listBanks();
      if (!result.ok) {
        throw new OperationError("resolution_failed", "The bank directory could not be loaded.");
      }
      return {
        ok: true,
        banks: result.value.map((bank) => ({ id: bank.id, name: bank.name, country: "zm" as const })),
      };
    },
  });
}

export const listBanks = createListBanksAction({ env: () => process.env });

// Owner-only account list with current approval keys. Only the owner's
// required display and approval facts are projected, never credentials.
export const listPaymentAccounts = query({
  args: {},
  returns: v.array(paymentAccountProjectionValidator),
  handler: async (ctx) => {
    const actor = await requireUser(ctx);
    const rows = await ctx.db
      .query("paymentAccounts")
      .withIndex("by_user", (q) => q.eq("userId", actor._id))
      .collect();
    const projections: Array<
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
        }
    > = [];
    for (const row of rows) {
      const key = currentKeyOfAccount(row) ?? "";
      if (row.type === "mobile_money") {
        projections.push({
          accountId: row._id,
          type: "mobile_money",
          destinationKey: key,
          phone: row.mobileNumber ?? "",
          operator:
            row.mobileMoneyProvider === "airtel" ||
            row.mobileMoneyProvider === "mtn" ||
            row.mobileMoneyProvider === "zamtel"
              ? row.mobileMoneyProvider
              : "mtn",
          accountName: row.accountName ?? null,
          isVerified: row.isVerified,
          providerResolvedAt: row.providerResolvedAt ?? null,
        });
      } else {
        projections.push({
          accountId: row._id,
          type: "bank_account",
          destinationKey: key,
          bankId: row.bankId ?? "",
          bankName: row.bankName ?? null,
          accountNumber: row.accountNumber ?? "",
          accountName: row.accountName ?? null,
          isVerified: row.isVerified,
          providerResolvedAt: row.providerResolvedAt ?? null,
        });
      }
    }
    return projections;
  },
});

// Owner-only provider status. Wallet rows are never projected here; the
// wallet slice owns them. Raw receipts, config, and other-owner data never
// leave this query.
export const getMine = query({
  args: { operationId: v.id("paymentOperations") },
  returns: v.union(providerStatusProjectionValidator, v.null()),
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    const operation = await ctx.db.get(args.operationId);
    if (!operation) {
      return null;
    }
    if (operation.ownerId !== actor._id) {
      throw new Error("Unauthorized");
    }
    if (!isProviderBranch(operation)) {
      return null;
    }
    await assertSafeProviderOutcome(ctx, operation);
    return {
      operationId: operation._id,
      kind: operation.kind,
      status: operation.status,
      amountCents: operation.amountCents,
      providerReference: operation.providerReference,
      destinationKey: operation.destinationKey,
      ...(operation.kind === "withdrawal_transfer"
        ? { walletTransactionId: operation.walletTransactionId }
        : operation.transactionId === undefined
          ? {}
          : { transactionId: operation.transactionId }),
      application:
        // Task4B consumes checkout proof here too: only a positively proven
        // capture or release reads as applied. Bare terminal labels without
        // that proof throw review_needed above instead of projecting.
        operation.accounting === undefined ? ("pending" as const) : ("applied" as const),
      createdAt: operation.createdAt,
    };
  },
});
