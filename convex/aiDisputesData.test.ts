import assert from 'node:assert/strict';
import test from 'node:test';

import * as aiDisputesData from './aiDisputesData';
import { createCtx, createDb, type Db, type Row, type Tables } from '../tests/support/convexFakeDb';
import { invokeFakeFunction } from '../tests/support/convexFakeActionCtx';

// Internal reads and the persistence write for Pinkie's dispute actions. Each runs the real handler over the fake db.
// A participant or permitted reviewer gets its data; any other caller gets the same result as a missing dispute, and
// nothing is written for them.

const INDEXES = {
  users: { by_clerk_id: ['clerkId'] },
  platformSettings: { by_key: ['key'] },
  messages: { by_dispute_created: ['disputeId', 'createdAt'] },
};

const SENTINELS = [
  'SENTINEL_PRIVATE_EMAIL',
  'SENTINEL_PRIVATE_PHONE',
  'SENTINEL_OTHER_DISPUTE',
  'SENTINEL_OTHER_MESSAGE',
];

function user(id: string, clerkId: string, fields: Record<string, unknown> = {}): Row {
  return { _id: id, clerkId, role: 'user', isBanned: false, firstName: 'Test', lastName: 'User', ...fields };
}

function dispute(id: string, fields: Record<string, unknown>): Row {
  return {
    _id: id,
    orderId: 'orders|1',
    escrowId: 'escrow|1',
    buyerId: 'users|1',
    sellerId: 'users|2',
    title: 'Phone not received',
    description: 'Paid for a phone that never arrived',
    category: 'not_received',
    evidence: [{ type: 'image', url: 'https://cdn.example.com/a.jpg', uploadedAt: 1 }],
    status: 'in_discussion',
    createdAt: 1,
    updatedAt: 1,
    ...fields,
  };
}

function message(id: string, fields: Record<string, unknown>): Row {
  return { _id: id, isSystemMessage: false, ...fields };
}

// users|1 buyer and users|2 seller on disputes|1. users|3 and users|4 are the parties to disputes|2.
// users|6 is a catalog manager who is not the company's delegate. users|7 is a catalog manager acting for the company
// seller users|8 on disputes|3. users|9 is a moderator. users|10 is banned and users|11 is deleted.
function seed(): Tables {
  return {
    users: [
      user('users|1', 'clerk_buyer'),
      user('users|2', 'clerk_seller'),
      user('users|3', 'clerk_other_buyer', { phone: 'SENTINEL_PRIVATE_PHONE' }),
      user('users|4', 'clerk_other_seller'),
      user('users|5', 'clerk_unrelated', { email: 'SENTINEL_PRIVATE_EMAIL@example.com' }),
      user('users|6', 'clerk_catalog', { role: 'catalog_manager' }),
      user('users|7', 'clerk_delegate', { role: 'catalog_manager' }),
      user('users|8', 'clerk_company', { role: 'admin' }),
      user('users|9', 'clerk_moderator', { role: 'moderator' }),
    ],
    platformSettings: [{ _id: 'platformSettings|1', key: 'singleton', companySellerUserId: 'users|8' }],
    disputes: [
      dispute('disputes|1', {}),
      dispute('disputes|2', {
        buyerId: 'users|3',
        sellerId: 'users|4',
        orderId: 'orders|3',
        title: 'SENTINEL_OTHER_DISPUTE title',
        description: 'SENTINEL_OTHER_DISPUTE description',
      }),
      dispute('disputes|3', { sellerId: 'users|8', orderId: 'orders|2' }),
    ],
    orders: [
      {
        _id: 'orders|1',
        buyerId: 'users|1',
        sellerId: 'users|2',
        totalAmount: 1500,
        createdAt: 100,
        items: [{ productId: 'products|1', title: 'Samsung Galaxy phone', price: 1500, quantity: 1 }],
        shippingAddress: { street: 'SENTINEL_PRIVATE_STREET 12' },
      },
      {
        _id: 'orders|2',
        buyerId: 'users|1',
        sellerId: 'users|8',
        totalAmount: 900,
        createdAt: 200,
        items: [{ productId: 'products|2', title: 'Company lamp', price: 900, quantity: 1 }],
      },
      {
        _id: 'orders|3',
        buyerId: 'users|3',
        sellerId: 'users|4',
        totalAmount: 50,
        createdAt: 300,
        items: [{ productId: 'products|3', title: 'SENTINEL_OTHER_DISPUTE product', price: 50, quantity: 1 }],
      },
    ],
    messages: [
      message('messages|1', {
        disputeId: 'disputes|1',
        senderId: 'users|1',
        content: 'The phone never arrived',
        speakerSide: 'buyer',
        createdAt: 10,
      }),
      message('messages|2', {
        disputeId: 'disputes|1',
        senderId: 'users|2',
        content: 'It was shipped on time',
        speakerSide: 'seller',
        createdAt: 20,
      }),
      message('messages|3', {
        disputeId: 'disputes|1',
        senderId: 'users|9',
        content: 'Please share the tracking record',
        speakerSide: 'moderator',
        createdAt: 30,
      }),
      message('messages|4', {
        disputeId: 'disputes|1',
        senderId: 'users|2',
        content: 'Legacy seller reply without a stored side',
        createdAt: 40,
      }),
      message('messages|5', {
        disputeId: 'disputes|2',
        senderId: 'users|3',
        content: 'SENTINEL_OTHER_MESSAGE from the other buyer',
        speakerSide: 'buyer',
        createdAt: 50,
      }),
    ],
  };
}

// The seeded table, failing loudly when a test names one the seed does not have.
function rowsOf(tables: Tables, name: string): Row[] {
  const rows = tables[name];
  if (!rows) {
    throw new Error(`seed has no ${name} table`);
  }
  return rows;
}

function open(tables: Tables = seed()): Db {
  return createDb(tables, INDEXES);
}

// An open record: the fields differ by outcome, and each test asserts the fields it expects.
type Read = { ok: boolean; [key: string]: unknown };

// Runs a registered internal function the way the runtime does: its argument validator first, then its handler. A refused
// argument throws "Argument validation failed" and never reaches the handler.
async function runInternal<T>(fn: unknown, db: Db, args: Record<string, unknown>): Promise<T> {
  return (await invokeFakeFunction(fn, createCtx(db, null), args)) as T;
}

function readAs(fn: unknown, db: Db, userId: string, disputeId: string): Promise<Read> {
  return runInternal<Read>(fn, db, { userId, disputeId });
}

// ---------------------------------------------------------------------------------------------------------------------
// Rephrase and conversation reads: participants and company delegates only.
// ---------------------------------------------------------------------------------------------------------------------

test('disputeForRephrase returns the viewer side and dispute text for the buyer', async () => {
  const result = await readAs(aiDisputesData.disputeForRephrase, open(), 'users|1', 'disputes|1');
  assert.deepEqual(result, {
    ok: true,
    side: 'buyer',
    title: 'Phone not received',
    description: 'Paid for a phone that never arrived',
  });
});

test('a non-participant gets the same not_found as a missing dispute from every internal read', async () => {
  const fns = [
    aiDisputesData.disputeForRephrase,
    aiDisputesData.disputeConversation,
    aiDisputesData.disputeForResolution,
  ];
  for (const fn of fns) {
    const missing = await readAs(fn, open(), 'users|1', 'disputes|404');
    for (const userId of ['users|3', 'users|4', 'users|5', 'users|6', 'users|10', 'users|11']) {
      const denied = await readAs(fn, open(), userId, 'disputes|1');
      assert.deepEqual(denied, missing, `${userId} must get the missing-dispute result`);
    }
  }
  assert.deepEqual(await readAs(aiDisputesData.disputeForRephrase, open(), 'users|1', 'disputes|404'), {
    ok: false,
    code: 'not_found',
  });
});

test('a banned or deleted account can read nothing, even as a party to the dispute', async () => {
  const tables = seed();
  rowsOf(tables, 'users').push(user('users|12', 'clerk_banned_party', { isBanned: true }));
  rowsOf(tables, 'disputes').push(dispute('disputes|4', { buyerId: 'users|12' }));
  const denied = await readAs(aiDisputesData.disputeConversation, open(tables), 'users|12', 'disputes|4');
  assert.deepEqual(denied, { ok: false, code: 'not_found' });
});

test('the company delegate reads a dispute against the company seller, as the seller side', async () => {
  const result = await readAs(aiDisputesData.disputeConversation, open(), 'users|7', 'disputes|3');
  assert.equal(result.ok, true);
  assert.equal(result.side, 'seller');
  assert.equal(result.orderAmount, 900);
});

test('a catalog manager acts for the company seller only on company disputes, as dispute reads always have', async () => {
  const onCompany = await readAs(aiDisputesData.disputeConversation, open(), 'users|6', 'disputes|3');
  assert.equal(onCompany.ok, true, 'catalog managers act for the company seller');
  const onOther = await readAs(aiDisputesData.disputeConversation, open(), 'users|6', 'disputes|1');
  assert.deepEqual(onOther, { ok: false, code: 'not_found' });
});

test('the conversation read labels every speaker from the stored side, and the reviewer is a moderator', async () => {
  const result = await readAs(aiDisputesData.disputeConversation, open(), 'users|1', 'disputes|1');
  assert.equal(result.ok, true);
  const messages = result.messages as Array<{ side: string; content: string }>;
  assert.deepEqual(
    messages.map((entry) => entry.side),
    ['buyer', 'seller', 'moderator', 'seller'],
  );
});

test('a reviewer who is not a party reads the conversation as moderator', async () => {
  const result = await readAs(aiDisputesData.disputeConversation, open(), 'users|9', 'disputes|1');
  assert.equal(result.ok, true);
  assert.equal(result.side, 'moderator');
});

test('the conversation read returns only the authorized dispute messages, never another dispute or account data', async () => {
  const result = await readAs(aiDisputesData.disputeConversation, open(), 'users|1', 'disputes|1');
  const serialized = JSON.stringify(result);
  for (const sentinel of SENTINELS) {
    assert.equal(serialized.includes(sentinel), false, `${sentinel} must not be returned`);
  }
  assert.equal(serialized.includes('SENTINEL_PRIVATE_STREET'), false);
  assert.equal(serialized.includes('@example.com'), false);
});

test('the conversation read caps the message count to the most recent 30 and each message to 1000 characters', async () => {
  const tables = seed();
  for (let index = 0; index < 40; index++) {
    rowsOf(tables, 'messages').push(
      message(`messages|${100 + index}`, {
        disputeId: 'disputes|1',
        senderId: 'users|1',
        content: `MSG-${index} ${'x'.repeat(3000)}`,
        speakerSide: 'buyer',
        createdAt: 1000 + index,
      }),
    );
  }
  const result = await readAs(aiDisputesData.disputeConversation, open(tables), 'users|1', 'disputes|1');
  const messages = result.messages as Array<{ content: string }>;
  assert.equal(messages.length, 30);
  assert.equal(messages[0]?.content.startsWith('MSG-10 '), true, 'the oldest messages are dropped, not the newest');
  assert.equal(messages[29]?.content.startsWith('MSG-39 '), true);
  for (const entry of messages) {
    assert.ok(entry.content.length <= 1000, 'each message is capped');
  }
});

test('the conversation read caps the title and description it returns', async () => {
  const tables = seed();
  rowsOf(tables, 'disputes')[0] = dispute('disputes|1', { title: 'T'.repeat(500), description: 'D'.repeat(3000) });
  const result = await readAs(aiDisputesData.disputeConversation, open(tables), 'users|1', 'disputes|1');
  assert.ok(String(result.title).length <= 200);
  assert.ok(String(result.description).length <= 1000);
});

test('the conversation read returns the order amount and product title, not the order address', async () => {
  const result = await readAs(aiDisputesData.disputeConversation, open(), 'users|1', 'disputes|1');
  assert.equal(result.orderAmount, 1500);
  assert.equal(result.productTitle, 'Samsung Galaxy phone');
  assert.equal(result.orderCreatedAt, 100);
  assert.equal('shippingAddress' in result, false);
});

// ---------------------------------------------------------------------------------------------------------------------
// Resolution drafts: reviewers only. A participant who may read the dispute gets forbidden, not the draft context.
// ---------------------------------------------------------------------------------------------------------------------

test('disputeForResolution returns draft context for a reviewer', async () => {
  const result = await readAs(aiDisputesData.disputeForResolution, open(), 'users|9', 'disputes|1');
  assert.deepEqual(result, {
    ok: true,
    title: 'Phone not received',
    category: 'not_received',
    productTitle: 'Samsung Galaxy phone',
    orderAmount: 1500,
  });
});

test('disputeForResolution refuses a buyer, seller, and company delegate as forbidden', async () => {
  for (const [userId, disputeId] of [
    ['users|1', 'disputes|1'],
    ['users|2', 'disputes|1'],
    ['users|7', 'disputes|3'],
  ] as const) {
    const result = await readAs(aiDisputesData.disputeForResolution, open(), userId, disputeId);
    assert.deepEqual(result, { ok: false, code: 'forbidden' }, `${userId} must be forbidden`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Persistence: an internal write that rechecks the caller and changes nothing for anyone else.
// ---------------------------------------------------------------------------------------------------------------------

test('persistAnalysis writes the validated objective summary and suggestions for a reviewer', async () => {
  const db = open();
  const written = await runInternal<boolean>(aiDisputesData.persistAnalysis, db, {
    userId: 'users|9',
    disputeId: 'disputes|1',
    aiSummary: 'The buyer reports a missing phone and the seller reports on-time shipment.',
    aiSuggestions: ['Refund in full'],
  });
  assert.equal(written, true);
  const row = db.tables.disputes?.find((candidate) => candidate._id === 'disputes|1');
  assert.equal(row?.aiSummary, 'The buyer reports a missing phone and the seller reports on-time shipment.');
  assert.deepEqual(row?.aiSuggestions, ['Refund in full']);
});

test('persistAnalysis refuses a participant, so personalized analysis can never become shared material', async () => {
  const db = open();
  const before = structuredClone(db.tables);
  for (const userId of ['users|1', 'users|2']) {
    const written = await runInternal<boolean>(aiDisputesData.persistAnalysis, db, {
      userId,
      disputeId: 'disputes|1',
      aiSummary: 'Objective text',
      aiSuggestions: [],
    });
    assert.equal(written, false, `${userId} is a participant and must not persist`);
  }
  assert.deepEqual(db.tables, before);
});

test('persistAnalysis refuses second-person text even from a reviewer', async () => {
  const db = open();
  const before = structuredClone(db.tables);
  const written = await runInternal<boolean>(aiDisputesData.persistAnalysis, db, {
    userId: 'users|9',
    disputeId: 'disputes|1',
    aiSummary: 'You should demand your money back from the seller.',
    aiSuggestions: [],
  });
  assert.equal(written, false);
  assert.deepEqual(db.tables, before);
});

// Each reproduction is refused in the summary and in a suggestion, with the same normalisation as the reviewer parser.
for (const reproduction of [
  'y​ou must refund the buyer.',
  'ｙｏｕ must refund the buyer.',
  'u must refund the buyer.',
  'ur refund is due.',
  'thou must refund the buyer.',
  "You're owed a refund.",
  'Yourselves should decide the refund.',
]) {
  test(`persistAnalysis refuses second-person text in the summary or a suggestion: ${reproduction}`, async () => {
    const db = open();
    const before = structuredClone(db.tables);
    const inSummary = await runInternal<boolean>(aiDisputesData.persistAnalysis, db, {
      userId: 'users|9',
      disputeId: 'disputes|1',
      aiSummary: reproduction,
      aiSuggestions: [],
    });
    const inSuggestion = await runInternal<boolean>(aiDisputesData.persistAnalysis, db, {
      userId: 'users|9',
      disputeId: 'disputes|1',
      aiSummary: 'The buyer reports a missing phone.',
      aiSuggestions: [reproduction],
    });
    assert.equal(inSummary, false);
    assert.equal(inSuggestion, false);
    assert.deepEqual(db.tables, before);
  });
}

test('persistAnalysis refuses arguments its validator does not accept, before the handler runs', async () => {
  const db = open();
  const before = structuredClone(db.tables);
  await assert.rejects(
    () =>
      runInternal<boolean>(aiDisputesData.persistAnalysis, db, {
        userId: 'users|9',
        disputeId: 'disputes|1',
        aiSummary: 'Objective text',
        aiSuggestions: [1],
      }),
    /Argument validation failed/,
  );
  assert.deepEqual(db.tables, before);
});

test('persistAnalysis refuses a banned reviewer', async () => {
  const tables = seed();
  rowsOf(tables, 'users').push(user('users|12', 'clerk_banned_mod', { role: 'moderator', isBanned: true }));
  const db = open(tables);
  const before = structuredClone(db.tables);
  const written = await runInternal<boolean>(aiDisputesData.persistAnalysis, db, {
    userId: 'users|12',
    disputeId: 'disputes|1',
    aiSummary: 'Objective text',
    aiSuggestions: [],
  });
  assert.equal(written, false);
  assert.deepEqual(db.tables, before);
});

test('the conversation read says whether the caller is a reviewer, so analysis can take the objective path', async () => {
  const moderator = await readAs(aiDisputesData.disputeConversation, open(), 'users|9', 'disputes|1');
  assert.equal(moderator.reviewer, true);
  const buyer = await readAs(aiDisputesData.disputeConversation, open(), 'users|1', 'disputes|1');
  assert.equal(buyer.reviewer, false);
  const seller = await readAs(aiDisputesData.disputeConversation, open(), 'users|2', 'disputes|1');
  assert.equal(seller.reviewer, false);
});

// ---------------------------------------------------------------------------------------------------------------------
// Denial traces: a missing dispute and an existing dispute the caller cannot read must do the same database work.
// ---------------------------------------------------------------------------------------------------------------------

// Records each database operation as "get:<table>" or "query:<table>", and passes it through to the fake db.
function tracedDb(db: Db, trace: string[]): Db {
  return {
    ...db,
    query: (table: string) => {
      trace.push(`query:${table}`);
      return db.query(table);
    },
    get: async (id: string) => {
      trace.push(`get:${id.split('|')[0] ?? ''}`);
      return await db.get(id);
    },
  };
}

async function traceOf(fn: unknown, userId: string, disputeId: string) {
  const trace: string[] = [];
  const db = tracedDb(open(), trace);
  const result = await runInternal<Read>(fn, db, { userId, disputeId });
  return { result, trace };
}

for (const [label, fn] of [
  ['disputeForRephrase', aiDisputesData.disputeForRephrase],
  ['disputeConversation', aiDisputesData.disputeConversation],
  ['disputeForResolution', aiDisputesData.disputeForResolution],
] as const) {
  for (const userId of ['users|3', 'users|4', 'users|6', 'users|5']) {
    test(`${label} for ${userId}: an unreadable existing dispute does the same database work as a missing one`, async () => {
      const missing = await traceOf(fn, userId, 'disputes|404');
      const denied = await traceOf(fn, userId, 'disputes|1');
      assert.deepEqual(denied.result, missing.result);
      assert.deepEqual(denied.trace, missing.trace, 'the operation sequence must match');
      assert.ok(missing.trace.includes('query:platformSettings'), 'the company context is read before the dispute');
    });
  }
}

test('persistAnalysis refuses a non-participant and leaves the dispute unchanged', async () => {
  const db = open();
  const before = structuredClone(db.tables);
  const written = await runInternal<boolean>(aiDisputesData.persistAnalysis, db, {
    userId: 'users|5',
    disputeId: 'disputes|1',
    aiSummary: 'Overwritten by a stranger',
    aiSuggestions: [],
  });
  assert.equal(written, false);
  assert.deepEqual(db.tables, before);
});
