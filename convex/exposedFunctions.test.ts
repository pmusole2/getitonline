import assert from 'node:assert/strict';
import test from 'node:test';

import * as disputes from './disputes';
import * as favorites from './favorites';
import * as orders from './orders';
import * as products from './products';
import * as promotions from './promotions';
import * as seed from './seed';
import * as users from './users';
import { createCtx, createDb, handlerOf, type Db, type Row, type Tables } from '../tests/support/convexFakeDb';

// These mutations have no caller anywhere, so they must not be part of the public API. Convex marks each registered
// function as public or internal, and only public functions are reachable by clients of any kind: anonymous, signed-in,
// or staff. The handler tests show the bodies are unchanged, so internal callers keep working.

type Args = Record<string, unknown>;

function flag(fn: unknown, name: 'isPublic' | 'isInternal'): unknown {
  return typeof fn === 'function' && name in fn ? Reflect.get(fn, name) : undefined;
}

const MOVED_TO_INTERNAL: Array<{ name: string; fn: unknown }> = [
  { name: 'orders.createOrder', fn: orders.createOrder },
  { name: 'promotions.recordPromoCodeRedemption', fn: promotions.recordPromoCodeRedemption },
  { name: 'products.decreaseQuantity', fn: products.decreaseQuantity },
  { name: 'users.incrementSales', fn: users.incrementSales },
  { name: 'users.incrementPurchases', fn: users.incrementPurchases },
  { name: 'users.updateUserRating', fn: users.updateUserRating },
  { name: 'disputes.updateAISummary', fn: disputes.updateAISummary },
  { name: 'products.storeListingModerationResult', fn: products.storeListingModerationResult },
  { name: 'favorites.removeProductFavorites', fn: favorites.removeProductFavorites },
  { name: 'seed.seedAllCategories', fn: seed.seedAllCategories },
];

for (const { name, fn } of MOVED_TO_INTERNAL) {
  test(`${name} is registered as internal, so no client can call it`, () => {
    assert.equal(flag(fn, 'isInternal'), true, `${name} must be internal`);
    assert.notEqual(flag(fn, 'isPublic'), true, `${name} must not be public`);
  });
}

function fixtureTables(): Tables {
  return {
    users: [
      { _id: 'users|seller', clerkId: 'clerk_seller', role: 'user', totalSales: 4, totalPurchases: 2, rating: 5 },
    ],
    products: [
      {
        _id: 'products|1',
        sellerId: 'users|seller',
        title: 'Lamp',
        status: 'active',
        quantity: 5,
        lowStockThreshold: 2,
        availabilityStatus: 'in_stock',
      },
    ],
    reviews: [
      { _id: 'reviews|1', revieweeId: 'users|seller', rating: 5 },
      { _id: 'reviews|2', revieweeId: 'users|seller', rating: 4 },
    ],
  };
}

function open(): { db: Db; ctx: ReturnType<typeof createCtx> } {
  const db = createDb(fixtureTables());
  return { db, ctx: createCtx(db, null) };
}

function row(db: Db, table: string, id: string): Row {
  const found = db.tables[table]?.find((candidate) => candidate._id === id);
  assert.ok(found, `${id} must exist`);
  return found;
}

test('decreaseQuantity keeps its behaviour for internal callers', async () => {
  const decrease = handlerOf<Args, void>(products.decreaseQuantity);
  const { db, ctx } = open();

  await decrease(ctx, { productId: 'products|1', amount: 2 });
  assert.equal(row(db, 'products', 'products|1').quantity, 3);

  await decrease(ctx, { productId: 'products|1', amount: 3 });
  const sold = row(db, 'products', 'products|1');
  assert.equal(sold.quantity, 0);
  assert.equal(sold.status, 'sold');
  assert.equal(sold.availabilityStatus, 'out_of_stock');
});

test('decreaseQuantity still refuses more than the stock, and changes nothing', async () => {
  const decrease = handlerOf<Args, void>(products.decreaseQuantity);
  const { db, ctx } = open();
  const before = structuredClone(db.tables);

  await assert.rejects(() => decrease(ctx, { productId: 'products|1', amount: 9 }), /Insufficient quantity/);
  assert.deepEqual(db.tables, before);
});

test('the counter helpers keep their behaviour for internal callers', async () => {
  const sales = handlerOf<Args, void>(users.incrementSales);
  const purchases = handlerOf<Args, void>(users.incrementPurchases);
  const rating = handlerOf<Args, void>(users.updateUserRating);
  const { db, ctx } = open();

  await sales(ctx, { userId: 'users|seller' });
  await purchases(ctx, { userId: 'users|seller' });
  await rating(ctx, { userId: 'users|seller' });

  const seller = row(db, 'users', 'users|seller');
  assert.equal(seller.totalSales, 5);
  assert.equal(seller.totalPurchases, 3);
  assert.equal(seller.rating, 4.5);
});
