import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { centsToStoredMajor, checkedAdd, majorNumberToCents } from "./lib/catalogMoney";
import { stableStringify } from "./lib/checkoutQuote";
import { providerReceiptValidator } from "./lib/providerOperationContracts";
import {
  hasReceiptConflict,
  receiptMatchesIntent,
  retainReceiptEvidence,
  validAcquisition,
  type SettledBranch,
} from "./lib/providerReceiptEvidence";
import {
  receiptAcquisitionValidator,
  settlementResultValidator,
  type SettlementResult,
} from "./lib/providerSettlementContracts";
import {
  applyCheckoutCapture,
  applyCheckoutRelease,
  checkoutCompanionMatches,
  isCheckoutOperation,
  preflightCheckoutSettlement,
  validateCheckoutAccounting,
  type CheckoutEvidencePatch,
} from "./lib/checkoutSettlement";

type ReadCtx = Pick<QueryCtx | MutationCtx, "db">;
type Ledger = Doc<"walletTransactions">;
type Companion = Doc<"transactions">;

function validTime(value: number | undefined): boolean {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

function walletMoneyValid(wallet: Doc<"wallets">): boolean {
  return [wallet.balance, wallet.pendingBalance, wallet.totalEarned, wallet.totalSpent, wallet.totalWithdrawn].every(
    (value) => majorNumberToCents(value) !== null
  );
}

function companionMatches(
  operation: Extract<SettledBranch, { kind: "top_up_collection" }>,
  row: Companion,
  providerId: string
): boolean {
  const metadata: unknown = row.metadata;
  // Anonymization intentionally erases phone and metadata. Present facts are
  // corroboration; frozen intent and acquired receipt establish destination.
  const corroborates =
    metadata === undefined ||
    (typeof metadata === "object" &&
      metadata !== null &&
      (!("operationId" in metadata) || metadata.operationId === operation._id) &&
      (!("topUp" in metadata) || metadata.topUp === true));
  return (
    row._id === operation.transactionId &&
    row.operationId === operation._id &&
    row.userId === operation.ownerId &&
    row.type === "collection" &&
    row.paymentMethod === "mobile_money" &&
    row.currency === "ZMW" &&
    row.reference === operation.providerReference &&
    majorNumberToCents(row.amount) === operation.amountCents &&
    row.orderId === undefined &&
    row.escrowId === undefined &&
    corroborates &&
    (row.mobileNumber === undefined || row.mobileNumber === operation.collectionDestination.phone) &&
    (row.mobileMoneyProvider === undefined || row.mobileMoneyProvider === operation.collectionDestination.operator) &&
    (row.lencoCollectionId === undefined || row.lencoCollectionId === providerId) &&
    (row.lencoTransactionId === undefined || row.lencoTransactionId === providerId)
  );
}

function debitMatches(
  operation: Extract<SettledBranch, { kind: "withdrawal_transfer" }>,
  row: Ledger,
  providerId: string
): boolean {
  return (
    operation.walletReference !== undefined &&
    row.reference === operation.walletReference &&
    row._id === operation.walletTransactionId &&
    row.walletId === operation.walletId &&
    row.userId === operation.ownerId &&
    row.operationId === operation._id &&
    row.paymentAccountId === operation.paymentAccountId &&
    row.type === "debit" &&
    row.source === ("phone" in operation.withdrawalDestination ? "withdrawal_mobile_money" : "withdrawal_bank") &&
    operation.debitAmountCents === operation.amountCents &&
    majorNumberToCents(row.amount) === operation.amountCents &&
    majorNumberToCents(row.balanceAfter) === operation.walletBalanceAfterCents &&
    row.orderId === undefined &&
    row.escrowId === undefined &&
    row.reversalOfId === undefined &&
    (row.providerReference === undefined || row.providerReference === operation.providerReference) &&
    (row.externalReference === undefined || row.externalReference === providerId)
  );
}

// Indexed read sets participate in the one Convex mutation's OCC transaction.
// No locks or declarative uniqueness claims: duplicate stored evidence fails
// closed. Foreign metadata is never a grant of resource ownership.
async function relatedEvidence(
  ctx: ReadCtx,
  operation: SettledBranch,
  providerId: string
): Promise<{
  operations: Doc<"paymentOperations">[];
  ledgers: Ledger[];
  companions: Companion[];
}> {
  const operations = [
    ...(await ctx.db
      .query("paymentOperations")
      .withIndex("by_provider_reference", (q) => q.eq("providerReference", operation.providerReference))
      .collect()),
    ...(await ctx.db
      .query("paymentOperations")
      .withIndex("by_provider_id", (q) => q.eq("providerId", providerId))
      .collect()),
  ];
  const ledgers = [
    ...(await ctx.db
      .query("walletTransactions")
      .withIndex("by_operation", (q) => q.eq("operationId", operation._id))
      .collect()),
    ...(await ctx.db
      .query("walletTransactions")
      .withIndex("by_reference", (q) => q.eq("reference", operation.providerReference))
      .collect()),
    ...(await ctx.db
      .query("walletTransactions")
      .withIndex("by_provider_reference", (q) => q.eq("providerReference", operation.providerReference))
      .collect()),
    ...(await ctx.db
      .query("walletTransactions")
      .withIndex("by_external_reference", (q) => q.eq("externalReference", providerId))
      .collect()),
  ];
  if (operation.kind === "withdrawal_transfer" && operation.walletReference !== undefined) {
    const walletReference = operation.walletReference;
    ledgers.push(
      ...(await ctx.db
        .query("walletTransactions")
        .withIndex("by_reference", (q) => q.eq("reference", walletReference))
        .collect())
    );
    ledgers.push(
      ...(await ctx.db
        .query("walletTransactions")
        .withIndex("by_reversal", (q) => q.eq("reversalOfId", operation.walletTransactionId))
        .collect())
    );
  }
  const companions = [
    ...(await ctx.db
      .query("transactions")
      .withIndex("by_operation", (q) => q.eq("operationId", operation._id))
      .collect()),
    ...(await ctx.db
      .query("transactions")
      .withIndex("by_reference", (q) => q.eq("reference", operation.providerReference))
      .collect()),
    ...(await ctx.db
      .query("transactions")
      .withIndex("by_lenco_id", (q) => q.eq("lencoTransactionId", providerId))
      .collect()),
    ...(await ctx.db
      .query("transactions")
      .withIndex("by_lenco_collection", (q) => q.eq("lencoCollectionId", providerId))
      .collect()),
  ];
  return { operations: uniqueRows(operations), ledgers: uniqueRows(ledgers), companions: uniqueRows(companions) };
}

function uniqueRows<T extends { _id: string }>(rows: T[]): T[] {
  return [...new Map(rows.map((row) => [row._id, row])).values()];
}

function creditMatches(
  operation: SettledBranch,
  row: Ledger,
  walletId: Id<"wallets">,
  source: "top_up_mobile_money" | "withdrawal_reversal",
  balanceAfterCents: number,
  appliedAt: number,
  providerId: string
): boolean {
  return (
    row.operationId === operation._id &&
    row.userId === operation.ownerId &&
    row.walletId === walletId &&
    row.type === "credit" &&
    row.source === source &&
    row.status === "completed" &&
    majorNumberToCents(row.amount) === operation.amountCents &&
    majorNumberToCents(row.balanceAfter) === balanceAfterCents &&
    row.reference === operation.providerReference &&
    row.providerReference === operation.providerReference &&
    row.externalReference === providerId &&
    row.completedAt === appliedAt &&
    row.createdAt === appliedAt &&
    row.orderId === undefined &&
    row.escrowId === undefined &&
    (operation.kind === "withdrawal_transfer"
      ? row.reversalOfId === operation.walletTransactionId && row.paymentAccountId === operation.paymentAccountId
      : row.reversalOfId === undefined && row.paymentAccountId === undefined)
  );
}

// Consumed by settlement duplicates AND owned recovery/projection. A bare
// terminal label, missing marker, or corrupted reciprocal effect is no proof.
export async function validateProviderAccounting(ctx: ReadCtx, operation: SettledBranch): Promise<boolean> {
  // Task4B checkout proof lives in the consumed helper; the wallet branches
  // below stay exactly unchanged.
  if (isCheckoutOperation(operation)) {
    return await validateCheckoutAccounting(ctx, operation);
  }
  const accounting = operation.accounting;
  if (
    accounting === undefined ||
    hasReceiptConflict(operation) ||
    !validTime(accounting.appliedAt) ||
    !validTime(operation.attemptedAt) ||
    !receiptMatchesIntent(operation, accounting.receipt, accounting.acquisition) ||
    !validAcquisition(operation, accounting.receipt, accounting.acquisition) ||
    operation.providerId !== accounting.receipt.id ||
    !(operation.acquisitions ?? []).some(
      (entry) =>
        stableStringify(entry) === stableStringify({ receipt: accounting.receipt, acquisition: accounting.acquisition })
    )
  ) {
    return false;
  }
  const providerId = accounting.receipt.id;
  const related = await relatedEvidence(ctx, operation, providerId);
  if (related.operations.some((row) => row._id !== operation._id)) {
    return false;
  }
  if (operation.kind === "top_up_collection") {
    const companion = related.companions[0];
    if (
      related.companions.length !== 1 ||
      companion === undefined ||
      !companionMatches(operation, companion, providerId) ||
      companion.lencoCollectionId !== providerId ||
      companion.completedAt !== accounting.appliedAt ||
      (accounting.kind !== "topup_credit" && accounting.kind !== "topup_failed") ||
      accounting.transactionId !== operation.transactionId
    ) {
      return false;
    }
    if (accounting.kind === "topup_failed") {
      return (
        operation.status === "failed" &&
        accounting.receipt.status === "failed" &&
        companion.status === "failed" &&
        related.ledgers.length === 0
      );
    }
    if (
      accounting.kind !== "topup_credit" ||
      operation.status !== "succeeded" ||
      accounting.receipt.status !== "successful" ||
      companion.status !== "successful"
    ) {
      return false;
    }
    const wallet = await ctx.db.get(accounting.walletId);
    const credit = related.ledgers[0];
    const owned = await ctx.db
      .query("wallets")
      .withIndex("by_user", (q) => q.eq("userId", operation.ownerId))
      .collect();
    return (
      wallet !== null &&
      wallet.userId === operation.ownerId &&
      owned.length === 1 &&
      walletMoneyValid(wallet) &&
      related.ledgers.length === 1 &&
      credit !== undefined &&
      credit._id === accounting.creditId &&
      creditMatches(
        operation,
        credit,
        wallet._id,
        "top_up_mobile_money",
        accounting.balanceAfterCents,
        accounting.appliedAt,
        providerId
      ) &&
      operation.receivedFunds?.receipt.id === providerId &&
      operation.receivedFunds.receipt.amountMinor === operation.amountCents
    );
  }
  if (accounting.kind !== "withdrawal_completed" && accounting.kind !== "withdrawal_reversed") {
    return false;
  }
  const wallet = await ctx.db.get(operation.walletId);
  const owned = await ctx.db
    .query("wallets")
    .withIndex("by_user", (q) => q.eq("userId", operation.ownerId))
    .collect();
  const debit = related.ledgers.find((row) => row._id === operation.walletTransactionId);
  if (
    !wallet ||
    owned.length !== 1 ||
    wallet.userId !== operation.ownerId ||
    !walletMoneyValid(wallet) ||
    !debit ||
    !debitMatches(operation, debit, providerId) ||
    related.companions.length !== 0 ||
    accounting.debitId !== debit._id ||
    debit.externalReference !== providerId ||
    debit.providerReference !== operation.providerReference ||
    debit.completedAt !== accounting.appliedAt
  ) {
    return false;
  }
  if (accounting.kind === "withdrawal_completed") {
    return (
      operation.status === "succeeded" &&
      accounting.receipt.status === "successful" &&
      debit.status === "completed" &&
      related.ledgers.length === 1
    );
  }
  const reversal = related.ledgers.find((row) => row._id === accounting.reversalId);
  return (
    operation.status === "failed" &&
    accounting.receipt.status === "failed" &&
    debit.status === "failed" &&
    related.ledgers.length === 2 &&
    reversal !== undefined &&
    creditMatches(
      operation,
      reversal,
      wallet._id,
      "withdrawal_reversal",
      accounting.balanceAfterCents,
      accounting.appliedAt,
      providerId
    )
  );
}

export const settleProviderReceipt = internalMutation({
  args: v.object({
    operationId: v.id("paymentOperations"),
    receipt: providerReceiptValidator,
    acquisition: receiptAcquisitionValidator,
  }),
  returns: settlementResultValidator,
  handler: async (ctx, args): Promise<SettlementResult> => {
    const operation = await ctx.db.get(args.operationId);
    if (!operation || operation.kind === "wallet_purchase") {
      return { operationId: args.operationId, status: "unknown", application: "unsupported" };
    }
    const receipt = args.receipt;
    const now = Date.now();
    const trusted = validTime(operation.attemptedAt) && validAcquisition(operation, receipt, args.acquisition);
    const matches = receiptMatchesIntent(operation, receipt, args.acquisition);
    const evidence = retainReceiptEvidence(operation, receipt, matches && trusted);
    const acquisitions = [...(operation.acquisitions ?? [])];
    const acquired = { receipt, acquisition: args.acquisition };
    if (!acquisitions.some((entry) => stableStringify(entry) === stableStringify(acquired))) {
      acquisitions.push(acquired);
    }
    const receivedFunds =
      operation.kind === "top_up_collection" || operation.kind === "checkout_collection"
        ? trusted && matches && receipt.status === "successful"
          ? (operation.receivedFunds ?? { ...acquired, receivedAt: now })
          : operation.receivedFunds
        : undefined;
    // Matching success funds are recorded before any hold or terminal
    // duplicate decision, including success after an earlier validated
    // failure or any terminal sibling. Evidence-only patches may commit
    // blocked results; business writes below never run on a held path.
    const evidenceBase: CheckoutEvidencePatch = {
      ...evidence,
      acquisitions,
      ...(receivedFunds === undefined ? {} : { receivedFunds }),
    };
    const patchEvidence = {
      ...evidenceBase,
      updatedAt: now,
    };
    const hold = async (): Promise<SettlementResult> => {
      await ctx.db.patch(operation._id, {
        ...patchEvidence,
        reviewNeeded: true,
        status:
          operation.status === "succeeded" || operation.status === "failed" || operation.status === "cancelled"
            ? operation.status
            : "unknown",
      });
      return { operationId: operation._id, status: "unknown", application: "review" };
    };
    if (
      !trusted ||
      !matches ||
      hasReceiptConflict(operation) ||
      (operation.providerId !== undefined && operation.providerId !== receipt.id)
    ) {
      return await hold();
    }
    if (operation.accounting !== undefined) {
      const valid = await validateProviderAccounting(ctx, operation);
      if (!valid || evidence.reviewNeeded === true) {
        return await hold();
      }
      await ctx.db.patch(operation._id, patchEvidence);
      return { operationId: operation._id, status: operation.status, application: "applied" };
    }
    if (
      evidence.reviewNeeded === true ||
      operation.status === "succeeded" ||
      operation.status === "failed" ||
      operation.status === "cancelled"
    ) {
      return await hold();
    }
    const related = await relatedEvidence(ctx, operation, receipt.id);
    if (related.operations.some((row) => row._id !== operation._id)) {
      return await hold();
    }
    // Task4B checkout branch through the same writer. Success captures the
    // already-reserved orders, escrows and discounts exactly once; trusted
    // failure releases exactly those reservations once. Unknown or pending
    // receipts never release stock, promo, or points.
    if (isCheckoutOperation(operation)) {
      if (receipt.status === "pending") {
        const companion = related.companions[0];
        const consistent =
          related.companions.length === 1 &&
          companion !== undefined &&
          checkoutCompanionMatches(operation, companion, receipt.id) &&
          companion.status === "pending" &&
          related.ledgers.length === 0;
        if (!consistent) {
          return await hold();
        }
        await ctx.db.patch(operation._id, { ...patchEvidence, status: "unknown" });
        return { operationId: operation._id, status: "unknown", application: "pending" };
      }
      const plan = await preflightCheckoutSettlement(ctx, operation, receipt);
      if (plan === null) {
        return await hold();
      }
      if (plan.branch === "capture") {
        await applyCheckoutCapture(ctx, operation, plan, {
          receipt,
          acquisition: args.acquisition,
          evidence: evidenceBase,
          now,
        });
        return { operationId: operation._id, status: "succeeded", application: "applied" };
      }
      await applyCheckoutRelease(ctx, operation, plan, {
        receipt,
        acquisition: args.acquisition,
        evidence: evidenceBase,
        now,
      });
      return { operationId: operation._id, status: "failed", application: "applied" };
    }
    if (receipt.status === "pending") {
      const companion = related.companions[0];
      const debit = related.ledgers[0];
      const consistent =
        operation.kind === "top_up_collection"
          ? related.companions.length === 1 &&
            companion !== undefined &&
            companionMatches(operation, companion, receipt.id) &&
            companion.status === "pending" &&
            related.ledgers.length === 0
          : related.companions.length === 0 &&
            related.ledgers.length === 1 &&
            debit !== undefined &&
            debitMatches(operation, debit, receipt.id) &&
            debit.status === "pending";
      if (!consistent) {
        return await hold();
      }
      await ctx.db.patch(operation._id, { ...patchEvidence, status: "unknown" });
      return { operationId: operation._id, status: "unknown", application: "pending" };
    }
    const amountMajor = centsToStoredMajor(operation.amountCents);
    if (amountMajor === null) {
      return await hold();
    }
    const ownedWallets = await ctx.db
      .query("wallets")
      .withIndex("by_user", (q) => q.eq("userId", operation.ownerId))
      .collect();
    if (operation.kind === "top_up_collection") {
      const companion = related.companions[0];
      if (
        related.companions.length !== 1 ||
        companion === undefined ||
        !companionMatches(operation, companion, receipt.id) ||
        companion.status !== "pending" ||
        related.ledgers.length !== 0
      ) {
        return await hold();
      }
      if (receipt.status === "failed") {
        await ctx.db.patch(companion._id, {
          status: "failed",
          lencoCollectionId: receipt.id,
          completedAt: now,
          updatedAt: now,
        });
        await ctx.db.patch(operation._id, {
          ...patchEvidence,
          status: "failed",
          accounting: {
            kind: "topup_failed",
            ...acquired,
            appliedAt: now,
            transactionId: companion._id,
          },
        });
        return { operationId: operation._id, status: "failed", application: "applied" };
      }
      if (ownedWallets.length > 1) {
        return await hold();
      }
      const wallet = ownedWallets[0];
      if (wallet !== undefined && !walletMoneyValid(wallet)) {
        return await hold();
      }
      const owner = await ctx.db.get(operation.ownerId);
      if (
        !owner ||
        (wallet === undefined && (owner.isBanned || owner.isDeleted === true || owner.deletedAt !== undefined))
      ) {
        return await hold();
      }
      const oldBalance = wallet === undefined ? 0 : majorNumberToCents(wallet.balance);
      const balanceCents = oldBalance === null ? null : checkedAdd(oldBalance, operation.amountCents);
      const balanceMajor = balanceCents === null ? null : centsToStoredMajor(balanceCents);
      if (balanceCents === null || balanceMajor === null) {
        return await hold();
      }
      // All business validation and conversion precedes the first money write.
      const walletId =
        wallet?._id ??
        (await ctx.db.insert("wallets", {
          userId: operation.ownerId,
          balance: 0,
          pendingBalance: 0,
          totalEarned: 0,
          totalSpent: 0,
          totalWithdrawn: 0,
          isActive: true,
          isFrozen: false,
          createdAt: now,
          updatedAt: now,
        }));
      await ctx.db.patch(walletId, { balance: balanceMajor, lastTransactionAt: now, updatedAt: now });
      const creditId = await ctx.db.insert("walletTransactions", {
        walletId,
        userId: operation.ownerId,
        operationId: operation._id,
        type: "credit",
        source: "top_up_mobile_money",
        amount: amountMajor,
        balanceAfter: balanceMajor,
        reference: operation.providerReference,
        providerReference: operation.providerReference,
        externalReference: receipt.id,
        status: "completed",
        description: "Trusted mobile-money top-up.",
        createdAt: now,
        completedAt: now,
        updatedAt: now,
      });
      await ctx.db.patch(companion._id, {
        status: "successful",
        lencoCollectionId: receipt.id,
        completedAt: now,
        updatedAt: now,
      });
      await ctx.db.patch(operation._id, {
        ...patchEvidence,
        status: "succeeded",
        accounting: {
          kind: "topup_credit",
          ...acquired,
          appliedAt: now,
          transactionId: companion._id,
          walletId,
          creditId,
          balanceAfterCents: balanceCents,
        },
      });
      return { operationId: operation._id, status: "succeeded", application: "applied" };
    }
    const wallet = ownedWallets[0];
    const debit = related.ledgers[0];
    if (
      ownedWallets.length !== 1 ||
      wallet === undefined ||
      wallet._id !== operation.walletId ||
      !walletMoneyValid(wallet) ||
      related.ledgers.length !== 1 ||
      debit === undefined ||
      !debitMatches(operation, debit, receipt.id) ||
      debit.status !== "pending" ||
      related.companions.length !== 0
    ) {
      return await hold();
    }
    // Novel accounting needs the actual beneficiary; retained tombstones
    // remain owed funds without restoring their wallet or account access.
    const owner = await ctx.db.get(operation.ownerId);
    if (!owner) {
      return await hold();
    }
    if (receipt.status === "successful") {
      await ctx.db.patch(debit._id, {
        status: "completed",
        externalReference: receipt.id,
        providerReference: operation.providerReference,
        completedAt: now,
        updatedAt: now,
      });
      await ctx.db.patch(operation._id, {
        ...patchEvidence,
        status: "succeeded",
        accounting: {
          kind: "withdrawal_completed",
          ...acquired,
          appliedAt: now,
          debitId: debit._id,
        },
      });
      return { operationId: operation._id, status: "succeeded", application: "applied" };
    }
    const balance = majorNumberToCents(wallet.balance);
    const withdrawn = majorNumberToCents(wallet.totalWithdrawn);
    const balanceCents = balance === null ? null : checkedAdd(balance, operation.debitAmountCents);
    const withdrawnCents =
      withdrawn === null || withdrawn < operation.debitAmountCents ? null : withdrawn - operation.debitAmountCents;
    const balanceMajor = balanceCents === null ? null : centsToStoredMajor(balanceCents);
    const withdrawnMajor = withdrawnCents === null ? null : centsToStoredMajor(withdrawnCents);
    if (balanceCents === null || balanceMajor === null || withdrawnMajor === null) {
      return await hold();
    }
    await ctx.db.patch(wallet._id, {
      balance: balanceMajor,
      totalWithdrawn: withdrawnMajor,
      lastTransactionAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(debit._id, {
      status: "failed",
      externalReference: receipt.id,
      providerReference: operation.providerReference,
      completedAt: now,
      updatedAt: now,
    });
    const reversalId = await ctx.db.insert("walletTransactions", {
      walletId: wallet._id,
      userId: operation.ownerId,
      operationId: operation._id,
      paymentAccountId: operation.paymentAccountId,
      reversalOfId: debit._id,
      type: "credit",
      source: "withdrawal_reversal",
      amount: amountMajor,
      balanceAfter: balanceMajor,
      reference: operation.providerReference,
      providerReference: operation.providerReference,
      externalReference: receipt.id,
      status: "completed",
      description: "Trusted failed-withdrawal reversal.",
      createdAt: now,
      completedAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(operation._id, {
      ...patchEvidence,
      status: "failed",
      accounting: {
        kind: "withdrawal_reversed",
        ...acquired,
        appliedAt: now,
        debitId: debit._id,
        reversalId,
        balanceAfterCents: balanceCents,
      },
    });
    return { operationId: operation._id, status: "failed", application: "applied" };
  },
});
