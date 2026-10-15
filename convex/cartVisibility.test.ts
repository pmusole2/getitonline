import assert from 'node:assert/strict';
import test from 'node:test';

import * as cart from './cart';
import { invokeFakeFunction } from '../tests/support/convexFakeActionCtx';
import { createCtx, createDb, type Db, type Row, type Tables } from '../tests/support/convexFakeDb';

// Cart reads and writes must apply the same listing rules as the product queries. A cart line can outlive the listing it
// points at: the product may be hidden, or its vendor may be suspended, after the buyer carted it. These tests run the real
// registered cart functions through invokeFakeFunction, which serializes the arguments the way Convex does, so NaN and
// Infinity reach the handler as they would in production. The fake db does not roll back, so every refusal must leave
// every table unchanged, and each test snapshots the tables to prove it.

type Args = Record<string, unknown>;

type CartLine = {
  _id: string;
  productId: string;
  quantity: number;
  lineUnitPrice?: number;
  selectedShipping: { name: string; price: number };
  product: { title: string; price: number; images: string[]; quantity: number; status: string; sellerName: string };
};

type CartResult = {
  items: CartLine[];
  subtotal: number;
  shippingTotal: number;
  total: number;
  itemCount: number;
};

type SellerGroups = Array<{
  sellerId: string;
  sellerName: string;
  items: Array<{ _id: string; quantity: number; lineUnitPrice: number; product: { title: string } }>;
  subtotal: number;
  shippingTotal: number;
}>;

type ValidationResult = {
  isValid: boolean;
  issues: Array<{ productId: string; issue: string; reason: string }>;
  itemCount: number;
};

const PUBLIC_PRICE = 1000;
const HIDDEN_PRICE = 98765;
const SHIPPING_PRICE = 50;
const MAX_QUANTITY_MESSAGE = /Quantity must be a whole number from 1 to 99/;

// Stored values a legacy cart line can carry. None of these strings may reach a client once the line is unavailable.
const SENTINEL_LEGACY_FIELDS = {
  selectedVariant: {
    variantId: 'VARIANT-SENTINEL-4471',
    sku: 'SKU-SENTINEL-4471',
    attributes: [{ name: 'Color', value: 'ATTR-SENTINEL-4471' }],
    price: 4471001,
    image: 'https://images.invalid/variant-sentinel-4471.jpg',
  },
  selectedVariantOptions: [
    { name: 'Size', value: 'OPTION-SENTINEL-4471', sku: 'OPTSKU-SENTINEL-4471', priceDelta: 4471002 },
  ],
  selectedAddOns: [{ name: 'ADDON-NAME-SENTINEL-4471', description: 'ADDON-DESC-SENTINEL-4471', price: 4471003 }],
  customizationKey: 'CUSTOM-KEY-SENTINEL-4471',
};

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

function product(id: string, sellerId: string, status: string, title: string, price: number): Row {
  return {
    _id: id,
    sellerId,
    title,
    description: `${title} description`,
    price,
    images: [`https://images.invalid/${id.replace('products|', '')}.jpg`],
    condition: 'good',
    status,
    quantity: 500,
    categoryId: 'categories|1',
    shippingOptions: [{ name: 'Courier', price: SHIPPING_PRICE }],
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
      product('products|active', 'users|seller', 'active', 'Public lamp', PUBLIC_PRICE),
      product('products|draft', 'users|seller', 'draft', 'Secret draft', HIDDEN_PRICE),
      product('products|private', 'users|suspended', 'active', 'Secret private', HIDDEN_PRICE),
    ],
    cartItems: [],
  };
}

function open(): Db {
  return createDb(fixtureTables());
}

// Calls a registered function the way the runtime does. The result type is the caller's claim about the handler's return.
async function call<T>(fn: unknown, db: Db, clerkId: string | null, args: Args): Promise<T> {
  return (await invokeFakeFunction(fn, createCtx(db, clerkId), args)) as T;
}

function snapshot(db: Db) {
  return structuredClone(db.tables);
}

function findRow(db: Db, table: string, id: string): Row {
  const row = db.tables[table]?.find((candidate) => candidate._id === id);
  assert.ok(row, `${id} must exist in ${table}`);
  return row;
}

function setField(db: Db, table: string, id: string, field: string, value: unknown) {
  findRow(db, table, id)[field] = value;
}

// Inserts a cart row straight into the fake table, the way a line saved before these rules would look.
function seedCartLine(
  db: Db,
  productId: string,
  quantity: number,
  options: { legacy?: boolean; userId?: string } = {},
): string {
  const rows = db.tables.cartItems;
  assert.ok(rows, 'cartItems table must exist');
  const id = `cartItems|seeded${rows.length + 1}`;
  rows.push({
    _id: id,
    userId: options.userId ?? 'users|buyer',
    productId,
    quantity,
    selectedShipping: { name: 'Courier', price: SHIPPING_PRICE },
    createdAt: 1,
    updatedAt: 1,
    ...(options.legacy ? SENTINEL_LEGACY_FIELDS : {}),
  });
  return id;
}

function guestItem(productId: string, quantity: number) {
  return {
    productId,
    quantity,
    selectedShipping: { name: 'Courier', price: SHIPPING_PRICE },
    product: {
      _id: productId,
      sellerId: 'users|seller',
      sellerName: 'Seller Store',
      title: 'Public lamp',
      price: PUBLIC_PRICE,
      images: [],
      quantity: 500,
      status: 'active',
      shippingOptions: [{ name: 'Courier', price: SHIPPING_PRICE, estimatedDays: '3' }],
    },
    addedAt: 1,
  };
}

function addArgs(productId: string, quantity: number): Args {
  return { productId, quantity, selectedShipping: { name: 'Courier', price: SHIPPING_PRICE } };
}

// Any sentinel, hidden price, or hidden title in the serialized output means a saved field or a hidden listing leaked.
function assertNoSentinel(output: unknown, label: string) {
  const text = JSON.stringify(output);
  assert.doesNotMatch(text, /SENTINEL|4471/, `${label} must not carry the saved variant, add-on, image, or price`);
  assert.doesNotMatch(text, new RegExp(String(HIDDEN_PRICE)), `${label} must not carry the hidden price`);
}

async function addActiveLineAsBuyer(db: Db, quantity: number) {
  return await call<string>(cart.addToCart, db, 'clerk_buyer', addArgs('products|active', quantity));
}

// ---- Reads: getCart ----

test('getCart returns an explicit placeholder for a hidden product, with no saved variant, add-on, image, price, or SKU', async () => {
  const db = open();
  const lineId = seedCartLine(db, 'products|draft', 2, { legacy: true });

  const result = await call<CartResult>(cart.getCart, db, 'clerk_buyer', {});

  assert.equal(result.items.length, 1, 'the line must stay so it can be removed');
  const line = result.items[0];
  assert.ok(line);
  assert.equal(line._id, lineId);
  assert.equal(line.productId, 'products|draft');
  assert.equal(line.quantity, 2);
  assert.equal(line.product.title, 'Listing unavailable');
  assert.equal(line.product.price, 0);
  assert.deepEqual(line.product.images, []);
  assert.equal(line.lineUnitPrice, 0);
  for (const field of ['selectedVariant', 'selectedVariantOptions', 'selectedAddOns', 'customizationKey']) {
    assert.equal(field in line, false, `${field} must not be returned for an unavailable line`);
  }
  assertNoSentinel(line, 'the placeholder line');
  assert.doesNotMatch(JSON.stringify(result), /Secret draft|Public lamp/);
});

test('getCart placeholder for a line whose vendor is suspended names no store and returns no saved fields', async () => {
  const db = open();
  seedCartLine(db, 'products|private', 1, { legacy: true });

  const result = await call<CartResult>(cart.getCart, db, 'clerk_buyer', {});

  assert.equal(result.items[0]?.product.title, 'Listing unavailable');
  assert.equal(result.items[0]?.product.sellerName, 'Unavailable');
  assertNoSentinel(result, 'the suspended-vendor placeholder');
  assert.doesNotMatch(JSON.stringify(result), /Suspended Store|Secret private|users\|suspended/);
});

test('getCart keeps the real title and totals for a staff viewer whose carted product is now hidden', async () => {
  const db = open();
  const moderator = 'clerk_moderator';
  seedCartLine(db, 'products|draft', 1, { userId: 'users|moderator' });

  const result = await call<CartResult>(cart.getCart, db, moderator, {});

  assert.equal(result.items[0]?.product.title, 'Secret draft');
  assert.equal(result.items[0]?.lineUnitPrice, HIDDEN_PRICE);
});

for (const quantity of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
  test(`getCart treats a stored quantity of ${String(quantity)} as an unavailable line and keeps every total finite`, async () => {
    const db = open();
    const badId = seedCartLine(db, 'products|active', quantity);
    seedCartLine(db, 'products|active', 2);

    const result = await call<CartResult>(cart.getCart, db, 'clerk_buyer', {});

    const bad = result.items.find((line) => line._id === badId);
    assert.equal(bad?.product.title, 'Listing unavailable', 'the invalid line must be a placeholder');
    assert.equal(result.subtotal, PUBLIC_PRICE * 2, 'only the valid line may count toward the subtotal');
    assert.equal(result.shippingTotal, SHIPPING_PRICE);
    assert.equal(result.total, PUBLIC_PRICE * 2 + SHIPPING_PRICE);
    assert.ok(Number.isFinite(result.total));
  });
}

test('getCart with a visible product and a hidden placeholder returns subtotal and total for the visible line only', async () => {
  const db = open();
  await addActiveLineAsBuyer(db, 2);
  seedCartLine(db, 'products|draft', 3, { legacy: true });

  const result = await call<CartResult>(cart.getCart, db, 'clerk_buyer', {});

  assert.equal(result.subtotal, PUBLIC_PRICE * 2);
  assert.equal(result.total, PUBLIC_PRICE * 2 + SHIPPING_PRICE);
  assert.equal(result.itemCount, 2);
  assertNoSentinel(result, 'the mixed cart');
});

// ---- Reads: getCartBySeller ----

test('getCartBySeller leaves out a line whose vendor was suspended after the buyer carted it', async () => {
  const db = open();
  await addActiveLineAsBuyer(db, 2);
  setField(db, 'vendorProfiles', 'vendorProfiles|seller', 'status', 'suspended');

  const groups = await call<SellerGroups>(cart.getCartBySeller, db, 'clerk_buyer', {});

  assert.deepEqual(groups, [], 'checkout must not offer a line from a suspended vendor');
  assert.doesNotMatch(JSON.stringify(groups), /Public lamp|Seller Store/);
});

test('getCartBySeller leaves out a saved line for a suspended vendor and keeps the visible line', async () => {
  const db = open();
  await addActiveLineAsBuyer(db, 1);
  seedCartLine(db, 'products|private', 1, { legacy: true });

  const groups = await call<SellerGroups>(cart.getCartBySeller, db, 'clerk_buyer', {});

  const items = groups.flatMap((group) => group.items);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.product.title, 'Public lamp');
  assertNoSentinel(groups, 'the checkout groups');
  assert.doesNotMatch(JSON.stringify(groups), /Secret private|Suspended Store/);
});

test('getCartBySeller leaves out a line with a non-finite stored quantity and keeps every subtotal finite', async () => {
  const db = open();
  seedCartLine(db, 'products|active', Number.NaN);
  await addActiveLineAsBuyer(db, 2);

  const groups = await call<SellerGroups>(cart.getCartBySeller, db, 'clerk_buyer', {});

  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.items.length, 1, 'the NaN line must not be offered at checkout');
  assert.equal(groups[0]?.subtotal, PUBLIC_PRICE * 2);
  assert.ok(Number.isFinite(groups[0]?.subtotal));
});

test('getCartBySeller leaves out a hidden draft, even for the staff viewer who carted it', async () => {
  const db = open();
  seedCartLine(db, 'products|draft', 1, { userId: 'users|moderator', legacy: true });

  const groups = await call<SellerGroups>(cart.getCartBySeller, db, 'clerk_moderator', {});

  assert.deepEqual(groups, []);
  assertNoSentinel(groups, 'the staff checkout groups');
});

// ---- Reads: validateCart ----

test('validateCart reports a line whose vendor is suspended as invalid, with a seller reason and no title', async () => {
  const db = open();
  await addActiveLineAsBuyer(db, 1);
  setField(db, 'vendorProfiles', 'vendorProfiles|seller', 'status', 'suspended');

  const result = await call<ValidationResult>(cart.validateCart, db, 'clerk_buyer', {});

  assert.equal(result.isValid, false, 'a suspended-vendor line must never validate');
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0]?.reason, 'seller_unavailable');
  assert.equal(result.issues[0]?.productId, 'products|active');
  assert.doesNotMatch(JSON.stringify(result), /Public lamp|Seller Store/);
});

test('validateCart reports a hidden draft as invalid with a product reason, for the buyer and for the staff viewer', async () => {
  const db = open();
  seedCartLine(db, 'products|draft', 1, { legacy: true });
  seedCartLine(db, 'products|draft', 1, { userId: 'users|moderator', legacy: true });

  const buyerResult = await call<ValidationResult>(cart.validateCart, db, 'clerk_buyer', {});
  const staffResult = await call<ValidationResult>(cart.validateCart, db, 'clerk_moderator', {});

  for (const result of [buyerResult, staffResult]) {
    assert.equal(result.isValid, false);
    assert.equal(result.issues[0]?.reason, 'product_unavailable');
  }
  assertNoSentinel(buyerResult, 'the buyer validation');
  assertNoSentinel(staffResult, 'the staff validation');
});

for (const quantity of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5]) {
  test(`validateCart reports a stored quantity of ${String(quantity)} as an invalid line`, async () => {
    const db = open();
    seedCartLine(db, 'products|active', quantity);

    const result = await call<ValidationResult>(cart.validateCart, db, 'clerk_buyer', {});

    assert.equal(result.isValid, false, 'an invalid stored quantity must never validate');
    assert.equal(result.issues[0]?.reason, 'invalid_line');
  });
}

test('validateCart reports insufficient stock with a stock reason and passes a valid in-stock line', async () => {
  const db = open();
  await addActiveLineAsBuyer(db, 2);
  assert.deepEqual(await call<ValidationResult>(cart.validateCart, db, 'clerk_buyer', {}), {
    isValid: true,
    issues: [],
    itemCount: 1,
  });

  setField(db, 'products', 'products|active', 'quantity', 1);
  const result = await call<ValidationResult>(cart.validateCart, db, 'clerk_buyer', {});

  assert.equal(result.isValid, false);
  assert.equal(result.issues[0]?.reason, 'insufficient_stock');
  assert.equal(result.issues[0]?.issue, 'Only 1 items available');
});

test('the checkout reads refuse an anonymous caller before any read', async () => {
  const db = open();
  const before = snapshot(db);

  await assert.rejects(() => call(cart.getCart, db, null, {}), /Unauthenticated/);
  await assert.rejects(() => call(cart.getCartBySeller, db, null, {}), /Unauthenticated/);
  await assert.rejects(() => call(cart.validateCart, db, null, {}), /Unauthenticated/);
  assert.deepEqual(db.tables, before);
});

// ---- Writes: addToCart ----

const INVALID_QUANTITIES: Array<[string, number]> = [
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['-Infinity', Number.NEGATIVE_INFINITY],
  ['0', 0],
  ['-1', -1],
  ['1.5', 1.5],
  ['100', 100],
  ['2^53', Number.MAX_SAFE_INTEGER + 1],
];

for (const [label, quantity] of INVALID_QUANTITIES) {
  test(`addToCart refuses a quantity of ${label} before any write`, async () => {
    const db = open();
    const before = snapshot(db);

    await assert.rejects(
      () => call(cart.addToCart, db, 'clerk_buyer', addArgs('products|active', quantity)),
      MAX_QUANTITY_MESSAGE,
    );
    assert.deepEqual(db.tables, before);
  });
}

test('addToCart accepts the boundary quantities 1 and 99', async () => {
  const low = open();
  await addActiveLineAsBuyer(low, 1);
  assert.equal(low.tables.cartItems?.[0]?.quantity, 1);

  const high = open();
  await addActiveLineAsBuyer(high, 99);
  assert.equal(high.tables.cartItems?.[0]?.quantity, 99);
});

test('addToCart refuses a merge that would take one cart line past 99, with no write', async () => {
  const db = open();
  await addActiveLineAsBuyer(db, 98);
  const before = snapshot(db);

  await assert.rejects(() => call(cart.addToCart, db, 'clerk_buyer', addArgs('products|active', 2)), /at most 99/);
  assert.deepEqual(db.tables, before);
});

test('addToCart refuses an active listing whose vendor is suspended, for the buyer and for the staff viewer, with no write', async () => {
  const db = open();
  const before = snapshot(db);

  for (const clerkId of ['clerk_buyer', 'clerk_moderator']) {
    await assert.rejects(
      () => call(cart.addToCart, db, clerkId, addArgs('products|private', 1)),
      /Product is not available/,
      `${clerkId} must not cart a suspended vendor's listing`,
    );
  }
  assert.deepEqual(db.tables, before);
});

test('addToCart still refuses a seller carting their own product, with no write', async () => {
  const db = open();
  const before = snapshot(db);

  await assert.rejects(
    () => call(cart.addToCart, db, 'clerk_seller', addArgs('products|active', 1)),
    /You cannot add your own product to cart/,
  );
  assert.deepEqual(db.tables, before);
});

// ---- Writes: mergeGuestCart ----

test('mergeGuestCart refuses the whole batch when any quantity is invalid, with no write, even if an earlier item is valid', async () => {
  const db = open();
  const before = snapshot(db);

  await assert.rejects(
    () =>
      call(cart.mergeGuestCart, db, 'clerk_buyer', {
        items: [guestItem('products|active', 1), guestItem('products|active', Number.NaN)],
      }),
    MAX_QUANTITY_MESSAGE,
  );
  assert.deepEqual(db.tables, before);
});

test('mergeGuestCart skips a listing whose vendor is suspended, with no write, and merges the valid item', async () => {
  const db = open();

  const result = await call<{ mergedCount: number; skipped: Array<{ productId: string; reason: string }> }>(
    cart.mergeGuestCart,
    db,
    'clerk_buyer',
    { items: [guestItem('products|private', 1), guestItem('products|active', 1)] },
  );

  assert.equal(result.mergedCount, 1);
  assert.deepEqual(result.skipped, [{ productId: 'products|private', reason: 'inactive' }]);
  assert.equal(db.tables.cartItems?.length, 1);
  assert.equal(db.tables.cartItems?.[0]?.productId, 'products|active');
});

test('mergeGuestCart caps a merged line at 99', async () => {
  const db = open();
  await addActiveLineAsBuyer(db, 98);

  await call(cart.mergeGuestCart, db, 'clerk_buyer', { items: [guestItem('products|active', 5)] });

  assert.equal(db.tables.cartItems?.length, 1);
  assert.equal(db.tables.cartItems?.[0]?.quantity, 99);
});

test('mergeGuestCart does not sum into a stored non-finite quantity, and writes a finite merged line', async () => {
  const db = open();
  const lineId = seedCartLine(db, 'products|active', Number.NaN);

  await call(cart.mergeGuestCart, db, 'clerk_buyer', { items: [guestItem('products|active', 2)] });

  assert.equal(findRow(db, 'cartItems', lineId).quantity, 2);
});

// ---- Writes: updateCartQuantity ----

const INVALID_UPDATES: Array<[string, number]> = [
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['0', 0],
  ['-1', -1],
  ['1.5', 1.5],
  ['100', 100],
];

for (const [label, quantity] of INVALID_UPDATES) {
  test(`updateCartQuantity refuses a quantity of ${label} and leaves the line unchanged`, async () => {
    const db = open();
    const lineId = await addActiveLineAsBuyer(db, 2);
    const before = snapshot(db);

    await assert.rejects(
      () => call(cart.updateCartQuantity, db, 'clerk_buyer', { cartItemId: lineId, quantity }),
      MAX_QUANTITY_MESSAGE,
    );
    assert.deepEqual(db.tables, before);
  });
}

test('updateCartQuantity refuses to raise a line whose product is now hidden, but still lets the buyer lower it', async () => {
  const db = open();
  const lineId = await addActiveLineAsBuyer(db, 2);
  setField(db, 'products', 'products|active', 'status', 'draft');
  const before = snapshot(db);

  await assert.rejects(
    () => call(cart.updateCartQuantity, db, 'clerk_buyer', { cartItemId: lineId, quantity: 3 }),
    /Product is not available/,
  );
  assert.deepEqual(db.tables, before);

  await call(cart.updateCartQuantity, db, 'clerk_buyer', { cartItemId: lineId, quantity: 1 });
  assert.equal(findRow(db, 'cartItems', lineId).quantity, 1);
});

test('updateCartQuantity refuses to raise a line whose vendor is suspended, with no write', async () => {
  const db = open();
  const lineId = await addActiveLineAsBuyer(db, 1);
  setField(db, 'vendorProfiles', 'vendorProfiles|seller', 'status', 'suspended');
  const before = snapshot(db);

  await assert.rejects(
    () => call(cart.updateCartQuantity, db, 'clerk_buyer', { cartItemId: lineId, quantity: 2 }),
    /Product is not available/,
  );
  assert.deepEqual(db.tables, before);
});

test('updateCartQuantity refuses a user who does not own the line, with no write', async () => {
  const db = open();
  const lineId = await addActiveLineAsBuyer(db, 1);
  const before = snapshot(db);

  await assert.rejects(
    () => call(cart.updateCartQuantity, db, 'clerk_other', { cartItemId: lineId, quantity: 2 }),
    /Unauthorized/,
  );
  assert.deepEqual(db.tables, before);
});
