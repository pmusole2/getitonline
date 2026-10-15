import assert from 'node:assert/strict';
import test from 'node:test';

import { ConvexError, convexToJson } from 'convex/values';

import * as checkoutQuote from './checkoutQuote';
import { majorNumberToCents } from './lib/catalogMoney';
import type { CheckoutQuote } from './lib/checkoutQuote';
import * as paymentOperations from './paymentOperations';
import { isPurchaseErrorData } from './lib/paymentOperationContracts';
import { invokeFakeFunction } from '../tests/support/convexFakeActionCtx';
import { createCtx, createDb, type Db, type Row, type Tables } from '../tests/support/convexFakeDb';

// End-to-end wallet purchase checks through the real registered mutation and
// owner query. Happy paths assert exact independently derived cents and full
// conservation; every denial proves zero writes by table snapshot. The fake
// cannot prove live OCC rollback, so the handler runs every check before
// its first write and the tests assert that ordering by snapshot.

const ADDRESS = {
  street: '123 Main',
  city: 'Lusaka',
  province: 'Lusaka',
  country: 'Zambia',
  phone: '0971234567',
};

type PurchaseOk = {
  ok: true;
  operationId: string;
  status: string;
  quoteKey: string;
  requestIdentity: string;
  totalAmountCents: number;
  orderIds: string[];
};

type PurchaseMismatch = {
  ok: false;
  code: string;
  quote: CheckoutQuote;
};

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

function walletRow(userId: string, extra: Record<string, unknown> = {}): Row {
  return {
    _id: `wallets|${userId}`,
    userId,
    balance: 1000,
    pendingBalance: 0,
    totalEarned: 1000,
    totalWithdrawn: 0,
    totalSpent: 0,
    isActive: true,
    isFrozen: false,
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
      productRow('products|tiny1', 'users|seller', {
        price: 0.1,
        quantity: 5,
        weightKg: 0,
        shippingOptions: [{ name: 'Free', price: 0 }],
      }),
      productRow('products|tiny2', 'users|seller2', {
        price: 0.1,
        quantity: 5,
        weightKg: 0,
        shippingOptions: [{ name: 'Free', price: 0 }],
      }),
      productRow('products|shirt', 'users|seller', {
        price: 20,
        quantity: 10,
        weightKg: 1,
        variantCombinations: [
          {
            id: 'c1',
            sku: 'SH-1',
            attributes: [{ name: 'Color', value: 'Red' }],
            price: 30,
            stock: 5,
            status: 'active',
          },
        ],
      }),
    ],
    cartItems: [],
    orders: [],
    escrow: [],
    transactions: [],
    walletTransactions: [],
    paymentOperations: [],
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
    wallets: [walletRow('users|buyer')],
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
      {
        _id: 'deliveryMethods|mtiny',
        zoneId: 'deliveryZones|z1',
        name: 'Tiny',
        code: 'TINY',
        type: 'standard',
        baseFee: 0.01,
        minDays: 1,
        maxDays: 1,
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

function open(): Db {
  return createDb(fixtureTables());
}

function snapshot(db: Db): Tables {
  return structuredClone(db.tables);
}

function cartArgs(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { source: 'cart', deliveryMethodId: 'deliveryMethods|m1', shippingAddress: ADDRESS, ...extra };
}

function purchaseArgs(requestId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { requestId, ...cartArgs(), expectedQuoteKey: '', ...extra };
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

async function purchase(db: Db, clerkId: string | null, args: Record<string, unknown>): Promise<unknown> {
  return await invokeFakeFunction(paymentOperations.purchaseWithWallet, createCtx(db, clerkId), args);
}

function okResult(result: unknown): PurchaseOk {
  const parsed = result as PurchaseOk;
  if (parsed.ok !== true) {
    throw new Error(`expected a successful purchase, got ${(result as PurchaseMismatch).code}`);
  }
  return parsed;
}

function mismatchResult(result: unknown): PurchaseMismatch {
  const parsed = result as PurchaseMismatch;
  if (parsed.ok !== false) {
    throw new Error('expected a quote_mismatch');
  }
  return parsed;
}

async function purchaseFailureCode(db: Db, clerkId: string | null, args: Record<string, unknown>): Promise<string> {
  try {
    const result = await purchase(db, clerkId, args);
    const parsed = result as { ok: boolean; code?: string };
    if (parsed.ok === false && parsed.code) {
      return parsed.code;
    }
    throw new Error('expected the purchase to fail');
  } catch (error) {
    if (error instanceof Error && 'code' in error && typeof (error as { code: unknown }).code === 'string') {
      return (error as { code: string }).code;
    }
    throw error;
  }
}

function seedCartLine(db: Db, productId: string, quantity: number, extra: Record<string, unknown> = {}): string {
  const rows = db.tables.cartItems;
  assert.ok(rows, 'cartItems table must exist');
  const id = `cartItems|seed${rows.length + 1}`;
  rows.push({
    _id: id,
    userId: 'users|buyer',
    productId,
    quantity,
    selectedShipping: { name: 'Courier', price: 50 },
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  });
  return id;
}

function lampItem(quantity: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    productId: 'products|lamp',
    title: 'Stale title',
    price: 0.01,
    quantity,
    image: 'https://images.invalid/stale.jpg',
    ...extra,
  };
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

function findRow(db: Db, table: string, id: string): Row {
  const row = db.tables[table]?.find((candidate) => candidate._id === id);
  assert.ok(row, `${id} must exist in ${table}`);
  return row;
}

function tableRows(db: Db, table: string): Row[] {
  return db.tables[table] ?? [];
}

type OrderItemView = {
  title: string;
  price: number;
  productId: string;
  quantity: number;
};

function orderItems(row: Row): OrderItemView[] {
  return row['items'] as OrderItemView[];
}

function centsOf(major: unknown): number {
  if (typeof major !== 'number') {
    throw new Error(`stored money must be a number, got ${typeof major}`);
  }
  const cents = majorNumberToCents(major);
  assert.ok(cents !== null, `stored major ${String(major)} must round-trip exactly`);
  return cents;
}

// ---- Request validation: public args carry no money authority ----

test('client money, seller, and actor fields are rejected by validation with no writes', async () => {
  const db = open();
  seedCartLine(db, 'products|lamp', 1);
  const quote = await freshQuote(db, 'clerk_buyer', cartArgs());
  const base = purchaseArgs('req-validation', { expectedQuoteKey: quote.quoteKey });

  const before = snapshot(db);
  await assert.rejects(() => purchase(db, 'clerk_buyer', { ...base, subtotal: 1 }), /Argument validation failed/);
  await assert.rejects(() => purchase(db, 'clerk_buyer', { ...base, totalAmount: 1 }), /Argument validation failed/);
  await assert.rejects(
    () => purchase(db, 'clerk_buyer', { ...base, sellerId: 'users|seller' }),
    /Argument validation failed/,
  );
  await assert.rejects(
    () => purchase(db, 'clerk_buyer', { ...base, userId: 'users|other' }),
    /Argument validation failed/,
  );
  await assert.rejects(
    () => purchase(db, 'clerk_buyer', { ...base, expectedQuoteKey: undefined }),
    /Argument validation failed/,
  );
  assert.deepEqual(db.tables, before);
});

test('blank request ids are invalid requests with no writes', async () => {
  const db = open();
  seedCartLine(db, 'products|lamp', 1);
  const quote = await freshQuote(db, 'clerk_buyer', cartArgs());

  const before = snapshot(db);
  assert.equal(
    await purchaseFailureCode(db, 'clerk_buyer', purchaseArgs('  ', { expectedQuoteKey: quote.quoteKey })),
    'invalid_request',
  );
  assert.equal(
    await purchaseFailureCode(db, 'clerk_buyer', purchaseArgs('', { expectedQuoteKey: quote.quoteKey })),
    'invalid_request',
  );
  assert.deepEqual(db.tables, before);
});

// ---- Identity: denials happen before any read or write ----

test('anonymous, banned, deleted, and unknown callers are denied with no writes', async () => {
  const db = open();
  seedCartLine(db, 'products|lamp', 1);
  const quote = await freshQuote(db, 'clerk_buyer', cartArgs());
  const args = purchaseArgs('req-identity', { expectedQuoteKey: quote.quoteKey });

  const before = snapshot(db);
  await assert.rejects(() => purchase(db, null, args), /Unauthenticated/);
  await assert.rejects(() => purchase(db, 'clerk_banned', args), /banned/);
  await assert.rejects(() => purchase(db, 'clerk_deleted', args), /deleted/);
  await assert.rejects(() => purchase(db, 'clerk_missing', args), /not found/);
  assert.deepEqual(db.tables, before);
});

test('staff cannot spend another buyer’s pending orders', async () => {
  const db = open();
  seedOrder(db, 'orders|mine', 'users|buyer', 'users|seller', 'pending_payment', [lampItem(1)]);
  const quote = await freshQuote(db, 'clerk_buyer', {
    source: 'pending_orders',
    orderIds: ['orders|mine'],
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });

  const before = snapshot(db);
  assert.equal(
    await purchaseFailureCode(db, 'clerk_admin', {
      requestId: 'req-staff-spoof',
      source: 'pending_orders',
      orderIds: ['orders|mine'],
      deliveryMethodId: 'deliveryMethods|m1',
      shippingAddress: ADDRESS,
      expectedQuoteKey: quote.quoteKey,
    }),
    'order_not_owned',
  );
  assert.deepEqual(db.tables, before);
});

// ---- Switch and stale keys ----

test('a missing or off payment switch blocks with no writes', async () => {
  const noConfig = open();
  seedCartLine(noConfig, 'products|lamp', 1);
  noConfig.tables.appConfig = [];
  assert.equal(
    await purchaseFailureCode(noConfig, 'clerk_buyer', purchaseArgs('req-no-config', { expectedQuoteKey: 'x' })),
    'payments_disabled',
  );

  const switchedOff = open();
  seedCartLine(switchedOff, 'products|lamp', 1);
  findRow(switchedOff, 'appConfig', 'appConfig|1').paymentsEnabled = false;
  const before = snapshot(switchedOff);
  assert.equal(
    await purchaseFailureCode(switchedOff, 'clerk_buyer', purchaseArgs('req-off', { expectedQuoteKey: 'x' })),
    'payments_disabled',
  );
  assert.deepEqual(switchedOff.tables, before);
});

test('a stale expected key returns the fresh owned quote with zero writes', async () => {
  const db = open();
  seedCartLine(db, 'products|lamp', 1);
  const quote = await freshQuote(db, 'clerk_buyer', cartArgs());

  const before = snapshot(db);
  const stale = mismatchResult(
    await purchase(db, 'clerk_buyer', purchaseArgs('req-stale', { expectedQuoteKey: 'wrong' })),
  );
  assert.equal(stale.code, 'quote_mismatch');
  assert.equal(stale.quote.quoteKey, quote.quoteKey);
  assert.deepEqual(db.tables, before);
});

// ---- Happy path: one combined debit, all escrows, exact conservation ----

test('a two-seller cart purchase debits once and conserves every cent', async () => {
  const db = open();
  seedCartLine(db, 'products|lamp', 2);
  seedCartLine(db, 'products|cap', 1);
  seedCartLine(db, 'products|lamp', 1, { userId: 'users|other' });
  const quote = await freshQuote(db, 'clerk_buyer', cartArgs());
  assert.equal(quote.subtotalCents, 21000);
  assert.equal(quote.shippingCents, 6500);
  assert.equal(quote.platformFeeCents, 1050);
  assert.equal(quote.totalAmountCents, 28550);

  const result = okResult(
    await purchase(db, 'clerk_buyer', purchaseArgs('req-happy', { expectedQuoteKey: quote.quoteKey })),
  );
  assert.equal(result.status, 'succeeded');
  assert.equal(result.totalAmountCents, 28550);
  assert.equal(result.quoteKey, quote.quoteKey);
  assert.equal(result.orderIds.length, 2);

  const orders = result.orderIds.map((orderId) => findRow(db, 'orders', orderId));
  for (const order of orders) {
    assert.equal(order.status, 'paid');
    assert.equal(order.buyerId, 'users|buyer');
  }
  const sellers = orders.map((order) => order.sellerId).sort();
  assert.deepEqual(sellers, ['users|seller', 'users|seller2']);

  const escrows = tableRows(db, 'escrow');
  assert.equal(escrows.length, 2);
  let escrowTotal = 0;
  for (const escrow of escrows) {
    const order = findRow(db, 'orders', escrow.orderId as string);
    assert.equal(escrow.status, 'held');
    assert.equal(escrow.grossAmount, order.totalAmount);
    assert.equal(escrow.amount, order.totalAmount);
    assert.equal(escrow.sellerAmount, order.sellerPayout);
    assert.equal(escrow.platformFee, order.platformFee);
    escrowTotal += centsOf(escrow.grossAmount);
  }
  assert.equal(escrowTotal, 28550);

  const wallet = findRow(db, 'wallets', 'wallets|users|buyer');
  assert.equal(centsOf(wallet.balance), 100000 - 28550);
  assert.equal(centsOf(wallet.totalSpent), 28550);

  const ledger = tableRows(db, 'walletTransactions');
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0]?.type, 'debit');
  assert.equal(ledger[0]?.source, 'purchase');
  assert.equal(ledger[0]?.status, 'completed');
  assert.match(String(ledger[0]?.reference), /^WLT-/);
  assert.equal(centsOf(ledger[0]?.amount), 28550);
  assert.equal(centsOf(ledger[0]?.balanceAfter), 100000 - 28550);

  const operations = tableRows(db, 'paymentOperations');
  assert.equal(operations.length, 1);
  const operation = operations[0];
  assert.equal(operation?.kind, 'wallet_purchase');
  assert.equal(operation?.status, 'succeeded');
  assert.equal(operation?.ownerId, 'users|buyer');
  assert.equal(operation?.requestId, 'req-happy');
  assert.equal(operation?.quoteKey, quote.quoteKey);
  assert.equal(operation?.totalAmountCents, 28550);
  assert.match(String(operation?.requestIdentity), /^[0-9a-f]{64}$/);
  assert.equal(result.operationId, operation?._id);
  for (const order of orders) {
    assert.equal(order.operationId, operation?._id);
  }
  for (const escrow of escrows) {
    assert.equal(escrow.operationId, operation?._id);
  }
  assert.equal(ledger[0]?.operationId, operation?._id);

  assert.equal(tableRows(db, 'cartItems').length, 1);
  assert.equal(tableRows(db, 'cartItems')[0]?.userId, 'users|other');

  const purchases = tableRows(db, 'behaviorEvents').filter((event) => event.eventType === 'purchase');
  assert.equal(purchases.length, 2);

  const notices = tableRows(db, 'notifications');
  assert.equal(notices.length, 5);

  assert.equal(findRow(db, 'products', 'products|lamp').quantity, 8);
  assert.equal(findRow(db, 'products', 'products|cap').quantity, 99);
});

test('tiny two-seller values conserve a one-cent fee', async () => {
  const db = open();
  seedCartLine(db, 'products|tiny1', 1);
  seedCartLine(db, 'products|tiny2', 1);
  const quote = await freshQuote(db, 'clerk_buyer', {
    source: 'cart',
    deliveryMethodId: 'deliveryMethods|mtiny',
    shippingAddress: ADDRESS,
  });
  assert.equal(quote.subtotalCents, 20);
  assert.equal(quote.totalAmountCents, 22);

  const result = okResult(
    await purchase(
      db,
      'clerk_buyer',
      purchaseArgs('req-tiny', { deliveryMethodId: 'deliveryMethods|mtiny', expectedQuoteKey: quote.quoteKey }),
    ),
  );
  assert.equal(result.totalAmountCents, 22);
  const escrows = tableRows(db, 'escrow');
  assert.equal(escrows.length, 2);
  assert.equal(
    escrows.reduce((sum, escrow) => sum + centsOf(escrow.grossAmount), 0),
    22,
  );
  assert.equal(centsOf(findRow(db, 'wallets', 'wallets|users|buyer').balance), 100000 - 22);
});

// ---- Pending source: rows retained, same-seller split, stock untouched ----

test('two pending orders from one seller split exactly with no stock move', async () => {
  const db = open();
  seedOrder(db, 'orders|o1', 'users|buyer', 'users|seller', 'pending_payment', [lampItem(1)]);
  seedOrder(db, 'orders|o2', 'users|buyer', 'users|seller', 'pending_payment', [lampItem(1)]);
  seedOrder(db, 'orders|o3', 'users|buyer', 'users|seller2', 'pending_payment', [
    {
      productId: 'products|cap',
      title: 'Stale cap',
      price: 0.01,
      quantity: 1,
      image: 'https://images.invalid/stale.jpg',
    },
  ]);
  const selectors = {
    source: 'pending_orders',
    orderIds: ['orders|o1', 'orders|o2', 'orders|o3'],
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  };
  const quote = await freshQuote(db, 'clerk_buyer', selectors);
  assert.equal(quote.totalAmountCents, 28550);

  const result = okResult(
    await purchase(db, 'clerk_buyer', { requestId: 'req-pending', ...selectors, expectedQuoteKey: quote.quoteKey }),
  );
  assert.deepEqual([...result.orderIds].sort(), ['orders|o1', 'orders|o2', 'orders|o3']);
  assert.equal(tableRows(db, 'orders').length, 3);

  const first = findRow(db, 'orders', 'orders|o1');
  const second = findRow(db, 'orders', 'orders|o2');
  const third = findRow(db, 'orders', 'orders|o3');
  assert.equal(first.status, 'paid');
  assert.equal(second.status, 'paid');
  assert.equal(third.status, 'paid');
  // Canonical facts refresh stale cached money and titles.
  assert.equal(orderItems(first)[0]?.title, 'Title products|lamp');
  assert.equal(centsOf(orderItems(first)[0]?.price), 10000);
  // Neither same-seller order copies the whole seller total.
  const sellerTotal = centsOf(first.totalAmount) + centsOf(second.totalAmount);
  assert.equal(sellerTotal, 27190);
  assert.ok(centsOf(first.totalAmount) < sellerTotal);
  assert.ok(centsOf(second.totalAmount) < sellerTotal);
  assert.equal(centsOf(first.totalAmount) + centsOf(second.totalAmount) + centsOf(third.totalAmount), 28550);

  const operations = tableRows(db, 'paymentOperations');
  assert.equal(operations.length, 1);
  const breakdowns = (operations[0]?.orderBreakdowns ?? []) as Array<{ orderId: string; totalAmountCents: number }>;
  assert.equal(breakdowns.length, 3);
  assert.equal(
    breakdowns.reduce((sum, breakdown) => sum + breakdown.totalAmountCents, 0),
    28550,
  );

  assert.equal(tableRows(db, 'escrow').length, 3);
  assert.equal(findRow(db, 'products', 'products|lamp').quantity, 10);
  assert.equal(findRow(db, 'products', 'products|cap').quantity, 100);
  assert.equal(tableRows(db, 'behaviorEvents').filter((event) => event.eventType === 'purchase').length, 0);
});

test('cart decrements aggregate and combo stock once; pending never does', async () => {
  const cartDb = open();
  seedCartLine(cartDb, 'products|shirt', 2, {
    selectedVariant: { variantId: 'c1', sku: 'SH-1', attributes: [], price: 30 },
  });
  const cartQuote = await freshQuote(cartDb, 'clerk_buyer', cartArgs());
  const cartResult = okResult(
    await purchase(cartDb, 'clerk_buyer', purchaseArgs('req-stock-cart', { expectedQuoteKey: cartQuote.quoteKey })),
  );
  assert.equal(cartResult.orderIds.length, 1);
  assert.equal(findRow(cartDb, 'products', 'products|shirt').quantity, 8);
  const combos = findRow(cartDb, 'products', 'products|shirt').variantCombinations as Array<{
    id: string;
    stock: number;
    status: string;
  }>;
  assert.equal(combos.find((combo) => combo.id === 'c1')?.stock, 3);

  const pendingDb = open();
  seedOrder(pendingDb, 'orders|po1', 'users|buyer', 'users|seller', 'pending_payment', [
    lampItem(2, {
      productId: 'products|shirt',
      selectedVariant: { variantId: 'c1', sku: 'SH-1', attributes: [], price: 30 },
    }),
  ]);
  const selectors = {
    source: 'pending_orders',
    orderIds: ['orders|po1'],
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  };
  const pendingQuote = await freshQuote(pendingDb, 'clerk_buyer', selectors);
  const pendingResult = okResult(
    await purchase(pendingDb, 'clerk_buyer', {
      requestId: 'req-stock-pending',
      ...selectors,
      expectedQuoteKey: pendingQuote.quoteKey,
    }),
  );
  assert.equal(pendingResult.orderIds.length, 1);
  assert.equal(findRow(pendingDb, 'products', 'products|shirt').quantity, 10);
  const kept = findRow(pendingDb, 'products', 'products|shirt').variantCombinations as Array<{
    id: string;
    stock: number;
  }>;
  assert.equal(kept.find((combo) => combo.id === 'c1')?.stock, 5);
});

// ---- Wallet denials: zero writes ----

test('insufficient, frozen, inactive, and malformed wallets deny with zero writes', async () => {
  const poor = open();
  seedCartLine(poor, 'products|lamp', 1);
  const poorQuote = await freshQuote(poor, 'clerk_buyer', cartArgs());
  findRow(poor, 'wallets', 'wallets|users|buyer').balance = 1;
  const poorBefore = snapshot(poor);
  assert.equal(
    await purchaseFailureCode(poor, 'clerk_buyer', purchaseArgs('req-poor', { expectedQuoteKey: poorQuote.quoteKey })),
    'insufficient_funds',
  );
  assert.deepEqual(poor.tables, poorBefore);

  const frozen = open();
  seedCartLine(frozen, 'products|lamp', 1);
  const frozenQuote = await freshQuote(frozen, 'clerk_buyer', cartArgs());
  findRow(frozen, 'wallets', 'wallets|users|buyer').isFrozen = true;
  const frozenBefore = snapshot(frozen);
  assert.equal(
    await purchaseFailureCode(
      frozen,
      'clerk_buyer',
      purchaseArgs('req-frozen', { expectedQuoteKey: frozenQuote.quoteKey }),
    ),
    'wallet_frozen',
  );
  assert.deepEqual(frozen.tables, frozenBefore);

  const inactive = open();
  seedCartLine(inactive, 'products|lamp', 1);
  const inactiveQuote = await freshQuote(inactive, 'clerk_buyer', cartArgs());
  findRow(inactive, 'wallets', 'wallets|users|buyer').isActive = false;
  const inactiveBefore = snapshot(inactive);
  assert.equal(
    await purchaseFailureCode(
      inactive,
      'clerk_buyer',
      purchaseArgs('req-inactive', { expectedQuoteKey: inactiveQuote.quoteKey }),
    ),
    'wallet_inactive',
  );
  assert.deepEqual(inactive.tables, inactiveBefore);

  const malformed = open();
  seedCartLine(malformed, 'products|lamp', 1);
  const malformedQuote = await freshQuote(malformed, 'clerk_buyer', cartArgs());
  findRow(malformed, 'wallets', 'wallets|users|buyer').balance = 10.001;
  const malformedBefore = snapshot(malformed);
  assert.equal(
    await purchaseFailureCode(
      malformed,
      'clerk_buyer',
      purchaseArgs('req-malformed', { expectedQuoteKey: malformedQuote.quoteKey }),
    ),
    'wallet_malformed',
  );
  assert.deepEqual(malformed.tables, malformedBefore);

  const missing = open();
  seedCartLine(missing, 'products|lamp', 1);
  const missingQuote = await freshQuote(missing, 'clerk_buyer', cartArgs());
  missing.tables.wallets = [];
  const missingBefore = snapshot(missing);
  assert.equal(
    await purchaseFailureCode(
      missing,
      'clerk_buyer',
      purchaseArgs('req-missing', { expectedQuoteKey: missingQuote.quoteKey }),
    ),
    'wallet_missing',
  );
  assert.deepEqual(missing.tables, missingBefore);
});

// ---- Idempotency and recovery ----

test('the same request recovers after cart clear, switch off, freeze, and reprice', async () => {
  const db = open();
  seedCartLine(db, 'products|lamp', 1);
  const quote = await freshQuote(db, 'clerk_buyer', cartArgs());
  const args = purchaseArgs('req-recover', { expectedQuoteKey: quote.quoteKey });
  const first = okResult(await purchase(db, 'clerk_buyer', args));

  db.tables.cartItems = [];
  findRow(db, 'appConfig', 'appConfig|1').paymentsEnabled = false;
  findRow(db, 'wallets', 'wallets|users|buyer').isFrozen = true;
  findRow(db, 'products', 'products|lamp').price = 9999;

  const before = snapshot(db);
  const second = okResult(await purchase(db, 'clerk_buyer', args));
  assert.deepEqual(second, first);
  assert.deepEqual(db.tables, before);
});

test('the same request id with different inputs or key rejects as conflicting', async () => {
  const db = open();
  seedCartLine(db, 'products|lamp', 1);
  const quote = await freshQuote(db, 'clerk_buyer', cartArgs());
  const args = purchaseArgs('req-conflict', { expectedQuoteKey: quote.quoteKey });
  okResult(await purchase(db, 'clerk_buyer', args));

  const before = snapshot(db);
  assert.equal(await purchaseFailureCode(db, 'clerk_buyer', { ...args, promoCode: 'SAVE10' }), 'conflicting_reuse');
  assert.equal(
    await purchaseFailureCode(db, 'clerk_buyer', { ...args, shippingAddress: { ...ADDRESS, city: 'Kitwe' } }),
    'conflicting_reuse',
  );
  assert.equal(
    await purchaseFailureCode(db, 'clerk_buyer', { ...args, expectedQuoteKey: 'wrong' }),
    'conflicting_reuse',
  );
  assert.equal(tableRows(db, 'paymentOperations').length, 1);
  assert.deepEqual(db.tables, before);
});

test('duplicate operation rows need review instead of returning one', async () => {
  const db = open();
  seedCartLine(db, 'products|lamp', 1);
  const quote = await freshQuote(db, 'clerk_buyer', cartArgs());
  for (let index = 0; index < 2; index++) {
    tableRows(db, 'paymentOperations').push({
      _id: `paymentOperations|dup${index}`,
      ownerId: 'users|buyer',
      requestId: 'req-duplicate',
      kind: 'wallet_purchase',
      status: 'succeeded',
      source: 'cart',
      requestIdentity: 'dupe',
      quoteKey: quote.quoteKey,
      quoteSnapshot: quote,
      orderBreakdowns: [],
      orderIds: [],
      totalAmountCents: quote.totalAmountCents,
      walletReference: `WLT-DUP${index}`,
      debitAmountCents: quote.totalAmountCents,
      walletBalanceAfterCents: 0,
      accountingAppliedAt: 1,
      createdAt: 1,
      updatedAt: 1,
    });
  }

  const before = snapshot(db);
  assert.equal(
    await purchaseFailureCode(db, 'clerk_buyer', purchaseArgs('req-duplicate', { expectedQuoteKey: quote.quoteKey })),
    'review_needed',
  );
  assert.deepEqual(db.tables, before);
});

// ---- Overlaps and legacy evidence ----

test('foreign, paid, and escrowed orders cannot be spent again', async () => {
  const db = open();
  seedOrder(db, 'orders|theirs', 'users|other', 'users|seller', 'pending_payment', [lampItem(1)]);
  seedOrder(db, 'orders|paid', 'users|buyer', 'users|seller', 'paid', [lampItem(1)]);
  seedOrder(db, 'orders|held', 'users|buyer', 'users|seller', 'pending_payment', [lampItem(1)]);
  tableRows(db, 'escrow').push({
    _id: 'escrow|held',
    orderId: 'orders|held',
    buyerId: 'users|buyer',
    sellerId: 'users|seller',
    grossAmount: 1,
    platformFee: 0,
    sellerAmount: 1,
    amount: 1,
    status: 'held',
    createdAt: 1,
    updatedAt: 1,
  });
  const selectors = (orderIds: string[]): Record<string, unknown> => ({
    source: 'pending_orders',
    orderIds,
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });

  const before = snapshot(db);
  assert.equal(
    await purchaseFailureCode(db, 'clerk_buyer', {
      requestId: 'req-foreign',
      ...selectors(['orders|theirs']),
      expectedQuoteKey: 'x',
    }),
    'order_not_owned',
  );
  assert.equal(
    await purchaseFailureCode(db, 'clerk_buyer', {
      requestId: 'req-paid',
      ...selectors(['orders|paid']),
      expectedQuoteKey: 'x',
    }),
    'order_not_pending',
  );
  const heldQuote = await freshQuote(db, 'clerk_buyer', selectors(['orders|held']));
  assert.equal(
    await purchaseFailureCode(db, 'clerk_buyer', {
      requestId: 'req-held',
      ...selectors(['orders|held']),
      expectedQuoteKey: heldQuote.quoteKey,
    }),
    'order_overlap',
  );
  assert.deepEqual(db.tables, before);
});

test('a new request cannot spend an order paid by an earlier operation', async () => {
  const db = open();
  seedCartLine(db, 'products|lamp', 1);
  const quote = await freshQuote(db, 'clerk_buyer', cartArgs());
  const first = okResult(
    await purchase(db, 'clerk_buyer', purchaseArgs('req-first', { expectedQuoteKey: quote.quoteKey })),
  );

  const selectors = {
    source: 'pending_orders',
    orderIds: first.orderIds,
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  };
  const pendingQuote = await freshQuote(db, 'clerk_buyer', selectors).catch(() => null);
  assert.equal(pendingQuote, null);
  const before = snapshot(db);
  assert.equal(
    await purchaseFailureCode(db, 'clerk_buyer', { requestId: 'req-second', ...selectors, expectedQuoteKey: 'x' }),
    'order_not_pending',
  );
  assert.deepEqual(db.tables, before);
});

test('unclear legacy provider evidence needs review in every local status', async () => {
  const blocked = open();
  seedOrder(blocked, 'orders|o1', 'users|buyer', 'users|seller', 'pending_payment', [lampItem(1)]);
  tableRows(blocked, 'transactions').push({
    _id: 'transactions|legacy',
    orderId: 'orders|o1',
    userId: 'users|buyer',
    reference: 'TXN-LEGACY',
    type: 'collection',
    paymentMethod: 'mobile_money',
    amount: 1,
    currency: 'ZMW',
    status: 'successful',
    initiatedAt: 1,
    createdAt: 1,
    updatedAt: 1,
  });
  const selectors = {
    source: 'pending_orders',
    orderIds: ['orders|o1'],
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  };
  const blockedQuote = await freshQuote(blocked, 'clerk_buyer', selectors);
  const blockedBefore = snapshot(blocked);
  assert.equal(
    await purchaseFailureCode(blocked, 'clerk_buyer', {
      requestId: 'req-evidence',
      ...selectors,
      expectedQuoteKey: blockedQuote.quoteKey,
    }),
    'evidence_review',
  );
  assert.deepEqual(blocked.tables, blockedBefore);

  // A bare local failed label is not a validated matching receipt, so it
  // gates reconciliation instead of authorizing a second debit.
  const failed = open();
  seedOrder(failed, 'orders|o1', 'users|buyer', 'users|seller', 'pending_payment', [lampItem(1)]);
  tableRows(failed, 'transactions').push({
    _id: 'transactions|failed',
    orderId: 'orders|o1',
    userId: 'users|buyer',
    reference: 'TXN-FAILED',
    type: 'collection',
    paymentMethod: 'mobile_money',
    amount: 1,
    currency: 'ZMW',
    status: 'failed',
    initiatedAt: 1,
    createdAt: 1,
    updatedAt: 1,
  });
  const failedQuote = await freshQuote(failed, 'clerk_buyer', selectors);
  const failedBefore = snapshot(failed);
  assert.equal(
    await purchaseFailureCode(failed, 'clerk_buyer', {
      requestId: 'req-after-failure',
      ...selectors,
      expectedQuoteKey: failedQuote.quoteKey,
    }),
    'evidence_review',
  );
  assert.deepEqual(failed.tables, failedBefore);

  const cancelled = open();
  seedOrder(cancelled, 'orders|o1', 'users|buyer', 'users|seller', 'pending_payment', [lampItem(1)]);
  tableRows(cancelled, 'walletTransactions').push({
    _id: 'walletTransactions|cancelled',
    walletId: 'wallets|users|buyer',
    orderId: 'orders|o1',
    userId: 'users|buyer',
    type: 'debit',
    source: 'purchase',
    amount: 1,
    balanceAfter: 999,
    reference: 'WLT-CANCELLED',
    status: 'cancelled',
    description: 'Cancelled legacy ledger row.',
    createdAt: 1,
    updatedAt: 1,
  });
  const cancelledQuote = await freshQuote(cancelled, 'clerk_buyer', selectors);
  const cancelledBefore = snapshot(cancelled);
  assert.equal(
    await purchaseFailureCode(cancelled, 'clerk_buyer', {
      requestId: 'req-after-cancel',
      ...selectors,
      expectedQuoteKey: cancelledQuote.quoteKey,
    }),
    'evidence_review',
  );
  assert.deepEqual(cancelled.tables, cancelledBefore);
});

// ---- Discounts captured once ----

test('promo and effective loyalty are captured exactly once', async () => {
  const db = open();
  seedCartLine(db, 'products|lamp', 2);
  seedCartLine(db, 'products|cap', 1);
  const selectors = cartArgs({ promoCode: 'save10', loyaltyPoints: 50 });
  const quote = await freshQuote(db, 'clerk_buyer', selectors);
  assert.equal(quote.promo?.discountCents, 2100);
  assert.equal(quote.loyalty?.points, 50);
  assert.equal(quote.loyalty?.discountCents, 500);

  const result = okResult(
    await purchase(db, 'clerk_buyer', { requestId: 'req-discounts', ...selectors, expectedQuoteKey: quote.quoteKey }),
  );
  assert.equal(result.totalAmountCents, quote.totalAmountCents);

  const redemptions = tableRows(db, 'promoCodeRedemptions');
  assert.equal(redemptions.length, 1);
  assert.equal(centsOf(redemptions[0]?.discountAmount), 2100);
  assert.equal(redemptions[0]?.operationId, result.operationId);

  const account = findRow(db, 'loyaltyAccounts', 'loyaltyAccounts|buyer');
  assert.equal(account.pointsBalance, 50);
  assert.equal(account.lifetimeRedeemed, 50);
  const loyaltyTxns = tableRows(db, 'loyaltyTransactions');
  assert.equal(loyaltyTxns.length, 1);
  assert.equal(loyaltyTxns[0]?.points, 50);
  assert.equal(loyaltyTxns[0]?.type, 'redeem');
  assert.equal(loyaltyTxns[0]?.operationId, result.operationId);
});

test('exhausted promo counters deny with no writes', async () => {
  const db = open();
  seedCartLine(db, 'products|lamp', 1);
  tableRows(db, 'promoCodeRedemptions').push({
    _id: 'promoCodeRedemptions|used',
    promoCodeId: 'promoCodes|save10',
    userId: 'users|buyer',
    discountAmount: 1,
    redeemedAt: 1,
  });
  findRow(db, 'promoCodes', 'promoCodes|save10').perUserLimit = 1;

  const before = snapshot(db);
  assert.equal(
    await purchaseFailureCode(
      db,
      'clerk_buyer',
      purchaseArgs('req-limit', { promoCode: 'SAVE10', expectedQuoteKey: 'x' }),
    ),
    'promo_invalid',
  );
  assert.deepEqual(db.tables, before);
});

// ---- Owner recovery query ----

test('getMine exposes the owner projection and hides everything else', async () => {
  const db = open();
  seedCartLine(db, 'products|lamp', 1);
  const quote = await freshQuote(db, 'clerk_buyer', cartArgs());
  const result = okResult(
    await purchase(db, 'clerk_buyer', purchaseArgs('req-mine', { expectedQuoteKey: quote.quoteKey })),
  );

  const projection = (await invokeFakeFunction(paymentOperations.getMine, createCtx(db, 'clerk_buyer'), {
    operationId: result.operationId,
  })) as Record<string, unknown>;
  assert.equal(projection.operationId, result.operationId);
  assert.equal(projection.kind, 'wallet_purchase');
  assert.equal(projection.status, 'succeeded');
  assert.equal(projection.totalAmountCents, result.totalAmountCents);
  assert.equal(projection.quoteKey, quote.quoteKey);
  assert.deepEqual(projection.orderIds, result.orderIds);
  assert.match(String(projection.walletReference), /^WLT-/);
  assert.equal(projection.quoteSnapshot, undefined);
  assert.equal(projection.shippingAddress, undefined);

  await assert.rejects(
    () =>
      invokeFakeFunction(paymentOperations.getMine, createCtx(db, 'clerk_other'), { operationId: result.operationId }),
    /Unauthorized/,
  );
  await assert.rejects(
    () =>
      invokeFakeFunction(paymentOperations.getMine, createCtx(db, 'clerk_admin'), { operationId: result.operationId }),
    /Unauthorized/,
  );
  await assert.rejects(
    () => invokeFakeFunction(paymentOperations.getMine, createCtx(db, null), { operationId: result.operationId }),
    /Unauthenticated/,
  );

  const missing = (await invokeFakeFunction(paymentOperations.getMine, createCtx(db, 'clerk_buyer'), {
    operationId: 'paymentOperations|missing',
  })) as null;
  assert.equal(missing, null);

  await assert.rejects(
    () => invokeFakeFunction(paymentOperations.getMine, createCtx(db, 'clerk_buyer'), { operationId: 'orders|o1' }),
    /Argument validation failed/,
  );
});

// ---- Correction wave: money bound by identity, not sorted positions ----

type BreakdownView = {
  orderId: string;
  sellerId: string;
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

function breakdownsOf(db: Db, operationId: string): BreakdownView[] {
  const operation = findRow(db, 'paymentOperations', operationId);
  return (operation['orderBreakdowns'] ?? []) as BreakdownView[];
}

function breakdownFor(db: Db, operationId: string, orderId: string): BreakdownView {
  const breakdown = breakdownsOf(db, operationId).find((candidate) => candidate.orderId === orderId);
  assert.ok(breakdown, `breakdown for ${orderId} must exist`);
  return breakdown;
}

function escrowFor(db: Db, orderId: string): Row {
  const escrow = tableRows(db, 'escrow').find((candidate) => candidate['orderId'] === orderId);
  assert.ok(escrow, `escrow for ${orderId} must exist`);
  return escrow;
}

function capItem(quantity: number): Record<string, unknown> {
  return {
    productId: 'products|cap',
    title: 'Stale cap',
    price: 0.01,
    quantity,
    image: 'https://images.invalid/stale.jpg',
  };
}

function pendingSelectors(orderIds: string[]): Record<string, unknown> {
  return {
    source: 'pending_orders',
    orderIds,
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  };
}

function assertMoneyTriple(
  db: Db,
  operationId: string,
  orderId: string,
  expectedSellerId: string,
  expectedSubtotalCents: number,
): void {
  const breakdown = breakdownFor(db, operationId, orderId);
  assert.equal(breakdown.sellerId, expectedSellerId);
  assert.equal(breakdown.subtotalCents, expectedSubtotalCents);
  const order = findRow(db, 'orders', orderId);
  assert.equal(order['sellerId'], expectedSellerId);
  assert.equal(order['status'], 'paid');
  const escrow = escrowFor(db, orderId);
  assert.equal(escrow['status'], 'held');
  assert.equal(escrow['sellerId'], expectedSellerId);
  assert.equal(escrow['grossAmount'], order['totalAmount']);
  assert.equal(escrow['amount'], order['totalAmount']);
  assert.equal(escrow['sellerAmount'], order['sellerPayout']);
  assert.equal(escrow['platformFee'], order['platformFee']);
  assert.equal(centsOf(escrow['grossAmount']), breakdown.totalAmountCents);
  assert.equal(centsOf(escrow['sellerAmount']), breakdown.sellerPayoutCents);
  assert.equal(centsOf(escrow['platformFee']), breakdown.platformFeeCents);
  assert.equal(centsOf(order['totalAmount']), breakdown.totalAmountCents);
  assert.equal(escrow['operationId'], operationId);
}

test('adversarial pending ids keep every money triple on its own order', async () => {
  const db = open();
  seedOrder(db, 'orders|z-low', 'users|buyer', 'users|seller', 'pending_payment', [lampItem(1)]);
  seedOrder(db, 'orders|a-high', 'users|buyer', 'users|seller2', 'pending_payment', [capItem(1)]);
  const selectors = pendingSelectors(['orders|z-low', 'orders|a-high']);
  const quote = await freshQuote(db, 'clerk_buyer', selectors);

  const result = okResult(
    await purchase(db, 'clerk_buyer', { requestId: 'req-adv-ids', ...selectors, expectedQuoteKey: quote.quoteKey }),
  );
  // Stored order ids stay sorted, but money must follow identity, not position.
  assert.deepEqual([...result.orderIds].sort(), ['orders|a-high', 'orders|z-low']);
  assertMoneyTriple(db, result.operationId, 'orders|z-low', 'users|seller', 10000);
  assertMoneyTriple(db, result.operationId, 'orders|a-high', 'users|seller2', 1000);
  const low = breakdownFor(db, result.operationId, 'orders|z-low');
  const high = breakdownFor(db, result.operationId, 'orders|a-high');
  assert.ok(low.totalAmountCents !== high.totalAmountCents, 'unequal checkouts must stay unequal');
  assert.equal(low.totalAmountCents + high.totalAmountCents, result.totalAmountCents);
});

test('cart-created opaque ids bind money by identity, not lex order', async () => {
  const db = open();
  seedCartLine(db, 'products|lamp', 1);
  seedCartLine(db, 'products|cap', 1);
  const quote = await freshQuote(db, 'clerk_buyer', cartArgs());

  // Production ids are opaque: the first-created order sorts last here.
  const rawInsert = db.insert.bind(db);
  const opaqueIds = ['orders|zz-cart-second', 'orders|aa-cart-first'];
  let next = 0;
  db.insert = async (table: string, value: Record<string, unknown>): Promise<string> => {
    if (table === 'orders' && next < opaqueIds.length) {
      const id = opaqueIds[next];
      assert.ok(id, 'opaque id must exist');
      next += 1;
      db.tables[table] = [...(db.tables[table] ?? []), { _id: id, ...value }];
      return id;
    }
    return await rawInsert(table, value);
  };

  const result = okResult(
    await purchase(db, 'clerk_buyer', purchaseArgs('req-opaque-cart', { expectedQuoteKey: quote.quoteKey })),
  );
  assert.deepEqual([...result.orderIds].sort(), ['orders|aa-cart-first', 'orders|zz-cart-second']);
  assertMoneyTriple(db, result.operationId, 'orders|zz-cart-second', 'users|seller', 10000);
  assertMoneyTriple(db, result.operationId, 'orders|aa-cart-first', 'users|seller2', 1000);
});

test('mixed same-seller pending orders split exactly beside an adversarial seller', async () => {
  const db = open();
  seedOrder(db, 'orders|z-a1', 'users|buyer', 'users|seller', 'pending_payment', [lampItem(1)]);
  seedOrder(db, 'orders|z-a2', 'users|buyer', 'users|seller', 'pending_payment', [lampItem(2)]);
  seedOrder(db, 'orders|a-b1', 'users|buyer', 'users|seller2', 'pending_payment', [capItem(1)]);
  const selectors = pendingSelectors(['orders|z-a1', 'orders|z-a2', 'orders|a-b1']);
  const quote = await freshQuote(db, 'clerk_buyer', selectors);

  const result = okResult(
    await purchase(db, 'clerk_buyer', { requestId: 'req-mixed', ...selectors, expectedQuoteKey: quote.quoteKey }),
  );
  assertMoneyTriple(db, result.operationId, 'orders|z-a1', 'users|seller', 10000);
  assertMoneyTriple(db, result.operationId, 'orders|z-a2', 'users|seller', 20000);
  assertMoneyTriple(db, result.operationId, 'orders|a-b1', 'users|seller2', 1000);
  const first = breakdownFor(db, result.operationId, 'orders|z-a1');
  const second = breakdownFor(db, result.operationId, 'orders|z-a2');
  assert.ok(first.totalAmountCents !== second.totalAmountCents, 'same-seller unequal orders must stay unequal');
  assert.ok(first.totalAmountCents < first.totalAmountCents + second.totalAmountCents);
  assert.ok(second.totalAmountCents < first.totalAmountCents + second.totalAmountCents);
  assert.equal(
    first.totalAmountCents +
      second.totalAmountCents +
      breakdownFor(db, result.operationId, 'orders|a-b1').totalAmountCents,
    result.totalAmountCents,
  );
});

// ---- Correction wave: every owned legacy evidence shape blocks ----

const EVIDENCE_STATUSES = ['pending', 'processing', 'successful', 'failed', 'cancelled', 'refunded'];

function seedDirectTransaction(db: Db, id: string, status: string, userId: string): void {
  tableRows(db, 'transactions').push({
    _id: id,
    orderId: 'orders|o1',
    userId,
    reference: id,
    type: 'collection',
    paymentMethod: 'mobile_money',
    amount: 1,
    currency: 'ZMW',
    status,
    initiatedAt: 1,
    createdAt: 1,
    updatedAt: 1,
  });
}

function seedDirectLedger(db: Db, id: string, status: string, userId: string): void {
  tableRows(db, 'walletTransactions').push({
    _id: id,
    walletId: 'wallets|users|buyer',
    orderId: 'orders|o1',
    userId,
    type: 'debit',
    source: 'purchase',
    amount: 1,
    balanceAfter: 999,
    reference: id,
    status,
    description: 'Legacy ledger row.',
    createdAt: 1,
    updatedAt: 1,
  });
}

function seedAggregateRow(db: Db, table: string, id: string, status: string, metadata: unknown): void {
  const row: Row =
    table === 'transactions'
      ? {
          _id: id,
          userId: 'users|buyer',
          reference: id,
          type: 'collection',
          paymentMethod: 'mobile_money',
          amount: 1,
          currency: 'ZMW',
          status,
          initiatedAt: 1,
          createdAt: 1,
          updatedAt: 1,
        }
      : {
          _id: id,
          walletId: 'wallets|users|buyer',
          userId: 'users|buyer',
          type: 'debit',
          source: 'purchase',
          amount: 1,
          balanceAfter: 999,
          reference: id,
          status,
          description: 'Legacy aggregate ledger row.',
          createdAt: 1,
          updatedAt: 1,
        };
  row['metadata'] = metadata;
  const rows = db.tables[table];
  assert.ok(rows, `${table} table must exist`);
  rows.push(row);
}

test('all owned legacy evidence shapes block in every local status', async () => {
  const selectors = pendingSelectors(['orders|o1']);
  const shapes: Array<{ name: string; seed: (db: Db, status: string) => void }> = [
    { name: 'tx-direct', seed: (db, status) => seedDirectTransaction(db, 'transactions|e', status, 'users|buyer') },
    {
      name: 'ledger-direct',
      seed: (db, status) => seedDirectLedger(db, 'walletTransactions|e', status, 'users|buyer'),
    },
    {
      name: 'tx-aggregate',
      seed: (db, status) =>
        seedAggregateRow(db, 'transactions', 'transactions|agg', status, { checkoutOrderIds: ['orders|o1'] }),
    },
    {
      name: 'ledger-aggregate',
      seed: (db, status) =>
        seedAggregateRow(db, 'walletTransactions', 'walletTransactions|agg', status, {
          checkoutOrderIds: ['orders|o1'],
        }),
    },
    {
      name: 'tx-legacy-orderIds',
      seed: (db, status) =>
        seedAggregateRow(db, 'transactions', 'transactions|leg', status, { orderIds: ['orders|o1'] }),
    },
    {
      name: 'ledger-legacy-orderIds',
      seed: (db, status) =>
        seedAggregateRow(db, 'walletTransactions', 'walletTransactions|leg', status, { orderIds: ['orders|o1'] }),
    },
  ];
  for (const shape of shapes) {
    for (const status of EVIDENCE_STATUSES) {
      const db = open();
      seedOrder(db, 'orders|o1', 'users|buyer', 'users|seller', 'pending_payment', [lampItem(1)]);
      shape.seed(db, status);
      const quote = await freshQuote(db, 'clerk_buyer', selectors);
      const before = snapshot(db);
      assert.equal(
        await purchaseFailureCode(db, 'clerk_buyer', {
          requestId: `req-evidence-${shape.name}-${status}`,
          ...selectors,
          expectedQuoteKey: quote.quoteKey,
        }),
        'evidence_review',
        `${shape.name} with status ${status} must block`,
      );
      assert.deepEqual(db.tables, before, `${shape.name} with status ${status} must write nothing`);
    }
  }

  // Malformed owned metadata that visibly names the order fails closed.
  for (const [name, metadata] of [
    ['string-names-order', 'legacy attempt for orders|o1 pending'],
    ['scalar-names-order', { checkoutOrderIds: 'orders|o1' }],
  ] as Array<[string, unknown]>) {
    const db = open();
    seedOrder(db, 'orders|o1', 'users|buyer', 'users|seller', 'pending_payment', [lampItem(1)]);
    seedAggregateRow(db, 'transactions', 'transactions|malformed', 'pending', metadata);
    const quote = await freshQuote(db, 'clerk_buyer', selectors);
    const before = snapshot(db);
    assert.equal(
      await purchaseFailureCode(db, 'clerk_buyer', {
        requestId: `req-evidence-malformed-${name}`,
        ...selectors,
        expectedQuoteKey: quote.quoteKey,
      }),
      'evidence_review',
      `malformed ${name} must block`,
    );
    assert.deepEqual(db.tables, before);
  }

  // A directly linked row from another account is still conflicting evidence.
  const foreign = open();
  seedOrder(foreign, 'orders|o1', 'users|buyer', 'users|seller', 'pending_payment', [lampItem(1)]);
  seedDirectTransaction(foreign, 'transactions|foreign', 'pending', 'users|other');
  const foreignQuote = await freshQuote(foreign, 'clerk_buyer', selectors);
  const foreignBefore = snapshot(foreign);
  assert.equal(
    await purchaseFailureCode(foreign, 'clerk_buyer', {
      requestId: 'req-evidence-foreign-direct',
      ...selectors,
      expectedQuoteKey: foreignQuote.quoteKey,
    }),
    'evidence_review',
  );
  assert.deepEqual(foreign.tables, foreignBefore);

  // Unrelated rows never block: a foreign aggregate naming our orders is not
  // funding proof, and another buyer's own order evidence is irrelevant.
  const clean = open();
  seedOrder(clean, 'orders|o1', 'users|buyer', 'users|seller', 'pending_payment', [lampItem(1)]);
  tableRows(clean, 'transactions').push({
    _id: 'transactions|foreign-meta',
    userId: 'users|other',
    reference: 'TXN-FOREIGN-META',
    type: 'collection',
    paymentMethod: 'mobile_money',
    amount: 1,
    currency: 'ZMW',
    status: 'pending',
    metadata: { checkoutOrderIds: ['orders|o1'] },
    initiatedAt: 1,
    createdAt: 1,
    updatedAt: 1,
  });
  seedOrder(clean, 'orders|unrelated', 'users|other', 'users|seller', 'pending_payment', [lampItem(1)]);
  seedDirectTransaction(clean, 'transactions|unrelated', 'failed', 'users|other');
  findRow(clean, 'transactions', 'transactions|unrelated')['orderId'] = 'orders|unrelated';
  const cleanQuote = await freshQuote(clean, 'clerk_buyer', selectors);
  const cleanResult = okResult(
    await purchase(clean, 'clerk_buyer', {
      requestId: 'req-evidence-clean',
      ...selectors,
      expectedQuoteKey: cleanQuote.quoteKey,
    }),
  );
  assert.equal(cleanResult.orderIds.length, 1);
});

// ---- Correction wave: the frozen operation links the exact debit row ----

test('the operation persists the exact debit ledger id end to end', async () => {
  const db = open();
  seedCartLine(db, 'products|lamp', 1);
  const quote = await freshQuote(db, 'clerk_buyer', cartArgs());
  const args = purchaseArgs('req-ledger-link', { expectedQuoteKey: quote.quoteKey });
  const result = okResult(await purchase(db, 'clerk_buyer', args));
  const withLedger = result as PurchaseOk & { walletTransactionId: string };
  assert.match(withLedger.walletTransactionId, /^walletTransactions\|/);

  const operation = findRow(db, 'paymentOperations', result.operationId);
  assert.equal(operation['walletTransactionId'], withLedger.walletTransactionId);
  const ledger = findRow(db, 'walletTransactions', withLedger.walletTransactionId);
  assert.equal(ledger['userId'], 'users|buyer');
  assert.equal(ledger['type'], 'debit');
  assert.equal(ledger['source'], 'purchase');
  assert.equal(ledger['status'], 'completed');
  assert.equal(ledger['operationId'], result.operationId);
  assert.equal(centsOf(ledger['amount']), result.totalAmountCents);
  assert.match(String(ledger['reference']), /^WLT-/);

  const projection = (await invokeFakeFunction(paymentOperations.getMine, createCtx(db, 'clerk_buyer'), {
    operationId: result.operationId,
  })) as Record<string, unknown>;
  assert.equal(projection['walletTransactionId'], withLedger.walletTransactionId);

  const before = snapshot(db);
  const recovered = (await purchase(db, 'clerk_buyer', args)) as PurchaseOk & { walletTransactionId: string };
  assert.equal(recovered.operationId, result.operationId);
  assert.equal(recovered.walletTransactionId, withLedger.walletTransactionId);
  assert.deepEqual(db.tables, before);

  // A missing link on recovery fails to review instead of inferring funding.
  const missing = open();
  seedCartLine(missing, 'products|lamp', 1);
  const missingQuote = await freshQuote(missing, 'clerk_buyer', cartArgs());
  const missingArgs = purchaseArgs('req-ledger-missing', { expectedQuoteKey: missingQuote.quoteKey });
  const first = okResult(await purchase(missing, 'clerk_buyer', missingArgs));
  const stored = findRow(missing, 'paymentOperations', first.operationId);
  delete stored['walletTransactionId'];
  missing.tables['walletTransactions'] = [];
  assert.equal(await purchaseFailureCode(missing, 'clerk_buyer', missingArgs), 'review_needed');

  // A conflicting link on recovery fails to review as well.
  const conflict = open();
  seedCartLine(conflict, 'products|lamp', 1);
  const conflictQuote = await freshQuote(conflict, 'clerk_buyer', cartArgs());
  const conflictArgs = purchaseArgs('req-ledger-conflict', { expectedQuoteKey: conflictQuote.quoteKey });
  const paid = okResult(await purchase(conflict, 'clerk_buyer', conflictArgs));
  const paidLedgerId = (paid as PurchaseOk & { walletTransactionId: string }).walletTransactionId;
  findRow(conflict, 'walletTransactions', paidLedgerId)['operationId'] = 'paymentOperations|elsewhere';
  assert.equal(await purchaseFailureCode(conflict, 'clerk_buyer', conflictArgs), 'review_needed');
});

// ---- Correction wave: cart cleanup compares canonical selectors ----

test('an unchanged customized row is removed even when cart and quote keys differ', async () => {
  const db = open();
  // Combination products price the variant and ignore stored option pairs,
  // so the cart key carries variants=Color:Red while the quote key is empty.
  const cartKey = 'products|shirt::variant=c1::variants=Color:Red::addons=';
  seedCartLine(db, 'products|shirt', 1, {
    selectedVariant: { variantId: 'c1', sku: 'SH-1', attributes: [{ name: 'Color', value: 'Red' }], price: 30 },
    selectedVariantOptions: [{ name: 'Color', value: 'Red' }],
    customizationKey: cartKey,
  });
  seedCartLine(db, 'products|cap', 1);
  const quote = await freshQuote(db, 'clerk_buyer', cartArgs());
  const quoted = quote.lines.find((line) => line.productId === 'products|shirt');
  assert.ok(quoted, 'shirt line must be quoted');
  assert.equal(quoted?.customizationKey, 'products|shirt::variant=c1::variants=::addons=');
  assert.notEqual(cartKey, quoted?.customizationKey);

  const result = okResult(
    await purchase(db, 'clerk_buyer', purchaseArgs('req-cleanup-keys', { expectedQuoteKey: quote.quoteKey })),
  );
  assert.equal(result.orderIds.length, 2);
  assert.equal(tableRows(db, 'cartItems').length, 0);
});

test('a changed row with a stale key mismatches with zero writes', async () => {
  const db = open();
  const combos = findRow(db, 'products', 'products|shirt')['variantCombinations'] as Array<Record<string, unknown>>;
  combos.push({
    id: 'c2',
    sku: 'SH-2',
    attributes: [{ name: 'Color', value: 'Blue' }],
    price: 35,
    stock: 5,
    status: 'active',
  });
  seedCartLine(db, 'products|shirt', 1, {
    selectedVariant: { variantId: 'c1', sku: 'SH-1', attributes: [{ name: 'Color', value: 'Red' }], price: 30 },
    customizationKey: 'products|shirt::variant=c1::variants=::addons=',
  });
  const quote = await freshQuote(db, 'clerk_buyer', cartArgs());

  // The buyer edits the variant after approving the quote; the stale key no
  // longer matches the fresh catalog facts.
  const row = tableRows(db, 'cartItems')[0];
  assert.ok(row, 'cart row must exist');
  row['selectedVariant'] = { variantId: 'c2', sku: 'SH-2', attributes: [{ name: 'Color', value: 'Blue' }], price: 35 };
  row['customizationKey'] = 'products|shirt::variant=c2::variants=::addons=';

  const before = snapshot(db);
  const stale = mismatchResult(
    await purchase(db, 'clerk_buyer', purchaseArgs('req-cleanup-changed', { expectedQuoteKey: quote.quoteKey })),
  );
  assert.equal(stale.code, 'quote_mismatch');
  assert.deepEqual(db.tables, before);
  assert.equal(tableRows(db, 'cartItems').length, 1);
});

// ---- Correction round 2: captured cart cleanup uses a pre-write raw snapshot ----

test('a required add-on added by the quote still cleans up the captured row', async () => {
  const db = open();
  // The stored row names no add-ons; the current catalog requires one, so the
  // approved quote canonically includes it while the raw row still shows [].
  const lamp = findRow(db, 'products', 'products|lamp');
  lamp['addOns'] = [{ name: 'Gift wrap', price: 5, isRequired: true }];
  seedCartLine(db, 'products|lamp', 1);
  const quote = await freshQuote(db, 'clerk_buyer', cartArgs());
  const quoted = quote.lines.find((line) => line.productId === 'products|lamp');
  assert.ok(quoted, 'lamp line must be quoted');
  assert.deepEqual(
    quoted?.addOns.map((addOn) => addOn.name),
    ['Gift wrap'],
  );

  const args = purchaseArgs('req-cleanup-addon', { expectedQuoteKey: quote.quoteKey });
  const result = okResult(await purchase(db, 'clerk_buyer', args));
  assert.equal(result.totalAmountCents, quote.totalAmountCents);
  assert.equal(result.quoteKey, quote.quoteKey);
  assert.equal(result.orderIds.length, 1);

  const order = findRow(db, 'orders', result.orderIds[0] as string);
  assert.equal(order.status, 'paid');
  assert.equal(order.buyerId, 'users|buyer');
  assert.equal(order.sellerId, 'users|seller');
  const items = orderItems(order);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.productId, 'products|lamp');
  assert.equal(items[0]?.quantity, 1);
  assert.equal(centsOf(items[0]?.price), quoted?.unitCents);

  const escrow = tableRows(db, 'escrow');
  assert.equal(escrow.length, 1);
  assert.equal(escrow[0]?.orderId, order._id);
  assert.equal(escrow[0]?.grossAmount, order.totalAmount);
  assert.equal(centsOf(order.totalAmount), quote.totalAmountCents);

  const wallet = findRow(db, 'wallets', 'wallets|users|buyer');
  assert.equal(centsOf(wallet.balance), 100000 - quote.totalAmountCents);
  const ledger = tableRows(db, 'walletTransactions');
  assert.equal(ledger.length, 1);
  assert.equal(centsOf(ledger[0]?.amount), quote.totalAmountCents);

  // The unchanged captured row is gone even though raw [] differed from the
  // canonical required names.
  assert.equal(tableRows(db, 'cartItems').length, 0);

  // Same-request recovery returns the stored result with no new writes.
  const before = snapshot(db);
  const recovered = okResult(await purchase(db, 'clerk_buyer', args));
  assert.equal(recovered.operationId, result.operationId);
  assert.deepEqual(db.tables, before);

  // A later fresh cart with a new request is not stranded by leftover IDs.
  // The follow-up row carries a fresh fake id: production ids never repeat,
  // while the seed helper would otherwise reuse the deleted row's id.
  seedCartLine(db, 'products|cap', 1, { _id: 'cartItems|addon-next' });
  const next = await freshQuote(db, 'clerk_buyer', cartArgs());
  const following = okResult(
    await purchase(db, 'clerk_buyer', purchaseArgs('req-cleanup-addon-next', { expectedQuoteKey: next.quoteKey })),
  );
  assert.equal(following.totalAmountCents, next.totalAmountCents);
  assert.equal(tableRows(db, 'cartItems').length, 0);
});

test('a unique SKU fallback still cleans up the captured row', async () => {
  const db = open();
  // The stored variant id is retired but its SKU uniquely matches the current
  // combination, so the quote resolves the canonical id while the raw row
  // still shows the retired id.
  const shirt = findRow(db, 'products', 'products|shirt');
  shirt['variantCombinations'] = [
    {
      id: 'current',
      sku: 'SH-1',
      attributes: [{ name: 'Color', value: 'Red' }],
      price: 30,
      stock: 5,
      status: 'active',
    },
  ];
  seedCartLine(db, 'products|shirt', 1, {
    selectedVariant: { variantId: 'retired', sku: 'SH-1', attributes: [], price: 30 },
  });
  const quote = await freshQuote(db, 'clerk_buyer', cartArgs());
  const quoted = quote.lines.find((line) => line.productId === 'products|shirt');
  assert.ok(quoted, 'shirt line must be quoted');
  assert.equal(quoted?.variant?.variantId, 'current');

  const args = purchaseArgs('req-cleanup-sku', { expectedQuoteKey: quote.quoteKey });
  const result = okResult(await purchase(db, 'clerk_buyer', args));
  assert.equal(result.totalAmountCents, quote.totalAmountCents);
  assert.equal(result.orderIds.length, 1);

  const order = findRow(db, 'orders', result.orderIds[0] as string);
  assert.equal(order.status, 'paid');
  const items = orderItems(order);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.quantity, 1);
  assert.equal(centsOf(items[0]?.price), quoted?.unitCents);
  const storedVariant = items[0] as unknown as {
    selectedVariant?: { variantId: string; sku: string };
  };
  assert.equal(storedVariant.selectedVariant?.variantId, 'current');
  assert.equal(storedVariant.selectedVariant?.sku, 'SH-1');

  const wallet = findRow(db, 'wallets', 'wallets|users|buyer');
  assert.equal(centsOf(wallet.balance), 100000 - quote.totalAmountCents);

  assert.equal(tableRows(db, 'cartItems').length, 0);

  const before = snapshot(db);
  const recovered = okResult(await purchase(db, 'clerk_buyer', args));
  assert.equal(recovered.operationId, result.operationId);
  assert.deepEqual(db.tables, before);

  seedCartLine(db, 'products|cap', 1, { _id: 'cartItems|sku-next' });
  const next = await freshQuote(db, 'clerk_buyer', cartArgs());
  const following = okResult(
    await purchase(db, 'clerk_buyer', purchaseArgs('req-cleanup-sku-next', { expectedQuoteKey: next.quoteKey })),
  );
  assert.equal(following.totalAmountCents, next.totalAmountCents);
  assert.equal(tableRows(db, 'cartItems').length, 0);
});

test('a product default-shipping fallback still cleans up the captured row', async () => {
  const db = open();
  // No delivery method serves this address, so the quote falls back to the
  // first product shipping option while the stored row keeps its own name.
  const remote = { ...ADDRESS, city: 'Ndola', province: 'Copperbelt' };
  const selectors = { source: 'cart', shippingAddress: remote };
  seedCartLine(db, 'products|lamp', 1, { selectedShipping: { name: 'Legacy Post', price: 1 } });
  const quote = await freshQuote(db, 'clerk_buyer', selectors);
  assert.equal(quote.delivery.methodType, 'product_fallback');
  const quoted = quote.lines.find((line) => line.productId === 'products|lamp');
  assert.ok(quoted, 'lamp line must be quoted');
  assert.equal(quoted?.fallbackShipping?.name, 'Courier');

  const args = { requestId: 'req-cleanup-ship', ...selectors, expectedQuoteKey: quote.quoteKey };
  const result = okResult(await purchase(db, 'clerk_buyer', args));
  assert.equal(result.totalAmountCents, quote.totalAmountCents);
  assert.equal(result.orderIds.length, 1);

  const order = findRow(db, 'orders', result.orderIds[0] as string);
  assert.equal(order.status, 'paid');
  assert.equal(centsOf(order.totalAmount), quote.totalAmountCents);

  const wallet = findRow(db, 'wallets', 'wallets|users|buyer');
  assert.equal(centsOf(wallet.balance), 100000 - quote.totalAmountCents);

  assert.equal(tableRows(db, 'cartItems').length, 0);

  const before = snapshot(db);
  const recovered = okResult(await purchase(db, 'clerk_buyer', args));
  assert.equal(recovered.operationId, result.operationId);
  assert.deepEqual(db.tables, before);
});

// ---- Correction wave: the whole requested pending set preflights first ----

test('a valid order beside an empty owned pending order rejects with no writes', async () => {
  const db = open();
  seedOrder(db, 'orders|z-low', 'users|buyer', 'users|seller', 'pending_payment', []);
  seedOrder(db, 'orders|a-high', 'users|buyer', 'users|seller2', 'pending_payment', [capItem(1)]);
  const selectors = pendingSelectors(['orders|z-low', 'orders|a-high']);
  const quote = await freshQuote(db, 'clerk_buyer', selectors);

  const before = snapshot(db);
  assert.equal(
    await purchaseFailureCode(db, 'clerk_buyer', {
      requestId: 'req-empty-sibling',
      ...selectors,
      expectedQuoteKey: quote.quoteKey,
    }),
    'malformed_catalog',
  );
  assert.deepEqual(db.tables, before);
  assert.equal(findRow(db, 'orders', 'orders|a-high')['status'], 'pending_payment');
  assert.equal(findRow(db, 'orders', 'orders|z-low')['status'], 'pending_payment');
});

// ---- Correction wave: business failures cross the SDK as typed data ----

async function purchaseErrorData(db: Db, clerkId: string | null, args: Record<string, unknown>): Promise<string> {
  try {
    await purchase(db, clerkId, args);
  } catch (error) {
    assert.ok(error instanceof ConvexError, 'business denials must cross the SDK as ConvexError data');
    const data: unknown = error.data;
    assert.ok(isPurchaseErrorData(data), 'denial data must match the typed purchase error shape');
    assert.equal(typeof data.message, 'string');
    convexToJson(data);
    return data.code;
  }
  throw new Error('expected the purchase to fail');
}

test('business denials carry typed ConvexError data instead of redacted errors', async () => {
  const disabled = open();
  seedCartLine(disabled, 'products|lamp', 1);
  findRow(disabled, 'appConfig', 'appConfig|1').paymentsEnabled = false;
  assert.equal(
    await purchaseErrorData(disabled, 'clerk_buyer', purchaseArgs('req-sdk-off', { expectedQuoteKey: 'x' })),
    'payments_disabled',
  );

  const frozen = open();
  seedCartLine(frozen, 'products|lamp', 1);
  const frozenQuote = await freshQuote(frozen, 'clerk_buyer', cartArgs());
  findRow(frozen, 'wallets', 'wallets|users|buyer').isFrozen = true;
  assert.equal(
    await purchaseErrorData(
      frozen,
      'clerk_buyer',
      purchaseArgs('req-sdk-frozen', { expectedQuoteKey: frozenQuote.quoteKey }),
    ),
    'wallet_frozen',
  );

  const poor = open();
  seedCartLine(poor, 'products|lamp', 1);
  const poorQuote = await freshQuote(poor, 'clerk_buyer', cartArgs());
  findRow(poor, 'wallets', 'wallets|users|buyer').balance = 1;
  assert.equal(
    await purchaseErrorData(
      poor,
      'clerk_buyer',
      purchaseArgs('req-sdk-poor', { expectedQuoteKey: poorQuote.quoteKey }),
    ),
    'insufficient_funds',
  );

  const evidence = open();
  seedOrder(evidence, 'orders|o1', 'users|buyer', 'users|seller', 'pending_payment', [lampItem(1)]);
  seedDirectTransaction(evidence, 'transactions|sdk', 'failed', 'users|buyer');
  const evidenceQuote = await freshQuote(evidence, 'clerk_buyer', pendingSelectors(['orders|o1']));
  assert.equal(
    await purchaseErrorData(evidence, 'clerk_buyer', {
      requestId: 'req-sdk-evidence',
      ...pendingSelectors(['orders|o1']),
      expectedQuoteKey: evidenceQuote.quoteKey,
    }),
    'evidence_review',
  );

  const conflict = open();
  seedCartLine(conflict, 'products|lamp', 1);
  const conflictQuote = await freshQuote(conflict, 'clerk_buyer', cartArgs());
  const conflictArgs = purchaseArgs('req-sdk-conflict', { expectedQuoteKey: conflictQuote.quoteKey });
  okResult(await purchase(conflict, 'clerk_buyer', conflictArgs));
  assert.equal(
    await purchaseErrorData(conflict, 'clerk_buyer', { ...conflictArgs, promoCode: 'SAVE10' }),
    'conflicting_reuse',
  );

  const overlap = open();
  seedOrder(overlap, 'orders|o1', 'users|buyer', 'users|seller', 'pending_payment', [lampItem(1)]);
  tableRows(overlap, 'paymentOperations').push({
    _id: 'paymentOperations|cover',
    ownerId: 'users|buyer',
    requestId: 'req-cover',
    orderIds: ['orders|o1'],
  });
  const overlapQuote = await freshQuote(overlap, 'clerk_buyer', pendingSelectors(['orders|o1']));
  assert.equal(
    await purchaseErrorData(overlap, 'clerk_buyer', {
      requestId: 'req-sdk-overlap',
      ...pendingSelectors(['orders|o1']),
      expectedQuoteKey: overlapQuote.quoteKey,
    }),
    'order_overlap',
  );

  const duplicate = open();
  seedCartLine(duplicate, 'products|lamp', 1);
  const duplicateQuote = await freshQuote(duplicate, 'clerk_buyer', cartArgs());
  for (let index = 0; index < 2; index++) {
    tableRows(duplicate, 'paymentOperations').push({
      _id: `paymentOperations|sdkdup${index}`,
      ownerId: 'users|buyer',
      requestId: 'req-sdk-duplicate',
      orderIds: [],
    });
  }
  assert.equal(
    await purchaseErrorData(
      duplicate,
      'clerk_buyer',
      purchaseArgs('req-sdk-duplicate', { expectedQuoteKey: duplicateQuote.quoteKey }),
    ),
    'review_needed',
  );

  // The stale-key path still returns its fresh quote value, and identity
  // guards keep their existing plain behavior.
  const staleDb = open();
  seedCartLine(staleDb, 'products|lamp', 1);
  await freshQuote(staleDb, 'clerk_buyer', cartArgs());
  const stale = mismatchResult(
    await purchase(staleDb, 'clerk_buyer', purchaseArgs('req-sdk-stale', { expectedQuoteKey: 'wrong' })),
  );
  assert.equal(stale.code, 'quote_mismatch');
  await assert.rejects(
    () => purchase(staleDb, null, purchaseArgs('req-sdk-anon', { expectedQuoteKey: 'x' })),
    /Unauthenticated/,
  );
});

// Task4A: both consumed owner reads and same-request recovery require the
// original reciprocal funding proof, never a succeeded label alone.
const FUNDING_CORRUPTIONS: Array<[string, (db: Db, operation: Row, ledger: Row) => void]> = [
  [
    'debit type',
    (_db, _operation, ledger) => {
      ledger.type = 'credit';
    },
  ],
  [
    'purchase source',
    (_db, _operation, ledger) => {
      ledger.source = 'admin_adjustment';
    },
  ],
  [
    'completed status',
    (_db, _operation, ledger) => {
      ledger.status = 'pending';
    },
  ],
  [
    'reference',
    (_db, _operation, ledger) => {
      ledger.reference = 'WLT-other';
    },
  ],
  [
    'wallet ownership',
    (db, _operation, _ledger) => {
      findRow(db, 'wallets', 'wallets|users|buyer').userId = 'users|other';
    },
  ],
  [
    'ledger owner',
    (_db, _operation, ledger) => {
      ledger.userId = 'users|other';
    },
  ],
  [
    'ledger operation',
    (_db, _operation, ledger) => {
      ledger.operationId = 'paymentOperations|other';
    },
  ],
  [
    'debit amount',
    (_db, _operation, ledger) => {
      ledger.amount = 1;
    },
  ],
  [
    'balance after',
    (_db, _operation, ledger) => {
      ledger.balanceAfter = 1;
    },
  ],
  [
    'effect time',
    (_db, _operation, ledger) => {
      ledger.completedAt = 0;
    },
  ],
  [
    'debit cents',
    (_db, operation, _ledger) => {
      operation.debitAmountCents = 1;
    },
  ],
  [
    'quote key',
    (_db, operation, _ledger) => {
      (operation.quoteSnapshot as CheckoutQuote).quoteKey = 'wrong';
    },
  ],
  [
    'accounting marker',
    (_db, operation, _ledger) => {
      operation.accountingAppliedAt = undefined;
    },
  ],
  [
    'zero aggregate',
    (_db, operation, _ledger) => {
      operation.totalAmountCents = 0;
    },
  ],
  [
    'duplicate debit',
    (db, _operation, ledger) => {
      db.tables.walletTransactions?.push({ ...ledger, _id: 'walletTransactions|duplicate' });
    },
  ],
  [
    'duplicate escrow',
    (db, _operation, _ledger) => {
      const escrow = tableRows(db, 'escrow')[0];
      assert.ok(escrow);
      db.tables.escrow?.push({ ...escrow, _id: 'escrow|duplicate' });
    },
  ],
  [
    'escrow operation',
    (db, _operation, _ledger) => {
      const escrow = tableRows(db, 'escrow')[0];
      assert.ok(escrow);
      escrow.operationId = 'paymentOperations|other';
    },
  ],
  [
    'escrow money',
    (db, _operation, _ledger) => {
      const escrow = tableRows(db, 'escrow')[0];
      assert.ok(escrow);
      escrow.grossAmount = 1;
    },
  ],
  [
    'order owner',
    (db, _operation, _ledger) => {
      const order = tableRows(db, 'orders')[0];
      assert.ok(order);
      order.buyerId = 'users|other';
    },
  ],
  [
    'order money',
    (db, _operation, _ledger) => {
      const order = tableRows(db, 'orders')[0];
      assert.ok(order);
      order.totalAmount = 1;
    },
  ],
  [
    'wrong order slice identity',
    (_db, operation, _ledger) => {
      const slices = operation.orderBreakdowns as Array<{ orderId: string }>;
      assert.ok(slices[0]);
      slices[0].orderId = 'orders|other';
    },
  ],
];

for (const [name, corrupt] of FUNDING_CORRUPTIONS) {
  test(`Task4A funding proof rejects ${name} in BOTH getMine and same-request recovery, with no writes`, async () => {
    const db = open();
    seedCartLine(db, 'products|lamp', 1);
    seedCartLine(db, 'products|cap', 1);
    const quote = await freshQuote(db, 'clerk_buyer', cartArgs());
    const args = purchaseArgs('funding-proof', { expectedQuoteKey: quote.quoteKey });
    const result = okResult(await purchase(db, 'clerk_buyer', args));
    const operation = findRow(db, 'paymentOperations', result.operationId);
    const ledger = tableRows(db, 'walletTransactions')[0];
    assert.ok(ledger);
    corrupt(db, operation, ledger);
    const before = snapshot(db);
    await assert.rejects(
      () =>
        invokeFakeFunction(paymentOperations.getMine, createCtx(db, 'clerk_buyer'), {
          operationId: result.operationId,
        }),
      /review/,
    );
    assert.equal(await purchaseFailureCode(db, 'clerk_buyer', args), 'review_needed');
    assert.deepEqual(db.tables, before);
  });
}

test('Task4A funding pairs same-seller and multi-seller orders by identity through terminal lifecycle and later effect sources', async () => {
  const db = open();
  seedOrder(db, 'orders|a', 'users|buyer', 'users|seller', 'pending_payment', [lampItem(1)]);
  seedOrder(db, 'orders|b', 'users|buyer', 'users|seller', 'pending_payment', [lampItem(2)]);
  seedOrder(db, 'orders|c', 'users|buyer', 'users|seller2', 'pending_payment', [capItem(1)]);
  const selectors = pendingSelectors(['orders|a', 'orders|b', 'orders|c']);
  const quote = await freshQuote(db, 'clerk_buyer', selectors);
  const args = { ...selectors, requestId: 'funding-paired', expectedQuoteKey: quote.quoteKey };
  const result = okResult(await purchase(db, 'clerk_buyer', args));
  const operation = findRow(db, 'paymentOperations', result.operationId);
  operation.orderIds = [...result.orderIds].reverse();
  const slices = operation.orderBreakdowns as Array<{ orderId: string; sellerId: string }>;
  operation.orderBreakdowns = [...slices].reverse();
  for (const [index, order] of tableRows(db, 'orders').entries()) {
    order.status = index === 0 ? 'cancelled' : 'completed';
  }
  for (const [index, escrow] of tableRows(db, 'escrow').entries()) {
    escrow.status = index === 0 ? 'refunded' : 'released';
  }
  const debit = tableRows(db, 'walletTransactions')[0];
  assert.ok(debit);
  db.tables.walletTransactions?.push({
    ...debit,
    _id: 'walletTransactions|future-refund',
    type: 'credit',
    source: 'refund',
    reference: 'REF-later',
  });
  db.tables.walletTransactions?.push({
    ...debit,
    _id: 'walletTransactions|future-release',
    type: 'credit',
    source: 'escrow_release',
    reference: 'REL-later',
  });
  findRow(db, 'wallets', 'wallets|users|buyer').balance = 999;
  findRow(db, 'appConfig', 'appConfig|1').paymentsEnabled = false;
  const before = snapshot(db);
  const mine = (await invokeFakeFunction(paymentOperations.getMine, createCtx(db, 'clerk_buyer'), {
    operationId: result.operationId,
  })) as { status: string };
  assert.equal(mine.status, 'succeeded');
  assert.equal(okResult(await purchase(db, 'clerk_buyer', args)).operationId, result.operationId);
  assert.deepEqual(db.tables, before);
  // Equal seller identity does not permit swapping unequal order slices.
  const first = slices.find((slice) => slice.orderId === 'orders|a');
  const second = slices.find((slice) => slice.orderId === 'orders|b');
  assert.ok(first);
  assert.ok(second);
  first.orderId = 'orders|b';
  second.orderId = 'orders|a';
  await assert.rejects(
    () =>
      invokeFakeFunction(paymentOperations.getMine, createCtx(db, 'clerk_buyer'), { operationId: result.operationId }),
    /review/,
  );
});

test('Task4A funding permits zero seller slices within a positive conserved aggregate', async () => {
  const db = open();
  const free = findRow(db, 'products', 'products|lamp');
  free.price = 0;
  free.weightKg = 0;
  free.shippingOptions = [{ name: 'Free', price: 0 }];
  seedCartLine(db, 'products|lamp', 1, { selectedShipping: { name: 'Free', price: 0 } });
  seedCartLine(db, 'products|cap', 1, { selectedShipping: { name: 'Standard', price: 20 } });
  const method = findRow(db, 'deliveryMethods', 'deliveryMethods|m1');
  method.baseFee = 0;
  method.perKgFee = 0;
  const selectors = cartArgs();
  const quote = await freshQuote(db, 'clerk_buyer', selectors);
  assert.ok(quote.totalAmountCents > 0);
  assert.ok(quote.sellers.some((seller) => seller.totalAmountCents === 0));
  const args = { ...selectors, requestId: 'zero-slice', expectedQuoteKey: quote.quoteKey };
  const result = okResult(await purchase(db, 'clerk_buyer', args));
  const before = snapshot(db);
  const mine = (await invokeFakeFunction(paymentOperations.getMine, createCtx(db, 'clerk_buyer'), {
    operationId: result.operationId,
  })) as { status: string };
  assert.equal(mine.status, 'succeeded');
  assert.equal(okResult(await purchase(db, 'clerk_buyer', args)).operationId, result.operationId);
  assert.deepEqual(db.tables, before);
});
