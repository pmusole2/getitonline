import assert from 'node:assert/strict';
import test from 'node:test';
import { internal } from './_generated/api';
import * as polling from './paymentPolling';
import { armFinancialPolling } from './lib/paymentPolling';
import type { Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import * as reconciliation from './paymentReconciliation';
import * as paymentReconciliationData from './paymentReconciliationData';
import * as providerOperations from './providerOperations';
import * as providerSettlement from './providerSettlement';
import * as checkoutCollection from './checkoutCollection';
import * as checkoutQuote from './checkoutQuote';
import * as paymentOperations from './paymentOperations';
import * as lencoWebhookData from './lencoWebhookData';
import type { LencoFetch } from './lib/lencoAdapter';
import { createFakeActionCtx, invokeFakeFunction } from '../tests/support/convexFakeActionCtx';
import { createCtx, createDb, type Row, type Tables } from '../tests/support/convexFakeDb';

// Registered handlers and real adapter/settler. Only external env/fetch are
// synthetic. This serial fake cannot prove SDK/JWT/OCC/transaction rollback.
const OWNER = 'users|buyer';
const PHONE = '0971234567';
const ID = '22222222-2222-3333-4444-555555555555';
const DEBIT = '11111111-2222-3333-4444-555555555555';
const ENV = { LENCO_API_KEY: 'synthetic-fixture', LENCO_ACCOUNT_ID: DEBIT };
const ADDRESS = { street: 'Test', city: 'Lusaka', province: 'Lusaka', country: 'Zambia', phone: PHONE };
type Db = ReturnType<typeof createDb>;
type Kind = 'topup' | 'mm' | 'bank' | 'checkout' | 'wallet';
type Status = 'successful' | 'failed' | 'pending';

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function row(db: Db, table: string, id?: string): Row {
  const value = db.tables[table]?.find((entry) => id === undefined || entry._id === id);
  assert.ok(value, `${table} row exists`);
  return value;
}

function numeric(value: unknown): number {
  assert.equal(typeof value, 'number');
  return value as number;
}

function string(value: unknown): string {
  assert.equal(typeof value, 'string');
  return value as string;
}

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

function fixture(): Db {
  const tables = checkoutTables();
  tables.users?.push(userRow('users|admin', 'admin', 'admin'));
  tables.wallets = [
    {
      _id: 'wallets|buyer',
      userId: OWNER,
      balance: 1000,
      pendingBalance: 3,
      totalEarned: 7,
      totalSpent: 0,
      totalWithdrawn: 0,
      isActive: true,
      isFrozen: false,
      createdAt: 1,
      updatedAt: 1,
    },
  ];
  tables.paymentAccounts = [
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
  ];
  tables.cartItems = ['lamp', 'cap'].map((product, index) => ({
    _id: `cartItems|line${index}`,
    userId: OWNER,
    productId: `products|${product}`,
    quantity: 1,
    selectedShipping: { name: 'Courier', price: 50 },
    createdAt: 1,
    updatedAt: 1,
  }));
  return createDb(tables);
}

const modules = {
  providerOperations,
  providerSettlement,
  checkoutCollection,
  paymentOperations,
  paymentReconciliation: reconciliation,
  paymentReconciliationData,
  lencoWebhookData,
};

function actionCtx(db: Db, subject: string | null = 'clerk_buyer', calls: string[] = []) {
  return createFakeActionCtx({ db, subject, modules, calls });
}

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ status: true, data }), { status: 200 });
}

function wire(operation: Row, status: Status = 'successful', fee: string | null = '0.70'): Record<string, unknown> {
  const common = {
    id: ID,
    reference: operation.providerReference,
    amount: String(numeric(operation.amountCents) / 100),
    currency: 'ZMW',
    status,
    fee,
    reasonForFailure: null,
    settlementStatus: null,
  };
  return operation.kind === 'withdrawal_transfer'
    ? {
        ...common,
        accountId: DEBIT,
        creditAccount:
          operation.paymentAccountId === 'paymentAccounts|bank'
            ? { type: 'bank-account', accountNumber: '123', bank: { id: 'bank-1', country: 'zm' } }
            : { type: 'mobile-money', phone: PHONE, operator: 'mtn' },
      }
    : {
        ...common,
        type: 'mobile-money',
        bearer: 'merchant',
        mobileMoneyDetails: { country: 'zm', phone: PHONE, operator: 'mtn' },
      };
}

async function prepare(
  kind: Kind = 'topup',
  bound = false,
  setup?: (db: Db) => void,
  onPost?: () => void,
): Promise<{ db: Db; operation: Row }> {
  const db = fixture();
  setup?.(db);
  const fetchImpl: LencoFetch = async (_url, init) => {
    assert.equal(init.method, 'POST');
    onPost?.();
    assert.equal(db.scheduled.length, 1, 'first checkpoint exists before POST');
    assert.equal(db.tables.paymentFinancialPolls?.length, 1);
    assert.equal(db.scheduled[0]?.dueAt, numeric(row(db, 'paymentOperations').attemptedAt) + 30_000);
    if (!bound) {
      throw new Error('synthetic ambiguous POST');
    }
    const body = record(JSON.parse(string(init.body)));
    const op: Row = {
      _id: 'synthetic',
      amountCents: numeric(body.amount) * 100,
      providerReference: body.reference,
      kind: kind === 'mm' || kind === 'bank' ? 'withdrawal_transfer' : 'top_up_collection',
      paymentAccountId: kind === 'bank' ? 'paymentAccounts|bank' : 'paymentAccounts|mm',
    };
    const data = wire(op, 'pending');
    if (kind === 'mm') {
      record(data.creditAccount).country = 'zm';
    }
    return envelope(data);
  };
  if (kind === 'checkout' || kind === 'wallet') {
    const selectors = {
      source: 'cart',
      deliveryMethodId: 'deliveryMethods|m1',
      shippingAddress: ADDRESS,
      promoCode: 'SAVE10',
      loyaltyPoints: 20,
    };
    const quoted = record(
      await invokeFakeFunction(checkoutQuote.quoteCheckout, createCtx(db, 'clerk_buyer'), selectors),
    );
    assert.equal(quoted.ok, true);
    const input = { ...selectors, requestId: 'recover-request', expectedQuoteKey: record(quoted.quote).quoteKey };
    const result = record(
      await invokeFakeFunction(
        kind === 'wallet'
          ? paymentOperations.purchaseWithWallet
          : checkoutCollection.createCheckoutCollectionAction({ env: () => ENV, fetchImpl }),
        kind === 'wallet' ? createCtx(db, 'clerk_buyer') : actionCtx(db),
        kind === 'wallet' ? input : { ...input, phone: PHONE, operator: 'mtn' },
      ),
    );
    assert.equal(result.ok, true);
  } else {
    const fn =
      kind === 'topup'
        ? providerOperations.createTopUpAction({ env: () => ENV, fetchImpl })
        : providerOperations.createWithdrawalAction({ env: () => ENV, fetchImpl });
    await invokeFakeFunction(
      fn,
      actionCtx(db),
      kind === 'topup'
        ? { requestId: 'recover-request', amountCents: 2500, phone: PHONE, operator: 'mtn' }
        : {
            requestId: 'recover-request',
            amountCents: 2500,
            paymentAccountId: `paymentAccounts|${kind}`,
            expectedDestinationKey: kind === 'mm' ? `mm:zm:mtn:${PHONE}` : 'bank:zm:bank-1:123',
          },
    );
  }
  return { db, operation: row(db, 'paymentOperations') };
}

for (const kind of ['topup', 'mm', 'bank', 'checkout', 'wallet'] as const) {
  test(`${kind}: atomic claim arms durable polling before POST, wallet purchase has no poll`, async () => {
    const { db, operation } = await prepare(kind);
    if (kind === 'wallet') {
      assert.equal(db.scheduled.length, 0);
      assert.equal((db.tables.paymentFinancialPolls ?? []).length, 0);
      return;
    }
    assert.equal(db.scheduled.length, 1);
    assert.equal(db.scheduled[0]?.name, 'paymentPolling:checkpoint');
    assert.equal(db.scheduled[0]?.dueAt, numeric(operation.attemptedAt) + 30_000);
    assert.equal(db.tables.paymentFinancialPolls?.length, 1);
  });
}

function poll(db: Db): Row {
  return row(db, 'paymentFinancialPolls');
}

function currentJob(db: Db) {
  const job = db.scheduled.find((entry) => entry.id === poll(db).jobId);
  assert.ok(job);
  return job;
}

function getJobs(db: Db) {
  return db.scheduled.filter((job) => job.name === 'paymentReconciliation:reconcileStoredOperation');
}

async function callback(db: Db, job = currentJob(db)): Promise<unknown> {
  assert.equal(job.cancelled, false);
  assert.ok(job.dueAt <= Date.now(), 'execute only eligible recorded jobs');
  const fn = job.name === 'paymentPolling:checkpoint' ? polling.checkpoint : polling.exhaustion;
  return await invokeFakeFunction(fn, createCtx(db, null), job.args);
}

async function getAction(db: Db, operation: Row, status: Status = 'successful', fee: string | null = '0.70') {
  const job = getJobs(db).at(-1);
  assert.ok(job);
  assert.deepEqual(job.args, { operationId: operation._id });
  return await invokeFakeFunction(
    reconciliation.createReconcileOperationAction({
      env: () => ENV,
      fetchImpl: async (_url, init) => {
        assert.equal(init.method, 'GET');
        return envelope(wire(operation, status, fee));
      },
    }),
    actionCtx(db, null),
    job.args,
  );
}

function reservedSnapshot(db: Db) {
  const { paymentOperations: _operations, paymentFinancialPolls: _polls, ...business } = db.tables;
  return structuredClone(business);
}

const OFFSETS = [
  30_000,
  60_000,
  120_000,
  300_000,
  900_000,
  1_800_000,
  ...Array.from({ length: 24 }, (_, index) => (index + 1) * 3_600_000),
];

for (const kind of ['topup', 'mm', 'bank', 'checkout'] as const) {
  test(`${kind}: thirty fixed due callbacks survive every dropped GET and exhaust with reservations retained`, async (t) => {
    let now = 2_000_000_000_000;
    t.mock.method(Date, 'now', () => now);
    const { db, operation } = await prepare(kind);
    const origin = numeric(operation.attemptedAt);
    const reserved = reservedSnapshot(db);
    const intent = structuredClone(operation);
    const replay = currentJob(db);
    for (const [index, offset] of OFFSETS.entries()) {
      now = origin + offset;
      const job = currentJob(db);
      assert.equal(job.dueAt, now);
      assert.equal(job.args.index, index);
      const before = db.scheduled.length;
      await callback(db, job);
      assert.equal(
        db.scheduled[before]?.name,
        index === 29 ? 'paymentPolling:exhaustion' : 'paymentPolling:checkpoint',
      );
      assert.equal(db.scheduled[before + 1]?.name, 'paymentReconciliation:reconcileStoredOperation');
      assert.equal(poll(db).dispatchedCount, index + 1);
      await callback(db, job);
      await callback(db, replay);
      assert.equal(getJobs(db).length, index + 1, 'duplicate/stale callbacks cannot dispatch');
    }
    assert.equal(currentJob(db).dueAt, origin + 86_460_000);
    assert.equal(poll(db).state, 'awaiting_exhaustion');
    now = origin + 86_459_999;
    await invokeFakeFunction(polling.exhaustion, createCtx(db, null), currentJob(db).args);
    assert.equal(operation.reviewNeeded, undefined);
    now += 1;
    await callback(db);
    assert.equal(poll(db).state, 'exhausted');
    assert.equal(operation.reviewNeeded, true);
    assert.deepEqual(reservedSnapshot(db), reserved);
    assert.deepEqual(operation, { ...intent, reviewNeeded: true });
    const exhausted = structuredClone(db.tables);
    await callback(db);
    assert.deepEqual(db.tables, exhausted);
    assert.equal(getJobs(db).length, 30);
    assert.equal(record(operation).attemptedAt, origin);
  });
}

for (const kind of ['topup', 'mm', 'bank', 'checkout'] as const) {
  for (const status of ['successful', 'failed'] as const) {
    test(`${kind}/${status}: real actor-free GET settles once, next callback positively stops`, async (t) => {
      let now = 2_000_000_000_000;
      t.mock.method(Date, 'now', () => now);
      const { db, operation } = await prepare(kind);
      row(db, 'appConfig').paymentsEnabled = false;
      assert.equal(row(db, 'appConfig').paymentsEnabled, false);
      row(db, 'users', OWNER).isBanned = true;
      row(db, 'wallets').isFrozen = true;
      row(db, 'wallets').isActive = false;
      now += 30_000;
      await callback(db);
      const result = record(await getAction(db, operation, status));
      assert.equal(result.application, 'applied');
      const settled = reservedSnapshot(db);
      const proof = structuredClone(operation.accounting);
      await getAction(db, operation, status);
      assert.deepEqual(reservedSnapshot(db), settled);
      assert.deepEqual(operation.accounting, proof);
      now += 30_000;
      await callback(db);
      assert.equal(poll(db).state, 'stopped');
      assert.equal(getJobs(db).length, 1);
      assert.notEqual(operation.reviewNeeded, true);
      if (kind === 'topup') {
        assert.equal(row(db, 'wallets').balance, status === 'successful' ? 1025 : 1000);
      } else if (kind !== 'checkout') {
        assert.equal(row(db, 'wallets').balance, status === 'successful' ? 975 : 1000);
        assert.equal(row(db, 'wallets').totalWithdrawn, status === 'successful' ? 25 : 0);
      } else {
        assert.equal(db.tables.escrow?.length ?? 0, status === 'successful' ? 2 : 0);
        assert.equal(row(db, 'products', 'products|lamp').quantity, status === 'successful' ? 9 : 10);
        assert.equal(row(db, 'loyaltyAccounts').lifetimeRedeemed, status === 'successful' ? 20 : 0);
      }
    });
  }
}

for (const delay of [90_000, 3_600_000, 86_400_000, 86_459_999, 86_460_000, 90_000_000]) {
  test(`late first checkpoint at ${delay} skips missed offsets, respects fixed grace`, async (t) => {
    let now = 2_000_000_000_000;
    t.mock.method(Date, 'now', () => now);
    const { db, operation } = await prepare('mm');
    const origin = now;
    now += delay;
    await callback(db);
    if (delay >= 86_460_000) {
      assert.equal(getJobs(db).length, 0);
      assert.equal(operation.reviewNeeded, true);
      assert.equal(poll(db).state, 'exhausted');
    } else {
      assert.equal(getJobs(db).length, 1);
      const next = OFFSETS.find((offset) => offset > delay) ?? 86_460_000;
      assert.equal(currentJob(db).dueAt, origin + next);
      assert.equal(poll(db).dispatchedCount, 1);
    }
    assert.equal(record(operation).attemptedAt, origin);
    assert.equal(row(db, 'wallets').balance, 975);
  });
}

for (const alteration of [
  { generation: 2 },
  { index: 1 },
  { index: -1 },
  { index: 0.5 },
  { index: NaN },
  { operationId: 'paymentOperations|foreign' },
  { pollId: 'paymentFinancialPolls|foreign' },
]) {
  test(`stale/foreign/invalid callback ${JSON.stringify(alteration)} cannot consume budget`, async (t) => {
    let now = 2_000_000_000_000;
    t.mock.method(Date, 'now', () => now);
    const { db } = await prepare();
    const job = currentJob(db);
    const before = structuredClone(db.tables);
    await invokeFakeFunction(polling.checkpoint, createCtx(db, null), job.args);
    assert.deepEqual(db.tables, before, 'early call has no writes');
    now += 30_000;
    await invokeFakeFunction(polling.checkpoint, createCtx(db, null), { ...job.args, ...alteration });
    assert.deepEqual(db.tables, before);
    assert.equal(getJobs(db).length, 0);
  });
}

for (const alteration of [
  { origin: -1 },
  { origin: 2_000_000_000_001 },
  { nextIndex: 0.5 },
  { dispatchedCount: 31 },
  { dueAt: 2_000_000_030_001 },
  { state: 'unknown' },
  { generation: 2 },
  { jobId: null },
]) {
  test(`malformed durable state ${JSON.stringify(alteration)} fails closed`, async (t) => {
    let now = 2_000_000_000_000;
    t.mock.method(Date, 'now', () => now);
    const { db } = await prepare();
    const job = currentJob(db);
    Object.assign(poll(db), alteration);
    now += 30_000;
    await assert.rejects(() => callback(db, job), /Invalid financial poll state/);
    assert.equal(getJobs(db).length, 0);
  });
}

test('duplicate indexed poll state fails closed rather than choosing first', async (t) => {
  let now = 2_000_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { db } = await prepare();
  db.tables.paymentFinancialPolls?.push({ ...poll(db), _id: 'paymentFinancialPolls|duplicate' });
  now += 30_000;
  await assert.rejects(() => callback(db), /Invalid financial poll state/);
  assert.equal(getJobs(db).length, 0);
});

for (const kind of ['topup', 'mm', 'bank', 'checkout'] as const) {
  for (const failure of ['schedule', 'persist'] as const) {
    test(`${kind}: ${failure} failure propagates from claim with zero POST authorization`, async (t) => {
      let posts = 0;
      let observed: Db | undefined;
      await assert.rejects(
        () =>
          prepare(
            kind,
            false,
            (db) => {
              observed = db;
              if (failure === 'schedule') {
                t.mock.method(db.scheduler, 'runAt', async () => {
                  throw new Error('synthetic schedule failure');
                });
              } else {
                const insert = db.insert;
                t.mock.method(db, 'insert', async (table: string, value: Record<string, unknown>) => {
                  if (table === 'paymentFinancialPolls') {
                    throw new Error('synthetic persist failure');
                  }
                  return await insert(table, value);
                });
              }
            },
            () => {
              posts += 1;
            },
          ),
        /synthetic (schedule|persist) failure/,
      );
      assert.equal(posts, 0);
      assert.ok(observed);
      assert.equal(getJobs(observed).length, 0);
      // Partial business writes in this serial fake are NOT rollback evidence.
    });
  }
}

for (const failure of ['successor', 'metadata', 'dispatch'] as const) {
  test(`checkpoint ${failure} failure propagates, GET never precedes durable successor`, async (t) => {
    let now = 2_000_000_000_000;
    t.mock.method(Date, 'now', () => now);
    const { db } = await prepare();
    const original = currentJob(db);
    now += 30_000;
    if (failure === 'successor') {
      t.mock.method(db.scheduler, 'runAt', async () => {
        throw new Error('synthetic successor failure');
      });
    } else if (failure === 'metadata') {
      const patch = db.patch;
      t.mock.method(db, 'patch', async (id: string, fields: Record<string, unknown>) => {
        if (id === poll(db)._id) {
          throw new Error('synthetic metadata failure');
        }
        await patch(id, fields);
      });
    } else {
      t.mock.method(db.scheduler, 'runAfter', async () => {
        assert.equal(currentJob(db).dueAt, now + 30_000);
        assert.equal(poll(db).nextIndex, 1);
        throw new Error('synthetic dispatch failure');
      });
    }
    await assert.rejects(() => callback(db, original), /synthetic .* failure/);
    assert.equal(getJobs(db).length, 0);
  });
}

for (const kind of ['topup', 'mm', 'bank', 'checkout'] as const) {
  test(`${kind}: final GET completed within fixed grace stops safety without review`, async (t) => {
    let now = 2_000_000_000_000;
    t.mock.method(Date, 'now', () => now);
    const { db, operation } = await prepare(kind);
    const origin = now;
    now += 86_400_000;
    await callback(db);
    assert.equal(currentJob(db).name, 'paymentPolling:exhaustion');
    assert.equal(currentJob(db).dueAt, origin + 86_460_000);
    now += 40_000;
    assert.equal(record(await getAction(db, operation)).application, 'applied');
    const money = reservedSnapshot(db);
    const proof = structuredClone(operation.accounting);
    now = origin + 86_460_000;
    await callback(db);
    assert.equal(poll(db).state, 'stopped');
    assert.notEqual(operation.reviewNeeded, true);
    assert.deepEqual(reservedSnapshot(db), money);
    assert.deepEqual(operation.accounting, proof);
  });

  test(`${kind}: valid receipt after exhaustion retains sticky hold and every reservation`, async (t) => {
    let now = 2_000_000_000_000;
    t.mock.method(Date, 'now', () => now);
    const { db, operation } = await prepare(kind);
    const reserved = reservedSnapshot(db);
    now += 86_400_000;
    await callback(db);
    now += 60_000;
    await callback(db);
    assert.equal(record(await getAction(db, operation)).application, 'review');
    assert.equal(operation.reviewNeeded, true);
    assert.equal(operation.accounting, undefined);
    assert.deepEqual(reservedSnapshot(db), reserved);
    assert.equal(poll(db).state, 'exhausted');
  });
}

for (const response of ['pending', '404', '500', 'malformed', 'throw'] as const) {
  test(`real final GET ${response} cannot lose exhaustion or release reserved withdrawal`, async (t) => {
    let now = 2_000_000_000_000;
    t.mock.method(Date, 'now', () => now);
    const { db, operation } = await prepare('mm');
    const reserved = reservedSnapshot(db);
    now += 86_400_000;
    await callback(db);
    let attempts = 0;
    const action = reconciliation.createReconcileOperationAction({
      env: () => ENV,
      fetchImpl: async (_url, init) => {
        assert.equal(init.method, 'GET');
        attempts += 1;
        if (response === 'throw') {
          throw new Error('synthetic transport loss');
        }
        if (response === '404' || response === '500') {
          return new Response('{}', { status: Number(response) });
        }
        return envelope(response === 'malformed' ? { status: 'successful' } : wire(operation, 'pending'));
      },
    });
    await invokeFakeFunction(action, actionCtx(db, null), getJobs(db)[0]?.args);
    assert.ok(attempts >= 1 && attempts <= 2, 'only accepted adapter retry budget');
    assert.deepEqual(reservedSnapshot(db), reserved);
    now += 60_000;
    await callback(db);
    assert.equal(operation.reviewNeeded, true);
    assert.deepEqual(reservedSnapshot(db), reserved);
    assert.equal(getJobs(db).length, 1);
  });
}

test('actual action storage throw leaves the final safety independently recorded', async (t) => {
  let now = 2_000_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { db, operation } = await prepare('mm');
  now += 86_400_000;
  await callback(db);
  const get = db.get;
  const trap = t.mock.method(db, 'get', async () => {
    throw new Error('synthetic GET storage failure');
  });
  await assert.rejects(() => getAction(db, operation), /synthetic GET storage failure/);
  trap.mock.restore();
  assert.equal(db.get, get);
  now += 60_000;
  await callback(db);
  assert.equal(poll(db).state, 'exhausted');
  assert.equal(row(db, 'wallets').balance, 975);
});

for (const state of ['succeeded', 'failed', 'corrupt-proof', 'review'] as const) {
  test(`unproved ${state} never masquerades as positive financial completion`, async (t) => {
    let now = 2_000_000_000_000;
    t.mock.method(Date, 'now', () => now);
    const { db, operation } = await prepare();
    if (state === 'corrupt-proof') {
      operation.accounting = { kind: 'top_up_credited' };
    } else if (state === 'review') {
      operation.reviewNeeded = true;
    } else {
      operation.status = state;
    }
    const before = structuredClone(operation);
    now += 30_000;
    await callback(db);
    assert.deepEqual(operation, before);
    assert.equal(poll(db).state, state === 'review' ? 'stopped' : 'active');
    assert.equal(getJobs(db).length, state === 'review' ? 0 : 1);
  });
}

for (const fee of [null, '0.00', '0.70'] as const) {
  test(`positive financial proof with original fee ${fee} stops independently of missing/conflicting cost`, async (t) => {
    let now = 2_000_000_000_000;
    t.mock.method(Date, 'now', () => now);
    const { db, operation } = await prepare();
    // Owner/webhook-equivalent accepted writer completed before the scheduled callback.
    const before = db.scheduled.length;
    const action = reconciliation.createReconcileOperationAction({
      env: () => ENV,
      fetchImpl: async () => envelope(wire(operation, 'successful', fee)),
    });
    await invokeFakeFunction(action, actionCtx(db, null), { operationId: operation._id });
    const proof = structuredClone(operation.accounting);
    await invokeFakeFunction(
      reconciliation.createReconcileOperationAction({
        env: () => ENV,
        fetchImpl: async () => envelope(wire(operation, 'successful', '0.80')),
      }),
      actionCtx(db, null),
      { operationId: operation._id },
    );
    assert.notEqual(operation.reviewNeeded, true);
    now += 30_000;
    await callback(db);
    assert.equal(poll(db).state, 'stopped');
    assert.equal(db.scheduled.length, before);
    assert.notEqual(operation.reviewNeeded, true);
    assert.deepEqual(operation.accounting, proof);
    assert.equal(row(db, 'wallets').balance, 1025);
  });
}

test('proof read failures propagate rather than being declared applied', async (t) => {
  let now = 2_000_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { db, operation } = await prepare();
  await invokeFakeFunction(
    reconciliation.createReconcileOperationAction({
      env: () => ENV,
      fetchImpl: async () => envelope(wire(operation)),
    }),
    actionCtx(db, null),
    { operationId: operation._id },
  );
  const get = db.get;
  t.mock.method(db, 'get', async (id: string) => {
    if (id === 'wallets|buyer') {
      throw new Error('synthetic proof storage failure');
    }
    return await get(id);
  });
  now += 30_000;
  await assert.rejects(() => callback(db), /synthetic proof storage failure/);
  assert.equal(poll(db).state, 'active');
  assert.equal(getJobs(db).length, 0);
});

test('same request after lost response never reenrolls, resets origin or POSTs', async (t) => {
  let now = 2_000_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { db, operation } = await prepare();
  const origin = operation.attemptedAt;
  const snapshot = structuredClone(db.tables);
  now += 10_000;
  const repeated = record(
    await invokeFakeFunction(
      providerOperations.createTopUpAction({
        env: () => ENV,
        fetchImpl: async () => {
          throw new Error('must not POST on reuse');
        },
      }),
      actionCtx(db),
      { requestId: 'recover-request', amountCents: 2500, phone: PHONE, operator: 'mtn' },
    ),
  );
  assert.equal(repeated.ok, true);
  assert.equal(repeated.operationId, operation._id);
  assert.deepEqual(db.tables, snapshot);
  assert.equal(db.scheduled.length, 1);
  assert.equal(record(operation).attemptedAt, origin);
  await assert.rejects(
    () => armFinancialPolling(createCtx(db, null) as unknown as MutationCtx, operation._id as Id<'paymentOperations'>),
    /Invalid financial poll claim|already armed/,
  );
});

test('physically missing beneficiary reaches unchanged settler manual hold through actor-free GET', async (t) => {
  let now = 2_000_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { db, operation } = await prepare();
  await db.delete(OWNER);
  row(db, 'wallets').isFrozen = true;
  row(db, 'appConfig').paymentsEnabled = false;
  assert.equal(row(db, 'appConfig').paymentsEnabled, false);
  now += 30_000;
  await callback(db);
  assert.equal(record(await getAction(db, operation)).application, 'review');
  assert.equal(row(db, 'wallets').balance, 1000);
  assert.equal(operation.reviewNeeded, true);
  now += 30_000;
  await callback(db);
  assert.equal(poll(db).state, 'stopped');
});

test('recorded scheduler retains target identity, copied args, relative due time and cancellation outside tables', async (t) => {
  t.mock.method(Date, 'now', () => 2_000_000_000_000);
  const db = createDb({});
  const args = { operationId: 'paymentOperations|1', nested: { index: 0 } };
  const target = internal.paymentReconciliation.reconcileStoredOperation;
  const id = await createCtx(db, null).scheduler.runAfter(60_000, target, args);
  args.nested.index = 9;
  assert.equal(db.scheduled[0]?.target, target);
  assert.equal(db.scheduled[0]?.dueAt, Date.now() + 60_000);
  assert.deepEqual(db.scheduled[0]?.args.nested, { index: 0 });
  await db.scheduler.cancel(id);
  assert.equal(db.scheduled[0]?.cancelled, true);
  assert.deepEqual(db.tables, {});
});

test('tombstoned owner with existing wallet receives owed settlement through unchanged beneficiary policy', async (t) => {
  let now = 2_000_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { db, operation } = await prepare();
  Object.assign(row(db, 'users', OWNER), { isDeleted: true, deletedAt: now, clerkId: 'deleted:clerk_buyer' });
  now += 30_000;
  await callback(db);
  assert.equal(record(await getAction(db, operation)).application, 'applied');
  assert.equal(row(db, 'wallets').balance, 1025);
});

test('sticky actual review stops without unnecessary proof reads or new GET', async (t) => {
  let now = 2_000_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { db, operation } = await prepare();
  await invokeFakeFunction(
    reconciliation.createReconcileOperationAction({
      env: () => ENV,
      fetchImpl: async () => envelope(wire(operation)),
    }),
    actionCtx(db, null),
    { operationId: operation._id },
  );
  operation.reviewNeeded = true;
  const get = db.get;
  t.mock.method(db, 'get', async (id: string) => {
    if (id === 'wallets|buyer') {
      throw new Error('must not reprocess sticky review');
    }
    return await get(id);
  });
  now += 30_000;
  await callback(db);
  assert.equal(poll(db).state, 'stopped');
  assert.equal(operation.reviewNeeded, true);
  assert.equal(getJobs(db).length, 0);
});

for (const beforeDeadline of [false, true]) {
  test(`actual signed-webhook settler before ${beforeDeadline ? 'exhaustion' : 'checkpoint'} positively stops polling`, async (t) => {
    let now = 2_000_000_000_000;
    t.mock.method(Date, 'now', () => now);
    const { db, operation } = await prepare('topup', true);
    if (beforeDeadline) {
      now += 86_400_000;
      await callback(db);
    }
    const receipt = { ...record(operation.receipt), status: 'successful', feeMinor: null };
    const settled = record(
      await invokeFakeFunction(providerSettlement.settleProviderReceipt, createCtx(db, null), {
        operationId: operation._id,
        receipt,
        acquisition: { kind: 'signed_webhook', eventId: 'synthetic-signed' },
      }),
    );
    assert.equal(settled.application, 'applied');
    const proof = structuredClone(operation.accounting);
    now += beforeDeadline ? 60_000 : 30_000;
    await callback(db);
    assert.equal(poll(db).state, 'stopped');
    assert.notEqual(operation.reviewNeeded, true);
    assert.equal(row(db, 'wallets').balance, 1025);
    assert.deepEqual(operation.accounting, proof);
    assert.equal(getJobs(db).length, beforeDeadline ? 1 : 0);
  });
}

for (const kind of ['mm', 'bank', 'checkout'] as const) {
  test(`${kind}: repeated request and lost response keep one poll, one origin and no second POST`, async (t) => {
    let now = 2_000_000_000_000;
    t.mock.method(Date, 'now', () => now);
    const { db, operation } = await prepare(kind);
    const before = structuredClone(db.tables);
    const job = currentJob(db);
    now += 10_000;
    const deps = {
      env: () => ENV,
      fetchImpl: async () => {
        throw new Error('must not POST on reuse');
      },
    };
    const args =
      kind === 'checkout'
        ? {
            source: 'cart',
            deliveryMethodId: 'deliveryMethods|m1',
            shippingAddress: ADDRESS,
            promoCode: 'SAVE10',
            loyaltyPoints: 20,
            requestId: 'recover-request',
            expectedQuoteKey: operation.quoteKey,
            phone: PHONE,
            operator: 'mtn',
          }
        : {
            requestId: 'recover-request',
            amountCents: 2500,
            paymentAccountId: `paymentAccounts|${kind}`,
            expectedDestinationKey: kind === 'mm' ? `mm:zm:mtn:${PHONE}` : 'bank:zm:bank-1:123',
          };
    const result = record(
      await invokeFakeFunction(
        kind === 'checkout'
          ? checkoutCollection.createCheckoutCollectionAction(deps)
          : providerOperations.createWithdrawalAction(deps),
        actionCtx(db),
        args,
      ),
    );
    assert.equal(result.ok, true);
    assert.equal(result.operationId, operation._id);
    assert.deepEqual(db.tables, before);
    assert.equal(db.scheduled.length, 1);
    assert.equal(currentJob(db), job);
  });
}

test('already enrolled attempted operation cannot rearm or adopt ambiguous rows', async () => {
  const { db, operation } = await prepare();
  operation.status = 'attempted';
  const before = structuredClone(db.tables);
  await assert.rejects(
    () => armFinancialPolling(createCtx(db, null) as unknown as MutationCtx, operation._id as Id<'paymentOperations'>),
    /already armed/,
  );
  assert.deepEqual(db.tables, before);
  assert.equal(db.scheduled.length, 1);
});
