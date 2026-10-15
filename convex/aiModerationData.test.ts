import assert from 'node:assert/strict';
import test from 'node:test';

import * as aiModerationData from './aiModerationData';
import { MODERATION_LIMITS, listingRevision } from './lib/aiModerationPolicy';
import { createDb, createCtx, type Db, type Row, type Tables } from '../tests/support/convexFakeDb';
import { invokeFakeFunction, validateArgs } from '../tests/support/convexFakeActionCtx';

// The two internal functions behind listing moderation. Neither is reachable from a client, the reviewer is checked again
// on every call, and the save is refused when the listing has changed since the action read it.

const INDEXES = { users: { by_clerk_id: ['clerkId'] } };
const PRODUCT = 'products|1';
// The revision of the seeded listing: its updatedAt, then every field the model reviewed, each with its type tag.
const SEED_REVISION =
  '[["n","100"],["s","Samsung Galaxy phone"],["s","Sealed box, good battery"],["n","1500"],["n","2"],["s","categories|1"],["s","Phones"],["a",[["s","https://cdn.example.com/1.jpg"],["s","https://cdn.example.com/2.jpg"]]],["s","pending"]]';

function user(id: string, clerkId: string, fields: Record<string, unknown> = {}): Row {
  return { _id: id, clerkId, role: 'user', isBanned: false, firstName: 'Test', lastName: 'User', ...fields };
}

function seed(): Tables {
  return {
    users: [
      user('users|1', 'clerk_buyer'),
      user('users|2', 'clerk_seller'),
      user('users|3', 'clerk_catalog', { role: 'catalog_manager' }),
      user('users|4', 'clerk_moderator', { role: 'moderator' }),
      user('users|5', 'clerk_admin', { role: 'admin' }),
      user('users|6', 'clerk_banned_admin', { role: 'admin', isBanned: true }),
      user('users|7', 'clerk_deleted_admin', { role: 'admin', deletedAt: 5 }),
    ],
    products: [
      {
        _id: PRODUCT,
        sellerId: 'users|2',
        title: 'Samsung Galaxy phone',
        description: 'Sealed box, good battery',
        price: 1500,
        quantity: 2,
        images: ['https://cdn.example.com/1.jpg', 'https://cdn.example.com/2.jpg'],
        categoryId: 'categories|1',
        status: 'pending',
        createdAt: 1,
        updatedAt: 100,
      },
    ],
    categories: [{ _id: 'categories|1', name: 'Phones', slug: 'phones' }],
    aiUsage: [],
  };
}

type Traced = { db: Db; reads: string[] };

function open(tables: Tables = seed()): Traced {
  const db = createDb(tables, INDEXES);
  const reads: string[] = [];
  const get = db.get;
  const query = db.query;
  db.get = async (id: string) => {
    reads.push(`get:${id}`);
    return await get(id);
  };
  db.query = (table: string) => {
    reads.push(`query:${table}`);
    return query(table);
  };
  return { db, reads };
}

function row(db: Db, table: string, id: string): Row {
  const found = db.tables[table]?.find((candidate) => candidate._id === id);
  assert.ok(found, `${id} must exist`);
  return found;
}

function recordOf(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected an object result');
  }
  return Object.fromEntries(Object.entries(value));
}

function firstProduct(tables: Tables): Row {
  const found = tables.products?.[0];
  if (!found) {
    throw new Error('the seed has no product');
  }
  return found;
}

function productReads(reads: string[]): string[] {
  return reads.filter((read) => read.startsWith('get:products|') || read === 'query:products');
}

const SAVE_ARGS = {
  productId: PRODUCT,
  revision: SEED_REVISION,
  status: 'clear' as const,
  summary: 'The listing has a clear title and price.',
  flags: ['weak_images'],
};

test('saveModerationResult and listingForModeration are internal, so no client can call them', () => {
  for (const [name, fn] of [
    ['saveModerationResult', aiModerationData.saveModerationResult],
    ['listingForModeration', aiModerationData.listingForModeration],
  ] as const) {
    assert.equal(Reflect.get(fn, 'isInternal'), true, `${name} must be internal`);
    assert.notEqual(Reflect.get(fn, 'isPublic'), true, `${name} must not be public`);
  }
});

test('saveModerationResult saves a clear result for a current moderator and leaves the listing revision unchanged', async () => {
  const { db } = open();
  const result = await invokeFakeFunction(aiModerationData.saveModerationResult, createCtx(db, null), {
    ...SAVE_ARGS,
    reviewerId: 'users|4',
  });
  assert.deepEqual(recordOf(result), { saved: true });
  const saved = row(db, 'products', PRODUCT);
  assert.equal(saved.aiModerationStatus, 'clear');
  assert.equal(saved.aiModerationSummary, SAVE_ARGS.summary);
  assert.deepEqual(saved.aiModerationFlags, ['weak_images']);
  assert.equal(saved.updatedAt, 100, 'moderation metadata is not a listing edit');
});

test('saveModerationResult saves a flagged result for an admin', async () => {
  const { db } = open();
  const result = await invokeFakeFunction(aiModerationData.saveModerationResult, createCtx(db, null), {
    ...SAVE_ARGS,
    status: 'flagged',
    reviewerId: 'users|5',
  });
  assert.deepEqual(recordOf(result), { saved: true });
  assert.equal(row(db, 'products', PRODUCT).aiModerationStatus, 'flagged');
});

const NON_REVIEWERS: Array<{ label: string; reviewerId: string; reason: string }> = [
  { label: 'a buyer', reviewerId: 'users|1', reason: 'forbidden' },
  { label: 'the seller who owns the listing', reviewerId: 'users|2', reason: 'forbidden' },
  { label: 'a catalog manager', reviewerId: 'users|3', reason: 'forbidden' },
  { label: 'a banned admin', reviewerId: 'users|6', reason: 'forbidden' },
  { label: 'a deleted admin', reviewerId: 'users|7', reason: 'forbidden' },
  { label: 'an id that is not a user', reviewerId: 'users|99', reason: 'forbidden' },
];

for (const { label, reviewerId, reason } of NON_REVIEWERS) {
  test(`saveModerationResult refuses ${label} and writes nothing`, async () => {
    const { db } = open();
    const before = structuredClone(db.tables);
    const result = await invokeFakeFunction(aiModerationData.saveModerationResult, createCtx(db, null), {
      ...SAVE_ARGS,
      reviewerId,
    });
    assert.deepEqual(recordOf(result), { saved: false, reason });
    assert.deepEqual(db.tables, before);
  });
}

test('saveModerationResult refuses a revision that no longer matches the listing, and writes nothing', async () => {
  const { db } = open();
  row(db, 'products', PRODUCT).updatedAt = 250;
  const before = structuredClone(db.tables);
  const result = await invokeFakeFunction(aiModerationData.saveModerationResult, createCtx(db, null), {
    ...SAVE_ARGS,
    reviewerId: 'users|4',
  });
  assert.deepEqual(recordOf(result), { saved: false, reason: 'stale' });
  assert.deepEqual(db.tables, before);
});

test('saveModerationResult refuses a listing that no longer exists, and writes nothing', async () => {
  const tables = seed();
  tables.products = [];
  const { db } = open(tables);
  const result = await invokeFakeFunction(aiModerationData.saveModerationResult, createCtx(db, null), {
    ...SAVE_ARGS,
    reviewerId: 'users|4',
  });
  assert.deepEqual(recordOf(result), { saved: false, reason: 'not_found' });
  assert.deepEqual(db.tables.products, []);
});

test('saveModerationResult refuses a summary over its cap or flags over their cap, and writes nothing', async () => {
  const cases: Array<{ label: string; fields: Record<string, unknown> }> = [
    { label: 'an oversized summary', fields: { summary: 'S'.repeat(MODERATION_LIMITS.summaryLength + 1) } },
    { label: 'an empty summary', fields: { summary: '' } },
    { label: 'too many flags', fields: { flags: Array.from({ length: 11 }, (_, i) => `flag_${i}`) } },
    { label: 'a flag that is not a snake_case token', fields: { flags: ['Not Valid'] } },
  ];
  for (const { label, fields } of cases) {
    const { db } = open();
    const before = structuredClone(db.tables);
    const result = await invokeFakeFunction(aiModerationData.saveModerationResult, createCtx(db, null), {
      ...SAVE_ARGS,
      ...fields,
      reviewerId: 'users|4',
    });
    assert.deepEqual(recordOf(result), { saved: false, reason: 'invalid_output' }, label);
    assert.deepEqual(db.tables, before, `${label} writes nothing`);
  }
});

test('saveModerationResult cannot write an error status: the validator rejects it before the handler runs', async () => {
  const { db } = open();
  const before = structuredClone(db.tables);
  await assert.rejects(
    invokeFakeFunction(aiModerationData.saveModerationResult, createCtx(db, null), {
      ...SAVE_ARGS,
      status: 'error',
      reviewerId: 'users|4',
    }),
    /Argument validation failed/,
  );
  assert.deepEqual(db.tables, before);
});

test('saveModerationResult takes no client identity fields beyond the reviewer id', () => {
  assert.throws(
    () =>
      validateArgs(
        aiModerationData.saveModerationResult,
        { ...SAVE_ARGS, reviewerId: 'users|4', userId: 'users|4' },
        'save',
      ),
    /Argument validation failed/,
  );
});

test('listingForModeration returns the stored listing and its revision to a moderator', async () => {
  const { db, reads } = open();
  const result = await invokeFakeFunction(aiModerationData.listingForModeration, createCtx(db, null), {
    userId: 'users|4',
    productId: PRODUCT,
  });
  assert.deepEqual(recordOf(result), {
    ok: true,
    revision: SEED_REVISION,
    updatedAt: 100,
    listing: {
      title: 'Samsung Galaxy phone',
      description: 'Sealed box, good battery',
      price: 1500,
      quantity: 2,
      imageUrls: ['https://cdn.example.com/1.jpg', 'https://cdn.example.com/2.jpg'],
      imageCount: 2,
      categoryName: 'Phones',
    },
  });
  assert.ok(productReads(reads).length > 0, 'the moderator path reads the listing');
});

for (const { label, reviewerId } of NON_REVIEWERS) {
  test(`listingForModeration refuses ${label} before reading the listing`, async () => {
    const { db, reads } = open();
    const result = await invokeFakeFunction(aiModerationData.listingForModeration, createCtx(db, null), {
      userId: reviewerId,
      productId: PRODUCT,
    });
    assert.deepEqual(recordOf(result), { ok: false, code: 'forbidden' });
    assert.deepEqual(productReads(reads), [], 'no listing read happens before the reviewer check');
  });
}

test('listingForModeration returns not_found for a listing that does not exist', async () => {
  const tables = seed();
  tables.products = [];
  const { db } = open(tables);
  const result = await invokeFakeFunction(aiModerationData.listingForModeration, createCtx(db, null), {
    userId: 'users|4',
    productId: PRODUCT,
  });
  assert.deepEqual(recordOf(result), { ok: false, code: 'not_found' });
});

test('listingForModeration caps stored text and counts every image', async () => {
  const tables = seed();
  firstProduct(tables).title = '#'.repeat(500);
  firstProduct(tables).description = '#'.repeat(5000);
  firstProduct(tables).images = Array.from({ length: 12 }, (_, i) => `https://cdn.example.com/${i}.jpg`);
  const { db } = open(tables);
  const result = recordOf(
    await invokeFakeFunction(aiModerationData.listingForModeration, createCtx(db, null), {
      userId: 'users|4',
      productId: PRODUCT,
    }),
  );
  const listing = recordOf(result.listing);
  assert.equal(listing.title, '#'.repeat(MODERATION_LIMITS.titleLength));
  assert.equal(listing.description, '#'.repeat(MODERATION_LIMITS.descriptionLength));
  assert.equal(listing.imageCount, 12);
  assert.equal(Array.isArray(listing.imageUrls) ? listing.imageUrls.length : -1, MODERATION_LIMITS.imageUrlCount);
});

// ---------------------------------------------------------------------------------------------------------------------
// The revision covers the content the model reviewed, not only updatedAt. A change to any reviewed field makes the save
// stale even when updatedAt has not moved, which Convex does not guarantee.
// ---------------------------------------------------------------------------------------------------------------------

const REVIEWED_CHANGES: Array<{ label: string; change: (db: Db) => void }> = [
  { label: 'the title', change: (db) => (row(db, 'products', PRODUCT).title = 'Samsung Galaxy phone, sealed') },
  { label: 'the description', change: (db) => (row(db, 'products', PRODUCT).description = 'Screen cracked') },
  { label: 'the price', change: (db) => (row(db, 'products', PRODUCT).price = 1600) },
  { label: 'the quantity', change: (db) => (row(db, 'products', PRODUCT).quantity = 3) },
  {
    label: 'the image order',
    change: (db) =>
      (row(db, 'products', PRODUCT).images = ['https://cdn.example.com/2.jpg', 'https://cdn.example.com/1.jpg']),
  },
  {
    label: 'an image URL',
    change: (db) =>
      (row(db, 'products', PRODUCT).images = ['https://cdn.example.com/1.jpg', 'https://cdn.example.com/9.jpg']),
  },
  {
    label: 'an added image',
    change: (db) =>
      (row(db, 'products', PRODUCT).images = [
        'https://cdn.example.com/1.jpg',
        'https://cdn.example.com/2.jpg',
        'https://cdn.example.com/3.jpg',
      ]),
  },
  {
    label: 'the category',
    change: (db) => {
      db.tables.categories = [
        ...(db.tables.categories ?? []),
        { _id: 'categories|2', name: 'Accessories', slug: 'accessories' },
      ];
      row(db, 'products', PRODUCT).categoryId = 'categories|2';
    },
  },
  { label: 'the category name', change: (db) => (row(db, 'categories', 'categories|1').name = 'Mobile Phones') },
  { label: 'the status', change: (db) => (row(db, 'products', PRODUCT).status = 'active') },
];

for (const { label, change } of REVIEWED_CHANGES) {
  test(`saveModerationResult refuses a save after ${label} changed with updatedAt unchanged, and writes nothing`, async () => {
    const { db } = open();
    change(db);
    assert.equal(row(db, 'products', PRODUCT).updatedAt, 100, 'updatedAt has not moved');
    const before = structuredClone(db.tables);
    const result = await invokeFakeFunction(aiModerationData.saveModerationResult, createCtx(db, null), {
      ...SAVE_ARGS,
      revision: SEED_REVISION,
      reviewerId: 'users|4',
    });
    assert.deepEqual(recordOf(result), { saved: false, reason: 'stale' });
    assert.deepEqual(db.tables, before);
  });
}

// The revision inputs of the seeded listing, with the price or count under test replaced by the caller.
const SEEDED_REVISION_INPUT = {
  updatedAt: 100,
  title: 'Samsung Galaxy phone',
  description: 'Sealed box, good battery',
  price: 1500,
  quantity: 2,
  categoryId: 'categories|1',
  categoryName: 'Phones',
  images: ['https://cdn.example.com/1.jpg', 'https://cdn.example.com/2.jpg'],
  status: 'pending',
};

// Reviewer reproduction. A revision read while the price is NaN must not save after a real edit makes the price Infinity with
// updatedAt unchanged. Before the fix both values fingerprinted as null, so the old revision still matched.
test('saveModerationResult refuses a revision read at price NaN after the price becomes Infinity, and writes nothing', async () => {
  const nanRevision = listingRevision({ ...SEEDED_REVISION_INPUT, price: Number.NaN });
  const { db } = open();
  row(db, 'products', PRODUCT).price = Number.POSITIVE_INFINITY;
  assert.equal(row(db, 'products', PRODUCT).updatedAt, 100, 'updatedAt has not moved');
  const before = structuredClone(db.tables);
  const result = await invokeFakeFunction(aiModerationData.saveModerationResult, createCtx(db, null), {
    ...SAVE_ARGS,
    revision: nanRevision,
    reviewerId: 'users|4',
  });
  assert.deepEqual(recordOf(result), { saved: false, reason: 'stale' });
  assert.deepEqual(db.tables, before);
});

// Each non-finite and signed-zero number has its own fingerprint, so no two of them can stand in for each other.
test('the revision keeps NaN, Infinity, -Infinity, 0, and -0 apart, so no price can stand in for another', () => {
  const prices = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -0, 1500];
  const revisions = prices.map((price) => listingRevision({ ...SEEDED_REVISION_INPUT, price }));
  assert.equal(new Set(revisions).size, prices.length);
});

test('the revision keeps non-finite quantity and updatedAt apart as well', () => {
  const quantities = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -0, 2];
  const quantityRevisions = quantities.map((quantity) => listingRevision({ ...SEEDED_REVISION_INPUT, quantity }));
  assert.equal(new Set(quantityRevisions).size, quantities.length);
  const stamps = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -0, 100];
  const stampRevisions = stamps.map((updatedAt) => listingRevision({ ...SEEDED_REVISION_INPUT, updatedAt }));
  assert.equal(new Set(stampRevisions).size, stamps.length);
});

// Text fields keep their type in the fingerprint: a missing value, an empty string, and text that looks like a token differ.
test('the revision keeps a missing text field, an empty string, and token-like text apart', () => {
  const base = listingRevision({ ...SEEDED_REVISION_INPUT, description: '' });
  assert.notEqual(listingRevision({ ...SEEDED_REVISION_INPUT, description: undefined }), base);
  assert.notEqual(
    listingRevision({ ...SEEDED_REVISION_INPUT, title: 'x', description: '' }),
    listingRevision({ ...SEEDED_REVISION_INPUT, title: '', description: 'x' }),
  );
  assert.notEqual(
    listingRevision({ ...SEEDED_REVISION_INPUT, title: '["s","x"]' }),
    listingRevision({ ...SEEDED_REVISION_INPUT, title: 'x' }),
  );
});

// Image order and element boundaries are part of the fingerprint: a reordered list and a comma inside an element differ.
test('the revision keeps image order and element boundaries apart', () => {
  const urls = ['https://cdn.example.com/1.jpg', 'https://cdn.example.com/2.jpg'];
  const reordered = listingRevision({ ...SEEDED_REVISION_INPUT, images: [...urls].reverse() });
  const joined = listingRevision({ ...SEEDED_REVISION_INPUT, images: [`${urls[0]},${urls[1]}`] });
  const empty = listingRevision({ ...SEEDED_REVISION_INPUT, images: [] });
  const emptyItem = listingRevision({ ...SEEDED_REVISION_INPUT, images: [''] });
  const seeded = listingRevision(SEEDED_REVISION_INPUT);
  assert.equal(new Set([seeded, reordered, joined, empty, emptyItem]).size, 5);
});

test('listingForModeration refuses a listing with a non-finite price, quantity, or updatedAt as listing_invalid', async () => {
  const cases: Array<{ label: string; change: (db: Db) => void }> = [
    { label: 'a NaN price', change: (db) => (row(db, 'products', PRODUCT).price = Number.NaN) },
    { label: 'an Infinity price', change: (db) => (row(db, 'products', PRODUCT).price = Number.POSITIVE_INFINITY) },
    { label: 'a NaN quantity', change: (db) => (row(db, 'products', PRODUCT).quantity = Number.NaN) },
    {
      label: 'a -Infinity quantity',
      change: (db) => (row(db, 'products', PRODUCT).quantity = Number.NEGATIVE_INFINITY),
    },
    { label: 'a NaN updatedAt', change: (db) => (row(db, 'products', PRODUCT).updatedAt = Number.NaN) },
  ];
  for (const { label, change } of cases) {
    const { db } = open();
    change(db);
    const before = structuredClone(db.tables);
    const result = await invokeFakeFunction(aiModerationData.listingForModeration, createCtx(db, null), {
      userId: 'users|4',
      productId: PRODUCT,
    });
    assert.deepEqual(recordOf(result), { ok: false, code: 'listing_invalid' }, label);
    assert.deepEqual(db.tables, before, `${label} writes nothing`);
  }
});

test('saveModerationResult saves after a rewrite that leaves every reviewed field identical', async () => {
  const { db } = open();
  Object.assign(row(db, 'products', PRODUCT), {
    title: 'Samsung Galaxy phone',
    description: 'Sealed box, good battery',
    price: 1500,
    quantity: 2,
    images: ['https://cdn.example.com/1.jpg', 'https://cdn.example.com/2.jpg'],
    categoryId: 'categories|1',
    status: 'pending',
  });
  const result = await invokeFakeFunction(aiModerationData.saveModerationResult, createCtx(db, null), {
    ...SAVE_ARGS,
    revision: SEED_REVISION,
    reviewerId: 'users|4',
  });
  assert.deepEqual(recordOf(result), { saved: true });
});

test('saveModerationResult saves after view counts and other unreviewed fields change', async () => {
  const { db } = open();
  Object.assign(row(db, 'products', PRODUCT), { viewCount: 41, shippingOptions: [] });
  const result = await invokeFakeFunction(aiModerationData.saveModerationResult, createCtx(db, null), {
    ...SAVE_ARGS,
    revision: SEED_REVISION,
    reviewerId: 'users|4',
  });
  assert.deepEqual(recordOf(result), { saved: true });
});

// ---------------------------------------------------------------------------------------------------------------------
// The persistence path normalises the summary again, so a directly supplied dirty summary is never stored raw.
// ---------------------------------------------------------------------------------------------------------------------

const DIRTY_SUMMARIES: Array<{ label: string; summary: string; stored: string }> = [
  { label: 'a script tag with a NUL', summary: '<script>alert(1)</script>\u0000', stored: 'scriptalert(1)/script' },
  { label: 'zero-width and format characters', summary: 'Clear​ listing﻿­', stored: 'Clear listing' },
  { label: 'newlines and tabs', summary: 'Line one\n\tline two\r\nline three', stored: 'Line one line two line three' },
  { label: 'angle brackets', summary: 'a < b > c', stored: 'a b c' },
];

for (const { label, summary, stored } of DIRTY_SUMMARIES) {
  test(`saveModerationResult stores a normalised summary for ${label}`, async () => {
    const { db } = open();
    const result = await invokeFakeFunction(aiModerationData.saveModerationResult, createCtx(db, null), {
      ...SAVE_ARGS,
      revision: SEED_REVISION,
      summary,
      reviewerId: 'users|4',
    });
    assert.deepEqual(recordOf(result), { saved: true });
    assert.equal(row(db, 'products', PRODUCT).aiModerationSummary, stored);
  });
}

test('saveModerationResult refuses a summary that is empty after normalisation, and writes nothing', async () => {
  const { db } = open();
  const before = structuredClone(db.tables);
  const result = await invokeFakeFunction(aiModerationData.saveModerationResult, createCtx(db, null), {
    ...SAVE_ARGS,
    revision: SEED_REVISION,
    summary: '\u0000​ \n\t<>',
    reviewerId: 'users|4',
  });
  assert.deepEqual(recordOf(result), { saved: false, reason: 'invalid_output' });
  assert.deepEqual(db.tables, before);
});

for (const flag of ['__proto__', 'constructor']) {
  test(`saveModerationResult refuses the reserved flag name ${flag}, and writes nothing`, async () => {
    const { db } = open();
    const before = structuredClone(db.tables);
    const result = await invokeFakeFunction(aiModerationData.saveModerationResult, createCtx(db, null), {
      ...SAVE_ARGS,
      revision: SEED_REVISION,
      flags: [flag],
      reviewerId: 'users|4',
    });
    assert.deepEqual(recordOf(result), { saved: false, reason: 'invalid_output' });
    assert.deepEqual(db.tables, before);
  });
}
