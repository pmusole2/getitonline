import assert from 'node:assert/strict';
import test from 'node:test';

import * as aiDiscoveryData from './aiDiscoveryData';
import { createCtx, createDb, type Row, type Tables } from '../tests/support/convexFakeDb';
import { invokeFakeFunction } from '../tests/support/convexFakeActionCtx';

// These tests run the real internal queries over the in-memory fake db. Each query returns only public product fields,
// only active products from public sellers, and only the caller's own interests and category activity.

const INDEXES = {
  users: { by_clerk_id: ['clerkId'] },
  products: { by_status_created: ['status', 'createdAt'], by_seller: ['sellerId'] },
  behaviorEvents: { by_user_created: ['userId', 'createdAt'] },
  platformSettings: { by_key: ['key'] },
  vendorProfiles: { by_owner: ['ownerUserId'] },
};

const PUBLIC_FIELDS = ['category', 'categoryId', 'condition', 'id', 'price', 'title'];

function product(id: string, fields: Record<string, unknown>): Row {
  return {
    _id: id,
    status: 'active',
    sellerId: 'users|9',
    price: 1500,
    condition: 'good',
    categoryId: 'categories|1',
    createdAt: 1,
    brand: 'Samsung',
    images: ['https://cdn.example.com/p.jpg'],
    shortDescription: 'Short blurb',
    description: 'SENTINEL_NOTE private seller description',
    quantity: 3,
    ...fields,
  };
}

// users|9 is the company seller (public). users|7 is an approved vendor (public). users|8 is an unapproved seller (private).
function seed(): Tables {
  return {
    users: [
      { _id: 'users|1', clerkId: 'clerk_buyer', role: 'buyer', isBanned: false, interests: ['categories|1'] },
      {
        _id: 'users|2',
        clerkId: 'clerk_other',
        role: 'buyer',
        isBanned: false,
        email: 'SENTINEL_EMAIL@example.com',
        interests: ['categories|3'],
      },
      { _id: 'users|7', clerkId: 'clerk_vendor', role: 'seller', isBanned: false },
      { _id: 'users|8', clerkId: 'clerk_hidden', role: 'seller', isBanned: false },
      { _id: 'users|9', clerkId: 'clerk_company', role: 'admin', isBanned: false },
    ],
    platformSettings: [
      {
        _id: 'platformSettings|1',
        key: 'singleton',
        companySellerUserId: 'users|9',
        companyDisplayName: 'Gettitonline',
      },
    ],
    vendorProfiles: [{ _id: 'vendorProfiles|1', ownerUserId: 'users|7', status: 'approved' }],
    categories: [
      { _id: 'categories|1', name: 'Electronics' },
      { _id: 'categories|2', name: 'Auto Parts' },
      { _id: 'categories|3', name: 'Fashion' },
    ],
    products: [
      product('products|1', { title: 'Samsung Galaxy phone', createdAt: 3 }),
      product('products|2', { title: 'Brake pads set', categoryId: 'categories|2', createdAt: 2 }),
      product('products|3', { title: 'Old phone', status: 'inactive', createdAt: 9 }),
      product('products|4', { title: 'SENTINEL_HIDDEN_TITLE', sellerId: 'users|8', createdAt: 8 }),
      product('products|5', {
        title: 'Vendor lamp',
        sellerId: 'users|7',
        categoryId: 'categories|3',
        createdAt: 5,
      }),
      product('products|6', { title: 'Phone case', createdAt: 6 }),
    ],
    behaviorEvents: [
      {
        _id: 'behaviorEvents|1',
        userId: 'users|1',
        eventType: 'product_view',
        categoryId: 'categories|1',
        createdAt: 1,
      },
      { _id: 'behaviorEvents|2', userId: 'users|1', eventType: 'purchase', categoryId: 'categories|2', createdAt: 2 },
      { _id: 'behaviorEvents|3', userId: 'users|2', eventType: 'purchase', categoryId: 'categories|3', createdAt: 3 },
    ],
  };
}

type Args = Record<string, unknown>;

// Runs an internal query the way the runtime does: the argument validator is checked before the handler.
function run(query: unknown, db: ReturnType<typeof createDb>, args: Args): Promise<unknown> {
  return invokeFakeFunction(query, createCtx(db, null), args);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordsOf(value: unknown): Array<Record<string, unknown>> {
  assert.ok(Array.isArray(value));
  const items: unknown[] = value;
  return items.map((item) => {
    assert.ok(isRecord(item));
    return item;
  });
}

function stringsOf(value: unknown): string[] {
  assert.ok(Array.isArray(value));
  const items: unknown[] = value;
  return items.map((item) => {
    assert.equal(typeof item, 'string');
    return String(item);
  });
}

function idsOf(candidates: unknown): string[] {
  return recordsOf(candidates).map((candidate) => String(candidate.id));
}

type RecommendationContext = {
  candidates: Array<Record<string, unknown>>;
  interests: string[];
  recentlyViewed: string[];
  purchases: string[];
};

function contextOf(value: unknown): RecommendationContext {
  assert.ok(isRecord(value));
  return {
    candidates: recordsOf(value.candidates),
    interests: stringsOf(value.interests),
    recentlyViewed: stringsOf(value.recentlyViewed),
    purchases: stringsOf(value.purchases),
  };
}

function similarOf(value: unknown): {
  source: Record<string, unknown> | null;
  candidates: Array<Record<string, unknown>>;
} {
  assert.ok(isRecord(value));
  const source = value.source;
  assert.ok(source === null || isRecord(source));
  return { source, candidates: recordsOf(value.candidates) };
}

test('recommendation candidates are active public products from other sellers, newest first', async () => {
  const db = createDb(seed(), INDEXES);
  const context = contextOf(
    await run(aiDiscoveryData.recommendationContext, db, {
      userId: 'users|1',
    }),
  );

  assert.deepEqual(idsOf(context.candidates), ['products|6', 'products|5', 'products|1', 'products|2']);
});

test('candidates expose only public product fields and never seller, description, or contact data', async () => {
  const db = createDb(seed(), INDEXES);
  const context = contextOf(
    await run(aiDiscoveryData.recommendationContext, db, {
      userId: 'users|1',
    }),
  );

  for (const candidate of context.candidates) {
    assert.deepEqual(Object.keys(candidate).sort(), PUBLIC_FIELDS);
  }
  const serialized = JSON.stringify(context);
  assert.ok(!serialized.includes('SENTINEL'));
  assert.ok(!serialized.includes('users|9'));
});

test('an account never receives its own listings as candidates', async () => {
  const db = createDb(seed(), INDEXES);
  const context = contextOf(
    await run(aiDiscoveryData.recommendationContext, db, {
      userId: 'users|7',
    }),
  );

  assert.deepEqual(idsOf(context.candidates), ['products|6', 'products|1', 'products|2']);
});

test('recommendation candidates are capped at 50 and keep the newest first', async () => {
  const tables = seed();
  for (let index = 0; index < 60; index += 1) {
    tables.products?.push(product(`products|${1000 + index}`, { title: `Bulk ${index}`, createdAt: 100 + index }));
  }
  const db = createDb(tables, INDEXES);
  const context = contextOf(
    await run(aiDiscoveryData.recommendationContext, db, {
      userId: 'users|1',
    }),
  );

  const ids = idsOf(context.candidates);
  assert.equal(ids.length, 50);
  assert.equal(ids[0], 'products|1059');
});

test('interests and category activity come from the caller only, as category names', async () => {
  const db = createDb(seed(), INDEXES);
  const context = contextOf(
    await run(aiDiscoveryData.recommendationContext, db, {
      userId: 'users|1',
    }),
  );

  assert.deepEqual(context.interests, ['Electronics']);
  assert.deepEqual(context.recentlyViewed, ['Electronics']);
  assert.deepEqual(context.purchases, ['Auto Parts']);
  assert.ok(!JSON.stringify(context.interests).includes('Fashion'));
});

test('interest names are capped at 20 and unknown category IDs are skipped', async () => {
  const tables = seed();
  tables.categories = [
    ...(tables.categories ?? []),
    ...Array.from({ length: 25 }, (_, index) => ({ _id: `categories|${100 + index}`, name: `Cat ${index}` })),
  ];
  const buyer = tables.users?.find((user) => user._id === 'users|1');
  if (buyer) {
    buyer.interests = ['categories|404', ...Array.from({ length: 25 }, (_, index) => `categories|${100 + index}`)];
  }
  const db = createDb(tables, INDEXES);
  const context = contextOf(
    await run(aiDiscoveryData.recommendationContext, db, {
      userId: 'users|1',
    }),
  );

  assert.equal(context.interests.length, 20);
  assert.equal(context.interests[0], 'Cat 0');
  assert.ok(!context.interests.includes('categories|404'));
});

test('similar products return the public source and the other public candidates, newest first', async () => {
  const db = createDb(seed(), INDEXES);
  const similar = similarOf(await run(aiDiscoveryData.similarContext, db, { productId: 'products|1' }));

  assert.equal(similar.source?.id, 'products|1');
  assert.deepEqual(idsOf(similar.candidates), ['products|6', 'products|5', 'products|2']);
  for (const candidate of similar.candidates) {
    assert.deepEqual(Object.keys(candidate).sort(), PUBLIC_FIELDS);
  }
});

for (const productId of ['products|3', 'products|4', 'products|404']) {
  test(`${productId} is not a visible source, so no candidates are returned`, async () => {
    const db = createDb(seed(), INDEXES);
    const similar = await run(aiDiscoveryData.similarContext, db, { productId });

    assert.deepEqual(similar, { source: null, candidates: [] });
  });
}

test('similar candidates are capped at 30', async () => {
  const tables = seed();
  for (let index = 0; index < 60; index += 1) {
    tables.products?.push(product(`products|${1000 + index}`, { title: `Bulk ${index}`, createdAt: 100 + index }));
  }
  const db = createDb(tables, INDEXES);
  const similar = similarOf(await run(aiDiscoveryData.similarContext, db, { productId: 'products|1' }));

  assert.equal(similar.candidates.length, 30);
});

test('eligibleProducts returns only the IDs that are active and from public sellers right now', async () => {
  const db = createDb(seed(), INDEXES);
  const eligible = await run(aiDiscoveryData.eligibleProducts, db, {
    productIds: ['products|1', 'products|3', 'products|4', 'products|5', 'products|404'],
  });

  assert.deepEqual(eligible, ['products|1', 'products|5']);
});

test('eligibleProducts drops a product that has gone draft or moved to a private seller since it was shown', async () => {
  const db = createDb(seed(), INDEXES);
  const productIds = ['products|1', 'products|5'];
  const row = (id: string): Row | undefined => (db.tables.products ?? []).find((candidate) => candidate._id === id);
  Object.assign(row('products|1') ?? {}, { status: 'draft' });
  Object.assign(row('products|5') ?? {}, { sellerId: 'users|8' });

  assert.deepEqual(await run(aiDiscoveryData.eligibleProducts, db, { productIds }), []);
});

test('eligibleProducts rejects a product ID from another table before any read', async () => {
  const db = createDb(seed(), INDEXES);

  await assert.rejects(
    run(aiDiscoveryData.eligibleProducts, db, { productIds: ['users|1'] }),
    /Argument validation failed/,
  );
});
