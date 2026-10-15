import assert from 'node:assert/strict';
import test from 'node:test';

import * as aiData from './aiData';
import { createCtx, createDb, handlerOf, type Db, type Row, type Tables } from '../tests/support/convexFakeDb';

// These tests run the real internal queries over the in-memory fake db. The context must hold public catalog facts and,
// for authenticated accounts only, aggregate counts. Private order, address, contact, and message data must never appear.

const INDEXES = {
  users: { by_clerk_id: ['clerkId'] },
  products: { by_status_created: ['status', 'createdAt'], by_seller: ['sellerId'] },
  orders: { by_buyer: ['buyerId'], by_seller: ['sellerId'] },
  cartItems: { by_user: ['userId'] },
  platformSettings: { by_key: ['key'] },
  vendorProfiles: { by_owner: ['ownerUserId'] },
};

const SENTINELS = ['SENTINEL_STREET', 'SENTINEL_PHONE', 'SENTINEL_EMAIL', 'SENTINEL_NOTE', 'SENTINEL_MESSAGE'];

const resolveChatAccount = handlerOf<{ clerkId: string }, unknown>(aiData.resolveChatAccount);
const chatContext = handlerOf<Record<string, unknown>, unknown>(aiData.chatContext);

function user(id: string, clerkId: string, fields: Record<string, unknown> = {}): Row {
  return { _id: id, clerkId, role: 'buyer', isBanned: false, firstName: 'Ada', lastName: 'Buyer', ...fields };
}

function product(id: string, fields: Record<string, unknown>): Row {
  return {
    _id: id,
    status: 'active',
    sellerId: 'users|9',
    price: 1500,
    condition: 'good',
    categoryId: 'categories|1',
    createdAt: 1,
    images: ['https://cdn.example.com/p.jpg'],
    shortDescription: 'Short phone blurb',
    description: 'Long phone description',
    ...fields,
  };
}

function seed(): Tables {
  return {
    users: [
      user('users|1', 'clerk_buyer', { email: 'SENTINEL_EMAIL@example.com' }),
      user('users|8', 'clerk_hidden_seller', { role: 'seller' }),
      user('users|9', 'clerk_company', { role: 'admin' }),
      user('users|10', 'clerk_banned', { isBanned: true }),
      user('users|11', 'clerk_deleted', { deletedAt: 5 }),
    ],
    platformSettings: [
      {
        _id: 'platformSettings|1',
        key: 'singleton',
        companySellerUserId: 'users|9',
        companyDisplayName: 'Gettitonline',
      },
    ],
    categories: [
      { _id: 'categories|1', name: 'Electronics', slug: 'electronics' },
      { _id: 'categories|2', name: 'Auto Parts', slug: 'auto-parts' },
    ],
    products: [
      product('products|1', { title: 'Samsung Galaxy phone', createdAt: 3 }),
      product('products|2', { title: 'Brake pads set', categoryId: 'categories|2', createdAt: 2 }),
      product('products|3', { title: 'Old phone', status: 'inactive' }),
      product('products|4', { title: 'Hidden phone', sellerId: 'users|8' }),
      product('products|5', { title: 'My listing', sellerId: 'users|1', createdAt: 4 }),
      product('products|6', { title: 'My paused listing', sellerId: 'users|1', status: 'inactive', createdAt: 0 }),
    ],
    orders: [
      {
        _id: 'orders|1',
        buyerId: 'users|1',
        sellerId: 'users|9',
        status: 'paid',
        shippingAddress: { street: 'SENTINEL_STREET 12', city: 'Lusaka', phone: 'SENTINEL_PHONE' },
        notes: 'SENTINEL_NOTE',
      },
      { _id: 'orders|2', buyerId: 'users|1', sellerId: 'users|9', status: 'delivered', notes: '' },
      { _id: 'orders|3', buyerId: 'users|1', sellerId: 'users|9', status: 'disputed', notes: '' },
      { _id: 'orders|4', buyerId: 'users|2', sellerId: 'users|9', status: 'paid', notes: '' },
      { _id: 'orders|5', buyerId: 'users|8', sellerId: 'users|1', status: 'shipped', notes: '' },
    ],
    cartItems: [
      { _id: 'cartItems|1', userId: 'users|1', productId: 'products|1', quantity: 2 },
      { _id: 'cartItems|2', userId: 'users|1', productId: 'products|2', quantity: 1 },
    ],
    messages: [{ _id: 'messages|1', content: 'SENTINEL_MESSAGE', senderId: 'users|1' }],
    aiUsage: [],
  };
}

function newDb(tables: Tables = seed()): Db {
  return createDb(tables, INDEXES);
}

type OrderCountsResult = { total: number; pending: number; completed: number; disputed: number; truncated: boolean };

type ContextResult = {
  catalog: {
    activeListingCount: number;
    truncated: boolean;
    categories: Array<{ name: string; count: number }>;
    matches: Array<{ title: string }>;
    recent: Array<{ title: string }>;
  };
  product: { title: string; price: number; category: string; condition: string; description: string } | null;
  account: {
    orders: OrderCountsResult | null;
    sellerOrders: OrderCountsResult | null;
    listings: { total: number; active: number; truncated: boolean } | null;
    cart: { items: number; truncated: boolean } | null;
  } | null;
};

async function contextFor(db: Db, args: Record<string, unknown>): Promise<ContextResult> {
  return (await chatContext(createCtx(db, null), args)) as ContextResult;
}

test('resolveChatAccount returns the verified active account id', async () => {
  const result = await resolveChatAccount(createCtx(newDb(), null), { clerkId: 'clerk_buyer' });

  assert.deepEqual(result, { ok: true, userId: 'users|1' });
});

for (const [clerkId, reason] of [
  ['clerk_banned', 'banned'],
  ['clerk_deleted', 'deleted'],
  ['clerk_nobody', 'unknown_user'],
] as const) {
  test(`resolveChatAccount refuses ${reason} accounts`, async () => {
    const result = await resolveChatAccount(createCtx(newDb(), null), { clerkId });

    assert.deepEqual(result, { ok: false, reason });
  });
}

test('a guest context holds public catalog facts only and no account data', async () => {
  const context = await contextFor(newDb(), { caller: { kind: 'guest' }, message: 'Do you have phones?' });

  assert.equal(context.account, null);
  assert.deepEqual(
    context.catalog.matches.map((item) => item.title),
    ['Samsung Galaxy phone'],
  );
  assert.equal(context.catalog.activeListingCount, 2);
  assert.equal(context.catalog.truncated, false);
  assert.deepEqual(context.catalog.categories, [
    { name: 'Auto Parts', count: 1 },
    { name: 'Electronics', count: 1 },
  ]);
});

test('a guest context never contains account data even when the message asks about orders', async () => {
  const context = await contextFor(newDb(), {
    caller: { kind: 'guest' },
    message: 'How many orders do I have? my cart and my dispute',
  });
  const serialized = JSON.stringify(context);

  assert.equal(context.account, null);
  assert.ok(SENTINELS.every((sentinel) => !serialized.includes(sentinel)));
});

test('a public product context is returned only for an active product from a public seller', async () => {
  const db = newDb();
  const shown = await contextFor(db, { caller: { kind: 'guest' }, message: 'tell me', productId: 'products|1' });
  const inactive = await contextFor(db, { caller: { kind: 'guest' }, message: 'tell me', productId: 'products|3' });
  const hidden = await contextFor(db, { caller: { kind: 'guest' }, message: 'tell me', productId: 'products|4' });
  const missing = await contextFor(db, { caller: { kind: 'guest' }, message: 'tell me', productId: 'products|99' });

  assert.deepEqual(shown.product, {
    id: 'products|1',
    title: 'Samsung Galaxy phone',
    price: 1500,
    category: 'Electronics',
    condition: 'good',
    description: 'Long phone description',
  });
  assert.equal(inactive.product, null);
  assert.equal(hidden.product, null);
  assert.equal(missing.product, null);
});

test('an authenticated account gets aggregate order counts for its own orders only', async () => {
  const context = await contextFor(newDb(), {
    caller: { kind: 'account', userId: 'users|1' },
    message: 'How many orders do I have?',
  });

  assert.deepEqual(context.account?.orders, { total: 3, pending: 1, completed: 1, disputed: 1, truncated: false });
  assert.deepEqual(context.account?.sellerOrders, {
    total: 1,
    pending: 1,
    completed: 0,
    disputed: 0,
    truncated: false,
  });
  assert.equal(context.account?.listings, null);
  assert.equal(context.account?.cart, null);
});

test('an authenticated account gets seller order counts for orders it sells', async () => {
  const context = await contextFor(newDb(), {
    caller: { kind: 'account', userId: 'users|8' },
    message: 'Any orders for me?',
  });

  assert.deepEqual(context.account?.sellerOrders, {
    total: 0,
    pending: 0,
    completed: 0,
    disputed: 0,
    truncated: false,
  });
  const seller = await contextFor(newDb(), {
    caller: { kind: 'account', userId: 'users|1' },
    message: 'Any orders for me?',
  });
  assert.deepEqual(seller.account?.sellerOrders, {
    total: 1,
    pending: 1,
    completed: 0,
    disputed: 0,
    truncated: false,
  });
});

test('an authenticated account gets listing counts for its own products when it asks about listings', async () => {
  const context = await contextFor(newDb(), {
    caller: { kind: 'account', userId: 'users|1' },
    message: 'How many of my listings are active?',
  });

  assert.deepEqual(context.account?.listings, { total: 2, active: 1, truncated: false });
});

test('an authenticated account gets the total cart quantity only when it asks about the cart', async () => {
  const asked = await contextFor(newDb(), {
    caller: { kind: 'account', userId: 'users|1' },
    message: 'What is in my cart?',
  });
  const notAsked = await contextFor(newDb(), {
    caller: { kind: 'account', userId: 'users|1' },
    message: 'Do you have phones?',
  });

  assert.deepEqual(asked.account?.cart, { items: 3, truncated: false });
  assert.equal(notAsked.account?.cart, null);
});

test('an authenticated account context never contains private order details', async () => {
  const context = await contextFor(newDb(), {
    caller: { kind: 'account', userId: 'users|1' },
    message: 'Show my orders, cart, listings and dispute details',
  });
  const serialized = JSON.stringify(context);

  assert.ok(SENTINELS.every((sentinel) => !serialized.includes(sentinel)));
  assert.ok(!serialized.includes('shippingAddress'));
  assert.ok(!serialized.includes('SENTINEL_EMAIL'));
});

test('catalog matches and recent items are capped at ten each', async () => {
  const tables = seed();
  tables.products = [
    ...(tables.products ?? []),
    ...Array.from({ length: 12 }, (_, index) =>
      product(`products|${100 + index}`, { title: `Phone model ${index}`, createdAt: 10 + index }),
    ),
  ];
  const context = await contextFor(newDb(tables), { caller: { kind: 'guest' }, message: 'phone' });

  assert.equal(context.catalog.matches.length, 10);
  assert.equal(context.catalog.recent.length, 10);
});

test('a sampled listing scan is flagged as truncated and counts only the newest 200 listings', async () => {
  const tables = seed();
  tables.products = [
    ...(tables.products ?? []),
    ...Array.from({ length: 200 }, (_, index) =>
      product(`products|${200 + index}`, { title: `Lamp ${index}`, createdAt: 10 + index }),
    ),
  ];
  const context = await contextFor(newDb(tables), { caller: { kind: 'guest' }, message: 'Do you have lamps?' });

  assert.equal(context.catalog.truncated, true);
  assert.equal(context.catalog.activeListingCount, 200);
});

test('a sampled order scan is flagged as truncated and counts only the newest 500 orders', async () => {
  const tables = seed();
  tables.orders = [
    ...(tables.orders ?? []),
    ...Array.from({ length: 500 }, (_, index) => ({
      _id: `orders|${100 + index}`,
      buyerId: 'users|1',
      sellerId: 'users|9',
      status: 'paid',
      notes: '',
    })),
  ];
  const context = await contextFor(newDb(tables), {
    caller: { kind: 'account', userId: 'users|1' },
    message: 'How many orders do I have?',
  });

  assert.deepEqual(context.account?.orders, { total: 500, pending: 500, completed: 0, disputed: 0, truncated: true });
});
