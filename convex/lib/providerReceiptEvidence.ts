import type { Doc } from "../_generated/dataModel";
import { stableStringify } from "./checkoutQuote";
import { isPositiveSafeCents, isValidProviderId, isValidReference } from "./lencoAdapter";
import type { ProviderReceiptFacts } from "./providerOperationContracts";
import type { ReceiptAcquisition } from "./providerSettlementContracts";

export type ProviderBranch = Exclude<Doc<"paymentOperations">, { kind: "wallet_purchase" }>;
// Task4B consumes the checkout branch through the same writer, so every
// provider branch carries settlement evidence.
export type SettledBranch = ProviderBranch;

export function validAcquisition(
  operation: ProviderBranch,
  receipt: ProviderReceiptFacts,
  acquisition: ReceiptAcquisition
): boolean {
  if (acquisition.kind === "initiation_post") {
    return acquisition.operationId === operation._id;
  }
  if (acquisition.kind === "signed_webhook") {
    // Reserved private interface: Task5 must verify the raw body before invoking it.
    return acquisition.eventId.trim() !== "";
  }
  return acquisition.lookup.kind === "reference"
    ? acquisition.lookup.reference === operation.providerReference
    : operation.providerId === acquisition.lookup.providerId && receipt.id === acquisition.lookup.providerId;
}

export function receiptMatchesIntent(
  operation: ProviderBranch,
  receipt: ProviderReceiptFacts,
  acquisition?: ReceiptAcquisition
): boolean {
  if (
    !isValidProviderId(receipt.id) ||
    !isValidReference(operation.providerReference) ||
    receipt.reference !== operation.providerReference ||
    operation.currency !== "ZMW" ||
    receipt.currency !== "ZMW" ||
    !isPositiveSafeCents(operation.amountCents) ||
    receipt.amountMinor !== operation.amountCents ||
    (receipt.feeMinor !== null && (!Number.isSafeInteger(receipt.feeMinor) || receipt.feeMinor < 0))
  ) {
    return false;
  }
  if (operation.kind !== "withdrawal_transfer") {
    return (
      receipt.kind === "collection" &&
      receipt.collectionType === "mobile-money" &&
      receipt.bearer === "merchant" &&
      receipt.country === "zm" &&
      operation.collectionDestination.country === "zm" &&
      receipt.phone === operation.collectionDestination.phone &&
      receipt.operator === operation.collectionDestination.operator
    );
  }
  if (
    receipt.kind !== "transfer" ||
    !isValidProviderId(operation.configuredDebitAccountId) ||
    receipt.debitAccountId !== operation.configuredDebitAccountId
  ) {
    return false;
  }
  const destination = operation.withdrawalDestination;
  if (destination.country !== "zm") {
    return false;
  }
  if ("phone" in destination) {
    return (
      receipt.transferType === "mobile-money" &&
      receipt.destination.kind === "mobile-money" &&
      (receipt.destination.country === "zm" ||
        (receipt.destination.country === null &&
          acquisition?.kind === "status_get" &&
          validAcquisition(operation, receipt, acquisition))) &&
      receipt.destination.phone === destination.phone &&
      receipt.destination.operator === destination.operator
    );
  }
  return (
    receipt.transferType === "bank-account" &&
    receipt.destination.kind === "bank-account" &&
    receipt.destination.country === "zm" &&
    receipt.destination.bankId === destination.bankId &&
    receipt.destination.accountNumber === destination.accountNumber
  );
}

// Inspect facts rather than the presence of a history array or a legacy flag.
// Matching pending history and same-payment fee/settlement enrichment are
// harmless; identity disagreement or opposite terminal outcomes remain held.
export function hasReceiptConflict(operation: SettledBranch): boolean {
  const receipts = [
    ...(operation.receipt === undefined ? [] : [operation.receipt]),
    ...(operation.receiptObservations ?? []),
  ];
  const terminalStatuses = new Set<string>();
  for (const receipt of receipts) {
    const matches =
      receiptMatchesIntent(operation, receipt) ||
      (operation.acquisitions ?? []).some(
        (entry) =>
          stableStringify(entry.receipt) === stableStringify(receipt) &&
          validAcquisition(operation, receipt, entry.acquisition) &&
          receiptMatchesIntent(operation, receipt, entry.acquisition)
      );
    if (!matches || (operation.providerId !== undefined && operation.providerId !== receipt.id)) {
      return true;
    }
    if (receipt.status !== "pending") {
      terminalStatuses.add(receipt.status);
    }
  }
  return terminalStatuses.size > 1;
}

// A normalized receipt terminal state is evidence terminality, distinct from
// the separately proven operation financial terminality. Only
// successful/failed receipts are terminal;
// pending always yields to a later matching terminal fact.
function isTerminalReceiptStatus(status: ProviderReceiptFacts["status"]): boolean {
  return status === "successful" || status === "failed";
}

// Stable canonical key for structural receipt comparison, so exact replays
// never grow the preserved observation history.
function canonicalReceiptKey(receipt: ProviderReceiptFacts): string {
  return stableStringify(receipt);
}

// Retains an incoming conflicting receipt fact separately without clearing
// review, binding an invalid id, or replacing primary evidence.
// Structurally identical replays (of the primary or an already retained
// observation) return the existing history unchanged.
function recordReceiptObservation(
  primary: ProviderReceiptFacts | undefined,
  observations: ProviderReceiptFacts[] | undefined,
  incoming: ProviderReceiptFacts
): ProviderReceiptFacts[] | undefined {
  const key = canonicalReceiptKey(incoming);
  if (primary !== undefined && canonicalReceiptKey(primary) === key) {
    return observations;
  }
  const existing = observations ?? [];
  if (existing.some((entry) => canonicalReceiptKey(entry) === key)) {
    return observations;
  }
  return [...existing, incoming];
}

// Preserves superseded primary facts when same-terminal enrichment stores
// new non-authority information, so no previous fact is silently replaced.
function retainPriorReceipt(
  observations: ProviderReceiptFacts[] | undefined,
  prior: ProviderReceiptFacts
): ProviderReceiptFacts[] {
  const existing = observations ?? [];
  const key = canonicalReceiptKey(prior);
  if (existing.some((entry) => canonicalReceiptKey(entry) === key)) {
    return existing;
  }
  return [...existing, prior];
}

export type ReceiptEvidencePatch = {
  receipt?: ProviderReceiptFacts;
  providerId?: string;
  receiptObservations?: ProviderReceiptFacts[];
  failureCode?: string;
  reviewNeeded?: true;
};

export function retainReceiptEvidence(
  operation: ProviderBranch,
  incomingReceipt: ProviderReceiptFacts | undefined,
  matches: boolean
): ReceiptEvidencePatch {
  let receiptToStore = operation.receipt;
  let observations = operation.receiptObservations;
  let providerId = operation.providerId;
  let reviewNeeded = operation.reviewNeeded ?? false;
  const failureCode = operation.failureCode;
  if (incomingReceipt !== undefined) {
    const incoming = incomingReceipt;
    if (!matches) {
      if (receiptToStore === undefined) {
        // First mismatching receipt with no previous evidence: store it
        // without binding a provider id, and flag review.
        receiptToStore = incoming;
        reviewNeeded = true;
      } else {
        // Preserve the earlier receipt and bound provider id; retain the
        // incoming conflicting evidence separately and keep review sticky.
        observations = recordReceiptObservation(receiptToStore, observations, incoming);
        reviewNeeded = true;
      }
    } else if (providerId !== undefined && providerId !== incoming.id) {
      // Different bound provider ids never replace one another.
      observations = recordReceiptObservation(receiptToStore, observations, incoming);
      reviewNeeded = true;
    } else if (receiptToStore !== undefined && receiptToStore.id !== incoming.id) {
      // A later matching receipt that conflicts with prior stored
      // evidence is preserved alongside it; the operation is never
      // silently repaired.
      observations = recordReceiptObservation(receiptToStore, observations, incoming);
      reviewNeeded = true;
    } else if (
      receiptToStore !== undefined &&
      isTerminalReceiptStatus(receiptToStore.status) &&
      incoming.status === "pending"
    ) {
      // A later matching pending after a terminal receipt is stale: retain
      // the terminal primary and record the distinct observation without
      // declaring a new financial outcome or changing review.
      observations = recordReceiptObservation(receiptToStore, observations, incoming);
    } else if (
      receiptToStore !== undefined &&
      isTerminalReceiptStatus(receiptToStore.status) &&
      isTerminalReceiptStatus(incoming.status) &&
      receiptToStore.status !== incoming.status
    ) {
      // Terminal disagreement keeps the earlier receipt and provider id,
      // retains the incoming observation, and sets sticky review.
      observations = recordReceiptObservation(receiptToStore, observations, incoming);
      reviewNeeded = true;
    } else if (receiptToStore !== undefined && canonicalReceiptKey(receiptToStore) !== canonicalReceiptKey(incoming)) {
      if (receiptToStore.status === incoming.status) {
        // Same-terminal enrichment of non-authority settlement/fee facts:
        // the previous facts remain observed, then the enriched receipt
        // becomes primary. Identity, amount, and destination still match.
        observations = retainPriorReceipt(observations, receiptToStore);
        receiptToStore = incoming;
      } else {
        // The only remaining status change is legitimate pending ->
        // successful or pending -> failed progression on the same bound
        // identity. The superseded pending facts remain observed via the
        // existing helper, then the terminal receipt becomes primary.
        // No financial settlement happens in this slice.
        observations = retainPriorReceipt(observations, receiptToStore);
        receiptToStore = incoming;
      }
      if (providerId === undefined) {
        providerId = incoming.id;
      }
    } else {
      receiptToStore = incoming;
      if (providerId === undefined) {
        providerId = incoming.id;
      }
    }
  }
  return {
    ...(receiptToStore === undefined ? {} : { receipt: receiptToStore }),
    ...(providerId === undefined ? {} : { providerId }),
    ...(observations === undefined ? {} : { receiptObservations: observations }),
    ...(failureCode === undefined ? {} : { failureCode }),
    ...(reviewNeeded ? { reviewNeeded: true } : {}),
  };
}
