import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, createHmac } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import * as webhook from './lencoWebhook';
import * as lencoWebhookData from './lencoWebhookData';
import * as providerOperations from './providerOperations';
import * as providerSettlement from './providerSettlement';
import * as paymentReconciliationData from './paymentReconciliationData';
import * as reconciliation from './paymentReconciliation';
import type { LencoFetch } from './lib/lencoAdapter';
import { createFakeActionCtx, invokeFakeFunction } from '../tests/support/convexFakeActionCtx';
import { createCtx, createDb, handlerOf, type Row } from '../tests/support/convexFakeDb';

const OWNER = 'users|buyer';
const PHONE = '0971234567';
const ID = '22222222-2222-3333-4444-555555555555';
const DEBIT = '11111111-2222-3333-4444-555555555555';
const ENV = { LENCO_API_KEY: 'synthetic-fixture', LENCO_ACCOUNT_ID: DEBIT };
type Db = ReturnType<typeof createDb>;

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

const modules = {
  lencoWebhookData,
  providerOperations,
  providerSettlement,
  paymentReconciliationData,
  paymentReconciliation: reconciliation,
};

function row(db: Db, table: string): Row {
  const value = db.tables[table]?.[0];
  assert.ok(value);
  return value;
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function numeric(value: unknown): number {
  assert.equal(typeof value, 'number');
  return value as number;
}

function wire(operation: Row, status = 'successful', fee: string | null = '0.70'): Record<string, unknown> {
  const common = {
    id: ID,
    reference: operation.providerReference,
    amount: '25.00',
    currency: 'ZMW',
    status,
    fee,
    reasonForFailure: null,
    settlementStatus: null,
  };
  return operation.kind === 'withdrawal_transfer'
    ? { ...common, accountId: DEBIT, creditAccount: { type: 'mobile-money', phone: PHONE, operator: 'mtn' } }
    : {
        ...common,
        type: 'mobile-money',
        bearer: 'merchant',
        mobileMoneyDetails: { country: 'zm', phone: PHONE, operator: 'mtn' },
      };
}

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ status: true, data }), { status: 200 });
}

async function prepare(
  kind: 'mm' | 'topup' = 'mm',
  initialFee: string | null = '0.70',
): Promise<{ db: Db; operation: Row }> {
  const db = fixture();
  const fetchImpl: LencoFetch = async (_url, init) => {
    assert.equal(init.method, 'POST');
    const body = record(JSON.parse(String(init.body)));
    const operation: Row = {
      _id: 'transport',
      providerReference: body.reference,
      kind: kind === 'mm' ? 'withdrawal_transfer' : 'top_up_collection',
    };
    const data = wire(operation, 'pending', initialFee);
    if (kind === 'mm') {
      record(data.creditAccount).country = 'zm';
    }
    return envelope(data);
  };
  await invokeFakeFunction(
    kind === 'mm'
      ? providerOperations.createWithdrawalAction({ env: () => ENV, fetchImpl })
      : providerOperations.createTopUpAction({ env: () => ENV, fetchImpl }),
    createFakeActionCtx({ db, subject: 'buyer', modules }),
    kind === 'mm'
      ? {
          requestId: 'request',
          amountCents: 2500,
          paymentAccountId: 'paymentAccounts|mm',
          expectedDestinationKey: `mm:zm:mtn:${PHONE}`,
        }
      : { requestId: 'request', amountCents: 2500, phone: PHONE, operator: 'mtn' },
  );
  return { db, operation: row(db, 'paymentOperations') };
}

function packet(operation: Row, event = 'transfer.successful', fee: string | null = '0.70'): string {
  return JSON.stringify({ event, data: wire(operation, 'successful', fee) });
}

async function deliver(db: Db, body: string, signed = true, calls: string[] = []): Promise<Response> {
  const signature = createHmac('sha512', createHash('sha256').update(ENV.LENCO_API_KEY).digest('hex'))
    .update(body)
    .digest('hex');
  const request = new Request('https://fixture.invalid/lenco-webhook', {
    method: 'POST',
    body,
    headers: { 'X-Lenco-Signature': signed ? signature : 'invalid' },
  });
  return await handlerOf<Request, Response>(webhook.createLencoWebhookAction({ env: () => ENV }))(
    createFakeActionCtx({ db, subject: null, modules, calls }),
    request,
  );
}

test('signed missing-country ingestion persists and arms the original inbox checkpoint before ACK', async (t) => {
  t.mock.method(Date, 'now', () => 2_000_000_000_000);
  const { db, operation } = await prepare();
  const response = await deliver(db, packet(operation));
  assert.equal(response.status, 200);
  const inbox = row(db, 'lencoWebhookInbox');
  assert.equal(inbox.classification, 'lookup_required');
  assert.equal(inbox.operationId, operation._id);
  assert.equal(db.tables.paymentInboxPolls?.length ?? 0, 1, 'eligible signed inbox arms one durable queue');
  const queue = row(db, 'paymentInboxPolls');
  assert.equal(queue.origin, inbox.ingestedAt);
  assert.equal(queue.inboxId, inbox._id);
  assert.equal(queue.operationId, operation._id);
  assert.equal(queue.nextIndex, 0);
  assert.equal(queue.dispatchedCount, 0);
  assert.equal(queue.state, 'active');
  const job = db.scheduled.find((entry) => entry.id === queue.jobId);
  assert.ok(job);
  assert.equal(job.name, 'paymentInboxPolling:checkpoint');
  assert.equal(job.dueAt, inbox.ingestedAt);
});

// Observable invariants: loss cannot remove successors, lookup completion stops
// acquisition, and exhaustion cannot manufacture a financial hold or fee.
function queue(db: Db): Row {
  return row(db, 'paymentInboxPolls');
}

function currentJob(db: Db) {
  const job = db.scheduled.find((entry) => entry.id === queue(db).jobId);
  assert.ok(job);
  return job;
}

function getJobs(db: Db) {
  return db.scheduled.filter((entry) => entry.name === 'paymentReconciliation:reconcileAssociatedInbox');
}

async function callback(db: Db, job = currentJob(db)): Promise<unknown> {
  const polling = await import('./paymentInboxPolling');
  return await invokeFakeFunction(
    job.name === 'paymentInboxPolling:exhaustion' ? polling.exhaustion : polling.checkpoint,
    createCtx(db, null),
    job.args,
  );
}

async function getAction(
  db: Db,
  operation: Row,
  status = 'successful',
  fee: string | null = '0.70',
  fetchImpl?: LencoFetch,
): Promise<unknown> {
  const job = getJobs(db).at(-1);
  assert.ok(job);
  assert.deepEqual(job.args, { inboxId: row(db, 'lencoWebhookInbox')._id });
  return await invokeFakeFunction(
    reconciliation.createReconcileInboxAction({
      env: () => ENV,
      fetchImpl:
        fetchImpl ??
        (async (_url, init) => {
          assert.equal(init.method, 'GET');
          assert.match(_url, new RegExp(`${ID}$`));
          return envelope(wire(operation, status, fee));
        }),
    }),
    createFakeActionCtx({ db, subject: null, modules }),
    job.args,
  );
}

function money(db: Db): Record<string, Row[]> {
  return structuredClone(
    Object.fromEntries(
      Object.entries(db.tables).filter(([table]) => !['paymentInboxPolls', 'lencoWebhookInbox'].includes(table)),
    ),
  );
}

async function status(db: Db, operation: Row): Promise<Record<string, unknown>> {
  return record(
    await invokeFakeFunction(reconciliation.getStatus, createCtx(db, 'buyer'), { operationId: operation._id }),
  );
}

const OFFSETS = [
  0,
  30_000,
  60_000,
  120_000,
  300_000,
  900_000,
  1_800_000,
  ...Array.from({ length: 24 }, (_, index) => (index + 1) * 3_600_000),
];

test('signed missing country reaches actual GET null-country authority and settles withdrawal exactly once', async (t) => {
  let now = 2_000_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { db, operation } = await prepare();
  assert.equal((await deliver(db, packet(operation))).status, 200);
  const financial = structuredClone(db.tables.paymentFinancialPolls);
  await callback(db);
  assert.equal(currentJob(db).dueAt, now + 30_000);
  const result = record(await getAction(db, operation));
  assert.deepEqual(result, { result: 'processed', application: 'applied' });
  assert.equal(operation.status, 'succeeded');
  assert.equal(row(db, 'wallets').balance, 75);
  assert.equal(row(db, 'wallets').pendingBalance, 3);
  assert.equal(row(db, 'wallets').totalWithdrawn, 25);
  const proof = record(operation.accounting);
  assert.equal(record(proof.receipt).kind, 'transfer');
  assert.equal(record(record(proof.receipt).destination).country, null);
  assert.equal(record(proof.acquisition).kind, 'status_get');
  const settled = money(db);
  await getAction(db, operation);
  assert.deepEqual(money(db), settled);
  assert.equal((await status(db, operation)).accountingApplied, true);
  now += 30_000;
  await callback(db);
  assert.equal(queue(db).state, 'stopped');
  assert.equal(getJobs(db).length, 1);
  assert.deepEqual(db.tables.paymentFinancialPolls, financial);
});

for (const lookupStatus of ['pending', 'successful', 'failed']) {
  test(`actual ${lookupStatus} lookup with null fee stops only the acquisition queue`, async (t) => {
    let now = 2_000_000_000_000;
    t.mock.method(Date, 'now', () => now);
    const { db, operation } = await prepare('topup', null);
    await deliver(db, packet(operation, 'collection.settled', null));
    const financial = structuredClone(db.tables.paymentFinancialPolls);
    const financialJobs = db.scheduled
      .filter((job) => job.name === 'paymentPolling:checkpoint')
      .map(({ target: _target, ...job }) => structuredClone(job));
    await callback(db);
    const outcome = record(await getAction(db, operation, lookupStatus, null));
    assert.equal(outcome.result, 'processed');
    assert.equal(row(db, 'lencoWebhookInbox').lookupResult, outcome.application);
    assert.equal(row(db, 'lencoWebhookInbox').lookupCompletedAt, now);
    assert.equal((await status(db, operation)).feeCents, null);
    const settled = money(db);
    now += 30_000;
    await callback(db);
    assert.equal(queue(db).state, 'stopped');
    assert.deepEqual(money(db), settled);
    assert.equal(operation.reviewNeeded, undefined);
    assert.deepEqual(db.tables.paymentFinancialPolls, financial);
    assert.deepEqual(
      db.scheduled.filter((job) => job.name === 'paymentPolling:checkpoint').map(({ target: _target, ...job }) => job),
      financialJobs,
    );
    if (lookupStatus === 'pending') {
      assert.equal(operation.status, 'unknown');
      assert.equal(row(db, 'wallets').pendingBalance, 3);
      assert.equal(operation.accounting, undefined);
    }
  });
}

test('signed merchant enrichment acquires known fee after original applied null fee without rewriting money or proof', async (t) => {
  let now = 2_000_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { db, operation } = await prepare('topup');
  await deliver(db, packet(operation, 'collection.successful', null));
  assert.equal(operation.status, 'succeeded');
  const proof = structuredClone(operation.accounting);
  const funds = structuredClone(db.tables.wallets);
  assert.equal((await status(db, operation)).feeCents, null);
  // A distinct signed digest owns a distinct acquisition observation.
  now += 100;
  await deliver(db, packet(operation, 'collection.settled', '1.20'));
  assert.equal(db.tables.paymentInboxPolls?.length, 2);
  const enrichment = db.tables.paymentInboxPolls?.[1];
  assert.ok(enrichment);
  const job = db.scheduled.find((entry) => entry.id === enrichment.jobId);
  assert.ok(job);
  await callback(db, job);
  const get = getJobs(db).at(-1);
  assert.ok(get);
  await invokeFakeFunction(
    reconciliation.createReconcileInboxAction({
      env: () => ENV,
      fetchImpl: async (_url, init) => {
        assert.equal(init.method, 'GET');
        return envelope(wire(operation, 'successful', '1.20'));
      },
    }),
    createFakeActionCtx({ db, subject: null, modules }),
    get.args,
  );
  assert.deepEqual(operation.accounting, proof);
  assert.deepEqual(db.tables.wallets, funds);
  assert.equal((await status(db, operation)).feeCents, 120);
  db.tables.users?.push({ ...row(db, 'users'), _id: 'users|admin', clerkId: 'admin', role: 'admin' });
  const transactions = await import('./transactions');
  const summary = record(
    await invokeFakeFunction(transactions.getPlatformFinancialSummary, createCtx(db, 'admin'), {
      adminId: 'users|admin',
    }),
  );
  assert.equal(summary.totalGatewayFees, 1.2);
  assert.equal(record(summary.review).unknownFeeOperations, 0);
  assert.equal(operation.reviewNeeded, undefined);
  now += 30_000;
  const successor = db.scheduled.find((entry) => entry.id === enrichment.jobId);
  assert.ok(successor);
  await callback(db, successor);
  assert.equal(enrichment.state, 'stopped');
  assert.deepEqual(operation.accounting, proof);
});

test('all 31 dropped GET dispatches retain successor first and exhaust only metadata at fixed safety', async (t) => {
  let now = 2_000_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { db, operation } = await prepare();
  await deliver(db, packet(operation));
  const origin = now;
  const before = money(db);
  for (let index = 0; index < OFFSETS.length; index++) {
    now = origin + OFFSETS[index]!;
    const job = currentJob(db);
    assert.equal(job.dueAt, now);
    assert.equal(job.args.index, index);
    const priorLength = db.scheduled.length;
    await callback(db, job);
    assert.equal(db.scheduled[priorLength]?.id, queue(db).jobId, 'successor recorded before GET');
    assert.equal(db.scheduled[priorLength + 1]?.name, 'paymentReconciliation:reconcileAssociatedInbox');
    assert.equal(queue(db).dispatchedCount, index + 1);
    assert.equal(queue(db).origin, origin);
    assert.deepEqual(money(db), before);
    await callback(db, job);
    assert.equal(getJobs(db).length, index + 1, 'duplicate callback cannot dispatch again');
  }
  assert.equal(getJobs(db).length, 31);
  assert.equal(queue(db).state, 'awaiting_exhaustion');
  assert.equal(currentJob(db).name, 'paymentInboxPolling:exhaustion');
  assert.equal(currentJob(db).dueAt, origin + 86_460_000);
  now += 59_999;
  await callback(db);
  assert.equal(queue(db).state, 'awaiting_exhaustion');
  now++;
  await callback(db);
  assert.equal(queue(db).state, 'exhausted');
  assert.equal(operation.reviewNeeded, undefined);
  assert.deepEqual(money(db), before);
  await deliver(db, packet(operation));
  assert.equal(getJobs(db).length, 31);
  assert.equal(queue(db).state, 'exhausted');
  assert.equal(queue(db).origin, origin);
});

for (const [delay, next, count, state] of [
  [0, 30_000, 1, 'active'],
  [30_000, 60_000, 1, 'active'],
  [61_000, 120_000, 1, 'active'],
  [86_400_000, 86_460_000, 1, 'awaiting_exhaustion'],
  [86_459_999, 86_460_000, 1, 'awaiting_exhaustion'],
  [86_460_000, 0, 0, 'exhausted'],
  [90_000_000, 0, 0, 'exhausted'],
] as const) {
  test(`late first callback at ${delay} skips missed opportunities without burst or new origin`, async (t) => {
    let now = 2_000_000_000_000;
    t.mock.method(Date, 'now', () => now);
    const { db, operation } = await prepare();
    await deliver(db, packet(operation));
    const before = money(db);
    const origin = now;
    now += delay;
    await callback(db);
    assert.equal(queue(db).origin, origin);
    assert.equal(queue(db).state, state);
    assert.equal(queue(db).dispatchedCount, count);
    assert.equal(getJobs(db).length, count);
    assert.equal(queue(db).dueAt, origin + next);
    assert.deepEqual(money(db), before);
  });
}

test('signed redelivery freezes first origin and binding; distinct contradictory digest is retained independently', async (t) => {
  let now = 2_000_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { db, operation } = await prepare();
  const body = packet(operation);
  await deliver(db, body);
  const original = structuredClone(queue(db));
  const jobs = db.scheduled.length;
  now += 500_000;
  await deliver(db, body);
  assert.deepEqual(queue(db), original);
  assert.equal(db.scheduled.length, jobs);
  assert.equal(row(db, 'lencoWebhookInbox').ingestedAt, original.origin);
  await deliver(db, JSON.stringify({ event: 'transfer.failed', data: wire(operation, 'failed') }));
  assert.equal(db.tables.paymentInboxPolls?.length, 2);
  assert.equal(db.tables.lencoWebhookInbox?.length, 2);
  assert.equal(db.tables.paymentInboxPolls?.[1]?.origin, now);
  assert.equal(operation.status, 'unknown');
  assert.equal(row(db, 'wallets').pendingBalance, 3);
});

for (const override of [
  { generation: 2 },
  { generation: 0 },
  { generation: NaN },
  { index: -1 },
  { index: 1 },
  { index: 0.5 },
  { index: 32 },
  { inboxId: 'lencoWebhookInbox|foreign' },
  { pollId: 'paymentInboxPolls|foreign' },
]) {
  test(`early/stale/foreign callback ${JSON.stringify(override)} cannot dispatch or reset`, async (t) => {
    t.mock.method(Date, 'now', () => 2_000_000_000_000);
    const { db, operation } = await prepare();
    await deliver(db, packet(operation));
    const before = structuredClone(db.tables);
    const polling = await import('./paymentInboxPolling');
    await invokeFakeFunction(polling.checkpoint, createCtx(db, null), { ...currentJob(db).args, ...override });
    assert.deepEqual(db.tables, before);
    assert.equal(getJobs(db).length, 0);
  });
}

test('early checkpoint cannot spend an acquisition dispatch', async (t) => {
  let now = 2_000_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { db, operation } = await prepare();
  await deliver(db, packet(operation));
  now--;
  const before = structuredClone(db.tables);
  await callback(db);
  assert.deepEqual(db.tables, before);
  assert.equal(getJobs(db).length, 0);
});

for (const change of [
  'duplicate_queue',
  'fractional_origin',
  'overflow_origin',
  'bad_generation',
  'fractional_index',
  'count_over_budget',
  'count_over_index',
  'wrong_due',
  'missing_job',
  'wrong_state',
  'bad_digest',
]) {
  test(`malformed queue ${change} fails closed before any GET or money write`, async (t) => {
    t.mock.method(Date, 'now', () => 2_000_000_000_000);
    const { db, operation } = await prepare();
    await deliver(db, packet(operation));
    const job = currentJob(db);
    const poll = queue(db);
    if (change === 'duplicate_queue') {
      db.tables.paymentInboxPolls?.push({ ...poll, _id: 'paymentInboxPolls|duplicate' });
    }
    if (change === 'fractional_origin') {
      poll.origin = numeric(poll.origin) + 0.5;
    }
    if (change === 'overflow_origin') {
      poll.origin = Number.MAX_SAFE_INTEGER;
    }
    if (change === 'bad_generation') {
      poll.generation = 2;
    }
    if (change === 'fractional_index') {
      poll.nextIndex = 0.5;
    }
    if (change === 'count_over_budget') {
      poll.dispatchedCount = 32;
    }
    if (change === 'count_over_index') {
      poll.dispatchedCount = 1;
    }
    if (change === 'wrong_due') {
      poll.dueAt = numeric(poll.dueAt) + 1;
    }
    if (change === 'missing_job') {
      delete poll.jobId;
    }
    if (change === 'wrong_state') {
      poll.state = 'successful';
    }
    if (change === 'bad_digest') {
      poll.bodyDigest = 'invalid';
    }
    const before = money(db);
    await assert.rejects(callback(db, job), /Invalid inbox poll state/);
    assert.equal(getJobs(db).length, 0);
    assert.deepEqual(money(db), before);
  });
}

for (const race of [
  'digest',
  'origin',
  'class',
  'event',
  'operation',
  'removed_operation',
  'duplicate_reference',
  'duplicate_id',
  'duplicate_digest',
  'wallet_kind',
]) {
  test(`current association race ${race} stops without retargeting or changing financial state`, async (t) => {
    t.mock.method(Date, 'now', () => 2_000_000_000_000);
    const { db, operation } = await prepare();
    await deliver(db, packet(operation));
    const inbox = row(db, 'lencoWebhookInbox');
    if (race === 'digest') {
      inbox.bodyDigest = 'a'.repeat(64);
    }
    if (race === 'origin') {
      inbox.ingestedAt = numeric(inbox.ingestedAt) + 1;
    }
    if (race === 'class') {
      inbox.classification = 'terminal';
    }
    if (race === 'event') {
      inbox.eventKind = 'collection_successful';
    }
    if (race === 'operation') {
      inbox.operationId = 'paymentOperations|foreign';
    }
    if (race === 'removed_operation') {
      await db.delete(operation._id);
    }
    if (race === 'duplicate_reference') {
      db.tables.paymentOperations?.push({ ...operation, _id: 'paymentOperations|other', providerId: undefined });
    }
    if (race === 'duplicate_id') {
      db.tables.paymentOperations?.push({ ...operation, _id: 'paymentOperations|other', providerReference: 'OTHER' });
    }
    if (race === 'duplicate_digest') {
      db.tables.lencoWebhookInbox?.push({ ...inbox, _id: 'lencoWebhookInbox|other' });
    }
    if (race === 'wallet_kind') {
      operation.kind = 'wallet_purchase';
    }
    const before = money(db);
    await callback(db);
    assert.equal(queue(db).state, 'stopped');
    assert.equal(getJobs(db).length, 0);
    assert.deepEqual(money(db), before);
  });
}

for (const completion of [
  { lookupResult: 'applied' },
  { lookupCompletedAt: 2_000_000_000_000 },
  { lookupCompletedAt: NaN, lookupResult: 'pending' },
  { lookupCompletedAt: 1, lookupResult: 'applied' },
  { lookupCompletedAt: 2_000_000_000_001, lookupResult: 'applied' },
  { lookupCompletedAt: 2_000_000_000_000, lookupResult: 'unknown' },
]) {
  test(`incoherent completion ${JSON.stringify(completion)} cannot claim success`, async (t) => {
    t.mock.method(Date, 'now', () => 2_000_000_000_000);
    const { db, operation } = await prepare();
    await deliver(db, packet(operation));
    Object.assign(row(db, 'lencoWebhookInbox'), completion);
    const before = structuredClone(db.tables);
    await assert.rejects(callback(db), /Invalid inbox lookup completion/);
    assert.deepEqual(db.tables, before);
    assert.equal(getJobs(db).length, 0);
  });
}

for (const result of ['applied', 'review', 'unsupported']) {
  test(`bare ingestion result ${result} and financial manual hold are not acquisition completion`, async (t) => {
    t.mock.method(Date, 'now', () => 2_000_000_000_000);
    const { db, operation } = await prepare();
    await deliver(db, packet(operation));
    row(db, 'lencoWebhookInbox').result = result;
    operation.reviewNeeded = true;
    const before = money(db);
    await callback(db);
    assert.equal(getJobs(db).length, 1);
    assert.equal(queue(db).state, 'active');
    assert.deepEqual(money(db), before);
    const processed = record(await getAction(db, operation));
    assert.equal(processed.application, 'review');
    assert.equal(row(db, 'lencoWebhookInbox').lookupResult, 'review');
  });
}

for (const failure of ['404', '429', '500', 'timeout', 'malformed']) {
  test(`GET ${failure} preserves future acquisition and all funds with only accepted adapter retry`, async (t) => {
    let now = 2_000_000_000_000;
    t.mock.method(Date, 'now', () => now);
    const { db, operation } = await prepare();
    await deliver(db, packet(operation));
    const before = money(db);
    await callback(db);
    let attempts = 0;
    const result = record(
      await getAction(db, operation, 'successful', '0.70', async (_url, init) => {
        assert.equal(init.method, 'GET');
        attempts++;
        if (failure === 'timeout') {
          throw new DOMException('synthetic timeout', 'AbortError');
        }
        if (failure === 'malformed') {
          return envelope({ id: ID });
        }
        return new Response('{}', { status: Number(failure) });
      }),
    );
    assert.equal(result.result, 'unresolved');
    assert.equal(attempts, ['429', '500', 'timeout'].includes(failure) ? 2 : 1);
    assert.equal(row(db, 'lencoWebhookInbox').lookupCompletedAt, undefined);
    assert.deepEqual(money(db), before);
    now += 30_000;
    await callback(db);
    assert.equal(getJobs(db).length, 2);
    assert.equal(queue(db).dispatchedCount, 2);
    assert.deepEqual(money(db), before);
  });
}

for (const boundary of ['query', 'settler', 'lookup_metadata']) {
  test(`actual action ${boundary} throws while precommitted successor still progresses`, async (t) => {
    let now = 2_000_000_000_000;
    t.mock.method(Date, 'now', () => now);
    const { db, operation } = await prepare();
    await deliver(db, packet(operation));
    await callback(db);
    const originalGet = db.get;
    const originalPatch = db.patch;
    const originalInsert = db.insert;
    if (boundary === 'query') {
      t.mock.method(db, 'get', async (id: string) => {
        if (id === row(db, 'lencoWebhookInbox')._id) {
          throw new Error('synthetic query storage failure');
        }
        return await originalGet(id);
      });
    } else if (boundary === 'lookup_metadata') {
      t.mock.method(db, 'patch', async (id: string, fields: Record<string, unknown>) => {
        if ('lookupCompletedAt' in fields) {
          throw new Error('synthetic lookup storage failure');
        }
        await originalPatch(id, fields);
      });
    } else {
      t.mock.method(db, 'patch', async (id: string, fields: Record<string, unknown>) => {
        if (id === operation._id) {
          throw new Error('synthetic settler storage failure');
        }
        await originalPatch(id, fields);
      });
    }
    await assert.rejects(getAction(db, operation), /synthetic .*storage failure/);
    assert.equal(row(db, 'lencoWebhookInbox').lookupCompletedAt, undefined);
    // This fake does not roll back partial mutation writes. Restore the actual
    // external storage boundary; only metadata-after-money is a valid committed
    // runtime failure scenario, and that replay must be exactly once.
    t.mock.restoreAll();
    t.mock.method(Date, 'now', () => now);
    assert.equal(db.get, originalGet);
    assert.equal(db.patch, originalPatch);
    assert.equal(db.insert, originalInsert);
    now += 30_000;
    await callback(db);
    assert.equal(getJobs(db).length, 2);
    if (boundary !== 'settler') {
      const before = structuredClone(db.tables.wallets);
      await getAction(db, operation);
      assert.equal(operation.status, 'succeeded');
      assert.equal(row(db, 'wallets').totalWithdrawn, 25);
      if (boundary === 'lookup_metadata') {
        assert.deepEqual(db.tables.wallets, before);
      }
      now += 30_000;
      await callback(db);
      assert.equal(queue(db).state, 'stopped');
    }
  });
}

for (const boundary of ['insert', 'scheduler', 'job_metadata']) {
  test(`signed ingestion ${boundary} failure returns 500 instead of false ACK`, async (t) => {
    t.mock.method(Date, 'now', () => 2_000_000_000_000);
    const { db, operation } = await prepare();
    if (boundary === 'insert') {
      const insert = db.insert;
      t.mock.method(db, 'insert', async (table: string, fields: Record<string, unknown>) => {
        if (table === 'paymentInboxPolls') {
          throw new Error('synthetic queue storage failure');
        }
        return await insert(table, fields);
      });
    } else if (boundary === 'scheduler') {
      t.mock.method(db.scheduler, 'runAt', async () => {
        throw new Error('synthetic scheduler failure');
      });
    } else {
      const patch = db.patch;
      t.mock.method(db, 'patch', async (id: string, fields: Record<string, unknown>) => {
        if (id.startsWith('paymentInboxPolls|')) {
          throw new Error('synthetic job identity failure');
        }
        await patch(id, fields);
      });
    }
    const before = money(db);
    assert.equal((await deliver(db, packet(operation))).status, 500);
    assert.equal(getJobs(db).length, 0);
    assert.deepEqual(money(db), before);
    // Deliberately no fake rollback assertion: real mutation/job atomicity is
    // SDK/OCC evidence, not modeled by this recorder.
  });
}

for (const boundary of ['successor', 'metadata', 'dispatch']) {
  test(`checkpoint ${boundary} failure propagates and never sends GET ahead of its successor`, async (t) => {
    t.mock.method(Date, 'now', () => 2_000_000_000_000);
    const { db, operation } = await prepare();
    await deliver(db, packet(operation));
    const job = currentJob(db);
    if (boundary === 'successor') {
      t.mock.method(db.scheduler, 'runAt', async () => {
        throw new Error('synthetic successor failure');
      });
    } else if (boundary === 'metadata') {
      const patch = db.patch;
      t.mock.method(db, 'patch', async (id: string, fields: Record<string, unknown>) => {
        if (id === queue(db)._id) {
          throw new Error('synthetic successor metadata failure');
        }
        await patch(id, fields);
      });
    } else {
      t.mock.method(db.scheduler, 'runAfter', async () => {
        assert.equal(queue(db).nextIndex, 1);
        assert.equal(currentJob(db).dueAt, Date.now() + 30_000);
        throw new Error('synthetic dispatch failure');
      });
    }
    const before = money(db);
    await assert.rejects(callback(db, job), /synthetic .*failure/);
    assert.equal(getJobs(db).length, 0);
    assert.deepEqual(money(db), before);
  });
}

test('invalid signature never reaches private ingestion, DB or scheduling', async (t) => {
  t.mock.method(Date, 'now', () => 2_000_000_000_000);
  const { db, operation } = await prepare();
  const before = structuredClone(db.tables);
  const jobs = db.scheduled.length;
  const calls: string[] = [];
  assert.equal((await deliver(db, packet(operation), false, calls)).status, 400);
  assert.deepEqual(calls, []);
  assert.deepEqual(db.tables, before);
  assert.equal(db.scheduled.length, jobs);
});

for (const eligibility of [
  'unmapped',
  'ambiguous_reference',
  'ambiguous_id',
  'wallet',
  'cross_kind',
  'malformed',
  'unhandled',
]) {
  test(`signed ${eligibility} entry has no acquisition authority or intent guess`, async (t) => {
    t.mock.method(Date, 'now', () => 2_000_000_000_000);
    const { db, operation } = await prepare();
    let body = packet(operation);
    if (eligibility === 'unmapped') {
      await db.delete(operation._id);
    }
    if (eligibility === 'ambiguous_reference') {
      db.tables.paymentOperations?.push({ ...operation, _id: 'paymentOperations|other', providerId: undefined });
    }
    if (eligibility === 'ambiguous_id') {
      db.tables.paymentOperations?.push({ ...operation, _id: 'paymentOperations|other', providerReference: 'other' });
    }
    if (eligibility === 'wallet') {
      operation.kind = 'wallet_purchase';
    }
    if (eligibility === 'cross_kind') {
      body = JSON.stringify({ event: 'collection.settled', data: wire(operation) });
    }
    if (eligibility === 'malformed') {
      body = '{invalid';
    }
    if (eligibility === 'unhandled') {
      body = JSON.stringify({ event: 'unhandled', data: wire(operation) });
    }
    const before = money(db);
    assert.equal((await deliver(db, body)).status, 200);
    assert.equal(db.tables.paymentInboxPolls?.length ?? 0, 0);
    assert.equal(getJobs(db).length, 0);
    assert.deepEqual(money(db), before);
  });
}

for (const access of ['banned', 'tombstone', 'missing', 'frozen', 'payments_off']) {
  test(`owed inbox GET survives ${access} and retains unchanged settler beneficiary rules`, async (t) => {
    let now = 2_000_000_000_000;
    t.mock.method(Date, 'now', () => now);
    const { db, operation } = await prepare('topup');
    if (access === 'banned') {
      row(db, 'users').isBanned = true;
    }
    if (access === 'tombstone') {
      Object.assign(row(db, 'users'), { isDeleted: true, deletedAt: now, clerkId: 'deleted:buyer' });
    }
    if (access === 'missing') {
      await db.delete(OWNER);
    }
    if (access === 'frozen') {
      row(db, 'wallets').isFrozen = true;
    }
    if (access === 'payments_off') {
      row(db, 'appConfig').paymentsEnabled = false;
      assert.equal(row(db, 'appConfig').paymentsEnabled, false);
    }
    assert.equal((await deliver(db, packet(operation, 'collection.successful', null))).status, 200);
    await callback(db);
    const processed = record(await getAction(db, operation, 'successful', null));
    assert.equal(processed.result, 'processed');
    assert.equal(processed.application, access === 'missing' ? 'review' : 'applied');
    assert.equal(row(db, 'wallets').balance, access === 'missing' ? 100 : 125);
    now += 30_000;
    await callback(db);
    assert.equal(queue(db).state, 'stopped');
    if (access !== 'missing') {
      assert.equal(operation.reviewNeeded, undefined);
    }
    if (access === 'banned' || access === 'tombstone' || access === 'missing') {
      await assert.rejects(status(db, operation));
    }
  });
}

test('queue expiry allows late already-dispatched GET to settle through original once-only writer', async (t) => {
  let now = 2_000_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { db, operation } = await prepare();
  await deliver(db, packet(operation));
  const origin = now;
  now += 86_400_000;
  await callback(db);
  assert.equal(queue(db).state, 'awaiting_exhaustion');
  const before = money(db);
  now += 60_000;
  await callback(db);
  assert.equal(queue(db).state, 'exhausted');
  assert.deepEqual(money(db), before);
  await getAction(db, operation);
  assert.equal(operation.status, 'succeeded');
  assert.equal(operation.reviewNeeded, undefined);
  assert.equal(row(db, 'wallets').totalWithdrawn, 25);
  const settled = money(db);
  await getAction(db, operation);
  assert.deepEqual(money(db), settled);
  await deliver(db, packet(operation));
  assert.equal(queue(db).origin, origin);
  assert.equal(queue(db).state, 'exhausted');
  assert.equal(getJobs(db).length, 1);
});

for (const race of ['digest', 'classification', 'event', 'operation', 'duplicate_digest']) {
  test(`GET completion race ${race} cannot bind success to changed inbox after real settlement`, async (t) => {
    t.mock.method(Date, 'now', () => 2_000_000_000_000);
    const { db, operation } = await prepare();
    await deliver(db, packet(operation));
    await callback(db);
    const inbox = row(db, 'lencoWebhookInbox');
    await assert.rejects(
      getAction(db, operation, 'successful', '0.70', async (_url, init) => {
        assert.equal(init.method, 'GET');
        if (race === 'digest') {
          inbox.bodyDigest = 'b'.repeat(64);
        }
        if (race === 'classification') {
          inbox.classification = 'terminal';
        }
        if (race === 'event') {
          inbox.eventKind = 'transfer_failed';
        }
        if (race === 'operation') {
          inbox.operationId = 'paymentOperations|foreign';
        }
        if (race === 'duplicate_digest') {
          db.tables.lencoWebhookInbox?.push({ ...inbox, _id: 'lencoWebhookInbox|other' });
        }
        return envelope(wire(operation));
      }),
      /Lookup result mismatch/,
    );
    assert.equal(inbox.lookupCompletedAt, undefined);
    assert.equal(operation.status, 'succeeded', 'owed settlement commits before metadata mismatch');
    assert.equal(row(db, 'wallets').totalWithdrawn, 25);
    assert.equal(getJobs(db).length, 1);
  });
}

for (const elapsed of [86_460_000, 90_000_000]) {
  test(`redelivery of pre-queue inbox after ${elapsed} grace cannot allocate a new budget`, async (t) => {
    let now = 2_000_000_000_000;
    t.mock.method(Date, 'now', () => now);
    const { db, operation } = await prepare();
    const body = packet(operation);
    const origin = now;
    // A legitimate prior-slice inbox with no queue; redelivery is the sole
    // ingestion arm edge, not a historical backfill or a caller time argument.
    await db.insert('lencoWebhookInbox', {
      bodyDigest: createHash('sha256').update(body).digest('hex'),
      eventKind: 'transfer_successful',
      classification: 'lookup_required',
      operationId: operation._id,
      ingestedAt: origin,
    });
    const jobs = db.scheduled.length;
    const before = money(db);
    now += elapsed;
    assert.equal((await deliver(db, body)).status, 200);
    assert.equal(queue(db).origin, origin);
    assert.equal(queue(db).state, 'exhausted');
    assert.equal(db.scheduled.length, jobs);
    assert.equal(queue(db).dispatchedCount, 0);
    assert.deepEqual(money(db), before);
  });
}

test('lookup performed before queue arming is stopped on redelivery without new jobs', async (t) => {
  t.mock.method(Date, 'now', () => 2_000_000_000_000);
  const { db, operation } = await prepare();
  const body = packet(operation);
  const inboxId = await db.insert('lencoWebhookInbox', {
    bodyDigest: createHash('sha256').update(body).digest('hex'),
    eventKind: 'transfer_successful',
    classification: 'lookup_required',
    operationId: operation._id,
    ingestedAt: Date.now(),
  });
  await invokeFakeFunction(
    reconciliation.createReconcileInboxAction({
      env: () => ENV,
      fetchImpl: async (_url, init) => {
        assert.equal(init.method, 'GET');
        return envelope(wire(operation));
      },
    }),
    createFakeActionCtx({ db, subject: null, modules }),
    { inboxId },
  );
  const before = money(db);
  const jobs = db.scheduled.length;
  assert.equal((await deliver(db, body)).status, 200);
  assert.equal(queue(db).state, 'stopped');
  assert.equal(queue(db).dispatchedCount, 0);
  assert.equal(db.scheduled.length, jobs);
  assert.deepEqual(money(db), before);
});

test('completed null-fee GET at final safety stops queue without creating financial review', async (t) => {
  let now = 2_000_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { db, operation } = await prepare('topup', null);
  await deliver(db, packet(operation, 'collection.settled', null));
  now += 86_400_000;
  await callback(db);
  await getAction(db, operation, 'successful', null);
  const before = money(db);
  now += 60_000;
  await callback(db);
  assert.equal(queue(db).state, 'stopped');
  assert.equal(operation.reviewNeeded, undefined);
  assert.deepEqual(money(db), before);
  assert.equal((await status(db, operation)).feeCents, null);
});

test('null fee remains unknown in actual financial summary while queue-only expiry preserves proof', async (t) => {
  let now = 2_000_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { db, operation } = await prepare('topup', null);
  await deliver(db, packet(operation, 'collection.successful', null));
  db.tables.users?.push({ ...row(db, 'users'), _id: 'users|admin', clerkId: 'admin', role: 'admin' });
  const transactions = await import('./transactions');
  const summary = async (): Promise<Record<string, unknown>> =>
    record(
      await invokeFakeFunction(transactions.getPlatformFinancialSummary, createCtx(db, 'admin'), {
        adminId: 'users|admin',
      }),
    );
  const before = await summary();
  assert.equal(before.totalGatewayFees, null);
  assert.equal(record(before.review).unknownFeeOperations, 1);
  const proof = structuredClone(operation.accounting);
  const funds = money(db);
  now += 86_460_000;
  await callback(db);
  assert.equal(queue(db).state, 'exhausted');
  assert.equal(operation.reviewNeeded, undefined);
  assert.deepEqual(operation.accounting, proof);
  assert.deepEqual(money(db), funds);
  assert.deepEqual(await summary(), before);
});

test('signed ACK waits for the actual durable queue job and metadata patch', async (t) => {
  t.mock.method(Date, 'now', () => 2_000_000_000_000);
  const { db, operation } = await prepare();
  let release: () => void = () => {
    throw new Error('missing scheduler barrier');
  };
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: () => void = () => {
    throw new Error('missing entry barrier');
  };
  const entering = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const runAt = db.scheduler.runAt;
  t.mock.method(db.scheduler, 'runAt', async (...args: Parameters<typeof runAt>) => {
    assert.equal(getFunctionName(args[1]), 'paymentInboxPolling:checkpoint');
    assert.equal(row(db, 'lencoWebhookInbox').classification, 'lookup_required');
    entered();
    await barrier;
    return await runAt(...args);
  });
  let acknowledged = false;
  const response = deliver(db, packet(operation)).then((value) => {
    acknowledged = true;
    return value;
  });
  await entering;
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  assert.equal(acknowledged, false);
  assert.equal(queue(db).jobId, undefined, 'scheduler boundary is still pending');
  release();
  assert.equal((await response).status, 200);
  assert.equal(currentJob(db).id, queue(db).jobId);
});

test('duplicate queue identity on signed redelivery returns 500 without scheduling or financial writes', async (t) => {
  t.mock.method(Date, 'now', () => 2_000_000_000_000);
  const { db, operation } = await prepare();
  await deliver(db, packet(operation));
  db.tables.paymentInboxPolls?.push({ ...queue(db), _id: 'paymentInboxPolls|other' });
  const jobs = db.scheduled.length;
  const before = money(db);
  assert.equal((await deliver(db, packet(operation))).status, 500);
  assert.equal(db.scheduled.length, jobs);
  assert.deepEqual(money(db), before);
});

for (const origin of [-1, 0.5, NaN, Number.MAX_SAFE_INTEGER]) {
  test(`invalid original inbox time ${origin} cannot authorize queue or silently ACK`, async (t) => {
    t.mock.method(Date, 'now', () => 2_000_000_000_000);
    const { db, operation } = await prepare();
    const body = packet(operation);
    await db.insert('lencoWebhookInbox', {
      bodyDigest: createHash('sha256').update(body).digest('hex'),
      eventKind: 'transfer_successful',
      classification: 'lookup_required',
      operationId: operation._id,
      ingestedAt: origin,
    });
    const jobs = db.scheduled.length;
    const before = money(db);
    assert.equal((await deliver(db, body)).status, 500);
    assert.equal(db.tables.paymentInboxPolls?.length ?? 0, 0);
    assert.equal(db.scheduled.length, jobs);
    assert.deepEqual(money(db), before);
  });
}

test('new observation after financial engine stopped cannot alter or reopen that financial budget', async (t) => {
  let now = 2_000_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { db, operation } = await prepare('topup', null);
  await deliver(db, packet(operation, 'collection.successful', null));
  now += 30_000;
  const financialJob = db.scheduled.find((job) => job.name === 'paymentPolling:checkpoint');
  assert.ok(financialJob);
  const financialPolling = await import('./paymentPolling');
  await invokeFakeFunction(financialPolling.checkpoint, createCtx(db, null), financialJob.args);
  assert.equal(row(db, 'paymentFinancialPolls').state, 'stopped');
  const financial = structuredClone(db.tables.paymentFinancialPolls);
  const proof = structuredClone(operation.accounting);
  now += 86_400_000;
  assert.equal((await deliver(db, packet(operation, 'collection.settled', '1.20'))).status, 200);
  const newPoll = db.tables.paymentInboxPolls?.[1];
  assert.ok(newPoll);
  const job = db.scheduled.find((entry) => entry.id === newPoll.jobId);
  assert.ok(job);
  assert.equal(newPoll.origin, now);
  await callback(db, job);
  assert.equal(newPoll.dispatchedCount, 1);
  assert.deepEqual(db.tables.paymentFinancialPolls, financial);
  assert.deepEqual(operation.accounting, proof);
  assert.equal(operation.reviewNeeded, undefined);
});
