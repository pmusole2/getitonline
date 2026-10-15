import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { centsToStoredMajor, checkedAdd, majorNumberToCents } from "./catalogMoney";
import { validateCheckoutAccounting } from "./checkoutSettlement";
import { metadataNamesCheckoutOrder } from "./checkoutReservations";
import { requireWalletFundingProof } from "./fundingProof";
import { PurchaseError } from "./paymentOperationContracts";

type ReadCtx = Pick<QueryCtx | MutationCtx, "db">;

class EscrowValidationError extends Error {
  constructor(message: "Escrow funding needs review" | "Invalid refund amount") {
    super(message);
  }
}

type Proof = NonNullable<Doc<"escrow">["lifecycleProof"]>;
type Kind = Proof["kind"];
type Applied = Extract<Proof["state"], { kind: "applied" }>;
type Operation = Extract<Doc<"paymentOperations">, { kind: "wallet_purchase" | "checkout_collection" }>;
// Private source context: resource documents and the action, never caller IDs
// or a public verified flag. The writer rechecks its authoritative association.
export type DisputeAccountingContext =
  | {
      kind: "reviewer_dispute";
      dispute: Doc<"disputes">;
      resolutionType: "full_refund" | "partial_refund" | "no_refund";
    }
  | {
      kind: "buyer_dispute";
      dispute: Doc<"disputes">;
      resolutionType: "withdraw" | "received_item" | "issue_resolved";
    };
type DisputeOrigin = NonNullable<Proof["disputeOrigin"]>;
type Recipient = "buyer" | "seller";
type Credit = { recipient: Recipient; userId: Id<"users">; cents: number };
type WalletPlan = { ownerId: Id<"users">; wallet: Doc<"wallets"> | null; balance: number; earned: number };
type EffectPlan = Credit & { wallet: WalletPlan; balanceBeforeCents: number; balanceAfterCents: number };
export type EscrowAccountingResult = {
  escrow: Doc<"escrow">;
  application: "applied" | "review";
  newlyApplied: boolean;
};

function validTime(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function major(cents: number): number {
  const value = centsToStoredMajor(cents);
  if (value === null) {
    throw new Error("Escrow accounting invariant: unrepresentable amount");
  }
  return value;
}

function reference(escrow: Doc<"escrow">, recipient: Recipient): string {
  return `ESC-${escrow._id}-${recipient}`;
}

function statusFor(kind: Kind): Doc<"escrow">["status"] {
  return kind === "release" ? "released" : kind === "full_refund" ? "refunded" : "partially_refunded";
}

function credits(escrow: Doc<"escrow">, proof: Proof): Credit[] {
  const result: Credit[] = [];
  if (proof.refundCents > 0) {
    result.push({ recipient: "buyer", userId: escrow.buyerId, cents: proof.refundCents });
  }
  if (proof.sellerCents > 0) {
    result.push({ recipient: "seller", userId: escrow.sellerId, cents: proof.sellerCents });
  }
  return result;
}

function economicOutcome(
  escrow: Doc<"escrow">,
  kind: Kind,
  requested?: number
): {
  grossCents: number;
  refundCents: number;
  sellerCents: number;
  retainedPlatformCents: number;
} {
  const gross = majorNumberToCents(escrow.grossAmount);
  const seller = majorNumberToCents(escrow.sellerAmount);
  const fee = majorNumberToCents(escrow.platformFee);
  if (
    gross === null ||
    seller === null ||
    fee === null ||
    checkedAdd(seller, fee) !== gross ||
    majorNumberToCents(escrow.amount) !== gross
  ) {
    throw new EscrowValidationError("Escrow funding needs review");
  }
  const requestedCents = requested === undefined ? null : majorNumberToCents(requested);
  if (kind === "partial_refund" && (requestedCents === null || requestedCents <= 0 || requestedCents > gross)) {
    throw new EscrowValidationError("Invalid refund amount");
  }
  const refundCents = kind === "release" ? 0 : kind === "full_refund" ? gross : requestedCents;
  if (refundCents === null) {
    throw new EscrowValidationError("Invalid refund amount");
  }
  const sellerCents = kind === "release" ? seller : kind === "full_refund" ? 0 : Math.max(0, seller - refundCents);
  const retainedPlatformCents = gross - refundCents - sellerCents;
  if ([refundCents, sellerCents, retainedPlatformCents].some((value) => centsToStoredMajor(value) === null)) {
    throw new EscrowValidationError("Escrow funding needs review");
  }
  return { grossCents: gross, refundCents, sellerCents, retainedPlatformCents };
}

async function disputeAssociation(
  ctx: ReadCtx,
  escrow: Doc<"escrow">,
  disputeId: Id<"disputes">
): Promise<{ dispute: Doc<"disputes">; order: Doc<"orders"> } | null> {
  const dispute = await ctx.db.get(disputeId);
  const order = await ctx.db.get(escrow.orderId);
  const disputes = await ctx.db
    .query("disputes")
    .withIndex("by_order", (q) => q.eq("orderId", escrow.orderId))
    .collect();
  const escrows = await ctx.db
    .query("escrow")
    .withIndex("by_order", (q) => q.eq("orderId", escrow.orderId))
    .collect();
  if (
    !dispute ||
    !order ||
    dispute.orderId !== order._id ||
    dispute.escrowId !== escrow._id ||
    order.buyerId !== escrow.buyerId ||
    order.sellerId !== escrow.sellerId ||
    dispute.buyerId !== escrow.buyerId ||
    dispute.sellerId !== escrow.sellerId ||
    disputes.length !== 1 ||
    disputes[0]?._id !== dispute._id ||
    escrows.length !== 1 ||
    escrows[0]?._id !== escrow._id
  ) {
    return null;
  }
  return { dispute, order };
}

function originKind(origin: DisputeOrigin): Kind {
  return origin.kind === "buyer_dispute" || origin.resolutionType === "no_refund" ? "release" : origin.resolutionType;
}

async function disputeProofValid(ctx: ReadCtx, escrow: Doc<"escrow">, proof: Proof): Promise<boolean> {
  const origin = proof.disputeOrigin;
  if (!origin) {
    return proof.kind !== "release" || (proof.approvedBy === escrow.buyerId && proof.originalStatus === "held");
  }
  if (
    originKind(origin) !== proof.kind ||
    (origin.kind === "buyer_dispute"
      ? proof.approvedBy !== escrow.buyerId
      : origin.role !== "moderator" && origin.role !== "admin")
  ) {
    return false;
  }
  const association = await disputeAssociation(ctx, escrow, origin.disputeId);
  if (!association) {
    return false;
  }
  const { dispute, order } = association;
  if (proof.state.kind === "pending") {
    return (
      ["open", "in_discussion", "moderator_review"].includes(dispute.status) &&
      dispute.resolution === undefined &&
      order.status === "disputed"
    );
  }
  const resolution = dispute.resolution;
  return (
    (dispute.status === "resolved" || dispute.status === "closed") &&
    resolution !== undefined &&
    resolution.type === (origin.kind === "buyer_dispute" ? "mutual_agreement" : origin.resolutionType) &&
    (proof.kind === "release"
      ? resolution.refundAmount === undefined
      : majorNumberToCents(resolution.refundAmount ?? NaN) === proof.refundCents) &&
    validTime(resolution.resolvedAt) &&
    resolution.resolvedAt >= proof.state.appliedAt &&
    (origin.kind !== "buyer_dispute" || resolution.resolvedBy === escrow.buyerId) &&
    order.status === (proof.kind === "full_refund" ? "cancelled" : "completed")
  );
}

async function decisionMatches(
  ctx: ReadCtx,
  escrow: Doc<"escrow">,
  operation: Operation,
  proof: Proof
): Promise<boolean> {
  if (
    proof.operationId !== operation._id ||
    proof.quoteKey !== operation.quoteKey ||
    proof.buyerId !== escrow.buyerId ||
    proof.sellerId !== escrow.sellerId ||
    !validTime(proof.approvedAt) ||
    proof.approvedAt > Date.now() ||
    typeof proof.approvedBy !== "string" ||
    proof.approvedBy.length === 0 ||
    (proof.state.kind !== "pending" && proof.state.kind !== "applied") ||
    (proof.state.kind === "pending" &&
      proof.state.reason !== "beneficiary_review" &&
      proof.state.reason !== "effect_review") ||
    (proof.originalStatus !== "held" && proof.originalStatus !== "disputed") ||
    !(await disputeProofValid(ctx, escrow, proof))
  ) {
    return false;
  }
  if (proof.kind !== "release" && proof.kind !== "full_refund" && proof.kind !== "partial_refund") {
    return false;
  }
  try {
    const expected = economicOutcome(escrow, proof.kind, centsToStoredMajor(proof.refundCents) ?? undefined);
    return (
      expected.grossCents === proof.grossCents &&
      expected.refundCents === proof.refundCents &&
      expected.sellerCents === proof.sellerCents &&
      expected.retainedPlatformCents === proof.retainedPlatformCents
    );
  } catch (error) {
    if (error instanceof EscrowValidationError) {
      return false;
    }
    throw error;
  }
}

async function funding(
  ctx: ReadCtx,
  escrow: Doc<"escrow">
): Promise<{ operation: Operation; originalLedgerId?: Id<"walletTransactions"> }> {
  const operation = escrow.operationId === undefined ? null : await ctx.db.get(escrow.operationId);
  const holds = await ctx.db
    .query("escrow")
    .withIndex("by_order", (q) => q.eq("orderId", escrow.orderId))
    .collect();
  if (!operation || holds.length !== 1 || holds[0]?._id !== escrow._id || operation.ownerId !== escrow.buyerId) {
    throw new EscrowValidationError("Escrow funding needs review");
  }
  if (operation.kind === "wallet_purchase") {
    try {
      return { operation, originalLedgerId: await requireWalletFundingProof(ctx, operation) };
    } catch (error) {
      if (error instanceof PurchaseError) {
        throw new EscrowValidationError("Escrow funding needs review");
      }
      throw error;
    }
  }
  if (
    operation.kind === "checkout_collection" &&
    operation.accounting?.kind === "checkout_captured" &&
    operation.amountCents > 0 &&
    (await validateCheckoutAccounting(ctx, operation))
  ) {
    return { operation };
  }
  throw new EscrowValidationError("Escrow funding needs review");
}

// Replay checks recorded reciprocal effects, never a terminal label or today's
// spendable balance. Original funding is validated separately before this call.
async function appliedProofValid(ctx: ReadCtx, escrow: Doc<"escrow">, operation: Operation): Promise<boolean> {
  const proof = escrow.lifecycleProof;
  if (!proof || !(await decisionMatches(ctx, escrow, operation, proof)) || proof.state.kind !== "applied") {
    return false;
  }
  const state = proof.state;
  if (
    !validTime(state.appliedAt) ||
    state.appliedAt < proof.approvedAt ||
    escrow.status !== statusFor(proof.kind) ||
    escrow.updatedAt !== state.appliedAt ||
    escrow.sellerPayoutTransactionId !== undefined
  ) {
    return false;
  }
  if (
    proof.kind === "release"
      ? escrow.refundAmount !== undefined
      : majorNumberToCents(escrow.refundAmount ?? NaN) !== proof.refundCents
  ) {
    return false;
  }
  if (proof.kind === "full_refund" ? escrow.releasedAt !== undefined : escrow.releasedAt !== state.appliedAt) {
    return false;
  }
  const expected = credits(escrow, proof);
  if (
    state.effects.length !== expected.length ||
    new Set(state.effects.map((effect) => effect.ledgerId)).size !== state.effects.length
  ) {
    return false;
  }
  for (const [index, credit] of expected.entries()) {
    const effect = state.effects[index];
    if (
      !effect ||
      effect.recipient !== credit.recipient ||
      effect.cents !== credit.cents ||
      checkedAdd(effect.balanceBeforeCents, effect.cents) !== effect.balanceAfterCents ||
      centsToStoredMajor(effect.balanceAfterCents) === null
    ) {
      return false;
    }
    const ledger = await ctx.db.get(effect.ledgerId);
    const byReference = await ctx.db
      .query("walletTransactions")
      .withIndex("by_reference", (q) => q.eq("reference", reference(escrow, credit.recipient)))
      .collect();
    if (
      !ledger ||
      byReference.length !== 1 ||
      byReference[0]?._id !== ledger._id ||
      ledger.walletId !== effect.walletId ||
      ledger.userId !== credit.userId ||
      ledger.operationId !== operation._id ||
      ledger.orderId !== escrow.orderId ||
      ledger.escrowId !== escrow._id ||
      ledger.status !== "completed" ||
      ledger.type !== (credit.recipient === "buyer" ? "refund" : "credit") ||
      ledger.source !== (credit.recipient === "buyer" ? "refund" : "escrow_release") ||
      ledger.reference !== reference(escrow, credit.recipient) ||
      majorNumberToCents(ledger.amount) !== effect.cents ||
      majorNumberToCents(ledger.balanceAfter) !== effect.balanceAfterCents ||
      ledger.createdAt !== state.appliedAt ||
      ledger.completedAt !== state.appliedAt ||
      ledger.updatedAt !== state.appliedAt ||
      ledger.paymentAccountId !== undefined ||
      ledger.reversalOfId !== undefined ||
      ledger.providerReference !== undefined ||
      ledger.externalReference !== undefined
    ) {
      return false;
    }
    const wallet = await ctx.db.get(effect.walletId);
    const owned = await ctx.db
      .query("wallets")
      .withIndex("by_user", (q) => q.eq("userId", credit.userId))
      .collect();
    if (!wallet || wallet.userId !== credit.userId || owned.length !== 1 || owned[0]?._id !== wallet._id) {
      return false;
    }
    const previous = state.effects[index - 1];
    if (previous?.walletId === effect.walletId && previous.balanceAfterCents !== effect.balanceBeforeCents) {
      return false;
    }
  }
  if (proof.kind === "release") {
    const counts = state.counts;
    const buyer = await ctx.db.get(escrow.buyerId);
    const seller = await ctx.db.get(escrow.sellerId);
    const buyerAfter = counts === undefined ? null : checkedAdd(counts.buyerBefore, 1);
    const sellerAfter = counts === undefined ? null : checkedAdd(counts.sellerBefore, 1);
    if (
      !counts ||
      buyerAfter === null ||
      sellerAfter === null ||
      !buyer ||
      !seller ||
      !Number.isSafeInteger(buyer.totalPurchases) ||
      buyer.totalPurchases < buyerAfter ||
      !Number.isSafeInteger(seller.totalSales) ||
      seller.totalSales < sellerAfter
    ) {
      return false;
    }
    const order = await ctx.db.get(escrow.orderId);
    if (order?.status !== "completed") {
      return false;
    }
  } else if (state.counts !== undefined) {
    return false;
  }
  return true;
}

// Union authoritative links and participant-owned metadata candidates. Foreign
// owners remain visible through operation/order/escrow/reference links. These
// reads exclude unrelated merchants, but participant history can still be large.
async function financialEvidence(
  ctx: ReadCtx,
  operation: Operation,
  escrows: Doc<"escrow">[]
): Promise<{ rows: Doc<"walletTransactions">[]; transactions: Doc<"transactions">[] }> {
  const rows = new Map<Id<"walletTransactions">, Doc<"walletTransactions">>();
  const transactions = new Map<Id<"transactions">, Doc<"transactions">>();
  const addRows = (items: Doc<"walletTransactions">[]): void => {
    for (const item of items) {
      rows.set(item._id, item);
    }
  };
  const addTransactions = (items: Doc<"transactions">[]): void => {
    for (const item of items) {
      transactions.set(item._id, item);
    }
  };
  addRows(
    await ctx.db
      .query("walletTransactions")
      .withIndex("by_operation", (q) => q.eq("operationId", operation._id))
      .collect()
  );
  addTransactions(
    await ctx.db
      .query("transactions")
      .withIndex("by_operation", (q) => q.eq("operationId", operation._id))
      .collect()
  );
  for (const orderId of new Set(operation.orderIds)) {
    addRows(
      await ctx.db
        .query("walletTransactions")
        .withIndex("by_order", (q) => q.eq("orderId", orderId))
        .collect()
    );
    addTransactions(
      await ctx.db
        .query("transactions")
        .withIndex("by_order", (q) => q.eq("orderId", orderId))
        .collect()
    );
  }
  for (const escrow of escrows) {
    addRows(
      await ctx.db
        .query("walletTransactions")
        .withIndex("by_escrow", (q) => q.eq("escrowId", escrow._id))
        .collect()
    );
  }
  for (const userId of new Set(escrows.flatMap((escrow) => [escrow.buyerId, escrow.sellerId]))) {
    addRows(
      await ctx.db
        .query("walletTransactions")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect()
    );
    addTransactions(
      await ctx.db
        .query("transactions")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect()
    );
  }
  const references = new Set([
    operation.kind === "wallet_purchase" ? operation.walletReference : operation.providerReference,
    ...escrows.flatMap((escrow) => [reference(escrow, "buyer"), reference(escrow, "seller")]),
  ]);
  for (const value of references) {
    addRows(
      await ctx.db
        .query("walletTransactions")
        .withIndex("by_reference", (q) => q.eq("reference", value))
        .collect()
    );
    addTransactions(
      await ctx.db
        .query("transactions")
        .withIndex("by_reference", (q) => q.eq("reference", value))
        .collect()
    );
  }
  return { rows: [...rows.values()], transactions: [...transactions.values()] };
}

// Inspect raw linked legacy evidence too, including escrow-only links without
// orderId. Original purchase debit / captured provider companion remain intact.
// A sibling may share the funding operation only with a validated applied proof.
async function effectsClear(
  ctx: ReadCtx,
  operation: Operation,
  originalLedgerId?: Id<"walletTransactions">
): Promise<boolean> {
  const escrows = await ctx.db
    .query("escrow")
    .withIndex("by_operation", (q) => q.eq("operationId", operation._id))
    .collect();
  const { rows, transactions } = await financialEvidence(ctx, operation, escrows);
  const expected = new Set<Id<"walletTransactions">>();
  if (originalLedgerId !== undefined) {
    expected.add(originalLedgerId);
  }
  for (const escrow of escrows) {
    if (escrow.sellerPayoutTransactionId !== undefined) {
      return false;
    }
    if (escrow.lifecycleProof !== undefined) {
      if (!(await decisionMatches(ctx, escrow, operation, escrow.lifecycleProof))) {
        return false;
      }
      if (escrow.lifecycleProof.state.kind === "applied") {
        if (!(await appliedProofValid(ctx, escrow, operation))) {
          return false;
        }
        for (const effect of escrow.lifecycleProof.state.effects) {
          if (expected.has(effect.ledgerId)) {
            return false;
          }
          expected.add(effect.ledgerId);
        }
      } else if (escrow.status !== escrow.lifecycleProof.originalStatus) {
        return false;
      }
    } else if (escrow.status !== "held" && escrow.status !== "disputed") {
      return false;
    }
    if (
      escrow.lifecycleProof?.state.kind !== "applied" &&
      (escrow.refundAmount !== undefined || escrow.releasedAt !== undefined)
    ) {
      return false;
    }
  }
  const orderIds = new Set(operation.orderIds);
  const escrowIds = new Set(escrows.map((escrow) => escrow._id));
  const owners = new Set(escrows.flatMap((escrow) => [escrow.buyerId, escrow.sellerId]));
  if (
    rows.some(
      (row) =>
        (row.operationId === operation._id ||
          (row.orderId !== undefined && orderIds.has(row.orderId)) ||
          (row.escrowId !== undefined && escrowIds.has(row.escrowId)) ||
          (owners.has(row.userId) && metadataNamesCheckoutOrder(row.metadata, orderIds))) &&
        !expected.has(row._id)
    )
  ) {
    return false;
  }
  const companionId = operation.kind === "checkout_collection" ? operation.transactionId : undefined;
  if (
    transactions.some(
      (row) =>
        (row.operationId === operation._id ||
          (row.orderId !== undefined && orderIds.has(row.orderId)) ||
          (owners.has(row.userId) && metadataNamesCheckoutOrder(row.metadata, orderIds))) &&
        row._id !== companionId
    )
  ) {
    return false;
  }
  return true;
}

// Consumed admin read projection. Original funding, exact effects, sibling
// evidence and historical decision origin use the same validators as replay.
// Expected malformed financial evidence is review; storage faults propagate.
export type EscrowFinancialProjection =
  | { state: "review" }
  | {
      state: "held" | "pending" | "applied";
      grossCents: number;
      heldCents: number;
      sellerCents: number;
      refundCents: number;
      earnedCents: number;
    };

export async function projectEscrowFinancials(ctx: ReadCtx, escrow: Doc<"escrow">): Promise<EscrowFinancialProjection> {
  try {
    const economics = economicOutcome(escrow, "release");
    const { operation, originalLedgerId } = await funding(ctx, escrow);
    if (economics.grossCents === 0 || !(await effectsClear(ctx, operation, originalLedgerId))) {
      return { state: "review" };
    }
    const proof = escrow.lifecycleProof;
    if (proof?.state.kind === "applied") {
      return {
        state: "applied",
        grossCents: proof.grossCents,
        heldCents: 0,
        sellerCents: proof.sellerCents,
        refundCents: proof.refundCents,
        earnedCents: proof.retainedPlatformCents,
      };
    }
    if (proof === undefined) {
      // Gross funding does not make contradictory legacy business markers healthy.
      // Applied/pending historical decisions remain governed by the shared proof.
      const order = await ctx.db.get(escrow.orderId);
      if (
        !order ||
        order.status === "pending_payment" ||
        order.status === "completed" ||
        order.status === "cancelled" ||
        (escrow.status === "disputed") !== (order.status === "disputed")
      ) {
        return { state: "review" };
      }
      if (escrow.status === "disputed") {
        const disputes = await ctx.db
          .query("disputes")
          .withIndex("by_order", (q) => q.eq("orderId", escrow.orderId))
          .collect();
        const dispute = disputes[0];
        if (
          disputes.length !== 1 ||
          !dispute ||
          !(await disputeAssociation(ctx, escrow, dispute._id)) ||
          !["open", "in_discussion", "moderator_review"].includes(dispute.status) ||
          dispute.resolution !== undefined
        ) {
          return { state: "review" };
        }
      }
    }
    if (operation.kind === "checkout_collection" && operation.reviewNeeded === true) {
      return { state: "review" };
    }
    return {
      state: proof === undefined ? "held" : "pending",
      grossCents: economics.grossCents,
      heldCents: economics.grossCents,
      sellerCents: 0,
      refundCents: 0,
      earnedCents: 0,
    };
  } catch (error) {
    if (error instanceof EscrowValidationError) {
      return { state: "review" };
    }
    throw error;
  }
}

async function prepareCredits(
  ctx: MutationCtx,
  escrow: Doc<"escrow">,
  proof: Proof
): Promise<{ wallets: WalletPlan[]; effects: EffectPlan[] } | null> {
  const wallets = new Map<Id<"users">, WalletPlan>();
  const effects: EffectPlan[] = [];
  for (const credit of credits(escrow, proof)) {
    let plan = wallets.get(credit.userId);
    if (!plan) {
      const owner = await ctx.db.get(credit.userId);
      if (!owner) {
        return null;
      }
      const owned = await ctx.db
        .query("wallets")
        .withIndex("by_user", (q) => q.eq("userId", credit.userId))
        .collect();
      if (owned.length > 1) {
        return null;
      }
      const wallet = owned[0] ?? null;
      if (wallet) {
        const pointed = await ctx.db.get(wallet._id);
        if (
          !pointed ||
          pointed.userId !== credit.userId ||
          wallet.userId !== credit.userId ||
          typeof wallet.isActive !== "boolean" ||
          typeof wallet.isFrozen !== "boolean" ||
          [wallet.balance, wallet.pendingBalance, wallet.totalEarned, wallet.totalSpent, wallet.totalWithdrawn].some(
            (amount) => majorNumberToCents(amount) === null
          )
        ) {
          return null;
        }
      } else if (owner.isBanned !== false || owner.deletedAt !== undefined || owner.isDeleted === true) {
        return null;
      }
      const balance = wallet ? majorNumberToCents(wallet.balance) : 0;
      const earned = wallet ? majorNumberToCents(wallet.totalEarned) : 0;
      if (balance === null || earned === null) {
        return null;
      }
      plan = { ownerId: credit.userId, wallet, balance, earned };
      wallets.set(credit.userId, plan);
    }
    const balanceBeforeCents = plan.balance;
    const balanceAfterCents = checkedAdd(plan.balance, credit.cents);
    const earned = credit.recipient === "seller" ? checkedAdd(plan.earned, credit.cents) : plan.earned;
    if (
      balanceAfterCents === null ||
      earned === null ||
      centsToStoredMajor(balanceAfterCents) === null ||
      centsToStoredMajor(earned) === null
    ) {
      return null;
    }
    plan.balance = balanceAfterCents;
    plan.earned = earned;
    effects.push({ ...credit, wallet: plan, balanceBeforeCents, balanceAfterCents });
  }
  return { wallets: [...wallets.values()], effects };
}

async function result(
  ctx: MutationCtx,
  escrowId: Id<"escrow">,
  application: "applied" | "review",
  newlyApplied = false
): Promise<EscrowAccountingResult> {
  const escrow = await ctx.db.get(escrowId);
  if (!escrow) {
    throw new Error("Escrow accounting invariant: escrow disappeared");
  }
  return { escrow, application, newlyApplied };
}

// Private, nonregistered, same-MutationCtx writer consumed by the existing
// internal wrappers. The actor is already verified by their auth guards.
export async function applyEscrowAccounting(
  ctx: MutationCtx,
  escrow: Doc<"escrow">,
  actor: Doc<"users">,
  kind: Kind,
  refundAmount?: number,
  disputeContext?: DisputeAccountingContext
): Promise<EscrowAccountingResult> {
  let disputeOrigin: DisputeOrigin | undefined;
  if (disputeContext) {
    if (actor.isBanned !== false || actor.deletedAt !== undefined || actor.isDeleted === true) {
      throw new Error("Unauthorized");
    }
    const association = await disputeAssociation(ctx, escrow, disputeContext.dispute._id);
    if (!association) {
      throw new Error("Dispute records need review");
    }
    const { dispute, order } = association;
    if (disputeContext.kind === "reviewer_dispute") {
      if (actor.role !== "moderator" && actor.role !== "admin") {
        throw new Error("Unauthorized");
      }
      disputeOrigin = {
        kind: disputeContext.kind,
        disputeId: dispute._id,
        resolutionType: disputeContext.resolutionType,
        role: actor.role,
      };
    } else {
      if (actor._id !== dispute.buyerId) {
        throw new Error("Unauthorized");
      }
      disputeOrigin = {
        kind: disputeContext.kind,
        disputeId: dispute._id,
        resolutionType: disputeContext.resolutionType,
      };
    }
    if (originKind(disputeOrigin) !== kind) {
      throw new Error("Escrow decision conflicts with the immutable approved decision");
    }
    if (
      escrow.lifecycleProof?.state.kind !== "applied" &&
      (!["open", "in_discussion", "moderator_review"].includes(dispute.status) ||
        dispute.resolution !== undefined ||
        order.status !== "disputed")
    ) {
      throw new Error("Dispute records need review");
    }
  }
  const economics = economicOutcome(escrow, kind, refundAmount);
  const { operation, originalLedgerId } = await funding(ctx, escrow);
  const existing = escrow.lifecycleProof;
  if (
    existing &&
    (existing.kind !== kind ||
      existing.refundCents !== economics.refundCents ||
      existing.disputeOrigin?.kind !== disputeOrigin?.kind ||
      existing.disputeOrigin?.disputeId !== disputeOrigin?.disputeId ||
      existing.disputeOrigin?.resolutionType !== disputeOrigin?.resolutionType)
  ) {
    throw new Error("Escrow decision conflicts with the immutable approved decision");
  }
  if (existing && !(await decisionMatches(ctx, escrow, operation, existing))) {
    return await result(ctx, escrow._id, "review");
  }
  if (existing?.state.kind === "applied") {
    return await result(ctx, escrow._id, (await effectsClear(ctx, operation, originalLedgerId)) ? "applied" : "review");
  }
  // Sticky source review blocks novel and pending effects. It does not destroy
  // intrinsic original funding for a fully validated, already-applied replay.
  // An applied-looking but invalid marker returns review above, never new money.
  if (operation.kind === "checkout_collection" && operation.reviewNeeded === true) {
    throw new Error("Escrow funding needs review");
  }
  if (escrow.status !== "held" && escrow.status !== "disputed") {
    // Historical terminal status never authorizes either repeat money or
    // retroactive approval/effect proof. Separately authorized reconciliation.
    return await result(ctx, escrow._id, "review");
  }
  const order = await ctx.db.get(escrow.orderId);
  if (!order || order.buyerId !== escrow.buyerId || order.sellerId !== escrow.sellerId) {
    throw new Error("Escrow funding needs review");
  }
  if (kind === "release" && disputeContext === undefined) {
    if (actor._id !== escrow.buyerId) {
      throw new Error("Unauthorized");
    }
    if (escrow.status !== "held" || order.status !== "delivered") {
      throw new Error("Order must be delivered with held escrow");
    }
  }
  const now = Date.now();
  const proof: Proof = existing ?? {
    kind,
    operationId: operation._id,
    quoteKey: operation.quoteKey,
    buyerId: escrow.buyerId,
    sellerId: escrow.sellerId,
    ...economics,
    approvedBy: actor._id,
    approvedAt: now,
    originalStatus: escrow.status,
    ...(disputeOrigin === undefined ? {} : { disputeOrigin }),
    state: { kind: "pending", reason: "effect_review" },
  };
  const clear = await effectsClear(ctx, operation, originalLedgerId);
  let referencesClear = true;
  for (const credit of credits(escrow, proof)) {
    if (
      (
        await ctx.db
          .query("walletTransactions")
          .withIndex("by_reference", (q) => q.eq("reference", reference(escrow, credit.recipient)))
          .collect()
      ).length !== 0
    ) {
      referencesClear = false;
    }
  }
  const prepared = clear && referencesClear ? await prepareCredits(ctx, escrow, proof) : null;
  let counts: Applied["counts"];
  let buyerAfter: number | null = null;
  let sellerAfter: number | null = null;
  if (kind === "release") {
    const buyer = await ctx.db.get(escrow.buyerId);
    const seller = await ctx.db.get(escrow.sellerId);
    buyerAfter = buyer ? checkedAdd(buyer.totalPurchases, 1) : null;
    sellerAfter = seller ? checkedAdd(seller.totalSales, 1) : null;
    if (buyer && seller && buyerAfter !== null && sellerAfter !== null) {
      counts = { buyerBefore: buyer.totalPurchases, sellerBefore: seller.totalSales };
    }
  }
  if (!prepared || (kind === "release" && counts === undefined)) {
    if (!existing) {
      await ctx.db.patch(escrow._id, {
        lifecycleProof: {
          ...proof,
          state: { kind: "pending", reason: clear && referencesClear ? "beneficiary_review" : "effect_review" },
        },
      });
    }
    // Successful return persists ONLY the immutable approval. No patch-then-
    // throw, wallet creation, state/counter/stock/dispute/notice partial commit.
    return await result(ctx, escrow._id, "review");
  }
  // All recipients, counters, references and effects have been preflighted.
  // Transactional atomicity/OCC is Convex's runtime contract, not a fake claim.
  const walletIds = new Map<Id<"users">, Id<"wallets">>();
  for (const plan of prepared.wallets) {
    const walletId =
      plan.wallet?._id ??
      (await ctx.db.insert("wallets", {
        userId: plan.ownerId,
        balance: 0,
        pendingBalance: 0,
        totalEarned: 0,
        totalWithdrawn: 0,
        totalSpent: 0,
        isActive: true,
        isFrozen: false,
        createdAt: now,
        updatedAt: now,
      }));
    walletIds.set(plan.ownerId, walletId);
    await ctx.db.patch(walletId, {
      balance: major(plan.balance),
      totalEarned: major(plan.earned),
      lastTransactionAt: now,
      updatedAt: now,
    });
  }
  const effects: Applied["effects"] = [];
  for (const effect of prepared.effects) {
    const walletId = walletIds.get(effect.userId);
    if (walletId === undefined) {
      throw new Error("Escrow accounting invariant: prepared wallet missing");
    }
    const ledgerId = await ctx.db.insert("walletTransactions", {
      walletId,
      userId: effect.userId,
      type: effect.recipient === "buyer" ? "refund" : "credit",
      source: effect.recipient === "buyer" ? "refund" : "escrow_release",
      amount: major(effect.cents),
      balanceAfter: major(effect.balanceAfterCents),
      orderId: escrow.orderId,
      escrowId: escrow._id,
      operationId: operation._id,
      reference: reference(escrow, effect.recipient),
      status: "completed",
      description:
        effect.recipient === "buyer" ? "Approved escrow refund to marketplace wallet" : "Escrow seller payout",
      createdAt: now,
      completedAt: now,
      updatedAt: now,
    });
    effects.push({
      recipient: effect.recipient,
      walletId,
      ledgerId,
      cents: effect.cents,
      balanceBeforeCents: effect.balanceBeforeCents,
      balanceAfterCents: effect.balanceAfterCents,
    });
  }
  if (counts !== undefined && buyerAfter !== null && sellerAfter !== null) {
    await ctx.db.patch(escrow.buyerId, { totalPurchases: buyerAfter, updatedAt: now });
    await ctx.db.patch(escrow.sellerId, { totalSales: sellerAfter, updatedAt: now });
  }
  await ctx.db.patch(escrow._id, {
    status: statusFor(kind),
    ...(kind === "release" ? {} : { refundAmount: major(proof.refundCents) }),
    ...(kind === "full_refund" ? {} : { releasedAt: now }),
    updatedAt: now,
    lifecycleProof: {
      ...proof,
      state: { kind: "applied", appliedAt: now, effects, ...(counts === undefined ? {} : { counts }) },
    },
  });
  const notice = async (
    userId: Id<"users">,
    type: "wallet_credit" | "funds_released",
    title: string,
    message: string
  ): Promise<void> => {
    await ctx.db.insert("notifications", {
      userId,
      type,
      title,
      message,
      data: { orderId: escrow.orderId, escrowId: escrow._id },
      isRead: false,
      createdAt: now,
    });
  };
  if (kind === "release") {
    await notice(
      escrow.sellerId,
      "wallet_credit",
      "Funds Added to Wallet",
      `K${major(proof.sellerCents).toLocaleString()} from order #${order.orderNumber} has been added to your wallet.`
    );
  } else {
    await notice(
      escrow.buyerId,
      "funds_released",
      kind === "full_refund" ? "Refund Processed" : "Partial Refund Processed",
      `A ${kind === "full_refund" ? "full" : "partial"} refund of K${major(proof.refundCents).toLocaleString()} has been processed.`
    );
    if (kind === "partial_refund" && proof.sellerCents > 0) {
      await notice(
        escrow.sellerId,
        "funds_released",
        "Funds Released",
        `K${major(proof.sellerCents).toLocaleString()} has been released to your account after partial refund.`
      );
    }
  }
  return await result(ctx, escrow._id, "applied", true);
}
