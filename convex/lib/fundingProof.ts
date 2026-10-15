import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { centsToStoredMajor, checkedAdd, majorNumberToCents } from "./catalogMoney";
import { buildQuoteKey, type QuoteSeller } from "./checkoutQuote";
import { PurchaseError } from "./paymentOperationContracts";

type WalletPurchase = Extract<Doc<"paymentOperations">, { kind: "wallet_purchase" }>;
type ReadCtx = Pick<QueryCtx | MutationCtx, "db">;
const MONEY_KEYS = [
  "subtotalCents",
  "promoCents",
  "loyaltyCents",
  "discountCents",
  "discountedSubtotalCents",
  "shippingCents",
  "platformFeeCents",
  "sellerPayoutCents",
  "totalAmountCents",
] as const;

function conserved(slice: QuoteSeller | WalletPurchase["quoteSnapshot"]): boolean {
  return (
    MONEY_KEYS.every((key) => centsToStoredMajor(slice[key]) !== null) &&
    checkedAdd(slice.promoCents, slice.loyaltyCents) === slice.discountCents &&
    checkedAdd(slice.discountedSubtotalCents, slice.discountCents) === slice.subtotalCents &&
    checkedAdd(slice.discountedSubtotalCents, slice.shippingCents) === slice.sellerPayoutCents &&
    checkedAdd(slice.sellerPayoutCents, slice.platformFeeCents) === slice.totalAmountCents
  );
}

function sameSums(slices: QuoteSeller[], expected: QuoteSeller | WalletPurchase["quoteSnapshot"]): boolean {
  return MONEY_KEYS.every((key) => {
    let sum: number | null = 0;
    for (const slice of slices) {
      sum = sum === null ? null : checkedAdd(sum, slice[key]);
    }
    return sum === expected[key];
  });
}

function review(): never {
  throw new PurchaseError("review_needed", "This purchase needs funding proof review.");
}

// Read-only original funding lineage. Current catalog/cart and lifecycle
// labels do not reprice or invalidate an otherwise conserved original hold.
export async function requireWalletFundingProof(
  ctx: ReadCtx,
  operation: WalletPurchase
): Promise<Id<"walletTransactions">> {
  const quote = operation.quoteSnapshot;
  const { quoteKey: _quoteKey, ...snapshot } = quote;
  const ledgerId = operation.walletTransactionId;
  if (
    operation.status !== "succeeded" ||
    ledgerId === undefined ||
    !Number.isFinite(operation.accountingAppliedAt) ||
    operation.accountingAppliedAt < 0 ||
    operation.totalAmountCents <= 0 ||
    operation.totalAmountCents !== quote.totalAmountCents ||
    operation.debitAmountCents !== operation.totalAmountCents ||
    operation.source !== quote.source ||
    quote.currency !== "ZMW" ||
    operation.quoteKey !== quote.quoteKey ||
    (await buildQuoteKey(snapshot)) !== operation.quoteKey ||
    !conserved(quote) ||
    quote.sellers.length === 0 ||
    new Set(quote.sellers.map((slice) => slice.sellerId)).size !== quote.sellers.length ||
    !quote.sellers.every(conserved) ||
    !sameSums(quote.sellers, quote) ||
    operation.orderIds.length === 0 ||
    new Set(operation.orderIds).size !== operation.orderIds.length ||
    operation.orderBreakdowns.length !== operation.orderIds.length ||
    new Set(operation.orderBreakdowns.map((slice) => slice.orderId)).size !== operation.orderIds.length ||
    !operation.orderBreakdowns.every((slice) => operation.orderIds.includes(slice.orderId) && conserved(slice)) ||
    !sameSums(operation.orderBreakdowns, quote)
  ) {
    return review();
  }
  for (const seller of quote.sellers) {
    const slices = operation.orderBreakdowns.filter((slice) => slice.sellerId === seller.sellerId);
    if (slices.length === 0 || !sameSums(slices, seller)) {
      return review();
    }
  }
  if (operation.orderBreakdowns.some((slice) => !quote.sellers.some((seller) => seller.sellerId === slice.sellerId))) {
    return review();
  }
  const ledger = await ctx.db.get(ledgerId);
  if (
    !ledger ||
    ledger.operationId !== operation._id ||
    ledger.userId !== operation.ownerId ||
    ledger.type !== "debit" ||
    ledger.source !== "purchase" ||
    ledger.status !== "completed" ||
    ledger.reference !== operation.walletReference ||
    majorNumberToCents(ledger.amount) !== operation.totalAmountCents ||
    majorNumberToCents(ledger.balanceAfter) !== operation.walletBalanceAfterCents ||
    ledger.completedAt !== operation.accountingAppliedAt ||
    ledger.orderId !== undefined ||
    ledger.escrowId !== undefined ||
    ledger.paymentAccountId !== undefined ||
    ledger.reversalOfId !== undefined
  ) {
    return review();
  }
  const wallet = await ctx.db.get(ledger.walletId);
  const ownedWallets = await ctx.db
    .query("wallets")
    .withIndex("by_user", (q) => q.eq("userId", operation.ownerId))
    .collect();
  if (
    !wallet ||
    wallet.userId !== operation.ownerId ||
    ownedWallets.length !== 1 ||
    ownedWallets[0]?._id !== wallet._id
  ) {
    return review();
  }
  const ledgers = [
    ...(await ctx.db
      .query("walletTransactions")
      .withIndex("by_operation", (q) => q.eq("operationId", operation._id))
      .collect()),
    ...(await ctx.db
      .query("walletTransactions")
      .withIndex("by_reference", (q) => q.eq("reference", operation.walletReference))
      .collect()),
  ];
  // Future refund/release rows can share operationId; a second debit or
  // purchase-source record is conflicting original funding evidence.
  if (
    ledgers.some(
      (row) =>
        row._id !== ledgerId &&
        (row.type === "debit" || row.source === "purchase" || row.reference === operation.walletReference)
    )
  ) {
    return review();
  }
  const metadata: unknown = ledger.metadata;
  if (metadata !== undefined && typeof metadata === "object" && metadata !== null) {
    if ("operationId" in metadata && metadata.operationId !== operation._id) {
      return review();
    }
    if (
      "orderIds" in metadata &&
      (!Array.isArray(metadata.orderIds) ||
        metadata.orderIds.length !== operation.orderIds.length ||
        new Set(metadata.orderIds).size !== operation.orderIds.length ||
        !metadata.orderIds.every(
          (id: unknown) => typeof id === "string" && operation.orderIds.some((orderId) => orderId === id)
        ))
    ) {
      return review();
    }
  }
  const allEscrows = await ctx.db
    .query("escrow")
    .withIndex("by_operation", (q) => q.eq("operationId", operation._id))
    .collect();
  if (allEscrows.length !== operation.orderIds.length) {
    return review();
  }
  for (const slice of operation.orderBreakdowns) {
    const order = await ctx.db.get(slice.orderId);
    const holds = await ctx.db
      .query("escrow")
      .withIndex("by_order", (q) => q.eq("orderId", slice.orderId))
      .collect();
    const escrow = holds[0];
    if (
      !order ||
      order.operationId !== operation._id ||
      order.buyerId !== operation.ownerId ||
      order.sellerId !== slice.sellerId ||
      majorNumberToCents(order.subtotal) !== slice.subtotalCents ||
      majorNumberToCents(order.discountAmount ?? 0) !== slice.discountCents ||
      majorNumberToCents(order.shippingCost) !== slice.shippingCents ||
      majorNumberToCents(order.platformFee) !== slice.platformFeeCents ||
      majorNumberToCents(order.sellerPayout) !== slice.sellerPayoutCents ||
      majorNumberToCents(order.totalAmount) !== slice.totalAmountCents ||
      holds.length !== 1 ||
      !escrow ||
      escrow.operationId !== operation._id ||
      escrow.orderId !== order._id ||
      escrow.buyerId !== operation.ownerId ||
      escrow.sellerId !== slice.sellerId ||
      majorNumberToCents(escrow.grossAmount) !== slice.totalAmountCents ||
      majorNumberToCents(escrow.amount) !== slice.totalAmountCents ||
      majorNumberToCents(escrow.platformFee) !== slice.platformFeeCents ||
      majorNumberToCents(escrow.sellerAmount) !== slice.sellerPayoutCents
    ) {
      return review();
    }
  }
  return ledgerId;
}
