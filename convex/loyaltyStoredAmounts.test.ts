import assert from 'node:assert/strict';
import test from 'node:test';

import * as loyalty from './loyalty';
import { invokeFakeFunction } from '../tests/support/convexFakeActionCtx';
import { createCtx, createDb, type Db, type Row, type Tables } from '../tests/support/convexFakeDb';

// Stored loyalty totals are arithmetic operands. A stored total that is not a non-negative safe integer (a fraction,
// a value past 2**53, NaN, Infinity, or a negative number) would make the result unreliable, so the handlers refuse the
// account before any write. The fake database does not roll back, so every refusal must leave all tables unchanged.

const CORRUPT_MESSAGE = /^Loyalty account is corrupt and cannot be changed$/;
const OVERFLOW_MESSAGE = /^Loyalty points total would exceed the largest supported amount$/;

function accountRow(extra: Partial<Row> = {}): Row {
  return {
    _id: 'loyaltyAccounts|owner',
    userId: 'users|owner',
    pointsBalance: 500,
    lifetimeEarned: 500,
    lifetimeRedeemed: 0,
    tier: 'bronze',
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

function tablesWith(account: Row): Tables {
  return {
    users: [{ _id: 'users|owner', clerkId: 'clerk_owner', role: 'user', isBanned: false }],
    loyaltyAccounts: [account],
    loyaltyTransactions: [],
  };
}

function setup(account: Row) {
  const db: Db = createDb(tablesWith(account));
  return { db, ctx: createCtx(db, 'clerk_owner') };
}

function snapshot(db: Db): Tables {
  return structuredClone(db.tables);
}

const redeem = (ctx: unknown, args: Record<string, unknown>) => invokeFakeFunction(loyalty.redeemPoints, ctx, args);
const award = (ctx: unknown, args: Record<string, unknown>) => invokeFakeFunction(loyalty.awardPoints, ctx, args);

const UNSTORABLE_TOTALS: Array<{ label: string; value: number }> = [
  { label: 'a fraction (100.5)', value: 100.5 },
  { label: '2**60', value: 2 ** 60 },
  { label: 'NaN', value: Number.NaN },
  { label: 'Infinity', value: Number.POSITIVE_INFINITY },
  { label: 'a negative number (-1)', value: -1 },
];

// redeemPoints reads pointsBalance and lifetimeRedeemed.
for (const bad of UNSTORABLE_TOTALS) {
  test(`redeemPoints refuses a stored balance of ${bad.label} and changes nothing`, async () => {
    const { db, ctx } = setup(accountRow({ pointsBalance: bad.value }));
    const before = snapshot(db);

    await assert.rejects(redeem(ctx, { points: 1, reason: 'Discount' }), { message: CORRUPT_MESSAGE });

    assert.deepEqual(db.tables, before);
  });

  test(`redeemPoints refuses a stored lifetime redeemed total of ${bad.label} and changes nothing`, async () => {
    const { db, ctx } = setup(accountRow({ lifetimeRedeemed: bad.value }));
    const before = snapshot(db);

    await assert.rejects(redeem(ctx, { points: 1, reason: 'Discount' }), { message: CORRUPT_MESSAGE });

    assert.deepEqual(db.tables, before);
  });
}

// awardPoints reads pointsBalance and lifetimeEarned.
for (const bad of UNSTORABLE_TOTALS) {
  test(`awardPoints refuses a stored balance of ${bad.label} and changes nothing`, async () => {
    const { db, ctx } = setup(accountRow({ pointsBalance: bad.value }));
    const before = snapshot(db);

    await assert.rejects(award(ctx, { userId: 'users|owner', points: 1, reason: 'Purchase' }), {
      message: CORRUPT_MESSAGE,
    });

    assert.deepEqual(db.tables, before);
  });

  test(`awardPoints refuses a stored lifetime earned total of ${bad.label} and changes nothing`, async () => {
    const { db, ctx } = setup(accountRow({ lifetimeEarned: bad.value }));
    const before = snapshot(db);

    await assert.rejects(award(ctx, { userId: 'users|owner', points: 1, reason: 'Purchase' }), {
      message: CORRUPT_MESSAGE,
    });

    assert.deepEqual(db.tables, before);
  });
}

test('redeeming 1 point from a stored balance of 2**60 is refused, not reported as a success with no change', async () => {
  const { db, ctx } = setup(accountRow({ pointsBalance: 2 ** 60 }));

  await assert.rejects(redeem(ctx, { points: 1, reason: 'Discount' }), { message: CORRUPT_MESSAGE });

  assert.equal(db.tables.loyaltyAccounts?.[0]?.pointsBalance, 2 ** 60);
  assert.equal(db.tables.loyaltyTransactions?.length, 0);
});

test('redeeming 1 point from a stored balance of 100.5 is refused, not carried to 99.5', async () => {
  const { db, ctx } = setup(accountRow({ pointsBalance: 100.5 }));

  await assert.rejects(redeem(ctx, { points: 1, reason: 'Discount' }), { message: CORRUPT_MESSAGE });

  assert.equal(db.tables.loyaltyAccounts?.[0]?.pointsBalance, 100.5);
  assert.equal(db.tables.loyaltyTransactions?.length, 0);
});

test('a stored balance at the largest safe integer redeems exactly, because it is still a safe integer', async () => {
  const start = Number.MAX_SAFE_INTEGER - 10;
  const { db, ctx } = setup(accountRow({ pointsBalance: start, lifetimeRedeemed: 0 }));

  await redeem(ctx, { points: 3, reason: 'Discount' });

  const account = db.tables.loyaltyAccounts?.[0];
  assert.equal(account?.pointsBalance, start - 3);
  assert.equal(account?.lifetimeRedeemed, 3);
  assert.equal(db.tables.loyaltyTransactions?.length, 1);
});

test('awarding points to a stored balance that would pass the largest safe integer is refused and changes nothing', async () => {
  const { db, ctx } = setup(accountRow({ pointsBalance: Number.MAX_SAFE_INTEGER - 10, lifetimeEarned: 0 }));
  const before = snapshot(db);

  await assert.rejects(award(ctx, { userId: 'users|owner', points: 50, reason: 'Purchase' }), {
    message: OVERFLOW_MESSAGE,
  });

  assert.deepEqual(db.tables, before);
});

test('redeeming to a lifetime redeemed total that would pass the largest safe integer is refused and changes nothing', async () => {
  const { db, ctx } = setup(accountRow({ pointsBalance: 500, lifetimeRedeemed: Number.MAX_SAFE_INTEGER - 10 }));
  const before = snapshot(db);

  await assert.rejects(redeem(ctx, { points: 50, reason: 'Discount' }), { message: OVERFLOW_MESSAGE });

  assert.deepEqual(db.tables, before);
});
