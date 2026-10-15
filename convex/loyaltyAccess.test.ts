import assert from 'node:assert/strict';
import test from 'node:test';

import * as loyalty from './loyalty';
import { createCtx, createDb, handlerOf, type Row } from '../tests/support/convexFakeDb';

// Real handlers with a database/auth double; this does not exercise deployed JWTs or SDK validation.
const account = handlerOf<Record<string, unknown>, Row | null>(loyalty.getMyLoyaltyAccount);
const history = handlerOf<Record<string, unknown>, Row[]>(loyalty.getLoyaltyTransactions);

function setup(subject: string | null) {
  const db = createDb({
    users: [
      { _id: 'users|owner', clerkId: 'owner', role: 'user', isBanned: false },
      { _id: 'users|other', clerkId: 'other', role: 'user', isBanned: false },
      { _id: 'users|admin', clerkId: 'admin', role: 'admin', isBanned: false },
      { _id: 'users|banned', clerkId: 'banned', role: 'admin', isBanned: true },
      { _id: 'users|deleted', clerkId: 'deleted', role: 'user', deletedAt: 1 },
    ],
    loyaltyAccounts: [
      { _id: 'loyaltyAccounts|owner', userId: 'users|owner', pointsBalance: 125, tier: 'bronze' },
      { _id: 'loyaltyAccounts|other', userId: 'users|other', pointsBalance: 900, tier: 'gold' },
    ],
    loyaltyTransactions: Array.from({ length: 60 }, (_, index) => ({
      _id: `loyaltyTransactions|${index}`,
      userId: index % 2 === 0 ? 'users|owner' : 'users|other',
      points: index,
      type: 'earn',
      reason: 'Fixture purchase',
    })),
  });

  return { db, ctx: createCtx(db, subject) };
}

test('loyalty reads derive the owner from identity, ignoring spoofed handler arguments', async () => {
  const { ctx } = setup('owner');
  assert.equal((await account(ctx, { userId: 'users|other' }))?.pointsBalance, 125);
  const rows = await history(ctx, { userId: 'users|other', limit: 3 });
  assert.deepEqual(
    rows.map((row) => row.points),
    [58, 56, 54],
  );
  assert.ok(rows.every((row) => row.userId === 'users|owner'));
});

test('loyalty reads preserve null, empty, descending order and the default limit', async () => {
  const { db, ctx } = setup('owner');
  const before = structuredClone(db.tables);
  assert.equal((await account(ctx, {}))?._id, 'loyaltyAccounts|owner');
  const rows = await history(ctx, {});
  assert.equal(rows.length, 30);
  assert.equal(rows[0]?.points, 58);
  assert.equal(rows[29]?.points, 0);
  assert.deepEqual(db.tables, before);

  const empty = setup('admin');
  assert.equal(await account(empty.ctx, { userId: 'users|owner' }), null);
  assert.deepEqual(await history(empty.ctx, { userId: 'users|owner' }), []);
});

test('loyalty history caps the default result at 50 owner rows', async () => {
  const { db, ctx } = setup('owner');
  db.tables.loyaltyTransactions?.forEach((row) => {
    row.userId = 'users|owner';
  });
  assert.equal((await history(ctx, {})).length, 50);
  assert.deepEqual(await history(ctx, { limit: 0 }), []);
});

for (const [label, subject, message] of [
  ['anonymous', null, /Unauthenticated/],
  ['unknown', 'unknown', /Account not found/],
  ['banned staff', 'banned', /Account is banned/],
  ['deleted', 'deleted', /Account is deleted/],
] as const) {
  test(`loyalty rejects ${label} before private reads and leaves every table unchanged`, async () => {
    const { db, ctx } = setup(subject);
    const before = structuredClone(db.tables);
    await assert.rejects(() => account(ctx, { userId: 'users|owner' }), message);
    await assert.rejects(() => history(ctx, { userId: 'users|owner' }), message);
    assert.deepEqual(db.tables, before);
  });
}

test('loyalty registered argument schemas omit acting userId', () => {
  for (const fn of [loyalty.getMyLoyaltyAccount, loyalty.getLoyaltyTransactions]) {
    assert.ok('exportArgs' in fn && typeof fn.exportArgs === 'function');
    const schema: unknown = JSON.parse(fn.exportArgs());
    assert.ok(typeof schema === 'object' && schema !== null && 'value' in schema);
    assert.ok(typeof schema.value === 'object' && schema.value !== null);
    assert.ok(!('userId' in schema.value));
  }
});
