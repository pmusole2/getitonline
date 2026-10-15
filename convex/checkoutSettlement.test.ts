import assert from 'node:assert/strict';
import test from 'node:test';

import type { Value } from 'convex/values';

import * as checkoutQuote from './checkoutQuote';
import * as ordersModule from './orders';
import type { CheckoutQuote } from './lib/checkoutQuote';
import { majorNumberToCents } from './lib/catalogMoney';
import type { LencoFetch } from './lib/lencoAdapter';
import type { ProviderReceiptFacts } from './lib/providerOperationContracts';

type CollectionReceiptFacts = Extract<ProviderReceiptFacts, { kind: 'collection' }>;
import * as providerOperations from './providerOperations';
import * as providerSettlement from './providerSettlement';
import * as usersModule from './users';
import * as walletOperations from './paymentOperations';
import * as checkoutCollection from './checkoutCollection';
import { createCheckoutCollectionAction } from './checkoutCollection';
import { createFakeActionCtx, invokeFakeFunction, type FakeModules } from '../tests/support/convexFakeActionCtx';
import { createCtx, createDb, handlerOf, type Db, type Row, type Tables } from '../tests/support/convexFakeDb';

// Task4B checkout settlement through the SAME private writer. Transport is
// intercepted at the adapter fetch boundary only: quote approval,
// reservation, claim, receipt matching and settlement all run for real, and
// the oracle inspects the database at fetch time. The fake cannot prove live
// OCC rollback, so every denial is asserted with unchanged tables.

const SUCCESS_ID = '22222222-2222-3333-4444-555555555555';
const OTHER_ID = '44444444-2222-3333-4444-555555555555';

const ENV: Record<string, string | undefined> = {
  LENCO_API_KEY: 'sk-test-key-value',
};

const PHONE = '0971234567';

const ADDRESS = {
  street: '123 Main',
  city: 'Lusaka',
  province: 'Lusaka',
  country: 'Zambia',
  phone: '0971234567',
};

type FetchCall = { url: string; method: string; body: Value | null };

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ status: true, data }), { status: 200 });
}

function bodyOf(call: FetchCall): Record<string, Value> {
  return (call.body ?? {}) as Record<string, Value>;
}

type Behavior = {
  status?: 'pending' | 'successful' | 'failed';
  fail?: boolean;
};

function createFetch(calls: FetchCall[], behavior: Behavior): LencoFetch {
  return (async (url: string, init: { method: string; body?: string }): Promise<Response> => {
    let body: Value | null = null;
    if (init.body !== undefined) {
      body = JSON.parse(init.body) as Value;
    }
    const call: FetchCall = { url, method: init.method, body };
    calls.push(call);
    if (url.endsWith('/collections/mobile-money')) {
      if (behavior.fail === true) {
        return new Response(JSON.stringify({ status: false, message: 'provider down' }), { status: 500 });
      }
      const args = bodyOf(call);
      const status = behavior.status ?? 'pending';
      return envelope({
        id: SUCCESS_ID,
        reference: args['reference'],
        amount: String(args['amount'] as number),
        currency: 'ZMW',
        status,
        type: 'mobile-money',
        bearer: 'merchant',
        mobileMoneyDetails: { country: 'zm', operator: args['operator'], phone: args['phone'] },
        reasonForFailure: null,
        settlementStatus: null,
      });
    }
    throw new Error(`unexpected provider url ${url}`);
  }) as LencoFetch;
}

function userRow(id: string, clerkId: string, role: string, extra: Record<string, unknown> = {}): Row {
  return {
    _id: id,
    clerkId,
    email: `${clerkId}@example.invalid`,
    firstName: id,
    lastName: 'Test',
    role,
    isBanned: false,
    totalSales: 0,
    totalPurchases: 0,
    isVerified: true,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

function productRow(id: string, sellerId: string, extra: Record<string, unknown> = {}): Row {
  return {
    _id: id,
    sellerId,
    title: `Title ${id}`,
    description: 'A test listing',
    price: 100,
    images: ['https://images.invalid/x.jpg'],
    condition: 'good',
    status: 'active',
    quantity: 10,
    categoryId: 'categories|1',
    shippingOptions: [{ name: 'Courier', price: 50 }],
    views: 0,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

function fixtureTables(): Tables {
  const now = Date.now();
  return {
    users: [
      userRow('users|buyer', 'clerk_buyer', 'user'),
      userRow('users|other', 'clerk_other', 'user'),
      userRow('users|seller', 'clerk_seller', 'user'),
      userRow('users|seller2', 'clerk_seller2', 'user'),
    ],
    vendorProfiles: [
      {
        _id: 'vendorProfiles|seller',
        ownerUserId: 'users|seller',
        status: 'approved',
        storeName: 'Seller',
        slug: 'seller',
      },
      {
        _id: 'vendorProfiles|seller2',
        ownerUserId: 'users|seller2',
        status: 'approved',
        storeName: 'Seller2',
        slug: 'seller2',
      },
    ],
    platformSettings: [
      {
        _id: 'platformSettings|1',
        key: 'singleton',
        companySellerUserId: 'users|company',
        companyDisplayName: 'Gettitonline',
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    appConfig: [
      {
        _id: 'appConfig|1',
        key: 'singleton',
        minimumBuilds: { ios: 1, android: 1 },
        paymentsEnabled: true,
        updatedAt: 1,
      },
    ],
    products: [
      productRow('products|lamp', 'users|seller', { price: 100, quantity: 10, weightKg: 2 }),
      productRow('products|cap', 'users|seller2', {
        price: 10,
        quantity: 100,
        weightKg: 0.5,
        shippingOptions: [{ name: 'Standard', price: 20 }],
      }),
    ],
    cartItems: [],
    orders: [],
    escrow: [],
    transactions: [],
    walletTransactions: [],
    paymentOperations: [],
    paymentAccounts: [],
    promoCodes: [
      {
        _id: 'promoCodes|save10',
        code: 'SAVE10',
        title: 'Save',
        scope: 'platform',
        discountType: 'percent',
        discountValue: 10,
        startsAt: now - 3600000,
        isActive: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    promoCodeRedemptions: [],
    loyaltyAccounts: [
      {
        _id: 'loyaltyAccounts|buyer',
        userId: 'users|buyer',
        pointsBalance: 100,
        lifetimeEarned: 100,
        lifetimeRedeemed: 0,
        tier: 'bronze',
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    loyaltyTransactions: [],
    wallets: [],
    deliveryZones: [
      {
        _id: 'deliveryZones|z1',
        name: 'Lusaka',
        slug: 'lusaka',
        province: 'Lusaka',
        city: 'Lusaka',
        isActive: true,
        sortOrder: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    deliveryMethods: [
      {
        _id: 'deliveryMethods|m1',
        zoneId: 'deliveryZones|z1',
        name: 'Standard',
        code: 'STD',
        type: 'standard',
        baseFee: 20,
        perKgFee: 10,
        minDays: 1,
        maxDays: 3,
        isActive: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    pickupPoints: [],
    notifications: [],
    behaviorEvents: [],
  };
}

type Harness = {
  db: Db;
  calls: FetchCall[];
  modules: FakeModules;
  fetchImpl: LencoFetch;
  behavior: Behavior;
};

function open(behavior: Behavior = {}): Harness {
  const db = createDb(fixtureTables());
  const calls: FetchCall[] = [];
  const fetchImpl = createFetch(calls, behavior);
  return {
    db,
    calls,
    modules: {
      checkoutCollection: { ...checkoutCollection },
      providerOperations: { ...providerOperations },
      providerSettlement: { ...providerSettlement },
    },
    fetchImpl,
    behavior,
  };
}

function actionOf(harness: Harness) {
  return createCheckoutCollectionAction({ env: () => ({ ...ENV }), fetchImpl: harness.fetchImpl });
}

function actionCtx(harness: Harness, subject: string | null) {
  return createFakeActionCtx({ db: harness.db, subject, modules: harness.modules });
}

function snapshot(db: Db): Tables {
  return structuredClone(db.tables);
}

let cartSeedCounter = 0;

function seedCartLine(db: Db, productId: string, quantity: number): string {
  const rows = db.tables.cartItems;
  assert.ok(rows, 'cartItems table must exist');
  cartSeedCounter += 1;
  const id = `cartItems|seed${cartSeedCounter}`;
  rows.push({
    _id: id,
    userId: 'users|buyer',
    productId,
    quantity,
    selectedShipping: { name: 'Courier', price: 50 },
    createdAt: 1,
    updatedAt: 1,
  });
  return id;
}

function findRow(db: Db, table: string, id: string): Row {
  const row = db.tables[table]?.find((candidate) => candidate._id === id);
  assert.ok(row, `${id} must exist in ${table}`);
  return row;
}

function tableRows(db: Db, table: string): Row[] {
  return db.tables[table] ?? [];
}

function orderIdsOf(operation: Row): string[] {
  const orderIds = operation['orderIds'] as string[];
  assert.ok(Array.isArray(orderIds));
  return orderIds;
}

function firstOrderId(operation: Row): string {
  const id: unknown = orderIdsOf(operation)[0];
  if (typeof id !== 'string') {
    throw new Error('a checkout operation must carry at least one order id');
  }
  return id;
}

function centsOf(major: unknown): number {
  if (typeof major !== 'number') {
    throw new Error(`stored money must be a number, got ${typeof major}`);
  }
  const cents = majorNumberToCents(major);
  assert.ok(cents !== null, 'stored money must convert to exact cents');
  return cents;
}

function numberOf(row: Row, field: string): number {
  const value = row[field];
  assert.equal(typeof value, 'number', `${field} must be a number`);
  return value as number;
}

async function freshQuote(db: Db, clerkId: string, args: Record<string, unknown>): Promise<CheckoutQuote> {
  const result = (await invokeFakeFunction(checkoutQuote.quoteCheckout, createCtx(db, clerkId), args)) as {
    ok: boolean;
    code?: string;
    quote?: CheckoutQuote;
  };
  if (!result.ok || !result.quote) {
    throw new Error(`expected an ok quote, got ${result.code}`);
  }
  return result.quote;
}

function checkoutArgs(
  requestId: string,
  quoteKey: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    requestId,
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
    expectedQuoteKey: quoteKey,
    phone: PHONE,
    operator: 'mtn',
    ...extra,
  };
}

async function initiate(harness: Harness, clerkId: string | null, args: Record<string, unknown>): Promise<unknown> {
  return await invokeFakeFunction(actionOf(harness), actionCtx(harness, clerkId), args);
}

type InitiateOk = { ok: true; operationId: string; status: string; providerReference: string };

function okResult(result: unknown): InitiateOk {
  const parsed = result as InitiateOk;
  if (parsed.ok !== true) {
    throw new Error(`expected a successful initiation, got ${JSON.stringify(result)}`);
  }
  return parsed;
}

function matchingReceipt(operation: Row, status: 'successful' | 'failed' | 'pending'): CollectionReceiptFacts {
  return {
    kind: 'collection',
    id: SUCCESS_ID,
    reference: String(operation['providerReference']),
    amountMinor: numberOf(operation, 'amountCents'),
    feeMinor: null,
    currency: 'ZMW',
    status,
    collectionType: 'mobile-money',
    country: 'zm',
    bearer: 'merchant',
    operator: 'mtn',
    phone: PHONE,
    reasonForFailure: null,
    settlementStatus: null,
  };
}

async function settleCheckout(
  db: Db,
  operation: Row,
  status: 'successful' | 'failed' | 'pending',
  receipt?: ProviderReceiptFacts,
): Promise<unknown> {
  return await invokeFakeFunction(providerSettlement.settleProviderReceipt, createCtx(db, null), {
    operationId: operation._id,
    receipt: receipt ?? matchingReceipt(operation, status),
    acquisition: { kind: 'initiation_post', operationId: operation._id },
  });
}

function seedWallet(db: Db): void {
  tableRows(db, 'wallets').push({
    _id: 'wallets|users|buyer',
    userId: 'users|buyer',
    balance: 1000,
    pendingBalance: 0,
    totalEarned: 1000,
    totalWithdrawn: 0,
    totalSpent: 0,
    isActive: true,
    isFrozen: false,
    createdAt: 1,
    updatedAt: 1,
  });
}

async function walletFailureCode(db: Db, clerkId: string | null, args: Record<string, unknown>): Promise<string> {
  try {
    const result = (await invokeFakeFunction(walletOperations.purchaseWithWallet, createCtx(db, clerkId), args)) as {
      ok: boolean;
      code?: string;
    };
    if (result.ok === false && typeof result.code === 'string') {
      return result.code;
    }
    throw new Error(`expected the wallet purchase to fail, got ${JSON.stringify(result)}`);
  } catch (error) {
    if (error instanceof Error && 'data' in error) {
      const data = (error as { data: { code?: unknown } }).data;
      if (typeof data.code === 'string') {
        return data.code;
      }
    }
    if (error instanceof Error && 'code' in error && typeof (error as { code: unknown }).code === 'string') {
      return (error as { code: string }).code;
    }
    throw error;
  }
}

async function checkoutFailureCode(harness: Harness, args: Record<string, unknown>): Promise<string> {
  try {
    const result = (await initiate(harness, 'clerk_buyer', args)) as { ok: boolean; code?: string };
    if (result.ok === false && typeof result.code === 'string') {
      return result.code;
    }
    throw new Error(`expected the checkout to fail, got ${JSON.stringify(result)}`);
  } catch (error) {
    if (error instanceof Error && 'data' in error) {
      const data = (error as { data: { code?: unknown } }).data;
      if (typeof data.code === 'string') {
        return data.code;
      }
    }
    throw error;
  }
}

// ---- TDD RED: the same writer must capture checkout success ----

test('checkout success settles through the same writer: paid orders, held escrow, captured discounts', async () => {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  seedCartLine(harness.db, 'products|cap', 2);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
    promoCode: 'SAVE10',
    loyaltyPoints: 20,
  });
  assert.ok(quote.promo && quote.loyalty);
  const lampBefore = numberOf(findRow(harness.db, 'products', 'products|lamp'), 'quantity');
  const capBefore = numberOf(findRow(harness.db, 'products', 'products|cap'), 'quantity');
  const started = okResult(
    await initiate(
      harness,
      'clerk_buyer',
      checkoutArgs('req-settle-ok', quote.quoteKey, { promoCode: 'SAVE10', loyaltyPoints: 20 }),
    ),
  );
  const operation = findRow(harness.db, 'paymentOperations', started.operationId);
  const result = (await settleCheckout(harness.db, operation, 'successful')) as {
    operationId: string;
    status: string;
    application: string;
  };
  assert.equal(result.application, 'applied');
  assert.equal(result.status, 'succeeded');
  const settled = findRow(harness.db, 'paymentOperations', started.operationId);
  assert.equal(settled['status'], 'succeeded');
  const orderIds = settled['orderIds'] as string[];
  assert.equal(orderIds.length, 2);
  for (const orderId of orderIds) {
    assert.equal(findRow(harness.db, 'orders', orderId)['status'], 'paid');
  }
  const escrows = tableRows(harness.db, 'escrow').filter((row) => row['operationId'] === started.operationId);
  assert.equal(escrows.length, 2);
  for (const escrow of escrows) {
    assert.equal(escrow['status'], 'held');
  }
  assert.equal(findRow(harness.db, 'transactions', String(settled['transactionId']))['status'], 'successful');
  const redemption = findRow(harness.db, 'promoCodeRedemptions', String(settled['promoRedemptionId']));
  assert.equal(redemption['status'], 'captured');
  const loyaltyTx = findRow(harness.db, 'loyaltyTransactions', String(settled['loyaltyTransactionId']));
  assert.equal(loyaltyTx['status'], 'captured');
  const account = findRow(harness.db, 'loyaltyAccounts', 'loyaltyAccounts|buyer');
  assert.equal(account['pointsBalance'], 80);
  assert.equal(account['lifetimeRedeemed'], 20);
  // No second stock or points debit on capture.
  assert.equal(numberOf(findRow(harness.db, 'products', 'products|lamp'), 'quantity'), lampBefore - 1);
  assert.equal(numberOf(findRow(harness.db, 'products', 'products|cap'), 'quantity'), capBefore - 2);
  // Captured cart rows are cleaned; the proof marker is consumed.
  assert.equal(tableRows(harness.db, 'cartItems').length, 0);
  assert.notEqual(settled['accounting'], undefined);
});

// ---- TDD RED: trusted failure releases exactly the reservations ----

test('checkout failure releases stock, promo and points exactly once with cart retained', async () => {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
    promoCode: 'SAVE10',
    loyaltyPoints: 20,
  });
  const lampBefore = numberOf(findRow(harness.db, 'products', 'products|lamp'), 'quantity');
  const started = okResult(
    await initiate(
      harness,
      'clerk_buyer',
      checkoutArgs('req-settle-fail', quote.quoteKey, { promoCode: 'SAVE10', loyaltyPoints: 20 }),
    ),
  );
  assert.equal(numberOf(findRow(harness.db, 'products', 'products|lamp'), 'quantity'), lampBefore - 1);
  const operation = findRow(harness.db, 'paymentOperations', started.operationId);
  const result = (await settleCheckout(harness.db, operation, 'failed')) as {
    operationId: string;
    status: string;
    application: string;
  };
  assert.equal(result.application, 'applied');
  assert.equal(result.status, 'failed');
  const settled = findRow(harness.db, 'paymentOperations', started.operationId);
  const orderIds = settled['orderIds'] as string[];
  for (const orderId of orderIds) {
    assert.equal(findRow(harness.db, 'orders', orderId)['status'], 'cancelled');
  }
  assert.equal(findRow(harness.db, 'transactions', String(settled['transactionId']))['status'], 'failed');
  assert.equal(findRow(harness.db, 'promoCodeRedemptions', String(settled['promoRedemptionId']))['status'], 'released');
  assert.equal(
    findRow(harness.db, 'loyaltyTransactions', String(settled['loyaltyTransactionId']))['status'],
    'released',
  );
  const account = findRow(harness.db, 'loyaltyAccounts', 'loyaltyAccounts|buyer');
  assert.equal(account['pointsBalance'], 100);
  assert.equal(account['lifetimeRedeemed'], 0);
  // Exact original inventory restored once; cart rows stay for retry.
  assert.equal(numberOf(findRow(harness.db, 'products', 'products|lamp'), 'quantity'), lampBefore);
  assert.equal(tableRows(harness.db, 'cartItems').length, 1);
  assert.equal(tableRows(harness.db, 'escrow').length, 0);
});

// ---- TDD RED: the POST receipt enters the same writer with one POST ----

test('checkout POST success settles through the writer with exactly one POST', async () => {
  const harness = open({ status: 'successful' });
  seedCartLine(harness.db, 'products|lamp', 1);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const result = okResult(await initiate(harness, 'clerk_buyer', checkoutArgs('req-post-ok', quote.quoteKey)));
  assert.equal(harness.calls.length, 1);
  assert.equal(result.status, 'succeeded');
  const operation = findRow(harness.db, 'paymentOperations', result.operationId);
  assert.equal(operation['status'], 'succeeded');
  assert.notEqual(operation['accounting'], undefined);
  for (const orderId of operation['orderIds'] as string[]) {
    assert.equal(findRow(harness.db, 'orders', orderId)['status'], 'paid');
  }
});

// ---- Proven release frees cart retry in BOTH consumers ----

test('proven checkout release frees the same cart for a fresh collection retry', async () => {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const started = okResult(await initiate(harness, 'clerk_buyer', checkoutArgs('req-retry-1', quote.quoteKey)));
  await settleCheckout(harness.db, findRow(harness.db, 'paymentOperations', started.operationId), 'failed');
  // Same cart retries as a fresh collection.
  const secondQuote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const retried = okResult(await initiate(harness, 'clerk_buyer', checkoutArgs('req-retry-2', secondQuote.quoteKey)));
  assert.notEqual(retried.operationId, started.operationId);
});

test('proven checkout release frees the same cart for a wallet purchase', async () => {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  seedWallet(harness.db);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const started = okResult(await initiate(harness, 'clerk_buyer', checkoutArgs('req-retry-1', quote.quoteKey)));
  await settleCheckout(harness.db, findRow(harness.db, 'paymentOperations', started.operationId), 'failed');
  const walletQuote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const purchased = (await invokeFakeFunction(
    walletOperations.purchaseWithWallet,
    createCtx(harness.db, 'clerk_buyer'),
    {
      requestId: 'req-retry-wallet',
      source: 'cart',
      deliveryMethodId: 'deliveryMethods|m1',
      shippingAddress: ADDRESS,
      expectedQuoteKey: walletQuote.quoteKey,
    },
  )) as { ok: boolean };
  assert.equal(purchased.ok, true);
});

// ---- Bare terminal labels still block both consumers without proof ----

test('bare failed label without proof still blocks both consumers', async () => {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  seedWallet(harness.db);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const started = okResult(await initiate(harness, 'clerk_buyer', checkoutArgs('req-bare-1', quote.quoteKey)));
  findRow(harness.db, 'paymentOperations', started.operationId)['status'] = 'failed';
  const before = snapshot(harness.db);
  const fresh = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  assert.equal(await checkoutFailureCode(harness, checkoutArgs('req-bare-2', fresh.quoteKey)), 'order_overlap');
  assert.deepEqual(snapshot(harness.db), before);
  assert.equal(
    await walletFailureCode(harness.db, 'clerk_buyer', {
      requestId: 'req-bare-wallet',
      source: 'cart',
      deliveryMethodId: 'deliveryMethods|m1',
      shippingAddress: ADDRESS,
      expectedQuoteKey: fresh.quoteKey,
    }),
    'order_overlap',
  );
  assert.deepEqual(snapshot(harness.db), before);
});

// ---- Extended coverage helpers ----

function seedOrder(
  db: Db,
  orderId: string,
  buyerId: string,
  sellerId: string,
  status: string,
  items: Record<string, unknown>[],
  extra: Record<string, unknown> = {},
): void {
  const rows = db.tables.orders;
  assert.ok(rows, 'orders table must exist');
  rows.push({
    _id: orderId,
    orderNumber: orderId,
    buyerId,
    sellerId,
    items,
    subtotal: 0,
    shippingCost: 0,
    platformFee: 0,
    totalAmount: 0,
    sellerPayout: 0,
    shippingAddress: ADDRESS,
    status,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  });
}

function lampItem(quantity: number): Record<string, unknown> {
  return { productId: 'products|lamp', title: 'Lamp', price: 100, quantity, image: 'https://images.invalid/x.jpg' };
}

function capItem(quantity: number): Record<string, unknown> {
  return { productId: 'products|cap', title: 'Cap', price: 10, quantity, image: 'https://images.invalid/x.jpg' };
}

type SettleResult = { operationId: string; status: string; application: string };

function appliedResult(result: unknown): SettleResult {
  const parsed = result as SettleResult;
  assert.ok(parsed && typeof parsed.application === 'string');
  return parsed;
}

async function settleCheckoutGet(db: Db, operation: Row, status: 'successful' | 'failed'): Promise<unknown> {
  return await invokeFakeFunction(providerSettlement.settleProviderReceipt, createCtx(db, null), {
    operationId: operation._id,
    receipt: matchingReceipt(operation, status),
    acquisition: {
      kind: 'status_get',
      lookup: { kind: 'reference', reference: String(operation['providerReference']) },
    },
  });
}

async function settleForeignStatusGet(db: Db, operation: Row): Promise<unknown> {
  return await invokeFakeFunction(providerSettlement.settleProviderReceipt, createCtx(db, null), {
    operationId: operation._id,
    receipt: matchingReceipt(operation, 'successful'),
    acquisition: {
      kind: 'status_get',
      lookup: { kind: 'reference', reference: 'TXN-foreign' },
    },
  });
}

async function createRealOrder(db: Db, args: Record<string, unknown>): Promise<string> {
  const orderId = (await invokeFakeFunction(ordersModule.createOrder, createCtx(db, 'clerk_buyer'), args)) as unknown;
  assert.equal(typeof orderId, 'string');
  return orderId as string;
}

function variantLine(variantId: string, sku: string, color: string, quantity: number): Record<string, unknown> {
  return {
    productId: 'products|shirt',
    title: 'Shirt',
    price: 50,
    quantity,
    image: 'https://images.invalid/shirt.jpg',
    selectedVariant: {
      variantId,
      sku,
      attributes: [{ name: 'Color', value: color }],
      price: 50,
    },
  };
}

function pendingArgs(
  requestId: string,
  quoteKey: string,
  orderIds: string[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    requestId,
    source: 'pending_orders',
    orderIds,
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
    expectedQuoteKey: quoteKey,
    phone: PHONE,
    operator: 'mtn',
    ...extra,
  };
}

// ---- Pending source: multi-seller and unequal same-seller pairing ----

test('pending capture pairs every order by identity with exact per-order escrow', async () => {
  const harness = open();
  seedWallet(harness.db);
  seedOrder(harness.db, 'orders|p1', 'users|buyer', 'users|seller', 'pending_payment', [lampItem(1)], {
    notes: 'Gift wrap please.',
  });
  seedOrder(harness.db, 'orders|p2', 'users|buyer', 'users|seller', 'pending_payment', [lampItem(2)]);
  seedOrder(harness.db, 'orders|p3', 'users|buyer', 'users|seller2', 'pending_payment', [capItem(3)]);
  // Simulate the real createOrder reservation the pending source retains.
  findRow(harness.db, 'products', 'products|lamp')['quantity'] = 7;
  const walletBefore = numberOf(findRow(harness.db, 'wallets', 'wallets|users|buyer'), 'balance');
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'pending_orders',
    orderIds: ['orders|p1', 'orders|p2', 'orders|p3'],
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const started = okResult(
    await initiate(
      harness,
      'clerk_buyer',
      pendingArgs('req-pend-cap', quote.quoteKey, ['orders|p1', 'orders|p2', 'orders|p3']),
    ),
  );
  // Pending inventory is never decremented again at persist.
  assert.equal(numberOf(findRow(harness.db, 'products', 'products|lamp'), 'quantity'), 7);
  const result = appliedResult(
    await settleCheckout(harness.db, findRow(harness.db, 'paymentOperations', started.operationId), 'successful'),
  );
  assert.equal(result.application, 'applied');
  assert.equal(result.status, 'succeeded');
  const settled = findRow(harness.db, 'paymentOperations', started.operationId);
  const breakdowns = settled['orderBreakdowns'] as Array<Record<string, unknown>>;
  assert.equal(breakdowns.length, 3);
  // The two same-seller orders keep unequal slices: no whole seller total is
  // copied into either order or escrow.
  const first = breakdowns.find((entry) => entry['orderId'] === 'orders|p1');
  const second = breakdowns.find((entry) => entry['orderId'] === 'orders|p2');
  assert.ok(first && second && first['totalAmountCents'] !== second['totalAmountCents']);
  for (const orderId of ['orders|p1', 'orders|p2', 'orders|p3'] as const) {
    const order = findRow(harness.db, 'orders', orderId);
    assert.equal(order['status'], 'paid');
    const breakdown = breakdowns.find((entry) => entry['orderId'] === orderId);
    assert.ok(breakdown);
    assert.equal(centsOf(order['totalAmount']), breakdown['totalAmountCents']);
    const holds = tableRows(harness.db, 'escrow').filter((row) => row['orderId'] === orderId);
    assert.equal(holds.length, 1);
    const hold = holds[0] as Row;
    assert.equal(hold['status'], 'held');
    assert.equal(hold['operationId'], started.operationId);
    assert.equal(hold['buyerId'], 'users|buyer');
    assert.equal(centsOf(hold['grossAmount']), breakdown['totalAmountCents']);
    assert.equal(centsOf(hold['amount']), breakdown['totalAmountCents']);
    assert.equal(centsOf(hold['platformFee']), breakdown['platformFeeCents']);
    assert.equal(centsOf(hold['sellerAmount']), breakdown['sellerPayoutCents']);
  }
  // Original notes survive capture; no wallet money moves in 4B.
  assert.equal(findRow(harness.db, 'orders', 'orders|p1')['notes'], 'Gift wrap please.');
  assert.equal(numberOf(findRow(harness.db, 'wallets', 'wallets|users|buyer'), 'balance'), walletBefore);
  assert.equal(tableRows(harness.db, 'walletTransactions').length, 0);
  // Mobile-money notices only: one seller receipt and one buyer success per
  // order, never a wallet-debit notice.
  const notices = tableRows(harness.db, 'notifications');
  assert.equal(notices.filter((row) => row['type'] === 'payment_received').length, 3);
  assert.equal(notices.filter((row) => row['type'] === 'order_status_update').length, 3);
  assert.equal(notices.filter((row) => row['type'] === 'wallet_debit').length, 0);
  assert.ok(notices.every((row) => typeof row['message'] === 'string' && !String(row['message']).includes('wallet')));
});

test('pending failure restores the exact aggregate across multiple orders per product', async () => {
  const harness = open();
  seedOrder(harness.db, 'orders|p1', 'users|buyer', 'users|seller', 'pending_payment', [lampItem(1)]);
  seedOrder(harness.db, 'orders|p2', 'users|buyer', 'users|seller', 'pending_payment', [lampItem(2)]);
  // The real createOrder reservation the pending source retains.
  findRow(harness.db, 'products', 'products|lamp')['quantity'] = 7;
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'pending_orders',
    orderIds: ['orders|p1', 'orders|p2'],
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const started = okResult(
    await initiate(harness, 'clerk_buyer', pendingArgs('req-pend-fail', quote.quoteKey, ['orders|p1', 'orders|p2'])),
  );
  const result = appliedResult(
    await settleCheckout(harness.db, findRow(harness.db, 'paymentOperations', started.operationId), 'failed'),
  );
  assert.equal(result.application, 'applied');
  // 1 + 2 units return once across the two same-product orders.
  assert.equal(numberOf(findRow(harness.db, 'products', 'products|lamp'), 'quantity'), 10);
  for (const orderId of ['orders|p1', 'orders|p2'] as const) {
    assert.equal(findRow(harness.db, 'orders', orderId)['status'], 'cancelled');
  }
  const settled = findRow(harness.db, 'paymentOperations', started.operationId);
  assert.equal((settled['accounting'] as { kind: string }).kind, 'checkout_released');
  // A matching replay releases nothing twice.
  const money = structuredClone({ products: harness.db.tables['products'], escrow: harness.db.tables['escrow'] });
  const replay = appliedResult(
    await settleCheckout(harness.db, findRow(harness.db, 'paymentOperations', started.operationId), 'failed'),
  );
  assert.equal(replay.application, 'applied');
  assert.deepEqual({ products: harness.db.tables['products'], escrow: harness.db.tables['escrow'] }, money);
});

// ---- Variants: exact authoritative restore and fail-closed edits ----

function seedShirt(db: Db): void {
  tableRows(db, 'products').push({
    _id: 'products|shirt',
    sellerId: 'users|seller',
    title: 'Shirt',
    description: 'A test shirt',
    price: 50,
    images: ['https://images.invalid/shirt.jpg'],
    condition: 'good',
    status: 'active',
    quantity: 10,
    categoryId: 'categories|1',
    shippingOptions: [{ name: 'Courier', price: 50 }],
    variantCombinations: [
      {
        id: 'v-red',
        sku: 'SHIRT-RED',
        attributes: [{ name: 'Color', value: 'Red' }],
        price: 50,
        stock: 5,
        status: 'active',
      },
      {
        id: 'v-blue',
        sku: 'SHIRT-BLUE',
        attributes: [{ name: 'Color', value: 'Blue' }],
        price: 50,
        stock: 7,
        status: 'active',
      },
    ],
    views: 0,
    createdAt: 1,
    updatedAt: 1,
  });
}

function seedShirtLine(db: Db, quantity: number): string {
  const rows = db.tables.cartItems;
  assert.ok(rows, 'cartItems table must exist');
  cartSeedCounter += 1;
  const id = `cartItems|variant${cartSeedCounter}`;
  rows.push({
    _id: id,
    userId: 'users|buyer',
    productId: 'products|shirt',
    quantity,
    selectedShipping: { name: 'Courier', price: 50 },
    selectedVariant: {
      variantId: 'v-red',
      sku: 'SHIRT-RED',
      attributes: [{ name: 'Color', value: 'Red' }],
      price: 50,
    },
    createdAt: 1,
    updatedAt: 1,
  });
  return id;
}

test('failure restores aggregate and authoritative variant stock while preserving unrelated variants', async () => {
  const harness = open();
  seedShirt(harness.db);
  seedShirtLine(harness.db, 2);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const started = okResult(await initiate(harness, 'clerk_buyer', checkoutArgs('req-variant', quote.quoteKey)));
  const reserved = findRow(harness.db, 'products', 'products|shirt');
  assert.equal(numberOf(reserved, 'quantity'), 8);
  const reservedCombos = reserved['variantCombinations'] as Array<Record<string, unknown>>;
  assert.equal((reservedCombos.find((entry) => entry['id'] === 'v-red') as Record<string, unknown>)['stock'], 3);
  const result = appliedResult(
    await settleCheckout(harness.db, findRow(harness.db, 'paymentOperations', started.operationId), 'failed'),
  );
  assert.equal(result.application, 'applied');
  const restored = findRow(harness.db, 'products', 'products|shirt');
  assert.equal(numberOf(restored, 'quantity'), 10);
  const combos = restored['variantCombinations'] as Array<Record<string, unknown>>;
  assert.equal((combos.find((entry) => entry['id'] === 'v-red') as Record<string, unknown>)['stock'], 5);
  // The unrelated combination is preserved byte-for-byte.
  assert.deepEqual(
    combos.find((entry) => entry['id'] === 'v-blue'),
    reservedCombos.find((entry) => entry['id'] === 'v-blue') as Record<string, unknown>,
  );
});

test('failure holds the whole set when the purchased variant no longer exists', async () => {
  const harness = open();
  seedShirt(harness.db);
  seedShirtLine(harness.db, 1);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const started = okResult(await initiate(harness, 'clerk_buyer', checkoutArgs('req-variant-gone', quote.quoteKey)));
  // The seller edits the catalog after the claim: the variant disappears.
  const product = findRow(harness.db, 'products', 'products|shirt');
  product['variantCombinations'] = (product['variantCombinations'] as Array<Record<string, unknown>>).filter(
    (entry) => entry['id'] !== 'v-red',
  );
  const result = appliedResult(
    await settleCheckout(harness.db, findRow(harness.db, 'paymentOperations', started.operationId), 'failed'),
  );
  assert.equal(result.application, 'review');
  assert.equal(result.status, 'unknown');
  const held = findRow(harness.db, 'paymentOperations', started.operationId);
  assert.equal(held['reviewNeeded'], true);
  assert.equal(held['accounting'], undefined);
  // No reservation business is released and no stock is minted from a guess.
  for (const orderId of held['orderIds'] as string[]) {
    assert.equal(findRow(harness.db, 'orders', orderId)['status'], 'pending_payment');
  }
  assert.equal(numberOf(findRow(harness.db, 'products', 'products|shirt'), 'quantity'), 9);
});

// ---- Late, conflicting, and duplicate funds are never re-applied ----

test('late success after applied failure records funds with no resurrection', async () => {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const started = okResult(await initiate(harness, 'clerk_buyer', checkoutArgs('req-late-ok', quote.quoteKey)));
  const operation = findRow(harness.db, 'paymentOperations', started.operationId);
  const lampAfterReserve = numberOf(findRow(harness.db, 'products', 'products|lamp'), 'quantity');
  const failed = appliedResult(await settleCheckout(harness.db, operation, 'failed'));
  assert.equal(failed.application, 'applied');
  assert.equal(numberOf(findRow(harness.db, 'products', 'products|lamp'), 'quantity'), lampAfterReserve + 1);
  // A late successful receipt for the same reference records its funds and
  // holds the whole set for review instead of resurrecting anything.
  const late = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(late.application, 'review');
  assert.equal(late.status, 'unknown');
  const held = findRow(harness.db, 'paymentOperations', started.operationId);
  assert.equal(held['status'], 'failed');
  assert.equal((held['accounting'] as { kind: string }).kind, 'checkout_released');
  assert.equal((held['receivedFunds'] as { receipt: { id: string } }).receipt.id, SUCCESS_ID);
  for (const orderId of held['orderIds'] as string[]) {
    assert.equal(findRow(harness.db, 'orders', orderId)['status'], 'cancelled');
  }
  assert.equal(tableRows(harness.db, 'escrow').length, 0);
  assert.equal(numberOf(findRow(harness.db, 'products', 'products|lamp'), 'quantity'), lampAfterReserve + 1);
  // The original failure proof still replays without a second release.
  const replay = appliedResult(await settleCheckout(harness.db, operation, 'failed'));
  assert.equal(replay.application, 'review');
  assert.equal(numberOf(findRow(harness.db, 'products', 'products|lamp'), 'quantity'), lampAfterReserve + 1);
});

test('failed receipt after applied success retains proof with no reversal or restock', async () => {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const started = okResult(await initiate(harness, 'clerk_buyer', checkoutArgs('req-late-fail', quote.quoteKey)));
  const operation = findRow(harness.db, 'paymentOperations', started.operationId);
  const lampAfterCapture = numberOf(findRow(harness.db, 'products', 'products|lamp'), 'quantity');
  const succeeded = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(succeeded.application, 'applied');
  const escrowsBefore = tableRows(harness.db, 'escrow').length;
  const late = appliedResult(await settleCheckout(harness.db, operation, 'failed'));
  assert.equal(late.application, 'review');
  const held = findRow(harness.db, 'paymentOperations', started.operationId);
  assert.equal(held['status'], 'succeeded');
  assert.equal((held['accounting'] as { kind: string }).kind, 'checkout_captured');
  for (const orderId of held['orderIds'] as string[]) {
    assert.equal(findRow(harness.db, 'orders', orderId)['status'], 'paid');
  }
  // No automatic refund, reversal, or restock.
  assert.equal(tableRows(harness.db, 'escrow').length, escrowsBefore);
  assert.ok(
    tableRows(harness.db, 'escrow').every(
      (row) => row['status'] === 'held' && row['operationId'] === started.operationId,
    ),
  );
  assert.equal(numberOf(findRow(harness.db, 'products', 'products|lamp'), 'quantity'), lampAfterCapture);
  assert.equal(tableRows(harness.db, 'walletTransactions').length, 0);
});

test('matching replay of applied capture changes nothing and retains enrichment', async () => {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const started = okResult(await initiate(harness, 'clerk_buyer', checkoutArgs('req-replay', quote.quoteKey)));
  const operation = findRow(harness.db, 'paymentOperations', started.operationId);
  const first = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(first.application, 'applied');
  const before = snapshot(harness.db);
  const escrowsBefore = tableRows(harness.db, 'escrow').length;
  const noticesBefore = tableRows(harness.db, 'notifications').length;
  // Exact replay applies nothing twice.
  const replay = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(replay.application, 'applied');
  assert.equal(tableRows(harness.db, 'escrow').length, escrowsBefore);
  assert.equal(tableRows(harness.db, 'notifications').length, noticesBefore);
  // Same-terminal enrichment is retained as an observation without new money.
  const enriched = appliedResult(
    await settleCheckout(harness.db, operation, 'successful', {
      ...matchingReceipt(operation, 'successful'),
      feeMinor: 70,
      settlementStatus: 'settled',
    }),
  );
  assert.equal(enriched.application, 'applied');
  assert.equal(tableRows(harness.db, 'escrow').length, escrowsBefore);
  assert.equal(tableRows(harness.db, 'notifications').length, noticesBefore);
  assert.ok(((operation['receiptObservations'] as unknown[]) ?? []).length > 0);
  void before;
});

// ---- Mismatched and conflicting receipts hold everything ----

test('mismatched receipt facts hold with sticky review and unchanged reservations', async () => {
  const cases: Array<[string, (value: CollectionReceiptFacts, operation: Row) => CollectionReceiptFacts]> = [
    ['amount', (value) => ({ ...value, amountMinor: value.amountMinor + 1 })],
    ['reference', (value) => ({ ...value, reference: 'TXN-wrong-reference' })],
    ['phone', (value) => ({ ...value, phone: '0970000000' })],
    ['operator', (value) => ({ ...value, operator: 'airtel' as const })],
  ];
  for (const [name, corrupt] of cases) {
    const harness = open();
    seedCartLine(harness.db, 'products|lamp', 1);
    const quote = await freshQuote(harness.db, 'clerk_buyer', {
      source: 'cart',
      deliveryMethodId: 'deliveryMethods|m1',
      shippingAddress: ADDRESS,
    });
    const lampBefore = numberOf(findRow(harness.db, 'products', 'products|lamp'), 'quantity');
    const started = okResult(await initiate(harness, 'clerk_buyer', checkoutArgs(`req-bad-${name}`, quote.quoteKey)));
    const operation = findRow(harness.db, 'paymentOperations', started.operationId);
    const money = structuredClone({
      products: harness.db.tables['products'],
      orders: harness.db.tables['orders'],
      escrow: harness.db.tables['escrow'],
      promo: harness.db.tables['promoCodeRedemptions'],
      loyalty: harness.db.tables['loyaltyTransactions'],
    });
    const result = appliedResult(
      await settleCheckout(
        harness.db,
        operation,
        'successful',
        corrupt(matchingReceipt(operation, 'successful'), operation),
      ),
    );
    assert.equal(result.application, 'review', name);
    assert.equal(operation['reviewNeeded'], true, name);
    assert.equal(operation['accounting'], undefined, name);
    assert.deepEqual(
      {
        products: harness.db.tables['products'],
        orders: harness.db.tables['orders'],
        escrow: harness.db.tables['escrow'],
        promo: harness.db.tables['promoCodeRedemptions'],
        loyalty: harness.db.tables['loyaltyTransactions'],
      },
      money,
      name,
    );
    assert.equal(numberOf(findRow(harness.db, 'products', 'products|lamp'), 'quantity'), lampBefore - 1, name);
    // A later matching receipt cannot silently clear the earlier conflict.
    const later = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
    assert.equal(later.application, 'review', name);
    assert.equal(operation['accounting'], undefined, name);
  }
});

test('wrong acquisition provenance cannot apply funds', async () => {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const started = okResult(await initiate(harness, 'clerk_buyer', checkoutArgs('req-bad-prov', quote.quoteKey)));
  const operation = findRow(harness.db, 'paymentOperations', started.operationId);
  const before = structuredClone(harness.db.tables['orders']);
  for (const acquisition of [
    { kind: 'initiation_post', operationId: 'paymentOperations|wrong' },
    { kind: 'status_get', lookup: { kind: 'reference', reference: 'TXN-wrong' } },
  ] as const) {
    const result = (await invokeFakeFunction(providerSettlement.settleProviderReceipt, createCtx(harness.db, null), {
      operationId: operation._id,
      receipt: matchingReceipt(operation, 'successful'),
      acquisition,
    })) as SettleResult;
    assert.equal(result.application, 'review');
  }
  assert.deepEqual(harness.db.tables['orders'], before);
  assert.equal(operation['accounting'], undefined);
});

test('a different bound provider id holds without replacing the first binding', async () => {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const started = okResult(await initiate(harness, 'clerk_buyer', checkoutArgs('req-bound-id', quote.quoteKey)));
  const operation = findRow(harness.db, 'paymentOperations', started.operationId);
  // A pending receipt binds the first provider id without applying money.
  const pending = appliedResult(await settleCheckout(harness.db, operation, 'pending'));
  assert.equal(pending.application, 'pending');
  assert.equal(operation['providerId'], SUCCESS_ID);
  // A successful receipt under a different id is conflicting evidence.
  const conflict = appliedResult(
    await settleCheckout(harness.db, operation, 'successful', {
      ...matchingReceipt(operation, 'successful'),
      id: OTHER_ID,
    }),
  );
  assert.equal(conflict.application, 'review');
  assert.equal(operation['providerId'], SUCCESS_ID);
  assert.equal(operation['accounting'], undefined);
  for (const orderId of operation['orderIds'] as string[]) {
    assert.equal(findRow(harness.db, 'orders', orderId)['status'], 'pending_payment');
  }
});

test('collection receipts without a Zambian country never enter the writer', async () => {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const started = okResult(await initiate(harness, 'clerk_buyer', checkoutArgs('req-no-country', quote.quoteKey)));
  const operation = findRow(harness.db, 'paymentOperations', started.operationId);
  const before = snapshot(harness.db);
  await assert.rejects(
    () =>
      invokeFakeFunction(providerSettlement.settleProviderReceipt, createCtx(harness.db, null), {
        operationId: operation._id,
        receipt: { ...matchingReceipt(operation, 'successful'), country: null },
        acquisition: { kind: 'initiation_post', operationId: operation._id },
      }),
    /Argument validation failed/,
  );
  assert.deepEqual(snapshot(harness.db), before);
});

// ---- Legacy and conflicting evidence holds everything ----

type StartedCheckout = { harness: Harness; operation: Row; quote: CheckoutQuote };

async function startLampCheckout(requestId: string, extra: Record<string, unknown> = {}): Promise<StartedCheckout> {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const started = okResult(await initiate(harness, 'clerk_buyer', checkoutArgs(requestId, quote.quoteKey, extra)));
  return { harness, operation: findRow(harness.db, 'paymentOperations', started.operationId), quote };
}

function moneyTables(db: Db): Record<string, unknown> {
  return structuredClone({
    products: db.tables['products'],
    orders: db.tables['orders'],
    escrow: db.tables['escrow'],
    transactions: db.tables['transactions'],
    walletTransactions: db.tables['walletTransactions'],
    promo: db.tables['promoCodeRedemptions'],
    loyalty: db.tables['loyaltyTransactions'],
    loyaltyAccounts: db.tables['loyaltyAccounts'],
  });
}

async function expectSettlementReview(db: Db, operation: Row, status: 'successful' | 'failed'): Promise<Row> {
  const before = moneyTables(db);
  const result = appliedResult(await settleCheckout(db, operation, status));
  assert.equal(result.application, 'review');
  assert.equal(result.status, 'unknown');
  assert.equal(operation['reviewNeeded'], true);
  assert.equal(operation['accounting'], undefined);
  assert.deepEqual(moneyTables(db), before);
  return operation;
}

test('legacy provider, companion, ledger, and metadata conflicts hold funds and reservations', async () => {
  const plant = [
    [
      'competing operation',
      (db: Db, operation: Row) => {
        tableRows(db, 'paymentOperations').push({
          _id: 'paymentOperations|legacy',
          providerReference: operation['providerReference'],
        });
      },
    ],
    [
      'legacy lenco companion',
      (db: Db, operation: Row) => {
        void operation;
        tableRows(db, 'transactions').push({ _id: 'transactions|legacy-lenco', lencoCollectionId: SUCCESS_ID });
      },
    ],
    [
      'legacy reference companion',
      (db: Db, operation: Row) => {
        tableRows(db, 'transactions').push({
          _id: 'transactions|legacy-ref',
          reference: operation['providerReference'],
        });
      },
    ],
    [
      'legacy order-linked transaction',
      (db: Db, operation: Row) => {
        tableRows(db, 'transactions').push({
          _id: 'transactions|legacy-order',
          orderId: (operation['orderIds'] as string[])[0],
        });
      },
    ],
    [
      'legacy order-linked ledger',
      (db: Db, operation: Row) => {
        tableRows(db, 'walletTransactions').push({
          _id: 'walletTransactions|legacy-order',
          orderId: (operation['orderIds'] as string[])[0],
        });
      },
    ],
    [
      'owned metadata naming the order',
      (db: Db, operation: Row) => {
        tableRows(db, 'transactions').push({
          _id: 'transactions|legacy-meta',
          userId: operation['ownerId'],
          operationId: 'paymentOperations|other',
          metadata: `legacy checkout for ${(operation['orderIds'] as string[])[0]}`,
        });
      },
    ],
    [
      'conflicting ledger naming the reference',
      (db: Db, operation: Row) => {
        tableRows(db, 'walletTransactions').push({
          _id: 'walletTransactions|legacy-ref',
          reference: operation['providerReference'],
        });
      },
    ],
    [
      'conflicting ledger naming the provider id',
      (db: Db) => {
        tableRows(db, 'walletTransactions').push({
          _id: 'walletTransactions|legacy-ext',
          externalReference: SUCCESS_ID,
        });
      },
    ],
  ] as Array<[string, (db: Db, operation: Row) => void]>;
  let index = 0;
  for (const [name, seed] of plant) {
    const { harness, operation } = await startLampCheckout(`req-legacy-${index}`);
    index += 1;
    seed(harness.db, operation);
    await expectSettlementReview(harness.db, operation, 'successful');
    // A later matching receipt cannot silently clear the earlier conflict.
    const later = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
    assert.equal(later.application, 'review', name);
    assert.equal(operation['accounting'], undefined, name);
  }
});

test('missing or bare-terminal links hold with no capture or release', async () => {
  const mutate = [
    [
      'missing order',
      (db: Db, operation: Row) => {
        db.tables['orders'] = tableRows(db, 'orders').filter(
          (row) => row._id !== (operation['orderIds'] as string[])[0],
        );
      },
    ],
    [
      'missing companion',
      (db: Db, operation: Row) => {
        db.tables['transactions'] = tableRows(db, 'transactions').filter(
          (row) => row._id !== operation['transactionId'],
        );
      },
    ],
    [
      'missing companion link',
      (db: Db, operation: Row) => {
        delete operation['transactionId'];
      },
    ],
    [
      'bare successful companion',
      (db: Db, operation: Row) => {
        findRow(db, 'transactions', String(operation['transactionId']))['status'] = 'successful';
      },
    ],
    [
      'companion with provider ids set',
      (db: Db, operation: Row) => {
        const companion = findRow(db, 'transactions', String(operation['transactionId']));
        companion['lencoCollectionId'] = SUCCESS_ID;
        companion['lencoTransactionId'] = SUCCESS_ID;
      },
    ],
    [
      'bare paid order',
      (db: Db, operation: Row) => {
        findRow(db, 'orders', firstOrderId(operation))['status'] = 'paid';
      },
    ],
    [
      'order operation link mismatch',
      (db: Db, operation: Row) => {
        findRow(db, 'orders', firstOrderId(operation))['operationId'] = 'paymentOperations|other';
      },
    ],
    [
      'pre-existing escrow',
      (db: Db, operation: Row) => {
        tableRows(db, 'escrow').push({
          _id: 'escrow|legacy',
          orderId: (operation['orderIds'] as string[])[0],
          operationId: 'paymentOperations|other',
          status: 'held',
        });
      },
    ],
  ] as Array<[string, (db: Db, operation: Row) => void]>;
  let index = 0;
  for (const [name, edit] of mutate) {
    const { harness, operation } = await startLampCheckout(`req-link-${index}`);
    index += 1;
    edit(harness.db, operation);
    await expectSettlementReview(harness.db, operation, 'successful');
    // The trusted failure path holds too: no release without the full set.
    const failed = appliedResult(await settleCheckout(harness.db, operation, 'failed'));
    assert.equal(failed.application, 'review', name);
    assert.equal(operation['accounting'], undefined, name);
  }
});

async function startPromoLoyaltyCheckout(
  requestId: string,
): Promise<{ harness: Harness; operation: Row; quote: CheckoutQuote }> {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  seedCartLine(harness.db, 'products|cap', 2);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
    promoCode: 'SAVE10',
    loyaltyPoints: 20,
  });
  assert.ok(quote.promo && quote.loyalty);
  const started = okResult(
    await initiate(
      harness,
      'clerk_buyer',
      checkoutArgs(requestId, quote.quoteKey, {
        promoCode: 'SAVE10',
        loyaltyPoints: 20,
      }),
    ),
  );
  return { harness, operation: findRow(harness.db, 'paymentOperations', started.operationId), quote };
}

test('duplicate promo and loyalty links hold with no capture', async () => {
  // Each duplicate plant runs on its own fresh operation: a sticky review
  // from an earlier plant must never stand in for the cardinality preflight.
  {
    const { harness, operation } = await startPromoLoyaltyCheckout('req-dupe-promo-fresh');
    tableRows(harness.db, 'promoCodeRedemptions').push({
      _id: 'promoCodeRedemptions|dupe',
      operationId: operation._id,
      userId: operation['ownerId'],
    });
    await expectSettlementReview(harness.db, operation, 'successful');
  }
  {
    const { harness, operation } = await startPromoLoyaltyCheckout('req-dupe-loyalty-fresh');
    tableRows(harness.db, 'loyaltyAccounts').push({
      _id: 'loyaltyAccounts|dupe',
      userId: 'users|buyer',
      pointsBalance: 5,
      lifetimeEarned: 5,
      lifetimeRedeemed: 0,
    });
    await expectSettlementReview(harness.db, operation, 'successful');
  }
});

// ---- Pending and GET settlement retain everything without proof ----

test('unknown and pending receipts never move money, stock, promos, points, or carts', async () => {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  seedCartLine(harness.db, 'products|cap', 2);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
    promoCode: 'SAVE10',
    loyaltyPoints: 20,
  });
  const lampBefore = numberOf(findRow(harness.db, 'products', 'products|lamp'), 'quantity');
  const started = okResult(
    await initiate(
      harness,
      'clerk_buyer',
      checkoutArgs('req-pending-keeps', quote.quoteKey, { promoCode: 'SAVE10', loyaltyPoints: 20 }),
    ),
  );
  const operation = findRow(harness.db, 'paymentOperations', started.operationId);
  const before = moneyTables(harness.db);
  const cartsBefore = structuredClone(harness.db.tables['cartItems']);
  const pending = appliedResult(await settleCheckout(harness.db, operation, 'pending'));
  assert.equal(pending.application, 'pending');
  assert.equal(operation['accounting'], undefined);
  assert.deepEqual(moneyTables(harness.db), before);
  assert.deepEqual(harness.db.tables['cartItems'], cartsBefore);
  assert.equal(numberOf(findRow(harness.db, 'products', 'products|lamp'), 'quantity'), lampBefore - 1);
  for (const orderId of operation['orderIds'] as string[]) {
    assert.equal(findRow(harness.db, 'orders', orderId)['status'], 'pending_payment');
  }
  assert.equal(findRow(harness.db, 'transactions', String(operation['transactionId']))['status'], 'pending');
  // A stale pending replay after the terminal capture applies nothing twice.
  const captured = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(captured.application, 'applied');
  const escrows = tableRows(harness.db, 'escrow').length;
  const notices = tableRows(harness.db, 'notifications').length;
  const stale = appliedResult(await settleCheckout(harness.db, operation, 'pending'));
  assert.equal(stale.application, 'applied');
  assert.equal(tableRows(harness.db, 'escrow').length, escrows);
  assert.equal(tableRows(harness.db, 'notifications').length, notices);
});

test('a status_get success wins the race and binds the initiation_post replay', async () => {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const started = okResult(await initiate(harness, 'clerk_buyer', checkoutArgs('req-get-wins', quote.quoteKey)));
  const operation = findRow(harness.db, 'paymentOperations', started.operationId);
  const won = appliedResult(await settleCheckoutGet(harness.db, operation, 'successful'));
  assert.equal(won.application, 'applied');
  const settled = findRow(harness.db, 'paymentOperations', started.operationId);
  assert.equal(settled['status'], 'succeeded');
  assert.equal((settled['accounting'] as { kind: string }).kind, 'checkout_captured');
  // The late initiation_post with the same terminal facts is a proven replay.
  const replay = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(replay.application, 'applied');
  assert.equal(tableRows(harness.db, 'escrow').length, 1);
});

// ---- Safe owned recovery and positively qualified retry ----

async function getMineState(db: Db, clerkId: string, operationId: string): Promise<string> {
  try {
    const result = (await invokeFakeFunction(providerOperations.getMine, createCtx(db, clerkId), {
      operationId,
    })) as { application?: string; status?: string } | null;
    return `ok:${String(result?.application)}:${String(result?.status)}`;
  } catch (error) {
    if (error instanceof Error && 'data' in error) {
      const data = (error as { data: { code?: unknown } }).data;
      if (typeof data.code === 'string') {
        return data.code;
      }
    }
    throw error;
  }
}

test('the same request replays proven success with no new POST', async () => {
  const harness = open({ status: 'successful' });
  seedCartLine(harness.db, 'products|lamp', 1);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const args = checkoutArgs('req-reuse-ok', quote.quoteKey);
  const first = okResult(await initiate(harness, 'clerk_buyer', args));
  assert.equal(first.status, 'succeeded');
  assert.equal(harness.calls.length, 1);
  const second = okResult(await initiate(harness, 'clerk_buyer', args));
  assert.equal(second.operationId, first.operationId);
  assert.equal(second.status, 'succeeded');
  assert.equal(harness.calls.length, 1);
  assert.equal(tableRows(harness.db, 'escrow').length, 1);
});

test('the same request after a held review rejects with no new POST', async () => {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const args = checkoutArgs('req-reuse-held', quote.quoteKey);
  const first = okResult(await initiate(harness, 'clerk_buyer', args));
  const operation = findRow(harness.db, 'paymentOperations', first.operationId);
  const held = appliedResult(
    await settleCheckout(harness.db, operation, 'successful', {
      ...matchingReceipt(operation, 'successful'),
      amountMinor: 1,
    }),
  );
  assert.equal(held.application, 'review');
  assert.equal(harness.calls.length, 1);
  assert.equal(await checkoutFailureCode(harness, args), 'review_needed');
  assert.equal(harness.calls.length, 1);
  assert.equal(operation['accounting'], undefined);
});

test('the same request after a claim-then-pending heals to unknown with no new POST', async () => {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const args = checkoutArgs('req-reuse-pending', quote.quoteKey);
  const first = okResult(await initiate(harness, 'clerk_buyer', args));
  const operation = findRow(harness.db, 'paymentOperations', first.operationId);
  assert.equal(operation['status'], 'unknown');
  const second = okResult(await initiate(harness, 'clerk_buyer', args));
  assert.equal(second.operationId, first.operationId);
  assert.equal(second.status, 'unknown');
  assert.equal(harness.calls.length, 1);
  assert.equal(operation['accounting'], undefined);
  for (const orderId of operation['orderIds'] as string[]) {
    assert.equal(findRow(harness.db, 'orders', orderId)['status'], 'pending_payment');
  }
});

test('owned projections qualify proof: applied, pending, or review', async () => {
  const proved = await startLampCheckout('req-mine-ok');
  const captured = appliedResult(await settleCheckout(proved.harness.db, proved.operation, 'successful'));
  assert.equal(captured.application, 'applied');
  assert.equal(
    await getMineState(proved.harness.db, 'clerk_buyer', String(proved.operation._id)),
    'ok:applied:succeeded',
  );

  const pendingHarness = await startLampCheckout('req-mine-pending');
  const pending = appliedResult(await settleCheckout(pendingHarness.harness.db, pendingHarness.operation, 'pending'));
  assert.equal(pending.application, 'pending');
  assert.equal(
    await getMineState(pendingHarness.harness.db, 'clerk_buyer', String(pendingHarness.operation._id)),
    'ok:pending:unknown',
  );

  const heldHarness = await startLampCheckout('req-mine-held');
  const held = appliedResult(
    await settleCheckout(heldHarness.harness.db, heldHarness.operation, 'successful', {
      ...matchingReceipt(heldHarness.operation, 'successful'),
      phone: '0970000000',
    }),
  );
  assert.equal(held.application, 'review');
  assert.equal(
    await getMineState(heldHarness.harness.db, 'clerk_buyer', String(heldHarness.operation._id)),
    'review_needed',
  );
});

// ---- Cart cleanup deletes only byte-identical captured rows ----

test('changed cart rows survive capture and fund a positively qualified retry', async () => {
  const harness = open();
  const rowId = seedCartLine(harness.db, 'products|lamp', 1);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const first = okResult(await initiate(harness, 'clerk_buyer', checkoutArgs('req-cart-changed', quote.quoteKey)));
  const operation = findRow(harness.db, 'paymentOperations', first.operationId);
  // The shopper edits the line after the reservation: the snapshot no longer matches.
  findRow(harness.db, 'cartItems', rowId)['quantity'] = 5;
  const captured = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(captured.application, 'applied');
  const survivors = tableRows(harness.db, 'cartItems');
  assert.equal(survivors.length, 1);
  assert.equal(survivors[0]?.['_id'], rowId);
  assert.equal(survivors[0]?.['quantity'], 5);
  // The edited line funds a fresh checkout: the consumed coverage no longer blocks it.
  const retry = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const second = okResult(await initiate(harness, 'clerk_buyer', checkoutArgs('req-cart-retry', retry.quoteKey)));
  assert.notEqual(second.operationId, first.operationId);
  assert.equal(harness.calls.length, 2);
});

test("another shopper's cart rows survive a capture", async () => {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  tableRows(harness.db, 'cartItems').push({
    _id: 'cartItems|foreign',
    userId: 'users|other',
    productId: 'products|lamp',
    quantity: 1,
    selectedShipping: { name: 'Courier', price: 50 },
    createdAt: 1,
    updatedAt: 1,
  });
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const started = okResult(await initiate(harness, 'clerk_buyer', checkoutArgs('req-cart-foreign', quote.quoteKey)));
  const operation = findRow(harness.db, 'paymentOperations', started.operationId);
  const captured = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(captured.application, 'applied');
  const survivors = tableRows(harness.db, 'cartItems');
  assert.equal(survivors.length, 1);
  assert.equal(survivors[0]?.['_id'], 'cartItems|foreign');
});

// ---- Beneficiary existence, tombstones, switches, and frozen wallets ----

test('an anonymized tombstone still receives its owed capture', async () => {
  const { harness, operation } = await startLampCheckout('req-tombstone');
  await invokeFakeFunction(usersModule.anonymizeDeletedUserByClerkId, createCtx(harness.db, null), {
    clerkId: 'clerk_buyer',
  });
  const tombstone = findRow(harness.db, 'users', 'users|buyer');
  assert.equal(tombstone['isDeleted'], true);
  const captured = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(captured.application, 'applied');
  for (const orderId of operation['orderIds'] as string[]) {
    assert.equal(findRow(harness.db, 'orders', orderId)['status'], 'paid');
  }
});

test('a missing owner row holds every fund and reservation', async () => {
  const { harness, operation } = await startLampCheckout('req-no-owner');
  harness.db.tables['users'] = tableRows(harness.db, 'users').filter((row) => row._id !== 'users|buyer');
  await expectSettlementReview(harness.db, operation, 'successful');
  await expectSettlementReview(harness.db, operation, 'failed');
});

test('hard deletion refuses a live checkout owner', async () => {
  const { harness } = await startLampCheckout('req-no-delete');
  await assert.rejects(
    () =>
      invokeFakeFunction(usersModule.deleteUser, createCtx(harness.db, null), {
        userId: 'users|buyer',
        clerkId: 'clerk_buyer',
      }),
    /unresolved checkout/,
  );
  assert.ok(findRow(harness.db, 'users', 'users|buyer'));
});

test('a disabled switch and frozen wallet never block an owed settlement', async () => {
  const { harness, operation } = await startLampCheckout('req-switch-off');
  findRow(harness.db, 'appConfig', 'appConfig|1')['paymentsEnabled'] = false;
  tableRows(harness.db, 'wallets').push({
    _id: 'wallets|users|buyer',
    userId: 'users|buyer',
    balance: 1000,
    pendingBalance: 0,
    totalEarned: 1000,
    totalWithdrawn: 0,
    totalSpent: 0,
    isActive: false,
    isFrozen: true,
    createdAt: 1,
    updatedAt: 1,
  });
  const captured = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(captured.application, 'applied');
  const wallet = findRow(harness.db, 'wallets', 'wallets|users|buyer');
  assert.equal(wallet['balance'], 1000);
  assert.equal(wallet['isFrozen'], true);
  assert.equal(tableRows(harness.db, 'walletTransactions').length, 0);
});

// ---- Lost responses heal through the same request with no second POST ----

for (const commit of [false, true]) {
  test(`lost checkout response ${commit ? 'after' : 'before'} commit: recovery never posts or settles again`, async () => {
    const harness = open({ status: 'successful' });
    seedCartLine(harness.db, 'products|lamp', 1);
    const quote = await freshQuote(harness.db, 'clerk_buyer', {
      source: 'cart',
      deliveryMethodId: 'deliveryMethods|m1',
      shippingAddress: ADDRESS,
    });
    const args = checkoutArgs('req-lost-checkout', quote.quoteKey);
    // Wrap only the unavoidable lost-response boundary; execute the actual
    // registered writer when commit=true, never fabricate effects.
    const real = providerSettlement.settleProviderReceipt;
    const lost = {
      ...real,
      _handler: async (ctx: unknown, inner: unknown) => {
        if (commit) {
          await handlerOf<unknown, unknown>(real)(ctx, inner);
        }
        throw new Error('lost response');
      },
    };
    harness.modules.providerSettlement = { settleProviderReceipt: lost };
    await assert.rejects(() => initiate(harness, 'clerk_buyer', args), /lost response/);
    const recovered = okResult(await initiate(harness, 'clerk_buyer', args));
    assert.equal(recovered.status, commit ? 'succeeded' : 'unknown');
    assert.equal(harness.calls.length, 1);
    const operation = findRow(harness.db, 'paymentOperations', recovered.operationId);
    if (commit) {
      assert.equal((operation['accounting'] as { kind: string }).kind, 'checkout_captured');
      assert.equal(tableRows(harness.db, 'escrow').length, 1);
      for (const orderId of operation['orderIds'] as string[]) {
        assert.equal(findRow(harness.db, 'orders', orderId)['status'], 'paid');
      }
    } else {
      assert.equal(operation['accounting'], undefined);
      assert.equal(tableRows(harness.db, 'escrow').length, 0);
      assert.equal(numberOf(findRow(harness.db, 'products', 'products|lamp'), 'quantity'), 9);
      for (const orderId of operation['orderIds'] as string[]) {
        assert.equal(findRow(harness.db, 'orders', orderId)['status'], 'pending_payment');
      }
      assert.equal(findRow(harness.db, 'transactions', String(operation['transactionId']))['status'], 'pending');
      assert.equal(tableRows(harness.db, 'cartItems').length, 1);
    }
  });
}

// ---- POST/GET orderings converge on one application ----

test('a successful status_get after a successful POST applies nothing twice', async () => {
  const { harness, operation } = await startLampCheckout('req-post-then-get');
  const posted = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(posted.application, 'applied');
  const before = moneyTables(harness.db);
  const notices = tableRows(harness.db, 'notifications').length;
  const escrows = tableRows(harness.db, 'escrow').length;
  const got = appliedResult(await settleCheckoutGet(harness.db, operation, 'successful'));
  assert.equal(got.application, 'applied');
  assert.deepEqual(moneyTables(harness.db), before);
  assert.equal(tableRows(harness.db, 'notifications').length, notices);
  assert.equal(tableRows(harness.db, 'escrow').length, escrows);
});

test('a failed status_get after an applied release releases nothing twice', async () => {
  const { harness, operation } = await startLampCheckout('req-fail-then-get');
  const lampAfterRelease = 10;
  const released = appliedResult(await settleCheckout(harness.db, operation, 'failed'));
  assert.equal(released.application, 'applied');
  assert.equal(numberOf(findRow(harness.db, 'products', 'products|lamp'), 'quantity'), lampAfterRelease);
  const replay = appliedResult(await settleCheckoutGet(harness.db, operation, 'failed'));
  assert.equal(replay.application, 'applied');
  assert.equal(numberOf(findRow(harness.db, 'products', 'products|lamp'), 'quantity'), lampAfterRelease);
  assert.equal(tableRows(harness.db, 'escrow').length, 0);
});

// ---- Cancellation refunds a captured checkout through the order writer ----

test('a captured checkout order cancels with a full buyer-wallet refund', async () => {
  const { harness, operation } = await startLampCheckout('req-cancel-refunded');
  const captured = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(captured.application, 'applied');
  const orderId = (operation['orderIds'] as string[])[0] as string;
  const escrow = tableRows(harness.db, 'escrow')[0];
  assert.ok(escrow);
  const gross = numberOf(escrow, 'grossAmount');
  const buyerWallet = tableRows(harness.db, 'wallets').find((row) => row['userId'] === 'users|buyer');
  const buyerBefore = buyerWallet ? numberOf(buyerWallet, 'balance') : 0;
  const companion = structuredClone(findRow(harness.db, 'transactions', String(operation['transactionId'])));
  assert.equal(companion['status'], 'successful');

  const cancelled = (await invokeFakeFunction(ordersModule.cancelOrder, createCtx(harness.db, 'clerk_buyer'), {
    orderId,
  })) as unknown as Row;
  assert.equal(cancelled['status'], 'cancelled');
  assert.equal(cancelled['accountingOutcome'], 'applied');
  assert.equal(findRow(harness.db, 'escrow', String(escrow['_id']))['status'], 'refunded');
  const after = tableRows(harness.db, 'wallets').find((row) => row['userId'] === 'users|buyer');
  assert.ok(after);
  assert.equal(numberOf(after, 'balance'), buyerBefore + gross);
  assert.equal(numberOf(findRow(harness.db, 'products', 'products|lamp'), 'quantity'), 10);
  // The captured provider companion is immutable refund-authority history,
  // never relabeled by one slice of the aggregate checkout.
  assert.deepEqual(findRow(harness.db, 'transactions', String(operation['transactionId'])), companion);
});

// ---- A zero slice settles inside a positive aggregate ----

test('a zero-total seller slice captures with a zero-gross escrow', async () => {
  const harness = open();
  tableRows(harness.db, 'products').push(
    productRow('products|freebie', 'users|seller2', { price: 0, quantity: 5, weightKg: 0.1 }),
  );
  seedCartLine(harness.db, 'products|freebie', 1);
  seedCartLine(harness.db, 'products|lamp', 1);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  assert.equal(quote.sellers.length, 2);
  const started = okResult(await initiate(harness, 'clerk_buyer', checkoutArgs('req-zero-slice', quote.quoteKey)));
  const operation = findRow(harness.db, 'paymentOperations', started.operationId);
  assert.equal(orderIdsOf(operation).length, 2);
  const captured = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(captured.application, 'applied');
  const freebieOrder = tableRows(harness.db, 'orders').find((row) => row['sellerId'] === 'users|seller2');
  assert.ok(freebieOrder);
  assert.equal(freebieOrder?.['status'], 'paid');
  const freebieEscrow = tableRows(harness.db, 'escrow').find((row) => row['orderId'] === freebieOrder?.['_id']);
  assert.ok(freebieEscrow);
  assert.equal(freebieEscrow?.['status'], 'held');
  assert.equal(freebieEscrow?.['grossAmount'], 0);
});

// ---- Discount variants: promo-only, loyalty-only, and intervening activity ----

test('promo-only and loyalty-only checkouts capture exactly their own links', async () => {
  for (const [name, extra] of [
    ['promo-only', { promoCode: 'SAVE10' }],
    ['loyalty-only', { loyaltyPoints: 20 }],
  ] as Array<[string, Record<string, unknown>]>) {
    const harness = open();
    seedCartLine(harness.db, 'products|lamp', 1);
    seedCartLine(harness.db, 'products|cap', 2);
    const quote = await freshQuote(harness.db, 'clerk_buyer', {
      source: 'cart',
      deliveryMethodId: 'deliveryMethods|m1',
      shippingAddress: ADDRESS,
      ...extra,
    });
    const started = okResult(
      await initiate(harness, 'clerk_buyer', checkoutArgs(`req-${name}`, quote.quoteKey, extra)),
    );
    const operation = findRow(harness.db, 'paymentOperations', started.operationId);
    const captured = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
    assert.equal(captured.application, 'applied', name);
    if (name === 'promo-only') {
      assert.equal(
        findRow(harness.db, 'promoCodeRedemptions', String(operation['promoRedemptionId']))['status'],
        'captured',
        name,
      );
      assert.equal(operation['loyaltyTransactionId'], undefined, name);
      assert.equal(tableRows(harness.db, 'loyaltyTransactions').length, 0, name);
    } else {
      assert.equal(
        findRow(harness.db, 'loyaltyTransactions', String(operation['loyaltyTransactionId']))['status'],
        'captured',
        name,
      );
      assert.equal(operation['promoRedemptionId'], undefined, name);
      assert.equal(tableRows(harness.db, 'promoCodeRedemptions').length, 0, name);
      assert.equal(
        numberOf(findRow(harness.db, 'loyaltyAccounts', 'loyaltyAccounts|buyer'), 'lifetimeRedeemed'),
        20,
        name,
      );
    }
  }
});

test('intervening loyalty earnings survive capture without a second debit', async () => {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  seedCartLine(harness.db, 'products|cap', 2);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
    loyaltyPoints: 20,
  });
  assert.ok(quote.loyalty);
  const started = okResult(
    await initiate(harness, 'clerk_buyer', checkoutArgs('req-loyalty-earn', quote.quoteKey, { loyaltyPoints: 20 })),
  );
  const operation = findRow(harness.db, 'paymentOperations', started.operationId);
  assert.equal(numberOf(findRow(harness.db, 'loyaltyAccounts', 'loyaltyAccounts|buyer'), 'pointsBalance'), 80);
  // The shopper earns 50 points elsewhere while the collection is in flight.
  const account = findRow(harness.db, 'loyaltyAccounts', 'loyaltyAccounts|buyer');
  account['pointsBalance'] = 130;
  account['lifetimeEarned'] = 150;
  const captured = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(captured.application, 'applied');
  assert.equal(numberOf(findRow(harness.db, 'loyaltyAccounts', 'loyaltyAccounts|buyer'), 'pointsBalance'), 130);
  assert.equal(numberOf(findRow(harness.db, 'loyaltyAccounts', 'loyaltyAccounts|buyer'), 'lifetimeRedeemed'), 20);
});

// ---- Release restores the last unit and reactivates a sold listing ----

test('a failed single-unit listing reactivates while dormant listings stay untouched', async () => {
  const harness = open();
  findRow(harness.db, 'products', 'products|lamp')['quantity'] = 1;
  tableRows(harness.db, 'products').push(
    productRow('products|dormant', 'users|seller', { status: 'inactive', quantity: 0 }),
  );
  seedCartLine(harness.db, 'products|lamp', 1);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const started = okResult(await initiate(harness, 'clerk_buyer', checkoutArgs('req-sold-back', quote.quoteKey)));
  const operation = findRow(harness.db, 'paymentOperations', started.operationId);
  assert.equal(findRow(harness.db, 'products', 'products|lamp')['status'], 'sold');
  const released = appliedResult(await settleCheckout(harness.db, operation, 'failed'));
  assert.equal(released.application, 'applied');
  const lamp = findRow(harness.db, 'products', 'products|lamp');
  assert.equal(lamp['quantity'], 1);
  assert.equal(lamp['status'], 'active');
  const dormant = findRow(harness.db, 'products', 'products|dormant');
  assert.equal(dormant['quantity'], 0);
  assert.equal(dormant['status'], 'inactive');
  for (const orderId of operation['orderIds'] as string[]) {
    assert.equal(findRow(harness.db, 'orders', orderId)['status'], 'cancelled');
  }
  assert.equal(tableRows(harness.db, 'cartItems').length, 1);
});

// ---- Capture notices describe mobile money, never a wallet debit ----

test('capture notices name mobile money for the buyer and every seller', async () => {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  seedCartLine(harness.db, 'products|cap', 2);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const started = okResult(await initiate(harness, 'clerk_buyer', checkoutArgs('req-notices', quote.quoteKey)));
  const operation = findRow(harness.db, 'paymentOperations', started.operationId);
  const captured = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(captured.application, 'applied');
  const notices = tableRows(harness.db, 'notifications');
  assert.equal(notices.length, 4);
  for (const notice of notices) {
    assert.match(String(notice['message']), /mobile[- ]money/i);
    assert.doesNotMatch(String(notice['message']), /wallet/i);
  }
  assert.equal(tableRows(harness.db, 'walletTransactions').length, 0);
});

// ---- Task4B fix r1: review-held coverage, inventory, ledger, escrow, durable proof ----

test('fixr1 review-held capture keeps the cart locked in both consumers', async () => {
  for (const consumer of ['collection', 'wallet'] as const) {
    const started = await startLampCheckout(`req-fixr1-held-${consumer}`);
    const harness = started.harness;
    const operation = started.operation;
    if (consumer === 'wallet') {
      seedWallet(harness.db);
    }
    // A genuine post-claim edit retains the changed row after capture.
    const cartRow = tableRows(harness.db, 'cartItems')[0];
    assert.ok(cartRow);
    cartRow['quantity'] = 2;
    const captured = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
    assert.equal(captured.application, 'applied');
    // The same valid receipt arriving over a conflicting lookup is held.
    const held = appliedResult(await settleForeignStatusGet(harness.db, operation));
    assert.equal(held.application, 'review');
    assert.equal(operation['reviewNeeded'], true);
    // The held checkout must not fund a new attempt in either consumer.
    const before = snapshot(harness.db);
    const operationsBefore = tableRows(harness.db, 'paymentOperations').length;
    const callsBefore = harness.calls.length;
    const retryQuote = await freshQuote(harness.db, 'clerk_buyer', {
      source: 'cart',
      deliveryMethodId: 'deliveryMethods|m1',
      shippingAddress: ADDRESS,
    });
    if (consumer === 'collection') {
      assert.equal(
        await checkoutFailureCode(harness, checkoutArgs(`req-fixr1-retry-${consumer}`, retryQuote.quoteKey)),
        'order_overlap',
      );
    } else {
      assert.equal(
        await walletFailureCode(harness.db, 'clerk_buyer', {
          requestId: `req-fixr1-retry-${consumer}`,
          source: 'cart',
          deliveryMethodId: 'deliveryMethods|m1',
          shippingAddress: ADDRESS,
          expectedQuoteKey: retryQuote.quoteKey,
        }),
        'order_overlap',
      );
    }
    assert.deepEqual(snapshot(harness.db), before);
    assert.equal(tableRows(harness.db, 'paymentOperations').length, operationsBefore);
    assert.equal(harness.calls.length, callsBefore);
  }
});

test('fixr1 a duplicated current variant holds the whole failure with no partial writes', async () => {
  const harness = open();
  seedShirt(harness.db);
  seedShirtLine(harness.db, 2);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const started = okResult(await initiate(harness, 'clerk_buyer', checkoutArgs('req-fixr1-dupevar', quote.quoteKey)));
  const operation = findRow(harness.db, 'paymentOperations', started.operationId);
  // The catalog now names the purchased variant twice: ambiguous evidence.
  const product = findRow(harness.db, 'products', 'products|shirt');
  const combos = product['variantCombinations'] as Array<Record<string, unknown>>;
  combos.push({ ...(combos[0] as Record<string, unknown>) });
  const before = moneyTables(harness.db);
  const result = appliedResult(await settleCheckout(harness.db, operation, 'failed'));
  assert.equal(result.application, 'review');
  assert.equal(result.status, 'unknown');
  assert.equal(operation['reviewNeeded'], true);
  assert.equal(operation['accounting'], undefined);
  assert.deepEqual(moneyTables(harness.db), before);
  for (const orderId of orderIdsOf(operation)) {
    assert.equal(findRow(harness.db, 'orders', orderId)['status'], 'pending_payment');
  }
});

test('fixr1 a foreign product owner holds the whole failure with no partial writes', async () => {
  const harness = open();
  seedShirt(harness.db);
  seedShirtLine(harness.db, 2);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const started = okResult(await initiate(harness, 'clerk_buyer', checkoutArgs('req-fixr1-foreign', quote.quoteKey)));
  const operation = findRow(harness.db, 'paymentOperations', started.operationId);
  // The current listing belongs to an unrelated seller now.
  findRow(harness.db, 'products', 'products|shirt')['sellerId'] = 'users|seller2';
  const before = moneyTables(harness.db);
  const result = appliedResult(await settleCheckout(harness.db, operation, 'failed'));
  assert.equal(result.application, 'review');
  assert.equal(result.status, 'unknown');
  assert.equal(operation['reviewNeeded'], true);
  assert.equal(operation['accounting'], undefined);
  assert.deepEqual(moneyTables(harness.db), before);
  for (const orderId of orderIdsOf(operation)) {
    assert.equal(findRow(harness.db, 'orders', orderId)['status'], 'pending_payment');
  }
});

test('fixr1 a novel same-operation wallet ledger holds capture with no escrow', async () => {
  const started = await startLampCheckout('req-fixr1-ledger');
  const harness = started.harness;
  const operation = started.operation;
  seedWallet(harness.db);
  // Task4B never writes a wallet ledger for a checkout: any same-operation
  // row is conflicting financial evidence regardless of its reference alias.
  tableRows(harness.db, 'walletTransactions').push({
    _id: 'walletTransactions|novel-op',
    walletId: 'wallets|users|buyer',
    userId: 'users|buyer',
    operationId: operation._id,
    type: 'credit',
    source: 'top_up_mobile_money',
    amount: 100,
    balanceAfter: 1000,
    reference: 'WLT-novel-unrelated',
    status: 'completed',
    createdAt: 1,
    completedAt: 1,
    updatedAt: 1,
  });
  const before = moneyTables(harness.db);
  const result = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(result.application, 'review');
  assert.equal(result.status, 'unknown');
  assert.equal(operation['reviewNeeded'], true);
  assert.equal(operation['accounting'], undefined);
  assert.deepEqual(moneyTables(harness.db), before);
  assert.equal(tableRows(harness.db, 'escrow').length, 0);
});

test('fixr1 a duplicated escrow identity fails positive proof and owned projection', async () => {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  seedCartLine(harness.db, 'products|cap', 1);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const started = okResult(await initiate(harness, 'clerk_buyer', checkoutArgs('req-fixr1-escrow', quote.quoteKey)));
  const operation = findRow(harness.db, 'paymentOperations', started.operationId);
  const captured = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(captured.application, 'applied');
  const orderIds = orderIdsOf(operation);
  assert.equal(orderIds.length, 2);
  // Copy the first escrow onto the second, keeping the second row id: both
  // rows now fund the first order while the second order holds no escrow.
  const rows = tableRows(harness.db, 'escrow');
  assert.equal(rows.length, 2);
  const first = rows[0];
  const second = rows[1];
  assert.ok(first && second);
  const secondId = second['_id'];
  Object.assign(second, { ...first, _id: secondId });
  assert.deepEqual(
    tableRows(harness.db, 'escrow').map((row) => row['orderId']),
    [orderIds[0], orderIds[0]],
  );
  const replay = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(replay.application, 'review');
  assert.equal(await getMineState(harness.db, 'clerk_buyer', String(operation._id)), 'review_needed');
});

test('fixr1 real Clerk erasure preserves completed funding and replay proof', async () => {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  const extra = { promoCode: 'SAVE10', loyaltyPoints: 50 };
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
    ...extra,
  });
  const started = okResult(
    await initiate(harness, 'clerk_buyer', checkoutArgs('req-fixr1-erasure', quote.quoteKey, extra)),
  );
  const operation = findRow(harness.db, 'paymentOperations', started.operationId);
  const captured = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(captured.application, 'applied');
  assert.equal(await getMineState(harness.db, 'clerk_buyer', String(operation._id)), 'ok:applied:succeeded');
  // The real Clerk deletion flow erases captured loyalty history and the account.
  await invokeFakeFunction(usersModule.anonymizeDeletedUserByClerkId, createCtx(harness.db, null), {
    clerkId: 'clerk_buyer',
  });
  assert.equal(findRow(harness.db, 'users', 'users|buyer')['isDeleted'], true);
  assert.equal(tableRows(harness.db, 'loyaltyTransactions').length, 0);
  assert.equal(tableRows(harness.db, 'loyaltyAccounts').length, 0);
  assert.equal(tableRows(harness.db, 'escrow').length, 1);
  // The already-funded obligation still replays as applied: same receipt,
  // same frozen quote, same companion, same one-to-one order escrow.
  const replay = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(replay.application, 'applied');
  assert.equal(tableRows(harness.db, 'escrow').length, 1);
  const redemption = tableRows(harness.db, 'promoCodeRedemptions')[0];
  assert.ok(redemption);
  assert.equal(redemption['status'], 'captured');
});

test('fixr1 anonymize before a pending capture still settles the owed funds', async () => {
  const { harness, operation } = await startPromoLoyaltyCheckout('req-fixr1-predel');
  await invokeFakeFunction(usersModule.anonymizeDeletedUserByClerkId, createCtx(harness.db, null), {
    clerkId: 'clerk_buyer',
  });
  assert.equal(findRow(harness.db, 'users', 'users|buyer')['isDeleted'], true);
  // Reserved rows for the still-unresolved operation are retained for owed
  // settlement; no new account is created.
  assert.equal(tableRows(harness.db, 'loyaltyTransactions').length, 1);
  const captured = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(captured.application, 'applied');
  for (const orderId of orderIdsOf(operation)) {
    assert.equal(findRow(harness.db, 'orders', orderId)['status'], 'paid');
  }
});

test('fixr1 duplicate Clerk events preserve history without repeat effects', async () => {
  const { harness, operation } = await startPromoLoyaltyCheckout('req-fixr1-dupevent');
  const captured = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(captured.application, 'applied');
  const noticesBefore = tableRows(harness.db, 'notifications').length;
  await invokeFakeFunction(usersModule.anonymizeDeletedUserByClerkId, createCtx(harness.db, null), {
    clerkId: 'clerk_buyer',
  });
  await invokeFakeFunction(usersModule.anonymizeDeletedUserByClerkId, createCtx(harness.db, null), {
    clerkId: 'clerk_buyer',
  });
  const replay = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(replay.application, 'applied');
  assert.equal(tableRows(harness.db, 'escrow').length, 2);
  // The replay repeats no money, stock, promo, points, or notice effects.
  // (Buyer notices are legitimately removed by the erasure itself, so the
  // count must not grow rather than stay byte-identical.)
  assert.ok(tableRows(harness.db, 'notifications').length <= noticesBefore);
  assert.equal(tableRows(harness.db, 'loyaltyTransactions').length, 0);
  const redemptions = tableRows(harness.db, 'promoCodeRedemptions');
  assert.equal(redemptions.length, 1);
  assert.equal(redemptions[0]?.['status'], 'captured');
});

test('fixr1 a tampered durable effect snapshot holds consumed proof', async () => {
  const { harness, operation } = await startPromoLoyaltyCheckout('req-fixr1-tamper');
  const captured = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(captured.application, 'applied');
  const proof = operation['completedDiscountProof'] as Record<string, unknown> | undefined;
  assert.ok(proof, 'capture must record the durable discount-effect proof');
  const loyalty = proof['loyalty'] as Record<string, unknown> | undefined;
  assert.ok(loyalty);
  loyalty['points'] = 999;
  const replay = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(replay.application, 'review');
  assert.equal(await getMineState(harness.db, 'clerk_buyer', String(operation._id)), 'review_needed');
});

test('fixr1 erased claim pointers hold consumed proof for reconciliation', async () => {
  const { harness, operation } = await startPromoLoyaltyCheckout('req-fixr1-pointers');
  const captured = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(captured.application, 'applied');
  // Erasing the claimed link must not silently skip the frozen discount.
  delete operation['promoRedemptionId'];
  const replay = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(replay.application, 'review');
  assert.equal(await getMineState(harness.db, 'clerk_buyer', String(operation._id)), 'review_needed');
});

test('fixr1 missing discount rows for an active owner hold consumed proof', async () => {
  const { harness, operation } = await startPromoLoyaltyCheckout('req-fixr1-activeowner');
  const captured = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(captured.application, 'applied');
  assert.equal(findRow(harness.db, 'users', 'users|buyer')['isDeleted'] ?? false, false);
  harness.db.tables['loyaltyTransactions'] = [];
  harness.db.tables['loyaltyAccounts'] = [];
  const replay = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(replay.application, 'review');
  assert.equal(await getMineState(harness.db, 'clerk_buyer', String(operation._id)), 'review_needed');
});

test('fixr1 a swapped loyalty first order holds novel settlement', async () => {
  const { harness, operation } = await startPromoLoyaltyCheckout('req-fixr1-swaps1');
  const orderIds = [...orderIdsOf(operation)].sort();
  assert.equal(orderIds.length, 2);
  // The reservation must name the sorted first operation order.
  const reservation = findRow(harness.db, 'loyaltyTransactions', String(operation['loyaltyTransactionId']));
  assert.equal(reservation['orderId'], orderIds[0]);
  reservation['orderId'] = orderIds[1];
  const before = moneyTables(harness.db);
  const result = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(result.application, 'review');
  assert.equal(operation['reviewNeeded'], true);
  assert.equal(operation['accounting'], undefined);
  assert.deepEqual(moneyTables(harness.db), before);
});

test('fixr1 a missing loyalty first order holds novel settlement', async () => {
  const { harness, operation } = await startPromoLoyaltyCheckout('req-fixr1-missings1');
  delete findRow(harness.db, 'loyaltyTransactions', String(operation['loyaltyTransactionId']))['orderId'];
  const before = moneyTables(harness.db);
  const result = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(result.application, 'review');
  assert.equal(operation['accounting'], undefined);
  assert.deepEqual(moneyTables(harness.db), before);
});

test('fixr1 swapped discount first orders fail consumed proof', async () => {
  const { harness, operation } = await startPromoLoyaltyCheckout('req-fixr1-swapproof');
  const captured = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(captured.application, 'applied');
  const orderIds = [...orderIdsOf(operation)].sort();
  findRow(harness.db, 'loyaltyTransactions', String(operation['loyaltyTransactionId']))['orderId'] = orderIds[1];
  const loyaltyReplay = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(loyaltyReplay.application, 'review');
  findRow(harness.db, 'loyaltyTransactions', String(operation['loyaltyTransactionId']))['orderId'] = orderIds[0];
  findRow(harness.db, 'promoCodeRedemptions', String(operation['promoRedemptionId']))['orderId'] = orderIds[1];
  const promoReplay = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(promoReplay.application, 'review');
  assert.equal(await getMineState(harness.db, 'clerk_buyer', String(operation._id)), 'review_needed');
});

test('fixr1 a nonvariant failure preserves the absent optional variant field', async () => {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  assert.ok(!('variantCombinations' in findRow(harness.db, 'products', 'products|lamp')));
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const started = okResult(await initiate(harness, 'clerk_buyer', checkoutArgs('req-fixr1-nonvar', quote.quoteKey)));
  const released = appliedResult(
    await settleCheckout(harness.db, findRow(harness.db, 'paymentOperations', started.operationId), 'failed'),
  );
  assert.equal(released.application, 'applied');
  const restored = findRow(harness.db, 'products', 'products|lamp');
  assert.equal(numberOf(restored, 'quantity'), 10);
  assert.ok(!('variantCombinations' in restored), 'release must not invent the optional variant field');
});

test('fixr1 original order ids stay denied after capture in both consumers', async () => {
  const started = await startLampCheckout('req-fixr1-q1cap');
  const harness = started.harness;
  const operation = started.operation;
  const orderIds = orderIdsOf(operation);
  const captured = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(captured.application, 'applied');
  const before = snapshot(harness.db);
  const operationsBefore = tableRows(harness.db, 'paymentOperations').length;
  const callsBefore = harness.calls.length;
  assert.equal(
    await checkoutFailureCode(harness, pendingArgs('req-fixr1-q1cap-col', started.quote.quoteKey, orderIds)),
    'order_not_pending',
  );
  assert.equal(
    await walletFailureCode(harness.db, 'clerk_buyer', {
      requestId: 'req-fixr1-q1cap-wal',
      source: 'pending_orders',
      orderIds,
      deliveryMethodId: 'deliveryMethods|m1',
      shippingAddress: ADDRESS,
      expectedQuoteKey: started.quote.quoteKey,
    }),
    'order_not_pending',
  );
  assert.deepEqual(snapshot(harness.db), before);
  assert.equal(tableRows(harness.db, 'paymentOperations').length, operationsBefore);
  assert.equal(harness.calls.length, callsBefore);
});

test('fixr1 original order ids stay denied after release in both consumers', async () => {
  const started = await startLampCheckout('req-fixr1-q1rel');
  const harness = started.harness;
  const operation = started.operation;
  const orderIds = orderIdsOf(operation);
  const released = appliedResult(await settleCheckout(harness.db, operation, 'failed'));
  assert.equal(released.application, 'applied');
  const before = snapshot(harness.db);
  const operationsBefore = tableRows(harness.db, 'paymentOperations').length;
  const callsBefore = harness.calls.length;
  assert.equal(
    await checkoutFailureCode(harness, pendingArgs('req-fixr1-q1rel-col', started.quote.quoteKey, orderIds)),
    'order_not_pending',
  );
  assert.equal(
    await walletFailureCode(harness.db, 'clerk_buyer', {
      requestId: 'req-fixr1-q1rel-wal',
      source: 'pending_orders',
      orderIds,
      deliveryMethodId: 'deliveryMethods|m1',
      shippingAddress: ADDRESS,
      expectedQuoteKey: started.quote.quoteKey,
    }),
    'order_not_pending',
  );
  assert.deepEqual(snapshot(harness.db), before);
  assert.equal(tableRows(harness.db, 'paymentOperations').length, operationsBefore);
  assert.equal(harness.calls.length, callsBefore);
});

test('fixr1 held proof keeps original order ids denied in both consumers', async () => {
  const started = await startLampCheckout('req-fixr1-q1held');
  const harness = started.harness;
  const operation = started.operation;
  seedWallet(harness.db);
  const orderIds = orderIdsOf(operation);
  const held = appliedResult(
    await settleCheckout(harness.db, operation, 'successful', {
      ...matchingReceipt(operation, 'successful'),
      amountMinor: 1,
    }),
  );
  assert.equal(held.application, 'review');
  for (const orderId of orderIds) {
    assert.equal(findRow(harness.db, 'orders', orderId)['status'], 'pending_payment');
  }
  const pendingQuote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'pending_orders',
    orderIds,
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const before = snapshot(harness.db);
  const operationsBefore = tableRows(harness.db, 'paymentOperations').length;
  const callsBefore = harness.calls.length;
  assert.equal(
    await checkoutFailureCode(harness, pendingArgs('req-fixr1-q1held-col', pendingQuote.quoteKey, orderIds)),
    'order_overlap',
  );
  assert.equal(
    await walletFailureCode(harness.db, 'clerk_buyer', {
      requestId: 'req-fixr1-q1held-wal',
      source: 'pending_orders',
      orderIds,
      deliveryMethodId: 'deliveryMethods|m1',
      shippingAddress: ADDRESS,
      expectedQuoteKey: pendingQuote.quoteKey,
    }),
    'order_overlap',
  );
  assert.deepEqual(snapshot(harness.db), before);
  assert.equal(tableRows(harness.db, 'paymentOperations').length, operationsBefore);
  assert.equal(harness.calls.length, callsBefore);
});

test('fixr1 real createOrder pending capture settles exact stock and money', async () => {
  const harness = open();
  const orderId = await createRealOrder(harness.db, {
    sellerId: 'users|seller',
    items: [
      {
        productId: 'products|lamp',
        title: 'Lamp',
        price: 100,
        quantity: 1,
        image: 'https://images.invalid/x.jpg',
      },
    ],
    subtotal: 100,
    shippingCost: 50,
    shippingAddress: ADDRESS,
  });
  // The registered handler reserves stock exactly once at creation.
  assert.equal(numberOf(findRow(harness.db, 'products', 'products|lamp'), 'quantity'), 9);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'pending_orders',
    orderIds: [orderId],
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const started = okResult(
    await initiate(harness, 'clerk_buyer', pendingArgs('req-fixr1-realcap', quote.quoteKey, [orderId])),
  );
  // Pending inventory is never reserved a second time at claim.
  assert.equal(numberOf(findRow(harness.db, 'products', 'products|lamp'), 'quantity'), 9);
  const result = appliedResult(
    await settleCheckout(harness.db, findRow(harness.db, 'paymentOperations', started.operationId), 'successful'),
  );
  assert.equal(result.application, 'applied');
  assert.equal(findRow(harness.db, 'orders', orderId)['status'], 'paid');
  assert.equal(numberOf(findRow(harness.db, 'products', 'products|lamp'), 'quantity'), 9);
  const holds = tableRows(harness.db, 'escrow').filter((row) => row['orderId'] === orderId);
  assert.equal(holds.length, 1);
  assert.equal(holds[0]?.['status'], 'held');
});

test('fixr1 real createOrder pending failure restores exact stock once', async () => {
  const harness = open();
  const orderId = await createRealOrder(harness.db, {
    sellerId: 'users|seller',
    items: [
      {
        productId: 'products|lamp',
        title: 'Lamp',
        price: 100,
        quantity: 2,
        image: 'https://images.invalid/x.jpg',
      },
    ],
    subtotal: 200,
    shippingCost: 50,
    shippingAddress: ADDRESS,
  });
  assert.equal(numberOf(findRow(harness.db, 'products', 'products|lamp'), 'quantity'), 8);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'pending_orders',
    orderIds: [orderId],
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const started = okResult(
    await initiate(harness, 'clerk_buyer', pendingArgs('req-fixr1-realfail', quote.quoteKey, [orderId])),
  );
  const result = appliedResult(
    await settleCheckout(harness.db, findRow(harness.db, 'paymentOperations', started.operationId), 'failed'),
  );
  assert.equal(result.application, 'applied');
  assert.equal(findRow(harness.db, 'orders', orderId)['status'], 'cancelled');
  assert.equal(numberOf(findRow(harness.db, 'products', 'products|lamp'), 'quantity'), 10);
  assert.equal(tableRows(harness.db, 'escrow').length, 0);
});

test('fixr1 real variant createOrders settle repeated lines and multiple orders', async () => {
  const harness = open();
  seedShirt(harness.db);
  // Two repeated custom lines on one order plus a second same-seller order.
  const firstId = await createRealOrder(harness.db, {
    sellerId: 'users|seller',
    items: [
      { ...variantLine('v-red', 'SHIRT-RED', 'Red', 1), customizationKey: 'gift-a' },
      { ...variantLine('v-red', 'SHIRT-RED', 'Red', 1), customizationKey: 'gift-b' },
    ],
    subtotal: 100,
    shippingCost: 50,
    shippingAddress: ADDRESS,
  });
  const secondId = await createRealOrder(harness.db, {
    sellerId: 'users|seller',
    items: [variantLine('v-blue', 'SHIRT-BLUE', 'Blue', 1)],
    subtotal: 50,
    shippingCost: 50,
    shippingAddress: ADDRESS,
  });
  // Real reservation: 3 units off the aggregate, per-variant stock exact.
  assert.equal(numberOf(findRow(harness.db, 'products', 'products|shirt'), 'quantity'), 7);
  const reservedCombos = findRow(harness.db, 'products', 'products|shirt')['variantCombinations'] as Array<
    Record<string, unknown>
  >;
  assert.equal(reservedCombos.find((entry) => entry['id'] === 'v-red')?.['stock'], 3);
  assert.equal(reservedCombos.find((entry) => entry['id'] === 'v-blue')?.['stock'], 6);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'pending_orders',
    orderIds: [firstId, secondId],
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const started = okResult(
    await initiate(harness, 'clerk_buyer', pendingArgs('req-fixr1-realvar', quote.quoteKey, [firstId, secondId])),
  );
  const result = appliedResult(
    await settleCheckout(harness.db, findRow(harness.db, 'paymentOperations', started.operationId), 'successful'),
  );
  assert.equal(result.application, 'applied');
  assert.equal(findRow(harness.db, 'orders', firstId)['status'], 'paid');
  assert.equal(findRow(harness.db, 'orders', secondId)['status'], 'paid');
  // Capture never re-reserves: stock round-trips the real creation shape.
  assert.equal(numberOf(findRow(harness.db, 'products', 'products|shirt'), 'quantity'), 7);
  const combos = findRow(harness.db, 'products', 'products|shirt')['variantCombinations'] as Array<
    Record<string, unknown>
  >;
  assert.equal(combos.find((entry) => entry['id'] === 'v-red')?.['stock'], 3);
  assert.equal(combos.find((entry) => entry['id'] === 'v-blue')?.['stock'], 6);
  for (const orderId of [firstId, secondId]) {
    assert.equal(tableRows(harness.db, 'escrow').filter((row) => row['orderId'] === orderId).length, 1);
  }
});

test('fixr2 a present loyalty row beside a missing account holds consumed proof under a tombstone', async () => {
  const { harness, operation } = await startPromoLoyaltyCheckout('req-fixr2-absent-account');
  const captured = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(captured.application, 'applied');
  const saved = structuredClone(findRow(harness.db, 'loyaltyTransactions', String(operation['loyaltyTransactionId'])));
  await invokeFakeFunction(usersModule.anonymizeDeletedUserByClerkId, createCtx(harness.db, null), {
    clerkId: 'clerk_buyer',
  });
  assert.equal(findRow(harness.db, 'users', 'users|buyer')['isDeleted'], true);
  assert.equal(tableRows(harness.db, 'loyaltyAccounts').length, 0);
  // Stored corruption: the pointed transaction is still present but names a
  // foreign user/order, conflicting points, and a reserved status while its
  // account stays legitimately erased.
  tableRows(harness.db, 'loyaltyTransactions').push({
    ...saved,
    userId: 'users|seller2',
    orderId: 'orders|foreign',
    points: 999,
    status: 'reserved',
  });
  const before = moneyTables(harness.db);
  const replay = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(replay.application, 'review');
  assert.deepEqual(moneyTables(harness.db), before);
});

test('fixr2 a stray same-operation loyalty link holds consumed proof when the claimed row is erased', async () => {
  const { harness, operation } = await startPromoLoyaltyCheckout('req-fixr2-stray-link');
  const captured = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(captured.application, 'applied');
  const saved = structuredClone(findRow(harness.db, 'loyaltyTransactions', String(operation['loyaltyTransactionId'])));
  await invokeFakeFunction(usersModule.anonymizeDeletedUserByClerkId, createCtx(harness.db, null), {
    clerkId: 'clerk_buyer',
  });
  assert.equal(tableRows(harness.db, 'loyaltyTransactions').length, 0);
  // The claimed row stays erased but a different-id row with the same
  // operation link and conflicting points is still present.
  tableRows(harness.db, 'loyaltyTransactions').push({
    ...saved,
    _id: 'loyaltyTransactions|stray',
    points: 999,
  });
  const before = moneyTables(harness.db);
  const replay = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(replay.application, 'review');
  assert.deepEqual(moneyTables(harness.db), before);
});

test('fixr2 a stray same-operation promo link holds consumed proof when the claimed promo row is gone', async () => {
  const { harness, operation } = await startPromoLoyaltyCheckout('req-fixr2-stray-promo');
  const captured = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(captured.application, 'applied');
  await invokeFakeFunction(usersModule.anonymizeDeletedUserByClerkId, createCtx(harness.db, null), {
    clerkId: 'clerk_buyer',
  });
  const redemption = tableRows(harness.db, 'promoCodeRedemptions')[0];
  assert.ok(redemption);
  assert.equal(redemption['status'], 'captured');
  // The frozen Clerk handler never deletes promo redemptions, so a missing
  // claimed row with a stray same-operation row still present must hold.
  harness.db.tables['promoCodeRedemptions'] = [
    { ...redemption, _id: 'promoCodeRedemptions|stray', discountAmount: 999 },
  ];
  const before = moneyTables(harness.db);
  const replay = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(replay.application, 'review');
  assert.deepEqual(moneyTables(harness.db), before);
});

test('fixr2 a present wrong-owner loyalty account holds consumed proof when the transaction is erased', async () => {
  const { harness, operation } = await startPromoLoyaltyCheckout('req-fixr2-wrong-account');
  const captured = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(captured.application, 'applied');
  const savedAccount = structuredClone(findRow(harness.db, 'loyaltyAccounts', String(operation['loyaltyAccountId'])));
  await invokeFakeFunction(usersModule.anonymizeDeletedUserByClerkId, createCtx(harness.db, null), {
    clerkId: 'clerk_buyer',
  });
  assert.equal(tableRows(harness.db, 'loyaltyTransactions').length, 0);
  assert.equal(tableRows(harness.db, 'loyaltyAccounts').length, 0);
  // The transaction stays legitimately erased but a present account with the
  // claimed id names a foreign owner: never waived by the tombstone.
  tableRows(harness.db, 'loyaltyAccounts').push({ ...savedAccount, userId: 'users|seller2' });
  const before = moneyTables(harness.db);
  const replay = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(replay.application, 'review');
  assert.deepEqual(moneyTables(harness.db), before);
});

test('fixr2 a present malformed loyalty account holds consumed proof when the transaction is erased', async () => {
  const { harness, operation } = await startPromoLoyaltyCheckout('req-fixr2-bad-counters');
  const captured = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(captured.application, 'applied');
  const savedAccount = structuredClone(findRow(harness.db, 'loyaltyAccounts', String(operation['loyaltyAccountId'])));
  await invokeFakeFunction(usersModule.anonymizeDeletedUserByClerkId, createCtx(harness.db, null), {
    clerkId: 'clerk_buyer',
  });
  assert.equal(tableRows(harness.db, 'loyaltyTransactions').length, 0);
  assert.equal(tableRows(harness.db, 'loyaltyAccounts').length, 0);
  // Corrupt numeric counters on the present account are never waived either.
  tableRows(harness.db, 'loyaltyAccounts').push({ ...savedAccount, pointsBalance: -1 });
  const before = moneyTables(harness.db);
  const replay = appliedResult(await settleCheckout(harness.db, operation, 'successful'));
  assert.equal(replay.application, 'review');
  assert.deepEqual(moneyTables(harness.db), before);
});

test('fixr2 a retained shared loyalty account keeps completed funding after Clerk erasure', async () => {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  const extra = { loyaltyPoints: 20 };
  const quoteA = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
    ...extra,
  });
  const startedA = okResult(
    await initiate(harness, 'clerk_buyer', checkoutArgs('req-fixr2-shared-a', quoteA.quoteKey, extra)),
  );
  const operationA = findRow(harness.db, 'paymentOperations', startedA.operationId);
  const capturedA = appliedResult(await settleCheckout(harness.db, operationA, 'successful'));
  assert.equal(capturedA.application, 'applied');
  // A distinct pending checkout reserves against the same numeric account,
  // then its provider attempt stays ambiguous without reusing A's receipt.
  seedCartLine(harness.db, 'products|cap', 1);
  harness.behavior.fail = true;
  const quoteB = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
    ...extra,
  });
  const startedB = okResult(
    await initiate(harness, 'clerk_buyer', checkoutArgs('req-fixr2-shared-b', quoteB.quoteKey, extra)),
  );
  const operationB = findRow(harness.db, 'paymentOperations', startedB.operationId);
  harness.behavior.fail = false;
  await invokeFakeFunction(usersModule.anonymizeDeletedUserByClerkId, createCtx(harness.db, null), {
    clerkId: 'clerk_buyer',
  });
  assert.equal(findRow(harness.db, 'users', 'users|buyer')['isDeleted'], true);
  // A's captured row is erased but the shared numeric account is retained
  // for B's outstanding reserved row.
  assert.equal(
    tableRows(harness.db, 'loyaltyTransactions').some((row) => row._id === String(operationA['loyaltyTransactionId'])),
    false,
  );
  const account = findRow(harness.db, 'loyaltyAccounts', String(operationA['loyaltyAccountId']));
  assert.equal(account['userId'], 'users|buyer');
  const retainedB = tableRows(harness.db, 'loyaltyTransactions').find(
    (row) => row._id === String(operationB['loyaltyTransactionId']),
  );
  assert.ok(retainedB);
  assert.equal(retainedB['status'], 'reserved');
  const escrowsBefore = tableRows(harness.db, 'escrow').length;
  const replay = appliedResult(await settleCheckout(harness.db, operationA, 'successful'));
  assert.equal(replay.application, 'applied');
  assert.equal(tableRows(harness.db, 'escrow').length, escrowsBefore);
});

test('fixr2 a trusted failure release survives Clerk erasure with empty loyalty tables', async () => {
  const { harness, operation } = await startPromoLoyaltyCheckout('req-fixr2-release-erasure');
  const released = appliedResult(await settleCheckout(harness.db, operation, 'failed'));
  assert.equal(released.application, 'applied');
  assert.equal(operation['status'], 'failed');
  await invokeFakeFunction(usersModule.anonymizeDeletedUserByClerkId, createCtx(harness.db, null), {
    clerkId: 'clerk_buyer',
  });
  assert.equal(findRow(harness.db, 'users', 'users|buyer')['isDeleted'], true);
  assert.equal(tableRows(harness.db, 'loyaltyTransactions').length, 0);
  assert.equal(tableRows(harness.db, 'loyaltyAccounts').length, 0);
  assert.equal(tableRows(harness.db, 'escrow').length, 0);
  const replay = appliedResult(await settleCheckout(harness.db, operation, 'failed'));
  assert.equal(replay.application, 'applied');
  assert.equal(tableRows(harness.db, 'escrow').length, 0);
});
