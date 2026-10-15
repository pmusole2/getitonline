import assert from 'node:assert/strict';
import test from 'node:test';

import * as loyalty from './loyalty';
import { invokeFakeFunction } from '../tests/support/convexFakeActionCtx';
import { createCtx, createDb, type Db, type Row, type Tables } from '../tests/support/convexFakeDb';

// Loyalty amounts come from the caller or from stored rows. Every numeric entry point must refuse a value that is not a
// whole number in range before it reads or writes. The fake database does not roll back, so each refusal must leave
// every table unchanged. Calls go through invokeFakeFunction, so NaN and Infinity reach the handler as they do in
// production, after the real Convex serializer and the function's argument validator.

const POINTS_MESSAGE = /^Points must be a positive whole number$/;
const LIMIT_MESSAGE = /^Limit must be a whole number of zero or more$/;
const CORRUPT_MESSAGE = /^Loyalty account is corrupt and cannot be changed$/;
const OVERFLOW_MESSAGE = /^Loyalty points total would exceed the largest supported amount$/;

const BAD_POINTS: Array<{ label: string; value: number }> = [
  { label: 'NaN', value: Number.NaN },
  { label: 'Infinity', value: Number.POSITIVE_INFINITY },
  { label: '-Infinity', value: Number.NEGATIVE_INFINITY },
  { label: 'zero', value: 0 },
  { label: 'a negative number', value: -5 },
  { label: 'a fraction', value: 1.5 },
  { label: '2**60', value: 2 ** 60 },
];

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

function tablesWith(account: Row | null): Tables {
  return {
    users: [
      { _id: 'users|owner', clerkId: 'clerk_owner', role: 'user', isBanned: false },
      { _id: 'users|other', clerkId: 'clerk_other', role: 'user', isBanned: false },
    ],
    loyaltyAccounts: account ? [account] : [],
    loyaltyTransactions: [],
  };
}

function setup(subject: string | null, account: Row | null = accountRow()) {
  const db: Db = createDb(tablesWith(account));
  return { db, ctx: createCtx(db, subject) };
}

function snapshot(db: Db): Tables {
  return structuredClone(db.tables);
}

const redeem = (ctx: unknown, args: Record<string, unknown>) => invokeFakeFunction(loyalty.redeemPoints, ctx, args);
const award = (ctx: unknown, args: Record<string, unknown>) => invokeFakeFunction(loyalty.awardPoints, ctx, args);

function isRows(value: unknown): value is Row[] {
  return Array.isArray(value) && value.every((row) => typeof row === 'object' && row !== null && '_id' in row);
}

async function history(ctx: unknown, args: Record<string, unknown>): Promise<Row[]> {
  const rows = await invokeFakeFunction(loyalty.getLoyaltyTransactions, ctx, args);
  assert.ok(isRows(rows));
  return rows;
}

// redeemPoints: the amount is checked before any account read or write.
for (const bad of BAD_POINTS) {
  test(`redeemPoints refuses ${bad.label} points and changes nothing`, async () => {
    const { db, ctx } = setup('clerk_owner');
    const before = snapshot(db);

    await assert.rejects(redeem(ctx, { points: bad.value, reason: 'Discount' }), { message: POINTS_MESSAGE });

    assert.deepEqual(db.tables, before);
  });
}

test('redeeming NaN and then 1,000,000,000 points refuses the first call and keeps the balance at 500', async () => {
  const { db, ctx } = setup('clerk_owner');

  await assert.rejects(redeem(ctx, { points: Number.NaN, reason: 'Discount' }), { message: POINTS_MESSAGE });
  await assert.rejects(redeem(ctx, { points: 1_000_000_000, reason: 'Discount' }), {
    message: 'Insufficient loyalty points',
  });

  const account = db.tables.loyaltyAccounts?.[0];
  assert.equal(account?.pointsBalance, 500);
  assert.equal(account?.lifetimeRedeemed, 0);
  assert.equal(db.tables.loyaltyTransactions?.length, 0);
});

test('a valid redemption debits the balance, counts toward lifetime redeemed, and writes one ledger row', async () => {
  const { db, ctx } = setup('clerk_owner');

  await redeem(ctx, { points: 100, reason: 'Discount' });

  const account = db.tables.loyaltyAccounts?.[0];
  assert.equal(account?.pointsBalance, 400);
  assert.equal(account?.lifetimeRedeemed, 100);
  assert.equal(db.tables.loyaltyTransactions?.length, 1);
  assert.equal(db.tables.loyaltyTransactions?.[0]?.points, 100);
});

test('redeeming 1 point without a loyalty account refuses and creates no account row', async () => {
  const { db, ctx } = setup('clerk_other', null);
  const before = snapshot(db);

  await assert.rejects(redeem(ctx, { points: 1, reason: 'Discount' }), { message: 'Insufficient loyalty points' });

  assert.deepEqual(db.tables, before);
  assert.equal(db.tables.loyaltyAccounts?.length, 0);
});

// Each operation checks only the stored totals it does arithmetic on: redeemPoints reads the balance and lifetime
// redeemed, awardPoints reads the balance and lifetime earned.
const CORRUPT_FOR_REDEEM = [
  { label: 'a NaN balance', fields: { pointsBalance: Number.NaN } },
  { label: 'an infinite balance', fields: { pointsBalance: Number.POSITIVE_INFINITY } },
  { label: 'a negative balance', fields: { pointsBalance: -10 } },
  { label: 'a NaN lifetime redeemed total', fields: { lifetimeRedeemed: Number.NaN } },
];

const CORRUPT_FOR_AWARD = [
  { label: 'a NaN balance', fields: { pointsBalance: Number.NaN } },
  { label: 'an infinite balance', fields: { pointsBalance: Number.POSITIVE_INFINITY } },
  { label: 'a negative balance', fields: { pointsBalance: -10 } },
  { label: 'a negative lifetime earned total', fields: { lifetimeEarned: -1 } },
];

for (const corrupt of CORRUPT_FOR_REDEEM) {
  test(`redeemPoints refuses a stored account with ${corrupt.label} and writes nothing`, async () => {
    const { db, ctx } = setup('clerk_owner', accountRow(corrupt.fields));
    const before = snapshot(db);

    await assert.rejects(redeem(ctx, { points: 100, reason: 'Discount' }), { message: CORRUPT_MESSAGE });

    assert.deepEqual(db.tables, before);
  });
}

for (const corrupt of CORRUPT_FOR_AWARD) {
  test(`awardPoints refuses a stored account with ${corrupt.label} and writes nothing`, async () => {
    const { db, ctx } = setup('clerk_owner', accountRow(corrupt.fields));
    const before = snapshot(db);

    await assert.rejects(award(ctx, { userId: 'users|owner', points: 50, reason: 'Purchase' }), {
      message: CORRUPT_MESSAGE,
    });

    assert.deepEqual(db.tables, before);
  });
}

// awardPoints is internal, so it is reached from other server code. Its amount is checked the same way.
for (const bad of BAD_POINTS) {
  test(`awardPoints refuses ${bad.label} points and changes nothing`, async () => {
    const { db, ctx } = setup('clerk_owner');
    const before = snapshot(db);

    await assert.rejects(award(ctx, { userId: 'users|owner', points: bad.value, reason: 'Purchase' }), {
      message: POINTS_MESSAGE,
    });

    assert.deepEqual(db.tables, before);
  });
}

test('awardPoints refuses a total past the largest safe integer and changes nothing', async () => {
  const { db, ctx } = setup('clerk_owner', accountRow({ pointsBalance: 500, lifetimeEarned: 500 }));
  const before = snapshot(db);

  await assert.rejects(award(ctx, { userId: 'users|owner', points: Number.MAX_SAFE_INTEGER, reason: 'Purchase' }), {
    message: OVERFLOW_MESSAGE,
  });

  assert.deepEqual(db.tables, before);
});

test('awardPoints credits a valid amount to the balance and lifetime total and writes one earn row', async () => {
  const { db, ctx } = setup('clerk_owner');

  await award(ctx, { userId: 'users|owner', points: 50, reason: 'Purchase' });

  const account = db.tables.loyaltyAccounts?.[0];
  assert.equal(account?.pointsBalance, 550);
  assert.equal(account?.lifetimeEarned, 550);
  assert.equal(db.tables.loyaltyTransactions?.[0]?.type, 'earn');
  assert.equal(db.tables.loyaltyTransactions?.length, 1);
});

// getLoyaltyTransactions: the limit is a whole number of zero or more. Zero keeps its existing empty result.
for (const bad of [
  { label: 'NaN', value: Number.NaN },
  { label: 'Infinity', value: Number.POSITIVE_INFINITY },
  { label: 'a negative number', value: -1 },
  { label: 'a fraction', value: 1.5 },
]) {
  test(`getLoyaltyTransactions refuses a limit of ${bad.label}`, async () => {
    const { ctx } = setup('clerk_owner');

    await assert.rejects(history(ctx, { limit: bad.value }), { message: LIMIT_MESSAGE });
  });
}

test('getLoyaltyTransactions still returns the caller ledger for a valid limit, and [] for zero', async () => {
  const { db, ctx } = setup('clerk_owner');
  db.tables.loyaltyTransactions = [
    { _id: 'loyaltyTransactions|1', userId: 'users|owner', points: 10, type: 'earn', createdAt: 1 },
    { _id: 'loyaltyTransactions|2', userId: 'users|owner', points: 20, type: 'earn', createdAt: 2 },
  ];

  assert.equal((await history(ctx, { limit: 1 })).length, 1);
  assert.deepEqual(await history(ctx, { limit: 0 }), []);
});
