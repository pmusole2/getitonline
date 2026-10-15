import assert from 'node:assert/strict';
import test from 'node:test';

import * as escrow from './escrow';
import * as transactions from './transactions';
import { createCtx, createDb, handlerOf, type Row, type Tables } from '../tests/support/convexFakeDb';

// Real registered handler bodies; the double models index equality, ordering and limits, not SDK validators/JWTs.
type Args = Record<string, unknown>;
const byOrder = handlerOf<Args, Row | null>(escrow.getEscrowByOrder);
const byEscrow = handlerOf<Args, Row | null>(escrow.getEscrow);
const buyerEscrows = handlerOf<Args, Row[]>(escrow.getBuyerEscrows);
const sellerPending = handlerOf<Args, { escrows: Row[]; totalPending: number; count: number }>(
  escrow.getSellerPendingEscrow,
);
const byReference = handlerOf<Args, Row | null>(transactions.getTransactionByReference);
const byTransaction = handlerOf<Args, Row | null>(transactions.getTransaction);
const orderTransactions = handlerOf<Args, Row[]>(transactions.getOrderTransactions);
const userTransactions = handlerOf<Args, Row[]>(transactions.getUserTransactions);

function user(name: string, role = 'user', extra: Args = {}): Row {
  return {
    _id: `users|${name}`,
    clerkId: name,
    role,
    email: `${name}@example.invalid`,
    firstName: name,
    lastName: 'Fixture',
    isBanned: false,
    isVerified: true,
    totalSales: 0,
    totalPurchases: 0,
    ...extra,
  };
}

function order(name: string, buyer: string, seller: string): Row {
  return {
    _id: `orders|${name}`,
    orderNumber: `ORD-${name}`,
    buyerId: `users|${buyer}`,
    sellerId: `users|${seller}`,
    status: 'paid',
    items: [],
    subtotal: 100,
    shippingCost: 0,
    platformFee: 5,
    totalAmount: 105,
    shippingAddress: { street: 'Fixture road', city: 'Lusaka', province: 'Lusaka', country: 'Zambia', phone: '000' },
    createdAt: 1,
    updatedAt: 1,
  };
}

function hold(name: string, buyer: string, seller: string, amount: number, sellerAmount: number, status = 'held'): Row {
  return {
    _id: `escrow|${name}`,
    orderId: `orders|${name}`,
    buyerId: `users|${buyer}`,
    sellerId: `users|${seller}`,
    grossAmount: amount,
    platformFee: 5,
    sellerAmount,
    amount,
    status,
    createdAt: 1,
    updatedAt: 1,
  };
}

function transaction(name: string, owner: string, orderName: string | undefined, status = 'successful'): Row {
  return {
    _id: `transactions|${name}`,
    reference: `REF-${name}`,
    userId: `users|${owner}`,
    ...(orderName ? { orderId: `orders|${orderName}` } : {}),
    type: 'collection',
    paymentMethod: 'card',
    amount: 105,
    currency: 'ZMW',
    status,
    initiatedAt: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

function tables(): Tables {
  return {
    users: [
      user('buyer'),
      user('seller'),
      user('other'),
      user('other_seller'),
      user('outsider'),
      user('company'),
      user('catalog', 'catalog_manager'),
      user('moderator', 'moderator'),
      user('admin', 'admin'),
      user('banned', 'admin', { isBanned: true }),
      user('deleted', 'user', { deletedAt: 1 }),
    ],
    platformSettings: [{ _id: 'platformSettings|settings', key: 'singleton', companySellerUserId: 'users|company' }],
    orders: [
      order('vendor', 'buyer', 'seller'),
      order('company', 'buyer', 'company'),
      order('other', 'other', 'other_seller'),
      order('legacy', 'other', 'seller'),
      order('refunded', 'buyer', 'seller'),
    ],
    escrow: [
      hold('vendor', 'buyer', 'seller', 100, 80),
      hold('company', 'buyer', 'company', 200, 160),
      hold('other', 'other', 'other_seller', 300, 250),
      hold('legacy', 'other', 'seller', 60, 0),
      hold('refunded', 'buyer', 'seller', 400, 350, 'refunded'),
    ],
    transactions: [
      transaction('pending', 'buyer', 'vendor', 'pending'),
      transaction('vendor', 'buyer', 'vendor'),
      transaction('company', 'buyer', 'company'),
      transaction('other', 'other', 'other'),
      transaction('topup', 'buyer', undefined),
      {
        ...transaction('aggregate', 'other', undefined),
        metadata: { checkoutOrderIds: ['orders|vendor', 'orders|company'] },
      },
    ],
  };
}

function setup(subject: string | null) {
  const db = createDb(tables());
  return { db, ctx: createCtx(db, subject) };
}

const vendorReads = [
  { name: 'escrow by order', run: byOrder, args: { orderId: 'orders|vendor' }, id: 'escrow|vendor' },
  { name: 'escrow by ID', run: byEscrow, args: { escrowId: 'escrow|vendor' }, id: 'escrow|vendor' },
  { name: 'transaction by reference', run: byReference, args: { reference: 'REF-vendor' }, id: 'transactions|vendor' },
  {
    name: 'transaction by ID',
    run: byTransaction,
    args: { transactionId: 'transactions|vendor' },
    id: 'transactions|vendor',
  },
] as const;

for (const read of vendorReads) {
  test(`${read.name} allows participants and reviewers and denies unrelated or catalog callers`, async () => {
    for (const subject of ['buyer', 'seller', 'admin', 'moderator']) {
      assert.equal((await read.run(setup(subject).ctx, read.args))?._id, read.id, subject);
    }
    for (const subject of ['outsider', 'other', 'catalog']) {
      const { db, ctx } = setup(subject);
      const before = structuredClone(db.tables);
      await assert.rejects(
        () => read.run(ctx, { ...read.args, viewerUserId: 'users|buyer', adminId: 'users|admin' }),
        /Unauthorized/,
      );
      assert.deepEqual(db.tables, before);
    }
  });
}

test('company delegates read only configured company financial records', async () => {
  for (const subject of ['catalog', 'admin']) {
    const { ctx } = setup(subject);
    assert.equal((await byOrder(ctx, { orderId: 'orders|company' }))?._id, 'escrow|company');
    assert.equal((await byEscrow(ctx, { escrowId: 'escrow|company' }))?._id, 'escrow|company');
    assert.equal((await byReference(ctx, { reference: 'REF-company' }))?._id, 'transactions|company');
    assert.equal((await byTransaction(ctx, { transactionId: 'transactions|company' }))?._id, 'transactions|company');
    assert.deepEqual(
      (await orderTransactions(ctx, { orderId: 'orders|company' })).map((row) => row._id),
      ['transactions|company'],
    );
    assert.equal((await sellerPending(ctx, { sellerId: 'users|company' })).totalPending, 160);
  }
  const { ctx } = setup('catalog');
  await assert.rejects(() => orderTransactions(ctx, { orderId: 'orders|other' }), /Unauthorized/);
  await assert.rejects(() => sellerPending(ctx, { sellerId: 'users|other_seller' }), /Unauthorized/);
});

test('seller target stays a resource ID and held-only totals preserve the legacy amount fallback', async () => {
  const own = await sellerPending(setup('seller').ctx, { sellerId: 'users|seller' });
  assert.deepEqual(
    own.escrows.map((row) => row._id),
    ['escrow|vendor', 'escrow|legacy'],
  );
  assert.equal(own.count, 2);
  assert.equal(own.totalPending, 140);
  for (const subject of ['buyer', 'outsider', 'moderator', 'admin']) {
    await assert.rejects(
      () => sellerPending(setup(subject).ctx, { sellerId: 'users|seller', actorUserId: 'users|seller' }),
      /Unauthorized/,
    );
  }
});

test('buyer escrow and payer histories are self-only, even when staff supplies another owner ID', async () => {
  const buyer = await buyerEscrows(setup('buyer').ctx, { buyerId: 'users|other' });
  assert.deepEqual(
    buyer.map((row) => row._id),
    ['escrow|vendor', 'escrow|company', 'escrow|refunded'],
  );
  assert.deepEqual(buyer[0]?.seller, { _id: 'users|seller', firstName: 'seller', lastName: 'Fixture' });
  const rows = await userTransactions(setup('buyer').ctx, { userId: 'users|other', status: 'successful', limit: 2 });
  assert.deepEqual(
    rows.map((row) => row._id),
    ['transactions|topup', 'transactions|company'],
  );
  assert.deepEqual(rows[1]?.order, { orderNumber: 'ORD-company', totalAmount: 105 });
  for (const subject of ['outsider', 'moderator', 'admin']) {
    assert.deepEqual(await buyerEscrows(setup(subject).ctx, { buyerId: 'users|buyer' }), []);
    assert.deepEqual(await userTransactions(setup(subject).ctx, { userId: 'users|buyer' }), []);
  }
});

test('order financial queries preserve descending history and reject unrelated users', async () => {
  assert.deepEqual(
    (await orderTransactions(setup('seller').ctx, { orderId: 'orders|vendor' })).map((row) => row._id),
    ['transactions|vendor', 'transactions|pending'],
  );
  for (const subject of ['outsider', 'catalog']) {
    await assert.rejects(
      () => orderTransactions(setup(subject).ctx, { orderId: 'orders|vendor', userId: 'users|buyer' }),
      /Unauthorized/,
    );
  }
  const detailed = await byTransaction(setup('buyer').ctx, { transactionId: 'transactions|vendor' });
  assert.deepEqual(detailed?.user, { firstName: 'buyer', lastName: 'Fixture' });
  assert.deepEqual(detailed?.order, { orderNumber: 'ORD-vendor', totalAmount: 105 });
});

test('standalone or aggregate payments belong to their payer/admin, never metadata-selected sellers or reviewers', async () => {
  assert.equal((await byReference(setup('buyer').ctx, { reference: 'REF-topup' }))?._id, 'transactions|topup');
  assert.equal(
    (await byTransaction(setup('admin').ctx, { transactionId: 'transactions|topup' }))?._id,
    'transactions|topup',
  );
  assert.equal((await byReference(setup('other').ctx, { reference: 'REF-aggregate' }))?._id, 'transactions|aggregate');
  for (const subject of ['seller', 'company', 'catalog', 'moderator', 'outsider']) {
    await assert.rejects(() => byReference(setup(subject).ctx, { reference: 'REF-topup' }), /Unauthorized/);
    await assert.rejects(
      () => byTransaction(setup(subject).ctx, { transactionId: 'transactions|aggregate' }),
      /Unauthorized/,
    );
  }
});

const allReads = [
  ...vendorReads,
  { name: 'buyer list', run: buyerEscrows, args: { buyerId: 'users|buyer' } },
  { name: 'seller pending', run: sellerPending, args: { sellerId: 'users|seller' } },
  { name: 'order transactions', run: orderTransactions, args: { orderId: 'orders|vendor' } },
  { name: 'payer list', run: userTransactions, args: { userId: 'users|buyer' } },
];

for (const [label, subject, pattern] of [
  ['anonymous', null, /Unauthenticated/],
  ['unknown', 'unknown', /Account not found/],
  ['banned staff', 'banned', /Account is banned/],
  ['deleted', 'deleted', /Account is deleted/],
] as const) {
  test(`all financial reads reject ${label} before looking up private tables`, async () => {
    for (const read of allReads) {
      const { db, ctx } = setup(subject);
      const before = structuredClone(db.tables);
      const query = db.query;
      db.query = (table) => {
        assert.equal(table, 'users', 'denied accounts must not query private tables');
        return query(table);
      };
      db.get = async () => {
        assert.fail('denied accounts must not load private records');
      };
      await assert.rejects(() => read.run(ctx, read.args), pattern, read.name);
      assert.deepEqual(db.tables, before);
    }
  });
}

test('active users get missing-record shapes; missing IDs cannot bypass auth', async () => {
  const { ctx } = setup('buyer');
  assert.equal(await byOrder(ctx, { orderId: 'orders|missing' }), null);
  assert.equal(await byEscrow(ctx, { escrowId: 'escrow|missing' }), null);
  assert.equal(await byReference(ctx, { reference: 'REF-missing' }), null);
  assert.equal(await byTransaction(ctx, { transactionId: 'transactions|missing' }), null);
  assert.deepEqual(await orderTransactions(ctx, { orderId: 'orders|missing' }), []);
  await assert.rejects(() => byReference(setup(null).ctx, { reference: 'REF-missing' }), /Unauthenticated/);
});

test('escrow enrichment rejects conflicting order ownership without disclosing the linked order', async () => {
  const { db, ctx } = setup('buyer');
  const row = db.tables.escrow?.find((entry) => entry._id === 'escrow|vendor');
  assert.ok(row);
  row.orderId = 'orders|other';
  await assert.rejects(() => byEscrow(ctx, { escrowId: 'escrow|vendor' }), /Unauthorized/);
  await assert.rejects(() => buyerEscrows(ctx, {}), /Unauthorized/);
  await assert.rejects(() => byOrder(ctx, { orderId: 'orders|other' }), /Unauthorized/);
});

test('user transaction history retains default limit and zero-limit fallback', async () => {
  const { db, ctx } = setup('buyer');
  db.tables.transactions = Array.from({ length: 60 }, (_, index) => transaction(String(index), 'buyer', undefined));
  assert.equal((await userTransactions(ctx, {})).length, 50);
  assert.equal((await userTransactions(ctx, { limit: 0 })).length, 50);
  assert.deepEqual(
    (await userTransactions(ctx, { limit: 2 })).map((row) => row._id),
    ['transactions|59', 'transactions|58'],
  );
});

test('missing legacy order links retain owner-readable records without granting unrelated access', async () => {
  const { db, ctx } = setup('buyer');
  db.tables.orders = [];
  assert.equal((await byOrder(ctx, { orderId: 'orders|vendor' }))?._id, 'escrow|vendor');
  assert.equal((await byEscrow(ctx, { escrowId: 'escrow|vendor' }))?.order, null);
  assert.equal((await byTransaction(ctx, { transactionId: 'transactions|vendor' }))?.order, null);
  const seller = createCtx(db, 'seller');
  await assert.rejects(() => byTransaction(seller, { transactionId: 'transactions|vendor' }), /Unauthorized/);
  await assert.rejects(() => byEscrow(createCtx(db, 'outsider'), { escrowId: 'escrow|vendor' }), /Unauthorized/);
});

test('company delegation follows current configuration and never a caller-supplied company ID', async () => {
  const { db, ctx } = setup('catalog');
  db.tables.platformSettings = [];
  await assert.rejects(() => byOrder(ctx, { orderId: 'orders|company', sellerId: 'users|company' }), /Unauthorized/);
  await assert.rejects(
    () => sellerPending(ctx, { sellerId: 'users|company', actorUserId: 'users|admin' }),
    /Unauthorized/,
  );
});

test('owner-list registered schemas remove authority IDs and keep financial resource selectors', () => {
  for (const [fn, expected] of [
    [escrow.getBuyerEscrows, []],
    [transactions.getUserTransactions, ['limit', 'status']],
    [escrow.getSellerPendingEscrow, ['sellerId']],
    [escrow.getEscrowByOrder, ['orderId']],
  ] as const) {
    assert.ok('exportArgs' in fn && typeof fn.exportArgs === 'function');
    const schema: unknown = JSON.parse(fn.exportArgs());
    assert.ok(typeof schema === 'object' && schema !== null && 'value' in schema);
    assert.ok(typeof schema.value === 'object' && schema.value !== null);
    assert.deepEqual(Object.keys(schema.value).sort(), [...expected].sort());
  }
});
