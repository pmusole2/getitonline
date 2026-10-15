import assert from 'node:assert/strict';
import test from 'node:test';

import { ConvexError, v, type Value } from 'convex/values';

import * as providerOperations from './providerOperations';
import * as providerSettlement from './providerSettlement';
import {
  createListBanksAction,
  createRegisterAccountAction,
  createTopUpAction,
  createWithdrawalAction,
} from './providerOperations';
import { majorNumberToCents } from './lib/catalogMoney';
import type { LencoFetch } from './lib/lencoAdapter';
import { createFakeActionCtx, invokeFakeFunction, type FakeModules } from '../tests/support/convexFakeActionCtx';
import { createCtx, createDb, handlerOf, type Db, type Row, type Tables } from '../tests/support/convexFakeDb';
import * as walletOperations from './paymentOperations';
import * as checkoutQuote from './checkoutQuote';
import { buildWithdrawalRequestIdentity, providerReceiptValidator } from './lib/providerOperationContracts';
import { internalMutation } from './_generated/server';
import {
  receiptAcquisitionValidator,
  settlementResultValidator,
  type SettlementResult,
} from './lib/providerSettlementContracts';

// Real-handler provider-initiation checks through the registered actions and
// internal mutations. Transport is intercepted at the adapter fetch
// boundary only: persistence, claim, debit, and attachment all run for real,
// and the oracle inspects the database at fetch time. The fake cannot prove
// live OCC rollback, so every denial is asserted with unchanged tables.

const DEBIT_UUID = '11111111-2222-3333-4444-555555555555';
const COLLECTION_ID = '22222222-2222-3333-4444-555555555555';
const TRANSFER_ID = '33333333-2222-3333-4444-555555555555';

const ENV: Record<string, string | undefined> = {
  LENCO_API_KEY: 'sk-test-key-value',
  LENCO_ACCOUNT_ID: DEBIT_UUID,
};

const PHONE = '0971234567';
const MM_KEY = 'mm:zm:mtn:0971234567';
const BANK_KEY = 'bank:zm:bank-1:1234567890';

const ADDRESS = {
  street: '123 Main',
  city: 'Lusaka',
  province: 'Lusaka',
  country: 'Zambia',
  phone: '0971234567',
};

type FetchCall = { url: string; method: string; body: Value | null };

type FakeBehavior = {
  collections?: (call: FetchCall) => Response;
  transfersMm?: (call: FetchCall) => Response;
  transfersBank?: (call: FetchCall) => Response;
  onFetch?: (call: FetchCall, db: Db) => void;
};

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ status: true, data }), { status: 200 });
}

function majorText(amountMajor: number): string {
  return String(amountMajor);
}

function bodyOf(call: FetchCall): Record<string, Value> {
  return (call.body ?? {}) as Record<string, Value>;
}

function createFetch(behavior: FakeBehavior, calls: FetchCall[], db: Db): LencoFetch {
  return (async (url: string, init: { method: string; body?: string }): Promise<Response> => {
    let body: Value | null = null;
    if (init.body !== undefined) {
      body = JSON.parse(init.body) as Value;
    }
    const call: FetchCall = { url, method: init.method, body };
    calls.push(call);
    if (behavior.onFetch !== undefined) {
      behavior.onFetch(call, db);
    }
    if (url.endsWith('/collections/mobile-money')) {
      if (behavior.collections !== undefined) {
        return behavior.collections(call);
      }
      const args = bodyOf(call);
      return envelope({
        id: COLLECTION_ID,
        reference: args['reference'],
        amount: majorText(args['amount'] as number),
        currency: 'ZMW',
        status: 'pending',
        type: 'mobile-money',
        bearer: 'merchant',
        mobileMoneyDetails: { country: 'zm', operator: args['operator'], phone: args['phone'] },
        reasonForFailure: null,
        settlementStatus: null,
      });
    }
    if (url.endsWith('/transfers/mobile-money')) {
      if (behavior.transfersMm !== undefined) {
        return behavior.transfersMm(call);
      }
      const args = bodyOf(call);
      return envelope({
        id: TRANSFER_ID,
        reference: args['reference'],
        amount: majorText(args['amount'] as number),
        fee: '0.50',
        currency: 'ZMW',
        status: 'pending',
        accountId: args['accountId'],
        creditAccount: {
          type: 'mobile-money',
          country: 'zm',
          operator: args['operator'],
          phone: args['phone'],
        },
        reasonForFailure: null,
        settlementStatus: null,
      });
    }
    if (url.endsWith('/transfers/bank-account')) {
      if (behavior.transfersBank !== undefined) {
        return behavior.transfersBank(call);
      }
      const args = bodyOf(call);
      return envelope({
        id: TRANSFER_ID,
        reference: args['reference'],
        amount: majorText(args['amount'] as number),
        fee: '1.00',
        currency: 'ZMW',
        status: 'pending',
        accountId: args['accountId'],
        creditAccount: {
          type: 'bank-account',
          accountNumber: args['accountNumber'],
          bank: { id: args['bankId'], name: 'Test Bank', country: 'zm' },
        },
        reasonForFailure: null,
        settlementStatus: null,
      });
    }
    if (url.endsWith('/resolve/mobile-money')) {
      const args = bodyOf(call);
      return envelope({
        type: 'mobile-money',
        country: 'zm',
        phone: args['phone'],
        operator: args['operator'],
        accountName: 'Test User',
      });
    }
    if (url.endsWith('/resolve/bank-account')) {
      const args = bodyOf(call);
      return envelope({
        type: 'bank-account',
        accountNumber: args['accountNumber'],
        bank: { id: args['bankId'], name: 'Test Bank', country: 'zm' },
        accountName: 'Test User',
      });
    }
    if (url.includes('/banks?country=zm')) {
      return envelope([
        { id: 'bank-1', name: 'Test Bank', country: 'zm' },
        { id: 'bank-2', name: 'Second Bank', country: 'zm' },
      ]);
    }
    throw new Error(`unexpected provider url ${url}`);
  }) as LencoFetch;
}

function userRow(id: string, clerkId: string, role: string): Row {
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
  };
}

function walletRow(userId: string): Row {
  return {
    _id: `wallets|${userId}`,
    userId,
    balance: 1000,
    pendingBalance: 0,
    totalEarned: 1000,
    totalWithdrawn: 0,
    totalSpent: 0,
    isActive: true,
    isFrozen: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

function mmAccountRow(id: string, userId: string): Row {
  return {
    _id: id,
    userId,
    type: 'mobile_money',
    mobileMoneyProvider: 'mtn',
    mobileNumber: PHONE,
    accountName: 'Test User',
    isDefault: false,
    isVerified: true,
    providerResolvedAt: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

function bankAccountRow(id: string, userId: string): Row {
  return {
    _id: id,
    userId,
    type: 'bank_account',
    bankId: 'bank-1',
    bankName: 'Test Bank',
    accountNumber: '1234567890',
    accountName: 'Test User',
    isDefault: false,
    isVerified: true,
    providerResolvedAt: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

function fixtureTables(): Tables {
  return {
    users: [
      userRow('users|buyer', 'clerk_buyer', 'user'),
      userRow('users|other', 'clerk_other', 'user'),
      userRow('users|admin', 'clerk_admin', 'admin'),
      userRow('users|seller', 'clerk_seller', 'user'),
      userRow('users|company', 'clerk_company', 'admin'),
      { ...userRow('users|banned', 'clerk_banned', 'user'), isBanned: true },
      { ...userRow('users|deleted', 'clerk_deleted', 'user'), deletedAt: 1 },
    ],
    vendorProfiles: [
      {
        _id: 'vendorProfiles|seller',
        ownerUserId: 'users|seller',
        status: 'approved',
        storeName: 'Seller',
        slug: 'seller',
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
    products: [
      {
        _id: 'products|lamp',
        sellerId: 'users|seller',
        title: 'Title products|lamp',
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
      },
    ],
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
    appConfig: [
      {
        _id: 'appConfig|1',
        key: 'singleton',
        minimumBuilds: { ios: 1, android: 1 },
        paymentsEnabled: true,
        updatedAt: 1,
      },
    ],
    wallets: [walletRow('users|buyer')],
    walletTransactions: [],
    paymentAccounts: [],
    paymentOperations: [],
    transactions: [],
    cartItems: [],
    orders: [],
  };
}

type Harness = {
  db: Db;
  calls: FetchCall[];
  modules: FakeModules;
  behavior: FakeBehavior;
  env: Record<string, string | undefined>;
  fetchImpl: LencoFetch;
};

function open(behavior: FakeBehavior = {}, env: Record<string, string | undefined> = ENV): Harness {
  const db = createDb(fixtureTables());
  const calls: FetchCall[] = [];
  const fetchImpl = createFetch(behavior, calls, db);
  return {
    db,
    calls,
    modules: { providerOperations: { ...providerOperations }, providerSettlement: { ...providerSettlement } },
    behavior,
    env: { ...env },
    fetchImpl,
  };
}

function actionCtx(harness: Harness, subject: string | null) {
  return createFakeActionCtx({ db: harness.db, subject, modules: harness.modules });
}

function topUpAction(harness: Harness) {
  return createTopUpAction({ env: () => ({ ...harness.env }), fetchImpl: harness.fetchImpl });
}

function withdrawalAction(harness: Harness) {
  return createWithdrawalAction({ env: () => ({ ...harness.env }), fetchImpl: harness.fetchImpl });
}

function registerAction(harness: Harness) {
  return createRegisterAccountAction({ env: () => ({ ...harness.env }), fetchImpl: harness.fetchImpl });
}

function banksAction(harness: Harness) {
  return createListBanksAction({ env: () => ({ ...harness.env }), fetchImpl: harness.fetchImpl });
}

function snapshot(db: Db): Tables {
  return structuredClone(db.tables);
}

type OkResult = {
  ok: true;
  operationId: string;
  status: string;
  providerReference: string;
};

function okResult(result: unknown): OkResult {
  const parsed = result as OkResult;
  if (parsed.ok !== true) {
    throw new Error(`expected a successful initiation, got ${JSON.stringify(result)}`);
  }
  return parsed;
}

async function failureCode(fn: unknown, ctx: unknown, args: unknown): Promise<string> {
  try {
    const result = (await invokeFakeFunction(fn, ctx, args)) as { ok: boolean; code?: string };
    if (result.ok === false && typeof result.code === 'string') {
      return result.code;
    }
    throw new Error(`expected the call to fail, got ${JSON.stringify(result)}`);
  } catch (error) {
    if (error instanceof ConvexError) {
      const data = error.data as { code: string; message: string };
      assert.equal(typeof data.message, 'string');
      return data.code;
    }
    throw error;
  }
}

function findRow(db: Db, table: string, id: string): Row {
  const row = db.tables[table]?.find((candidate) => candidate._id === id);
  assert.ok(row, `${id} must exist in ${table}`);
  return row;
}

function centsOf(major: unknown): number {
  assert.equal(typeof major, 'number');
  const cents = majorNumberToCents(major as number);
  assert.ok(cents !== null);
  return cents;
}

async function registerMm(
  harness: Harness,
  clerkId: string,
  phone = PHONE,
  env: Record<string, string | undefined> | null = null,
): Promise<string> {
  const action =
    env === null
      ? registerAction(harness)
      : createRegisterAccountAction({ env: () => ({ ...env }), fetchImpl: harness.fetchImpl });
  const result = (await invokeFakeFunction(action, actionCtx(harness, clerkId), {
    destination: { type: 'mobile_money', phone, operator: 'mtn' },
  })) as { accountId: string; destinationKey: string };
  return result.accountId;
}

// ---- Request validation: public args carry no money authority ----

test('top-up args reject caller authority and spoofed provider fields with no writes', async () => {
  const harness = open();
  const base = { requestId: 'req-spoof', amountCents: 2500, phone: PHONE, operator: 'mtn' };
  const before = snapshot(harness.db);
  const ctx = actionCtx(harness, 'clerk_buyer');
  const action = topUpAction(harness);
  await assert.rejects(
    () => invokeFakeFunction(action, ctx, { ...base, userId: 'users|other' }),
    /Argument validation failed/,
  );
  await assert.rejects(
    () => invokeFakeFunction(action, ctx, { ...base, providerReference: 'TOP-X' }),
    /Argument validation failed/,
  );
  await assert.rejects(
    () => invokeFakeFunction(action, ctx, { ...base, status: 'succeeded' }),
    /Argument validation failed/,
  );
  await assert.rejects(() => invokeFakeFunction(action, ctx, { ...base, feeMinor: 10 }), /Argument validation failed/);
  await assert.rejects(
    () => invokeFakeFunction(action, ctx, { ...base, debitAccountId: DEBIT_UUID }),
    /Argument validation failed/,
  );
  await assert.rejects(
    () => invokeFakeFunction(action, ctx, { ...base, operator: 'vodafone' }),
    /Argument validation failed/,
  );
  assert.deepEqual(harness.db.tables, before);
  assert.equal(harness.calls.length, 0);
});

test('withdrawal args reject spoofed config and require the approved key', async () => {
  const harness = open();
  const accountId = await registerMm(harness, 'clerk_buyer');
  const base = {
    requestId: 'req-spoof',
    amountCents: 2500,
    paymentAccountId: accountId,
    expectedDestinationKey: MM_KEY,
  };
  const before = snapshot(harness.db);
  const ctx = actionCtx(harness, 'clerk_buyer');
  const action = withdrawalAction(harness);
  await assert.rejects(
    () => invokeFakeFunction(action, ctx, { ...base, userId: 'users|other' }),
    /Argument validation failed/,
  );
  await assert.rejects(
    () => invokeFakeFunction(action, ctx, { ...base, configuredDebitAccountId: DEBIT_UUID }),
    /Argument validation failed/,
  );
  await assert.rejects(
    () => invokeFakeFunction(action, ctx, { ...base, providerReference: 'WDR-X' }),
    /Argument validation failed/,
  );
  await assert.rejects(
    () => invokeFakeFunction(action, ctx, { ...base, status: 'succeeded' }),
    /Argument validation failed/,
  );
  const { expectedDestinationKey: _dropped, ...withoutKey } = base;
  assert.equal(_dropped, MM_KEY);
  await assert.rejects(() => invokeFakeFunction(action, ctx, withoutKey), /Argument validation failed/);
  assert.deepEqual(harness.db.tables, before);
});

test('malformed and lossy amounts deny with no writes and no POST', async () => {
  const harness = open();
  const before = snapshot(harness.db);
  const ctx = actionCtx(harness, 'clerk_buyer');
  const action = topUpAction(harness);
  for (const amountCents of [0, -100, 10.5, Number.NaN, Number.MAX_SAFE_INTEGER]) {
    assert.equal(
      await failureCode(action, ctx, {
        requestId: `req-amount-${String(amountCents)}`,
        amountCents,
        phone: PHONE,
        operator: 'mtn',
      }),
      'invalid_amount',
    );
  }
  assert.deepEqual(harness.db.tables, before);
  assert.equal(harness.calls.length, 0);
});

// ---- Identity: denials happen before any read or write ----

test('anonymous, banned, deleted, and unknown callers are denied with no writes', async () => {
  const harness = open();
  const before = snapshot(harness.db);
  const action = topUpAction(harness);
  const args = { requestId: 'req-identity', amountCents: 2500, phone: PHONE, operator: 'mtn' };
  await assert.rejects(() => invokeFakeFunction(action, actionCtx(harness, null), args), /Unauthenticated/);
  await assert.rejects(() => invokeFakeFunction(action, actionCtx(harness, 'clerk_banned'), args), /banned/);
  await assert.rejects(() => invokeFakeFunction(action, actionCtx(harness, 'clerk_deleted'), args), /deleted/);
  await assert.rejects(() => invokeFakeFunction(action, actionCtx(harness, 'clerk_missing'), args), /not found/);
  assert.deepEqual(harness.db.tables, before);
  assert.equal(harness.calls.length, 0);
});

// ---- Config and switch gates ----

test('missing or invalid private config yields not_started with no operation, debit, or POST', async () => {
  const missing = open({}, {});
  assert.equal(
    await failureCode(topUpAction(missing), actionCtx(missing, 'clerk_buyer'), {
      requestId: 'req-nokey',
      amountCents: 2500,
      phone: PHONE,
      operator: 'mtn',
    }),
    'not_started',
  );
  assert.equal(missing.db.tables['paymentOperations']?.length, 0);
  assert.equal(missing.calls.length, 0);

  const blankKey = open({}, { LENCO_API_KEY: '   ', LENCO_ACCOUNT_ID: DEBIT_UUID });
  assert.equal(
    await failureCode(topUpAction(blankKey), actionCtx(blankKey, 'clerk_buyer'), {
      requestId: 'req-blank',
      amountCents: 2500,
      phone: PHONE,
      operator: 'mtn',
    }),
    'not_started',
  );
  assert.equal(blankKey.calls.length, 0);

  const badDebit = open({}, { LENCO_API_KEY: 'sk-test-key-value', LENCO_ACCOUNT_ID: 'not-a-uuid' });
  const badWithdrawal = createWithdrawalAction({
    env: () => ({ LENCO_API_KEY: 'sk-test-key-value', LENCO_ACCOUNT_ID: 'not-a-uuid' }),
    fetchImpl: badDebit.fetchImpl,
  });
  const accountId = await registerMm(badDebit, 'clerk_buyer', PHONE, ENV);
  const before = snapshot(badDebit.db);
  assert.equal(
    await failureCode(badWithdrawal, actionCtx(badDebit, 'clerk_buyer'), {
      requestId: 'req-baddebit',
      amountCents: 2500,
      paymentAccountId: accountId,
      expectedDestinationKey: MM_KEY,
    }),
    'not_started',
  );
  assert.deepEqual(badDebit.db.tables, before);
  assert.equal(badDebit.calls.filter((call) => call.url.includes('/transfers/')).length, 0);
});

test('a disabled payment switch blocks initiation but not registration', async () => {
  const harness = open();
  findRow(harness.db, 'appConfig', 'appConfig|1')['paymentsEnabled'] = false;
  const before = snapshot(harness.db);
  assert.equal(
    await failureCode(topUpAction(harness), actionCtx(harness, 'clerk_buyer'), {
      requestId: 'req-off',
      amountCents: 2500,
      phone: PHONE,
      operator: 'mtn',
    }),
    'payments_disabled',
  );
  assert.deepEqual(harness.db.tables, before);

  const registered = (await invokeFakeFunction(registerAction(harness), actionCtx(harness, 'clerk_buyer'), {
    destination: { type: 'mobile_money', phone: PHONE, operator: 'mtn' },
  })) as { accountId: string; destinationKey: string };
  assert.equal(registered.destinationKey, MM_KEY);
});

// ---- Top-up happy path with at-fetch oracle ----

test('a top-up persists the operation and companion before its single POST', async () => {
  const seenAtFetch: Array<{ operations: Row[]; companions: Row[] }> = [];
  const harness = open({
    onFetch: (call, db) => {
      if (call.url.endsWith('/collections/mobile-money')) {
        seenAtFetch.push({
          operations: structuredClone(db.tables['paymentOperations'] ?? []),
          companions: structuredClone(db.tables['transactions'] ?? []),
        });
      }
    },
  });
  const result = okResult(
    await invokeFakeFunction(topUpAction(harness), actionCtx(harness, 'clerk_buyer'), {
      requestId: 'req-topup',
      amountCents: 2500,
      phone: PHONE,
      operator: 'mtn',
    }),
  );
  assert.equal(result.status, 'unknown');
  assert.match(result.providerReference, /^TOP-/);

  // Exactly one financial POST with the frozen facts.
  assert.equal(harness.calls.length, 1);
  const post = harness.calls[0] as FetchCall;
  assert.ok(post.url.endsWith('/collections/mobile-money'));
  const body = bodyOf(post);
  assert.equal(body['reference'], result.providerReference);
  assert.equal(body['amount'], 25);
  assert.equal(body['phone'], PHONE);
  assert.equal(body['operator'], 'mtn');
  assert.equal(body['country'], 'zm');

  // The oracle at fetch time: the immutable operation and companion already
  // exist with exact amounts and no wallet movement.
  assert.equal(seenAtFetch.length, 1);
  const atFetch = seenAtFetch[0] as { operations: Row[]; companions: Row[] };
  assert.equal(atFetch.operations.length, 1);
  const frozen = atFetch.operations[0] as Row;
  assert.equal(frozen['kind'], 'top_up_collection');
  assert.equal(frozen['status'], 'attempted');
  assert.equal(frozen['ownerId'], 'users|buyer');
  assert.equal(frozen['amountCents'], 2500);
  assert.equal(frozen['providerReference'], result.providerReference);
  assert.equal(atFetch.companions.length, 1);
  const companion = atFetch.companions[0] as Row;
  assert.equal(companion['type'], 'collection');
  assert.equal(companion['status'], 'pending');
  assert.equal(companion['reference'], result.providerReference);
  assert.equal(centsOf(companion['amount']), 2500);
  assert.equal(companion['currency'], 'ZMW');
  assert.equal(companion['userId'], 'users|buyer');
  assert.equal(harness.db.tables['walletTransactions']?.length, 0);
  assert.equal(harness.db.tables['orders']?.length ?? 0, 0);

  // After attachment: unknown with complete typed receipt facts and no raw payload.
  const operation = findRow(harness.db, 'paymentOperations', result.operationId);
  assert.equal(operation['status'], 'unknown');
  assert.equal(operation['transactionId'], companion['_id']);
  const receipt = operation['receipt'] as Record<string, unknown>;
  assert.deepEqual(receipt, {
    kind: 'collection',
    id: COLLECTION_ID,
    reference: result.providerReference,
    amountMinor: 2500,
    feeMinor: null,
    currency: 'ZMW',
    status: 'pending',
    collectionType: 'mobile-money',
    country: 'zm',
    bearer: 'merchant',
    operator: 'mtn',
    phone: PHONE,
    reasonForFailure: null,
    settlementStatus: null,
  });
  assert.equal(operation['providerId'], COLLECTION_ID);
  assert.equal(findRow(harness.db, 'wallets', 'wallets|users|buyer')['balance'], 1000);
});

test('a top-up is permitted without a wallet and denied for frozen, inactive, or duplicate wallets', async () => {
  const absent = open();
  absent.db.tables['wallets'] = [];
  const permitted = okResult(
    await invokeFakeFunction(topUpAction(absent), actionCtx(absent, 'clerk_buyer'), {
      requestId: 'req-nowallet',
      amountCents: 2500,
      phone: PHONE,
      operator: 'mtn',
    }),
  );
  assert.equal(permitted.status, 'unknown');
  assert.equal(absent.db.tables['wallets']?.length, 0);

  for (const [name, patch, code] of [
    ['frozen', { isFrozen: true }, 'wallet_frozen'],
    ['inactive', { isActive: false }, 'wallet_inactive'],
  ] as Array<[string, Record<string, boolean>, string]>) {
    const harness = open();
    Object.assign(findRow(harness.db, 'wallets', 'wallets|users|buyer'), patch);
    const before = snapshot(harness.db);
    assert.equal(
      await failureCode(topUpAction(harness), actionCtx(harness, 'clerk_buyer'), {
        requestId: `req-${name}`,
        amountCents: 2500,
        phone: PHONE,
        operator: 'mtn',
      }),
      code,
      name,
    );
    assert.deepEqual(harness.db.tables, before);
    assert.equal(harness.calls.length, 0);
  }

  const duplicate = open();
  (duplicate.db.tables['wallets'] as Row[]).push(walletRow('users|buyer'));
  const beforeDup = snapshot(duplicate.db);
  assert.equal(
    await failureCode(topUpAction(duplicate), actionCtx(duplicate, 'clerk_buyer'), {
      requestId: 'req-dup',
      amountCents: 2500,
      phone: PHONE,
      operator: 'mtn',
    }),
    'wallet_duplicate',
  );
  assert.deepEqual(duplicate.db.tables, beforeDup);
});

// ---- Withdrawal happy paths ----

test('a mobile-money withdrawal debits exactly once with fee as evidence only', async () => {
  const seenAtFetch: Array<{ operations: Row[]; ledger: Row[] }> = [];
  const harness = open({
    onFetch: (call, db) => {
      if (call.url.endsWith('/transfers/mobile-money')) {
        seenAtFetch.push({
          operations: structuredClone(db.tables['paymentOperations'] ?? []),
          ledger: structuredClone(db.tables['walletTransactions'] ?? []),
        });
      }
    },
  });
  const accountId = await registerMm(harness, 'clerk_buyer');
  const fetchBeforeWithdraw = harness.calls.length;
  const result = okResult(
    await invokeFakeFunction(withdrawalAction(harness), actionCtx(harness, 'clerk_buyer'), {
      requestId: 'req-withdraw-mm',
      amountCents: 2500,
      paymentAccountId: accountId,
      expectedDestinationKey: MM_KEY,
    }),
  );
  assert.equal(result.status, 'unknown');
  assert.match(result.providerReference, /^WDR-MM-/);

  const posts = harness.calls.slice(fetchBeforeWithdraw);
  assert.equal(posts.length, 1);
  const body = bodyOf(posts[0] as FetchCall);
  assert.equal(body['reference'], result.providerReference);
  assert.equal(body['amount'], 25);
  assert.equal(body['accountId'], DEBIT_UUID);
  assert.equal(body['phone'], PHONE);
  assert.equal(body['operator'], 'mtn');
  assert.equal(body['country'], 'zm');

  // At fetch time the reservation and pending debit already exist.
  assert.equal(seenAtFetch.length, 1);
  const atFetch = seenAtFetch[0] as { operations: Row[]; ledger: Row[] };
  assert.equal(atFetch.operations.length, 1);
  assert.equal(atFetch.operations[0]?.['status'], 'attempted');
  assert.equal(atFetch.ledger.length, 1);
  assert.equal(atFetch.ledger[0]?.['status'], 'pending');

  const operation = findRow(harness.db, 'paymentOperations', result.operationId);
  assert.equal(operation['kind'], 'withdrawal_transfer');
  assert.equal(operation['status'], 'unknown');
  assert.equal(operation['amountCents'], 2500);
  assert.equal(operation['debitAmountCents'], 2500);
  assert.equal(operation['configuredDebitAccountId'], DEBIT_UUID);
  assert.equal(operation['destinationKey'], MM_KEY);

  // Exactly one pending debit equal to the requested cents; the fee is
  // evidence, never an extra debit.
  const rows = harness.db.tables['walletTransactions'] as Row[];
  assert.equal(rows.length, 1);
  const debit = rows[0] as Row;
  assert.equal(debit['type'], 'debit');
  assert.equal(debit['source'], 'withdrawal_mobile_money');
  assert.equal(debit['status'], 'pending');
  assert.equal(centsOf(debit['amount']), 2500);
  assert.equal(debit['operationId'], result.operationId);
  assert.equal(debit['paymentAccountId'], accountId);
  assert.match(String(debit['reference']), /^WLT-/);
  assert.notEqual(debit['reference'], result.providerReference);
  assert.equal(operation['walletTransactionId'], debit['_id']);

  const receipt = operation['receipt'] as Record<string, unknown>;
  assert.equal(receipt['feeMinor'], 50);
  assert.equal(operation['providerId'], TRANSFER_ID);

  const wallet = findRow(harness.db, 'wallets', 'wallets|users|buyer');
  assert.equal(centsOf(wallet['balance']), 100000 - 2500);
  assert.equal(centsOf(wallet['totalWithdrawn']), 2500);
  assert.equal(centsOf(wallet['pendingBalance']), 0);
  assert.equal(centsOf(wallet['totalSpent']), 0);
  assert.equal(centsOf(wallet['totalEarned']), 100000);
});

test('a bank withdrawal posts the directory bank id and matching destination', async () => {
  const harness = open();
  const registered = (await invokeFakeFunction(registerAction(harness), actionCtx(harness, 'clerk_buyer'), {
    destination: { type: 'bank_account', bankId: 'bank-1', accountNumber: '1234567890' },
  })) as { accountId: string; destinationKey: string };
  assert.equal(registered.destinationKey, BANK_KEY);
  const fetchBeforeWithdraw = harness.calls.length;

  const result = okResult(
    await invokeFakeFunction(withdrawalAction(harness), actionCtx(harness, 'clerk_buyer'), {
      requestId: 'req-withdraw-bank',
      amountCents: 10000,
      paymentAccountId: registered.accountId,
      expectedDestinationKey: BANK_KEY,
    }),
  );
  assert.match(result.providerReference, /^WDR-BK-/);

  const posts = harness.calls.slice(fetchBeforeWithdraw);
  assert.equal(posts.length, 1);
  assert.ok((posts[0] as FetchCall).url.endsWith('/transfers/bank-account'));
  const body = bodyOf(posts[0] as FetchCall);
  assert.equal(body['bankId'], 'bank-1');
  assert.equal(body['accountNumber'], '1234567890');
  assert.equal(body['accountId'], DEBIT_UUID);
  assert.ok(!('bankCode' in body));
  assert.ok(!('accountName' in body));

  const operation = findRow(harness.db, 'paymentOperations', result.operationId);
  assert.deepEqual(operation['withdrawalDestination'], {
    bankId: 'bank-1',
    accountNumber: '1234567890',
    country: 'zm',
  });
  const debit = (harness.db.tables['walletTransactions'] as Row[])[0] as Row;
  assert.equal(debit['source'], 'withdrawal_bank');
  assert.equal(centsOf(debit['amount']), 10000);
  const wallet = findRow(harness.db, 'wallets', 'wallets|users|buyer');
  assert.equal(centsOf(wallet['balance']), 100000 - 10000);
  assert.equal(centsOf(wallet['totalWithdrawn']), 10000);
});

// ---- Withdrawal denials leave every table unchanged ----

test('withdrawal wallet denials write nothing and post nothing', async () => {
  const cases: Array<{ name: string; setup: (db: Db) => void; code: string }> = [
    {
      name: 'missing',
      setup: (db) => {
        db.tables['wallets'] = [];
      },
      code: 'wallet_missing',
    },
    {
      name: 'inactive',
      setup: (db) => {
        findRow(db, 'wallets', 'wallets|users|buyer')['isActive'] = false;
      },
      code: 'wallet_inactive',
    },
    {
      name: 'frozen',
      setup: (db) => {
        findRow(db, 'wallets', 'wallets|users|buyer')['isFrozen'] = true;
      },
      code: 'wallet_frozen',
    },
    {
      name: 'malformed',
      setup: (db) => {
        findRow(db, 'wallets', 'wallets|users|buyer')['balance'] = 10.001;
      },
      code: 'wallet_malformed',
    },
    {
      name: 'insufficient',
      setup: (db) => {
        findRow(db, 'wallets', 'wallets|users|buyer')['balance'] = 1;
      },
      code: 'insufficient_funds',
    },
    {
      name: 'duplicate',
      setup: (db) => {
        (db.tables['wallets'] as Row[]).push(walletRow('users|buyer'));
      },
      code: 'wallet_duplicate',
    },
  ];
  for (const { name, setup, code } of cases) {
    const harness = open();
    const accountId = await registerMm(harness, 'clerk_buyer');
    setup(harness.db);
    const before = snapshot(harness.db);
    const fetchCount = harness.calls.length;
    assert.equal(
      await failureCode(withdrawalAction(harness), actionCtx(harness, 'clerk_buyer'), {
        requestId: `req-w-${name}`,
        amountCents: 2500,
        paymentAccountId: accountId,
        expectedDestinationKey: MM_KEY,
      }),
      code,
      name,
    );
    assert.deepEqual(harness.db.tables, before, name);
    assert.equal(harness.calls.length, fetchCount, name);
  }
});

test('a destination mismatch returns the current owned key with zero writes and zero POST', async () => {
  const harness = open();
  const accountId = await registerMm(harness, 'clerk_buyer');
  const before = snapshot(harness.db);
  const fetchCount = harness.calls.length;
  const result = (await invokeFakeFunction(withdrawalAction(harness), actionCtx(harness, 'clerk_buyer'), {
    requestId: 'req-mismatch',
    amountCents: 2500,
    paymentAccountId: accountId,
    expectedDestinationKey: 'mm:zm:mtn:0999999999',
  })) as { ok: boolean; code?: string; destinationKey?: string };
  assert.equal(result.ok, false);
  assert.equal(result.code, 'destination_mismatch');
  assert.equal(result.destinationKey, MM_KEY);
  assert.deepEqual(harness.db.tables, before);
  assert.equal(harness.calls.length, fetchCount);
});

test('foreign, missing, and unresolved accounts cannot back a withdrawal', async () => {
  const harness = open();
  (harness.db.tables['paymentAccounts'] as Row[]).push(mmAccountRow('paymentAccounts|foreign', 'users|other'));
  (harness.db.tables['paymentAccounts'] as Row[]).push({
    ...mmAccountRow('paymentAccounts|legacy', 'users|buyer'),
    isVerified: false,
    providerResolvedAt: undefined,
  });
  const accountId = await registerMm(harness, 'clerk_buyer');

  const foreignBefore = snapshot(harness.db);
  assert.equal(
    await failureCode(withdrawalAction(harness), actionCtx(harness, 'clerk_buyer'), {
      requestId: 'req-foreign',
      amountCents: 2500,
      paymentAccountId: 'paymentAccounts|foreign',
      expectedDestinationKey: MM_KEY,
    }),
    'account_not_found',
  );
  assert.deepEqual(harness.db.tables, foreignBefore);

  assert.equal(
    await failureCode(withdrawalAction(harness), actionCtx(harness, 'clerk_buyer'), {
      requestId: 'req-legacy',
      amountCents: 2500,
      paymentAccountId: 'paymentAccounts|legacy',
      expectedDestinationKey: MM_KEY,
    }),
    'account_unverified',
  );

  await assert.rejects(
    () =>
      invokeFakeFunction(withdrawalAction(harness), actionCtx(harness, 'clerk_other'), {
        requestId: 'req-theirs',
        amountCents: 2500,
        paymentAccountId: accountId,
        expectedDestinationKey: MM_KEY,
      }),
    /account_not_found|Unauthorized/,
  );
  assert.deepEqual(harness.db.tables, foreignBefore);
});

// ---- Registration and directory ----

test('registration resolves once, stores owned facts, and is idempotent by key', async () => {
  const harness = open();
  const first = (await invokeFakeFunction(registerAction(harness), actionCtx(harness, 'clerk_buyer'), {
    destination: { type: 'mobile_money', phone: PHONE, operator: 'mtn' },
  })) as { accountId: string; destinationKey: string };
  assert.equal(first.destinationKey, MM_KEY);

  const resolveCalls = harness.calls.filter((call) => call.url.endsWith('/resolve/mobile-money'));
  assert.equal(resolveCalls.length, 1);
  assert.ok(!resolveCalls[0]?.url.includes('/collections/'));

  const stored = findRow(harness.db, 'paymentAccounts', first.accountId);
  assert.equal(stored['userId'], 'users|buyer');
  assert.equal(stored['mobileMoneyProvider'], 'mtn');
  assert.equal(stored['mobileNumber'], PHONE);
  assert.equal(stored['accountName'], 'Test User');
  assert.equal(stored['isVerified'], true);
  assert.equal(typeof stored['providerResolvedAt'], 'number');

  const second = (await invokeFakeFunction(registerAction(harness), actionCtx(harness, 'clerk_buyer'), {
    destination: { type: 'mobile_money', phone: PHONE, operator: 'mtn' },
  })) as { accountId: string; destinationKey: string };
  assert.equal(second.accountId, first.accountId);
  assert.equal((harness.db.tables['paymentAccounts'] as Row[]).length, 1);

  // The caller cannot set verification, ownership, or debit facts.
  await assert.rejects(
    () =>
      invokeFakeFunction(registerAction(harness), actionCtx(harness, 'clerk_buyer'), {
        destination: { type: 'mobile_money', phone: PHONE, operator: 'mtn' },
        isVerified: false,
      }),
    /Argument validation failed/,
  );
  await assert.rejects(
    () =>
      invokeFakeFunction(registerAction(harness), actionCtx(harness, 'clerk_buyer'), {
        destination: { type: 'mobile_money', phone: PHONE, operator: 'mtn' },
        accountName: 'Spoofed',
      }),
    /Argument validation failed/,
  );
  await assert.rejects(
    () =>
      invokeFakeFunction(registerAction(harness), actionCtx(harness, null), {
        destination: { type: 'mobile_money', phone: PHONE, operator: 'mtn' },
      }),
    /Unauthenticated/,
  );
});

test('a bank registration keeps the directory id and never a bankCode alias', async () => {
  const harness = open();
  const result = (await invokeFakeFunction(registerAction(harness), actionCtx(harness, 'clerk_buyer'), {
    destination: { type: 'bank_account', bankId: 'bank-1', accountNumber: '1234567890' },
  })) as { accountId: string; destinationKey: string };
  assert.equal(result.destinationKey, BANK_KEY);
  const stored = findRow(harness.db, 'paymentAccounts', result.accountId);
  assert.equal(stored['bankId'], 'bank-1');
  assert.equal(stored['bankCode'], undefined);
  assert.equal(stored['accountNumber'], '1234567890');
});

test('registration exposes an object root with a nested destination discriminant', async () => {
  // The deployed analyzer requires a root object: the registered action
  // must export {type:"object"} with the mobile-money/bank discriminant
  // nested under destination, and no caller authority fields anywhere.
  const exported = JSON.parse(
    (providerOperations.registerPaymentAccount as unknown as { exportArgs: () => string }).exportArgs(),
  ) as { type: string };
  assert.equal(exported.type, 'object');
  const text = JSON.stringify(exported);
  for (const token of ['destination', 'mobile_money', 'bank_account', 'phone', 'operator', 'bankId', 'accountNumber']) {
    assert.ok(text.includes(`"${token}"`), `exported args must carry ${token}`);
  }
  for (const token of ['accountName', 'isVerified']) {
    assert.ok(!text.includes(`"${token}"`), `exported args must not carry caller authority ${token}`);
  }
});

test('registration rejects flat, branch-invalid, and authority inputs with no writes', async () => {
  const harness = open();
  const action = registerAction(harness);
  const ctx = actionCtx(harness, 'clerk_buyer');
  const before = snapshot(harness.db);
  // The old flat shape no longer validates: destination is required.
  await assert.rejects(
    () => invokeFakeFunction(action, ctx, { type: 'mobile_money', phone: PHONE, operator: 'mtn' }),
    /Argument validation failed/,
  );
  await assert.rejects(() => invokeFakeFunction(action, ctx, {}), /Argument validation failed/);
  // A branch missing its required fields never reaches the provider.
  await assert.rejects(
    () => invokeFakeFunction(action, ctx, { destination: { type: 'mobile_money', phone: PHONE } }),
    /Argument validation failed/,
  );
  // Authority fields are rejected inside the nested branch too.
  await assert.rejects(
    () =>
      invokeFakeFunction(action, ctx, {
        destination: { type: 'mobile_money', phone: PHONE, operator: 'mtn', accountName: 'Spoofed' },
      }),
    /Argument validation failed/,
  );
  assert.deepEqual(harness.db.tables, before);
  assert.equal(harness.calls.length, 0);
  // Blank directory fields pass the schema but fail at the handler with no writes.
  assert.equal(
    await failureCode(action, ctx, { destination: { type: 'bank_account', bankId: '', accountNumber: '' } }),
    'invalid_destination',
  );
  assert.deepEqual(harness.db.tables, before);
});

test('an unresolved provider answer fails registration with no stored row', async () => {
  const harness = open();
  const failing = createRegisterAccountAction({
    env: () => ({ ...ENV }),
    fetchImpl: (async () =>
      new Response(JSON.stringify({ status: false, message: 'no such account' }), { status: 200 })) as LencoFetch,
  });
  const before = snapshot(harness.db);
  assert.equal(
    await failureCode(failing, actionCtx(harness, 'clerk_buyer'), {
      destination: { type: 'mobile_money', phone: PHONE, operator: 'mtn' },
    }),
    'resolution_failed',
  );
  assert.deepEqual(harness.db.tables, before);
});

test('the bank directory lists validated banks for an active verified actor', async () => {
  const harness = open();
  const result = (await invokeFakeFunction(banksAction(harness), actionCtx(harness, 'clerk_buyer'), {})) as {
    ok: boolean;
    banks: Array<{ id: string; name: string; country: string }>;
  };
  assert.equal(result.ok, true);
  assert.deepEqual(result.banks, [
    { id: 'bank-1', name: 'Test Bank', country: 'zm' },
    { id: 'bank-2', name: 'Second Bank', country: 'zm' },
  ]);
  await assert.rejects(() => invokeFakeFunction(banksAction(harness), actionCtx(harness, null), {}), /Unauthenticated/);
  await assert.rejects(
    () => invokeFakeFunction(banksAction(harness), actionCtx(harness, 'clerk_banned'), {}),
    /banned/,
  );
});

test('the account list projects only display and approval facts', async () => {
  const harness = open();
  (harness.db.tables['paymentAccounts'] as Row[]).push(mmAccountRow('paymentAccounts|mm1', 'users|buyer'));
  (harness.db.tables['paymentAccounts'] as Row[]).push(bankAccountRow('paymentAccounts|bk1', 'users|buyer'));
  (harness.db.tables['paymentAccounts'] as Row[]).push(mmAccountRow('paymentAccounts|other', 'users|other'));
  (harness.db.tables['paymentAccounts'] as Row[]).push({
    ...mmAccountRow('paymentAccounts|legacy', 'users|buyer'),
    isVerified: false,
    providerResolvedAt: undefined,
  });

  const listed = (await invokeFakeFunction(
    providerOperations.listPaymentAccounts,
    createCtx(harness.db, 'clerk_buyer'),
    {},
  )) as Array<Record<string, unknown>>;
  assert.equal(listed.length, 3);
  const mm = listed.find((row) => row['accountId'] === 'paymentAccounts|mm1') as Record<string, unknown>;
  assert.equal(mm['destinationKey'], MM_KEY);
  assert.equal(mm['phone'], PHONE);
  assert.equal(mm['isVerified'], true);
  assert.ok(!('userId' in mm));
  assert.ok(!('lencoRecipientId' in mm));
  const bank = listed.find((row) => row['accountId'] === 'paymentAccounts|bk1') as Record<string, unknown>;
  assert.equal(bank['destinationKey'], BANK_KEY);
  const legacy = listed.find((row) => row['accountId'] === 'paymentAccounts|legacy') as Record<string, unknown>;
  assert.equal(legacy['destinationKey'], MM_KEY);
  assert.equal(legacy['isVerified'], false);
  assert.equal(legacy['providerResolvedAt'], null);

  await assert.rejects(
    () => invokeFakeFunction(providerOperations.listPaymentAccounts, createCtx(harness.db, null), {}),
    /Unauthenticated/,
  );
  const otherListed = (await invokeFakeFunction(
    providerOperations.listPaymentAccounts,
    createCtx(harness.db, 'clerk_other'),
    {},
  )) as Array<Record<string, unknown>>;
  assert.equal(otherListed.length, 1);
});

// ---- Recovery before fresh reads ----

test('a repeated request returns its stored status with zero POST, debit, or new row', async () => {
  const harness = open();
  const args = { requestId: 'req-replay', amountCents: 2500, phone: PHONE, operator: 'mtn' };
  const first = okResult(await invokeFakeFunction(topUpAction(harness), actionCtx(harness, 'clerk_buyer'), args));
  assert.equal(harness.calls.length, 1);

  findRow(harness.db, 'appConfig', 'appConfig|1')['paymentsEnabled'] = false;
  (harness.db.tables['wallets'] as Row[]).push(walletRow('users|buyer'));
  const before = snapshot(harness.db);
  const second = okResult(await invokeFakeFunction(topUpAction(harness), actionCtx(harness, 'clerk_buyer'), args));
  assert.deepEqual(second, first);
  assert.deepEqual(harness.db.tables, before);
  assert.equal(harness.calls.length, 1);
});

test('a conflicting reuse rejects across kind, amount, destination, key, and account', async () => {
  const harness = open();
  const accountId = await registerMm(harness, 'clerk_buyer');
  const base = { requestId: 'req-conflict', amountCents: 2500, phone: PHONE, operator: 'mtn' };
  okResult(await invokeFakeFunction(topUpAction(harness), actionCtx(harness, 'clerk_buyer'), base));
  const fetchCount = harness.calls.length;
  const before = snapshot(harness.db);
  const ctx = actionCtx(harness, 'clerk_buyer');
  const action = topUpAction(harness);

  assert.equal(await failureCode(action, ctx, { ...base, amountCents: 2600 }), 'conflicting_reuse');
  assert.equal(await failureCode(action, ctx, { ...base, phone: '0979999999' }), 'conflicting_reuse');
  assert.equal(await failureCode(action, ctx, { ...base, operator: 'airtel' }), 'conflicting_reuse');
  assert.equal(
    await failureCode(withdrawalAction(harness), ctx, {
      requestId: 'req-conflict',
      amountCents: 2500,
      paymentAccountId: accountId,
      expectedDestinationKey: MM_KEY,
    }),
    'conflicting_reuse',
  );
  assert.deepEqual(harness.db.tables, before);
  assert.equal(harness.calls.length, fetchCount);
});

test('duplicate request rows fail to review instead of returning one', async () => {
  const harness = open();
  for (let index = 0; index < 2; index++) {
    (harness.db.tables['paymentOperations'] as Row[]).push({
      _id: `paymentOperations|dup${index}`,
      ownerId: 'users|buyer',
      requestId: 'req-duplicate',
      kind: 'top_up_collection',
      status: 'unknown',
      requestIdentity: 'dupe',
      providerReference: `TOP-DUP${index}`,
      amountCents: 2500,
      currency: 'ZMW',
      destinationKey: MM_KEY,
      collectionDestination: { phone: PHONE, operator: 'mtn', country: 'zm' },
      createdAt: 1,
      updatedAt: 1,
    });
  }
  const before = snapshot(harness.db);
  assert.equal(
    await failureCode(topUpAction(harness), actionCtx(harness, 'clerk_buyer'), {
      requestId: 'req-duplicate',
      amountCents: 2500,
      phone: PHONE,
      operator: 'mtn',
    }),
    'review_needed',
  );
  assert.deepEqual(harness.db.tables, before);
  assert.equal(harness.calls.length, 0);
});

test('a cross-kind wallet row conflicts instead of recovering as a top-up', async () => {
  const harness = open();
  (harness.db.tables['paymentOperations'] as Row[]).push({
    _id: 'paymentOperations|wallet1',
    ownerId: 'users|buyer',
    requestId: 'req-cross',
    kind: 'wallet_purchase',
    status: 'succeeded',
    source: 'cart',
    requestIdentity: 'wallet-identity',
    quoteKey: 'quote-1',
    quoteSnapshot: {},
    orderBreakdowns: [],
    orderIds: [],
    totalAmountCents: 100,
    walletReference: 'WLT-X',
    debitAmountCents: 100,
    walletBalanceAfterCents: 0,
    accountingAppliedAt: 1,
    createdAt: 1,
    updatedAt: 1,
  });
  assert.equal(
    await failureCode(topUpAction(harness), actionCtx(harness, 'clerk_buyer'), {
      requestId: 'req-cross',
      amountCents: 2500,
      phone: PHONE,
      operator: 'mtn',
    }),
    'conflicting_reuse',
  );
});

test('a crash before POST heals to unknown on reuse with no second POST', async () => {
  const harness = open();
  const accountId = await registerMm(harness, 'clerk_buyer');
  // A reservation stranded in attempted by a crash before transport, built
  // with the same static identity the action derives.
  const requestIdentity = await buildWithdrawalRequestIdentity({
    actorId: 'users|buyer',
    amountCents: 2500,
    paymentAccountId: accountId,
    expectedDestinationKey: MM_KEY,
  });
  (harness.db.tables['paymentOperations'] as Row[]).push({
    _id: 'paymentOperations|stranded',
    ownerId: 'users|buyer',
    requestId: 'req-crash',
    kind: 'withdrawal_transfer',
    status: 'attempted',
    requestIdentity,
    providerReference: 'WDR-MM-STRANDED',
    amountCents: 2500,
    currency: 'ZMW',
    destinationKey: MM_KEY,
    withdrawalDestination: { phone: PHONE, operator: 'mtn', country: 'zm' },
    paymentAccountId: accountId,
    configuredDebitAccountId: DEBIT_UUID,
    walletId: 'wallets|users|buyer',
    walletTransactionId: 'walletTransactions|seed',
    debitAmountCents: 2500,
    walletBalanceAfterCents: 97500,
    attemptedAt: 1,
    createdAt: 1,
    updatedAt: 1,
  });
  const fetchCount = harness.calls.length;
  const healed = okResult(
    await invokeFakeFunction(withdrawalAction(harness), actionCtx(harness, 'clerk_buyer'), {
      requestId: 'req-crash',
      amountCents: 2500,
      paymentAccountId: accountId,
      expectedDestinationKey: MM_KEY,
    }),
  );
  assert.equal(healed.operationId, 'paymentOperations|stranded');
  assert.equal(healed.status, 'unknown');
  assert.equal(healed.providerReference, 'WDR-MM-STRANDED');
  assert.equal(harness.calls.length, fetchCount);
  assert.equal(findRow(harness.db, 'paymentOperations', 'paymentOperations|stranded')['status'], 'unknown');
});

test('replays after success never POST again', async () => {
  const harness = open();
  const accountId = await registerMm(harness, 'clerk_buyer');
  const args = {
    requestId: 'req-once',
    amountCents: 2500,
    paymentAccountId: accountId,
    expectedDestinationKey: MM_KEY,
  };
  const ctx = actionCtx(harness, 'clerk_buyer');
  const action = withdrawalAction(harness);
  const first = okResult(await invokeFakeFunction(action, ctx, args));
  const posts = harness.calls.filter((call) => call.url.includes('/transfers/')).length;
  assert.equal(posts, 1);
  for (let replay = 0; replay < 2; replay++) {
    const next = okResult(await invokeFakeFunction(action, ctx, args));
    assert.deepEqual(next, { ...first });
  }
  assert.equal(harness.calls.filter((call) => call.url.includes('/transfers/')).length, 1);
  assert.equal((harness.db.tables['walletTransactions'] as Row[]).length, 1);
});

// ---- Ambiguous transport stays unknown with funds retained ----

test('timeout, HTTP, provider-false, duplicate, and malformed outcomes stay unknown with no reversal', async () => {
  const outcomes: Array<{ name: string; response: () => Response }> = [
    { name: 'http', response: () => new Response('bad gateway', { status: 502 }) },
    {
      name: 'provider-false',
      response: () => new Response(JSON.stringify({ status: false, message: 'declined' }), { status: 200 }),
    },
    {
      name: 'duplicate',
      response: () =>
        new Response(JSON.stringify({ status: false, code: 'duplicate', message: 'duplicate reference' }), {
          status: 400,
        }),
    },
    { name: 'malformed', response: () => new Response('not json', { status: 200 }) },
  ];
  for (const { name, response } of outcomes) {
    const harness = open({ collections: () => response() });
    const result = okResult(
      await invokeFakeFunction(topUpAction(harness), actionCtx(harness, 'clerk_buyer'), {
        requestId: `req-${name}`,
        amountCents: 2500,
        phone: PHONE,
        operator: 'mtn',
      }),
    );
    assert.equal(result.status, 'unknown', name);
    const operation = findRow(harness.db, 'paymentOperations', result.operationId);
    assert.equal(operation['status'], 'unknown', name);
    assert.equal(operation['receipt'], undefined, name);
    assert.equal(typeof operation['failureCode'], 'string', name);
    // The second replay posts nothing and keeps the original operation.
    const replayed = okResult(
      await invokeFakeFunction(topUpAction(harness), actionCtx(harness, 'clerk_buyer'), {
        requestId: `req-${name}`,
        amountCents: 2500,
        phone: PHONE,
        operator: 'mtn',
      }),
    );
    assert.equal(replayed.operationId, result.operationId, name);
    assert.equal(harness.calls.length, 1, name);
  }

  const throwing = open({
    collections: () => {
      throw new Error('socket reset');
    },
  });
  const thrown = okResult(
    await invokeFakeFunction(topUpAction(throwing), actionCtx(throwing, 'clerk_buyer'), {
      requestId: 'req-throw',
      amountCents: 2500,
      phone: PHONE,
      operator: 'mtn',
    }),
  );
  assert.equal(thrown.status, 'unknown');
  assert.equal(findRow(throwing.db, 'paymentOperations', thrown.operationId)['failureCode'], 'provider_error');
});

test('a pending receipt is stored as evidence while the operation waits for settlement', async () => {
  const harness = open({
    collections: (call) => {
      const args = bodyOf(call);
      return envelope({
        id: COLLECTION_ID,
        reference: args['reference'],
        amount: majorText(args['amount'] as number),
        currency: 'ZMW',
        status: 'awaiting-otp',
        type: 'mobile-money',
        bearer: 'merchant',
        mobileMoneyDetails: { country: 'zm', operator: args['operator'], phone: args['phone'] },
        reasonForFailure: null,
        settlementStatus: 'unsettled',
      });
    },
  });
  const result = okResult(
    await invokeFakeFunction(topUpAction(harness), actionCtx(harness, 'clerk_buyer'), {
      requestId: 'req-pending',
      amountCents: 2500,
      phone: PHONE,
      operator: 'mtn',
    }),
  );
  const operation = findRow(harness.db, 'paymentOperations', result.operationId);
  assert.equal(operation['status'], 'unknown');
  const receipt = operation['receipt'] as Record<string, unknown>;
  assert.equal(receipt['status'], 'pending');
  assert.equal(receipt['settlementStatus'], 'unsettled');
  assert.equal(operation['providerId'], COLLECTION_ID);
});

test('a mismatching receipt flags review without binding or moving money', async () => {
  const harness = open({
    collections: (call) => {
      const args = bodyOf(call);
      return envelope({
        id: COLLECTION_ID,
        reference: args['reference'],
        amount: '99.99',
        currency: 'ZMW',
        status: 'successful',
        type: 'mobile-money',
        bearer: 'merchant',
        mobileMoneyDetails: { country: 'zm', operator: args['operator'], phone: args['phone'] },
        reasonForFailure: null,
        settlementStatus: null,
      });
    },
  });
  const result = okResult(
    await invokeFakeFunction(topUpAction(harness), actionCtx(harness, 'clerk_buyer'), {
      requestId: 'req-mismatch-receipt',
      amountCents: 2500,
      phone: PHONE,
      operator: 'mtn',
    }),
  );
  const operation = findRow(harness.db, 'paymentOperations', result.operationId);
  assert.equal(operation['status'], 'unknown');
  assert.equal(operation['reviewNeeded'], true);
  assert.equal(operation['providerId'], undefined);
  assert.equal((operation['receipt'] as Record<string, unknown>)['amountMinor'], 9999);
});

test('attachment never overwrites a bound provider id or regresses review state', async () => {
  const harness = open();
  const result = okResult(
    await invokeFakeFunction(topUpAction(harness), actionCtx(harness, 'clerk_buyer'), {
      requestId: 'req-bind',
      amountCents: 2500,
      phone: PHONE,
      operator: 'mtn',
    }),
  );
  const first = findRow(harness.db, 'paymentOperations', result.operationId);
  assert.equal(first['providerId'], COLLECTION_ID);

  const conflicting = {
    kind: 'collection',
    id: '44444444-2222-3333-4444-555555555555',
    reference: result.providerReference,
    amountMinor: 2500,
    feeMinor: null,
    currency: 'ZMW',
    status: 'failed',
    collectionType: 'mobile-money',
    country: 'zm',
    bearer: 'merchant',
    operator: 'mtn',
    phone: PHONE,
    reasonForFailure: 'declined',
    settlementStatus: null,
  };
  const attached = (await invokeFakeFunction(
    providerOperations.attachProviderResult,
    createCtx(harness.db, 'clerk_buyer'),
    { operationId: result.operationId, receipt: conflicting },
  )) as { status: string };
  assert.equal(attached.status, 'unknown');
  const kept = findRow(harness.db, 'paymentOperations', result.operationId);
  assert.equal(kept['providerId'], COLLECTION_ID);
  assert.equal((kept['receipt'] as Record<string, unknown>)['id'], COLLECTION_ID);
  assert.equal(kept['reviewNeeded'], true);
});

test('attachment still runs after the owner is banned, deleted, or signed out', async () => {
  const harness = open();
  const result = okResult(
    await invokeFakeFunction(topUpAction(harness), actionCtx(harness, 'clerk_buyer'), {
      requestId: 'req-ban',
      amountCents: 2500,
      phone: PHONE,
      operator: 'mtn',
    }),
  );
  findRow(harness.db, 'users', 'users|buyer')['isBanned'] = true;
  const receipt = {
    kind: 'collection',
    id: COLLECTION_ID,
    reference: result.providerReference,
    amountMinor: 2500,
    feeMinor: null,
    currency: 'ZMW',
    status: 'successful',
    collectionType: 'mobile-money',
    country: 'zm',
    bearer: 'merchant',
    operator: 'mtn',
    phone: PHONE,
    reasonForFailure: null,
    settlementStatus: null,
  };
  for (const subject of ['clerk_buyer', 'clerk_other', null]) {
    const attached = (await invokeFakeFunction(
      providerOperations.attachProviderResult,
      createCtx(harness.db, subject),
      { operationId: result.operationId, receipt },
    )) as { status: string };
    assert.equal(attached.status, 'unknown');
  }
  // New claims stay denied for the banned owner.
  await assert.rejects(
    () =>
      invokeFakeFunction(topUpAction(harness), actionCtx(harness, 'clerk_buyer'), {
        requestId: 'req-ban-new',
        amountCents: 2500,
        phone: PHONE,
        operator: 'mtn',
      }),
    /banned/,
  );
});

// ---- Owner recovery queries ----

test('provider getMine projects safe facts and hides everything else', async () => {
  const harness = open();
  const accountId = await registerMm(harness, 'clerk_buyer');
  const withdrawal = okResult(
    await invokeFakeFunction(withdrawalAction(harness), actionCtx(harness, 'clerk_buyer'), {
      requestId: 'req-mine-w',
      amountCents: 2500,
      paymentAccountId: accountId,
      expectedDestinationKey: MM_KEY,
    }),
  );
  const topUp = okResult(
    await invokeFakeFunction(topUpAction(harness), actionCtx(harness, 'clerk_buyer'), {
      requestId: 'req-mine-t',
      amountCents: 2500,
      phone: PHONE,
      operator: 'mtn',
    }),
  );

  const mine = (await invokeFakeFunction(providerOperations.getMine, createCtx(harness.db, 'clerk_buyer'), {
    operationId: withdrawal.operationId,
  })) as Record<string, unknown>;
  assert.equal(mine['kind'], 'withdrawal_transfer');
  assert.equal(mine['status'], 'unknown');
  assert.equal(mine['amountCents'], 2500);
  assert.equal(mine['providerReference'], withdrawal.providerReference);
  assert.equal(mine['destinationKey'], MM_KEY);
  assert.equal(typeof mine['walletTransactionId'], 'string');
  assert.equal(mine['receipt'], undefined);

  const topMine = (await invokeFakeFunction(providerOperations.getMine, createCtx(harness.db, 'clerk_buyer'), {
    operationId: topUp.operationId,
  })) as Record<string, unknown>;
  assert.equal(topMine['kind'], 'top_up_collection');
  assert.equal(typeof topMine['transactionId'], 'string');

  await assert.rejects(
    () =>
      invokeFakeFunction(providerOperations.getMine, createCtx(harness.db, 'clerk_other'), {
        operationId: withdrawal.operationId,
      }),
    /Unauthorized/,
  );
  await assert.rejects(
    () =>
      invokeFakeFunction(providerOperations.getMine, createCtx(harness.db, 'clerk_admin'), {
        operationId: withdrawal.operationId,
      }),
    /Unauthorized/,
  );
  await assert.rejects(
    () =>
      invokeFakeFunction(providerOperations.getMine, createCtx(harness.db, null), {
        operationId: withdrawal.operationId,
      }),
    /Unauthenticated/,
  );
  const missing = (await invokeFakeFunction(providerOperations.getMine, createCtx(harness.db, 'clerk_buyer'), {
    operationId: 'paymentOperations|missing',
  })) as null;
  assert.equal(missing, null);
});

test('provider rows never project as wallet purchases and wallet rows never project as provider operations', async () => {
  const harness = open();
  const topUp = okResult(
    await invokeFakeFunction(topUpAction(harness), actionCtx(harness, 'clerk_buyer'), {
      requestId: 'req-kinds',
      amountCents: 2500,
      phone: PHONE,
      operator: 'mtn',
    }),
  );
  const walletView = (await invokeFakeFunction(walletOperations.getMine, createCtx(harness.db, 'clerk_buyer'), {
    operationId: topUp.operationId,
  })) as null;
  assert.equal(walletView, null);
});

test('a provider row does not block or confuse a wallet purchase overlap scan', async () => {
  const harness = open();
  (harness.db.tables['orders'] as Row[]).push({
    _id: 'orders|o1',
    orderNumber: 'orders|o1',
    buyerId: 'users|buyer',
    sellerId: 'users|seller',
    items: [
      {
        productId: 'products|lamp',
        title: 'Stale title',
        price: 0.01,
        quantity: 1,
        image: 'https://images.invalid/stale.jpg',
      },
    ],
    subtotal: 0,
    shippingCost: 0,
    platformFee: 0,
    totalAmount: 0,
    sellerPayout: 0,
    shippingAddress: ADDRESS,
    status: 'pending_payment',
    createdAt: 1,
    updatedAt: 1,
  });
  (harness.db.tables['paymentOperations'] as Row[]).push({
    _id: 'paymentOperations|provider1',
    ownerId: 'users|buyer',
    requestId: 'req-provider-other',
    kind: 'top_up_collection',
    status: 'unknown',
    requestIdentity: 'other-identity',
    providerReference: 'TOP-OTHER',
    amountCents: 2500,
    currency: 'ZMW',
    destinationKey: MM_KEY,
    collectionDestination: { phone: PHONE, operator: 'mtn', country: 'zm' },
    createdAt: 1,
    updatedAt: 1,
  });

  const selectors = {
    source: 'pending_orders',
    orderIds: ['orders|o1'],
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  };
  const quote = (await invokeFakeFunction(
    checkoutQuote.quoteCheckout,
    createCtx(harness.db, 'clerk_buyer'),
    selectors,
  )) as {
    ok: boolean;
    quote?: { quoteKey: string; totalAmountCents: number };
  };
  assert.equal(quote.ok, true);
  assert.ok(quote.quote);
  const result = (await invokeFakeFunction(walletOperations.purchaseWithWallet, createCtx(harness.db, 'clerk_buyer'), {
    requestId: 'req-wallet-beside-provider',
    ...selectors,
    expectedQuoteKey: quote.quote.quoteKey,
  })) as { ok: boolean; totalAmountCents?: number };
  assert.equal(result.ok, true);
  assert.equal(result.totalAmountCents, quote.quote.totalAmountCents);
  assert.equal((harness.db.tables['paymentOperations'] as Row[]).length, 2);
  assert.equal(findRow(harness.db, 'paymentOperations', 'paymentOperations|provider1')['status'], 'unknown');
});

// ---- Correction round 1: legacy re-registration must yield a usable resolved row ----

test('a legacy unverified mobile-money row re-registers as a new usable resolved resource', async () => {
  const harness = open();
  (harness.db.tables['paymentAccounts'] as Row[]).push({
    _id: 'paymentAccounts|legacy',
    userId: 'users|buyer',
    type: 'mobile_money',
    mobileMoneyProvider: 'mtn',
    mobileNumber: PHONE,
    isDefault: true,
    isVerified: false,
    createdAt: 1,
    updatedAt: 1,
  });
  (harness.db.tables['paymentAccounts'] as Row[]).push(mmAccountRow('paymentAccounts|foreign', 'users|other'));
  const legacyBefore = structuredClone(findRow(harness.db, 'paymentAccounts', 'paymentAccounts|legacy'));
  const foreignBefore = structuredClone(findRow(harness.db, 'paymentAccounts', 'paymentAccounts|foreign'));

  const registered = (await invokeFakeFunction(registerAction(harness), actionCtx(harness, 'clerk_buyer'), {
    destination: { type: 'mobile_money', phone: PHONE, operator: 'mtn' },
  })) as { accountId: string; destinationKey: string };
  assert.equal(registered.destinationKey, MM_KEY);
  assert.notEqual(registered.accountId, 'paymentAccounts|legacy');

  // Registration resolves but never posts financially.
  assert.ok(harness.calls.every((call) => !call.url.includes('/collections/') && !call.url.includes('/transfers/')));
  assert.equal(harness.calls.filter((call) => call.url.endsWith('/resolve/mobile-money')).length, 1);

  // The legacy and foreign rows are preserved byte-for-byte.
  assert.deepEqual(findRow(harness.db, 'paymentAccounts', 'paymentAccounts|legacy'), legacyBefore);
  assert.deepEqual(findRow(harness.db, 'paymentAccounts', 'paymentAccounts|foreign'), foreignBefore);

  // The fresh row carries the usable resolution marker.
  const created = findRow(harness.db, 'paymentAccounts', registered.accountId);
  assert.equal(created['userId'], 'users|buyer');
  assert.equal(created['isVerified'], true);
  assert.equal(typeof created['providerResolvedAt'], 'number');

  // The fresh resolve unlocks the prescribed withdrawal path over mocked transport.
  const fetchBeforeWithdraw = harness.calls.length;
  const withdrawal = okResult(
    await invokeFakeFunction(withdrawalAction(harness), actionCtx(harness, 'clerk_buyer'), {
      requestId: 'req-re-registered',
      amountCents: 2500,
      paymentAccountId: registered.accountId,
      expectedDestinationKey: MM_KEY,
    }),
  );
  assert.equal(withdrawal.status, 'unknown');
  assert.equal(harness.calls.slice(fetchBeforeWithdraw).filter((call) => call.url.includes('/transfers/')).length, 1);
});

test('a verified-but-unmarked legacy row also re-registers as a new usable resource', async () => {
  const harness = open();
  (harness.db.tables['paymentAccounts'] as Row[]).push({
    _id: 'paymentAccounts|legacy-marked',
    userId: 'users|buyer',
    type: 'mobile_money',
    mobileMoneyProvider: 'mtn',
    mobileNumber: PHONE,
    accountName: 'Test User',
    isDefault: false,
    isVerified: true,
    createdAt: 1,
    updatedAt: 1,
  });
  const legacyBefore = structuredClone(findRow(harness.db, 'paymentAccounts', 'paymentAccounts|legacy-marked'));

  const first = (await invokeFakeFunction(registerAction(harness), actionCtx(harness, 'clerk_buyer'), {
    destination: { type: 'mobile_money', phone: PHONE, operator: 'mtn' },
  })) as { accountId: string; destinationKey: string };
  assert.equal(first.destinationKey, MM_KEY);
  assert.notEqual(first.accountId, 'paymentAccounts|legacy-marked');
  assert.deepEqual(findRow(harness.db, 'paymentAccounts', 'paymentAccounts|legacy-marked'), legacyBefore);

  // Repeating the registration now reuses the already resolved row.
  const second = (await invokeFakeFunction(registerAction(harness), actionCtx(harness, 'clerk_buyer'), {
    destination: { type: 'mobile_money', phone: PHONE, operator: 'mtn' },
  })) as { accountId: string; destinationKey: string };
  assert.equal(second.accountId, first.accountId);
  assert.equal((harness.db.tables['paymentAccounts'] as Row[]).length, 2);

  const withdrawal = okResult(
    await invokeFakeFunction(withdrawalAction(harness), actionCtx(harness, 'clerk_buyer'), {
      requestId: 'req-re-registered-marked',
      amountCents: 2500,
      paymentAccountId: first.accountId,
      expectedDestinationKey: MM_KEY,
    }),
  );
  assert.equal(withdrawal.status, 'unknown');
});

// ---- Correction round 1: conflicting evidence is preserved, never replaced ----

function successfulCollectionFetch(call: FetchCall): Response {
  const args = bodyOf(call);
  return envelope({
    id: COLLECTION_ID,
    reference: args['reference'],
    amount: majorText(args['amount'] as number),
    currency: 'ZMW',
    status: 'successful',
    type: 'mobile-money',
    bearer: 'merchant',
    mobileMoneyDetails: { country: 'zm', operator: args['operator'], phone: args['phone'] },
    reasonForFailure: null,
    settlementStatus: null,
  });
}

test('a mismatching receipt never replaces a bound valid receipt, and retrying the original adds no observation', async () => {
  const harness = open({ collections: successfulCollectionFetch });
  const created = okResult(
    await invokeFakeFunction(topUpAction(harness), actionCtx(harness, 'clerk_buyer'), {
      requestId: 'req-evidence',
      amountCents: 2500,
      phone: PHONE,
      operator: 'mtn',
    }),
  );
  const primary = structuredClone(findRow(harness.db, 'paymentOperations', created.operationId));
  assert.equal((primary['receipt'] as Record<string, unknown>)['status'], 'successful');
  assert.equal(primary['providerId'], COLLECTION_ID);
  const walletsBefore = structuredClone(harness.db.tables['wallets']);
  const ledgerBefore = structuredClone(harness.db.tables['walletTransactions']);
  const companionsBefore = structuredClone(harness.db.tables['transactions']);
  const callsBefore = harness.calls.length;

  const mismatching = {
    ...(primary['receipt'] as Record<string, unknown>),
    id: '55555555-2222-3333-4444-555555555555',
    reference: 'TOP-OTHER',
    amountMinor: 9900,
  };
  await invokeFakeFunction(providerOperations.attachProviderResult, createCtx(harness.db, 'clerk_buyer'), {
    operationId: created.operationId,
    receipt: mismatching,
  });
  const afterMismatch = findRow(harness.db, 'paymentOperations', created.operationId);
  assert.deepEqual(afterMismatch['receipt'], primary['receipt']);
  assert.equal(afterMismatch['providerId'], COLLECTION_ID);
  assert.equal(afterMismatch['reviewNeeded'], true);
  assert.deepEqual(afterMismatch['receiptObservations'], [mismatching]);
  assert.deepEqual(harness.db.tables['wallets'], walletsBefore);
  assert.deepEqual(harness.db.tables['walletTransactions'], ledgerBefore);
  assert.deepEqual(harness.db.tables['transactions'], companionsBefore);

  // Retrying the original valid receipt restores nothing new: it is already primary.
  await invokeFakeFunction(providerOperations.attachProviderResult, createCtx(harness.db, 'clerk_buyer'), {
    operationId: created.operationId,
    receipt: primary['receipt'],
  });
  const afterRetry = findRow(harness.db, 'paymentOperations', created.operationId);
  assert.deepEqual(afterRetry['receipt'], primary['receipt']);
  assert.equal(afterRetry['providerId'], COLLECTION_ID);
  assert.equal(afterRetry['reviewNeeded'], true);
  assert.deepEqual(afterRetry['receiptObservations'], [mismatching]);
  assert.deepEqual(harness.db.tables['wallets'], walletsBefore);
  assert.equal(harness.calls.length, callsBefore);
});

// ---- Correction round 1: receipt terminality is distinct from operation terminality ----

const CHAIN_REFERENCE = 'TOP-CHAIN';

function chainReceipt(status: string, reasonForFailure: string | null, settlementStatus: string | null) {
  return {
    kind: 'collection',
    id: COLLECTION_ID,
    reference: CHAIN_REFERENCE,
    amountMinor: 2500,
    feeMinor: null,
    currency: 'ZMW',
    status,
    collectionType: 'mobile-money',
    country: 'zm',
    bearer: 'merchant',
    operator: 'mtn',
    phone: PHONE,
    reasonForFailure,
    settlementStatus,
  };
}

function seedChainedOperation(harness: Harness, receipt: Record<string, unknown>): string {
  const operationId = `paymentOperations|chain-${harness.db.tables['paymentOperations']?.length ?? 0}`;
  (harness.db.tables['paymentOperations'] as Row[]).push({
    _id: operationId,
    ownerId: 'users|buyer',
    requestId: `req-chain-${operationId}`,
    kind: 'top_up_collection',
    status: 'unknown',
    requestIdentity: `chain-identity-${operationId}`,
    providerReference: CHAIN_REFERENCE,
    amountCents: 2500,
    currency: 'ZMW',
    destinationKey: MM_KEY,
    collectionDestination: { phone: PHONE, operator: 'mtn', country: 'zm' },
    receipt,
    providerId: COLLECTION_ID,
    createdAt: 1,
    updatedAt: 1,
  });
  return operationId;
}

test('terminal receipts never regress to pending: the terminal primary stays and the stale fact is observed', async () => {
  for (const terminal of [chainReceipt('successful', null, null), chainReceipt('failed', 'declined', null)]) {
    const harness = open();
    const operationId = seedChainedOperation(harness, terminal);
    const stale = chainReceipt('pending', null, 'unsettled');
    await invokeFakeFunction(providerOperations.attachProviderResult, createCtx(harness.db, 'clerk_buyer'), {
      operationId,
      receipt: stale,
    });
    const kept = findRow(harness.db, 'paymentOperations', operationId);
    assert.deepEqual(kept['receipt'], terminal);
    assert.equal(kept['providerId'], COLLECTION_ID);
    assert.equal(kept['reviewNeeded'] ?? false, false);
    assert.deepEqual(kept['receiptObservations'], [stale]);
    assert.equal(kept['status'], 'unknown');

    // Repeating the stale pending fact adds no further observation.
    await invokeFakeFunction(providerOperations.attachProviderResult, createCtx(harness.db, 'clerk_buyer'), {
      operationId,
      receipt: stale,
    });
    assert.deepEqual(findRow(harness.db, 'paymentOperations', operationId)['receiptObservations'], [stale]);
  }
});

test('terminal disagreements keep the earlier receipt with review, while pending progression still applies', async () => {
  const successful = chainReceipt('successful', null, null);
  const failed = chainReceipt('failed', 'declined', null);
  const pending = chainReceipt('pending', null, 'unsettled');

  for (const [name, earlier, incoming] of [
    ['successful-kept-over-failed', successful, failed],
    ['failed-kept-over-successful', failed, successful],
  ] as Array<[string, Record<string, unknown>, Record<string, unknown>]>) {
    const harness = open();
    const operationId = seedChainedOperation(harness, earlier);
    await invokeFakeFunction(providerOperations.attachProviderResult, createCtx(harness.db, 'clerk_buyer'), {
      operationId,
      receipt: incoming,
    });
    const kept = findRow(harness.db, 'paymentOperations', operationId);
    assert.deepEqual(kept['receipt'], earlier, name);
    assert.equal(kept['providerId'], COLLECTION_ID, name);
    assert.equal(kept['reviewNeeded'], true, name);
    assert.deepEqual(kept['receiptObservations'], [incoming], name);
  }

  // Task3B1 correction round 2: legitimate pending -> terminal progression
  // preserves the superseded pending facts with the existing
  // retainPriorReceipt helper instead of dropping them. The pending fixture
  // carries distinct fee/settlement/reason facts so the preservation is
  // actually exercised.
  for (const [name, terminal] of [
    ['pending-progresses-to-successful', successful],
    ['pending-progresses-to-failed', failed],
  ] as Array<[string, Record<string, unknown>]>) {
    const priorPending = {
      ...chainReceipt('pending', 'awaiting', 'unsettled'),
      feeMinor: 150,
    };
    const harness = open();
    const walletsBefore = structuredClone(harness.db.tables['wallets']);
    const ledgerBefore = structuredClone(harness.db.tables['walletTransactions']);
    const companionsBefore = structuredClone(harness.db.tables['transactions']);
    const operationId = seedChainedOperation(harness, priorPending);
    await invokeFakeFunction(providerOperations.attachProviderResult, createCtx(harness.db, 'clerk_buyer'), {
      operationId,
      receipt: terminal,
    });
    const progressed = findRow(harness.db, 'paymentOperations', operationId);
    assert.deepEqual(progressed['receipt'], terminal, name);
    assert.equal(progressed['providerId'], COLLECTION_ID, name);
    assert.equal(progressed['reviewNeeded'] ?? false, false, name);
    assert.deepEqual(progressed['receiptObservations'], [priorPending], name);
    assert.equal(progressed['status'], 'unknown', name);
    assert.deepEqual(harness.db.tables['wallets'], walletsBefore, name);
    assert.deepEqual(harness.db.tables['walletTransactions'], ledgerBefore, name);
    assert.deepEqual(harness.db.tables['transactions'], companionsBefore, name);

    // Repeating the terminal receipt changes nothing further.
    await invokeFakeFunction(providerOperations.attachProviderResult, createCtx(harness.db, 'clerk_buyer'), {
      operationId,
      receipt: terminal,
    });
    const repeated = findRow(harness.db, 'paymentOperations', operationId);
    assert.deepEqual(repeated['receipt'], terminal, name);
    assert.deepEqual(repeated['receiptObservations'], [priorPending], name);

    // A later stale replay of the same pending fact adds no duplicate observation.
    await invokeFakeFunction(providerOperations.attachProviderResult, createCtx(harness.db, 'clerk_buyer'), {
      operationId,
      receipt: priorPending,
    });
    const afterStale = findRow(harness.db, 'paymentOperations', operationId);
    assert.deepEqual(afterStale['receipt'], terminal, name);
    assert.deepEqual(afterStale['receiptObservations'], [priorPending], name);
  }

  // Same-terminal enrichment stores the new facts while the previous facts remain observed.
  const enriched = open();
  const enrichedId = seedChainedOperation(enriched, pending);
  const settled = chainReceipt('pending', null, 'settled');
  await invokeFakeFunction(providerOperations.attachProviderResult, createCtx(enriched.db, 'clerk_buyer'), {
    operationId: enrichedId,
    receipt: settled,
  });
  const enrichedRow = findRow(enriched.db, 'paymentOperations', enrichedId);
  assert.deepEqual(enrichedRow['receipt'], settled);
  assert.deepEqual(enrichedRow['receiptObservations'], [pending]);

  // Successful -> successful fee/settlement enrichment preserves the earlier terminal facts too.
  const enrichedTerminal = open();
  const baseSuccessful = chainReceipt('successful', null, null);
  const enrichedSuccessful = {
    ...chainReceipt('successful', null, 'settled'),
    feeMinor: 150,
  };
  const enrichedTerminalId = seedChainedOperation(enrichedTerminal, baseSuccessful);
  await invokeFakeFunction(providerOperations.attachProviderResult, createCtx(enrichedTerminal.db, 'clerk_buyer'), {
    operationId: enrichedTerminalId,
    receipt: enrichedSuccessful,
  });
  const enrichedTerminalRow = findRow(enrichedTerminal.db, 'paymentOperations', enrichedTerminalId);
  assert.deepEqual(enrichedTerminalRow['receipt'], enrichedSuccessful);
  assert.deepEqual(enrichedTerminalRow['receiptObservations'], [baseSuccessful]);
});

// ---- Correction round 1: withdrawal ambiguity and attach-boundary evidence ----

test('a mobile-money withdrawal over an HTTP failure retains exactly one pending debit and replays without a second POST', async () => {
  const harness = open({ transfersMm: () => new Response('bad gateway', { status: 502 }) });
  const accountId = await registerMm(harness, 'clerk_buyer');
  const args = {
    requestId: 'req-ambiguous-mm',
    amountCents: 2500,
    paymentAccountId: accountId,
    expectedDestinationKey: MM_KEY,
  };
  const result = okResult(await invokeFakeFunction(withdrawalAction(harness), actionCtx(harness, 'clerk_buyer'), args));
  assert.equal(result.status, 'unknown');
  assert.match(result.providerReference, /^WDR-MM-/);

  const operation = findRow(harness.db, 'paymentOperations', result.operationId);
  assert.equal(operation['status'], 'unknown');
  assert.equal(operation['receipt'], undefined);
  assert.equal(typeof operation['failureCode'], 'string');

  const debits = harness.db.tables['walletTransactions'] as Row[];
  assert.equal(debits.length, 1);
  assert.equal(debits[0]?.['status'], 'pending');
  assert.equal(centsOf(debits[0]?.['amount']), 2500);
  assert.equal(debits[0]?.['operationId'], result.operationId);

  const wallet = findRow(harness.db, 'wallets', 'wallets|users|buyer');
  assert.equal(centsOf(wallet['balance']), 100000 - 2500);
  assert.equal(centsOf(wallet['totalWithdrawn']), 2500);
  assert.equal(centsOf(wallet['pendingBalance']), 0);
  assert.equal(centsOf(wallet['totalSpent']), 0);
  assert.equal(centsOf(wallet['totalEarned']), 100000);

  const replayed = okResult(
    await invokeFakeFunction(withdrawalAction(harness), actionCtx(harness, 'clerk_buyer'), args),
  );
  assert.deepEqual(replayed, result);
  assert.equal(harness.calls.filter((call) => call.url.includes('/transfers/')).length, 1);
  assert.equal((harness.db.tables['walletTransactions'] as Row[]).length, 1);
});

test('a bank withdrawal over a malformed response retains exactly one pending debit and replays without a second POST', async () => {
  const harness = open({ transfersBank: () => new Response('not json', { status: 200 }) });
  const registered = (await invokeFakeFunction(registerAction(harness), actionCtx(harness, 'clerk_buyer'), {
    destination: { type: 'bank_account', bankId: 'bank-1', accountNumber: '1234567890' },
  })) as { accountId: string; destinationKey: string };
  const args = {
    requestId: 'req-ambiguous-bank',
    amountCents: 10000,
    paymentAccountId: registered.accountId,
    expectedDestinationKey: BANK_KEY,
  };
  const result = okResult(await invokeFakeFunction(withdrawalAction(harness), actionCtx(harness, 'clerk_buyer'), args));
  assert.equal(result.status, 'unknown');
  assert.match(result.providerReference, /^WDR-BK-/);

  const debits = harness.db.tables['walletTransactions'] as Row[];
  assert.equal(debits.length, 1);
  assert.equal(debits[0]?.['source'], 'withdrawal_bank');
  assert.equal(centsOf(debits[0]?.['amount']), 10000);

  const wallet = findRow(harness.db, 'wallets', 'wallets|users|buyer');
  assert.equal(centsOf(wallet['balance']), 100000 - 10000);
  assert.equal(centsOf(wallet['totalWithdrawn']), 10000);

  const replayed = okResult(
    await invokeFakeFunction(withdrawalAction(harness), actionCtx(harness, 'clerk_buyer'), args),
  );
  assert.deepEqual(replayed, result);
  assert.equal(harness.calls.filter((call) => call.url.includes('/transfers/')).length, 1);
  assert.equal((harness.db.tables['walletTransactions'] as Row[]).length, 1);
});

test('an accepted POST followed by a failing settlement heals on reuse without a second POST or new debit', async () => {
  const harness = open();
  const accountId = await registerMm(harness, 'clerk_buyer');
  let attachShouldFail = true;
  const flakyAttach = internalMutation({
    args: {
      operationId: v.id('paymentOperations'),
      receipt: providerReceiptValidator,
      acquisition: receiptAcquisitionValidator,
    },
    returns: settlementResultValidator,
    handler: async (ctx, args) => {
      if (attachShouldFail) {
        attachShouldFail = false;
        throw new Error('attach boundary exploded');
      }
      const delegate = handlerOf(providerSettlement.settleProviderReceipt) as (
        ctx: unknown,
        args: unknown,
      ) => Promise<SettlementResult>;
      return await delegate(ctx, args);
    },
  });
  const modules = {
    providerOperations: { ...providerOperations },
    providerSettlement: { ...providerSettlement, settleProviderReceipt: flakyAttach },
  };
  const args = {
    requestId: 'req-attach-fails',
    amountCents: 2500,
    paymentAccountId: accountId,
    expectedDestinationKey: MM_KEY,
  };
  await assert.rejects(
    () =>
      invokeFakeFunction(
        withdrawalAction(harness),
        createFakeActionCtx({ db: harness.db, subject: 'clerk_buyer', modules }),
        args,
      ),
    /attach boundary exploded/,
  );

  // Persistence and claim already committed: one attempted operation, one pending debit, one POST.
  const operations = harness.db.tables['paymentOperations'] as Row[];
  assert.equal(operations.length, 1);
  const stranded = operations[0] as Row;
  assert.equal(stranded['status'], 'attempted');
  const reference = stranded['providerReference'] as string;
  assert.match(reference, /^WDR-MM-/);
  assert.equal((harness.db.tables['walletTransactions'] as Row[]).length, 1);
  assert.equal(harness.calls.filter((call) => call.url.includes('/transfers/')).length, 1);

  // The same request heals with no second POST, debit, or row.
  const healed = okResult(
    await invokeFakeFunction(
      withdrawalAction(harness),
      createFakeActionCtx({ db: harness.db, subject: 'clerk_buyer', modules }),
      args,
    ),
  );
  assert.equal(healed.operationId, stranded['_id']);
  assert.equal(healed.status, 'unknown');
  assert.equal(healed.providerReference, reference);
  assert.equal(harness.calls.filter((call) => call.url.includes('/transfers/')).length, 1);
  assert.equal((harness.db.tables['paymentOperations'] as Row[]).length, 1);
  assert.equal((harness.db.tables['walletTransactions'] as Row[]).length, 1);
  assert.equal(findRow(harness.db, 'paymentOperations', stranded['_id'] as string)['status'], 'unknown');
});

test('registration completion rejects a banned owner and a changed subject with no account writes', async () => {
  const harness = open();
  const before = snapshot(harness.db);

  // A delayed completion after the owner is banned: the re-checked subject denies the write.
  findRow(harness.db, 'users', 'users|buyer')['isBanned'] = true;
  await assert.rejects(
    () =>
      invokeFakeFunction(providerOperations.storePaymentAccount, createCtx(harness.db, 'clerk_buyer'), {
        expectedUserId: 'users|buyer',
        type: 'mobile_money',
        phone: PHONE,
        operator: 'mtn',
        accountName: 'Test User',
      }),
    /banned/,
  );
  findRow(harness.db, 'users', 'users|buyer')['isBanned'] = false;

  // A changed authenticated subject at the inner boundary cannot complete another owner's registration.
  await assert.rejects(
    () =>
      invokeFakeFunction(providerOperations.storePaymentAccount, createCtx(harness.db, 'clerk_other'), {
        expectedUserId: 'users|buyer',
        type: 'mobile_money',
        phone: PHONE,
        operator: 'mtn',
        accountName: 'Test User',
      }),
    /Unauthorized/,
  );

  assert.deepEqual(harness.db.tables, before);
  assert.equal(harness.calls.length, 0);
});

// Task4A: observable terminal receipt accounting through the existing action.
test('Task4A successful top-up POST credits gross once and recovers without another POST', async () => {
  const harness = open({
    collections: (call) =>
      envelope({
        id: COLLECTION_ID,
        reference: bodyOf(call)['reference'],
        amount: '25',
        fee: '0.50',
        currency: 'ZMW',
        status: 'successful',
        type: 'mobile-money',
        bearer: 'merchant',
        mobileMoneyDetails: { country: 'zm', operator: 'mtn', phone: PHONE },
        reasonForFailure: null,
        settlementStatus: null,
      }),
  });
  const args = { requestId: 'task4a-topup', amountCents: 2500, phone: PHONE, operator: 'mtn' };
  const first = okResult(await invokeFakeFunction(topUpAction(harness), actionCtx(harness, 'clerk_buyer'), args));
  assert.equal(first.status, 'succeeded');
  assert.equal(findRow(harness.db, 'wallets', 'wallets|users|buyer')['balance'], 1025);
  assert.equal(harness.db.tables['walletTransactions']?.length, 1);
  const second = okResult(await invokeFakeFunction(topUpAction(harness), actionCtx(harness, 'clerk_buyer'), args));
  assert.equal(second.status, 'succeeded');
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.db.tables['walletTransactions']?.length, 1);
});

test('Task4A failed withdrawal POST reverses only the original reserved gross once', async () => {
  const harness = open({
    transfersMm: (call) =>
      envelope({
        id: TRANSFER_ID,
        reference: bodyOf(call)['reference'],
        amount: '25',
        fee: '0.50',
        currency: 'ZMW',
        status: 'failed',
        accountId: DEBIT_UUID,
        creditAccount: { type: 'mobile-money', country: 'zm', operator: 'mtn', phone: PHONE },
        reasonForFailure: 'declined',
        settlementStatus: null,
      }),
  });
  harness.db.tables['paymentAccounts'] = [mmAccountRow('paymentAccounts|mm1', 'users|buyer')];
  const args = {
    requestId: 'task4a-withdraw',
    amountCents: 2500,
    paymentAccountId: 'paymentAccounts|mm1',
    expectedDestinationKey: MM_KEY,
  };
  const first = okResult(await invokeFakeFunction(withdrawalAction(harness), actionCtx(harness, 'clerk_buyer'), args));
  assert.equal(first.status, 'failed');
  assert.equal(findRow(harness.db, 'wallets', 'wallets|users|buyer')['balance'], 1000);
  assert.equal(findRow(harness.db, 'wallets', 'wallets|users|buyer')['totalWithdrawn'], 0);
  assert.equal(harness.db.tables['walletTransactions']?.length, 2);
  const second = okResult(await invokeFakeFunction(withdrawalAction(harness), actionCtx(harness, 'clerk_buyer'), args));
  assert.equal(second.status, 'failed');
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.db.tables['walletTransactions']?.length, 2);
});
