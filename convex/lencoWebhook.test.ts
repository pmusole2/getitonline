import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, createHmac } from 'node:crypto';
import http from './http';
import { getFunctionName } from 'convex/server';
import * as webhook from './lencoWebhook';
import * as lencoWebhookData from './lencoWebhookData';
import type { ProviderReceiptFacts } from './lib/providerOperationContracts';
import * as checkoutCollection from './checkoutCollection';
import * as checkoutQuote from './checkoutQuote';
import type { CheckoutQuote } from './lib/checkoutQuote';
import * as providerOperations from './providerOperations';
import * as providerSettlement from './providerSettlement';
import { type LencoFetch } from './lib/lencoAdapter';
import { createFakeActionCtx, invokeFakeFunction } from '../tests/support/convexFakeActionCtx';
import { createCtx, createDb, handlerOf, type Db, type Row, type Tables } from '../tests/support/convexFakeDb';

const OWNER = 'users|buyer';
const PHONE = '0971234567';
const ID = '22222222-2222-3333-4444-555555555555';
const DEBIT = '11111111-2222-3333-4444-555555555555';
const ENV = { LENCO_API_KEY: 'synthetic-fixture', LENCO_ACCOUNT_ID: DEBIT };

function fixture(): Db {
  return createDb({
    users: [
      {
        _id: OWNER,
        clerkId: 'buyer',
        role: 'user',
        isBanned: false,
        email: 'fixture@example.invalid',
        firstName: 'Fixture',
        lastName: 'Buyer',
        totalSales: 0,
        totalPurchases: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    wallets: [
      {
        _id: 'wallets|buyer',
        userId: OWNER,
        balance: 100,
        pendingBalance: 3,
        totalEarned: 7,
        totalSpent: 9,
        totalWithdrawn: 0,
        isActive: true,
        isFrozen: false,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    appConfig: [{ _id: 'appConfig|1', key: 'singleton', paymentsEnabled: true }],
    paymentAccounts: [
      {
        _id: 'paymentAccounts|mm',
        userId: OWNER,
        type: 'mobile_money',
        mobileMoneyProvider: 'mtn',
        mobileNumber: PHONE,
        isVerified: true,
        providerResolvedAt: 1,
      },
      {
        _id: 'paymentAccounts|bank',
        userId: OWNER,
        type: 'bank_account',
        bankId: 'bank-1',
        accountNumber: '123',
        isVerified: true,
        providerResolvedAt: 1,
      },
    ],
    paymentOperations: [],
    walletTransactions: [],
    transactions: [],
  });
}

function row(db: Db, table: string, id?: string): Row {
  const value = (db.tables[table] ?? []).find((entry) => id === undefined || entry._id === id);
  assert.ok(value, `${table} row exists`);
  return value;
}

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ status: true, data }), { status: 200 });
}

function transport(status: 'pending' | 'successful' | 'failed', onPost?: (db: Db) => void, db?: Db): LencoFetch {
  return async (_url, init) => {
    if (onPost !== undefined && db !== undefined) {
      onPost(db);
    }
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    const collection = _url.endsWith('/collections/mobile-money');
    return envelope(
      collection
        ? {
            id: ID,
            reference: body['reference'],
            amount: String(body['amount']),
            currency: 'ZMW',
            status,
            type: 'mobile-money',
            bearer: 'merchant',
            fee: '0.70',
            mobileMoneyDetails: { country: 'zm', phone: body['phone'], operator: body['operator'] },
            reasonForFailure: null,
            settlementStatus: null,
          }
        : {
            id: ID,
            reference: body['reference'],
            amount: String(body['amount']),
            currency: 'ZMW',
            status,
            fee: '0.70',
            accountId: DEBIT,
            creditAccount:
              body['bankId'] === undefined
                ? { type: 'mobile-money', country: 'zm', phone: body['phone'], operator: body['operator'] }
                : {
                    type: 'bank-account',
                    accountNumber: body['accountNumber'],
                    bank: { id: body['bankId'], country: 'zm' },
                  },
            reasonForFailure: null,
            settlementStatus: null,
          },
    );
  };
}

async function initiate(
  db: Db,
  kind: 'topup' | 'mm' | 'bank' = 'topup',
  status: 'pending' | 'successful' | 'failed' = 'pending',
  onPost?: (db: Db) => void,
): Promise<Row> {
  const deps = { env: () => ENV, fetchImpl: transport(status, onPost, db) };
  const fn =
    kind === 'topup' ? providerOperations.createTopUpAction(deps) : providerOperations.createWithdrawalAction(deps);
  const args =
    kind === 'topup'
      ? { requestId: 'request', amountCents: 2500, phone: PHONE, operator: 'mtn' }
      : {
          requestId: 'request',
          amountCents: 2500,
          paymentAccountId: `paymentAccounts|${kind === 'mm' ? 'mm' : 'bank'}`,
          expectedDestinationKey: kind === 'mm' ? `mm:zm:mtn:${PHONE}` : 'bank:zm:bank-1:123',
        };
  await invokeFakeFunction(
    fn,
    createFakeActionCtx({ db, subject: 'buyer', modules: { providerOperations, providerSettlement } }),
    args,
  );
  return row(db, 'paymentOperations');
}

function collectionData(operation: Row, status = 'successful'): Record<string, unknown> {
  return {
    id: ID,
    reference: operation['providerReference'],
    amount: '25.00',
    currency: 'ZMW',
    status,
    type: 'mobile-money',
    bearer: 'merchant',
    fee: '0.70',
    mobileMoneyDetails: { country: 'zm', phone: PHONE, operator: 'mtn' },
    reasonForFailure: null,
    settlementStatus: null,
  };
}

function signature(body: string | Uint8Array): string {
  return createHmac('sha512', createHash('sha256').update(ENV.LENCO_API_KEY).digest('hex')).update(body).digest('hex');
}

type DeliveryOptions = {
  signature?: string | null;
  key?: string;
  calls?: string[];
  beforeMutation?: (name: string) => Promise<void>;
  onRead?: () => void;
};

async function deliver(db: Db, body: string | Uint8Array, options: DeliveryOptions = {}): Promise<Response> {
  const route = http.lookup('/lenco-webhook', 'POST');
  if (route === null) {
    return new Response('Not found', { status: 404 });
  }
  assert.equal(route[0], webhook.lencoWebhook);
  const handler = webhook.createLencoWebhookAction({
    env: () => ({ LENCO_API_KEY: options.key ?? ENV.LENCO_API_KEY }),
  });
  const ctx = createFakeActionCtx({
    db,
    subject: null,
    modules: { lencoWebhookData, providerSettlement },
    calls: options.calls,
  });
  const runMutation: typeof ctx.runMutation = async (ref, args) => {
    await options.beforeMutation?.(getFunctionName(ref));
    return await ctx.runMutation(ref, args);
  };
  const headers: Record<string, string> = {};
  const signed = options.signature === undefined ? signature(body) : options.signature;
  if (signed !== null) {
    headers['X-Lenco-Signature'] = signed;
  }
  // Copy bytes into an ArrayBuffer for the Request boundary; do not reencode the payload.
  const payload = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  const bytes = new Uint8Array(payload.length);
  bytes.set(payload);
  const request = new Request('https://fixture.invalid/lenco-webhook', { method: 'POST', body: bytes.buffer, headers });
  const read = request.arrayBuffer.bind(request);
  request.arrayBuffer = async (): Promise<ArrayBuffer> => {
    options.onRead?.();
    return await read();
  };
  return await handlerOf<Request, Response>(handler)({ ...ctx, runMutation }, request);
}

function financialSnapshot(db: Db): unknown {
  return structuredClone(
    Object.fromEntries(
      Object.entries(db.tables).filter(
        ([table]) => table !== 'lencoWebhookInbox' && table !== 'paymentOperations' && table !== 'paymentInboxPolls',
      ),
    ),
  );
}

function packet(operation: Row, status = 'successful'): string {
  return JSON.stringify({ event: `collection.${status}`, data: collectionData(operation, status) });
}

function transferData(operation: Row, status = 'successful'): Record<string, unknown> {
  const receipt = operation['receipt'] as Extract<ProviderReceiptFacts, { kind: 'transfer' }>;
  const destination = receipt.destination;
  return {
    id: ID,
    reference: operation['providerReference'],
    amount: '25.00',
    currency: 'ZMW',
    status,
    accountId: DEBIT,
    fee: '0.70',
    reasonForFailure: null,
    settlementStatus: null,
    creditAccount:
      destination.kind === 'mobile-money'
        ? { type: destination.kind, country: 'zm', phone: destination.phone, operator: destination.operator }
        : {
            type: destination.kind,
            accountNumber: destination.accountNumber,
            bank: { id: destination.bankId, country: 'zm' },
          },
  };
}

function assertMinimalInbox(db: Db): void {
  for (const inbox of db.tables['lencoWebhookInbox'] ?? []) {
    assert.deepEqual(
      Object.keys(inbox)
        .filter((key) => !key.startsWith('_'))
        .sort(),
      [
        'bodyDigest',
        'eventKind',
        'classification',
        'ingestedAt',
        ...('operationId' in inbox ? ['operationId'] : []),
        ...('result' in inbox ? ['result'] : []),
      ].sort(),
    );
    assert.match(String(inbox['bodyDigest']), /^[a-f0-9]{64}$/);
    for (const privateValue of [PHONE, ENV.LENCO_API_KEY, ID, DEBIT, 'fixture@example.invalid', 'Fixture']) {
      assert.ok(!JSON.stringify(inbox).includes(privateValue));
    }
  }
}

test('verified receipt before provider-id attachment binds only matching frozen intent', async () => {
  const db = fixture();
  let signedResponse = 0;
  await invokeFakeFunction(
    providerOperations.createTopUpAction({
      env: () => ENV,
      fetchImpl: async (url, init) => {
        const operation = row(db, 'paymentOperations');
        assert.equal(operation['status'], 'attempted');
        assert.equal(operation['providerId'], undefined);
        signedResponse = (await deliver(db, packet(operation))).status;
        assert.equal(row(db, 'wallets')['balance'], 125);
        return await transport('pending')(url, init);
      },
    }),
    createFakeActionCtx({ db, subject: 'buyer', modules: { providerOperations, providerSettlement } }),
    {
      requestId: 'before-attachment',
      amountCents: 2500,
      phone: PHONE,
      operator: 'mtn',
    },
  );
  assert.equal(signedResponse, 200);
  const operation = row(db, 'paymentOperations');
  assert.equal(operation['status'], 'succeeded');
  assert.equal(operation['providerId'], ID);
  assert.equal(db.tables['walletTransactions']?.length, 1);
  assert.equal(operation['reviewNeeded'], undefined);
  assert.equal((operation['receipt'] as ProviderReceiptFacts).status, 'successful');
  assert.ok(
    (operation['receiptObservations'] as ProviderReceiptFacts[]).some((receipt) => receipt.status === 'pending'),
  );
  assert.equal((await deliver(db, packet(operation))).status, 200);
  assert.equal(row(db, 'wallets')['balance'], 125);
});

for (const status of ['successful', 'failed'] as const) {
  test(`event after ${status} initiation preserves already-applied accounting`, async () => {
    const db = fixture();
    const operation = await initiate(db, 'topup', status);
    const before = financialSnapshot(db);
    const proof = structuredClone(operation['accounting']);
    assert.ok(proof);
    assert.equal((await deliver(db, packet(operation, status))).status, 200);
    assert.deepEqual(financialSnapshot(db), before);
    assert.deepEqual(operation['accounting'], proof);
  });
}

test('failure then distinct success preserves received funds and holds, never credits from terminal disagreement', async () => {
  const db = fixture();
  const operation = await initiate(db);
  assert.equal((await deliver(db, packet(operation, 'failed'))).status, 200);
  const before = financialSnapshot(db);
  const proof = structuredClone(operation['accounting']);
  assert.equal((await deliver(db, packet(operation))).status, 200);
  assert.equal(row(db, 'wallets')['balance'], 100);
  assert.equal(operation['reviewNeeded'], true);
  assert.ok(operation['receivedFunds']);
  assert.deepEqual(operation['accounting'], proof);
  assert.deepEqual(financialSnapshot(db), before);
  assert.equal(db.tables['lencoWebhookInbox']?.length, 2);
});

const FOREIGN_ID = '44444444-2222-3333-4444-555555555555';

for (const [name, patch, classification, invoked] of [
  ['foreign reference', { reference: 'TOP-foreign' }, 'terminal', true],
  ['foreign id', { id: FOREIGN_ID }, 'terminal', true],
  ['wrong amount', { amount: '25.01' }, 'terminal', true],
  ['wrong currency', { currency: 'USD' }, 'lookup_required', false],
  ['fractional cent', { amount: '25.001' }, 'lookup_required', false],
  ['missing amount', { amount: null }, 'lookup_required', false],
  ['foreign phone', { mobileMoneyDetails: { country: 'zm', phone: '0979999999', operator: 'mtn' } }, 'terminal', true],
  [
    'foreign country',
    { mobileMoneyDetails: { country: 'ke', phone: PHONE, operator: 'mtn' } },
    'lookup_required',
    false,
  ],
  ['label status mismatch', { status: 'failed' }, 'review', false],
  ['pending label status mismatch', { status: 'pending' }, 'review', false],
] as const) {
  test(`${name} has no financial effect and preserves strict authority`, async () => {
    const db = fixture();
    const operation = await initiate(db);
    const before = financialSnapshot(db);
    const original = structuredClone(operation);
    const calls: string[] = [];
    const body = JSON.stringify({ event: 'collection.successful', data: { ...collectionData(operation), ...patch } });
    assert.equal((await deliver(db, body, { calls })).status, 200);
    assert.deepEqual(financialSnapshot(db), before);
    assert.equal(row(db, 'lencoWebhookInbox')['classification'], classification);
    assert.equal(calls.includes('mutation:providerSettlement:settleProviderReceipt'), invoked);
    if (invoked) {
      assert.equal(operation['reviewNeeded'], true);
      assert.equal(row(db, 'lencoWebhookInbox')['result'], 'review');
      assert.equal(operation['accounting'], undefined);
    } else {
      assert.deepEqual(operation, original);
    }
    assertMinimalInbox(db);
  });
}

for (const field of ['accountId', 'creditAccount']) {
  test(`transfer foreign ${field} reaches existing evidence review without debit/reversal`, async () => {
    const db = fixture();
    const operation = await initiate(db, 'mm');
    const data = transferData(operation);
    data[field] =
      field === 'accountId'
        ? FOREIGN_ID
        : { type: 'mobile-money', country: 'zm', phone: '0979999999', operator: 'mtn' };
    const before = financialSnapshot(db);
    assert.equal(
      (await deliver(db, JSON.stringify({ event: 'transfer.failed', data: { ...data, status: 'failed' } }))).status,
      200,
    );
    assert.deepEqual(financialSnapshot(db), before);
    assert.equal(operation['reviewNeeded'], true);
    assert.equal(operation['accounting'], undefined);
    assert.equal(row(db, 'lencoWebhookInbox')['result'], 'review');
  });
}

test('foreign receipt kind cannot use reference/id association as financial authority', async () => {
  const db = fixture();
  const operation = await initiate(db);
  const data = {
    id: ID,
    reference: operation['providerReference'],
    amount: '25',
    currency: 'ZMW',
    status: 'failed',
    accountId: DEBIT,
    fee: '0.7',
    creditAccount: { type: 'mobile-money', country: 'zm', phone: PHONE, operator: 'mtn' },
  };
  const before = financialSnapshot(db);
  assert.equal((await deliver(db, JSON.stringify({ event: 'transfer.failed', data }))).status, 200);
  assert.deepEqual(financialSnapshot(db), before);
  assert.equal(operation['reviewNeeded'], true);
  assert.equal(operation['accounting'], undefined);
});

for (const mode of ['duplicate_reference', 'duplicate_id', 'cross_linked'] as const) {
  test(`${mode} union lookup persists ambiguity without selecting a first operation`, async () => {
    const db = fixture();
    const operation = await initiate(db);
    const clone = structuredClone(operation);
    clone._id = 'paymentOperations|other';
    if (mode === 'duplicate_reference') {
      clone['providerId'] = FOREIGN_ID;
    }
    if (mode === 'duplicate_id') {
      clone['providerReference'] = 'TOP-other';
    }
    if (mode === 'cross_linked') {
      clone['providerReference'] = 'TOP-other';
      delete operation['providerId'];
    }
    db.tables['paymentOperations']?.push(clone);
    const before = structuredClone(db.tables);
    const calls: string[] = [];
    assert.equal((await deliver(db, packet(operation), { calls })).status, 200);
    assert.equal(row(db, 'lencoWebhookInbox')['classification'], 'ambiguous');
    assert.equal(row(db, 'lencoWebhookInbox')['operationId'], undefined);
    assert.deepEqual(db.tables['paymentOperations'], before['paymentOperations']);
    assert.deepEqual(
      financialSnapshot(db),
      Object.fromEntries(
        Object.entries(before).filter(([table]) => table !== 'paymentOperations' && table !== 'lencoWebhookInbox'),
      ),
    );
    assert.deepEqual(calls, ['mutation:lencoWebhookData:ingest']);
  });
}

test('unknown legacy reference/id remains unmapped without adopting historical credits or creating intent', async () => {
  const db = fixture();
  const operation = await initiate(db);
  const data = { ...collectionData(operation), id: FOREIGN_ID, reference: 'TOP-legacy' };
  db.tables['walletTransactions'] = [
    {
      _id: 'walletTransactions|legacy',
      externalReference: FOREIGN_ID,
      providerReference: 'TOP-legacy',
      type: 'credit',
      amount: 25,
      source: 'top_up_mobile_money',
      status: 'completed',
    },
  ];
  const before = structuredClone(db.tables);
  assert.equal((await deliver(db, JSON.stringify({ event: 'collection.successful', data }))).status, 200);
  assert.equal(row(db, 'lencoWebhookInbox')['classification'], 'unmapped');
  assert.deepEqual(db.tables['paymentOperations'], before['paymentOperations']);
  assert.deepEqual(
    financialSnapshot(db),
    Object.fromEntries(
      Object.entries(before).filter(([table]) => table !== 'paymentOperations' && table !== 'lencoWebhookInbox'),
    ),
  );
});

test('wallet purchase candidate cannot be externally settled', async () => {
  const db = fixture();
  const operation = await initiate(db);
  operation['kind'] = 'wallet_purchase';
  const before = structuredClone(db.tables);
  const calls: string[] = [];
  assert.equal((await deliver(db, packet(operation), { calls })).status, 200);
  assert.equal(row(db, 'lencoWebhookInbox')['classification'], 'unsupported');
  assert.deepEqual(db.tables['paymentOperations'], before['paymentOperations']);
  assert.deepEqual(
    financialSnapshot(db),
    Object.fromEntries(
      Object.entries(before).filter(([table]) => table !== 'paymentOperations' && table !== 'lencoWebhookInbox'),
    ),
  );
  assert.deepEqual(calls, ['mutation:lencoWebhookData:ingest']);
});

test('registered signed HTTP success settles a genuinely pending top-up before ACK', async () => {
  const db = fixture();
  const operation = await initiate(db);
  assert.equal(row(db, 'wallets')['balance'], 100);
  const response = await deliver(
    db,
    JSON.stringify({ event: 'collection.successful', data: collectionData(operation) }),
  );
  assert.equal(row(db, 'wallets')['balance'], 125, 'signed HTTP must credit the pending wallet');
  assert.equal(db.tables['walletTransactions']?.length, 1);
  assert.equal(response.status, 200);
});

for (const badSignature of [null, '', 'not-hex', '0'.repeat(128)]) {
  test(`invalid signature ${badSignature === null ? 'missing' : badSignature.length} rejects before private calls/writes`, async () => {
    const db = fixture();
    await initiate(db);
    const before = structuredClone(db.tables);
    const calls: string[] = [];
    const response = await deliver(db, '{invalid JSON and private data', { signature: badSignature, calls });
    assert.equal(response.status, 400);
    assert.deepEqual(db.tables, before);
    assert.deepEqual(calls, []);
    assert.equal(await response.text(), 'Webhook rejected');
  });
}

test('signature binds exact whitespace/UTF8 bytes, reads once and digest distinguishes equivalent JSON', async () => {
  const db = fixture();
  const operation = await initiate(db);
  const compact = packet(operation);
  const spaced = `  ${compact}\n`;
  const before = structuredClone(db.tables);
  assert.equal((await deliver(db, spaced, { signature: signature(compact) })).status, 400);
  const altered = new TextEncoder().encode(compact);
  altered[altered.length - 1] = 32;
  assert.equal((await deliver(db, altered, { signature: signature(compact) })).status, 400);
  assert.deepEqual(db.tables, before);
  let reads = 0;
  assert.equal(
    (
      await deliver(db, spaced, {
        onRead: () => {
          reads++;
        },
      })
    ).status,
    200,
  );
  assert.equal(reads, 1);
  assert.equal((await deliver(db, compact)).status, 200);
  assert.equal(db.tables['lencoWebhookInbox']?.length, 2);
  assert.equal(row(db, 'wallets')['balance'], 125);
  assert.equal(db.tables['walletTransactions']?.length, 1);
  for (const [body, inbox] of [spaced, compact].map(
    (body, index) => [body, db.tables['lencoWebhookInbox']?.[index]] as const,
  )) {
    assert.equal(inbox?.['bodyDigest'], createHash('sha256').update(body).digest('hex'));
  }
  assertMinimalInbox(db);
});

test('missing managed key is generic unavailable without private calls or writes', async () => {
  const db = fixture();
  const before = structuredClone(db.tables);
  const calls: string[] = [];
  const response = await deliver(db, '{}', { key: '', calls });
  assert.equal(response.status, 503);
  assert.deepEqual(calls, []);
  assert.deepEqual(db.tables, before);
});

for (const [body, classification] of [
  ['{', 'malformed'],
  ['null', 'malformed'],
  [JSON.stringify({ event: 'collection.successful', data: null }), 'malformed'],
  [JSON.stringify({ event: 'transaction.credit', data: { id: ID, phone: PHONE, notes: 'private' } }), 'unhandled'],
  [JSON.stringify({ event: 'transaction.debit', data: { id: ID } }), 'unhandled'],
  [JSON.stringify({ event: 'unknown-private-event', data: { id: ID } }), 'unhandled'],
] as const) {
  test(`verified ${classification} body is durable and identical delivery keeps first ingestion time`, async () => {
    const db = fixture();
    const before = financialSnapshot(db);
    const calls: string[] = [];
    assert.equal((await deliver(db, body, { calls })).status, 200);
    const inbox = structuredClone(row(db, 'lencoWebhookInbox'));
    assert.equal(inbox['classification'], classification);
    assert.equal((await deliver(db, body)).status, 200);
    assert.deepEqual(row(db, 'lencoWebhookInbox'), inbox);
    assert.equal(db.tables['lencoWebhookInbox']?.length, 1);
    assert.deepEqual(financialSnapshot(db), before);
    assert.deepEqual(calls, ['mutation:lencoWebhookData:ingest']);
    assertMinimalInbox(db);
  });
}

test('signed invalid UTF8 is durably malformed rather than reencoded for authority', async () => {
  const db = fixture();
  const body = new Uint8Array([0xff, 0xfe]);
  assert.equal((await deliver(db, body)).status, 200);
  assert.equal(row(db, 'lencoWebhookInbox')['classification'], 'malformed');
  assert.equal(row(db, 'lencoWebhookInbox')['bodyDigest'], createHash('sha256').update(body).digest('hex'));
});

test('same transaction id with success, opposite terminal and settlement enrichment retains all facts', async () => {
  const db = fixture();
  const operation = await initiate(db);
  assert.equal((await deliver(db, packet(operation))).status, 200);
  const proof = structuredClone(operation['accounting']);
  const financial = financialSnapshot(db);
  const calls: string[] = [];
  assert.equal((await deliver(db, packet(operation, 'failed'), { calls })).status, 200);
  assert.ok(calls.includes('mutation:providerSettlement:settleProviderReceipt'));
  assert.equal(operation['reviewNeeded'], true);
  assert.deepEqual(operation['accounting'], proof);
  assert.equal(
    (await deliver(db, JSON.stringify({ event: 'collection.settled', data: collectionData(operation) }))).status,
    200,
  );
  assert.equal(db.tables['lencoWebhookInbox']?.length, 3);
  assert.deepEqual(financialSnapshot(db), financial);
  assert.equal(
    db.tables['lencoWebhookInbox']?.find((entry) => entry['eventKind'] === 'collection_settled')?.['classification'],
    'enrichment',
  );
  assertMinimalInbox(db);
});

test('exact duplicate revalidates accepted writer and preserves once accounting, history and notices', async () => {
  const db = fixture();
  const operation = await initiate(db);
  const body = packet(operation);
  assert.equal((await deliver(db, body)).status, 200);
  const all = structuredClone(db.tables);
  const calls: string[] = [];
  assert.equal((await deliver(db, body, { calls })).status, 200);
  assert.deepEqual(
    financialSnapshot(db),
    Object.fromEntries(
      Object.entries(all).filter(
        ([table]) => table !== 'lencoWebhookInbox' && table !== 'paymentOperations' && table !== 'paymentInboxPolls',
      ),
    ),
  );
  assert.deepEqual(operation['accounting'], all['paymentOperations']?.[0]?.['accounting']);
  assert.deepEqual(operation['acquisitions'], all['paymentOperations']?.[0]?.['acquisitions']);
  assert.deepEqual(operation['receiptObservations'], all['paymentOperations']?.[0]?.['receiptObservations']);
  assert.equal(db.tables['lencoWebhookInbox']?.length, 1);
  assert.deepEqual(calls, [
    'mutation:lencoWebhookData:ingest',
    'mutation:providerSettlement:settleProviderReceipt',
    'mutation:lencoWebhookData:recordResult',
  ]);
  assert.equal(row(db, 'lencoWebhookInbox')['result'], 'applied');
});

for (const kind of ['mm', 'bank'] as const) {
  for (const status of ['successful', 'failed'] as const) {
    test(`signed ${kind} withdrawal ${status} uses accepted once debit/reversal`, async () => {
      const db = fixture();
      const operation = await initiate(db, kind);
      assert.equal(row(db, 'wallets')['balance'], 75);
      const body = JSON.stringify({ event: `transfer.${status}`, data: transferData(operation, status) });
      assert.equal((await deliver(db, body)).status, 200);
      assert.equal(row(db, 'wallets')['balance'], status === 'successful' ? 75 : 100);
      assert.equal(db.tables['walletTransactions']?.length, status === 'successful' ? 1 : 2);
      assert.equal(operation['status'], status === 'successful' ? 'succeeded' : 'failed');
      const money = financialSnapshot(db);
      const accounting = structuredClone(operation['accounting']);
      assert.equal((await deliver(db, body)).status, 200);
      assert.deepEqual(financialSnapshot(db), money);
      assert.deepEqual(operation['accounting'], accounting);
      assertMinimalInbox(db);
    });
  }
}

for (const event of ['collection.settled', 'collection.successful']) {
  test(`${event} card remains unhandled and cannot credit`, async () => {
    const db = fixture();
    const operation = await initiate(db);
    const before = structuredClone(db.tables);
    const calls: string[] = [];
    const body = JSON.stringify({ event, data: { ...collectionData(operation), type: 'card' } });
    assert.equal((await deliver(db, body, { calls })).status, 200);
    assert.deepEqual(
      financialSnapshot(db),
      Object.fromEntries(
        Object.entries(before).filter(([table]) => table !== 'paymentOperations' && table !== 'lencoWebhookInbox'),
      ),
    );
    assert.deepEqual(db.tables['paymentOperations'], before['paymentOperations']);
    assert.equal(row(db, 'lencoWebhookInbox')['classification'], 'unhandled');
    assert.deepEqual(calls, ['mutation:lencoWebhookData:ingest']);
  });
}

test('missing transfer country is an operation-associated lookup queue, never signed null-country authority', async () => {
  const db = fixture();
  const operation = await initiate(db, 'mm');
  const data = transferData(operation);
  const account = data['creditAccount'] as Record<string, unknown>;
  delete account['country'];
  const before = structuredClone(db.tables);
  const calls: string[] = [];
  assert.equal((await deliver(db, JSON.stringify({ event: 'transfer.successful', data }), { calls })).status, 200);
  assert.deepEqual(
    financialSnapshot(db),
    Object.fromEntries(
      Object.entries(before).filter(([table]) => table !== 'paymentOperations' && table !== 'lencoWebhookInbox'),
    ),
  );
  assert.deepEqual(db.tables['paymentOperations'], before['paymentOperations']);
  assert.equal(row(db, 'lencoWebhookInbox')['classification'], 'lookup_required');
  assert.equal(row(db, 'lencoWebhookInbox')['operationId'], operation._id);
  assert.deepEqual(calls, ['mutation:lencoWebhookData:ingest']);
  assertMinimalInbox(db);
});

for (const mutation of [
  'lencoWebhookData:ingest',
  'providerSettlement:settleProviderReceipt',
  'lencoWebhookData:recordResult',
]) {
  test(`${mutation} failure returns 5xx; retry does actual once settlement after partial action commit`, async () => {
    const db = fixture();
    const operation = await initiate(db);
    const body = packet(operation);
    const response = await deliver(db, body, {
      beforeMutation: async (name) => {
        if (name === mutation) {
          throw new Error(`private ${PHONE} ${ENV.LENCO_API_KEY}`);
        }
      },
    });
    assert.equal(response.status, 500);
    assert.equal(await response.text(), 'Webhook processing failed');
    const committed = mutation === 'lencoWebhookData:recordResult';
    assert.equal(row(db, 'wallets')['balance'], committed ? 125 : 100);
    assert.equal(db.tables['lencoWebhookInbox']?.length ?? 0, mutation === 'lencoWebhookData:ingest' ? 0 : 1);
    if (committed) {
      assert.equal(row(db, 'lencoWebhookInbox')['result'], undefined);
    }
    const calls: string[] = [];
    assert.equal((await deliver(db, body, { calls })).status, 200);
    assert.equal(row(db, 'wallets')['balance'], 125);
    assert.equal(db.tables['walletTransactions']?.length, 1);
    assert.equal(row(db, 'lencoWebhookInbox')['result'], 'applied');
    assert.ok(calls.includes('mutation:providerSettlement:settleProviderReceipt'));
    assertMinimalInbox(db);
  });
}

for (const stage of ['lencoWebhookData:ingest', 'lencoWebhookData:recordResult']) {
  test(`HTTP waits for ${stage} persistence before ACK`, async () => {
    const db = fixture();
    const operation = await initiate(db);
    let entered: () => void = () => {
      throw new Error('barrier not initialized');
    };
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release: () => void = () => {
      throw new Error('barrier not initialized');
    };
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let returned = false;
    const response = deliver(db, packet(operation), {
      beforeMutation: async (name) => {
        if (name === stage) {
          entered();
          await barrier;
        }
      },
    }).then((value) => {
      returned = true;
      return value;
    });
    await reached;
    assert.equal(returned, false);
    assert.equal(row(db, 'wallets')['balance'], stage === 'lencoWebhookData:ingest' ? 100 : 125);
    release();
    assert.equal((await response).status, 200);
  });
}

test('owed webhook settlement works with initiation disabled and owner banned/frozen', async () => {
  const db = fixture();
  const operation = await initiate(db);
  row(db, 'appConfig')['paymentsEnabled'] = false;
  row(db, 'users')['isBanned'] = true;
  row(db, 'wallets')['isFrozen'] = true;
  assert.equal((await deliver(db, packet(operation))).status, 200);
  assert.equal(row(db, 'wallets')['balance'], 125);
  assert.equal(operation['status'], 'succeeded');
});

test('inbox result association and digest cannot be supplied as a different operation proof', async () => {
  const db = fixture();
  const operation = await initiate(db);
  assert.equal((await deliver(db, packet(operation))).status, 200);
  const inbox = row(db, 'lencoWebhookInbox');
  const before = structuredClone(db.tables);
  for (const [digest, operationId] of [
    [inbox['bodyDigest'], 'paymentOperations|other'],
    ['0'.repeat(64), operation._id],
  ]) {
    await assert.rejects(
      invokeFakeFunction(lencoWebhookData.recordResult, createCtx(db, null), {
        inboxId: inbox._id,
        bodyDigest: digest,
        result: { operationId, status: 'succeeded', application: 'applied' },
      }),
      /Webhook result mismatch/,
    );
    assert.deepEqual(db.tables, before);
  }
  for (const fn of [lencoWebhookData.ingest, lencoWebhookData.recordResult]) {
    assert.equal(fn.isInternal, true);
    assert.equal('isPublic' in fn, false);
  }
});

test('collection.settled queues late fee lookup without changing frozen accounting or unknown fee authority', async () => {
  const db = fixture();
  const operation = await initiate(db);
  const data = { ...collectionData(operation), fee: null };
  assert.equal((await deliver(db, JSON.stringify({ event: 'collection.successful', data }))).status, 200);
  const proof = structuredClone(operation['accounting']);
  assert.equal((proof as { receipt: { feeMinor: number | null } }).receipt.feeMinor, null);
  const before = structuredClone(db.tables['paymentOperations']);
  const money = financialSnapshot(db);
  const calls: string[] = [];
  const enriched = JSON.stringify({
    event: 'collection.settled',
    data: { ...data, fee: '1.20', settlementStatus: 'settled' },
  });
  assert.equal((await deliver(db, enriched, { calls })).status, 200);
  assert.deepEqual(db.tables['paymentOperations'], before);
  assert.deepEqual(financialSnapshot(db), money);
  assert.deepEqual(operation['accounting'], proof);
  assert.equal(
    db.tables['lencoWebhookInbox']?.find((entry) => entry['classification'] === 'enrichment')?.['operationId'],
    operation._id,
  );
  assert.deepEqual(calls, ['mutation:lencoWebhookData:ingest']);
});

test('same-terminal changed receipt facts reach writer while preserving original accounting proof', async () => {
  const db = fixture();
  const operation = await initiate(db);
  assert.equal((await deliver(db, packet(operation))).status, 200);
  const proof = structuredClone(operation['accounting']);
  const money = financialSnapshot(db);
  const calls: string[] = [];
  const body = JSON.stringify({ event: 'collection.successful', data: { ...collectionData(operation), fee: '1.20' } });
  assert.equal((await deliver(db, body, { calls })).status, 200);
  assert.ok(calls.includes('mutation:providerSettlement:settleProviderReceipt'));
  assert.equal((operation['receipt'] as ProviderReceiptFacts).feeMinor, 120);
  assert.deepEqual(operation['accounting'], proof);
  assert.deepEqual(financialSnapshot(db), money);
  assert.equal(db.tables['lencoWebhookInbox']?.length, 2);
});

test('legacy completed credit with current intent is held, never adopted or credited twice', async () => {
  const db = fixture();
  const operation = await initiate(db);
  db.tables['walletTransactions'] = [
    {
      _id: 'walletTransactions|legacy',
      externalReference: ID,
      providerReference: operation['providerReference'],
      type: 'credit',
      amount: 25,
      source: 'top_up_mobile_money',
      status: 'completed',
      userId: OWNER,
      walletId: 'wallets|buyer',
    },
  ];
  const money = financialSnapshot(db);
  assert.equal((await deliver(db, packet(operation))).status, 200);
  assert.equal(operation['reviewNeeded'], true);
  assert.equal(operation['accounting'], undefined);
  assert.deepEqual(financialSnapshot(db), money);
});

test('retries cannot reassign inbox association when operation mapping changes', async () => {
  const db = fixture();
  const operation = await initiate(db);
  const body = packet(operation);
  assert.equal(
    (
      await deliver(db, body, {
        beforeMutation: async (name) => {
          if (name === 'providerSettlement:settleProviderReceipt') {
            throw new Error('unavailable');
          }
        },
      })
    ).status,
    500,
  );
  const inbox = row(db, 'lencoWebhookInbox');
  const firstTime = inbox['ingestedAt'];
  const replacement = { ...structuredClone(operation), _id: 'paymentOperations|replacement' };
  db.tables['paymentOperations'] = [replacement];
  const before = financialSnapshot(db);
  const calls: string[] = [];
  assert.equal((await deliver(db, body, { calls })).status, 200);
  assert.equal(inbox['classification'], 'ambiguous');
  assert.equal(inbox['operationId'], operation._id);
  assert.equal(inbox['ingestedAt'], firstTime);
  assert.equal(inbox['result'], undefined);
  assert.deepEqual(financialSnapshot(db), before);
  assert.deepEqual(calls, ['mutation:lencoWebhookData:ingest']);
});

test('minimal unhandled ACK also waits for actual database insert and reports insert failure honestly', async () => {
  const db = fixture();
  const before = structuredClone(db.tables);
  db.insert = async () => {
    throw new Error('private database failure');
  };
  assert.equal(
    (await deliver(db, JSON.stringify({ event: 'transaction.credit', data: { phone: PHONE } }))).status,
    500,
  );
  assert.deepEqual(db.tables, before);
});

test('handler emits no logs containing private payloads, keys, signatures or infrastructure errors', async (context) => {
  const logs: unknown[][] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    context.mock.method(console, method, (...args: unknown[]): void => {
      logs.push(args);
    });
  }
  const db = fixture();
  const operation = await initiate(db);
  assert.equal((await deliver(db, '{secret', { signature: 'private-signature' })).status, 400);
  assert.equal(
    (
      await deliver(db, packet(operation), {
        beforeMutation: async () => {
          throw new Error(`private ${PHONE} ${ENV.LENCO_API_KEY}`);
        },
      })
    ).status,
    500,
  );
  assert.equal(
    (await deliver(db, JSON.stringify({ event: 'private', data: { name: 'private-name', phone: PHONE } }))).status,
    200,
  );
  assert.deepEqual(logs, []);
  assertMinimalInbox(db);
});

function userRow(id: string, clerkId: string, role: string, extra: Record<string, unknown> = {}): Row {
  return {
    _id: id,
    clerkId,
    email: `${clerkId}@example.invalid`,
    firstName: id,
    lastName: 'Test',
    role,
    isBanned: false,
    totalSales: 0,
    totalPurchases: 0,
    isVerified: true,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

function productRow(id: string, sellerId: string, extra: Record<string, unknown> = {}): Row {
  return {
    _id: id,
    sellerId,
    title: `Title ${id}`,
    description: 'A test listing',
    price: 100,
    images: ['https://images.invalid/x.jpg'],
    condition: 'good',
    status: 'active',
    quantity: 10,
    categoryId: 'categories|1',
    shippingOptions: [{ name: 'Courier', price: 50 }],
    views: 0,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

function checkoutTables(): Tables {
  const now = Date.now();
  return {
    users: [
      userRow('users|buyer', 'clerk_buyer', 'user'),
      userRow('users|other', 'clerk_other', 'user'),
      userRow('users|seller', 'clerk_seller', 'user'),
      userRow('users|seller2', 'clerk_seller2', 'user'),
    ],
    vendorProfiles: [
      {
        _id: 'vendorProfiles|seller',
        ownerUserId: 'users|seller',
        status: 'approved',
        storeName: 'Seller',
        slug: 'seller',
      },
      {
        _id: 'vendorProfiles|seller2',
        ownerUserId: 'users|seller2',
        status: 'approved',
        storeName: 'Seller2',
        slug: 'seller2',
      },
    ],
    platformSettings: [
      {
        _id: 'platformSettings|1',
        key: 'singleton',
        companySellerUserId: 'users|company',
        companyDisplayName: 'Gettitonline',
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    appConfig: [
      {
        _id: 'appConfig|1',
        key: 'singleton',
        minimumBuilds: { ios: 1, android: 1 },
        paymentsEnabled: true,
        updatedAt: 1,
      },
    ],
    products: [
      productRow('products|lamp', 'users|seller', { price: 100, quantity: 10, weightKg: 2 }),
      productRow('products|cap', 'users|seller2', {
        price: 10,
        quantity: 100,
        weightKg: 0.5,
        shippingOptions: [{ name: 'Standard', price: 20 }],
      }),
    ],
    cartItems: [],
    orders: [],
    escrow: [],
    transactions: [],
    walletTransactions: [],
    paymentOperations: [],
    paymentAccounts: [],
    promoCodes: [
      {
        _id: 'promoCodes|save10',
        code: 'SAVE10',
        title: 'Save',
        scope: 'platform',
        discountType: 'percent',
        discountValue: 10,
        startsAt: now - 3600000,
        isActive: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    promoCodeRedemptions: [],
    loyaltyAccounts: [
      {
        _id: 'loyaltyAccounts|buyer',
        userId: 'users|buyer',
        pointsBalance: 100,
        lifetimeEarned: 100,
        lifetimeRedeemed: 0,
        tier: 'bronze',
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    loyaltyTransactions: [],
    wallets: [],
    deliveryZones: [
      {
        _id: 'deliveryZones|z1',
        name: 'Lusaka',
        slug: 'lusaka',
        province: 'Lusaka',
        city: 'Lusaka',
        isActive: true,
        sortOrder: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    deliveryMethods: [
      {
        _id: 'deliveryMethods|m1',
        zoneId: 'deliveryZones|z1',
        name: 'Standard',
        code: 'STD',
        type: 'standard',
        baseFee: 20,
        perKgFee: 10,
        minDays: 1,
        maxDays: 3,
        isActive: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    pickupPoints: [],
    notifications: [],
    behaviorEvents: [],
  };
}

const ADDRESS = { street: '123 Main', city: 'Lusaka', province: 'Lusaka', country: 'Zambia', phone: PHONE };

for (const status of ['successful', 'failed'] as const) {
  test(`signed aggregate checkout ${status} applies two orders exactly once`, async () => {
    const db = createDb(checkoutTables());
    db.tables['cartItems'] = ['lamp', 'cap'].map((product, index) => ({
      _id: `cartItems|line${index}`,
      userId: OWNER,
      productId: `products|${product}`,
      quantity: 1,
      selectedShipping: { name: 'Courier', price: 50 },
      createdAt: 1,
      updatedAt: 1,
    }));
    const input = {
      source: 'cart',
      deliveryMethodId: 'deliveryMethods|m1',
      shippingAddress: ADDRESS,
      promoCode: 'SAVE10',
      loyaltyPoints: 20,
    };
    const quoted = (await invokeFakeFunction(checkoutQuote.quoteCheckout, createCtx(db, 'clerk_buyer'), input)) as {
      ok: boolean;
      quote: CheckoutQuote;
    };
    assert.equal(quoted.ok, true);
    assert.ok(quoted.quote.promo && quoted.quote.loyalty);
    await invokeFakeFunction(
      checkoutCollection.createCheckoutCollectionAction({ env: () => ENV, fetchImpl: transport('pending') }),
      createFakeActionCtx({
        db,
        subject: 'clerk_buyer',
        modules: { checkoutCollection, providerOperations, providerSettlement },
      }),
      {
        ...input,
        requestId: 'aggregate',
        expectedQuoteKey: quoted.quote.quoteKey,
        phone: PHONE,
        operator: 'mtn',
      },
    );
    const operation = row(db, 'paymentOperations');
    assert.equal(db.tables['orders']?.length, 2);
    assert.ok(db.tables['orders']?.every((order) => order['status'] === 'pending_payment'));
    const data = { ...collectionData(operation, status), amount: String(Number(operation['amountCents']) / 100) };
    const body = JSON.stringify({ event: `collection.${status}`, data });
    assert.equal((await deliver(db, body)).status, 200);
    assert.ok(
      db.tables['orders']?.every((order) => order['status'] === (status === 'successful' ? 'paid' : 'cancelled')),
    );
    assert.equal(db.tables['escrow']?.length ?? 0, status === 'successful' ? 2 : 0);
    assert.equal(row(db, 'promoCodeRedemptions')['status'], status === 'successful' ? 'captured' : 'released');
    assert.equal(row(db, 'loyaltyTransactions')['status'], status === 'successful' ? 'captured' : 'released');
    const money = financialSnapshot(db);
    const proof = structuredClone(operation['accounting']);
    assert.equal((await deliver(db, body)).status, 200);
    assert.deepEqual(financialSnapshot(db), money);
    assert.deepEqual(operation['accounting'], proof);
    assertMinimalInbox(db);
  });
}
