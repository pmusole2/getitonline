import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { centsToStoredMajor, checkedAdd, majorNumberToCents } from "./catalogMoney";
import { buildQuoteKey, stableStringify, type CheckoutQuote } from "./checkoutQuote";
import { deriveOrderSlices, type OrderSlice } from "./applyQuoteOrders";
import { capturedCartSnapshotsEqual, snapshotCapturedCartRow } from "./checkoutCartSnapshot";
import { isValidLoyaltyCounters, metadataNamesCheckoutOrder } from "./checkoutReservations";
import type { ProviderReceiptFacts } from "./providerOperationContracts";
import { hasReceiptConflict, receiptMatchesIntent, validAcquisition } from "./providerReceiptEvidence";
import type { ReceiptAcquisition } from "./providerSettlementContracts";

// Task4B consumed checkout settlement helper. Private typed functions only:
// no registered mutation lives here, so no second financial writer exists.
// Every function runs inside the single providerSettlement mutation ctx (or a
// read ctx for proof validation). Nothing here reads fresh prices, carts,
// catalogs, configs, or the current actor: the frozen operation snapshots
// are the only authority.

export type CheckoutOperation = Extract<Doc<"paymentOperations">, { kind: "checkout_collection" }>;

type ReadCtx = Pick<QueryCtx | MutationCtx, "db">;

export function isCheckoutOperation(operation: Doc<"paymentOperations">): operation is CheckoutOperation {
  return operation.kind === "checkout_collection";
}

function validTime(value: number | undefined): boolean {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

function uniqueRows<T extends { _id: string }>(rows: T[]): T[] {
  return [...new Map(rows.map((row) => [row._id, row])).values()];
}

export type CheckoutEvidencePatch = {
  receipt?: ProviderReceiptFacts;
  providerId?: string;
  receiptObservations?: ProviderReceiptFacts[];
  failureCode?: string;
  reviewNeeded?: true;
  acquisitions: Array<{ receipt: ProviderReceiptFacts; acquisition: ReceiptAcquisition }>;
  receivedFunds?: { receipt: ProviderReceiptFacts; acquisition: ReceiptAcquisition; receivedAt: number };
};

type MoneySlice = {
  subtotalCents: number;
  promoCents: number;
  loyaltyCents: number;
  discountCents: number;
  discountedSubtotalCents: number;
  shippingCents: number;
  platformFeeCents: number;
  sellerPayoutCents: number;
  totalAmountCents: number;
};

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

function sliceConserved(slice: MoneySlice): boolean {
  return (
    MONEY_KEYS.every((key) => centsToStoredMajor(slice[key]) !== null) &&
    checkedAdd(slice.promoCents, slice.loyaltyCents) === slice.discountCents &&
    checkedAdd(slice.discountedSubtotalCents, slice.discountCents) === slice.subtotalCents &&
    checkedAdd(slice.discountedSubtotalCents, slice.shippingCents) === slice.sellerPayoutCents &&
    checkedAdd(slice.sellerPayoutCents, slice.platformFeeCents) === slice.totalAmountCents
  );
}

function sumsEqual(slices: MoneySlice[], expected: MoneySlice): boolean {
  return MONEY_KEYS.every((key) => {
    let sum: number | null = 0;
    for (const slice of slices) {
      sum = sum === null ? null : checkedAdd(sum, slice[key]);
    }
    return sum === expected[key];
  });
}

function sortedIds(ids: Array<Id<"orders">>): string[] {
  return ids.map((id) => String(id)).sort();
}

function sameIdSet(left: Array<Id<"orders">>, right: Array<Id<"orders">>): boolean {
  const a = sortedIds(left);
  const b = sortedIds(right);
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

async function competingOperations(
  ctx: ReadCtx,
  operation: CheckoutOperation,
  providerId: string
): Promise<Array<Doc<"paymentOperations">>> {
  const rows = [
    ...(await ctx.db
      .query("paymentOperations")
      .withIndex("by_provider_reference", (q) => q.eq("providerReference", operation.providerReference))
      .collect()),
    ...(await ctx.db
      .query("paymentOperations")
      .withIndex("by_provider_id", (q) => q.eq("providerId", providerId))
      .collect()),
  ];
  return uniqueRows(rows).filter((row) => row._id !== operation._id);
}

function companionCorroborates(
  operation: CheckoutOperation,
  row: Doc<"transactions">,
  orderIdSet: ReadonlySet<string>
): boolean {
  if (
    (row.mobileNumber !== undefined && row.mobileNumber !== operation.collectionDestination.phone) ||
    (row.mobileMoneyProvider !== undefined && row.mobileMoneyProvider !== operation.collectionDestination.operator)
  ) {
    return false;
  }
  const metadata: unknown = row.metadata;
  if (metadata === undefined) {
    // Actual Clerk scrubbing erases phone and metadata. Present facts are
    // corroboration; frozen intent and acquired receipt are authority.
    return true;
  }
  if (typeof metadata !== "object" || metadata === null) {
    return false;
  }
  const record = metadata as Record<string, unknown>;
  if ("operationId" in record && record["operationId"] !== operation._id) {
    return false;
  }
  if ("checkoutOrderIds" in record) {
    const named = record["checkoutOrderIds"];
    if (!Array.isArray(named) || named.length !== orderIdSet.size) {
      return false;
    }
    for (const entry of named) {
      if (typeof entry !== "string" || !orderIdSet.has(entry)) {
        return false;
      }
    }
  }
  return true;
}

export function checkoutCompanionMatches(
  operation: CheckoutOperation,
  row: Doc<"transactions">,
  providerId: string
): boolean {
  const orderIdSet = new Set(operation.orderIds.map((id) => String(id)));
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
    companionCorroborates(operation, row, orderIdSet) &&
    (row.lencoCollectionId === undefined || row.lencoCollectionId === providerId) &&
    (row.lencoTransactionId === undefined || row.lencoTransactionId === providerId)
  );
}

type FrozenLineage = {
  quote: CheckoutQuote;
  slices: OrderSlice[];
  sortedOrderIds: Array<Id<"orders">>;
};

async function frozenLineage(operation: CheckoutOperation): Promise<FrozenLineage | null> {
  const quote = operation.quoteSnapshot;
  if (
    operation.quoteKey !== quote.quoteKey ||
    operation.source !== quote.source ||
    quote.currency !== "ZMW" ||
    operation.currency !== "ZMW" ||
    !Number.isSafeInteger(operation.amountCents) ||
    operation.amountCents <= 0 ||
    operation.amountCents !== quote.totalAmountCents ||
    quote.totalAmountCents <= 0 ||
    !sliceConserved(quote) ||
    quote.sellers.length === 0 ||
    new Set(quote.sellers.map((slice) => String(slice.sellerId))).size !== quote.sellers.length ||
    !quote.sellers.every(sliceConserved) ||
    !sumsEqual(quote.sellers, quote)
  ) {
    return null;
  }
  const { quoteKey: _quoteKey, ...snapshot } = quote;
  if ((await buildQuoteKey(snapshot)) !== operation.quoteKey) {
    return null;
  }
  if (
    operation.orderIds.length === 0 ||
    new Set(operation.orderIds.map((id) => String(id))).size !== operation.orderIds.length ||
    operation.orderBreakdowns.length !== operation.orderIds.length ||
    new Set(operation.orderBreakdowns.map((slice) => String(slice.orderId))).size !== operation.orderIds.length ||
    !operation.orderBreakdowns.every((slice) => operation.orderIds.some((id) => id === slice.orderId)) ||
    !operation.orderIds.every((id) => operation.orderBreakdowns.some((slice) => slice.orderId === id)) ||
    !operation.orderBreakdowns.every(sliceConserved) ||
    !sumsEqual(operation.orderBreakdowns, quote)
  ) {
    return null;
  }
  for (const seller of quote.sellers) {
    const slices = operation.orderBreakdowns.filter((slice) => String(slice.sellerId) === String(seller.sellerId));
    if (slices.length === 0 || !sumsEqual(slices, seller)) {
      return null;
    }
  }
  if (operation.orderBreakdowns.some((slice) => !quote.sellers.some((seller) => seller.sellerId === slice.sellerId))) {
    return null;
  }
  let slices: OrderSlice[];
  try {
    slices = deriveOrderSlices(quote, quote.source === "pending_orders" ? [...operation.orderIds] : undefined);
  } catch {
    return null;
  }
  return { quote, slices, sortedOrderIds: [...operation.orderIds].sort() };
}

type PairedOrder = {
  order: Doc<"orders">;
  slice: OrderSlice;
  breakdown: MoneySlice & { orderId: Id<"orders">; sellerId: Id<"users"> };
};

async function pairOrders(
  ctx: ReadCtx,
  operation: CheckoutOperation,
  lineage: FrozenLineage
): Promise<PairedOrder[] | null> {
  const paired: PairedOrder[] = [];
  if (lineage.quote.source === "pending_orders") {
    const sliceByOrder = new Map<string, OrderSlice>();
    for (const slice of lineage.slices) {
      if (slice.orderId === undefined || slice.items.length === 0) {
        return null;
      }
      sliceByOrder.set(String(slice.orderId), slice);
    }
    if (sliceByOrder.size !== operation.orderIds.length) {
      return null;
    }
    for (const orderId of operation.orderIds) {
      const order = await ctx.db.get(orderId);
      const slice = sliceByOrder.get(String(orderId));
      const breakdown = operation.orderBreakdowns.find((entry) => entry.orderId === orderId);
      if (!order || !slice || !breakdown || slice.orderId !== orderId) {
        return null;
      }
      paired.push({ order, slice, breakdown });
    }
    return paired;
  }
  // Cart source creates exactly one order per seller. Production ids are
  // opaque, so pairing follows seller identity plus exact frozen money and
  // items, never a sorted position.
  const sliceBySeller = new Map<string, OrderSlice>();
  for (const slice of lineage.slices) {
    sliceBySeller.set(String(slice.sellerId), slice);
  }
  if (sliceBySeller.size !== lineage.quote.sellers.length) {
    return null;
  }
  const ordersBySeller = new Map<string, Array<Doc<"orders">>>();
  for (const orderId of operation.orderIds) {
    const order = await ctx.db.get(orderId);
    if (!order) {
      return null;
    }
    const bucket = ordersBySeller.get(String(order.sellerId)) ?? [];
    bucket.push(order);
    ordersBySeller.set(String(order.sellerId), bucket);
  }
  if (ordersBySeller.size !== lineage.quote.sellers.length) {
    return null;
  }
  for (const [sellerId, orders] of ordersBySeller) {
    if (orders.length !== 1) {
      return null;
    }
    const order = orders[0] as Doc<"orders">;
    const slice = sliceBySeller.get(sellerId);
    const breakdown = operation.orderBreakdowns.find((entry) => entry.orderId === order._id);
    if (!slice || !breakdown || String(breakdown.sellerId) !== sellerId) {
      return null;
    }
    paired.push({ order, slice, breakdown });
  }
  return paired;
}

function orderMatchesFrozen(entry: PairedOrder, operation: CheckoutOperation, quote: CheckoutQuote): boolean {
  const { order, slice, breakdown } = entry;
  if (
    order.buyerId !== operation.ownerId ||
    order.operationId !== operation._id ||
    order.status !== "pending_payment" ||
    String(breakdown.sellerId) !== String(order.sellerId) ||
    String(breakdown.sellerId) !== String(slice.sellerId) ||
    stableStringify(order.items) !== stableStringify(slice.items) ||
    stableStringify({ ...breakdown }) !==
      stableStringify({ ...slice.breakdown, orderId: breakdown.orderId, sellerId: breakdown.sellerId }) ||
    majorNumberToCents(order.subtotal) !== breakdown.subtotalCents ||
    majorNumberToCents(order.discountAmount ?? 0) !== breakdown.discountCents ||
    majorNumberToCents(order.shippingCost) !== breakdown.shippingCents ||
    majorNumberToCents(order.platformFee) !== breakdown.platformFeeCents ||
    majorNumberToCents(order.sellerPayout) !== breakdown.sellerPayoutCents ||
    majorNumberToCents(order.totalAmount) !== breakdown.totalAmountCents
  ) {
    return false;
  }
  if (quote.promo === undefined ? order.promoCodeId !== undefined : order.promoCodeId !== quote.promo.promoCodeId) {
    return false;
  }
  return true;
}

export type CheckoutCapturePlan = {
  branch: "capture";
  companionId: Id<"transactions">;
  paired: PairedOrder[];
  escrowMajors: Array<{ gross: number; platformFee: number; sellerAmount: number }>;
  promoRedemptionId?: Id<"promoCodeRedemptions">;
  loyaltyTransactionId?: Id<"loyaltyTransactions">;
  loyaltyAccountId?: Id<"loyaltyAccounts">;
  loyaltyPoints?: number;
  discountEffect?: CheckoutDiscountEffect;
};

export type CheckoutReleasePlan = {
  branch: "release";
  companionId: Id<"transactions">;
  orderIds: Array<Id<"orders">>;
  stockPatches: Array<{
    productId: Id<"products">;
    quantity: number;
    status?: Doc<"products">["status"];
    variantCombinations?: Doc<"products">["variantCombinations"];
  }>;
  promoRedemptionId?: Id<"promoCodeRedemptions">;
  loyaltyTransactionId?: Id<"loyaltyTransactions">;
  loyaltyAccountId?: Id<"loyaltyAccounts">;
  loyaltyPoints?: number;
  discountEffect?: CheckoutDiscountEffect;
};

// Minimal typed non-PII completed-discount facts validated in preflight and
// recorded by the same writer at capture/release. The snapshot survives
// legitimate Clerk erasure of loyalty history and is consumed by the
// already-applied validator, replay, recovery, projection, and coverage.
// Only ids, amounts, and points: no personal or behavior data.
export type CheckoutDiscountEffect = {
  firstOrderId: Id<"orders">;
  promo?: {
    redemptionId: Id<"promoCodeRedemptions">;
    promoCodeId: Id<"promoCodes">;
    orderId: Id<"orders">;
    discountCents: number;
  };
  loyalty?: {
    transactionId: Id<"loyaltyTransactions">;
    accountId: Id<"loyaltyAccounts">;
    orderId: Id<"orders">;
    points: number;
  };
};

// Whole-set preflight before the first business mutation. Every money,
// resource, counter, conversion, stock and write fact is validated here; a
// null return holds the entire set with evidence only and never a denial
// after partial writes.
export async function preflightCheckoutSettlement(
  ctx: ReadCtx,
  operation: CheckoutOperation,
  receipt: ProviderReceiptFacts
): Promise<CheckoutCapturePlan | CheckoutReleasePlan | null> {
  if (receipt.status !== "successful" && receipt.status !== "failed") {
    return null;
  }
  const lineage = await frozenLineage(operation);
  if (!lineage) {
    return null;
  }
  const { quote } = lineage;
  const paired = await pairOrders(ctx, operation, lineage);
  if (!paired || paired.length !== operation.orderIds.length) {
    return null;
  }
  for (const entry of paired) {
    if (!orderMatchesFrozen(entry, operation, quote)) {
      return null;
    }
  }
  // Actual buyer row must exist. A deleted/banned tombstone still receives
  // owed processing; a missing row holds every fund and reservation.
  if ((await ctx.db.get(operation.ownerId)) === null) {
    return null;
  }
  // Competing provider/reference evidence and duplicate companions hold.
  if ((await competingOperations(ctx, operation, receipt.id)).length > 0) {
    return null;
  }
  const companionId = operation.transactionId;
  if (companionId === undefined) {
    return null;
  }
  const companion = await ctx.db.get(companionId);
  const companions = uniqueRows([
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
      .withIndex("by_lenco_id", (q) => q.eq("lencoTransactionId", receipt.id))
      .collect()),
    ...(await ctx.db
      .query("transactions")
      .withIndex("by_lenco_collection", (q) => q.eq("lencoCollectionId", receipt.id))
      .collect()),
  ]);
  if (
    companion === null ||
    companions.length !== 1 ||
    companions[0]?._id !== companion._id ||
    !checkoutCompanionMatches(operation, companion, receipt.id) ||
    companion.status !== "pending" ||
    companion.lencoCollectionId !== undefined ||
    companion.lencoTransactionId !== undefined
  ) {
    return null;
  }
  const orderIdSet = new Set(operation.orderIds.map((id) => String(id)));
  for (const entry of paired) {
    const escrows = await ctx.db
      .query("escrow")
      .withIndex("by_order", (q) => q.eq("orderId", entry.order._id))
      .collect();
    if (escrows.length > 0) {
      return null;
    }
    // Order-linked legacy transaction/ledger evidence in any local status is
    // ambiguous and never funding proof.
    const legacyTransactions = await ctx.db
      .query("transactions")
      .withIndex("by_order", (q) => q.eq("orderId", entry.order._id))
      .collect();
    if (legacyTransactions.length > 0) {
      return null;
    }
    const legacyLedger = await ctx.db
      .query("walletTransactions")
      .withIndex("by_order", (q) => q.eq("orderId", entry.order._id))
      .collect();
    if (legacyLedger.length > 0) {
      return null;
    }
  }
  const operationEscrows = await ctx.db
    .query("escrow")
    .withIndex("by_operation", (q) => q.eq("operationId", operation._id))
    .collect();
  if (operationEscrows.length > 0) {
    return null;
  }
  // Task4B writes no wallet ledger rows for a checkout. Any ledger already
  // naming this reference or provider id is conflicting evidence.
  const ledgers = uniqueRows([
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
      .withIndex("by_external_reference", (q) => q.eq("externalReference", receipt.id))
      .collect()),
  ]);
  if (ledgers.length > 0) {
    return null;
  }
  // Task4B never writes a wallet ledger for a checkout source, so any ledger
  // already linked to this operation id is novel conflicting financial
  // evidence, regardless of its metadata, reference, or status alias. The
  // exact expected companion (a transactions row, never a ledger) is the
  // only same-operation record this preflight tolerates. Legitimate later
  // lifecycle effects may share lineage only after funding is applied, so
  // this novel-stage hold never invalidates an already-applied funding
  // proof: the consumed validator below reads no by_operation ledger
  // exclusion.
  const operationLedgers = await ctx.db
    .query("walletTransactions")
    .withIndex("by_operation", (q) => q.eq("operationId", operation._id))
    .collect();
  if (operationLedgers.length > 0) {
    return null;
  }
  // Owned metadata-only legacy evidence names orders without setting
  // orderId. Only owned rows are read. The exact expected companion is the
  // only same-operation row excluded here: any other row already naming this
  // operation id is a novel conflicting link, not a legacy grant.
  const ownedTransactions = await ctx.db
    .query("transactions")
    .withIndex("by_user", (q) => q.eq("userId", operation.ownerId))
    .collect();
  const ownedLedger = await ctx.db
    .query("walletTransactions")
    .withIndex("by_user", (q) => q.eq("userId", operation.ownerId))
    .collect();
  for (const row of [...ownedTransactions, ...ownedLedger]) {
    if (row._id === companion._id) {
      continue;
    }
    if (row.operationId === operation._id) {
      return null;
    }
    if (metadataNamesCheckoutOrder(row.metadata, orderIdSet)) {
      return null;
    }
  }
  // Promo: exact optional frozen promo plus one reciprocal reserved link.
  // No current cap recheck; no usageCount exists.
  const sortedOrderIds = [...operation.orderIds].sort();
  const firstOrderId = sortedOrderIds[0] as Id<"orders"> | undefined;
  let promoRedemptionId: Id<"promoCodeRedemptions"> | undefined;
  const promoLinks = await ctx.db
    .query("promoCodeRedemptions")
    .withIndex("by_operation", (q) => q.eq("operationId", operation._id))
    .collect();
  if (quote.promo === undefined) {
    if (operation.promoRedemptionId !== undefined || promoLinks.length > 0) {
      return null;
    }
  } else {
    if (firstOrderId === undefined || operation.promoRedemptionId === undefined || promoLinks.length !== 1) {
      return null;
    }
    const redemption = await ctx.db.get(operation.promoRedemptionId);
    if (
      redemption === null ||
      promoLinks[0]?._id !== redemption._id ||
      redemption.operationId !== operation._id ||
      redemption.userId !== operation.ownerId ||
      redemption.promoCodeId !== quote.promo.promoCodeId ||
      redemption.status !== "reserved" ||
      majorNumberToCents(redemption.discountAmount) !== quote.promo.discountCents ||
      redemption.orderId !== firstOrderId
    ) {
      return null;
    }
    promoRedemptionId = redemption._id;
  }
  // Loyalty: exact optional frozen effective points plus one reciprocal
  // reserved link and one owned numeric account. The current balance may
  // reflect legitimate other activity and is never compared to an old
  // snapshot; prospective capture/return counters must stay lossless.
  let loyaltyTransactionId: Id<"loyaltyTransactions"> | undefined;
  let loyaltyAccountId: Id<"loyaltyAccounts"> | undefined;
  let loyaltyPoints: number | undefined;
  const loyaltyLinks = await ctx.db
    .query("loyaltyTransactions")
    .withIndex("by_operation", (q) => q.eq("operationId", operation._id))
    .collect();
  if (quote.loyalty === undefined) {
    if (
      operation.loyaltyTransactionId !== undefined ||
      operation.loyaltyAccountId !== undefined ||
      operation.loyaltyPoints !== undefined ||
      loyaltyLinks.length > 0
    ) {
      return null;
    }
  } else {
    const effectivePoints = quote.loyalty.points;
    if (
      !Number.isSafeInteger(effectivePoints) ||
      effectivePoints <= 0 ||
      operation.loyaltyTransactionId === undefined ||
      operation.loyaltyAccountId === undefined ||
      operation.loyaltyPoints !== effectivePoints ||
      loyaltyLinks.length !== 1
    ) {
      return null;
    }
    const reservation = await ctx.db.get(operation.loyaltyTransactionId);
    if (
      reservation === null ||
      loyaltyLinks[0]?._id !== reservation._id ||
      reservation.operationId !== operation._id ||
      reservation.userId !== operation.ownerId ||
      reservation.accountId !== operation.loyaltyAccountId ||
      reservation.type !== "redeem" ||
      reservation.points !== effectivePoints ||
      reservation.status !== "reserved" ||
      // The accepted producer stores the sorted first operation order on the
      // reserved row: a missing, foreign, or swapped first-order link holds.
      firstOrderId === undefined ||
      reservation.orderId !== firstOrderId
    ) {
      return null;
    }
    const accounts = await ctx.db
      .query("loyaltyAccounts")
      .withIndex("by_user", (q) => q.eq("userId", operation.ownerId))
      .collect();
    const account = accounts[0];
    if (
      accounts.length !== 1 ||
      account === undefined ||
      account._id !== operation.loyaltyAccountId ||
      !isValidLoyaltyCounters(account)
    ) {
      return null;
    }
    if (
      checkedAdd(account.lifetimeRedeemed, effectivePoints) === null ||
      checkedAdd(account.pointsBalance, effectivePoints) === null
    ) {
      return null;
    }
    loyaltyTransactionId = reservation._id;
    loyaltyAccountId = account._id;
    loyaltyPoints = effectivePoints;
  }
  // Validated completed-discount facts carried into the apply step so the
  // same writer records the durable non-PII effect snapshot. Every business
  // check above already passed; carrying these facts authorizes no partial
  // write and changes no throw/rollback invariant below.
  let discountEffect: CheckoutDiscountEffect | undefined;
  if (promoRedemptionId !== undefined || loyaltyTransactionId !== undefined) {
    if (firstOrderId === undefined) {
      return null;
    }
    const frozenPromo = quote.promo;
    discountEffect = {
      firstOrderId,
      ...(promoRedemptionId === undefined || frozenPromo === undefined
        ? {}
        : {
            promo: {
              redemptionId: promoRedemptionId,
              promoCodeId: frozenPromo.promoCodeId,
              orderId: firstOrderId,
              discountCents: frozenPromo.discountCents,
            },
          }),
      ...(loyaltyTransactionId === undefined || loyaltyAccountId === undefined || loyaltyPoints === undefined
        ? {}
        : {
            loyalty: {
              transactionId: loyaltyTransactionId,
              accountId: loyaltyAccountId,
              orderId: firstOrderId,
              points: loyaltyPoints,
            },
          }),
    };
  }
  if (receipt.status === "successful") {
    const escrowMajors: CheckoutCapturePlan["escrowMajors"] = [];
    for (const entry of paired) {
      const gross = centsToStoredMajor(entry.breakdown.totalAmountCents);
      const platformFee = centsToStoredMajor(entry.breakdown.platformFeeCents);
      const sellerAmount = centsToStoredMajor(entry.breakdown.sellerPayoutCents);
      if (gross === null || platformFee === null || sellerAmount === null) {
        return null;
      }
      escrowMajors.push({ gross, platformFee, sellerAmount });
    }
    return {
      branch: "capture",
      companionId,
      paired,
      escrowMajors,
      ...(promoRedemptionId === undefined ? {} : { promoRedemptionId }),
      ...(loyaltyTransactionId === undefined ? {} : { loyaltyTransactionId }),
      ...(loyaltyAccountId === undefined ? {} : { loyaltyAccountId }),
      ...(loyaltyPoints === undefined ? {} : { loyaltyPoints }),
      ...(discountEffect === undefined ? {} : { discountEffect }),
    };
  }
  // Trusted failure restores the exact original purchased lines once,
  // aggregated across repeated lines, customizations and multiple orders per
  // product/variant. The authoritative frozen seller is the order that
  // purchased each line: a current product owned by anyone else, a purchased
  // variant id naming zero or several current combinations, or a malformed
  // quantity holds the whole failure before any reservation release; nothing
  // is minted from guesses, SKUs, or repricing.
  const restored = new Map<
    string,
    {
      productId: Id<"products">;
      product: Doc<"products">;
      frozenSeller: string;
      byVariant: Map<string, number>;
    }
  >();
  for (const entry of paired) {
    for (const item of entry.order.items) {
      const variantId = item.selectedVariant?.variantId ?? "";
      if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
        return null;
      }
      const key = String(item.productId);
      let bucket = restored.get(key);
      if (bucket === undefined) {
        const product = await ctx.db.get(item.productId);
        if (!product || !Number.isSafeInteger(product.quantity)) {
          return null;
        }
        if (String(product.sellerId) !== String(entry.order.sellerId)) {
          return null;
        }
        bucket = {
          productId: item.productId,
          product,
          frozenSeller: String(entry.order.sellerId),
          byVariant: new Map<string, number>(),
        };
        restored.set(key, bucket);
      } else if (bucket.frozenSeller !== String(entry.order.sellerId)) {
        return null;
      }
      const total = bucket.byVariant.get(variantId) ?? 0;
      const next = checkedAdd(total, item.quantity);
      if (next === null) {
        return null;
      }
      bucket.byVariant.set(variantId, next);
    }
  }
  const stockPatches: CheckoutReleasePlan["stockPatches"] = [];
  for (const { productId, product, byVariant } of restored.values()) {
    let totalRestored: number | null = 0;
    for (const quantity of byVariant.values()) {
      totalRestored = totalRestored === null ? null : checkedAdd(totalRestored, quantity);
    }
    const quantity = totalRestored === null ? null : checkedAdd(product.quantity, totalRestored);
    if (quantity === null) {
      return null;
    }
    const patch: CheckoutReleasePlan["stockPatches"][number] = { productId, quantity };
    if (product.status === "sold" && quantity > 0) {
      patch.status = "active";
    }
    // The optional variant field is preserved exactly: combinations are
    // patched only when some purchased line names a real (non-empty) variant
    // id, mirroring the reservation helper. A non-variant product keeps the
    // field absent instead of gaining an invented empty array, while
    // unrelated combinations, intentional inactive states, and pending-review
    // states stay untouched.
    const variantIds = [...byVariant.keys()].filter((id) => id !== "");
    if (variantIds.length > 0) {
      const combinations = (product.variantCombinations ?? []).map((combination) => {
        const restore = byVariant.get(combination.id) ?? 0;
        if (restore === 0) {
          return combination;
        }
        const stock = checkedAdd(combination.stock, restore);
        if (stock === null) {
          return null;
        }
        return {
          ...combination,
          stock,
          status:
            combination.status === "out_of_stock" && combination.stock === 0 ? ("active" as const) : combination.status,
        };
      });
      if (combinations.some((combination) => combination === null)) {
        return null;
      }
      for (const namedId of variantIds) {
        if ((product.variantCombinations ?? []).filter((combination) => combination.id === namedId).length !== 1) {
          return null;
        }
      }
      patch.variantCombinations = combinations.filter(
        (combination): combination is NonNullable<typeof combination> => combination !== null
      ) as Doc<"products">["variantCombinations"];
    }
    stockPatches.push(patch);
  }
  return {
    branch: "release",
    companionId,
    orderIds: [...operation.orderIds],
    stockPatches,
    ...(promoRedemptionId === undefined ? {} : { promoRedemptionId }),
    ...(loyaltyTransactionId === undefined ? {} : { loyaltyTransactionId }),
    ...(loyaltyAccountId === undefined ? {} : { loyaltyAccountId }),
    ...(loyaltyPoints === undefined ? {} : { loyaltyPoints }),
    ...(discountEffect === undefined ? {} : { discountEffect }),
  };
}

export async function applyCheckoutCapture(
  ctx: MutationCtx,
  operation: CheckoutOperation,
  plan: CheckoutCapturePlan,
  input: {
    receipt: ProviderReceiptFacts;
    acquisition: ReceiptAcquisition;
    evidence: CheckoutEvidencePatch;
    now: number;
  }
): Promise<void> {
  const { receipt, acquisition, evidence, now } = input;
  // Paid orders keep every other field; only the lifecycle moves.
  for (const entry of plan.paired) {
    await ctx.db.patch(entry.order._id, { status: "paid", updatedAt: now });
  }
  const escrowIds: Array<Id<"escrow">> = [];
  for (const [index, entry] of plan.paired.entries()) {
    const majors = plan.escrowMajors[index] as CheckoutCapturePlan["escrowMajors"][number];
    const escrowId = await ctx.db.insert("escrow", {
      orderId: entry.order._id,
      buyerId: operation.ownerId,
      sellerId: entry.order.sellerId,
      grossAmount: majors.gross,
      platformFee: majors.platformFee,
      sellerAmount: majors.sellerAmount,
      amount: majors.gross,
      status: "held",
      operationId: operation._id,
      createdAt: now,
      updatedAt: now,
    });
    escrowIds.push(escrowId);
  }
  await ctx.db.patch(plan.companionId, {
    status: "successful",
    lencoCollectionId: receipt.id,
    completedAt: now,
    updatedAt: now,
  });
  if (plan.promoRedemptionId !== undefined) {
    await ctx.db.patch(plan.promoRedemptionId, { status: "captured" });
  }
  // Capture increments lifetimeRedeemed only: the balance was already
  // debited once at reservation and is never debited again here.
  if (
    plan.loyaltyTransactionId !== undefined &&
    plan.loyaltyAccountId !== undefined &&
    plan.loyaltyPoints !== undefined
  ) {
    const account = await ctx.db.get(plan.loyaltyAccountId);
    if (!account) {
      throw new Error("The loyalty account is missing for capture.");
    }
    await ctx.db.patch(plan.loyaltyTransactionId, { status: "captured" });
    await ctx.db.patch(plan.loyaltyAccountId, {
      lifetimeRedeemed: account.lifetimeRedeemed + plan.loyaltyPoints,
      updatedAt: now,
    });
  }
  // Buyer/seller success notices describe mobile money. No wallet-debit
  // notice is emitted from this path.
  for (const entry of plan.paired) {
    await ctx.db.insert("notifications", {
      userId: entry.order.sellerId,
      type: "payment_received",
      title: "Payment Received",
      message: `Payment received for order #${entry.order.orderNumber} via mobile money. Please process the order.`,
      data: { orderId: entry.order._id, operationId: operation._id },
      isRead: false,
      createdAt: now,
    });
    await ctx.db.insert("notifications", {
      userId: entry.order.buyerId,
      type: "order_status_update",
      title: "Payment Successful",
      message: `Your mobile-money payment for order #${entry.order.orderNumber} was successful.`,
      data: { orderId: entry.order._id, operationId: operation._id },
      isRead: false,
      createdAt: now,
    });
  }
  // Cart cleanup deletes only captured still-owned rows whose raw stored
  // selectors still match the raw snapshot. New, changed and foreign rows
  // remain; cached display facts are never selectors.
  const snapshots = new Map(
    (operation.rawCartSnapshot ?? []).map((entry) => [
      String(entry.cartItemId),
      {
        ownerId: entry.ownerId,
        productId: entry.productId,
        quantity: entry.quantity,
        variantId: entry.variantId,
        variantSku: entry.variantSku,
        options: entry.options,
        addOns: entry.addOns,
        shippingName: entry.shippingName,
      },
    ])
  );
  for (const [cartItemId, snapshot] of snapshots) {
    const row = await ctx.db.get(cartItemId as Id<"cartItems">);
    if (!row || row.userId !== operation.ownerId) {
      continue;
    }
    if (capturedCartSnapshotsEqual(snapshot, snapshotCapturedCartRow(row))) {
      await ctx.db.delete(row._id);
    }
  }
  await ctx.db.patch(operation._id, {
    ...evidence,
    status: "succeeded",
    // Durable minimal non-PII completed-discount proof: the same writer
    // records the preflight-validated effect facts (ids, amounts, points,
    // first order, receipt, and quote binding) so legitimate Clerk erasure
    // of loyalty history never destroys the already-funded obligation.
    ...(plan.discountEffect === undefined
      ? {}
      : {
          completedDiscountProof: {
            receiptId: receipt.id,
            quoteKey: operation.quoteKey,
            appliedAt: now,
            firstOrderId: plan.discountEffect.firstOrderId,
            ...(plan.discountEffect.promo === undefined ? {} : { promo: plan.discountEffect.promo }),
            ...(plan.discountEffect.loyalty === undefined ? {} : { loyalty: plan.discountEffect.loyalty }),
          },
        }),
    accounting: {
      kind: "checkout_captured",
      receipt,
      acquisition,
      appliedAt: now,
      transactionId: plan.companionId,
      orderIds: [...operation.orderIds],
      escrowIds,
      ...(plan.promoRedemptionId === undefined ? {} : { promoRedemptionId: plan.promoRedemptionId }),
      ...(plan.loyaltyTransactionId === undefined ? {} : { loyaltyTransactionId: plan.loyaltyTransactionId }),
    },
    updatedAt: now,
  });
}

export async function applyCheckoutRelease(
  ctx: MutationCtx,
  operation: CheckoutOperation,
  plan: CheckoutReleasePlan,
  input: {
    receipt: ProviderReceiptFacts;
    acquisition: ReceiptAcquisition;
    evidence: CheckoutEvidencePatch;
    now: number;
  }
): Promise<void> {
  const { receipt, acquisition, evidence, now } = input;
  // Cancelled orders keep notes and every other field; the generic cancel
  // helper (with its escrow-refund guesses) is never invoked here.
  for (const orderId of plan.orderIds) {
    await ctx.db.patch(orderId, { status: "cancelled", updatedAt: now });
  }
  await ctx.db.patch(plan.companionId, {
    status: "failed",
    lencoCollectionId: receipt.id,
    completedAt: now,
    updatedAt: now,
  });
  if (plan.promoRedemptionId !== undefined) {
    await ctx.db.patch(plan.promoRedemptionId, { status: "released" });
  }
  // The reserved effective points return to the same numeric account.
  // lifetimeEarned, lifetimeRedeemed and tier stay exactly unchanged.
  if (
    plan.loyaltyTransactionId !== undefined &&
    plan.loyaltyAccountId !== undefined &&
    plan.loyaltyPoints !== undefined
  ) {
    const account = await ctx.db.get(plan.loyaltyAccountId);
    if (!account) {
      throw new Error("The loyalty account is missing for release.");
    }
    await ctx.db.patch(plan.loyaltyTransactionId, { status: "released" });
    await ctx.db.patch(plan.loyaltyAccountId, {
      pointsBalance: account.pointsBalance + plan.loyaltyPoints,
      updatedAt: now,
    });
  }
  for (const patch of plan.stockPatches) {
    const fields: {
      quantity: number;
      status?: Doc<"products">["status"];
      variantCombinations?: Doc<"products">["variantCombinations"];
      updatedAt: number;
    } = { quantity: patch.quantity, updatedAt: now };
    if (patch.status !== undefined) {
      fields.status = patch.status;
    }
    if (patch.variantCombinations !== undefined) {
      fields.variantCombinations = patch.variantCombinations;
    }
    await ctx.db.patch(patch.productId, fields);
  }
  // Failure leaves cart rows untouched for retry. No buyer wallet credit,
  // escrow funding, provider refund, or second POST happens here.
  await ctx.db.patch(operation._id, {
    ...evidence,
    status: "failed",
    // Same durable effect proof as capture: a released discount history is
    // still an applied reservation settlement that later replay, recovery,
    // and coverage must read exactly.
    ...(plan.discountEffect === undefined
      ? {}
      : {
          completedDiscountProof: {
            receiptId: receipt.id,
            quoteKey: operation.quoteKey,
            appliedAt: now,
            firstOrderId: plan.discountEffect.firstOrderId,
            ...(plan.discountEffect.promo === undefined ? {} : { promo: plan.discountEffect.promo }),
            ...(plan.discountEffect.loyalty === undefined ? {} : { loyalty: plan.discountEffect.loyalty }),
          },
        }),
    accounting: {
      kind: "checkout_released",
      receipt,
      acquisition,
      appliedAt: now,
      transactionId: plan.companionId,
      orderIds: [...operation.orderIds],
      ...(plan.promoRedemptionId === undefined ? {} : { promoRedemptionId: plan.promoRedemptionId }),
      ...(plan.loyaltyTransactionId === undefined ? {} : { loyaltyTransactionId: plan.loyaltyTransactionId }),
    },
    updatedAt: now,
  });
}

// Read-only consumed proof for a checkout branch. A bare terminal label, a
// missing marker, or a corrupted reciprocal effect is no proof; complete
// proof plus a matching replay applies nothing twice. Later legitimate order
// completion/cancellation and escrow release preserve the original funding
// lineage when money and identity facts stay intact, so lifecycle labels
// after capture/release never destroy the proof. Current stock, wallet and
// activity balances are never compared to old snapshots as positive proof.
export async function validateCheckoutAccounting(ctx: ReadCtx, operation: CheckoutOperation): Promise<boolean> {
  const accounting = operation.accounting;
  if (
    accounting === undefined ||
    (accounting.kind !== "checkout_captured" && accounting.kind !== "checkout_released") ||
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
  if ((await competingOperations(ctx, operation, providerId)).length > 0) {
    return false;
  }
  if (!sameIdSet(accounting.orderIds, operation.orderIds)) {
    return false;
  }
  const lineage = await frozenLineage(operation);
  if (!lineage) {
    return false;
  }
  const companion = await ctx.db.get(accounting.transactionId);
  const companions = uniqueRows([
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
  ]);
  if (
    companion === null ||
    companions.length !== 1 ||
    companions[0]?._id !== companion._id ||
    !checkoutCompanionMatches(operation, companion, providerId) ||
    companion.lencoCollectionId !== providerId ||
    companion.completedAt !== accounting.appliedAt ||
    accounting.transactionId !== operation.transactionId
  ) {
    return false;
  }
  for (const orderId of accounting.orderIds) {
    const order = await ctx.db.get(orderId);
    const breakdown = operation.orderBreakdowns.find((entry) => entry.orderId === orderId);
    if (
      !order ||
      !breakdown ||
      order.operationId !== operation._id ||
      order.buyerId !== operation.ownerId ||
      order.sellerId !== breakdown.sellerId ||
      majorNumberToCents(order.subtotal) !== breakdown.subtotalCents ||
      majorNumberToCents(order.discountAmount ?? 0) !== breakdown.discountCents ||
      majorNumberToCents(order.shippingCost) !== breakdown.shippingCents ||
      majorNumberToCents(order.platformFee) !== breakdown.platformFeeCents ||
      majorNumberToCents(order.sellerPayout) !== breakdown.sellerPayoutCents ||
      majorNumberToCents(order.totalAmount) !== breakdown.totalAmountCents
    ) {
      return false;
    }
    if (accounting.kind === "checkout_captured" ? order.status === "pending_payment" : order.status !== "cancelled") {
      return false;
    }
  }
  if (accounting.kind === "checkout_captured") {
    if (
      operation.status !== "succeeded" ||
      accounting.receipt.status !== "successful" ||
      companion.status !== "successful" ||
      operation.receivedFunds?.receipt.id !== providerId
    ) {
      return false;
    }
    const escrowRows = await ctx.db
      .query("escrow")
      .withIndex("by_operation", (q) => q.eq("operationId", operation._id))
      .collect();
    const escrows = uniqueRows(escrowRows);
    if (
      escrowRows.length !== escrows.length ||
      escrows.length !== accounting.orderIds.length ||
      accounting.escrowIds.length !== accounting.orderIds.length ||
      new Set(accounting.escrowIds.map((id) => String(id))).size !== accounting.escrowIds.length
    ) {
      return false;
    }
    const actualEscrowIds = new Set(escrows.map((entry) => String(entry._id)));
    for (const markerId of accounting.escrowIds) {
      if (!actualEscrowIds.has(String(markerId))) {
        return false;
      }
    }
    // Exact one-to-one coverage by ORIGINAL order identity: every original
    // order funds exactly one authoritative escrow. A duplicated order
    // escrow with a missing sibling (or any foreign extra) fails even when
    // raw counts match, without any sorted-position pairing. Unequal and
    // same-seller multi-order shapes still validate through identity.
    const escrowsByOrder = new Map<string, number>();
    for (const entry of escrows) {
      if (entry.orderId === undefined) {
        return false;
      }
      const key = String(entry.orderId);
      escrowsByOrder.set(key, (escrowsByOrder.get(key) ?? 0) + 1);
    }
    const coveredOrderIds = [...escrowsByOrder.keys()].sort();
    const expectedOrderIds = operation.orderIds.map((id) => String(id)).sort();
    if (
      coveredOrderIds.length !== expectedOrderIds.length ||
      coveredOrderIds.some((id, index) => id !== expectedOrderIds[index]) ||
      [...escrowsByOrder.values()].some((count) => count !== 1)
    ) {
      return false;
    }
    for (const escrow of escrows) {
      const breakdown = operation.orderBreakdowns.find((entry) => entry.orderId === escrow.orderId);
      if (
        !accounting.escrowIds.some((id) => id === escrow._id) ||
        !breakdown ||
        escrow.operationId !== operation._id ||
        escrow.orderId === undefined ||
        escrow.buyerId !== operation.ownerId ||
        escrow.sellerId !== breakdown.sellerId ||
        majorNumberToCents(escrow.grossAmount) !== breakdown.totalAmountCents ||
        majorNumberToCents(escrow.amount) !== breakdown.totalAmountCents ||
        majorNumberToCents(escrow.platformFee) !== breakdown.platformFeeCents ||
        majorNumberToCents(escrow.sellerAmount) !== breakdown.sellerPayoutCents
      ) {
        return false;
      }
    }
  } else {
    if (operation.status !== "failed" || accounting.receipt.status !== "failed" || companion.status !== "failed") {
      return false;
    }
    const escrows = await ctx.db
      .query("escrow")
      .withIndex("by_operation", (q) => q.eq("operationId", operation._id))
      .collect();
    if (escrows.length > 0) {
      return false;
    }
  }
  const promoLinks = await ctx.db
    .query("promoCodeRedemptions")
    .withIndex("by_operation", (q) => q.eq("operationId", operation._id))
    .collect();
  // Durable completed-discount proof: the frozen quote's optional promo and
  // loyalty effects must each be present in the claim pointers, the applied
  // marker, and the server-written snapshot together. Erasing a claim or
  // effect pointer never silently skips a frozen required discount, and a
  // legacy bare marker without the new durable evidence holds for
  // reconciliation with no backfill. The snapshot carries only ids, amounts,
  // and points: never PII, and never authority on its own.
  const proof = operation.completedDiscountProof;
  const firstOrderId = [...operation.orderIds].sort()[0];
  if (firstOrderId === undefined) {
    return false;
  }
  const frozenPromo = lineage.quote.promo;
  const frozenLoyalty = lineage.quote.loyalty;
  if (frozenPromo !== undefined || frozenLoyalty !== undefined) {
    if (
      proof === undefined ||
      proof.receiptId !== providerId ||
      proof.quoteKey !== operation.quoteKey ||
      proof.appliedAt !== accounting.appliedAt ||
      proof.firstOrderId !== firstOrderId
    ) {
      return false;
    }
  } else if (proof !== undefined) {
    return false;
  }
  if (frozenPromo === undefined) {
    if (
      operation.promoRedemptionId !== undefined ||
      accounting.promoRedemptionId !== undefined ||
      promoLinks.length > 0 ||
      proof?.promo !== undefined
    ) {
      return false;
    }
  } else {
    if (
      operation.promoRedemptionId === undefined ||
      accounting.promoRedemptionId === undefined ||
      proof?.promo === undefined
    ) {
      return false;
    }
    const effect = proof.promo;
    if (
      effect.redemptionId !== accounting.promoRedemptionId ||
      effect.redemptionId !== operation.promoRedemptionId ||
      effect.promoCodeId !== frozenPromo.promoCodeId ||
      effect.discountCents !== frozenPromo.discountCents ||
      effect.orderId !== firstOrderId
    ) {
      return false;
    }
    const redemption = await ctx.db.get(accounting.promoRedemptionId);
    if (redemption === null) {
      // The frozen Clerk handler never deletes promo redemptions, so a
      // missing claimed row is never genuine erasure: hold for
      // reconciliation even under a deleted tombstone. No broad
      // missing-promo waiver based only on deletion.
      return false;
    }
    if (
      promoLinks.length !== 1 ||
      promoLinks[0]?._id !== redemption._id ||
      redemption.operationId !== operation._id ||
      redemption.userId !== operation.ownerId ||
      operation.promoRedemptionId !== redemption._id ||
      redemption.promoCodeId !== frozenPromo.promoCodeId ||
      majorNumberToCents(redemption.discountAmount) !== frozenPromo.discountCents ||
      redemption.orderId !== firstOrderId ||
      redemption.status !== (accounting.kind === "checkout_captured" ? "captured" : "released")
    ) {
      return false;
    }
  }
  const loyaltyLinks = await ctx.db
    .query("loyaltyTransactions")
    .withIndex("by_operation", (q) => q.eq("operationId", operation._id))
    .collect();
  if (frozenLoyalty === undefined) {
    if (
      operation.loyaltyTransactionId !== undefined ||
      operation.loyaltyAccountId !== undefined ||
      operation.loyaltyPoints !== undefined ||
      accounting.loyaltyTransactionId !== undefined ||
      loyaltyLinks.length > 0 ||
      proof?.loyalty !== undefined
    ) {
      return false;
    }
  } else {
    const loyaltyTransactionId = operation.loyaltyTransactionId;
    const loyaltyAccountId = operation.loyaltyAccountId;
    if (
      loyaltyTransactionId === undefined ||
      loyaltyAccountId === undefined ||
      operation.loyaltyPoints !== frozenLoyalty.points ||
      accounting.loyaltyTransactionId === undefined ||
      proof?.loyalty === undefined
    ) {
      return false;
    }
    const effect = proof.loyalty;
    if (
      effect.transactionId !== accounting.loyaltyTransactionId ||
      effect.transactionId !== loyaltyTransactionId ||
      effect.accountId !== loyaltyAccountId ||
      effect.points !== frozenLoyalty.points ||
      effect.orderId !== firstOrderId
    ) {
      return false;
    }
    const reservation = await ctx.db.get(accounting.loyaltyTransactionId);
    const account = await ctx.db.get(loyaltyAccountId);
    const expectedLoyaltyStatus = accounting.kind === "checkout_captured" ? "captured" : "released";
    // Strict raw by_operation cardinality: a present pointed row must be
    // exactly the only claimed effect link; an absent pointed row requires
    // empty links. A missing sibling or tombstone never hides
    // duplicate/foreign/stray links.
    if (reservation !== null) {
      // A present transaction is always validated independently, even when
      // the account row is absent.
      if (
        loyaltyLinks.length !== 1 ||
        loyaltyLinks[0]?._id !== reservation._id ||
        loyaltyTransactionId !== reservation._id ||
        reservation.operationId !== operation._id ||
        reservation.userId !== operation.ownerId ||
        reservation.accountId !== loyaltyAccountId ||
        reservation.type !== "redeem" ||
        reservation.points !== frozenLoyalty.points ||
        operation.loyaltyPoints !== frozenLoyalty.points ||
        reservation.orderId !== firstOrderId ||
        reservation.status !== expectedLoyaltyStatus
      ) {
        return false;
      }
    } else if (loyaltyLinks.length !== 0) {
      return false;
    }
    if (account !== null) {
      // A present account is always validated independently, even when the
      // transaction row is absent. A wrong-owner or corrupt present account
      // is never waived.
      if (
        account._id !== effect.accountId ||
        account.userId !== operation.ownerId ||
        !isValidLoyaltyCounters(account)
      ) {
        return false;
      }
    }
    if (reservation !== null && account !== null) {
      if (reservation.accountId !== account._id) {
        return false;
      }
    } else if (reservation === null && account === null) {
      // Both facts legitimately erased: only a genuine deleted tombstone
      // with the complete server-written snapshot above still replays the
      // already-funded obligation. Active owners and missing owner rows
      // still hold.
      const owner = await ctx.db.get(operation.ownerId);
      if (!owner || owner.isDeleted !== true) {
        return false;
      }
    } else if (reservation === null && account !== null) {
      // A-row-absent with a retained shared numeric account: an outstanding
      // distinct checkout keeps the account alive after captured history
      // erasure. The account above already validated exactly and A-links
      // are empty, so only the genuine tombstone is still required.
      const owner = await ctx.db.get(operation.ownerId);
      if (!owner || owner.isDeleted !== true) {
        return false;
      }
    } else {
      // A present transaction beside a missing account cannot arise from
      // actual erasure (captured/released rows are always deleted with or
      // before their account): conservatively hold without rebuilding.
      return false;
    }
  }
  return true;
}

// Shared consumed qualifier for cart overlap in BOTH the collection and
// wallet consumers. A checkout keeps its CART coverage until a trusted
// capture or release is positively proven without a hold; bare labels, held
// reviews, and corrupt proof keep blocking while the wallet-branch defense
// stays unchanged. Original ORDER-ID coverage is never freed here: the
// pending-order scanners below do not consult this qualifier at all.
export async function checkoutCoverageConsumed(ctx: ReadCtx, operation: Doc<"paymentOperations">): Promise<boolean> {
  if (!isCheckoutOperation(operation)) {
    return false;
  }
  // A sticky review never frees retry, even when the original funding proof
  // is intrinsically intact. Review is not a financial reversal; only a
  // positively proven capture or release without a hold frees the cart.
  if (operation.reviewNeeded === true) {
    return false;
  }
  if (operation.accounting?.kind !== "checkout_captured" && operation.accounting?.kind !== "checkout_released") {
    return false;
  }
  return await validateCheckoutAccounting(ctx, operation);
}
