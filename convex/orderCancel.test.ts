import assert from 'node:assert/strict';
import test from 'node:test';

import * as disputes from './disputes';
import * as orders from './orders';
import { createCtx, createDb, handlerOf, type Db, type Row, type Tables } from '../tests/support/convexFakeDb';

// Cancelling an order must put stock back, refund a held or disputed escrow, and settle the order's transactions, whether
// the cancel comes through cancelOrder or through the cancelled transition of updateOrderStatus. The parity test runs both
// paths on identical data. Rejected transitions must leave every table unchanged, because the fake does not roll back.

type Args = Record<string, unknown>;

const updateOrderStatus = handlerOf<Args, Row | null>(orders.updateOrderStatus);
const cancelOrder = handlerOf<Args, Row | null>(orders.cancelOrder);
const createDispute = handlerOf<Args, string>(disputes.createDispute);
const resolveDispute = handlerOf<Args, Row | null>(disputes.resolveDispute);
const buyerResolveDispute = handlerOf<Args, Row | null>(disputes.buyerResolveDispute);
const createOrder = handlerOf<Args, string>(orders.createOrder);

function account(id: string, clerkId: string, role: string): Row {
  return {
    _id: id,
    clerkId,
    email: `${clerkId}@example.invalid`,
    firstName: 'Fixture',
    lastName: id,
    role,
    isBanned: false,
  };
}

function fixtureTables(status: string, escrowStatus: string): Tables {
  return {
    users: [
      account('users|buyer', 'clerk_buyer', 'user'),
      account('users|seller', 'clerk_seller', 'user'),
      account('users|moderator', 'clerk_moderator', 'moderator'),
      account('users|admin', 'clerk_admin', 'admin'),
      account('users|outsider', 'clerk_outsider', 'user'),
      { ...account('users|banned', 'clerk_banned', 'user'), isBanned: true },
      { ...account('users|deleted', 'clerk_deleted', 'user'), deletedAt: 1 },
    ],
    platformSettings: [{ _id: 'platformSettings|1', key: 'singleton', companySellerUserId: 'users|company' }],
    products: [
      { _id: 'products|1', sellerId: 'users|seller', title: 'Lamp', quantity: 0, status: 'sold' },
      { _id: 'products|2', sellerId: 'users|seller', title: 'Desk', quantity: 4, status: 'active' },
    ],
    orders: [
      {
        _id: 'orders|1',
        orderNumber: 'ORD-1',
        buyerId: 'users|buyer',
        sellerId: 'users|seller',
        status,
        items: [
          { productId: 'products|1', quantity: 2 },
          { productId: 'products|2', quantity: 1 },
        ],
        totalAmount: 100,
        updatedAt: 1,
      },
    ],
    escrow: [{ _id: 'escrow|1', orderId: 'orders|1', amount: 90, grossAmount: 100, status: escrowStatus }],
    transactions: [
      { _id: 'transactions|paid', orderId: 'orders|1', status: 'successful' },
      { _id: 'transactions|pending', orderId: 'orders|1', status: 'pending' },
      { _id: 'transactions|processing', orderId: 'orders|1', status: 'processing' },
      { _id: 'transactions|failed', orderId: 'orders|1', status: 'failed' },
    ],
  };
}

function setup(status: string, escrowStatus: string, clerkId: string) {
  const db: Db = createDb(fixtureTables(status, escrowStatus));
  return { db, ctx: createCtx(db, clerkId) };
}

// A genuine unlinked unfunded order: pending_payment with no escrow hold, no
// linked operation, and no financial rows. Only these orders may still
// stock-cancel without money movement.
function unfundedTables(status: string): Tables {
  const tables = fixtureTables(status, 'held');
  tables.escrow = [];
  tables.transactions = [];
  return tables;
}

function setupUnfunded(status: string, clerkId: string) {
  const db: Db = createDb(unfundedTables(status));
  return { db, ctx: createCtx(db, clerkId) };
}

function rowOf(db: Db, table: string, id: string): Row {
  const found = db.tables[table]?.find((candidate) => candidate._id === id);
  assert.ok(found, `${id} must exist`);
  return found;
}

function assertCancelled(db: Db) {
  assert.equal(rowOf(db, 'orders', 'orders|1').status, 'cancelled');

  const lamp = rowOf(db, 'products', 'products|1');
  assert.equal(lamp.quantity, 2, 'the reserved stock is put back');
  assert.equal(lamp.status, 'active', 'a sold-out listing is active again');
  assert.equal(rowOf(db, 'products', 'products|2').quantity, 5);

  // A genuine unfunded cancel moves no money: no escrow hold exists to
  // refund and no financial rows exist to settle.
  assert.equal(db.tables.escrow?.length ?? 0, 0);
  assert.equal(db.tables.transactions?.length ?? 0, 0);
}

test('the buyer cancelling an unfunded order through updateOrderStatus restores stock and cancels', async () => {
  const { db, ctx } = setupUnfunded('pending_payment', 'clerk_buyer');

  const updated = await updateOrderStatus(ctx, { orderId: 'orders|1', status: 'cancelled' });

  assert.equal(updated?.status, 'cancelled');
  assertCancelled(db);
});

test('a moderator cancelling an unfunded pending order through updateOrderStatus does the same', async () => {
  const { db, ctx } = setupUnfunded('pending_payment', 'clerk_moderator');
  await updateOrderStatus(ctx, { orderId: 'orders|1', status: 'cancelled' });
  assertCancelled(db);
});

test('updateOrderStatus and cancelOrder leave the same stock for an unfunded order', async () => {
  const viaStatus = setupUnfunded('pending_payment', 'clerk_buyer');
  await updateOrderStatus(viaStatus.ctx, { orderId: 'orders|1', status: 'cancelled' });

  const viaCancel = setupUnfunded('pending_payment', 'clerk_buyer');
  await cancelOrder(viaCancel.ctx, { orderId: 'orders|1' });

  for (const table of ['products', 'escrow', 'transactions']) {
    const strip = (db: Db) =>
      (db.tables[table] ?? []).map(({ updatedAt: _updatedAt, completedAt: _completedAt, ...rest }) => rest);
    assert.deepEqual(strip(viaStatus.db), strip(viaCancel.db), `${table} must match between the two paths`);
  }
  assert.equal(rowOf(viaStatus.db, 'orders', 'orders|1').status, rowOf(viaCancel.db, 'orders', 'orders|1').status);
});

test('cancelOrder keeps its own behaviour, including the reason it records', async () => {
  const { db, ctx } = setupUnfunded('pending_payment', 'clerk_buyer');

  await cancelOrder(ctx, { orderId: 'orders|1', reason: 'Changed my mind' });

  assertCancelled(db);
  assert.equal(rowOf(db, 'orders', 'orders|1').notes, 'Changed my mind');
});

// A marker-only legacy escrow (held, but with no linked operation or funding
// proof) never authorizes a refund or a stock release. Both entries hold the
// order for review with every table unchanged, instead of pretending a
// refund. Genuine funded positives run the real handlers in
// escrowAccounting.test.ts (C2a).

test('a marker-only escrow holds cancellation for review with nothing changed', async () => {
  for (const status of ['pending_payment', 'paid', 'processing']) {
    for (const entry of ENTRIES) {
      const clerkId = entry === 'status' && status !== 'pending_payment' ? 'clerk_moderator' : 'clerk_buyer';
      const { db, ctx } = setup(status, 'held', clerkId);
      const before = structuredClone(db.tables);

      await assert.rejects(() => cancelVia(entry, ctx, {}), /review/i, `${entry} on ${status}`);
      assert.deepEqual(db.tables, before, `${entry} on ${status} must change nothing`);
      assert.equal(rowOf(db, 'orders', 'orders|1').status, status);
      assert.equal(rowOf(db, 'escrow', 'escrow|1').status, 'held');
    }
  }
});

test('a rejected cancel leaves stock, escrow, transactions, and the order unchanged', async () => {
  const attempts: Array<{ status: string; clerkId: string; escrow: string }> = [
    { status: 'paid', clerkId: 'clerk_buyer', escrow: 'held' },
    { status: 'processing', clerkId: 'clerk_buyer', escrow: 'held' },
    { status: 'paid', clerkId: 'clerk_seller', escrow: 'held' },
    { status: 'pending_payment', clerkId: 'clerk_outsider', escrow: 'held' },
    { status: 'shipped', clerkId: 'clerk_moderator', escrow: 'held' },
    { status: 'cancelled', clerkId: 'clerk_admin', escrow: 'refunded' },
  ];
  for (const attempt of attempts) {
    const { db, ctx } = setup(attempt.status, attempt.escrow, attempt.clerkId);
    const before = structuredClone(db.tables);

    await assert.rejects(
      () => updateOrderStatus(ctx, { orderId: 'orders|1', status: 'cancelled' }),
      /Cannot transition/,
      `${attempt.clerkId} on ${attempt.status}`,
    );
    assert.deepEqual(db.tables, before, `${attempt.clerkId} on ${attempt.status} must change nothing`);
  }
});

test('other transitions do not touch stock, escrow, or transactions', async () => {
  const { db, ctx } = setup('paid', 'held', 'clerk_seller');
  const stockBefore = structuredClone(db.tables.products);
  const escrowBefore = structuredClone(db.tables.escrow);
  const transactionsBefore = structuredClone(db.tables.transactions);

  const updated = await updateOrderStatus(ctx, { orderId: 'orders|1', status: 'processing' });

  assert.equal(updated?.status, 'processing');
  assert.deepEqual(db.tables.products, stockBefore);
  assert.deepEqual(db.tables.escrow, escrowBefore);
  assert.deepEqual(db.tables.transactions, transactionsBefore);
});

// An order whose goods have shipped is decided by the dispute flow, never by a generic cancel. Cancelling through the
// order would put goods back on sale while the buyer still holds them.

const DISPUTE_ARGS = {
  orderId: 'orders|1',
  title: 'Item is defective',
  description: 'It broke on the first day',
  category: 'defective',
  evidence: [],
};

async function openDispute(orderStatus: string): Promise<Db> {
  const { db, ctx } = setup(orderStatus, 'held', 'clerk_buyer');
  await createDispute(ctx, DISPUTE_ARGS);
  return db;
}

function disputeIdOf(db: Db): string {
  const dispute = db.tables.disputes?.[0];
  assert.ok(dispute, 'a dispute must exist');
  return dispute._id;
}

test('an order in a real dispute cannot be cancelled through updateOrderStatus, and its goods stay unavailable', async () => {
  for (const orderStatus of ['delivered', 'shipped']) {
    const db = await openDispute(orderStatus);
    assert.equal(rowOf(db, 'orders', 'orders|1').status, 'disputed');
    assert.equal(rowOf(db, 'escrow', 'escrow|1').status, 'disputed');
    const before = structuredClone(db.tables);

    for (const clerkId of ['clerk_admin', 'clerk_moderator', 'clerk_buyer']) {
      await assert.rejects(
        () => updateOrderStatus(createCtx(db, clerkId), { orderId: 'orders|1', status: 'cancelled' }),
        /Cannot transition/,
        `${clerkId} after ${orderStatus}`,
      );
      assert.deepEqual(db.tables, before, `${clerkId} after ${orderStatus} must change nothing`);
    }
    assert.equal(rowOf(db, 'products', 'products|1').quantity, 0, 'the goods are not put back on sale');
    assert.equal(rowOf(db, 'products', 'products|1').status, 'sold');
  }
});

test('a legacy unfunded dispute cannot issue a new refund or put shipped goods back on sale', async () => {
  const db = await openDispute('delivered');
  await db.patch('escrow|1', {
    buyerId: 'users|buyer',
    sellerId: 'users|seller',
    amount: 100,
    grossAmount: 100,
    sellerAmount: 90,
    platformFee: 10,
  });
  const before = structuredClone(db.tables);
  await assert.rejects(
    () =>
      resolveDispute(createCtx(db, 'clerk_admin'), {
        disputeId: disputeIdOf(db),
        resolutionType: 'full_refund',
        notes: 'The goods are defective',
      }),
    /Escrow funding needs review/,
  );
  assert.deepEqual(db.tables, before);
  assert.equal(rowOf(db, 'products', 'products|1').quantity, 0);
  assert.equal(rowOf(db, 'products', 'products|1').status, 'sold');
});

test('a dispute cannot be decided once its escrow has stopped holding funds', async () => {
  for (const terminal of ['refunded', 'released', 'partially_refunded']) {
    const db = await openDispute('delivered');
    await db.patch('escrow|1', { status: terminal });
    const before = structuredClone(db.tables);

    await assert.rejects(
      () =>
        resolveDispute(createCtx(db, 'clerk_admin'), {
          disputeId: disputeIdOf(db),
          resolutionType: 'no_refund',
          notes: 'Seller keeps the funds',
        }),
      /no longer holding funds/,
      `resolveDispute with ${terminal} escrow`,
    );
    assert.deepEqual(db.tables, before, `resolveDispute with ${terminal} escrow must change nothing`);

    await assert.rejects(
      () =>
        buyerResolveDispute(createCtx(db, 'clerk_buyer'), { disputeId: disputeIdOf(db), resolutionType: 'withdraw' }),
      /no longer holding funds/,
      `buyerResolveDispute with ${terminal} escrow`,
    );
    assert.deepEqual(db.tables, before, `buyerResolveDispute with ${terminal} escrow must change nothing`);
  }
});

test('a dispute that is already decided or closed cannot be decided again', async () => {
  const decided = await openDispute('delivered');
  const id = disputeIdOf(decided);
  // Explicit historical resolved refund retains the terminal-decision oracle.
  // Genuine funded first decisions are exercised in escrowAccounting.test.ts.
  await decided.patch(id, {
    status: 'resolved',
    resolution: {
      type: 'full_refund',
      refundAmount: 100,
      resolvedBy: 'users|admin',
      notes: 'First decision',
      resolvedAt: 2,
    },
  });
  await decided.patch('escrow|1', { status: 'refunded', refundAmount: 100 });
  await decided.patch('orders|1', { status: 'cancelled' });
  const afterFirst = structuredClone(decided.tables);

  for (const resolutionType of ['no_refund', 'full_refund']) {
    await assert.rejects(
      () => resolveDispute(createCtx(decided, 'clerk_admin'), { disputeId: id, resolutionType, notes: 'Second' }),
      /already resolved or closed/,
      resolutionType,
    );
    assert.deepEqual(decided.tables, afterFirst, `a second ${resolutionType} must change nothing`);
  }

  const closed = await openDispute('delivered');
  await closed.patch(disputeIdOf(closed), { status: 'closed' });
  const beforeClosed = structuredClone(closed.tables);
  await assert.rejects(
    () =>
      resolveDispute(createCtx(closed, 'clerk_admin'), {
        disputeId: disputeIdOf(closed),
        resolutionType: 'no_refund',
        notes: 'Too late',
      }),
    /already resolved or closed/,
  );
  assert.deepEqual(closed.tables, beforeClosed);
});

// Both entry points share one cancellation. Each caller below is turned away before any write.

const DENIED: Array<{ clerkId: string | null; pattern: RegExp }> = [
  { clerkId: null, pattern: /Unauthenticated/ },
  { clerkId: 'clerk_nobody', pattern: /Account not found/ },
  { clerkId: 'clerk_banned', pattern: /Account is banned/ },
  { clerkId: 'clerk_deleted', pattern: /Account is deleted/ },
  { clerkId: 'clerk_outsider', pattern: /Unauthorized|Cannot transition/ },
  { clerkId: 'clerk_seller', pattern: /Unauthorized|Cannot transition/ },
];

type Entry = 'status' | 'cancel';
const ENTRIES: Entry[] = ['status', 'cancel'];

function cancelVia(entry: Entry, ctx: unknown, extra: Args = {}) {
  return entry === 'status'
    ? updateOrderStatus(ctx, { orderId: 'orders|1', status: 'cancelled' })
    : cancelOrder(ctx, { orderId: 'orders|1', ...extra });
}

test('anonymous, unknown, banned, deleted, and unauthorized callers cannot cancel through either entry point', async () => {
  for (const { clerkId, pattern } of DENIED) {
    for (const entry of ENTRIES) {
      const db = createDb(fixtureTables('pending_payment', 'held'));
      const before = structuredClone(db.tables);

      await assert.rejects(() => cancelVia(entry, createCtx(db, clerkId)), pattern, `${clerkId} via ${entry}`);
      assert.deepEqual(db.tables, before, `${clerkId} via ${entry} must change nothing`);
    }
  }
});

test('a decided dispute cannot be decided by an anonymous, banned, deleted, or unrelated caller', async () => {
  for (const { clerkId, pattern } of DENIED.filter((denied) => denied.clerkId !== 'clerk_seller')) {
    const db = await openDispute('delivered');
    const before = structuredClone(db.tables);

    await assert.rejects(
      () =>
        resolveDispute(createCtx(db, clerkId), {
          disputeId: disputeIdOf(db),
          resolutionType: 'no_refund',
          notes: 'Not allowed',
        }),
      pattern,
      `${clerkId}`,
    );
    assert.deepEqual(db.tables, before);
  }
});

// Variant stock. createOrder takes the purchased quantity from the chosen variant, so a cancel must give it back to that
// variant and to no other.

function variant(id: string, sku: string, stock: number, status: string) {
  return { id, sku, attributes: [], price: 50, stock, status };
}

function chosen(variantId: string, sku: string) {
  return { variantId, sku, attributes: [], price: 50 };
}

function variantTables(items?: Array<Record<string, unknown>>, status = 'pending_payment'): Tables {
  const tables = fixtureTables(status, 'held');
  const order = tables.orders?.[0];
  assert.ok(order);
  tables.products = [
    {
      _id: 'products|1',
      sellerId: 'users|seller',
      title: 'Lamp',
      quantity: 8,
      status: 'active',
      variantCombinations: [
        variant('v1', 'LAMP-R', 0, 'out_of_stock'),
        variant('v2', 'LAMP-B', 3, 'active'),
        variant('v3', 'LAMP-G', 5, 'inactive'),
      ],
    },
    { _id: 'products|2', sellerId: 'users|seller', title: 'Desk', quantity: 4, status: 'active' },
    {
      _id: 'products|3',
      sellerId: 'users|seller',
      title: 'Mug',
      quantity: 0,
      status: 'sold',
      variantCombinations: [variant('s1', 'MUG-1', 0, 'out_of_stock')],
    },
  ];
  tables.orders = [
    {
      ...order,
      items: items ?? [
        { productId: 'products|1', quantity: 2, selectedVariant: chosen('v1', 'LAMP-R') },
        { productId: 'products|2', quantity: 1 },
        { productId: 'products|3', quantity: 1, selectedVariant: chosen('s1', 'MUG-1') },
      ],
    },
  ];
  return tables;
}

function unfundedVariantTables(items?: Array<Record<string, unknown>>, status = 'pending_payment'): Tables {
  const tables = variantTables(items, status);
  tables.escrow = [];
  tables.transactions = [];
  return tables;
}

function combination(db: Db, productId: string, id: string): Row {
  const combinations = rowOf(db, 'products', productId).variantCombinations;
  assert.ok(Array.isArray(combinations));
  const found = (combinations as Row[]).find((candidate) => candidate.id === id);
  assert.ok(found, `${id} must exist`);
  return found;
}

test('cancelling an unfunded order through either entry point gives the quantity back to the variant that was bought', async () => {
  for (const entry of ENTRIES) {
    const db = createDb(unfundedVariantTables());
    await cancelVia(entry, createCtx(db, 'clerk_buyer'), {});
    const label = `via ${entry}`;

    assert.equal(rowOf(db, 'orders', 'orders|1').status, 'cancelled', label);
    assert.equal(combination(db, 'products|1', 'v1').stock, 2, `${label}: the bought variant is restocked`);
    assert.equal(combination(db, 'products|1', 'v1').status, 'active', `${label}: a sold-out variant is active again`);
    assert.equal(combination(db, 'products|1', 'v2').stock, 3, `${label}: other variants are untouched`);
    assert.equal(combination(db, 'products|1', 'v3').stock, 5);
    assert.equal(
      combination(db, 'products|1', 'v3').status,
      'inactive',
      `${label}: an inactive variant stays inactive`,
    );
    assert.equal(rowOf(db, 'products', 'products|1').quantity, 10, `${label}: the aggregate matches`);
    assert.equal(rowOf(db, 'products', 'products|2').quantity, 5, `${label}: a plain line is restored as before`);
    assert.equal(rowOf(db, 'products', 'products|3').quantity, 1);
    assert.equal(rowOf(db, 'products', 'products|3').status, 'active', `${label}: a sold-out listing is active again`);
    assert.equal(combination(db, 'products|3', 's1').stock, 1);
  }
});

test('a variant that was marked out of stock by hand stays that way, whatever its stock', async () => {
  const tables = unfundedVariantTables();
  const lamp = tables.products?.[0];
  assert.ok(lamp);
  lamp.variantCombinations = [
    variant('v1', 'LAMP-R', 3, 'out_of_stock'),
    variant('v2', 'LAMP-B', 3, 'active'),
    variant('v3', 'LAMP-G', 5, 'inactive'),
  ];
  const db = createDb(tables);

  await cancelOrder(createCtx(db, 'clerk_buyer'), { orderId: 'orders|1' });

  assert.equal(combination(db, 'products|1', 'v1').stock, 5);
  assert.equal(combination(db, 'products|1', 'v1').status, 'out_of_stock');
});

test('a variant that no longer exists is not guessed at: the unfunded cancel proceeds and the seller is told', async () => {
  for (const entry of ENTRIES) {
    const db = createDb(
      unfundedVariantTables([{ productId: 'products|1', quantity: 2, selectedVariant: chosen('gone', 'LAMP-X') }]),
    );
    const variantsBefore = structuredClone(rowOf(db, 'products', 'products|1').variantCombinations);

    await cancelVia(entry, createCtx(db, 'clerk_buyer'), {});

    assert.equal(rowOf(db, 'orders', 'orders|1').status, 'cancelled', entry);
    assert.equal(rowOf(db, 'products', 'products|1').quantity, 10, `${entry}: the aggregate is still restored`);
    assert.deepEqual(
      rowOf(db, 'products', 'products|1').variantCombinations,
      variantsBefore,
      `${entry}: no variant is credited`,
    );
    const notice = db.tables.notifications?.find((row) => row.userId === 'users|seller' && row.type === 'system');
    assert.ok(notice, `${entry}: the seller must be told`);
    assert.match(String(notice.message), /Lamp/);
    assert.match(String(notice.message), /LAMP-X/);
  }
});

test('an unfunded order line without a recorded variant restores the aggregate only, and raises no notice', async () => {
  const db = createDb(unfundedVariantTables([{ productId: 'products|1', quantity: 2 }]));
  const variantsBefore = structuredClone(rowOf(db, 'products', 'products|1').variantCombinations);

  await cancelOrder(createCtx(db, 'clerk_buyer'), { orderId: 'orders|1' });

  assert.equal(rowOf(db, 'products', 'products|1').quantity, 10);
  assert.deepEqual(rowOf(db, 'products', 'products|1').variantCombinations, variantsBefore);
  assert.equal(db.tables.notifications?.length ?? 0, 0);
});

test('an unfunded cancel through one entry cannot be cancelled again, and its stock comes back once', async () => {
  for (const first of ENTRIES) {
    const db = createDb(unfundedVariantTables());
    await cancelVia(first, createCtx(db, 'clerk_buyer'), {});
    const afterFirst = structuredClone(db.tables);

    for (const second of ENTRIES) {
      await assert.rejects(
        () => cancelVia(second, createCtx(db, 'clerk_admin'), {}),
        /cannot be cancelled|Cannot transition/,
        `${second} after ${first}`,
      );
      assert.deepEqual(db.tables, afterFirst, `${second} after ${first} must change nothing`);
    }
  }
});

test('an unfunded cancel keeps an existing order note unless the buyer gives a reason', async () => {
  for (const entry of ENTRIES) {
    const db = createDb(unfundedTables('pending_payment'));
    await db.patch('orders|1', { notes: 'Gift wrap please' });

    await cancelVia(entry, createCtx(db, 'clerk_buyer'), {});

    assert.equal(rowOf(db, 'orders', 'orders|1').notes, 'Gift wrap please', `${entry} keeps the note`);
  }

  const withReason = createDb(unfundedTables('pending_payment'));
  await withReason.patch('orders|1', { notes: 'Gift wrap please' });
  await cancelOrder(createCtx(withReason, 'clerk_buyer'), { orderId: 'orders|1', reason: 'Changed my mind' });
  assert.equal(rowOf(withReason, 'orders', 'orders|1').notes, 'Changed my mind');
});

// createOrder reserves stock, and a cancel must give exactly that stock back. These round trips run the real createOrder,
// then each cancel entry point, against the same fake. A refused order must change nothing.

const SHIPPING = { street: '1 Main Road', city: 'Lusaka', province: 'Lusaka', country: 'Zambia', phone: '0970000000' };

// A mug without variants (4 in stock), and a lamp (10 in stock) in two variants: LAMP-A with 3 and LAMP-B with 7.
function purchaseTables(lampQuantity = 10, stockA = 3, stockB = 7): Tables {
  return {
    users: fixtureTables('pending_payment', 'held').users ?? [],
    platformSettings: [{ _id: 'platformSettings|1', key: 'singleton', companySellerUserId: 'users|company' }],
    products: [
      { _id: 'products|plain', sellerId: 'users|seller', title: 'Mug', quantity: 4, status: 'active' },
      {
        _id: 'products|lamp',
        sellerId: 'users|seller',
        title: 'Lamp',
        quantity: lampQuantity,
        status: 'active',
        variantCombinations: [
          variant('lamp-a', 'LAMP-A', stockA, 'active'),
          variant('lamp-b', 'LAMP-B', stockB, 'active'),
        ],
      },
    ],
    orders: [],
    escrow: [],
    transactions: [],
  };
}

function line(productId: string, quantity: number, extra: Args = {}): Args {
  return { productId, title: 'Item', price: 50, quantity, image: 'https://example.invalid/item.png', ...extra };
}

function variantLine(productId: string, quantity: number, selectedVariant: Args, extra: Args = {}): Args {
  return line(productId, quantity, { selectedVariant, ...extra });
}

// Places the order as checkout does, and returns the new order's id.
function place(db: Db, items: Args[], clerkId: string | null = 'clerk_buyer') {
  return createOrder(createCtx(db, clerkId), {
    sellerId: 'users|seller',
    items,
    subtotal: 100,
    shippingCost: 0,
    shippingAddress: SHIPPING,
  });
}

function storedItems(db: Db): Array<Record<string, unknown>> {
  const items = rowOf(db, 'orders', 'orders|1').items;
  assert.ok(Array.isArray(items), 'the order must carry its items');
  return items;
}

function storedVariantId(db: Db): unknown {
  const selected = storedItems(db)[0]?.selectedVariant;
  return typeof selected === 'object' && selected !== null && 'variantId' in selected ? selected.variantId : undefined;
}

function lampWith(variants: Args[]): Tables {
  const tables = purchaseTables();
  const lamp = tables.products?.find((product) => product._id === 'products|lamp');
  assert.ok(lamp);
  lamp.variantCombinations = variants;
  return tables;
}

test('repeated lines for one variant that together exceed it are refused, and nothing is written', async () => {
  const db = createDb(purchaseTables());
  const before = structuredClone(db.tables);

  await assert.rejects(
    () =>
      place(db, [
        variantLine('products|lamp', 2, chosen('lamp-a', 'LAMP-A'), { customizationKey: 'engraved-left' }),
        variantLine('products|lamp', 2, chosen('lamp-a', 'LAMP-A'), { customizationKey: 'engraved-right' }),
      ]),
    /Insufficient stock for Lamp/,
  );
  assert.deepEqual(db.tables, before, 'a refused order changes nothing');
});

test('repeated lines for a product without variants that together exceed its stock are refused, and nothing is written', async () => {
  const db = createDb(purchaseTables());
  const before = structuredClone(db.tables);

  await assert.rejects(
    () => place(db, [line('products|plain', 3), line('products|plain', 2)]),
    /Insufficient stock for Mug/,
  );
  assert.deepEqual(db.tables, before, 'a refused order changes nothing');
});

test('variant lines must also fit the product total, not only their own variant', async () => {
  const db = createDb(purchaseTables(4));
  const before = structuredClone(db.tables);

  await assert.rejects(
    () =>
      place(db, [
        variantLine('products|lamp', 3, chosen('lamp-a', 'LAMP-A')),
        variantLine('products|lamp', 2, chosen('lamp-b', 'LAMP-B')),
      ]),
    /Insufficient stock for Lamp/,
  );
  assert.deepEqual(db.tables, before, 'a refused order changes nothing');
});

test('repeated variant lines that fit are reserved, and a cancel through either entry point restores every variant exactly', async () => {
  for (const entry of ENTRIES) {
    const db = createDb(purchaseTables());
    const lampBefore = structuredClone(rowOf(db, 'products', 'products|lamp'));

    await place(db, [
      variantLine('products|lamp', 1, chosen('lamp-a', 'LAMP-A')),
      variantLine('products|lamp', 2, chosen('lamp-a', 'LAMP-A')),
    ]);
    assert.equal(combination(db, 'products|lamp', 'lamp-a').stock, 0, `${entry}: the variant is reserved`);
    assert.equal(rowOf(db, 'products', 'products|lamp').quantity, 7, `${entry}: the product total is reserved`);

    await cancelVia(entry, createCtx(db, 'clerk_buyer'), {});

    assert.equal(rowOf(db, 'orders', 'orders|1').status, 'cancelled', entry);
    assert.deepEqual(rowOf(db, 'products', 'products|lamp').variantCombinations, lampBefore.variantCombinations, entry);
    assert.equal(rowOf(db, 'products', 'products|lamp').quantity, lampBefore.quantity, entry);
    assert.equal(rowOf(db, 'products', 'products|lamp').status, 'active', entry);
  }
});

test('distinct customized lines for one variant stay separate, and a cancel restores the variant', async () => {
  for (const entry of ENTRIES) {
    const db = createDb(purchaseTables());
    const lampBefore = structuredClone(rowOf(db, 'products', 'products|lamp'));
    const keys = ['engraved-left', 'engraved-right', 'engraved-centre'];

    await place(
      db,
      keys.map((customizationKey) => variantLine('products|lamp', 1, chosen('lamp-a', 'LAMP-A'), { customizationKey })),
    );
    assert.deepEqual(
      storedItems(db).map((item) => item.customizationKey),
      keys,
      entry,
    );
    assert.equal(combination(db, 'products|lamp', 'lamp-a').stock, 0, entry);

    await cancelVia(entry, createCtx(db, 'clerk_buyer'), {});
    assert.deepEqual(rowOf(db, 'products', 'products|lamp').variantCombinations, lampBefore.variantCombinations, entry);
  }
});

test('lines for distinct variants of one product each reserve their own variant, and a cancel restores both', async () => {
  for (const entry of ENTRIES) {
    const db = createDb(purchaseTables());
    const lampBefore = structuredClone(rowOf(db, 'products', 'products|lamp'));

    await place(db, [
      variantLine('products|lamp', 2, chosen('lamp-a', 'LAMP-A')),
      variantLine('products|lamp', 4, chosen('lamp-b', 'LAMP-B')),
    ]);
    assert.equal(combination(db, 'products|lamp', 'lamp-a').stock, 1, entry);
    assert.equal(combination(db, 'products|lamp', 'lamp-b').stock, 3, entry);

    await cancelVia(entry, createCtx(db, 'clerk_buyer'), {});
    assert.deepEqual(rowOf(db, 'products', 'products|lamp').variantCombinations, lampBefore.variantCombinations, entry);
    assert.equal(rowOf(db, 'products', 'products|lamp').quantity, 10, entry);
  }
});

test('repeated lines for a product without variants that fit its stock reserve it, and a cancel restores it exactly', async () => {
  for (const entry of ENTRIES) {
    const db = createDb(purchaseTables());

    await place(db, [line('products|plain', 1), line('products|plain', 3)]);
    assert.equal(rowOf(db, 'products', 'products|plain').quantity, 0, entry);
    assert.equal(rowOf(db, 'products', 'products|plain').status, 'sold', entry);

    await cancelVia(entry, createCtx(db, 'clerk_buyer'), {});
    assert.equal(rowOf(db, 'products', 'products|plain').quantity, 4, entry);
    assert.equal(rowOf(db, 'products', 'products|plain').status, 'active', entry);
  }
});

test('a line for a product without variants stores no variant, and its cancel raises no stock notice', async () => {
  for (const entry of ENTRIES) {
    const db = createDb(purchaseTables());

    await place(db, [variantLine('products|plain', 2, chosen('stray', 'STRAY-1'))]);
    assert.equal(storedItems(db)[0]?.selectedVariant, undefined, `${entry}: no variant is stored`);

    await cancelVia(entry, createCtx(db, 'clerk_buyer'), {});
    assert.equal(rowOf(db, 'products', 'products|plain').quantity, 4, entry);
    assert.equal(db.tables.notifications?.length ?? 0, 0, `${entry}: a product without variants raises no notice`);
  }
});

test('a variant named only by its sku is reserved from that variant, and a cancel gives it back there', async () => {
  for (const entry of ENTRIES) {
    const db = createDb(purchaseTables());

    await place(db, [variantLine('products|lamp', 2, chosen('no-such-id', 'LAMP-B'))]);
    assert.equal(storedVariantId(db), 'lamp-b', `${entry}: the stored line names the variant it reserved`);
    assert.equal(
      combination(db, 'products|lamp', 'lamp-b').stock,
      5,
      `${entry}: the variant the sku names is reserved`,
    );
    assert.equal(combination(db, 'products|lamp', 'lamp-a').stock, 3, `${entry}: no other variant is touched`);

    await cancelVia(entry, createCtx(db, 'clerk_buyer'), {});
    assert.equal(combination(db, 'products|lamp', 'lamp-b').stock, 7, entry);
    assert.equal(db.tables.notifications?.length ?? 0, 0, `${entry}: nothing needs a manual check`);
  }
});

test('a variant named by its id is the one reserved, even when the sku names another variant', async () => {
  // B is listed first, so a lookup that matched on sku alone would find B before A.
  const db = createDb(lampWith([variant('lamp-b', 'LAMP-B', 7, 'active'), variant('lamp-a', 'LAMP-A', 1, 'active')]));
  const before = structuredClone(db.tables);

  await assert.rejects(
    () => place(db, [variantLine('products|lamp', 2, chosen('lamp-a', 'LAMP-B'))]),
    /Insufficient stock for Lamp/,
  );
  assert.deepEqual(db.tables, before, 'a refused order changes nothing');

  await place(db, [variantLine('products|lamp', 1, chosen('lamp-a', 'LAMP-B'))]);
  assert.equal(storedVariantId(db), 'lamp-a');
  assert.equal(combination(db, 'products|lamp', 'lamp-a').stock, 0);
  assert.equal(combination(db, 'products|lamp', 'lamp-b').stock, 7, 'the variant the sku names is untouched');
});

test('an anonymous, banned, or deleted buyer cannot place an order, and nothing is written', async () => {
  const attempts: Array<{ clerkId: string | null; pattern: RegExp }> = [
    { clerkId: null, pattern: /Unauthenticated/ },
    { clerkId: 'clerk_banned', pattern: /Account is banned/ },
    { clerkId: 'clerk_deleted', pattern: /Account is deleted/ },
  ];
  for (const { clerkId, pattern } of attempts) {
    const db = createDb(purchaseTables());
    const before = structuredClone(db.tables);

    await assert.rejects(
      () => place(db, [variantLine('products|lamp', 1, chosen('lamp-a', 'LAMP-A'))], clerkId),
      pattern,
      String(clerkId),
    );
    assert.deepEqual(db.tables, before, `${clerkId} must change nothing`);
  }
});

test('a variant line must name a variant that is active and in stock', async () => {
  const inactive = createDb(
    lampWith([variant('lamp-a', 'LAMP-A', 3, 'inactive'), variant('lamp-b', 'LAMP-B', 7, 'active')]),
  );
  const inactiveBefore = structuredClone(inactive.tables);
  await assert.rejects(
    () => place(inactive, [variantLine('products|lamp', 1, chosen('lamp-a', 'LAMP-A'))]),
    /is out of stock/,
  );
  assert.deepEqual(inactive.tables, inactiveBefore);

  const unnamed = createDb(purchaseTables());
  const unnamedBefore = structuredClone(unnamed.tables);
  await assert.rejects(() => place(unnamed, [line('products|lamp', 1)]), /Select a variant for Lamp/);
  assert.deepEqual(unnamed.tables, unnamedBefore);
});

test('an order that is placed and then cancelled cannot be cancelled again, and its stock comes back once', async () => {
  for (const first of ENTRIES) {
    const db = createDb(purchaseTables());
    await place(db, [variantLine('products|lamp', 3, chosen('lamp-a', 'LAMP-A')), line('products|plain', 4)]);

    await cancelVia(first, createCtx(db, 'clerk_buyer'), {});
    const afterFirst = structuredClone(db.tables);

    for (const second of ENTRIES) {
      await assert.rejects(
        () => cancelVia(second, createCtx(db, 'clerk_buyer'), {}),
        /cannot be cancelled|Cannot transition/,
        `${second} after ${first}`,
      );
      assert.deepEqual(db.tables, afterFirst, `${second} after ${first} must change nothing`);
    }
    assert.equal(combination(db, 'products|lamp', 'lamp-a').stock, 3, `${first}: the variant comes back once`);
    assert.equal(rowOf(db, 'products', 'products|plain').quantity, 4, `${first}: the product comes back once`);
  }
});
