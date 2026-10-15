import assert from 'node:assert/strict';
import test from 'node:test';

import { ConvexError, type Value } from 'convex/values';

import * as checkoutQuote from './checkoutQuote';
import type { CheckoutQuote } from './lib/checkoutQuote';
import { majorNumberToCents } from './lib/catalogMoney';
import type { LencoFetch } from './lib/lencoAdapter';
import * as providerOperations from './providerOperations';
import * as providerSettlement from './providerSettlement';
import * as walletOperations from './paymentOperations';
import * as promotionsModule from './promotions';
import * as checkoutCollection from './checkoutCollection';
import { createCheckoutCollectionAction } from './checkoutCollection';
import * as ordersModule from './orders';
import * as usersModule from './users';
import { createFakeActionCtx, invokeFakeFunction, type FakeModules } from '../tests/support/convexFakeActionCtx';
import { createCtx, createDb, handlerOf, type Db, type Row, type Tables } from '../tests/support/convexFakeDb';

// Real-handler checkout-collection checks through the registered action and
// internal mutations. Transport is intercepted at the adapter fetch boundary
// only: quote approval, reservation, claim, debit, and attachment all run
// for real, and the oracle inspects the database at fetch time. The fake
// cannot prove live OCC rollback, so every denial is asserted with unchanged
// tables and every check runs before the first write.

const COLLECTION_ID = '22222222-2222-3333-4444-555555555555';

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

function createFetch(
  calls: FetchCall[],
  behavior: { onFetch?: (call: FetchCall, db: Db) => void; fail?: boolean },
  db: Db,
): LencoFetch {
  return (async (url: string, init: { method: string; body?: string }): Promise<Response> => {
    let body: Value | null = null;
    if (init.body !== undefined) {
      body = JSON.parse(init.body) as Value;
    }
    const call: FetchCall = { url, method: init.method, body };
    calls.push(call);
    if (behavior.onFetch !== undefined) {
      behavior.onFetch(call, db);
    }
    if (url.endsWith('/collections/mobile-money')) {
      if (behavior.fail === true) {
        return new Response(JSON.stringify({ status: false, message: 'provider down' }), { status: 500 });
      }
      const args = bodyOf(call);
      return envelope({
        id: COLLECTION_ID,
        reference: args['reference'],
        amount: String(args['amount'] as number),
        currency: 'ZMW',
        status: 'pending',
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
      userRow('users|admin', 'clerk_admin', 'admin'),
      userRow('users|banned', 'clerk_banned', 'user', { isBanned: true }),
      userRow('users|deleted', 'clerk_deleted', 'user', { deletedAt: 1 }),
      userRow('users|company', 'clerk_company', 'admin'),
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
  behavior: { onFetch?: (call: FetchCall, db: Db) => void; fail?: boolean };
};

function open(behavior: { onFetch?: (call: FetchCall, db: Db) => void; fail?: boolean } = {}): Harness {
  const db = createDb(fixtureTables());
  const calls: FetchCall[] = [];
  const fetchImpl = createFetch(calls, behavior, db);
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
  // Monotonic ids: cleared carts must never donate a recycled id to a later
  // line, or overlap scans would see a phantom cover.
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

function seedOrder(
  db: Db,
  orderId: string,
  buyerId: string,
  sellerId: string,
  status: string,
  items: Record<string, unknown>[],
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
  });
}

function lampItem(quantity: number): Record<string, unknown> {
  return { productId: 'products|lamp', title: 'Lamp', price: 100, quantity, image: 'https://images.invalid/x.jpg' };
}

function capItem(quantity: number): Record<string, unknown> {
  return { productId: 'products|cap', title: 'Cap', price: 10, quantity, image: 'https://images.invalid/x.jpg' };
}

function findRow(db: Db, table: string, id: string): Row {
  const row = db.tables[table]?.find((candidate) => candidate._id === id);
  assert.ok(row, `${id} must exist in ${table}`);
  return row;
}

function tableRows(db: Db, table: string): Row[] {
  return db.tables[table] ?? [];
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

async function failureCode(fn: unknown, ctx: unknown, args: unknown): Promise<string> {
  try {
    const result = (await invokeFakeFunction(fn, ctx, args)) as { ok: boolean; code?: string };
    if (result.ok === false && typeof result.code === 'string') {
      return result.code;
    }
    throw new Error(`expected the call to fail, got ${JSON.stringify(result)}`);
  } catch (error) {
    if (error instanceof ConvexError) {
      const data = error.data as { code: string; message: string };
      assert.equal(typeof data.message, 'string');
      return data.code;
    }
    throw error;
  }
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
    if (error instanceof ConvexError) {
      const data = error.data as { code?: unknown };
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

// ---- Request validation: public args carry no money authority ----

test('checkout args reject caller authority and spoofed provider fields with no writes', async () => {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const base = checkoutArgs('req-spoof', quote.quoteKey);
  const before = snapshot(harness.db);
  const ctx = actionCtx(harness, 'clerk_buyer');
  const action = actionOf(harness);
  await assert.rejects(
    () => invokeFakeFunction(action, ctx, { ...base, userId: 'users|other' }),
    /Argument validation failed/,
  );
  await assert.rejects(
    () => invokeFakeFunction(action, ctx, { ...base, amountCents: 1 }),
    /Argument validation failed/,
  );
  await assert.rejects(
    () => invokeFakeFunction(action, ctx, { ...base, providerReference: 'TXN-X' }),
    /Argument validation failed/,
  );
  await assert.rejects(
    () => invokeFakeFunction(action, ctx, { ...base, status: 'succeeded' }),
    /Argument validation failed/,
  );
  assert.deepEqual(snapshot(harness.db), before);
  assert.equal(harness.calls.length, 0);
});

test('banned and deleted subjects cannot initiate checkout', async () => {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const before = snapshot(harness.db);
  await assert.rejects(
    () => initiate(harness, 'clerk_banned', checkoutArgs('req-ban', quote.quoteKey)),
    /banned|Banned|Unauthorized|denied/i,
  );
  await assert.rejects(
    () => initiate(harness, 'clerk_deleted', checkoutArgs('req-del', quote.quoteKey)),
    /deleted|Unauthorized|denied/i,
  );
  assert.deepEqual(snapshot(harness.db), before);
  assert.equal(harness.calls.length, 0);
});

// ---- Fresh cart checkout: one durable claim, full reservations ----

test('cart checkout reserves orders, stock, companion and claims one POST', async () => {
  const harness = open();
  const lampBefore = numberOf(findRow(harness.db, 'products', 'products|lamp'), 'quantity');
  const capBefore = numberOf(findRow(harness.db, 'products', 'products|cap'), 'quantity');
  const cartA = seedCartLine(harness.db, 'products|lamp', 1);
  const cartB = seedCartLine(harness.db, 'products|cap', 2);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  let seenAtFetch: { operationId: string; status: string; reference: string } | null = null;
  harness.behavior.onFetch = (call, db) => {
    const args = bodyOf(call);
    const operations = tableRows(db, 'paymentOperations');
    assert.equal(operations.length, 1);
    const operation = operations[0] as Record<string, unknown>;
    assert.equal(operation['kind'], 'checkout_collection');
    assert.equal(operation['status'], 'attempted');
    assert.equal(operation['amountCents'], quote.totalAmountCents);
    assert.ok(
      typeof operation['providerReference'] === 'string' &&
        (operation['providerReference'] as string).startsWith('TXN-'),
    );
    assert.equal(args['reference'], operation['providerReference']);
    assert.equal(args['amount'], quote.totalAmountCents / 100);
    assert.equal(args['phone'], PHONE);
    // Reservations exist at fetch time: pending orders with reciprocal links.
    const orderIds = operation['orderIds'] as string[];
    assert.equal(orderIds.length, 2);
    for (const orderId of orderIds) {
      const order = findRow(db, 'orders', orderId);
      assert.equal(order['status'], 'pending_payment');
      assert.equal(order['operationId'], operation['_id']);
    }
    const companions = tableRows(db, 'transactions').filter((row) => row['operationId'] === operation['_id']);
    assert.equal(companions.length, 1);
    const companion = companions[0] as Row;
    assert.equal(companion['status'], 'pending');
    assert.equal(companion['reference'], operation['providerReference']);
    assert.deepEqual((companion['metadata'] as Record<string, unknown>)['checkoutOrderIds'], [...orderIds].sort());
    seenAtFetch = {
      operationId: operation['_id'] as string,
      status: operation['status'] as string,
      reference: operation['providerReference'] as string,
    };
  };
  const result = okResult(await initiate(harness, 'clerk_buyer', checkoutArgs('req-cart-1', quote.quoteKey)));
  assert.equal(harness.calls.length, 1);
  assert.ok(seenAtFetch, 'fetch oracle must observe the durable claim');
  assert.equal(result.status, 'unknown');
  assert.equal(result.providerReference, (seenAtFetch as unknown as { reference: string }).reference);
  assert.ok(result.providerReference.startsWith('TXN-'));

  const operation = findRow(harness.db, 'paymentOperations', result.operationId);
  assert.equal(operation['status'], 'unknown');
  assert.equal(operation['quoteKey'], quote.quoteKey);
  assert.deepEqual(operation['quoteSnapshot'], JSON.parse(JSON.stringify(quote)));
  // Cart rows are retained until trusted Task4 success.
  assert.ok(findRow(harness.db, 'cartItems', cartA));
  assert.ok(findRow(harness.db, 'cartItems', cartB));
  // Raw snapshot stored for Task4 cleanup.
  const raw = operation['rawCartSnapshot'] as Array<Record<string, unknown>> | undefined;
  assert.ok(raw && raw.length === 2);
  // Stock reserved exactly once in aggregate.
  assert.equal(numberOf(findRow(harness.db, 'products', 'products|lamp'), 'quantity'), lampBefore - 1);
  assert.equal(numberOf(findRow(harness.db, 'products', 'products|cap'), 'quantity'), capBefore - 2);
  // No escrow, no wallet movement, no paid orders in this slice.
  assert.equal(tableRows(harness.db, 'escrow').length, 0);
  assert.equal(tableRows(harness.db, 'walletTransactions').length, 0);
});

test('stale expected key returns quote_mismatch with zero writes', async () => {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  const before = snapshot(harness.db);
  const result = (await initiate(harness, 'clerk_buyer', checkoutArgs('req-stale', 'stale-key'))) as {
    ok: boolean;
    code?: string;
    quote?: CheckoutQuote;
  };
  assert.equal(result.ok, false);
  assert.equal(result.code, 'quote_mismatch');
  assert.ok(result.quote && typeof result.quote.quoteKey === 'string' && result.quote.quoteKey !== 'stale-key');
  assert.deepEqual(snapshot(harness.db), before);
  assert.equal(harness.calls.length, 0);
});

test('same-request reuse returns stored status with zero POST despite later cart and config changes', async () => {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const first = okResult(await initiate(harness, 'clerk_buyer', checkoutArgs('req-reuse', quote.quoteKey)));
  assert.equal(harness.calls.length, 1);
  // Later cart/config/switch changes must not cause a second POST or write.
  tableRows(harness.db, 'cartItems').length = 0;
  findRow(harness.db, 'appConfig', 'appConfig|1')['paymentsEnabled'] = false;
  const afterFirst = snapshot(harness.db);
  const second = okResult(await initiate(harness, 'clerk_buyer', checkoutArgs('req-reuse', quote.quoteKey)));
  assert.equal(second.operationId, first.operationId);
  assert.equal(second.status, 'unknown');
  assert.equal(harness.calls.length, 1);
  assert.deepEqual(snapshot(harness.db), afterFirst);
});

test('conflicting reuse and cross-kind reuse reject without effects', async () => {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  await initiate(harness, 'clerk_buyer', checkoutArgs('req-conflict', quote.quoteKey));
  const before = snapshot(harness.db);
  const code = await failureCode(
    actionOf(harness),
    actionCtx(harness, 'clerk_buyer'),
    checkoutArgs('req-conflict', quote.quoteKey, { phone: '0979999999' }),
  );
  assert.equal(code, 'conflicting_reuse');
  assert.deepEqual(snapshot(harness.db), before);
  assert.equal(harness.calls.length, 1);
});

test('overlapping second request for the same cart rejects with zero writes', async () => {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  await initiate(harness, 'clerk_buyer', checkoutArgs('req-over-1', quote.quoteKey));
  const before = snapshot(harness.db);
  const code = await failureCode(
    actionOf(harness),
    actionCtx(harness, 'clerk_buyer'),
    checkoutArgs('req-over-2', quote.quoteKey),
  );
  assert.equal(code, 'order_overlap');
  assert.deepEqual(snapshot(harness.db), before);
  assert.equal(harness.calls.length, 1);
});

// ---- Pending source: refresh without a second stock decrement ----

test('pending checkout refreshes canonical slices with identity pairing and no second decrement', async () => {
  const harness = open();
  seedOrder(harness.db, 'orders|p1', 'users|buyer', 'users|seller', 'pending_payment', [lampItem(1)]);
  seedOrder(harness.db, 'orders|p2', 'users|buyer', 'users|seller', 'pending_payment', [lampItem(2)]);
  seedOrder(harness.db, 'orders|p3', 'users|buyer', 'users|seller2', 'pending_payment', [capItem(3)]);
  const lampBefore = numberOf(findRow(harness.db, 'products', 'products|lamp'), 'quantity');
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'pending_orders',
    orderIds: ['orders|p1', 'orders|p2', 'orders|p3'],
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const result = okResult(
    await initiate(
      harness,
      'clerk_buyer',
      checkoutArgs('req-pending', quote.quoteKey, {
        source: 'pending_orders',
        orderIds: ['orders|p1', 'orders|p2', 'orders|p3'],
      }),
    ),
  );
  assert.equal(harness.calls.length, 1);
  const operation = findRow(harness.db, 'paymentOperations', result.operationId);
  const breakdowns = operation['orderBreakdowns'] as Array<Record<string, unknown>>;
  assert.equal(breakdowns.length, 3);
  // Every breakdown stays paired to its own order id with exact slice money.
  for (const orderId of ['orders|p1', 'orders|p2', 'orders|p3'] as const) {
    const breakdown = breakdowns.find((entry) => entry['orderId'] === orderId);
    assert.ok(breakdown, `${orderId} must keep its own slice`);
    const order = findRow(harness.db, 'orders', orderId);
    assert.equal(order['status'], 'pending_payment');
    assert.equal(order['operationId'], result.operationId);
    assert.equal(centsOf(order['totalAmount']), breakdown['totalAmountCents']);
  }
  // Aggregate and seller conservation across the three slices.
  const total = (breakdowns as Array<{ totalAmountCents: number }>).reduce(
    (sum, entry) => sum + entry.totalAmountCents,
    0,
  );
  assert.equal(total, quote.totalAmountCents);
  // Pending inventory is never decremented again.
  assert.equal(numberOf(findRow(harness.db, 'products', 'products|lamp'), 'quantity'), lampBefore);
});

// ---- Promo and loyalty reservations with consistent readers ----

test('promo reservation holds one usage and counts across released and legacy rows', async () => {
  const harness = open();
  // Legacy captured, released, and unknown-status rows for the per-user cap probe.
  tableRows(harness.db, 'promoCodeRedemptions').push(
    {
      _id: 'promoCodeRedemptions|legacy',
      promoCodeId: 'promoCodes|save10',
      userId: 'users|other',
      discountAmount: 5,
      redeemedAt: 1,
    },
    {
      _id: 'promoCodeRedemptions|released',
      promoCodeId: 'promoCodes|save10',
      userId: 'users|buyer',
      discountAmount: 5,
      redeemedAt: 1,
      status: 'released',
    },
    {
      _id: 'promoCodeRedemptions|odd',
      promoCodeId: 'promoCodes|save10',
      userId: 'users|other',
      discountAmount: 5,
      redeemedAt: 1,
      status: 'mystery',
    },
  );
  findRow(harness.db, 'promoCodes', 'promoCodes|save10')['perUserLimit'] = 1;
  findRow(harness.db, 'promoCodes', 'promoCodes|save10')['usageLimit'] = 10;
  seedCartLine(harness.db, 'products|lamp', 1);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
    promoCode: 'SAVE10',
  });
  assert.ok(quote.promo && quote.promo.discountCents > 0);
  const result = okResult(
    await initiate(harness, 'clerk_buyer', checkoutArgs('req-promo', quote.quoteKey, { promoCode: 'SAVE10' })),
  );
  const operation = findRow(harness.db, 'paymentOperations', result.operationId);
  const redemptionId = operation['promoRedemptionId'] as string;
  assert.ok(redemptionId);
  const redemption = findRow(harness.db, 'promoCodeRedemptions', redemptionId);
  assert.equal(redemption['status'], 'reserved');
  assert.equal(redemption['operationId'], result.operationId);
  assert.equal(centsOf(redemption['discountAmount']), quote.promo.discountCents);
  // The reserved usage now exhausts the per-user cap of 1 for a second checkout.
  // The fresh quote itself rejects, so any expected key yields promo_invalid
  // with zero writes: the released row stays ignored while the reserved,
  // legacy, and unknown-status rows keep counting.
  seedCartLine(harness.db, 'products|cap', 1);
  const beforeSecond = snapshot(harness.db);
  const code = await failureCode(
    actionOf(harness),
    actionCtx(harness, 'clerk_buyer'),
    checkoutArgs('req-promo-2', quote.quoteKey, { promoCode: 'SAVE10' }),
  );
  assert.equal(code, 'promo_invalid');
  assert.deepEqual(snapshot(harness.db), beforeSecond);
});

test('loyalty reservation debits balance once and never captures lifetime', async () => {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
    loyaltyPoints: 20,
  });
  assert.ok(quote.loyalty && quote.loyalty.points === 20);
  const result = okResult(
    await initiate(harness, 'clerk_buyer', checkoutArgs('req-loyal', quote.quoteKey, { loyaltyPoints: 20 })),
  );
  const account = findRow(harness.db, 'loyaltyAccounts', 'loyaltyAccounts|buyer');
  assert.equal(account['pointsBalance'], 80);
  assert.equal(account['lifetimeRedeemed'], 0);
  assert.equal(account['lifetimeEarned'], 100);
  const operation = findRow(harness.db, 'paymentOperations', result.operationId);
  const loyaltyTxId = operation['loyaltyTransactionId'] as string;
  assert.ok(loyaltyTxId);
  const loyaltyTx = findRow(harness.db, 'loyaltyTransactions', loyaltyTxId);
  assert.equal(loyaltyTx['status'], 'reserved');
  assert.equal(loyaltyTx['points'], 20);
  assert.equal(loyaltyTx['operationId'], result.operationId);
  assert.equal(operation['loyaltyPoints'], 20);
});

test('a balance change after quoting recovers with quote_mismatch and zero writes', async () => {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
    loyaltyPoints: 20,
  });
  assert.ok(quote.loyalty && quote.loyalty.points === 20);
  // The approved 20-point snapshot no longer prices once the balance moves:
  // the precise recovery is quote_mismatch with the fresh owned quote, and
  // no reservation, write, or POST may happen on the stale key.
  findRow(harness.db, 'loyaltyAccounts', 'loyaltyAccounts|buyer')['pointsBalance'] = 1;
  const before = snapshot(harness.db);
  const result = (await initiate(
    harness,
    'clerk_buyer',
    checkoutArgs('req-loyal-stale', quote.quoteKey, { loyaltyPoints: 20 }),
  )) as { ok: boolean; code?: string; quote?: CheckoutQuote };
  assert.equal(result.ok, false);
  assert.equal(result.code, 'quote_mismatch');
  assert.ok(result.quote && result.quote.quoteKey !== quote.quoteKey);
  assert.deepEqual(snapshot(harness.db), before);
  assert.equal(harness.calls.length, 0);
});

// ---- Unknown outcomes retain every reservation ----

test('transport failure attaches unknown and retains all reservations', async () => {
  const failing = open({ fail: true });
  failing.db.tables.cartItems?.push({
    _id: 'cartItems|seed1',
    userId: 'users|buyer',
    productId: 'products|lamp',
    quantity: 1,
    selectedShipping: { name: 'Courier', price: 50 },
    createdAt: 1,
    updatedAt: 1,
  });
  const quote = await freshQuote(failing.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
    loyaltyPoints: 10,
  });
  const result = okResult(
    await initiate(failing, 'clerk_buyer', checkoutArgs('req-unknown', quote.quoteKey, { loyaltyPoints: 10 })),
  );
  assert.equal(result.status, 'unknown');
  assert.equal(failing.calls.length, 1);
  const operation = findRow(failing.db, 'paymentOperations', result.operationId);
  assert.equal(operation['status'], 'unknown');
  // Every reservation is retained: orders, companion, promo/loyalty, stock.
  for (const orderId of operation['orderIds'] as string[]) {
    assert.equal(findRow(failing.db, 'orders', orderId)['operationId'], result.operationId);
  }
  assert.equal(
    tableRows(failing.db, 'transactions').filter((row) => row['operationId'] === result.operationId).length,
    1,
  );
  assert.equal(findRow(failing.db, 'loyaltyAccounts', 'loyaltyAccounts|buyer')['pointsBalance'], 90);
  assert.equal(findRow(failing.db, 'loyaltyAccounts', 'loyaltyAccounts|buyer')['lifetimeRedeemed'], 0);
});

// ---- Cancellation and deletion prerequisites ----

test('both cancel entry points reject a checkout-linked order with every table unchanged', async () => {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const result = okResult(await initiate(harness, 'clerk_buyer', checkoutArgs('req-cancel', quote.quoteKey)));
  const orderId = (findRow(harness.db, 'paymentOperations', result.operationId)['orderIds'] as string[])[0] as string;
  const before = snapshot(harness.db);
  await assert.rejects(
    () => invokeFakeFunction(ordersModule.cancelOrder, createCtx(harness.db, 'clerk_buyer'), { orderId }),
    /unresolved checkout/,
  );
  assert.deepEqual(snapshot(harness.db), before);
  await assert.rejects(
    () =>
      invokeFakeFunction(ordersModule.updateOrderStatus, createCtx(harness.db, 'clerk_buyer'), {
        orderId,
        status: 'cancelled',
      }),
    /unresolved checkout/,
  );
  assert.deepEqual(snapshot(harness.db), before);
});

test('legacy cancellation without a checkout link still works', async () => {
  const harness = open();
  seedOrder(harness.db, 'orders|legacy', 'users|buyer', 'users|seller', 'pending_payment', [lampItem(1)]);
  const cancelled = (await invokeFakeFunction(ordersModule.cancelOrder, createCtx(harness.db, 'clerk_buyer'), {
    orderId: 'orders|legacy',
  })) as Row | null;
  assert.ok(cancelled);
  assert.equal(cancelled['status'], 'cancelled');
});

test('loyalty checkout then anonymization retains the reservation and tombstones the owner', async () => {
  const harness = open();
  // Unrelated loyalty history that must be removed.
  tableRows(harness.db, 'loyaltyTransactions').push({
    _id: 'loyaltyTransactions|old',
    accountId: 'loyaltyAccounts|buyer',
    userId: 'users|buyer',
    type: 'earn',
    points: 5,
    reason: 'Old reward.',
    createdAt: 1,
  });
  seedCartLine(harness.db, 'products|lamp', 1);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
    loyaltyPoints: 10,
  });
  const result = okResult(
    await initiate(harness, 'clerk_buyer', checkoutArgs('req-anon', quote.quoteKey, { loyaltyPoints: 10 })),
  );
  const operation = findRow(harness.db, 'paymentOperations', result.operationId);
  const loyaltyTxId = operation['loyaltyTransactionId'] as string;

  const first = (await invokeFakeFunction(usersModule.anonymizeDeletedUserByClerkId, createCtx(harness.db, null), {
    clerkId: 'clerk_buyer',
  })) as { status: string };
  assert.equal(first.status, 'anonymized');
  // Reserved reservation and its numeric account survive; history is gone.
  const retained = findRow(harness.db, 'loyaltyTransactions', loyaltyTxId);
  assert.equal(retained['status'], 'reserved');
  assert.equal(retained['operationId'], result.operationId);
  assert.ok(findRow(harness.db, 'loyaltyAccounts', 'loyaltyAccounts|buyer'));
  assert.equal(
    harness.db.tables.loyaltyTransactions?.find((row) => row._id === 'loyaltyTransactions|old'),
    undefined,
  );
  const tombstone = findRow(harness.db, 'users', 'users|buyer');
  assert.equal(tombstone['isDeleted'], true);
  assert.equal(tombstone['isBanned'], true);
  // Attachment still works after denial: receipt evidence is preserved.
  const attached = (await invokeFakeFunction(providerOperations.attachProviderResult, createCtx(harness.db, null), {
    operationId: result.operationId,
    receipt: {
      kind: 'collection',
      id: COLLECTION_ID,
      reference: result.providerReference,
      amountMinor: quote.totalAmountCents,
      feeMinor: null,
      currency: 'ZMW',
      status: 'pending',
      collectionType: 'mobile-money',
      country: 'zm',
      bearer: 'merchant',
      operator: 'mtn',
      phone: PHONE,
      reasonForFailure: null,
      settlementStatus: null,
    },
  })) as { operationId: string; status: string };
  assert.equal(attached.status, 'unknown');
  assert.equal(findRow(harness.db, 'paymentOperations', result.operationId)['providerId'], COLLECTION_ID);
  // Repeat anonymization stays safe and keeps the reservation.
  const second = (await invokeFakeFunction(usersModule.anonymizeDeletedUserByClerkId, createCtx(harness.db, null), {
    clerkId: 'clerk_buyer',
  })) as { status: string };
  assert.equal(second.status, 'anonymized');
  assert.ok(findRow(harness.db, 'loyaltyTransactions', loyaltyTxId));
});

test('hard delete is refused while a checkout reservation is unresolved', async () => {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  await initiate(harness, 'clerk_buyer', checkoutArgs('req-nodelete', quote.quoteKey));
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

// ---- Correction wave R1: terminal labels retain coverage (finding 1) ----

test('bare terminal labels retain cart coverage for a second collection', async () => {
  for (const label of ['failed', 'cancelled', 'succeeded'] as const) {
    const harness = open();
    seedCartLine(harness.db, 'products|lamp', 1);
    const quote = await freshQuote(harness.db, 'clerk_buyer', {
      source: 'cart',
      deliveryMethodId: 'deliveryMethods|m1',
      shippingAddress: ADDRESS,
    });
    const first = okResult(await initiate(harness, 'clerk_buyer', checkoutArgs(`req-term-1-${label}`, quote.quoteKey)));
    // A bare local label with no trusted release/accounting marker: the
    // rows stay covered and a second collection must deny order_overlap.
    findRow(harness.db, 'paymentOperations', first.operationId)['status'] = label;
    const fresh = await freshQuote(harness.db, 'clerk_buyer', {
      source: 'cart',
      deliveryMethodId: 'deliveryMethods|m1',
      shippingAddress: ADDRESS,
    });
    const before = snapshot(harness.db);
    const code = await failureCode(
      actionOf(harness),
      actionCtx(harness, 'clerk_buyer'),
      checkoutArgs(`req-term-2-${label}`, fresh.quoteKey),
    );
    assert.equal(code, 'order_overlap');
    assert.deepEqual(snapshot(harness.db), before);
    assert.equal(harness.calls.length, 1);
  }
});

test('a bare failed label retains coverage against a wallet purchase', async () => {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  seedWallet(harness.db);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const first = okResult(await initiate(harness, 'clerk_buyer', checkoutArgs('req-wallet-blocked', quote.quoteKey)));
  findRow(harness.db, 'paymentOperations', first.operationId)['status'] = 'failed';
  const walletQuote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const before = snapshot(harness.db);
  assert.equal(
    await walletFailureCode(harness.db, 'clerk_buyer', {
      requestId: 'req-wallet-second',
      source: 'cart',
      deliveryMethodId: 'deliveryMethods|m1',
      shippingAddress: ADDRESS,
      expectedQuoteKey: walletQuote.quoteKey,
    }),
    'order_overlap',
  );
  assert.deepEqual(snapshot(harness.db), before);
});

test('hard delete is refused for a bare failed checkout label', async () => {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const result = okResult(await initiate(harness, 'clerk_buyer', checkoutArgs('req-nodelete-failed', quote.quoteKey)));
  findRow(harness.db, 'paymentOperations', result.operationId)['status'] = 'failed';
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

// ---- Correction wave R1: missing/conflicting links need review (finding 2) ----

test('both cancel entry points reject a missing checkout link with every table unchanged', async () => {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const result = okResult(await initiate(harness, 'clerk_buyer', checkoutArgs('req-missing-link', quote.quoteKey)));
  const operation = findRow(harness.db, 'paymentOperations', result.operationId);
  const orderId = (operation['orderIds'] as string[])[0] as string;
  findRow(harness.db, 'orders', orderId)['operationId'] = 'paymentOperations|missing';
  const before = snapshot(harness.db);
  await assert.rejects(
    () => invokeFakeFunction(ordersModule.cancelOrder, createCtx(harness.db, 'clerk_buyer'), { orderId }),
    /review/,
  );
  assert.deepEqual(snapshot(harness.db), before);
  await assert.rejects(
    () =>
      invokeFakeFunction(ordersModule.updateOrderStatus, createCtx(harness.db, 'clerk_buyer'), {
        orderId,
        status: 'cancelled',
      }),
    /review/,
  );
  assert.deepEqual(snapshot(harness.db), before);
  assert.equal(findRow(harness.db, 'paymentOperations', result.operationId)['status'], 'unknown');
});

test('a provider top-up row cannot authorize cancellation of a checkout order', async () => {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const result = okResult(await initiate(harness, 'clerk_buyer', checkoutArgs('req-kind-link', quote.quoteKey)));
  const operation = findRow(harness.db, 'paymentOperations', result.operationId);
  const orderId = (operation['orderIds'] as string[])[0] as string;
  tableRows(harness.db, 'paymentOperations').push({
    _id: 'paymentOperations|topup',
    ownerId: 'users|buyer',
    requestId: 'req-topup-kind',
    kind: 'top_up_collection',
    status: 'unknown',
  });
  findRow(harness.db, 'orders', orderId)['operationId'] = 'paymentOperations|topup';
  const before = snapshot(harness.db);
  await assert.rejects(
    () => invokeFakeFunction(ordersModule.cancelOrder, createCtx(harness.db, 'clerk_buyer'), { orderId }),
    /review/,
  );
  assert.deepEqual(snapshot(harness.db), before);
  await assert.rejects(
    () =>
      invokeFakeFunction(ordersModule.updateOrderStatus, createCtx(harness.db, 'clerk_buyer'), {
        orderId,
        status: 'cancelled',
      }),
    /review/,
  );
  assert.deepEqual(snapshot(harness.db), before);
});

test('a conflicting checkout linkage needs review at both cancel entries', async () => {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const result = okResult(await initiate(harness, 'clerk_buyer', checkoutArgs('req-conflict-link', quote.quoteKey)));
  const operation = findRow(harness.db, 'paymentOperations', result.operationId);
  const orderId = (operation['orderIds'] as string[])[0] as string;
  // Break the reciprocal linkage: the order still names the operation, but
  // the operation no longer names the order.
  findRow(harness.db, 'paymentOperations', result.operationId)['orderIds'] = [];
  const before = snapshot(harness.db);
  await assert.rejects(
    () => invokeFakeFunction(ordersModule.cancelOrder, createCtx(harness.db, 'clerk_buyer'), { orderId }),
    /conflicting payment record/,
  );
  assert.deepEqual(snapshot(harness.db), before);
  await assert.rejects(
    () =>
      invokeFakeFunction(ordersModule.updateOrderStatus, createCtx(harness.db, 'clerk_buyer'), {
        orderId,
        status: 'cancelled',
      }),
    /conflicting payment record/,
  );
  assert.deepEqual(snapshot(harness.db), before);
});

test('staff cancellation cannot bypass the checkout guard but legacy orders still cancel', async () => {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  seedOrder(harness.db, 'orders|legacy', 'users|buyer', 'users|seller', 'pending_payment', [lampItem(1)]);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const result = okResult(await initiate(harness, 'clerk_buyer', checkoutArgs('req-staff-guard', quote.quoteKey)));
  const orderId = (findRow(harness.db, 'paymentOperations', result.operationId)['orderIds'] as string[])[0] as string;
  const before = snapshot(harness.db);
  // Neither the admin cancel entry nor the moderator status transition may
  // bypass the shared guard.
  await assert.rejects(
    () => invokeFakeFunction(ordersModule.cancelOrder, createCtx(harness.db, 'clerk_admin'), { orderId }),
    /unresolved checkout/,
  );
  assert.deepEqual(snapshot(harness.db), before);
  await assert.rejects(
    () =>
      invokeFakeFunction(ordersModule.updateOrderStatus, createCtx(harness.db, 'clerk_admin'), {
        orderId,
        status: 'cancelled',
      }),
    /unresolved checkout/,
  );
  assert.deepEqual(snapshot(harness.db), before);
  // The same admin path still cancels a genuine legacy order.
  const cancelled = (await invokeFakeFunction(ordersModule.cancelOrder, createCtx(harness.db, 'clerk_admin'), {
    orderId: 'orders|legacy',
  })) as Row | null;
  assert.ok(cancelled);
  assert.equal(cancelled['status'], 'cancelled');
});

// ---- Correction wave R1: unique loyalty account (finding 3) ----

test('duplicate owned loyalty accounts deny before any reservation or POST', async () => {
  const harness = open();
  tableRows(harness.db, 'loyaltyAccounts').push({
    ...structuredClone(findRow(harness.db, 'loyaltyAccounts', 'loyaltyAccounts|buyer')),
    _id: 'loyaltyAccounts|duplicate',
  });
  seedCartLine(harness.db, 'products|lamp', 1);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
    loyaltyPoints: 10,
  });
  const before = snapshot(harness.db);
  const code = await failureCode(
    actionOf(harness),
    actionCtx(harness, 'clerk_buyer'),
    checkoutArgs('req-dup-loyal', quote.quoteKey, { loyaltyPoints: 10 }),
  );
  assert.equal(code, 'loyalty_invalid');
  assert.deepEqual(snapshot(harness.db), before);
  assert.equal(harness.calls.length, 0);
  assert.deepEqual(
    tableRows(harness.db, 'loyaltyAccounts').map((row) => row['pointsBalance']),
    [100, 100],
  );
});

// ---- Correction wave R1: direct evidence for changed boundaries (finding 5) ----

test('missing or invalid private config denies with not_started and zero effects', async () => {
  for (const env of [{}, { LENCO_API_KEY: '' }] as Array<Record<string, string | undefined>>) {
    const harness = open();
    seedCartLine(harness.db, 'products|lamp', 1);
    const quote = await freshQuote(harness.db, 'clerk_buyer', {
      source: 'cart',
      deliveryMethodId: 'deliveryMethods|m1',
      shippingAddress: ADDRESS,
    });
    const before = snapshot(harness.db);
    const unconfigured = createCheckoutCollectionAction({
      env: () => ({ ...env }),
      fetchImpl: harness.fetchImpl,
    });
    const code = await failureCode(
      unconfigured,
      actionCtx(harness, 'clerk_buyer'),
      checkoutArgs('req-noconfig', quote.quoteKey),
    );
    assert.equal(code, 'not_started');
    assert.deepEqual(snapshot(harness.db), before);
    assert.equal(harness.calls.length, 0);
  }
});

test('anonymous and unknown subjects are denied before recovery or config effects', async () => {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const args = checkoutArgs('req-nosubject', quote.quoteKey);
  const before = snapshot(harness.db);
  await assert.rejects(() => initiate(harness, null, args), /Unauthenticated|Unauthorized/);
  await assert.rejects(() => initiate(harness, 'clerk_missing', args), /not found|Unauthorized|Unauthenticated/);
  assert.deepEqual(snapshot(harness.db), before);
  assert.equal(harness.calls.length, 0);
});

test('duplicate owned request rows need review with no new writes or POST', async () => {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const first = okResult(await initiate(harness, 'clerk_buyer', checkoutArgs('req-dup-rows', quote.quoteKey)));
  tableRows(harness.db, 'paymentOperations').push({
    ...structuredClone(findRow(harness.db, 'paymentOperations', first.operationId)),
    _id: 'paymentOperations|dup',
  });
  const before = snapshot(harness.db);
  const code = await failureCode(
    actionOf(harness),
    actionCtx(harness, 'clerk_buyer'),
    checkoutArgs('req-dup-rows', quote.quoteKey),
  );
  assert.equal(code, 'review_needed');
  assert.deepEqual(snapshot(harness.db), before);
  assert.equal(harness.calls.length, 1);
});

test('a changed subject cannot persist another owner checkout', async () => {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const before = snapshot(harness.db);
  await assert.rejects(
    () =>
      invokeFakeFunction(checkoutCollection.persistAndClaimCheckout, createCtx(harness.db, 'clerk_other'), {
        expectedUserId: 'users|buyer',
        requestId: 'req-switch',
        source: 'cart',
        deliveryMethodId: 'deliveryMethods|m1',
        shippingAddress: ADDRESS,
        expectedQuoteKey: quote.quoteKey,
        phone: PHONE,
        operator: 'mtn',
      }),
    /Unauthorized/,
  );
  assert.deepEqual(snapshot(harness.db), before);
});

test('a checkout request id cannot be reused as a wallet purchase', async () => {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  seedWallet(harness.db);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  await initiate(harness, 'clerk_buyer', checkoutArgs('req-xkind', quote.quoteKey));
  const walletQuote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const before = snapshot(harness.db);
  assert.equal(
    await walletFailureCode(harness.db, 'clerk_buyer', {
      requestId: 'req-xkind',
      source: 'cart',
      deliveryMethodId: 'deliveryMethods|m1',
      shippingAddress: ADDRESS,
      expectedQuoteKey: walletQuote.quoteKey,
    }),
    'conflicting_reuse',
  );
  assert.deepEqual(snapshot(harness.db), before);
});

test('a pending order covered by checkout cannot be collected again', async () => {
  const harness = open();
  seedOrder(harness.db, 'orders|p1', 'users|buyer', 'users|seller', 'pending_payment', [lampItem(1)]);
  const pendingArgs = {
    source: 'pending_orders',
    orderIds: ['orders|p1'],
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  };
  const quote = await freshQuote(harness.db, 'clerk_buyer', pendingArgs);
  await initiate(
    harness,
    'clerk_buyer',
    checkoutArgs('req-pend-1', quote.quoteKey, { source: 'pending_orders', orderIds: ['orders|p1'] }),
  );
  const secondQuote = await freshQuote(harness.db, 'clerk_buyer', pendingArgs);
  const before = snapshot(harness.db);
  const code = await failureCode(
    actionOf(harness),
    actionCtx(harness, 'clerk_buyer'),
    checkoutArgs('req-pend-2', secondQuote.quoteKey, { source: 'pending_orders', orderIds: ['orders|p1'] }),
  );
  assert.equal(code, 'order_overlap');
  assert.deepEqual(snapshot(harness.db), before);
  assert.equal(harness.calls.length, 1);
});

test('direct legacy evidence blocks a second collection in every local status', async () => {
  for (const status of ['successful', 'failed', 'pending'] as const) {
    const harness = open();
    seedOrder(harness.db, 'orders|p1', 'users|buyer', 'users|seller', 'pending_payment', [lampItem(1)]);
    tableRows(harness.db, 'transactions').push({
      _id: `transactions|legacy-${status}`,
      orderId: 'orders|p1',
      userId: 'users|buyer',
      reference: `TXN-LEGACY-${status}`,
      type: 'collection',
      paymentMethod: 'mobile_money',
      amount: 1,
      currency: 'ZMW',
      status,
    });
    const quote = await freshQuote(harness.db, 'clerk_buyer', {
      source: 'pending_orders',
      orderIds: ['orders|p1'],
      deliveryMethodId: 'deliveryMethods|m1',
      shippingAddress: ADDRESS,
    });
    const before = snapshot(harness.db);
    const code = await failureCode(
      actionOf(harness),
      actionCtx(harness, 'clerk_buyer'),
      checkoutArgs(`req-evidence-${status}`, quote.quoteKey, {
        source: 'pending_orders',
        orderIds: ['orders|p1'],
      }),
    );
    assert.equal(code, 'evidence_review');
    assert.deepEqual(snapshot(harness.db), before);
    assert.equal(harness.calls.length, 0);
  }
});

test('aggregate owned metadata blocks while foreign metadata grants nothing', async () => {
  const blocked = open();
  seedOrder(blocked.db, 'orders|p1', 'users|buyer', 'users|seller', 'pending_payment', [lampItem(1)]);
  tableRows(blocked.db, 'transactions').push({
    _id: 'transactions|aggregate',
    userId: 'users|buyer',
    reference: 'TXN-AGG',
    type: 'collection',
    paymentMethod: 'mobile_money',
    amount: 1,
    currency: 'ZMW',
    status: 'successful',
    metadata: { checkoutOrderIds: ['orders|p1'] },
  });
  const blockedQuote = await freshQuote(blocked.db, 'clerk_buyer', {
    source: 'pending_orders',
    orderIds: ['orders|p1'],
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const blockedBefore = snapshot(blocked.db);
  assert.equal(
    await failureCode(
      actionOf(blocked),
      actionCtx(blocked, 'clerk_buyer'),
      checkoutArgs('req-agg', blockedQuote.quoteKey, {
        source: 'pending_orders',
        orderIds: ['orders|p1'],
      }),
    ),
    'evidence_review',
  );
  assert.deepEqual(snapshot(blocked.db), blockedBefore);
  assert.equal(blocked.calls.length, 0);

  // Foreign metadata naming the same order proves nothing about this checkout.
  const foreign = open();
  seedOrder(foreign.db, 'orders|p1', 'users|buyer', 'users|seller', 'pending_payment', [lampItem(1)]);
  tableRows(foreign.db, 'transactions').push({
    _id: 'transactions|foreign',
    userId: 'users|other',
    reference: 'TXN-FOREIGN',
    type: 'collection',
    paymentMethod: 'mobile_money',
    amount: 1,
    currency: 'ZMW',
    status: 'successful',
    metadata: { checkoutOrderIds: ['orders|p1'] },
  });
  const foreignQuote = await freshQuote(foreign.db, 'clerk_buyer', {
    source: 'pending_orders',
    orderIds: ['orders|p1'],
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const result = okResult(
    await initiate(
      foreign,
      'clerk_buyer',
      checkoutArgs('req-foreign-ok', foreignQuote.quoteKey, {
        source: 'pending_orders',
        orderIds: ['orders|p1'],
      }),
    ),
  );
  assert.equal(result.status, 'unknown');
});

test('an accepted checkout POST followed by a failing settle heals on reuse without a second POST', async () => {
  const harness = open();
  seedCartLine(harness.db, 'products|lamp', 1);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });
  const args = checkoutArgs('req-flaky-settle', quote.quoteKey);
  // Wrap only the unavoidable lost-response boundary: the accepted POST
  // receipt reaches the same settlement writer, which throws once before
  // executing for real on reuse.
  const real = providerSettlement.settleProviderReceipt;
  let settleShouldFail = true;
  const flakySettle = {
    ...real,
    _handler: async (ctx: unknown, innerArgs: unknown) => {
      if (settleShouldFail) {
        settleShouldFail = false;
        throw new Error('settle boundary exploded');
      }
      return await handlerOf<unknown, unknown>(real)(ctx, innerArgs);
    },
  };
  const modules = {
    checkoutCollection: { ...checkoutCollection },
    providerOperations: { ...providerOperations },
    providerSettlement: { settleProviderReceipt: flakySettle },
  };
  const flakyCtx = () => createFakeActionCtx({ db: harness.db, subject: 'clerk_buyer', modules });
  await assert.rejects(() => invokeFakeFunction(actionOf(harness), flakyCtx(), args), /settle boundary exploded/);

  // Intent, stock, companion, and reservation rows already committed: one
  // attempted operation, linked orders, one companion, one POST.
  const operations = tableRows(harness.db, 'paymentOperations');
  assert.equal(operations.length, 1);
  const stranded = operations[0] as Row;
  assert.equal(stranded['status'], 'attempted');
  const reference = stranded['providerReference'] as string;
  assert.ok(reference.startsWith('TXN-'));
  assert.equal(harness.calls.length, 1);
  for (const orderId of stranded['orderIds'] as string[]) {
    assert.equal(findRow(harness.db, 'orders', orderId)['operationId'], stranded['_id']);
  }
  assert.equal(tableRows(harness.db, 'transactions').filter((row) => row['operationId'] === stranded['_id']).length, 1);

  // The same request heals to unknown with no second POST or new rows.
  const healed = okResult(await invokeFakeFunction(actionOf(harness), flakyCtx(), args));
  assert.equal(healed.operationId, stranded['_id']);
  assert.equal(healed.status, 'unknown');
  assert.equal(healed.providerReference, reference);
  assert.equal(harness.calls.length, 1);
  assert.equal(tableRows(harness.db, 'paymentOperations').length, 1);
  assert.equal(findRow(harness.db, 'paymentOperations', stranded['_id'] as string)['status'], 'unknown');
});

test('promo readers agree on mixed statuses and global cap exhaustion', async () => {
  const harness = open();
  seedWallet(harness.db);
  findRow(harness.db, 'promoCodes', 'promoCodes|save10')['usageLimit'] = 5;
  findRow(harness.db, 'promoCodes', 'promoCodes|save10')['perUserLimit'] = 10;
  // Legacy-absent, unknown, and captured rows count (3 active); released
  // rows are ignored. Five raw rows already reach the cap of 5, so a naive
  // cardinality count would deny while the status-aware readers allow.
  tableRows(harness.db, 'promoCodeRedemptions').push(
    {
      _id: 'promoCodeRedemptions|legacy',
      promoCodeId: 'promoCodes|save10',
      userId: 'users|buyer',
      discountAmount: 5,
      redeemedAt: 1,
    },
    {
      _id: 'promoCodeRedemptions|mystery',
      promoCodeId: 'promoCodes|save10',
      userId: 'users|other',
      discountAmount: 5,
      redeemedAt: 1,
      status: 'mystery',
    },
    {
      _id: 'promoCodeRedemptions|captured',
      promoCodeId: 'promoCodes|save10',
      userId: 'users|other',
      discountAmount: 5,
      redeemedAt: 1,
      status: 'captured',
    },
    {
      _id: 'promoCodeRedemptions|rel-buyer',
      promoCodeId: 'promoCodes|save10',
      userId: 'users|buyer',
      discountAmount: 5,
      redeemedAt: 1,
      status: 'released',
    },
    {
      _id: 'promoCodeRedemptions|rel-other',
      promoCodeId: 'promoCodes|save10',
      userId: 'users|other',
      discountAmount: 5,
      redeemedAt: 1,
      status: 'released',
    },
  );
  const publicCheck = (await invokeFakeFunction(
    promotionsModule.validatePromoCode,
    createCtx(harness.db, 'clerk_buyer'),
    { code: 'SAVE10', subtotal: 200 },
  )) as { valid: boolean };
  assert.equal(publicCheck.valid, true);

  // The wallet recheck agrees: a wallet purchase with the promo succeeds,
  // consuming one more unit (absent status still counts).
  seedCartLine(harness.db, 'products|cap', 2);
  const walletQuote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
    promoCode: 'SAVE10',
  });
  const walletResult = (await invokeFakeFunction(
    walletOperations.purchaseWithWallet,
    createCtx(harness.db, 'clerk_buyer'),
    {
      requestId: 'req-promo-wallet',
      source: 'cart',
      deliveryMethodId: 'deliveryMethods|m1',
      shippingAddress: ADDRESS,
      promoCode: 'SAVE10',
      expectedQuoteKey: walletQuote.quoteKey,
    },
  )) as { ok: boolean };
  assert.equal(walletResult.ok, true);

  // The checkout recheck agrees too and reserves the fifth unit.
  seedCartLine(harness.db, 'products|lamp', 1);
  const approvedQuote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
    promoCode: 'SAVE10',
  });
  const checkoutResult = okResult(
    await initiate(
      harness,
      'clerk_buyer',
      checkoutArgs('req-promo-checkout', approvedQuote.quoteKey, { promoCode: 'SAVE10' }),
    ),
  );
  const operation = findRow(harness.db, 'paymentOperations', checkoutResult.operationId);
  const redemption = findRow(harness.db, 'promoCodeRedemptions', operation['promoRedemptionId'] as string);
  assert.equal(redemption['status'], 'reserved');
  assert.equal(harness.calls.length, 1);

  // Cap now exhausted (5 active): the public reader, the quote, the
  // checkout persist, and the wallet handler all deny.
  const deniedPublic = (await invokeFakeFunction(
    promotionsModule.validatePromoCode,
    createCtx(harness.db, 'clerk_buyer'),
    { code: 'SAVE10', subtotal: 200 },
  )) as { valid: boolean };
  assert.equal(deniedPublic.valid, false);
  const deniedQuote = (await invokeFakeFunction(checkoutQuote.quoteCheckout, createCtx(harness.db, 'clerk_buyer'), {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
    promoCode: 'SAVE10',
  })) as { ok: boolean; code?: string };
  assert.equal(deniedQuote.ok, false);
  assert.equal(deniedQuote.code, 'promo_invalid');
  const denyBefore = snapshot(harness.db);
  assert.equal(
    await failureCode(
      actionOf(harness),
      actionCtx(harness, 'clerk_buyer'),
      checkoutArgs('req-promo-deny', 'stale-key', { promoCode: 'SAVE10' }),
    ),
    'promo_invalid',
  );
  assert.deepEqual(snapshot(harness.db), denyBefore);
  assert.equal(harness.calls.length, 1);
  assert.equal(
    await walletFailureCode(harness.db, 'clerk_buyer', {
      requestId: 'req-promo-wallet-deny',
      source: 'cart',
      deliveryMethodId: 'deliveryMethods|m1',
      shippingAddress: ADDRESS,
      promoCode: 'SAVE10',
      expectedQuoteKey: 'stale-key',
    }),
    'promo_invalid',
  );
  assert.deepEqual(snapshot(harness.db), denyBefore);
});

test('promo readers agree on the per-user cap with released rows ignored', async () => {
  const harness = open();
  seedWallet(harness.db);
  findRow(harness.db, 'promoCodes', 'promoCodes|save10')['perUserLimit'] = 1;
  // The released buyer row is ignored, so the buyer starts at zero active
  // uses even though one raw buyer row exists.
  tableRows(harness.db, 'promoCodeRedemptions').push({
    _id: 'promoCodeRedemptions|rel-buyer',
    promoCodeId: 'promoCodes|save10',
    userId: 'users|buyer',
    discountAmount: 5,
    redeemedAt: 1,
    status: 'released',
  });
  const publicCheck = (await invokeFakeFunction(
    promotionsModule.validatePromoCode,
    createCtx(harness.db, 'clerk_buyer'),
    { code: 'SAVE10', subtotal: 200 },
  )) as { valid: boolean };
  assert.equal(publicCheck.valid, true);

  seedCartLine(harness.db, 'products|lamp', 1);
  const quote = await freshQuote(harness.db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
    promoCode: 'SAVE10',
  });
  okResult(
    await initiate(harness, 'clerk_buyer', checkoutArgs('req-promo-user', quote.quoteKey, { promoCode: 'SAVE10' })),
  );

  // The reserved usage exhausts the per-user cap of 1: every reader denies.
  const deniedPublic = (await invokeFakeFunction(
    promotionsModule.validatePromoCode,
    createCtx(harness.db, 'clerk_buyer'),
    { code: 'SAVE10', subtotal: 200 },
  )) as { valid: boolean };
  assert.equal(deniedPublic.valid, false);
  const deniedQuote = (await invokeFakeFunction(checkoutQuote.quoteCheckout, createCtx(harness.db, 'clerk_buyer'), {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
    promoCode: 'SAVE10',
  })) as { ok: boolean; code?: string };
  assert.equal(deniedQuote.ok, false);
  assert.equal(deniedQuote.code, 'promo_invalid');
  seedCartLine(harness.db, 'products|cap', 1);
  const denyBefore = snapshot(harness.db);
  assert.equal(
    await failureCode(
      actionOf(harness),
      actionCtx(harness, 'clerk_buyer'),
      checkoutArgs('req-promo-user-deny', 'stale-key', { promoCode: 'SAVE10' }),
    ),
    'promo_invalid',
  );
  assert.deepEqual(snapshot(harness.db), denyBefore);
  assert.equal(harness.calls.length, 1);
  assert.equal(
    await walletFailureCode(harness.db, 'clerk_buyer', {
      requestId: 'req-promo-user-wallet-deny',
      source: 'cart',
      deliveryMethodId: 'deliveryMethods|m1',
      shippingAddress: ADDRESS,
      promoCode: 'SAVE10',
      expectedQuoteKey: 'stale-key',
    }),
    'promo_invalid',
  );
  assert.deepEqual(snapshot(harness.db), denyBefore);
});
