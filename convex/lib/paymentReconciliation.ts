import { v, type Infer } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { centsToStoredMajor } from "./catalogMoney";
import { validateCheckoutAccounting } from "./checkoutSettlement";
import { requireWalletFundingProof } from "./fundingProof";
import { PurchaseError } from "./paymentOperationContracts";
import { providerOperationStatusValidator } from "./providerOperationContracts";
import {
  hasReceiptConflict,
  receiptMatchesIntent,
  validAcquisition,
  type ProviderBranch,
} from "./providerReceiptEvidence";
import { validateProviderAccounting } from "../providerSettlement";

// Function arguments must have an object root for Convex deployment analysis.
// selectOwnedOperation enforces exactly one of these flat selectors.
export const recoverySelectorValidator = v.object({
  operationId: v.optional(v.id("paymentOperations")),
  requestId: v.optional(v.string()),
});

export type RecoverySelector = Infer<typeof recoverySelectorValidator>;

export const applicationValidator = v.union(v.literal("pending"), v.literal("applied"), v.literal("review"));

export const recoveryStatusValidator = v.union(
  v.null(),
  v.object({ result: v.literal("review"), reason: v.literal("ambiguous_request") }),
  v.object({
    result: v.literal("found"),
    operationId: v.id("paymentOperations"),
    requestId: v.string(),
    requestIdentity: v.union(v.string(), v.null()),
    kind: v.union(
      v.literal("wallet_purchase"),
      v.literal("top_up_collection"),
      v.literal("withdrawal_transfer"),
      v.literal("checkout_collection")
    ),
    status: providerOperationStatusValidator,
    providerStatus: v.union(
      v.literal("unknown"),
      v.literal("pending"),
      v.literal("successful"),
      v.literal("failed"),
      v.literal("not_applicable")
    ),
    application: applicationValidator,
    accountingApplied: v.boolean(),
    reviewNeeded: v.boolean(),
    amountCents: v.number(),
    quoteKey: v.union(v.string(), v.null()),
    source: v.union(v.literal("cart"), v.literal("pending_orders"), v.null()),
    orderIds: v.array(v.id("orders")),
    feeCents: v.union(v.number(), v.null()),
  })
);

export type RecoveryStatus = Infer<typeof recoveryStatusValidator>;
type ReadCtx = Pick<QueryCtx, "db">;

// Legacy container guards keep absent/corrupt stored structures from throwing
// before the accepted proof validators can decide. These check readability
// only: no money, lineage, authority or application rule is duplicated here.
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readableReceipt(value: unknown): boolean {
  return (
    object(value) && (value["kind"] === "collection" || (value["kind"] === "transfer" && object(value["destination"])))
  );
}

function readableAcquisition(value: unknown): boolean {
  return (
    object(value) &&
    (value["kind"] === "signed_webhook" ||
      value["kind"] === "initiation_post" ||
      (value["kind"] === "status_get" && object(value["lookup"])))
  );
}

function readableAccounting(value: unknown): boolean {
  if (!object(value) || !readableReceipt(value["receipt"]) || !readableAcquisition(value["acquisition"])) {
    return false;
  }
  if (value["kind"] === "checkout_captured" || value["kind"] === "checkout_released") {
    return (
      Array.isArray(value["orderIds"]) && (value["kind"] !== "checkout_captured" || Array.isArray(value["escrowIds"]))
    );
  }
  return true;
}

function readableProviderEvidence(operation: ProviderBranch): boolean {
  const accounting = operation.accounting;
  return (
    (operation.kind === "withdrawal_transfer"
      ? object(operation.withdrawalDestination)
      : object(operation.collectionDestination)) &&
    (accounting === undefined || readableAccounting(accounting)) &&
    (!("receivedFunds" in operation) ||
      operation.receivedFunds === undefined ||
      (object(operation.receivedFunds) &&
        readableReceipt(operation.receivedFunds.receipt) &&
        readableAcquisition(operation.receivedFunds.acquisition))) &&
    (operation.receipt === undefined || readableReceipt(operation.receipt)) &&
    (operation.receiptObservations === undefined ||
      (Array.isArray(operation.receiptObservations) && operation.receiptObservations.every(readableReceipt))) &&
    (operation.acquisitions === undefined ||
      (Array.isArray(operation.acquisitions) &&
        operation.acquisitions.every(
          (entry) => object(entry) && readableReceipt(entry.receipt) && readableAcquisition(entry.acquisition)
        )))
  );
}

function readablePurchase(
  operation: Extract<Doc<"paymentOperations">, { kind: "wallet_purchase" | "checkout_collection" }>
): boolean {
  const quote = operation.quoteSnapshot;
  return (
    object(quote) &&
    Array.isArray(quote.sellers) &&
    quote.sellers.every(object) &&
    Array.isArray(operation.orderBreakdowns) &&
    operation.orderBreakdowns.every(object) &&
    Array.isArray(operation.orderIds)
  );
}

// Accounting is validated first. GET enrichment affects only this readonly cost
// projection; the original receipt, proof and all financial effects stay frozen.
export async function provenProviderFee(
  ctx: ReadCtx,
  operation: ProviderBranch
): Promise<{ validated: false } | { validated: true; feeCents: number | null }> {
  if (
    !readableProviderEvidence(operation) ||
    (operation.kind === "checkout_collection" && !readablePurchase(operation)) ||
    !(await validateProviderAccounting(ctx, operation))
  ) {
    return { validated: false };
  }
  const original = operation.accounting?.receipt;
  if (operation.reviewNeeded === true || original === undefined) {
    return { validated: true, feeCents: null };
  }
  const acquisitions = (operation.acquisitions ?? []).filter(
    (entry) =>
      entry.receipt.status !== "pending" &&
      validAcquisition(operation, entry.receipt, entry.acquisition) &&
      receiptMatchesIntent(operation, entry.receipt, entry.acquisition)
  );
  const terminal = [
    original,
    operation.receipt,
    ...(operation.receiptObservations ?? []),
    ...acquisitions.map((e) => e.receipt),
  ];
  if (
    terminal.some(
      (fact) =>
        fact !== undefined && fact.status !== "pending" && (fact.id !== original.id || fact.status !== original.status)
    )
  ) {
    return { validated: true, feeCents: null };
  }
  const costs = terminal
    .filter((fact) => fact !== undefined && fact.status !== "pending" && fact.feeMinor !== null)
    .map((fact) => fact?.feeMinor);
  if (costs.some((cost) => cost === undefined || cost === null || centsToStoredMajor(cost) === null)) {
    return { validated: true, feeCents: null };
  }
  const known = new Set(costs);
  if (known.size > 1) {
    return { validated: true, feeCents: null };
  }
  if (original.feeMinor !== null) {
    return { validated: true, feeCents: original.feeMinor };
  }
  const get = acquisitions.find(
    (entry) =>
      entry.acquisition.kind === "status_get" &&
      entry.receipt.id === original.id &&
      entry.receipt.status === original.status &&
      entry.receipt.feeMinor !== null
  );
  return { validated: true, feeCents: get?.receipt.feeMinor ?? null };
}

function safeHash(value: string): string | null {
  return /^[a-f0-9]{64}$/.test(value) ? value : null;
}

export async function projectRecoveryStatus(
  ctx: ReadCtx,
  operation: Doc<"paymentOperations">
): Promise<RecoveryStatus> {
  let accountingApplied = false;
  let providerStatus: "unknown" | "pending" | "successful" | "failed" | "not_applicable" = "unknown";
  let feeCents: number | null = null;
  let reviewNeeded = false;
  if (operation.kind === "wallet_purchase") {
    providerStatus = "not_applicable";
    try {
      if (readablePurchase(operation)) {
        await requireWalletFundingProof(ctx, operation);
        accountingApplied = true;
      } else {
        reviewNeeded = true;
      }
    } catch (error) {
      if (!(error instanceof PurchaseError) || error.code !== "review_needed") {
        throw error;
      }
      reviewNeeded = true;
    }
  } else {
    const readable =
      readableProviderEvidence(operation) && (operation.kind !== "checkout_collection" || readablePurchase(operation));
    accountingApplied =
      readable &&
      (operation.kind === "checkout_collection"
        ? await validateCheckoutAccounting(ctx, operation)
        : await validateProviderAccounting(ctx, operation));
    reviewNeeded =
      !readable ||
      (readable && hasReceiptConflict(operation)) ||
      operation.reviewNeeded === true ||
      (!accountingApplied &&
        (operation.accounting !== undefined || ["succeeded", "failed", "cancelled"].includes(operation.status)));
    const receipt = operation.receipt;
    if (
      readable &&
      receipt !== undefined &&
      !hasReceiptConflict(operation) &&
      (operation.acquisitions ?? []).some(
        (entry) =>
          entry.receipt.id === receipt.id &&
          entry.receipt.status === receipt.status &&
          validAcquisition(operation, entry.receipt, entry.acquisition) &&
          receiptMatchesIntent(operation, receipt, entry.acquisition)
      )
    ) {
      providerStatus = receipt.status;
    }
    if (accountingApplied) {
      const fee = await provenProviderFee(ctx, operation);
      feeCents = fee.validated ? fee.feeCents : null;
    }
  }
  return {
    result: "found",
    operationId: operation._id,
    requestId: operation.requestId,
    requestIdentity: safeHash(operation.requestIdentity),
    kind: operation.kind,
    status: operation.status,
    providerStatus,
    application: reviewNeeded ? "review" : accountingApplied ? "applied" : "pending",
    accountingApplied,
    reviewNeeded,
    amountCents: operation.kind === "wallet_purchase" ? operation.totalAmountCents : operation.amountCents,
    quoteKey: "quoteKey" in operation ? safeHash(operation.quoteKey) : null,
    source: "source" in operation ? operation.source : null,
    orderIds: "orderIds" in operation ? operation.orderIds : [],
    feeCents,
  };
}
