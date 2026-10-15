import assert from 'node:assert/strict';
import test from 'node:test';

import { createCtx, createDb, handlerOf } from '../tests/support/convexFakeDb';
import { recordPromoCodeRedemption } from './promotions';

// Real handler with database/auth doubles; deployed JWTs and SDK argument validation are not exercised here.
const redeem = handlerOf<Record<string, unknown>, string>(recordPromoCodeRedemption);

function setup(subject: string | null): {
  db: ReturnType<typeof createDb>;
  ctx: ReturnType<typeof createCtx>;
} {
  const db = createDb({
    users: [
      { _id: 'users|owner', clerkId: 'owner', role: 'user', isBanned: false },
      { _id: 'users|other', clerkId: 'other', role: 'user', isBanned: false },
      { _id: 'users|admin', clerkId: 'admin', role: 'admin', isBanned: false },
      { _id: 'users|support', clerkId: 'support', role: 'support', isBanned: false },
      { _id: 'users|banned', clerkId: 'banned', role: 'admin', isBanned: true },
      { _id: 'users|deleted', clerkId: 'deleted', role: 'user', deletedAt: 1 },
      { _id: 'users|duplicate-active', clerkId: 'duplicate', role: 'user', isBanned: false },
      { _id: 'users|duplicate-deleted', clerkId: 'duplicate', role: 'user', deletedAt: 1 },
      { _id: 'users|legacy-deleted', clerkId: 'deleted:legacy', role: 'user', deletedAt: 1 },
    ],
    promoCodes: [{ _id: 'promoCodes|code', code: 'TEST', isActive: true }],
    orders: [
      { _id: 'orders|owner', buyerId: 'users|owner' },
      { _id: 'orders|other', buyerId: 'users|other' },
      { _id: 'orders|admin', buyerId: 'users|admin' },
      { _id: 'orders|support', buyerId: 'users|support' },
    ],
    promoCodeRedemptions: [
      {
        _id: 'promoCodeRedemptions|existing',
        promoCodeId: 'promoCodes|code',
        userId: 'users|other',
        discountAmount: 9,
        redeemedAt: 1,
      },
    ],
    wallets: [{ _id: 'wallets|owner', userId: 'users|owner', balance: 20 }],
    loyaltyAccounts: [{ _id: 'loyaltyAccounts|owner', userId: 'users|owner', pointsBalance: 10 }],
  });

  return { db, ctx: createCtx(db, subject) };
}

test('promo redemption derives the owner, ignores a spoofed handler userId, and returns the inserted ID', async () => {
  const { db, ctx } = setup('owner');
  const before = structuredClone(db.tables);
  const beforeTime = Date.now();
  const id = await redeem(ctx, {
    promoCodeId: 'promoCodes|code',
    userId: 'users|other',
    orderId: 'orders|owner',
    discountAmount: 12.34,
  });
  const row = await db.get(id);

  assert.ok(row);
  assert.deepEqual(
    { ...row, redeemedAt: undefined },
    {
      _id: id,
      promoCodeId: 'promoCodes|code',
      userId: 'users|owner',
      orderId: 'orders|owner',
      discountAmount: 12.34,
      redeemedAt: undefined,
    },
  );
  assert.equal(typeof row.redeemedAt, 'number');
  assert.ok(typeof row.redeemedAt === 'number' && row.redeemedAt >= beforeTime && row.redeemedAt <= Date.now());
  assert.deepEqual(db.tables, {
    ...before,
    promoCodeRedemptions: [...(before.promoCodeRedemptions ?? []), row],
  });
});

test('promo redemption preserves optional orderId and the supplied discount amount', async () => {
  const { db, ctx } = setup('owner');
  const id = await redeem(ctx, { promoCodeId: 'promoCodes|code', discountAmount: -2.5 });
  const row = await db.get(id);

  assert.ok(row);
  assert.equal(row.userId, 'users|owner');
  assert.equal(row.orderId, undefined);
  assert.equal(row.discountAmount, -2.5);
});

for (const subject of ['admin', 'support']) {
  test(`active ${subject} can redeem only as itself with its own order`, async () => {
    const { db, ctx } = setup(subject);
    const id = await redeem(ctx, {
      promoCodeId: 'promoCodes|code',
      userId: 'users|owner',
      orderId: `orders|${subject}`,
      discountAmount: 3,
    });

    assert.equal((await db.get(id))?.userId, `users|${subject}`);
  });
}

for (const [label, subject, message] of [
  ['anonymous', null, /Unauthenticated/],
  ['unknown', 'unknown', /Account not found/],
  ['banned staff', 'banned', /Account is banned/],
  ['deleted', 'deleted', /Account is deleted/],
  ['deleted duplicate', 'duplicate', /Account is deleted/],
  ['legacy deleted', 'legacy', /Account is deleted/],
] as const) {
  test(`promo redemption rejects ${label} and leaves every table unchanged`, async () => {
    const { db, ctx } = setup(subject);
    const before = structuredClone(db.tables);

    await assert.rejects(
      () => redeem(ctx, { promoCodeId: 'promoCodes|code', userId: 'users|owner', discountAmount: 3 }),
      message,
    );
    assert.deepEqual(db.tables, before);
  });
}

for (const [label, subject, orderId] of [
  ['missing order', 'owner', 'orders|missing'],
  ['unrelated order', 'owner', 'orders|other'],
  ['admin targeting another buyer', 'admin', 'orders|owner'],
  ['support targeting another buyer', 'support', 'orders|owner'],
] as const) {
  test(`promo redemption rejects ${label} before writing any table`, async () => {
    const { db, ctx } = setup(subject);
    const before = structuredClone(db.tables);

    await assert.rejects(() =>
      redeem(ctx, { promoCodeId: 'promoCodes|code', userId: 'users|owner', orderId, discountAmount: 3 }),
    );
    assert.deepEqual(db.tables, before);
  });
}

test('promo redemption registered arguments remove acting userId and retain the optional order contract', () => {
  assert.ok('exportArgs' in recordPromoCodeRedemption && typeof recordPromoCodeRedemption.exportArgs === 'function');
  const schema: unknown = JSON.parse(recordPromoCodeRedemption.exportArgs());

  assert.ok(typeof schema === 'object' && schema !== null && 'value' in schema);
  assert.ok(typeof schema.value === 'object' && schema.value !== null);
  assert.deepEqual(Object.keys(schema.value).sort(), ['discountAmount', 'orderId', 'promoCodeId']);
  assert.ok('orderId' in schema.value);
  const orderArg = schema.value.orderId;

  assert.ok(typeof orderArg === 'object' && orderArg !== null && 'optional' in orderArg);
  assert.equal(orderArg.optional, true);
});
