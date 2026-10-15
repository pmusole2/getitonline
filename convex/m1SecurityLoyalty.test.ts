import assert from 'node:assert/strict';
import test from 'node:test';

import * as loyalty from './loyalty';
import { createCtx, createDb, handlerOf, type Db, type Row } from '../tests/support/convexFakeDb';

// A points redemption may name an order only if the signed-in account is that order's buyer. Every refusal must
// happen before the first write, because the fake database does not roll back.

type Args = Record<string, unknown>;
const redeemPoints = handlerOf<Args, unknown>(loyalty.redeemPoints);

function setup(
  subject: string | null,
  extra: Partial<Record<string, Row[]>> = {},
): { db: Db; ctx: ReturnType<typeof createCtx> } {
  const db = createDb({
    users: [
      { _id: 'users|owner', clerkId: 'clerk_owner', role: 'user', isBanned: false },
      { _id: 'users|other', clerkId: 'clerk_other', role: 'user', isBanned: false },
      { _id: 'users|seller', clerkId: 'clerk_seller', role: 'user', isBanned: false },
    ],
    orders: [
      { _id: 'orders|owner', orderNumber: 'ORD-1', buyerId: 'users|owner', sellerId: 'users|seller' },
      { _id: 'orders|other', orderNumber: 'ORD-2', buyerId: 'users|other', sellerId: 'users|seller' },
    ],
    loyaltyAccounts: [
      { _id: 'loyaltyAccounts|owner', userId: 'users|owner', pointsBalance: 500, lifetimeRedeemed: 0, tier: 'bronze' },
    ],
    loyaltyTransactions: [],
    ...extra,
  });
  return { db, ctx: createCtx(db, subject) };
}

test('a buyer redeeming against their own order is debited and the ledger names that order', async () => {
  const { db, ctx } = setup('clerk_owner');

  await redeemPoints(ctx, { points: 100, reason: 'Discount', orderId: 'orders|owner' });

  assert.equal(db.tables.loyaltyAccounts?.[0]?.pointsBalance, 400);
  assert.equal(db.tables.loyaltyAccounts?.[0]?.lifetimeRedeemed, 100);
  const entry = db.tables.loyaltyTransactions?.[0];
  assert.equal(db.tables.loyaltyTransactions?.length, 1);
  assert.equal(entry?.orderId, 'orders|owner');
  assert.equal(entry?.type, 'redeem');
});

test('a redemption without an order still works as before', async () => {
  const { db, ctx } = setup('clerk_owner');

  await redeemPoints(ctx, { points: 50, reason: 'Discount' });

  assert.equal(db.tables.loyaltyAccounts?.[0]?.pointsBalance, 450);
  assert.equal(db.tables.loyaltyTransactions?.[0]?.orderId, undefined);
});

test("a buyer cannot attach a redemption to another buyer's order, and nothing changes", async () => {
  const { db, ctx } = setup('clerk_owner');
  const before = structuredClone(db.tables);

  await assert.rejects(redeemPoints(ctx, { points: 100, reason: 'Discount', orderId: 'orders|other' }), {
    message: 'Unauthorized',
  });

  assert.deepEqual(db.tables, before);
});

test('a redemption naming a missing order is refused, and nothing changes', async () => {
  const { db, ctx } = setup('clerk_owner');
  const before = structuredClone(db.tables);

  await assert.rejects(redeemPoints(ctx, { points: 100, reason: 'Discount', orderId: 'orders|missing' }), {
    message: 'Order not found',
  });

  assert.deepEqual(db.tables, before);
});

test('a seller of the order, who is not its buyer, cannot redeem against it', async () => {
  const { db, ctx } = setup('clerk_seller', {
    loyaltyAccounts: [
      { _id: 'loyaltyAccounts|seller', userId: 'users|seller', pointsBalance: 500, lifetimeRedeemed: 0 },
    ],
  });
  const before = structuredClone(db.tables);

  await assert.rejects(redeemPoints(ctx, { points: 100, reason: 'Discount', orderId: 'orders|owner' }), {
    message: 'Unauthorized',
  });

  assert.deepEqual(db.tables, before);
});

test('a refused order check creates no loyalty account for a user who has none', async () => {
  const { db, ctx } = setup('clerk_seller', { loyaltyAccounts: [] });
  const before = structuredClone(db.tables);

  await assert.rejects(redeemPoints(ctx, { points: 100, reason: 'Discount', orderId: 'orders|owner' }), {
    message: 'Unauthorized',
  });

  assert.deepEqual(db.tables, before);
  assert.equal(db.tables.loyaltyAccounts?.length, 0);
});
