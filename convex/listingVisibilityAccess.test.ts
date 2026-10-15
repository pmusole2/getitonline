import assert from 'node:assert/strict';
import test from 'node:test';

import * as cart from './cart';
import * as favorites from './favorites';
import * as reviews from './reviews';
import { createCtx, createDb, handlerOf, type Db, type Row, type Tables } from '../tests/support/convexFakeDb';

// A product's customer-facing fields are visible only to the public (active, from a public storefront seller), the owner,
// and staff viewers. A user can keep a favorite, cart line, or review that points at a product that later becomes hidden.
// Those rows stay, but they must not return the hidden product's title, price, images, description, or seller name to
// anyone who may not see the product. These tests run the real handlers over the in-memory fake. The fake does not roll
// back, so every refusal must happen before the first write, and each refusal must leave every table unchanged.

type Args = Record<string, unknown>;

const addFavorite = handlerOf<Args, string>(favorites.addFavorite);
const toggleFavorite = handlerOf<Args, { isFavorited: boolean }>(favorites.toggleFavorite);
const getUserFavorites = handlerOf<Args, Array<{ _id: string; product: Row | null }>>(favorites.getUserFavorites);
const removeProductFavorites = handlerOf<Args, { deleted: number }>(favorites.removeProductFavorites);
const addToCart = handlerOf<Args, string>(cart.addToCart);
const getCart = handlerOf<
  Args,
  {
    items: Array<{ _id: string; lineUnitPrice: number; product: Row }>;
    subtotal: number;
    shippingTotal: number;
    total: number;
    itemCount: number;
  }
>(cart.getCart);
const getSellerReviews = handlerOf<Args, Array<{ _id: string; rating: number; product: Row | null }>>(
  reviews.getSellerReviews,
);
const getUserWrittenReviews = handlerOf<Args, Array<{ _id: string; rating: number; product: Row | null }>>(
  reviews.getUserWrittenReviews,
);

const HIDDEN_PRICE = 98765;
const PUBLIC_PRICE = 1000;
const HIDDEN_PRODUCT_IDS = [
  'products|draft',
  'products|pending',
  'products|sold',
  'products|suspended',
  'products|private',
];

function account(id: string, clerkId: string, role: string, firstName: string): Row {
  return {
    _id: id,
    clerkId,
    email: `${clerkId}@example.invalid`,
    firstName,
    lastName: id,
    role,
    isBanned: false,
    rating: 4,
  };
}

function listing(id: string, sellerId: string, status: string, label: string): Row {
  return {
    _id: id,
    sellerId,
    title: `Secret ${label}`,
    description: `Secret description ${label}`,
    price: HIDDEN_PRICE,
    images: [`https://images.invalid/${label}.jpg`],
    condition: 'good',
    status,
    quantity: 5,
    categoryId: 'categories|1',
    shippingOptions: [{ name: 'Courier', price: 50 }],
  };
}

function fixtureTables(): Tables {
  return {
    users: [
      account('users|buyer', 'clerk_buyer', 'user', 'Buyer'),
      account('users|other', 'clerk_other', 'user', 'Other'),
      account('users|seller', 'clerk_seller', 'user', 'Seller'),
      account('users|suspended', 'clerk_suspended', 'user', 'Suspended'),
      account('users|moderator', 'clerk_moderator', 'moderator', 'Moderator'),
      account('users|admin', 'clerk_admin', 'admin', 'Admin'),
    ],
    vendorProfiles: [
      {
        _id: 'vendorProfiles|seller',
        ownerUserId: 'users|seller',
        status: 'approved',
        storeName: 'Seller Store',
        slug: 'seller-store',
      },
      {
        _id: 'vendorProfiles|suspended',
        ownerUserId: 'users|suspended',
        status: 'suspended',
        storeName: 'Suspended Store',
        slug: 'suspended-store',
      },
    ],
    platformSettings: [{ _id: 'platformSettings|1', key: 'singleton', companyDisplayName: 'Gettitonline' }],
    products: [
      {
        ...listing('products|active', 'users|seller', 'active', 'public'),
        title: 'Public lamp',
        description: 'Public',
        price: PUBLIC_PRICE,
        images: ['https://images.invalid/public.jpg'],
      },
      listing('products|draft', 'users|seller', 'draft', 'draft'),
      listing('products|pending', 'users|seller', 'pending_review', 'pending'),
      listing('products|sold', 'users|seller', 'sold', 'sold'),
      listing('products|suspended', 'users|seller', 'suspended', 'suspended-listing'),
      listing('products|private', 'users|suspended', 'active', 'private'),
    ],
    favorites: [],
    cartItems: [],
    reviews: [],
  };
}

function open(): Db {
  return createDb(fixtureTables());
}

function ctxFor(db: Db, clerkId: string | null) {
  return createCtx(db, clerkId);
}

function setStatus(db: Db, productId: string, status: string) {
  const found = db.tables.products?.find((candidate) => candidate._id === productId);
  assert.ok(found, `${productId} must exist`);
  found.status = status;
}

// The serialized output must not contain the hidden listing's title, description, image, or price.
function assertNoSecret(output: unknown, label: string) {
  const text = JSON.stringify(output);
  assert.doesNotMatch(text, new RegExp(`Secret ${label}`), `title of ${label} leaked`);
  assert.doesNotMatch(text, new RegExp(`Secret description ${label}`), `description of ${label} leaked`);
  assert.doesNotMatch(text, new RegExp(`images\\.invalid/${label}\\.jpg`), `image of ${label} leaked`);
  assert.doesNotMatch(text, new RegExp(`${HIDDEN_PRICE}`), `price of ${label} leaked`);
  assert.doesNotMatch(text, /Suspended Store/, 'private seller store name leaked');
}

function assertNoLeakOfAnyHiddenListing(output: unknown) {
  for (const label of ['draft', 'pending', 'sold', 'suspended-listing', 'private']) {
    assertNoSecret(output, label);
  }
}

// Snapshot of every table; a refused call must leave it exactly as it was.
function snapshot(db: Db) {
  return structuredClone(db.tables);
}

test('addFavorite refuses every hidden product for an unrelated buyer, with zero writes', async () => {
  const db = open();
  const before = snapshot(db);
  const buyer = ctxFor(db, 'clerk_buyer');

  for (const productId of HIDDEN_PRODUCT_IDS) {
    await assert.rejects(() => addFavorite(buyer, { productId }), /Product not found/, `${productId} must be refused`);
    assert.deepEqual(db.tables, before, `${productId} refusal must not write`);
  }
});

test('addFavorite refuses an anonymous caller before any read or write', async () => {
  const db = open();
  const before = snapshot(db);

  await assert.rejects(() => addFavorite(ctxFor(db, null), { productId: 'products|active' }), /Unauthenticated/);
  assert.deepEqual(db.tables, before);
});

test('addFavorite still accepts a visible product, and lets the owner, a moderator, and an admin favorite a hidden one', async () => {
  const db = open();

  await addFavorite(ctxFor(db, 'clerk_buyer'), { productId: 'products|active' });
  await addFavorite(ctxFor(db, 'clerk_seller'), { productId: 'products|draft' });
  await addFavorite(ctxFor(db, 'clerk_moderator'), { productId: 'products|pending' });
  await addFavorite(ctxFor(db, 'clerk_admin'), { productId: 'products|private' });

  assert.equal(db.tables.favorites?.length, 4);
});

test('toggleFavorite refuses to add a hidden product, with zero writes', async () => {
  const db = open();
  const before = snapshot(db);

  await assert.rejects(
    () => toggleFavorite(ctxFor(db, 'clerk_buyer'), { productId: 'products|draft' }),
    /Product not found/,
  );
  assert.deepEqual(db.tables, before);
});

test('toggleFavorite still removes an existing favorite for a product that became hidden', async () => {
  const db = open();
  const buyer = ctxFor(db, 'clerk_buyer');
  await addFavorite(buyer, { productId: 'products|active' });
  setStatus(db, 'products|active', 'draft');

  const result = await toggleFavorite(buyer, { productId: 'products|active' });

  assert.deepEqual(result, { isFavorited: false });
  assert.equal(db.tables.favorites?.length, 0);
});

test('getUserFavorites keeps the row for a product that became hidden, with product null and no private fields', async () => {
  const db = open();
  const buyer = ctxFor(db, 'clerk_buyer');
  const favoriteId = await addFavorite(buyer, { productId: 'products|active' });
  setStatus(db, 'products|active', 'draft');

  const rows = await getUserFavorites(buyer, {});

  assert.equal(rows.length, 1, 'the favorite row must still be listed so it can be removed');
  assert.equal(rows[0]?._id, favoriteId);
  assert.equal(rows[0]?.product, null);
  assertNoSecret(rows, 'public');
  assert.doesNotMatch(JSON.stringify(rows), /Public lamp/);
});

test('getUserFavorites returns no private field for any hidden status or a private seller, and keeps every row', async () => {
  const db = open();
  const buyer = ctxFor(db, 'clerk_buyer');
  for (const productId of HIDDEN_PRODUCT_IDS) {
    db.tables.favorites?.push({ _id: `favorites|${productId}`, userId: 'users|buyer', productId, createdAt: 1 });
  }

  const rows = await getUserFavorites(buyer, {});

  assert.equal(rows.length, HIDDEN_PRODUCT_IDS.length);
  for (const row of rows) {
    assert.equal(row.product, null);
  }
  assertNoLeakOfAnyHiddenListing(rows);
});

test('getCart keeps the row for a product that became hidden, with an unavailable placeholder and no price', async () => {
  const db = open();
  const buyer = ctxFor(db, 'clerk_buyer');
  await addToCart(buyer, {
    productId: 'products|active',
    quantity: 1,
    selectedShipping: { name: 'Courier', price: 50 },
  });
  setStatus(db, 'products|active', 'draft');

  const result = await getCart(buyer, {});

  assert.equal(result.items.length, 1, 'the cart row must still be listed so it can be removed');
  const item = result.items[0];
  assert.ok(item);
  assert.equal(item.product.title, 'Listing unavailable');
  assert.equal(item.product.price, 0);
  assert.deepEqual(item.product.images, []);
  assert.equal(item.lineUnitPrice, 0);
  assert.equal(result.subtotal, 0);
  assert.equal(result.total, 0);
  assertNoSecret(result, 'public');
  assert.doesNotMatch(JSON.stringify(result), /Public lamp/);
});

test('getCart still shows the real title and price of a visible product', async () => {
  const db = open();
  const buyer = ctxFor(db, 'clerk_buyer');
  await addToCart(buyer, {
    productId: 'products|active',
    quantity: 2,
    selectedShipping: { name: 'Courier', price: 50 },
  });

  const result = await getCart(buyer, {});

  assert.equal(result.items[0]?.product.title, 'Public lamp');
  assert.equal(result.items[0]?.lineUnitPrice, PUBLIC_PRICE);
  assert.equal(result.subtotal, PUBLIC_PRICE * 2);
});

test('getUserWrittenReviews keeps a review of a product that became hidden, with product null', async () => {
  const db = open();
  db.tables.reviews?.push({
    _id: 'reviews|1',
    orderId: 'orders|1',
    reviewerId: 'users|buyer',
    revieweeId: 'users|seller',
    productId: 'products|draft',
    rating: 5,
    comment: 'Good',
  });

  const rows = await getUserWrittenReviews(ctxFor(db, 'clerk_buyer'), {});

  assert.equal(rows.length, 1, 'the review must still be listed');
  assert.equal(rows[0]?.rating, 5);
  assert.equal(rows[0]?.product, null);
  assertNoSecret(rows, 'draft');
});

test('getSellerReviews as an anonymous caller exposes no private product fields for a hidden product', async () => {
  const db = open();
  db.tables.reviews?.push({
    _id: 'reviews|1',
    orderId: 'orders|1',
    reviewerId: 'users|buyer',
    revieweeId: 'users|seller',
    productId: 'products|draft',
    rating: 4,
  });

  const rows = await getSellerReviews(ctxFor(db, null), { sellerId: 'users|seller' });

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.rating, 4);
  assert.equal(rows[0]?.product, null);
  assertNoSecret(rows, 'draft');
});

test('getSellerReviews as an anonymous caller still shows a visible product', async () => {
  const db = open();
  db.tables.reviews?.push({
    _id: 'reviews|1',
    orderId: 'orders|1',
    reviewerId: 'users|buyer',
    revieweeId: 'users|seller',
    productId: 'products|active',
    rating: 4,
  });

  const rows = await getSellerReviews(ctxFor(db, null), { sellerId: 'users|seller' });

  assert.equal(rows[0]?.product?.title, 'Public lamp');
});

test('the owner and staff viewers still see the title, price, and images of a hidden product', async () => {
  const db = open();
  db.tables.reviews?.push({
    _id: 'reviews|1',
    orderId: 'orders|1',
    reviewerId: 'users|buyer',
    revieweeId: 'users|seller',
    productId: 'products|draft',
    rating: 4,
  });
  db.tables.reviews?.push({
    _id: 'reviews|2',
    orderId: 'orders|2',
    reviewerId: 'users|buyer',
    revieweeId: 'users|suspended',
    productId: 'products|private',
    rating: 3,
  });

  const ownerRows = await getSellerReviews(ctxFor(db, 'clerk_seller'), { sellerId: 'users|seller' });
  const moderatorRows = await getSellerReviews(ctxFor(db, 'clerk_moderator'), { sellerId: 'users|seller' });
  const adminRows = await getSellerReviews(ctxFor(db, 'clerk_admin'), { sellerId: 'users|suspended' });

  assert.equal(ownerRows[0]?.product?.title, 'Secret draft');
  assert.deepEqual(ownerRows[0]?.product?.images, ['https://images.invalid/draft.jpg']);
  assert.equal(moderatorRows[0]?.product?.title, 'Secret draft');
  assert.equal(adminRows[0]?.product?.title, 'Secret private');
});

test('the owner of a hidden product still sees its fields through getSellerReviews, the private seller included', async () => {
  const db = open();
  db.tables.reviews?.push({
    _id: 'reviews|1',
    orderId: 'orders|1',
    reviewerId: 'users|buyer',
    revieweeId: 'users|suspended',
    productId: 'products|private',
    rating: 3,
  });

  const rows = await getSellerReviews(ctxFor(db, 'clerk_suspended'), { sellerId: 'users|suspended' });

  assert.equal(rows[0]?.product?.title, 'Secret private');
});

test('a staff viewer who favorited a product while visible still sees it after it becomes hidden', async () => {
  const db = open();
  const moderator = ctxFor(db, 'clerk_moderator');
  await addFavorite(moderator, { productId: 'products|active' });
  setStatus(db, 'products|active', 'draft');

  const rows = await getUserFavorites(moderator, {});

  assert.equal(rows[0]?.product?.title, 'Public lamp');
});

test('a buyer who carted a product while visible sees it as a placeholder, never the real title', async () => {
  const db = open();
  const buyer = ctxFor(db, 'clerk_buyer');
  await addToCart(buyer, {
    productId: 'products|active',
    quantity: 1,
    selectedShipping: { name: 'Courier', price: 50 },
  });
  setStatus(db, 'products|active', 'draft');

  const result = await getCart(buyer, {});

  assert.equal(result.items[0]?.product.title, 'Listing unavailable');
  assert.notEqual(result.items[0]?.product.title, 'Public lamp');
});

test('removeProductFavorites is internal, so no client can call it', () => {
  assert.equal(Reflect.get(favorites.removeProductFavorites, 'isInternal'), true);
  assert.notEqual(Reflect.get(favorites.removeProductFavorites, 'isPublic'), true);
});

test('removeProductFavorites still deletes every favorite of the product for internal callers', async () => {
  const db = open();
  await addFavorite(ctxFor(db, 'clerk_buyer'), { productId: 'products|active' });
  await addFavorite(ctxFor(db, 'clerk_other'), { productId: 'products|active' });

  const result = await removeProductFavorites(ctxFor(db, null), { productId: 'products|active' });

  assert.deepEqual(result, { deleted: 2 });
  assert.equal(db.tables.favorites?.length, 0);
});
