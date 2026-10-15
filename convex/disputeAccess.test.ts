import assert from 'node:assert/strict';
import test from 'node:test';

import * as disputes from './disputes';
import { createCtx, createDb, handlerOf, type Db, type Tables } from '../tests/support/convexFakeDb';

// Runs the real dispute handlers against the in-memory database. Spoof tests pass the acting ID an old client sent
// (`buyerId`, `userId`, `sellerId`), so a caller-supplied ID must not change who the handler treats as the actor.
// Every rejection also asserts that no table changed, because the fake does not roll writes back.

type Args = Record<string, unknown>;

const createDispute = handlerOf<Args, string>(disputes.createDispute);
const getDispute = handlerOf<Args, Record<string, unknown> | null>(disputes.getDispute);
const getDisputeByOrder = handlerOf<Args, Record<string, unknown> | null>(disputes.getDisputeByOrder);
const getBuyerDisputes = handlerOf<Args, Array<Record<string, unknown>>>(disputes.getBuyerDisputes);
const getSellerDisputes = handlerOf<Args, Array<Record<string, unknown>>>(disputes.getSellerDisputes);
const updateDisputeStatus = handlerOf<Args, Record<string, unknown> | null>(disputes.updateDisputeStatus);
const addEvidence = handlerOf<Args, Record<string, unknown> | null>(disputes.addEvidence);

function user(id: string, clerkId: string, role: string, extra: Record<string, unknown> = {}) {
  return {
    _id: id,
    clerkId,
    role,
    isBanned: false,
    email: `${clerkId}@example.invalid`,
    firstName: 'Fixture',
    lastName: id,
    ...extra,
  };
}

function order(id: string, buyerId: string, sellerId: string, status: string) {
  return {
    _id: id,
    buyerId,
    sellerId,
    status,
    orderNumber: id.replace('orders|', 'ORD-'),
    totalAmount: 100,
    updatedAt: 1,
  };
}

function escrow(id: string, orderId: string) {
  return { _id: id, orderId, amount: 100, status: 'held', createdAt: 1, updatedAt: 1 };
}

function dispute(id: string, orderId: string, escrowId: string, buyerId: string, sellerId: string, status: string) {
  return {
    _id: id,
    orderId,
    escrowId,
    buyerId,
    sellerId,
    title: `Dispute ${id}`,
    description: 'The item did not arrive',
    category: 'not_received',
    evidence: [],
    status,
    createdAt: 1,
    updatedAt: 1,
  };
}

function fixtureTables(): Tables {
  return {
    users: [
      user('users|buyer', 'clerk_buyer', 'user', { firstName: 'Bea', lastName: 'Buyer' }),
      user('users|other_buyer', 'clerk_other_buyer', 'user'),
      user('users|seller', 'clerk_seller', 'user', { firstName: 'Sam', lastName: 'Seller' }),
      user('users|other_seller', 'clerk_other_seller', 'user'),
      user('users|company', 'clerk_company', 'user', { firstName: 'Gettitonline', lastName: 'Store' }),
      user('users|outsider', 'clerk_outsider', 'user'),
      user('users|catalog', 'clerk_catalog', 'catalog_manager'),
      user('users|moderator', 'clerk_moderator', 'moderator'),
      user('users|admin', 'clerk_admin', 'admin'),
      user('users|banned_moderator', 'clerk_banned_moderator', 'moderator', { isBanned: true }),
      user('users|banned_buyer', 'clerk_banned_buyer', 'user', { isBanned: true }),
      user('users|deleted_buyer', 'clerk_deleted_buyer', 'user', { deletedAt: 1 }),
    ],
    platformSettings: [{ _id: 'platformSettings|1', key: 'singleton', companySellerUserId: 'users|company' }],
    orders: [
      order('orders|buyer', 'users|buyer', 'users|seller', 'delivered'),
      order('orders|company', 'users|buyer', 'users|company', 'delivered'),
      order('orders|other', 'users|other_buyer', 'users|other_seller', 'delivered'),
      order('orders|plain', 'users|buyer', 'users|seller', 'delivered'),
      order('orders|paid', 'users|buyer', 'users|seller', 'paid'),
      order('orders|resolved', 'users|buyer', 'users|seller', 'completed'),
    ],
    escrow: [
      escrow('escrow|buyer', 'orders|buyer'),
      escrow('escrow|company', 'orders|company'),
      escrow('escrow|other', 'orders|other'),
      escrow('escrow|plain', 'orders|plain'),
      escrow('escrow|resolved', 'orders|resolved'),
    ],
    disputes: [
      dispute('disputes|buyer', 'orders|buyer', 'escrow|buyer', 'users|buyer', 'users|seller', 'open'),
      dispute('disputes|company', 'orders|company', 'escrow|company', 'users|buyer', 'users|company', 'open'),
      dispute(
        'disputes|other',
        'orders|other',
        'escrow|other',
        'users|other_buyer',
        'users|other_seller',
        'in_discussion',
      ),
      dispute('disputes|resolved', 'orders|resolved', 'escrow|resolved', 'users|buyer', 'users|seller', 'resolved'),
    ],
    messages: [],
    notifications: [],
  };
}

function freshDb(): Db {
  return createDb(fixtureTables());
}

function disputeRow(db: Db, id: string) {
  return db.tables.disputes?.find((row) => row._id === id);
}

function messagesFor(db: Db, disputeId: string) {
  return (db.tables.messages ?? []).filter((row) => row.disputeId === disputeId);
}

async function assertRejects(promise: Promise<unknown>, message: RegExp) {
  await assert.rejects(promise, message);
}

const actingAs = (db: Db, subject: string | null) => createCtx(db, subject);

const reviewBody = { title: 'Late', description: 'Still waiting', category: 'not_received', evidence: [] };

// createDispute ---------------------------------------------------------------------------------------------------

test('createDispute: a buyer opens a dispute on their delivered order, attributed to them', async () => {
  const db = freshDb();

  const id = await createDispute(actingAs(db, 'clerk_buyer'), { orderId: 'orders|plain', ...reviewBody });

  const created = disputeRow(db, id);
  assert.equal(created?.buyerId, 'users|buyer');
  assert.equal(created?.sellerId, 'users|seller');
  assert.equal(db.tables.escrow?.find((row) => row._id === 'escrow|plain')?.status, 'disputed');
  assert.equal(db.tables.orders?.find((row) => row._id === 'orders|plain')?.status, 'disputed');
  assert.equal(messagesFor(db, id)[0]?.senderId, 'users|buyer');
  assert.equal(db.tables.notifications?.[0]?.userId, 'users|seller');
});

test("createDispute: a caller-supplied buyerId cannot open a dispute on someone else's order", async () => {
  const db = freshDb();
  const before = structuredClone(db.tables);

  await assertRejects(
    createDispute(actingAs(db, 'clerk_outsider'), { orderId: 'orders|plain', buyerId: 'users|buyer', ...reviewBody }),
    /Unauthorized/,
  );
  assert.deepEqual(db.tables, before);
});

test('createDispute: the seller of an order cannot open a dispute on it', async () => {
  const db = freshDb();
  const before = structuredClone(db.tables);

  await assertRejects(
    createDispute(actingAs(db, 'clerk_seller'), { orderId: 'orders|plain', ...reviewBody }),
    /Unauthorized/,
  );
  assert.deepEqual(db.tables, before);
});

test('createDispute: staff cannot open disputes on orders they do not buy', async () => {
  const db = freshDb();
  const before = structuredClone(db.tables);

  await assertRejects(
    createDispute(actingAs(db, 'clerk_admin'), { orderId: 'orders|plain', ...reviewBody }),
    /Unauthorized/,
  );
  assert.deepEqual(db.tables, before);
});

test('createDispute: anonymous, unknown, banned, and deleted callers are refused before any write', async () => {
  const cases: Array<[string | null, RegExp]> = [
    [null, /Unauthenticated/],
    ['clerk_nobody', /Account not found/],
    ['clerk_banned_buyer', /Account is banned/],
    ['clerk_deleted_buyer', /Account is deleted/],
  ];
  for (const [subject, message] of cases) {
    const db = freshDb();
    const before = structuredClone(db.tables);
    await assertRejects(createDispute(actingAs(db, subject), { orderId: 'orders|plain', ...reviewBody }), message);
    assert.deepEqual(db.tables, before, `${subject} must not change any table`);
  }
});

test('createDispute: an order that is not delivered or shipped cannot be disputed', async () => {
  const db = freshDb();
  const before = structuredClone(db.tables);

  await assertRejects(
    createDispute(actingAs(db, 'clerk_buyer'), { orderId: 'orders|paid', ...reviewBody }),
    /Order must be delivered or shipped/,
  );
  assert.deepEqual(db.tables, before);
});

// getDispute -------------------------------------------------------------------------------------------------------

test('getDispute: the buyer and the seller read the dispute with its order, escrow, and parties', async () => {
  const db = freshDb();

  for (const subject of ['clerk_buyer', 'clerk_seller']) {
    const result = await getDispute(actingAs(db, subject), { disputeId: 'disputes|buyer' });
    assert.equal(result?._id, 'disputes|buyer');
    assert.equal((result?.order as Record<string, unknown> | undefined)?._id, 'orders|buyer');
    assert.equal((result?.escrow as Record<string, unknown> | undefined)?._id, 'escrow|buyer');
    assert.equal((result?.buyer as Record<string, unknown> | undefined)?.firstName, 'Bea');
  }
});

test('getDispute: an unrelated signed-in user is refused, even when passing a participant ID', async () => {
  const db = freshDb();

  await assertRejects(
    getDispute(actingAs(db, 'clerk_outsider'), { disputeId: 'disputes|buyer', userId: 'users|buyer' }),
    /Unauthorized/,
  );
});

test('getDispute: reviewers can read any dispute', async () => {
  const db = freshDb();

  for (const subject of ['clerk_moderator', 'clerk_admin']) {
    const result = await getDispute(actingAs(db, subject), { disputeId: 'disputes|other' });
    assert.equal(result?._id, 'disputes|other', subject);
  }
});

test('getDispute: a catalog manager reads company disputes through company delegation only', async () => {
  const db = freshDb();

  const company = await getDispute(actingAs(db, 'clerk_catalog'), { disputeId: 'disputes|company' });
  assert.equal(company?._id, 'disputes|company');
  await assertRejects(getDispute(actingAs(db, 'clerk_catalog'), { disputeId: 'disputes|other' }), /Unauthorized/);
});

test('getDispute: a missing dispute is a null result, not an error', async () => {
  const db = freshDb();

  assert.equal(await getDispute(actingAs(db, 'clerk_buyer'), { disputeId: 'disputes|missing' }), null);
});

test('getDispute: anonymous and banned callers are refused', async () => {
  const db = freshDb();

  await assertRejects(getDispute(actingAs(db, null), { disputeId: 'disputes|buyer' }), /Unauthenticated/);
  await assertRejects(
    getDispute(actingAs(db, 'clerk_banned_buyer'), { disputeId: 'disputes|buyer' }),
    /Account is banned/,
  );
});

// getDisputeByOrder ------------------------------------------------------------------------------------------------

test('getDisputeByOrder: the buyer and the seller see the summary for their order, without escrow', async () => {
  const db = freshDb();

  for (const subject of ['clerk_buyer', 'clerk_seller']) {
    const result = await getDisputeByOrder(actingAs(db, subject), { orderId: 'orders|buyer' });
    assert.equal(result?._id, 'disputes|buyer');
    assert.equal(result?.title, 'Dispute disputes|buyer');
    assert.equal('escrow' in (result ?? {}), false, 'the summary must not include escrow');
  }
});

test('getDisputeByOrder: an unrelated user is refused even though a dispute exists for the order', async () => {
  const db = freshDb();

  await assertRejects(getDisputeByOrder(actingAs(db, 'clerk_outsider'), { orderId: 'orders|buyer' }), /Unauthorized/);
});

test('getDisputeByOrder: an order without a dispute yields null for its buyer', async () => {
  const db = freshDb();

  assert.equal(await getDisputeByOrder(actingAs(db, 'clerk_buyer'), { orderId: 'orders|plain' }), null);
});

test('getDisputeByOrder: reviewers can read the summary', async () => {
  const db = freshDb();

  const result = await getDisputeByOrder(actingAs(db, 'clerk_moderator'), { orderId: 'orders|buyer' });
  assert.equal(result?._id, 'disputes|buyer');
});

// getBuyerDisputes ------------------------------------------------------------------------------------------------

test('getBuyerDisputes: a buyer lists only their own disputes, and the status filter applies', async () => {
  const db = freshDb();

  const all = await getBuyerDisputes(actingAs(db, 'clerk_buyer'), {});
  assert.deepEqual(all.map((row) => row._id).sort(), ['disputes|buyer', 'disputes|company', 'disputes|resolved']);

  const open = await getBuyerDisputes(actingAs(db, 'clerk_buyer'), { status: 'open' });
  assert.deepEqual(open.map((row) => row._id).sort(), ['disputes|buyer', 'disputes|company']);
});

test("getBuyerDisputes: a caller-supplied buyerId cannot list another buyer's disputes", async () => {
  const db = freshDb();

  const result = await getBuyerDisputes(actingAs(db, 'clerk_buyer'), { buyerId: 'users|other_buyer' });
  assert.deepEqual(result.map((row) => row._id).sort(), ['disputes|buyer', 'disputes|company', 'disputes|resolved']);
});

test('getBuyerDisputes: anonymous and banned callers are refused', async () => {
  const db = freshDb();

  await assertRejects(getBuyerDisputes(actingAs(db, null), {}), /Unauthenticated/);
  await assertRejects(getBuyerDisputes(actingAs(db, 'clerk_banned_buyer'), {}), /Account is banned/);
});

// getSellerDisputes -----------------------------------------------------------------------------------------------

test('getSellerDisputes: a seller lists disputes for their own account', async () => {
  const db = freshDb();

  const result = await getSellerDisputes(actingAs(db, 'clerk_seller'), { sellerId: 'users|seller' });
  assert.deepEqual(result.map((row) => row._id).sort(), ['disputes|buyer', 'disputes|resolved']);
});

test("getSellerDisputes: a seller cannot list another seller's disputes", async () => {
  const db = freshDb();

  await assertRejects(
    getSellerDisputes(actingAs(db, 'clerk_seller'), { sellerId: 'users|other_seller' }),
    /Unauthorized/,
  );
});

test("getSellerDisputes: catalog managers list company-seller disputes, not another vendor's", async () => {
  const db = freshDb();

  const company = await getSellerDisputes(actingAs(db, 'clerk_catalog'), { sellerId: 'users|company' });
  assert.deepEqual(
    company.map((row) => row._id),
    ['disputes|company'],
  );
  await assertRejects(
    getSellerDisputes(actingAs(db, 'clerk_catalog'), { sellerId: 'users|other_seller' }),
    /Unauthorized/,
  );
});

test("getSellerDisputes: a buyer cannot list a seller's disputes", async () => {
  const db = freshDb();

  await assertRejects(getSellerDisputes(actingAs(db, 'clerk_buyer'), { sellerId: 'users|seller' }), /Unauthorized/);
});

test("getSellerDisputes: reviewers can list any seller's disputes", async () => {
  const db = freshDb();

  const result = await getSellerDisputes(actingAs(db, 'clerk_moderator'), { sellerId: 'users|seller' });
  assert.deepEqual(result.map((row) => row._id).sort(), ['disputes|buyer', 'disputes|resolved']);
});

// updateDisputeStatus ---------------------------------------------------------------------------------------------

test('updateDisputeStatus: a buyer moves an open dispute to in_discussion, attributed to the buyer', async () => {
  const db = freshDb();

  await updateDisputeStatus(actingAs(db, 'clerk_buyer'), { disputeId: 'disputes|buyer', status: 'in_discussion' });

  assert.equal(disputeRow(db, 'disputes|buyer')?.status, 'in_discussion');
  assert.equal(messagesFor(db, 'disputes|buyer')[0]?.senderId, 'users|buyer');
});

test('updateDisputeStatus: an unrelated user cannot move a dispute to in_discussion, even passing a participant as userId', async () => {
  const db = freshDb();
  const before = structuredClone(db.tables);

  await assertRejects(
    updateDisputeStatus(actingAs(db, 'clerk_outsider'), {
      disputeId: 'disputes|buyer',
      userId: 'users|buyer',
      status: 'in_discussion',
    }),
    /Unauthorized/,
  );
  assert.deepEqual(db.tables, before);
});

test('updateDisputeStatus: the seller and reviewers can move an open dispute to in_discussion', async () => {
  for (const subject of ['clerk_seller', 'clerk_moderator']) {
    const db = freshDb();

    await updateDisputeStatus(actingAs(db, subject), { disputeId: 'disputes|buyer', status: 'in_discussion' });

    assert.equal(disputeRow(db, 'disputes|buyer')?.status, 'in_discussion', subject);
  }
});

test('updateDisputeStatus: in_discussion still requires an open dispute, and nothing changes when refused', async () => {
  const db = freshDb();
  const before = structuredClone(db.tables);

  await assertRejects(
    updateDisputeStatus(actingAs(db, 'clerk_other_buyer'), { disputeId: 'disputes|other', status: 'in_discussion' }),
    /Can only move to in_discussion from open status/,
  );
  assert.deepEqual(db.tables, before);
});

test('updateDisputeStatus: only a buyer or seller can request moderator review', async () => {
  const db = freshDb();

  await assertRejects(
    updateDisputeStatus(actingAs(db, 'clerk_moderator'), { disputeId: 'disputes|buyer', status: 'moderator_review' }),
    /Only buyer or seller can request moderator review/,
  );
  await updateDisputeStatus(actingAs(db, 'clerk_buyer'), { disputeId: 'disputes|buyer', status: 'moderator_review' });
  assert.equal(disputeRow(db, 'disputes|buyer')?.status, 'moderator_review');
});

test('updateDisputeStatus: an unrelated user cannot request moderator review', async () => {
  const db = freshDb();
  const before = structuredClone(db.tables);

  await assertRejects(
    updateDisputeStatus(actingAs(db, 'clerk_outsider'), { disputeId: 'disputes|buyer', status: 'moderator_review' }),
    /Unauthorized/,
  );
  assert.deepEqual(db.tables, before);
});

test('updateDisputeStatus: only reviewers can resolve or close, and unrelated users are refused first', async () => {
  const db = freshDb();
  const before = structuredClone(db.tables);

  await assertRejects(
    updateDisputeStatus(actingAs(db, 'clerk_buyer'), { disputeId: 'disputes|buyer', status: 'closed' }),
    /Only moderators can resolve or close disputes/,
  );
  await assertRejects(
    updateDisputeStatus(actingAs(db, 'clerk_outsider'), { disputeId: 'disputes|buyer', status: 'closed' }),
    /Unauthorized/,
  );
  assert.equal(disputeRow(db, 'disputes|buyer')?.status, before.disputes?.[0]?.status);

  await updateDisputeStatus(actingAs(db, 'clerk_moderator'), { disputeId: 'disputes|buyer', status: 'closed' });
  assert.equal(disputeRow(db, 'disputes|buyer')?.status, 'closed');
});

test('updateDisputeStatus: a catalog manager moves company disputes through company delegation only', async () => {
  const db = freshDb();

  await updateDisputeStatus(actingAs(db, 'clerk_catalog'), { disputeId: 'disputes|company', status: 'in_discussion' });
  assert.equal(disputeRow(db, 'disputes|company')?.status, 'in_discussion');

  const before = structuredClone(db.tables);
  await assertRejects(
    updateDisputeStatus(actingAs(db, 'clerk_catalog'), { disputeId: 'disputes|other', status: 'in_discussion' }),
    /Unauthorized/,
  );
  assert.deepEqual(db.tables, before);
});

test('updateDisputeStatus: banned staff cannot change a dispute', async () => {
  const db = freshDb();
  const before = structuredClone(db.tables);

  await assertRejects(
    updateDisputeStatus(actingAs(db, 'clerk_banned_moderator'), { disputeId: 'disputes|buyer', status: 'closed' }),
    /Account is banned/,
  );
  assert.deepEqual(db.tables, before);
});

test('updateDisputeStatus: a missing dispute is still reported as not found', async () => {
  const db = freshDb();

  await assertRejects(
    updateDisputeStatus(actingAs(db, 'clerk_buyer'), { disputeId: 'disputes|missing', status: 'in_discussion' }),
    /Dispute not found/,
  );
});

// addEvidence -----------------------------------------------------------------------------------------------------

const photo = { type: 'image', url: 'https://example.invalid/photo.jpg', uploadedAt: 2 };

test('addEvidence: a caller-supplied userId cannot attach evidence as someone else', async () => {
  const db = freshDb();
  const before = structuredClone(db.tables);

  await assertRejects(
    addEvidence(actingAs(db, 'clerk_outsider'), {
      disputeId: 'disputes|buyer',
      userId: 'users|seller',
      evidence: photo,
    }),
    /Unauthorized/,
  );
  assert.deepEqual(db.tables, before);
});

test('addEvidence: the buyer and the seller can attach evidence', async () => {
  const db = freshDb();

  await addEvidence(actingAs(db, 'clerk_buyer'), { disputeId: 'disputes|buyer', evidence: photo });
  await addEvidence(actingAs(db, 'clerk_seller'), { disputeId: 'disputes|buyer', evidence: photo });

  assert.equal((disputeRow(db, 'disputes|buyer')?.evidence as unknown[]).length, 2);
});

test('addEvidence: reviewers cannot attach evidence merely because they can review the dispute', async () => {
  const db = freshDb();
  const before = structuredClone(db.tables);

  for (const subject of ['clerk_moderator', 'clerk_admin']) {
    await assertRejects(
      addEvidence(actingAs(db, subject), { disputeId: 'disputes|buyer', evidence: photo }),
      /Unauthorized/,
    );
  }
  assert.deepEqual(db.tables, before);
});

test('addEvidence: a catalog manager attaches company evidence through company delegation only', async () => {
  const db = freshDb();

  await addEvidence(actingAs(db, 'clerk_catalog'), { disputeId: 'disputes|company', evidence: photo });
  assert.equal((disputeRow(db, 'disputes|company')?.evidence as unknown[]).length, 1);

  const before = structuredClone(db.tables);
  await assertRejects(
    addEvidence(actingAs(db, 'clerk_catalog'), { disputeId: 'disputes|other', evidence: photo }),
    /Unauthorized/,
  );
  assert.deepEqual(db.tables, before);
});

test('addEvidence: a resolved dispute takes no evidence, and unrelated users are refused before that check', async () => {
  const db = freshDb();
  const before = structuredClone(db.tables);

  await assertRejects(
    addEvidence(actingAs(db, 'clerk_buyer'), { disputeId: 'disputes|resolved', evidence: photo }),
    /Cannot add evidence to resolved dispute/,
  );
  await assertRejects(
    addEvidence(actingAs(db, 'clerk_outsider'), { disputeId: 'disputes|resolved', evidence: photo }),
    /Unauthorized/,
  );
  assert.deepEqual(db.tables, before);
});

test('addEvidence: banned participants are refused', async () => {
  const db = freshDb();
  const before = structuredClone(db.tables);

  await assertRejects(
    addEvidence(actingAs(db, 'clerk_banned_buyer'), { disputeId: 'disputes|buyer', evidence: photo }),
    /Account is banned/,
  );
  assert.deepEqual(db.tables, before);
});

// Scope -----------------------------------------------------------------------------------------------------------

// Functions this batch binds. Every other export is listed as out of scope, so a new export cannot reach clients
// without a decision about its guard. updateAISummary has no guard; it stays exposed until the AI migration.
const BOUND_BY_THIS_BATCH = [
  'createDispute',
  'getDispute',
  'getDisputeByOrder',
  'getBuyerDisputes',
  'getSellerDisputes',
  'updateDisputeStatus',
  'addEvidence',
];
const OUT_OF_THIS_BATCH = [
  'getOpenDisputes',
  'getModeratorDisputes',
  'assignModerator',
  'resolveDispute',
  'buyerResolveDispute',
  'updateAISummary',
  'getDisputeStats',
];

test('every disputes.ts export is bound by this batch or listed as out of scope', () => {
  const exported = Object.keys(disputes);

  for (const name of exported) {
    assert.ok(
      BOUND_BY_THIS_BATCH.includes(name) || OUT_OF_THIS_BATCH.includes(name),
      `disputes.${name} is not classified`,
    );
  }
  for (const name of BOUND_BY_THIS_BATCH) {
    assert.ok(exported.includes(name), `disputes.${name} must be exported`);
  }
});
