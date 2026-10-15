import assert from 'node:assert/strict';
import test from 'node:test';

import * as disputes from './disputes';
import * as orders from './orders';
import { createCtx, createDb, handlerOf, type Db, type Row, type Tables } from '../tests/support/convexFakeDb';

// A recorded dispute decision is final, and escrow is opened for a dispute only while it holds funds. These tests run the
// real handlers against the in-memory fake. The fake does not roll back, so every refused call must be refused before its
// first write, and each refusal must leave every table unchanged.

type Args = Record<string, unknown>;

const createDispute = handlerOf<Args, string>(disputes.createDispute);
const updateDisputeStatus = handlerOf<Args, Row | null>(disputes.updateDisputeStatus);
const assignModerator = handlerOf<Args, Row | null>(disputes.assignModerator);
const resolveDispute = handlerOf<Args, Row | null>(disputes.resolveDispute);
const buyerResolveDispute = handlerOf<Args, Row | null>(disputes.buyerResolveDispute);
const updateOrderStatus = handlerOf<Args, Row | null>(orders.updateOrderStatus);

function account(id: string, clerkId: string, role: string): Row {
  return {
    _id: id,
    clerkId,
    email: `${clerkId}@example.invalid`,
    firstName: 'Fixture',
    lastName: id,
    role,
    isBanned: false,
  };
}

function fixtureTables(orderStatus: string, escrowStatus: string): Tables {
  return {
    users: [
      account('users|buyer', 'clerk_buyer', 'user'),
      account('users|other_buyer', 'clerk_other_buyer', 'user'),
      account('users|seller', 'clerk_seller', 'user'),
      account('users|moderator', 'clerk_moderator', 'moderator'),
      account('users|admin', 'clerk_admin', 'admin'),
      account('users|outsider', 'clerk_outsider', 'user'),
      { ...account('users|banned', 'clerk_banned', 'user'), isBanned: true },
      { ...account('users|deleted', 'clerk_deleted', 'user'), deletedAt: 1 },
    ],
    orders: [
      {
        _id: 'orders|1',
        orderNumber: 'ORD-1',
        buyerId: 'users|buyer',
        sellerId: 'users|seller',
        status: orderStatus,
        items: [],
        totalAmount: 100,
        updatedAt: 1,
      },
    ],
    escrow: [{ _id: 'escrow|1', orderId: 'orders|1', amount: 90, grossAmount: 100, status: escrowStatus }],
    transactions: [{ _id: 'transactions|paid', orderId: 'orders|1', status: 'successful' }],
  };
}

function setup(orderStatus: string, escrowStatus: string, clerkId: string | null) {
  const db: Db = createDb(fixtureTables(orderStatus, escrowStatus));
  return { db, ctx: createCtx(db, clerkId) };
}

function rowOf(db: Db, table: string, id: string): Row {
  const found = db.tables[table]?.find((candidate) => candidate._id === id);
  assert.ok(found, `${id} must exist`);
  return found;
}

const REVIEW = {
  title: 'Item is defective',
  description: 'It broke on the first day',
  category: 'defective',
  evidence: [],
};

// Opens a dispute the way the buyer does, through createDispute.
async function openDispute(orderStatus = 'delivered', escrowStatus = 'held') {
  const { db, ctx } = setup(orderStatus, escrowStatus, 'clerk_buyer');
  const disputeId = await createDispute(ctx, { orderId: 'orders|1', ...REVIEW });
  return { db, disputeId };
}

// Explicit historical marker-only state: unsupported staff mutual_agreement
// is no longer a valid new financial decision. Archive/reopen guards must still
// protect this recorded legacy decision without repairing its disputed escrow.
async function decideByMutualAgreement() {
  const opened = await openDispute();
  await opened.db.patch(opened.disputeId, {
    status: 'resolved',
    resolution: {
      type: 'mutual_agreement',
      resolvedBy: 'users|moderator',
      notes: 'Both parties agreed',
      resolvedAt: 2,
    },
  });
  await opened.db.patch('orders|1', { status: 'completed' });
  return opened;
}

test('a dispute opens only on held escrow, and refunded, released, partially refunded, or disputed escrow is refused before any write', async () => {
  for (const escrowStatus of ['refunded', 'released', 'partially_refunded', 'disputed']) {
    for (const orderStatus of ['delivered', 'shipped']) {
      const { db, ctx } = setup(orderStatus, escrowStatus, 'clerk_buyer');
      const before = structuredClone(db.tables);

      await assert.rejects(
        () => createDispute(ctx, { orderId: 'orders|1', ...REVIEW }),
        /Escrow cannot be disputed in current state/,
        `${escrowStatus} escrow on a ${orderStatus} order`,
      );
      assert.deepEqual(db.tables, before, `${escrowStatus} escrow on a ${orderStatus} order must change nothing`);
    }
  }
});

test('refunded escrow cannot be reopened by opening a dispute and withdrawing it', async () => {
  // The reproduction stops at createDispute: with no dispute, buyerResolveDispute(withdraw) has nothing to act on.
  const { db, ctx } = setup('delivered', 'refunded', 'clerk_buyer');
  await db.patch('escrow|1', { refundAmount: 100 });
  await db.patch('transactions|paid', { status: 'refunded' });
  const before = structuredClone(db.tables);

  await assert.rejects(() => createDispute(ctx, { orderId: 'orders|1', ...REVIEW }), /Escrow cannot be disputed/);

  assert.deepEqual(db.tables, before, 'no dispute, notice, or status change is written');
  assert.equal(rowOf(db, 'escrow', 'escrow|1').status, 'refunded');
  assert.equal(rowOf(db, 'escrow', 'escrow|1').refundAmount, 100);
  assert.equal(db.tables.disputes?.length ?? 0, 0);
});

test('held escrow opens a dispute for its buyer, moves the order and escrow into dispute, and tells the seller', async () => {
  for (const orderStatus of ['delivered', 'shipped']) {
    const { db, disputeId } = await openDispute(orderStatus);

    assert.equal(rowOf(db, 'disputes', disputeId).status, 'open', orderStatus);
    assert.equal(rowOf(db, 'disputes', disputeId).buyerId, 'users|buyer', orderStatus);
    assert.equal(rowOf(db, 'escrow', 'escrow|1').status, 'disputed', orderStatus);
    assert.equal(rowOf(db, 'orders', 'orders|1').status, 'disputed', orderStatus);
    const notice = db.tables.notifications?.find(
      (row) => row.userId === 'users|seller' && row.type === 'dispute_update',
    );
    assert.ok(notice, `${orderStatus}: the seller is told about the dispute`);
  }
});

test('only the buyer can open the dispute, and anonymous, unknown, banned, deleted, and other callers are refused before any write', async () => {
  const attempts: Array<{ clerkId: string | null; pattern: RegExp }> = [
    { clerkId: null, pattern: /Unauthenticated/ },
    { clerkId: 'clerk_nobody', pattern: /Account not found/ },
    { clerkId: 'clerk_banned', pattern: /Account is banned/ },
    { clerkId: 'clerk_deleted', pattern: /Account is deleted/ },
    { clerkId: 'clerk_seller', pattern: /Unauthorized/ },
    { clerkId: 'clerk_other_buyer', pattern: /Unauthorized/ },
    { clerkId: 'clerk_admin', pattern: /Unauthorized/ },
    { clerkId: 'clerk_outsider', pattern: /Unauthorized/ },
  ];
  for (const { clerkId, pattern } of attempts) {
    const { db, ctx } = setup('delivered', 'held', clerkId);
    const before = structuredClone(db.tables);

    await assert.rejects(() => createDispute(ctx, { orderId: 'orders|1', ...REVIEW }), pattern, String(clerkId));
    assert.deepEqual(db.tables, before, `${clerkId} must change nothing`);
  }
});

test('a second dispute on the same order is refused before any write', async () => {
  const { db, ctx } = setup('delivered', 'held', 'clerk_buyer');
  await createDispute(ctx, { orderId: 'orders|1', ...REVIEW });
  const before = structuredClone(db.tables);

  // The first dispute has moved the order to disputed, so its status refuses the second attempt before the duplicate check.
  await assert.rejects(() => createDispute(ctx, { orderId: 'orders|1', ...REVIEW }), /must be delivered or shipped/);
  assert.deepEqual(db.tables, before);
});

test('a dispute decided by mutual agreement cannot be sent back to review by the buyer or the seller', async () => {
  const { db, disputeId } = await decideByMutualAgreement();
  const decided = structuredClone(db.tables);

  // Only a buyer or seller may request review, so reviewers are covered by the reassignment test below.
  for (const clerkId of ['clerk_buyer', 'clerk_seller']) {
    await assert.rejects(
      () => updateDisputeStatus(createCtx(db, clerkId), { disputeId, status: 'moderator_review' }),
      /cannot be reopened/,
      clerkId,
    );
    assert.deepEqual(db.tables, decided, `${clerkId} must change nothing`);
  }
});

test('a decided dispute cannot be reassigned, and cannot be decided a second time', async () => {
  const { db, disputeId } = await decideByMutualAgreement();
  const decided = structuredClone(db.tables);

  await assert.rejects(
    () => assignModerator(createCtx(db, 'clerk_moderator'), { disputeId, moderatorId: 'users|moderator' }),
    /cannot be reopened/,
  );
  assert.deepEqual(db.tables, decided);

  await assert.rejects(
    () => resolveDispute(createCtx(db, 'clerk_admin'), { disputeId, resolutionType: 'full_refund', notes: 'Again' }),
    /already resolved or closed/,
  );
  assert.deepEqual(db.tables, decided);
});

test('a full refund cannot be erased by reopening the dispute and then agreeing a refund', async () => {
  const { db, disputeId } = await openDispute();
  // Recorded historical refund, not positive proof for issuing new money.
  await db.patch(disputeId, {
    status: 'resolved',
    resolution: {
      type: 'full_refund',
      refundAmount: 100,
      resolvedBy: 'users|admin',
      notes: 'Goods defective',
      resolvedAt: 2,
    },
  });
  await db.patch('escrow|1', { status: 'refunded', refundAmount: 100 });
  await db.patch('orders|1', { status: 'cancelled' });
  const decided = structuredClone(db.tables);

  await assert.rejects(
    () => updateDisputeStatus(createCtx(db, 'clerk_buyer'), { disputeId, status: 'moderator_review' }),
    /cannot be reopened/,
  );
  await assert.rejects(
    () => assignModerator(createCtx(db, 'clerk_moderator'), { disputeId, moderatorId: 'users|moderator' }),
    /cannot be reopened/,
  );
  await assert.rejects(
    () => buyerResolveDispute(createCtx(db, 'clerk_buyer'), { disputeId, resolutionType: 'agreed_refund' }),
    /cannot be resolved at this stage/,
  );

  assert.deepEqual(db.tables, decided, 'the recorded refund, and the order and escrow it set, stay as they were');
  assert.equal(rowOf(db, 'escrow', 'escrow|1').status, 'refunded');
  assert.equal(rowOf(db, 'orders', 'orders|1').status, 'cancelled');
});

test('a reviewer archives a resolved dispute by closing it, and the decision stays on record', async () => {
  const { db, disputeId } = await decideByMutualAgreement();
  const resolution = structuredClone(rowOf(db, 'disputes', disputeId).resolution);

  await updateDisputeStatus(createCtx(db, 'clerk_moderator'), { disputeId, status: 'closed' });

  assert.equal(rowOf(db, 'disputes', disputeId).status, 'closed');
  assert.deepEqual(rowOf(db, 'disputes', disputeId).resolution, resolution);
  const messages = db.tables.messages ?? [];
  assert.equal(messages[messages.length - 1]?.speakerSide, 'moderator');
});

test('a closed dispute cannot be reopened, moved, decided, or reassigned', async () => {
  const { db, disputeId } = await decideByMutualAgreement();
  await updateDisputeStatus(createCtx(db, 'clerk_moderator'), { disputeId, status: 'closed' });
  const closed = structuredClone(db.tables);

  // Each attempt is made by an actor who may make it, so the refusal comes from the closed state and not from a role check.
  const attempts: Array<{ clerkId: string; status: string; pattern: RegExp }> = [
    { clerkId: 'clerk_buyer', status: 'moderator_review', pattern: /cannot be reopened/ },
    { clerkId: 'clerk_moderator', status: 'in_discussion', pattern: /Can only move to in_discussion/ },
    { clerkId: 'clerk_moderator', status: 'resolved', pattern: /resolveDispute/ },
    { clerkId: 'clerk_moderator', status: 'closed', pattern: /cannot be reopened/ },
  ];
  for (const { clerkId, status, pattern } of attempts) {
    await assert.rejects(
      () => updateDisputeStatus(createCtx(db, clerkId), { disputeId, status }),
      pattern,
      `${clerkId} to ${status}`,
    );
    assert.deepEqual(db.tables, closed, `${clerkId} to ${status} must change nothing`);
  }

  await assert.rejects(
    () => assignModerator(createCtx(db, 'clerk_moderator'), { disputeId, moderatorId: 'users|moderator' }),
    /cannot be reopened/,
  );
  assert.deepEqual(db.tables, closed);
});

test('a dispute is decided only through resolveDispute, so a status update cannot record a resolution', async () => {
  const { db, disputeId } = await openDispute();
  const before = structuredClone(db.tables);

  await assert.rejects(
    () => updateDisputeStatus(createCtx(db, 'clerk_moderator'), { disputeId, status: 'resolved' }),
    /resolveDispute/,
  );
  assert.deepEqual(db.tables, before, 'the dispute, escrow, and order are left for resolveDispute to decide');
});

test('a legacy unfunded dispute enters review and assignment without minting money; an explicitly recorded historical decision remains archivable', async () => {
  const { db, disputeId } = await openDispute();
  await updateDisputeStatus(createCtx(db, 'clerk_seller'), { disputeId, status: 'in_discussion' });
  await updateDisputeStatus(createCtx(db, 'clerk_buyer'), { disputeId, status: 'moderator_review' });
  await assignModerator(createCtx(db, 'clerk_moderator'), { disputeId, moderatorId: 'users|moderator' });
  // Supply reciprocal owners so this negative reaches actual funding review,
  // rather than treating a marker-only fixture as funded financial authority.
  await db.patch('escrow|1', {
    buyerId: 'users|buyer',
    sellerId: 'users|seller',
    amount: 100,
    sellerAmount: 90,
    platformFee: 10,
  });
  const before = structuredClone(db.tables);
  await assert.rejects(
    () =>
      resolveDispute(createCtx(db, 'clerk_moderator'), {
        disputeId,
        resolutionType: 'partial_refund',
        refundAmount: 40,
        notes: 'Part of the goods were fine',
      }),
    /Escrow funding needs review/,
  );
  assert.deepEqual(db.tables, before);
  // Preserve the original archival characterization using explicit historical
  // state, rather than invoking marker-only money as a fixture constructor.
  await db.patch(disputeId, {
    status: 'resolved',
    resolution: {
      type: 'partial_refund',
      refundAmount: 40,
      resolvedBy: 'users|moderator',
      notes: 'Historical decision',
      resolvedAt: 2,
    },
  });
  await db.patch('escrow|1', { status: 'partially_refunded', refundAmount: 40 });
  await db.patch('orders|1', { status: 'completed' });
  const resolution = structuredClone(rowOf(db, 'disputes', disputeId).resolution);
  await updateDisputeStatus(createCtx(db, 'clerk_moderator'), { disputeId, status: 'closed' });
  assert.equal(rowOf(db, 'disputes', disputeId).status, 'closed');
  assert.deepEqual(rowOf(db, 'disputes', disputeId).resolution, resolution);
  assert.equal(rowOf(db, 'escrow', 'escrow|1').status, 'partially_refunded');
  assert.equal(rowOf(db, 'escrow', 'escrow|1').refundAmount, 40);
  assert.equal(rowOf(db, 'orders', 'orders|1').status, 'completed');
});

test('an order cannot enter or leave disputed through a generic status change, only through the dispute flow', async () => {
  const entering = setup('delivered', 'held', 'clerk_buyer');
  const enteringBefore = structuredClone(entering.db.tables);

  await assert.rejects(
    () => updateOrderStatus(entering.ctx, { orderId: 'orders|1', status: 'disputed' }),
    /Cannot transition/,
  );
  assert.deepEqual(entering.db.tables, enteringBefore);

  const { db } = await openDispute();
  const leaving = structuredClone(db.tables);

  await assert.rejects(
    () => updateOrderStatus(createCtx(db, 'clerk_moderator'), { orderId: 'orders|1', status: 'completed' }),
    /Cannot transition/,
  );
  assert.deepEqual(db.tables, leaving);
});
