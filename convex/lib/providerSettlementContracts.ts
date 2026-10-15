import { v, type Infer } from "convex/values";
import { providerOperationStatusValidator, providerReceiptValidator } from "./providerOperationContracts";

// Only internally acquired evidence can reach the accounting writer. No user,
// config, raw payload, signature, or public verified flag is accepted.
export const receiptAcquisitionValidator = v.union(
  v.object({ kind: v.literal("initiation_post"), operationId: v.id("paymentOperations") }),
  v.object({
    kind: v.literal("status_get"),
    lookup: v.union(
      v.object({ kind: v.literal("reference"), reference: v.string() }),
      v.object({ kind: v.literal("provider_id"), providerId: v.string() })
    ),
  }),
  v.object({ kind: v.literal("signed_webhook"), eventId: v.string() })
);

export type ReceiptAcquisition = Infer<typeof receiptAcquisitionValidator>;

export const acquiredReceiptValidator = v.object({
  receipt: providerReceiptValidator,
  acquisition: receiptAcquisitionValidator,
});

const proof = {
  receipt: providerReceiptValidator,
  acquisition: receiptAcquisitionValidator,
  appliedAt: v.number(),
};

export const providerAccountingValidator = v.union(
  v.object({
    kind: v.literal("topup_credit"),
    ...proof,
    transactionId: v.id("transactions"),
    walletId: v.id("wallets"),
    creditId: v.id("walletTransactions"),
    balanceAfterCents: v.number(),
  }),
  v.object({ kind: v.literal("topup_failed"), ...proof, transactionId: v.id("transactions") }),
  v.object({ kind: v.literal("withdrawal_completed"), ...proof, debitId: v.id("walletTransactions") }),
  v.object({
    kind: v.literal("withdrawal_reversed"),
    ...proof,
    debitId: v.id("walletTransactions"),
    reversalId: v.id("walletTransactions"),
    balanceAfterCents: v.number(),
  }),
  // Task4B checkout capture/release through the same writer. Each marker is
  // consumed proof of exactly-once reservation settlement: the reciprocal
  // companion, order and escrow/effect identities plus the frozen reservation
  // links. Frozen money/quantities live on the operation's quoteSnapshot and
  // orderBreakdowns; a bare terminal label without one of these markers is
  // never financial proof.
  v.object({
    kind: v.literal("checkout_captured"),
    ...proof,
    transactionId: v.id("transactions"),
    orderIds: v.array(v.id("orders")),
    escrowIds: v.array(v.id("escrow")),
    promoRedemptionId: v.optional(v.id("promoCodeRedemptions")),
    loyaltyTransactionId: v.optional(v.id("loyaltyTransactions")),
  }),
  v.object({
    kind: v.literal("checkout_released"),
    ...proof,
    transactionId: v.id("transactions"),
    orderIds: v.array(v.id("orders")),
    promoRedemptionId: v.optional(v.id("promoCodeRedemptions")),
    loyaltyTransactionId: v.optional(v.id("loyaltyTransactions")),
  })
);

export const receivedFundsValidator = v.object({
  receipt: providerReceiptValidator,
  acquisition: receiptAcquisitionValidator,
  receivedAt: v.number(),
});

export const settlementResultValidator = v.object({
  operationId: v.id("paymentOperations"),
  status: providerOperationStatusValidator,
  application: v.union(v.literal("pending"), v.literal("applied"), v.literal("review"), v.literal("unsupported")),
});

export type SettlementResult = Infer<typeof settlementResultValidator>;
