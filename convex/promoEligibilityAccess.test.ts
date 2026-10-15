import assert from 'node:assert/strict';
import test from 'node:test';

import { validatePromoCode } from './promotions';
import { createCtx, createDb, handlerOf } from '../tests/support/convexFakeDb';

// Real registered handler with auth/DB doubles, separate from SDK validator/JWT integration.
const validate = handlerOf<Record<string, unknown>, Record<string, unknown>>(validatePromoCode);
const input = { code: ' test ', subtotal: 100 };

function setup(subject: string | null) {
  const db = createDb({
    users: ['used', 'new', 'admin', 'banned', 'deleted'].map((name) => ({
      _id: `users|${name}`,
      clerkId: name,
      role: name === 'admin' || name === 'banned' ? 'admin' : 'user',
      isBanned: name === 'banned',
      ...(name === 'deleted' ? { deletedAt: 1 } : {}),
    })),
    promoCodes: [
      {
        _id: 'promoCodes|code',
        code: 'TEST',
        title: 'Fixture promo',
        isActive: true,
        startsAt: 0,
        scope: 'platform',
        discountType: 'percent',
        discountValue: 10,
        perUserLimit: 1,
      },
    ],
    promoCodeRedemptions: [
      {
        _id: 'promoCodeRedemptions|used',
        promoCodeId: 'promoCodes|code',
        userId: 'users|used',
        discountAmount: 10,
        redeemedAt: 1,
      },
    ],
  });

  return { db, ctx: createCtx(db, subject) };
}

for (const authority of [{}, { userId: 'users|new' }, { userId: 'users|admin' }]) {
  test(`exhausted buyer cannot bypass its per-user limit using ${JSON.stringify(authority)}`, async () => {
    const { db, ctx } = setup('used');
    const before = structuredClone(db.tables);
    assert.deepEqual(await validate(ctx, { ...input, ...authority }), {
      valid: false,
      reason: 'Promo code already used',
    });
    assert.deepEqual(db.tables, before);
  });
}

for (const subject of ['new', 'admin']) {
  test(`${subject} eligibility uses its own history, ignoring a forged exhausted user`, async () => {
    const { db, ctx } = setup(subject);
    const before = structuredClone(db.tables);
    assert.deepEqual(await validate(ctx, { ...input, userId: 'users|used' }), {
      valid: true,
      promoCodeId: 'promoCodes|code',
      code: 'TEST',
      title: 'Fixture promo',
      discountAmount: 10,
      totalAfterDiscount: 90,
    });
    assert.deepEqual(db.tables, before);
  });
}

for (const [label, subject, message] of [
  ['anonymous', null, /Unauthenticated/],
  ['unknown', 'unknown', /Account not found/],
  ['banned staff', 'banned', /Account is banned/],
  ['deleted', 'deleted', /Account is deleted/],
] as const) {
  test(`promo eligibility rejects ${label} before promo lookup, even for nonexistent codes`, async () => {
    const { db, ctx } = setup(subject);
    const query = db.query;
    db.query = (table) => {
      assert.equal(table, 'users');
      return query(table);
    };
    const before = structuredClone(db.tables);
    for (const code of ['TEST', 'ABSENT']) {
      await assert.rejects(() => validate(ctx, { ...input, code, userId: 'users|new' }), message);
    }
    assert.deepEqual(db.tables, before);
  });
}

test('legacy tombstone wins over an active profile for promo eligibility', async () => {
  const { db, ctx } = setup('new');
  assert.ok(db.tables.users);
  db.tables.users.push({ _id: 'users|tombstone', clerkId: 'deleted:new', deletedAt: 1, role: 'user', isBanned: false });
  const before = structuredClone(db.tables);
  await assert.rejects(() => validate(ctx, input), /Account is deleted/);
  assert.deepEqual(db.tables, before);
});

test('registered promo eligibility args remove acting userId and preserve all quote-resource args', () => {
  assert.ok('exportArgs' in validatePromoCode && typeof validatePromoCode.exportArgs === 'function');
  const schema: unknown = JSON.parse(validatePromoCode.exportArgs());
  assert.ok(typeof schema === 'object' && schema !== null && 'value' in schema);
  assert.ok(typeof schema.value === 'object' && schema.value !== null);
  assert.deepEqual(Object.keys(schema.value).sort(), ['categoryIds', 'code', 'productIds', 'sellerId', 'subtotal']);
});

test('existing missing/inactive/window/scope/discount/global-limit results remain unchanged for active buyers', async () => {
  const cases: Array<{
    fields: Record<string, unknown>;
    args?: Record<string, unknown>;
    expected: Record<string, unknown>;
  }> = [
    { fields: { isActive: false }, expected: { valid: false, reason: 'Promo code not found' } },
    { fields: { endsAt: 1 }, expected: { valid: false, reason: 'Promo code is not active' } },
    {
      fields: { minimumSubtotal: 200 },
      expected: { valid: false, reason: 'Order subtotal is below the promo minimum' },
    },
    {
      fields: { scope: 'seller', sellerId: 'users|seller' },
      args: { sellerId: 'users|other' },
      expected: { valid: false, reason: 'Promo code does not apply to this seller' },
    },
    { fields: { usageLimit: 1 }, expected: { valid: false, reason: 'Promo code usage limit reached' } },
    {
      fields: { discountType: 'fixed_amount', discountValue: 200, maxDiscount: 15 },
      expected: {
        valid: true,
        promoCodeId: 'promoCodes|code',
        code: 'TEST',
        title: 'Fixture promo',
        discountAmount: 15,
        totalAfterDiscount: 85,
      },
    },
  ];
  for (const scenario of cases) {
    const { db, ctx } = setup('new');
    const promo = db.tables.promoCodes?.[0];
    assert.ok(promo);
    Object.assign(promo, scenario.fields);
    const before = structuredClone(db.tables);
    assert.deepEqual(await validate(ctx, { ...input, ...scenario.args }), scenario.expected);
    assert.deepEqual(db.tables, before);
  }
  assert.deepEqual(await validate(setup('new').ctx, { ...input, code: 'ABSENT' }), {
    valid: false,
    reason: 'Promo code not found',
  });
});
