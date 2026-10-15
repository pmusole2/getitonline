import assert from 'node:assert/strict';
import test from 'node:test';

import * as disputes from './disputes';
import * as messages from './messages';
import { createCtx, createDb, handlerOf, type Db, type Row, type Tables } from '../tests/support/convexFakeDb';

// Runs the real message handlers against the in-memory database. Private conversations must not be read by a caller
// who is not a participant, a reviewer, or the company seller side. Caller-supplied IDs never establish authority.
// Every rejection also asserts that no table changed, because the fake does not roll writes back.

type Args = Record<string, unknown>;

const sendMessage = handlerOf<Args, string>(messages.sendMessage);
const updateMessageWithRephrase = handlerOf<Args, Row | null>(messages.updateMessageWithRephrase);
const updateDisputeStatus = handlerOf<Args, Row | null>(disputes.updateDisputeStatus);
const assignModerator = handlerOf<Args, Row | null>(disputes.assignModerator);
const getMessages = handlerOf<Args, Row[]>(messages.getMessages);
const getMessagesPaginated = handlerOf<Args, { messages: Row[]; hasMore: boolean; nextCursor: string | null }>(
  messages.getMessagesPaginated,
);
const getMessageCount = handlerOf<Args, number>(messages.getMessageCount);
const getLastMessage = handlerOf<Args, Row | null>(messages.getLastMessage);
const getMessagesForAnalysis = handlerOf<Args, Row | null>(messages.getMessagesForAnalysis);

const BUYER_DISPUTE = 'disputes|buyer';
const COMPANY_DISPUTE = 'disputes|company';
const OTHER_DISPUTE = 'disputes|other';
const CLOSED_DISPUTE = 'disputes|closed';
const MISSING_DISPUTE = 'disputes|missing';

function user(id: string, clerkId: string, role: string, extra: Record<string, unknown> = {}): Row {
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

function dispute(id: string, buyerId: string, sellerId: string, status: string): Row {
  return {
    _id: id,
    orderId: `orders|${id}`,
    escrowId: `escrow|${id}`,
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

function message(id: string, disputeId: string, senderId: string, content: string, createdAt: number): Row {
  return { _id: id, disputeId, senderId, content, isSystemMessage: false, createdAt };
}

const INDEXES = {
  messages: { by_dispute: ['disputeId'], by_dispute_created: ['disputeId', 'createdAt'] },
};

function fixtureTables(): Tables {
  return {
    users: [
      user('users|buyer', 'clerk_buyer', 'user', { firstName: 'Bea', lastName: 'Buyer' }),
      user('users|other_buyer', 'clerk_other_buyer', 'user'),
      user('users|seller', 'clerk_seller', 'user', { firstName: 'Sam', lastName: 'Seller' }),
      user('users|other_seller', 'clerk_other_seller', 'user'),
      user('users|company', 'clerk_company', 'user', { firstName: 'Gettitonline', lastName: 'Store' }),
      user('users|outsider', 'clerk_outsider', 'user'),
      user('users|catalog', 'clerk_catalog', 'catalog_manager', { firstName: 'Cora', lastName: 'Catalog' }),
      user('users|moderator', 'clerk_moderator', 'moderator', { firstName: 'Mo', lastName: 'Derator' }),
      user('users|admin', 'clerk_admin', 'admin'),
      user('users|banned_buyer', 'clerk_banned_buyer', 'user', { isBanned: true }),
      user('users|deleted_buyer', 'clerk_deleted_buyer', 'user', { deletedAt: 1 }),
    ],
    platformSettings: [
      {
        _id: 'platformSettings|singleton',
        key: 'singleton',
        companySellerUserId: 'users|company',
        companyDisplayName: 'Gettitonline',
      },
    ],
    disputes: [
      dispute(BUYER_DISPUTE, 'users|buyer', 'users|seller', 'open'),
      dispute(COMPANY_DISPUTE, 'users|buyer', 'users|company', 'in_discussion'),
      dispute(OTHER_DISPUTE, 'users|other_buyer', 'users|other_seller', 'open'),
      dispute(CLOSED_DISPUTE, 'users|buyer', 'users|seller', 'closed'),
    ],
    // Inserted out of creation order on purpose, so ordering must come from the index, not from insertion.
    messages: [
      message('messages|third', BUYER_DISPUTE, 'users|buyer', 'third', 3),
      message('messages|first', BUYER_DISPUTE, 'users|buyer', 'first', 1),
      message('messages|second', BUYER_DISPUTE, 'users|seller', 'second', 2),
      { ...message('messages|company', COMPANY_DISPUTE, 'users|catalog', 'company reply', 4), speakerSide: 'seller' },
      message('messages|other', OTHER_DISPUTE, 'users|other_buyer', 'other vendor', 1),
      message('messages|staff', CLOSED_DISPUTE, 'users|moderator', 'staff note', 5),
    ],
  };
}

function setup(clerkId: string | null) {
  const db: Db = createDb(fixtureTables(), INDEXES);
  return { db, ctx: createCtx(db, clerkId) };
}

type Read = { name: string; call: (ctx: unknown, disputeId: string) => Promise<unknown> };

const READS: readonly Read[] = [
  { name: 'getMessages', call: (ctx, disputeId) => getMessages(ctx, { disputeId }) },
  { name: 'getMessagesPaginated', call: (ctx, disputeId) => getMessagesPaginated(ctx, { disputeId }) },
  { name: 'getMessageCount', call: (ctx, disputeId) => getMessageCount(ctx, { disputeId }) },
  { name: 'getLastMessage', call: (ctx, disputeId) => getLastMessage(ctx, { disputeId }) },
  { name: 'getMessagesForAnalysis', call: (ctx, disputeId) => getMessagesForAnalysis(ctx, { disputeId }) },
];

async function rejectsWithoutWrites(db: Db, attempt: () => Promise<unknown>, pattern: RegExp) {
  const before = structuredClone(db.tables);
  await assert.rejects(attempt, pattern);
  assert.deepEqual(db.tables, before, 'a rejected call must not change any table');
}

for (const read of READS) {
  test(`${read.name}: anonymous callers are refused before any conversation is read`, async () => {
    const { ctx } = setup(null);
    await assert.rejects(() => read.call(ctx, BUYER_DISPUTE), /Unauthenticated/);
  });

  test(`${read.name}: unknown, banned, and deleted accounts are refused`, async () => {
    await assert.rejects(() => read.call(setup('clerk_nobody').ctx, BUYER_DISPUTE), /Account not found/);
    await assert.rejects(() => read.call(setup('clerk_banned_buyer').ctx, BUYER_DISPUTE), /Account is banned/);
    await assert.rejects(() => read.call(setup('clerk_deleted_buyer').ctx, BUYER_DISPUTE), /Account is deleted/);
  });

  test(`${read.name}: unrelated signed-in users are refused, including a spoofed buyer ID`, async () => {
    await assert.rejects(() => read.call(setup('clerk_outsider').ctx, BUYER_DISPUTE), /Unauthorized/);
    await assert.rejects(() => read.call(setup('clerk_other_buyer').ctx, BUYER_DISPUTE), /Unauthorized/);
    await assert.rejects(() => read.call(setup('clerk_other_seller').ctx, BUYER_DISPUTE), /Unauthorized/);
  });

  test(`${read.name}: a catalog manager cannot read another vendor's conversation`, async () => {
    await assert.rejects(() => read.call(setup('clerk_catalog').ctx, OTHER_DISPUTE), /Unauthorized/);
  });
}

test('the buyer, the seller side, and reviewers can read a buyer conversation', async () => {
  for (const clerkId of ['clerk_buyer', 'clerk_seller', 'clerk_moderator', 'clerk_admin']) {
    const { ctx } = setup(clerkId);
    const rows = await getMessages(ctx, { disputeId: BUYER_DISPUTE });
    assert.deepEqual(
      rows.map((row) => row.content),
      ['first', 'second', 'third'],
      `${clerkId} must read the conversation`,
    );
  }
});

test('the company seller account and configured catalog managers read company conversations', async () => {
  for (const clerkId of ['clerk_company', 'clerk_catalog', 'clerk_buyer']) {
    const { ctx } = setup(clerkId);
    const rows = await getMessages(ctx, { disputeId: COMPANY_DISPUTE });
    assert.deepEqual(
      rows.map((row) => row.content),
      ['company reply'],
      `${clerkId} must read the company conversation`,
    );
  }
  await assert.rejects(
    () => getMessages(setup('clerk_other_seller').ctx, { disputeId: COMPANY_DISPUTE }),
    /Unauthorized/,
  );
});

test('a reviewer reads company conversations as staff, not as the seller side', async () => {
  const { ctx } = setup('clerk_admin');
  const rows = await getMessages(ctx, { disputeId: COMPANY_DISPUTE });
  assert.equal(rows.length, 1);
});

test('the count and the last message follow the conversation order', async () => {
  const { ctx } = setup('clerk_buyer');

  assert.equal(await getMessageCount(ctx, { disputeId: BUYER_DISPUTE }), 3);

  const last = await getLastMessage(ctx, { disputeId: BUYER_DISPUTE });
  assert.equal(last?.content, 'third');
  assert.deepEqual(last?.sender, { _id: 'users|buyer', firstName: 'Bea', lastName: 'Buyer' });
});

test('pagination returns the newest page in chronological order with hasMore and nextCursor', async () => {
  const { ctx } = setup('clerk_buyer');

  const firstPage = await getMessagesPaginated(ctx, { disputeId: BUYER_DISPUTE, limit: 2 });
  assert.deepEqual(
    firstPage.messages.map((row) => row.content),
    ['second', 'third'],
  );
  assert.equal(firstPage.hasMore, true);
  assert.equal(firstPage.nextCursor, 'messages|second');

  const everything = await getMessagesPaginated(ctx, { disputeId: BUYER_DISPUTE, limit: 5 });
  assert.deepEqual(
    everything.messages.map((row) => row.content),
    ['first', 'second', 'third'],
  );
  assert.equal(everything.hasMore, false);
  assert.equal(everything.nextCursor, null);
});

// A missing dispute holds no private data, so any signed-in caller gets the empty result, as dispute reads return null.
test('a missing dispute reads as an empty conversation for any signed-in caller', async () => {
  for (const clerkId of ['clerk_admin', 'clerk_outsider']) {
    const { ctx } = setup(clerkId);
    assert.deepEqual(await getMessages(ctx, { disputeId: MISSING_DISPUTE }), []);
    assert.equal(await getMessageCount(ctx, { disputeId: MISSING_DISPUTE }), 0);
    assert.equal(await getLastMessage(ctx, { disputeId: MISSING_DISPUTE }), null);
    assert.equal(await getMessagesForAnalysis(ctx, { disputeId: MISSING_DISPUTE }), null);
  }
});

test('analysis labels each message by the side recorded for it, and a company delegate counts as the seller', async () => {
  const buyerView = await getMessagesForAnalysis(setup('clerk_buyer').ctx, { disputeId: COMPANY_DISPUTE });
  assert.ok(buyerView);
  assert.deepEqual(
    (buyerView.messages as Row[]).map((row) => row.senderRole),
    ['seller'],
    'a catalog manager speaks for the company seller',
  );

  const staffView = await getMessagesForAnalysis(setup('clerk_admin').ctx, { disputeId: CLOSED_DISPUTE });
  assert.ok(staffView);
  assert.deepEqual(
    (staffView.messages as Row[]).map((row) => row.senderRole),
    ['moderator'],
  );
});

test('analysis returns the dispute summary, participants, and message timestamps', async () => {
  const view = await getMessagesForAnalysis(setup('clerk_buyer').ctx, { disputeId: BUYER_DISPUTE });
  assert.ok(view);
  assert.deepEqual(view.dispute, {
    title: 'Dispute disputes|buyer',
    description: 'The item did not arrive',
    category: 'not_received',
    status: 'open',
  });
  assert.deepEqual(view.participants, {
    buyer: { _id: 'users|buyer', name: 'Bea Buyer' },
    seller: { _id: 'users|seller', name: 'Sam Seller' },
  });
  assert.deepEqual(
    (view.messages as Row[]).map((row) => [row.senderRole, row.timestamp]),
    [
      ['buyer', 1],
      ['seller', 2],
      ['buyer', 3],
    ],
  );
  assert.equal(view.evidenceCount, 0);
});

test('analysis refuses unauthenticated callers, which leaves no compatibility exception', async () => {
  await assert.rejects(() => getMessagesForAnalysis(setup(null).ctx, { disputeId: BUYER_DISPUTE }), /Unauthenticated/);
});

// sendMessage: the verified actor sends, and the dispute policy decides who may write.

test('the buyer sends, the dispute moves to in_discussion, and the seller is notified', async () => {
  const { db, ctx } = setup('clerk_buyer');
  const id = await sendMessage(ctx, { disputeId: BUYER_DISPUTE, content: 'Hello' });

  const sent = db.tables.messages?.find((row) => row._id === id);
  assert.equal(sent?.senderId, 'users|buyer');
  assert.equal(sent?.content, 'Hello');
  assert.equal(db.tables.disputes?.find((row) => row._id === BUYER_DISPUTE)?.status, 'in_discussion');
  const notice = db.tables.notifications?.find((row) => row.userId === 'users|seller');
  assert.equal(notice?.type, 'new_message');
});

test('the seller sends and the buyer is notified', async () => {
  const { db, ctx } = setup('clerk_seller');
  await sendMessage(ctx, { disputeId: BUYER_DISPUTE, content: 'Reply' });
  assert.ok(db.tables.notifications?.some((row) => row.userId === 'users|buyer'));
});

test('a configured catalog manager replies to a company dispute as the verified actor, and the buyer is notified', async () => {
  const { db, ctx } = setup('clerk_catalog');
  const id = await sendMessage(ctx, { disputeId: COMPANY_DISPUTE, content: 'We are checking this' });

  const sent = db.tables.messages?.find((row) => row._id === id);
  assert.equal(sent?.senderId, 'users|catalog', 'attribution is the catalog manager, not the company account');
  const notice = db.tables.notifications?.find((row) => row.userId === 'users|buyer');
  assert.equal(notice?.type, 'new_message');
  assert.match(String(notice?.message), /Cora Catalog/);
});

test('the company seller account itself may reply to its own company dispute', async () => {
  const { db, ctx } = setup('clerk_company');
  const id = await sendMessage(ctx, { disputeId: COMPANY_DISPUTE, content: 'Store reply' });
  assert.equal(db.tables.messages?.find((row) => row._id === id)?.senderId, 'users|company');
});

test('a catalog manager cannot reply to another vendor, and nothing changes', async () => {
  const { ctx, db } = setup('clerk_catalog');
  await rejectsWithoutWrites(
    db,
    () => sendMessage(ctx, { disputeId: OTHER_DISPUTE, content: 'Not mine' }),
    /Unauthorized/,
  );
});

test('an unrelated user cannot reply, and nothing changes', async () => {
  const { ctx, db } = setup('clerk_outsider');
  await rejectsWithoutWrites(db, () => sendMessage(ctx, { disputeId: BUYER_DISPUTE, content: 'Hi' }), /Unauthorized/);
});

test('a spoofed sender ID is ignored: the message is attributed to the verified actor', async () => {
  const { db, ctx } = setup('clerk_outsider');
  await rejectsWithoutWrites(
    db,
    () => sendMessage(ctx, { disputeId: BUYER_DISPUTE, content: 'Hi', senderId: 'users|buyer' }),
    /Unauthorized/,
  );

  const buyer = setup('clerk_buyer');
  const id = await sendMessage(buyer.ctx, { disputeId: BUYER_DISPUTE, content: 'Mine', senderId: 'users|seller' });
  assert.equal(buyer.db.tables.messages?.find((row) => row._id === id)?.senderId, 'users|buyer');
});

test('banned and deleted accounts cannot reply, and nothing changes', async () => {
  for (const [clerkId, pattern] of [
    ['clerk_banned_buyer', /Account is banned/],
    ['clerk_deleted_buyer', /Account is deleted/],
  ] as const) {
    const { ctx, db } = setup(clerkId);
    await rejectsWithoutWrites(db, () => sendMessage(ctx, { disputeId: BUYER_DISPUTE, content: 'Hi' }), pattern);
  }
});

test('a moderator may reply without notifying the parties, as before', async () => {
  const { db, ctx } = setup('clerk_moderator');
  const id = await sendMessage(ctx, { disputeId: BUYER_DISPUTE, content: 'Reviewing now' });
  assert.equal(db.tables.messages?.find((row) => row._id === id)?.senderId, 'users|moderator');
  assert.equal(db.tables.notifications?.length ?? 0, 0);
});

test('resolved or closed disputes refuse replies from every sender, and nothing changes', async () => {
  const { ctx, db } = setup('clerk_buyer');
  await rejectsWithoutWrites(
    db,
    () => sendMessage(ctx, { disputeId: CLOSED_DISPUTE, content: 'Too late' }),
    /Cannot send messages to resolved or closed disputes/,
  );
});

test('a missing dispute refuses the reply, and nothing changes', async () => {
  const { ctx, db } = setup('clerk_buyer');
  await rejectsWithoutWrites(
    db,
    () => sendMessage(ctx, { disputeId: MISSING_DISPUTE, content: 'Hi' }),
    /Dispute not found/,
  );
});

// updateMessageWithRephrase writes a private message, so only its author may change it, and only while they can read
// its dispute. A caller-supplied sender ID cannot choose the author.

function rephrase(messageId: string): Args {
  return { messageId, aiRephraseAccepted: true, originalContent: 'first draft' };
}

test('updateMessageWithRephrase: anonymous and unknown callers are refused, and nothing changes', async () => {
  const anonymous = setup(null);
  await rejectsWithoutWrites(
    anonymous.db,
    () => updateMessageWithRephrase(anonymous.ctx, rephrase('messages|first')),
    /Unauthenticated/,
  );

  const unknown = setup('clerk_nobody');
  await rejectsWithoutWrites(
    unknown.db,
    () => updateMessageWithRephrase(unknown.ctx, rephrase('messages|first')),
    /Account not found/,
  );
});

test('updateMessageWithRephrase: a participant or reviewer who did not write the message cannot change it', async () => {
  for (const clerkId of ['clerk_seller', 'clerk_outsider', 'clerk_moderator']) {
    const { ctx, db } = setup(clerkId);
    await rejectsWithoutWrites(db, () => updateMessageWithRephrase(ctx, rephrase('messages|first')), /Unauthorized/);
  }
});

test('updateMessageWithRephrase: a spoofed sender ID cannot make another user the author', async () => {
  const { ctx, db } = setup('clerk_seller');
  await rejectsWithoutWrites(
    db,
    () => updateMessageWithRephrase(ctx, { ...rephrase('messages|first'), senderId: 'users|buyer' }),
    /Unauthorized/,
  );
});

test('updateMessageWithRephrase: the author changes their own message, including a catalog delegate on a company dispute', async () => {
  const buyer = setup('clerk_buyer');
  const updated = await updateMessageWithRephrase(buyer.ctx, rephrase('messages|first'));
  assert.equal(updated?.aiRephraseAccepted, true);
  assert.equal(updated?.originalContent, 'first draft');

  const catalog = setup('clerk_catalog');
  const delegated = await updateMessageWithRephrase(catalog.ctx, rephrase('messages|company'));
  assert.equal(delegated?.aiRephraseAccepted, true);
});

// Speaker attribution is recorded when a message is written, from the verified actor and the dispute. A later role
// change never rewrites it. A message stored before the field existed is labelled from its sender account alone.

function labelsOf(view: Row | null): unknown[] {
  return ((view?.messages ?? []) as Row[]).map((row) => row.senderRole);
}

test('a reviewer note keeps the reviewer label after that account becomes catalog staff', async () => {
  const { db, ctx } = setup('clerk_moderator');
  const id = await sendMessage(ctx, { disputeId: OTHER_DISPUTE, content: 'Checking the listing' });
  assert.equal(db.tables.messages?.find((row) => row._id === id)?.speakerSide, 'moderator');

  await db.patch('users|moderator', { role: 'catalog_manager' });
  const view = await getMessagesForAnalysis(createCtx(db, 'clerk_other_seller'), { disputeId: OTHER_DISPUTE });
  assert.deepEqual(labelsOf(view), ['buyer', 'moderator']);
});

test('a company reply keeps the seller label after the delegate loses catalog staff status', async () => {
  const { db, ctx } = setup('clerk_catalog');
  await sendMessage(ctx, { disputeId: COMPANY_DISPUTE, content: 'We are checking this' });
  await db.patch('users|catalog', { role: 'user' });
  const view = await getMessagesForAnalysis(createCtx(db, 'clerk_buyer'), { disputeId: COMPANY_DISPUTE });
  assert.deepEqual(labelsOf(view), ['seller', 'seller']);
});

test('the speaker side comes from the verified actor, and a caller-supplied side is ignored', async () => {
  const { db, ctx } = setup('clerk_catalog');
  const id = await sendMessage(ctx, { disputeId: COMPANY_DISPUTE, content: 'Store reply', speakerSide: 'buyer' });
  assert.equal(db.tables.messages?.find((row) => row._id === id)?.speakerSide, 'seller');
});

test('a message stored before speakerSide is labelled from its sender account, never from a current role', async () => {
  const { db } = setup(null);
  await db.insert('messages', {
    disputeId: COMPANY_DISPUTE,
    senderId: 'users|catalog',
    content: 'Stored before speaker sides',
    isSystemMessage: false,
    createdAt: 9,
  });
  const view = await getMessagesForAnalysis(createCtx(db, 'clerk_buyer'), { disputeId: COMPANY_DISPUTE });
  assert.deepEqual(labelsOf(view), ['seller', 'moderator']);
});

test('a former reviewer promoted to catalog staff still cannot read or reply in an unrelated vendor dispute', async () => {
  const { db, ctx } = setup('clerk_moderator');
  await db.patch('users|moderator', { role: 'catalog_manager' });
  await assert.rejects(() => getMessages(ctx, { disputeId: OTHER_DISPUTE }), /Unauthorized/);
  await rejectsWithoutWrites(
    db,
    () => sendMessage(ctx, { disputeId: OTHER_DISPUTE, content: 'Not mine' }),
    /Unauthorized/,
  );
});

test('system messages record the side of the verified actor who changed the dispute', async () => {
  const delegate = setup('clerk_catalog');
  await updateDisputeStatus(delegate.ctx, { disputeId: COMPANY_DISPUTE, status: 'moderator_review' });
  const notice = delegate.db.tables.messages?.find(
    (row) => row.disputeId === COMPANY_DISPUTE && row.isSystemMessage === true,
  );
  assert.equal(notice?.speakerSide, 'seller');

  const staff = setup('clerk_moderator');
  await assignModerator(staff.ctx, { disputeId: BUYER_DISPUTE, moderatorId: 'users|moderator' });
  const assigned = staff.db.tables.messages?.find(
    (row) => row.disputeId === BUYER_DISPUTE && row.isSystemMessage === true,
  );
  assert.equal(assigned?.speakerSide, 'moderator');
});
