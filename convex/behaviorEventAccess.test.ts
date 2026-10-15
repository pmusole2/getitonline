import assert from 'node:assert/strict';
import test from 'node:test';

import { recordBehaviorEvent } from './notifications';
import { createCtx, createDb, handlerOf } from '../tests/support/convexFakeDb';

// Executes real handlers using DB/auth doubles, distinct from SDK/JWT transport verification.
const record = handlerOf<Record<string, unknown>, string>(recordBehaviorEvent);
const event = { eventType: 'product_view', productId: 'products|p', categoryId: 'categories|c' };

function setup(subject: string | null) {
  const db = createDb({
    users: ['ada', 'bea', 'admin', 'banned', 'deleted'].map((name) => ({
      _id: `users|${name}`,
      clerkId: name,
      role: name === 'admin' ? 'admin' : 'user',
      isBanned: name === 'banned',
      ...(name === 'deleted' ? { deletedAt: 1 } : {}),
    })),
  });
  return { db, ctx: createCtx(db, subject) };
}

test('behavior attribution comes from verified actor, including staff, and omits session assertions', async () => {
  for (const subject of ['ada', 'admin']) {
    const { db, ctx } = setup(subject);
    const id = await record(ctx, { ...event, expectedClerkId: subject, userId: 'users|bea' });
    const row = db.tables.behaviorEvents?.[0];
    assert.equal(row?._id, id);
    assert.equal(row?.userId, `users|${subject}`);
    assert.equal(row?.productId, event.productId);
    assert.equal(row?.categoryId, event.categoryId);
    assert.ok(!Object.prototype.hasOwnProperty.call(row ?? {}, 'expectedClerkId'));
  }
});

test('genuine anonymous browsing cannot forge account attribution', async () => {
  const { db, ctx } = setup(null);
  await record(ctx, { ...event, expectedClerkId: null, userId: 'users|ada', anonymousId: 'guest-fixture' });
  const row = db.tables.behaviorEvents?.[0];
  assert.equal(row?.userId, undefined);
  assert.equal(row?.anonymousId, 'guest-fixture');
  assert.ok(!Object.prototype.hasOwnProperty.call(row ?? {}, 'expectedClerkId'));
});

for (const [subject, message] of [
  ['unknown', /Account not found/],
  ['banned', /Account is banned/],
  ['deleted', /Account is deleted/],
] as const) {
  test(`behavior rejects signed-in ${subject}, without falling back to guest`, async () => {
    const { db, ctx } = setup(subject);
    const before = structuredClone(db.tables);
    await assert.rejects(() => record(ctx, { ...event, expectedClerkId: subject }), message);
    assert.deepEqual(db.tables, before);
  });
}

test('behavior rejects a legacy deletion marker even with an active duplicate', async () => {
  const { db, ctx } = setup('ada');
  assert.ok(db.tables.users);
  db.tables.users.push({ _id: 'users|tombstone', clerkId: 'deleted:ada', role: 'user', isBanned: true });
  const before = structuredClone(db.tables);
  await assert.rejects(() => record(ctx, { ...event, expectedClerkId: 'ada' }), /Account is (deleted|banned)/);
  assert.deepEqual(db.tables, before);
});

test('queued behavior cannot cross guest, sign-out or account-switch boundaries', async () => {
  for (const [subject, expectedClerkId] of [
    ['bea', 'ada'],
    ['ada', null],
    [null, 'ada'],
    ['ada', undefined],
  ] as const) {
    const { db, ctx } = setup(subject);
    const before = structuredClone(db.tables);
    await assert.rejects(() => record(ctx, { ...event, expectedClerkId }), /Authentication changed/);
    assert.deepEqual(db.tables, before);
  }
});

test('registered behavior schema forbids acting userId and requires a null/string session assertion', () => {
  const fn = recordBehaviorEvent as unknown as { exportArgs: () => string };
  const schema = JSON.parse(fn.exportArgs());
  assert.ok(!Object.prototype.hasOwnProperty.call(schema.value, 'userId'));
  assert.equal(schema.value.expectedClerkId.optional, false);
  assert.equal(schema.value.expectedClerkId.fieldType.type, 'union');
});
