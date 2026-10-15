import assert from 'node:assert/strict';
import test from 'node:test';
import * as providerOperations from './providerOperations';
import * as providerSettlement from './providerSettlement';
import * as users from './users';
import { createLencoAdapter, type LencoFetch } from './lib/lencoAdapter';
import type { ProviderReceiptFacts } from './lib/providerOperationContracts';
import { createFakeActionCtx, invokeFakeFunction } from '../tests/support/convexFakeActionCtx';
import { createCtx, createDb, handlerOf, type Db, type Row } from '../tests/support/convexFakeDb';

const OWNER = 'users|buyer';
const PHONE = '0971234567';
const ID = '22222222-2222-3333-4444-555555555555';
const OTHER_ID = '44444444-2222-3333-4444-555555555555';
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

function receipt(operation: Row, status: 'successful' | 'failed' | 'pending' = 'successful'): ProviderReceiptFacts {
  // Fixture originates from the actual action/accepted adapter's typed receipt.
  return { ...(operation['receipt'] as ProviderReceiptFacts), status };
}

async function settle(
  db: Db,
  operation: Row,
  value: ProviderReceiptFacts = receipt(operation),
  acquisition?: unknown,
): Promise<unknown> {
  return await invokeFakeFunction(providerSettlement.settleProviderReceipt, createCtx(db, null), {
    operationId: operation._id,
    receipt: value,
    acquisition: acquisition ?? {
      kind: 'status_get',
      lookup: { kind: 'reference', reference: String(operation['providerReference']) },
    },
  });
}

function money(db: Db): unknown {
  return structuredClone({
    wallets: db.tables['wallets'],
    ledger: db.tables['walletTransactions'],
    companions: db.tables['transactions'],
  });
}

for (const kind of ['topup', 'mm', 'bank'] as const) {
  for (const status of ['successful', 'failed'] as const) {
    test(`${kind} real initiation ${status}: conserved gross/counters, reciprocal outcome and exact duplicate`, async () => {
      const db = fixture();
      const operation = await initiate(db, kind, status);
      assert.equal(operation['status'], status === 'successful' ? 'succeeded' : 'failed');
      const wallet = row(db, 'wallets');
      assert.equal(
        wallet['balance'],
        kind === 'topup' ? (status === 'successful' ? 125 : 100) : status === 'successful' ? 75 : 100,
      );
      assert.equal(wallet['totalWithdrawn'], kind !== 'topup' && status === 'successful' ? 25 : 0);
      assert.equal(wallet['pendingBalance'], 3);
      assert.equal(wallet['totalEarned'], 7);
      assert.equal(wallet['totalSpent'], 9);
      assert.equal(
        db.tables['walletTransactions']?.length,
        kind === 'topup' ? (status === 'successful' ? 1 : 0) : status === 'failed' ? 2 : 1,
      );
      const before = money(db);
      await settle(db, operation, receipt(operation, status));
      await settle(db, operation, { ...receipt(operation, status), settlementStatus: 'settled', feeMinor: 99 });
      assert.deepEqual(money(db), before);
      assert.equal(operation['reviewNeeded'], undefined);
      assert.ok((operation['receiptObservations'] as unknown[]).length > 0);
      const mine = await invokeFakeFunction(providerOperations.getMine, createCtx(db, 'buyer'), {
        operationId: operation._id,
      });
      assert.equal((mine as Record<string, unknown>)['status'], operation['status']);
    });
  }
}

test('settler is registered INTERNAL with root object args, no actor/public authority, strict receipt shape', async () => {
  const fn = providerSettlement.settleProviderReceipt as unknown as {
    isInternal: boolean;
    isMutation: boolean;
    exportArgs: () => string;
  };
  assert.equal(fn.isInternal, true);
  assert.equal(fn.isMutation, true);
  assert.equal(JSON.parse(fn.exportArgs()).type, 'object');
  const db = fixture();
  const operation = await initiate(db);
  for (const extra of [{ verified: true }, { ownerId: OWNER }, { fee: 0 }]) {
    await assert.rejects(
      () =>
        invokeFakeFunction(providerSettlement.settleProviderReceipt, createCtx(db, null), {
          operationId: operation._id,
          receipt: receipt(operation),
          acquisition: { kind: 'initiation_post', operationId: operation._id },
          ...extra,
        }),
      /Argument validation failed/,
    );
  }
  await assert.rejects(
    () =>
      invokeFakeFunction(providerSettlement.settleProviderReceipt, createCtx(db, null), {
        operationId: operation._id,
        receipt: { ...receipt(operation), raw: 'payload' },
        acquisition: { kind: 'initiation_post', operationId: operation._id },
      }),
    /Argument validation failed/,
  );
});

for (const first of ['successful', 'failed'] as const) {
  test(`terminal ${first} then opposite retains all evidence with no repeat money (both winner orderings)`, async () => {
    for (const kind of ['topup', 'mm', 'bank'] as const) {
      const db = fixture();
      const operation = await initiate(db, kind);
      await settle(db, operation, receipt(operation, first));
      const before = money(db);
      await settle(db, operation, receipt(operation, first === 'successful' ? 'failed' : 'successful'));
      await settle(db, operation, receipt(operation, first));
      assert.deepEqual(money(db), before);
      assert.equal(operation['reviewNeeded'], true);
      assert.equal(operation['status'], first === 'successful' ? 'succeeded' : 'failed');
      assert.ok((operation['receiptObservations'] as unknown[]).length >= 2);
      if (kind === 'topup') {
        assert.ok(operation['receivedFunds']);
      }
      await assert.rejects(
        () => invokeFakeFunction(providerOperations.getMine, createCtx(db, 'buyer'), { operationId: operation._id }),
        /review/,
      );
    }
  });
}

test('ordinary attachment retains late mismatch and different ID after accounting without applying or erasing proof', async () => {
  const db = fixture();
  const operation = await initiate(db, 'topup', 'successful');
  const before = money(db);
  const proof = structuredClone(operation['accounting']);
  await invokeFakeFunction(providerOperations.attachProviderResult, createCtx(db, null), {
    operationId: operation._id,
    receipt: { ...receipt(operation), id: OTHER_ID },
  });
  await invokeFakeFunction(providerOperations.attachProviderResult, createCtx(db, null), {
    operationId: operation._id,
    receipt: { ...receipt(operation), amountMinor: 1 },
  });
  await invokeFakeFunction(providerOperations.markUnknown, createCtx(db, null), { operationId: operation._id });
  assert.deepEqual(money(db), before);
  assert.deepEqual(operation['accounting'], proof);
  assert.equal(operation['providerId'], ID);
  assert.equal(operation['status'], 'succeeded');
  assert.equal(operation['reviewNeeded'], true);
  assert.equal((operation['receiptObservations'] as unknown[]).length, 2);
});

const wrongReceipts: Array<[string, (value: ProviderReceiptFacts) => ProviderReceiptFacts]> = [
  ['reference', (value) => ({ ...value, reference: 'TOP-wrong' })],
  ['null reference', (value) => ({ ...value, reference: null })],
  ['amount', (value) => ({ ...value, amountMinor: 2501 })],
  ['unsafe amount', (value) => ({ ...value, amountMinor: Number.MAX_SAFE_INTEGER + 1 })],
  ['invalid ID', (value) => ({ ...value, id: 'invalid' })],
  ['different bound ID', (value) => ({ ...value, id: OTHER_ID })],
  ['collection destination', (value) => (value.kind === 'collection' ? { ...value, phone: '0970000000' } : value)],
];
for (const [name, corrupt] of wrongReceipts) {
  test(`wrong ${name} holds with sticky review and no financial writes`, async () => {
    const db = fixture();
    const operation = await initiate(db);
    const before = money(db);
    await settle(db, operation, corrupt(receipt(operation)));
    assert.deepEqual(money(db), before);
    assert.equal(operation['reviewNeeded'], true);
    await settle(db, operation);
    assert.deepEqual(money(db), before);
  });
}

for (const acquisition of [
  { kind: 'initiation_post', operationId: 'paymentOperations|wrong' },
  { kind: 'status_get', lookup: { kind: 'reference', reference: 'TOP-wrong' } },
  { kind: 'status_get', lookup: { kind: 'provider_id', providerId: OTHER_ID } },
] as const) {
  test(`wrong acquisition ${JSON.stringify(acquisition)} cannot apply funds`, async () => {
    const db = fixture();
    const operation = await initiate(db);
    const before = money(db);
    await settle(db, operation, receipt(operation), acquisition);
    assert.deepEqual(money(db), before);
    assert.equal(operation['reviewNeeded'], true);
  });
}

for (const provenance of ['reference', 'provider_id', 'post', 'webhook'] as const) {
  test(`MM null country only succeeds for trusted GET: ${provenance}`, async () => {
    const db = fixture();
    const operation = await initiate(db, 'mm');
    const prior = receipt(operation);
    assert.equal(prior.kind, 'transfer');
    if (prior.kind !== 'transfer' || prior.destination.kind !== 'mobile-money') {
      throw new Error('fixture');
    }
    const value: ProviderReceiptFacts = { ...prior, destination: { ...prior.destination, country: null } };
    const acquisition =
      provenance === 'post'
        ? { kind: 'initiation_post', operationId: operation._id }
        : provenance === 'webhook'
          ? { kind: 'signed_webhook', eventId: 'verified-fixture-event' }
          : {
              kind: 'status_get',
              lookup:
                provenance === 'reference'
                  ? { kind: 'reference', reference: String(operation['providerReference']) }
                  : { kind: 'provider_id', providerId: ID },
            };
    const before = money(db);
    await settle(db, operation, value, acquisition);
    if (provenance === 'post' || provenance === 'webhook') {
      assert.deepEqual(money(db), before);
      assert.equal(operation['reviewNeeded'], true);
    } else {
      assert.equal(operation['status'], 'succeeded');
      assert.equal(row(db, 'walletTransactions')['status'], 'completed');
    }
  });
}

test('actual intercepted status GET adapter normalizes absent MM country and its real lookup permits completion', async () => {
  const db = fixture();
  const operation = await initiate(db, 'mm');
  const calls: string[] = [];
  const adapter = createLencoAdapter({ apiKey: ENV.LENCO_API_KEY, debitAccountId: DEBIT }, async (url, init) => {
    calls.push(String(url));
    assert.equal(init?.method, 'GET');
    return envelope({
      id: ID,
      reference: operation['providerReference'],
      amount: '25',
      fee: '0.70',
      currency: 'ZMW',
      status: 'successful',
      accountId: DEBIT,
      creditAccount: { type: 'mobile-money', phone: PHONE, operator: 'mtn' },
      reasonForFailure: null,
      settlementStatus: null,
    });
  });
  const result = await adapter.getTransferByReference(String(operation['providerReference']));
  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error('adapter fixture failed');
  }
  assert.equal(result.value.destination.kind === 'mobile-money' && result.value.destination.country, null);
  await settle(db, operation, result.value as ProviderReceiptFacts);
  assert.equal(operation['status'], 'succeeded');
  assert.equal(calls.length, 1);
});

for (const name of [
  'duplicate wallet',
  'malformed wallet',
  'absent banned owner',
  'absent deleted owner',
  'missing owner',
  'companion successful',
  'duplicate companion',
  'foreign credit',
  'competing provider operation',
  'legacy collection provider ID',
] as const) {
  test(`matching received top-up funds held for ${name}, no synthetic balance or financial partial writes`, async () => {
    const db = fixture();
    const operation = await initiate(db);
    if (name === 'duplicate wallet') {
      db.tables['wallets']?.push({ ...row(db, 'wallets'), _id: 'wallets|duplicate' });
    }
    if (name === 'malformed wallet') {
      row(db, 'wallets')['balance'] = 1.001;
    }
    if (name.startsWith('absent')) {
      db.tables['wallets'] = [];
      row(db, 'users')[name === 'absent banned owner' ? 'isBanned' : 'deletedAt'] = true;
    }
    if (name === 'missing owner') {
      db.tables['users'] = [];
      db.tables['wallets'] = [];
    }
    if (name === 'companion successful') {
      row(db, 'transactions')['status'] = 'successful';
    }
    if (name === 'duplicate companion') {
      db.tables['transactions']?.push({ ...row(db, 'transactions'), _id: 'transactions|duplicate' });
    }
    if (name === 'foreign credit') {
      db.tables['walletTransactions']?.push({
        _id: 'walletTransactions|foreign',
        reference: operation['providerReference'],
        externalReference: ID,
        userId: 'users|other',
        amount: 25,
        type: 'credit',
      });
    }
    if (name === 'competing provider operation') {
      db.tables['paymentOperations']?.push({
        ...operation,
        _id: 'paymentOperations|foreign',
        ownerId: 'users|other',
        providerReference: 'TOP-other',
        providerId: ID,
      });
    }
    if (name === 'legacy collection provider ID') {
      db.tables['transactions']?.push({
        ...row(db, 'transactions'),
        _id: 'transactions|legacy',
        reference: 'TOP-other',
        operationId: undefined,
        lencoCollectionId: ID,
        status: 'successful',
      });
    }
    const before = money(db);
    await settle(db, operation);
    assert.deepEqual(money(db), before);
    assert.equal(operation['reviewNeeded'], true);
    assert.equal((operation['receivedFunds'] as { receipt: ProviderReceiptFacts }).receipt.status, 'successful');
    assert.equal(operation['accounting'], undefined);
  });
}

test('active actual owner with absent wallet gets only positively funded first wallet', async () => {
  const db = fixture();
  db.tables['wallets'] = [];
  const operation = await initiate(db);
  assert.equal(db.tables['wallets'].length, 0);
  await settle(db, operation);
  assert.equal(row(db, 'wallets')['balance'], 25);
  assert.equal(row(db, 'wallets')['totalEarned'], 0);
  assert.equal(row(db, 'wallets')['pendingBalance'], 0);
});

test('real Clerk anonymization clears companion phone/metadata, owed frozen wallet still receives gross without rehydration', async () => {
  const db = fixture();
  const operation = await initiate(db);
  await invokeFakeFunction(users.anonymizeDeletedUserByClerkId, createCtx(db, null), { clerkId: 'buyer' });
  const companion = row(db, 'transactions');
  assert.equal(companion['mobileNumber'], undefined);
  assert.equal(companion['metadata'], undefined);
  const wallet = row(db, 'wallets');
  wallet['isActive'] = false;
  wallet['isFrozen'] = true;
  wallet['freezeReason'] = 'deleted';
  row(db, 'appConfig')['paymentsEnabled'] = false;
  await settle(db, operation);
  assert.equal(operation['status'], 'succeeded');
  assert.equal(wallet['balance'], 125);
  assert.equal(wallet['isActive'], false);
  assert.equal(wallet['isFrozen'], true);
  assert.equal(wallet['freezeReason'], 'deleted');
  assert.equal(companion['mobileNumber'], undefined);
  assert.equal(companion['metadata'], undefined);
});

for (const name of [
  'missing wallet',
  'duplicate wallet',
  'underflow',
  'lossy balance',
  'wrong debit source',
  'wrong debit owner',
  'wrong balanceAfter',
  'wrong payment account',
  'legacy completed',
  'legacy reversal',
] as const) {
  test(`failed withdrawal ${name} keeps the reservation and no partial money`, async () => {
    const db = fixture();
    const operation = await initiate(db, 'mm');
    const wallet = row(db, 'wallets');
    const debit = row(db, 'walletTransactions');
    if (name === 'missing wallet') {
      db.tables['wallets'] = [];
    }
    if (name === 'duplicate wallet') {
      db.tables['wallets']?.push({ ...wallet, _id: 'wallets|duplicate' });
    }
    if (name === 'underflow') {
      wallet['totalWithdrawn'] = 24.99;
    }
    if (name === 'lossy balance') {
      wallet['balance'] = 0.001;
    }
    if (name === 'wrong debit source') {
      debit['source'] = 'purchase';
    }
    if (name === 'wrong debit owner') {
      debit['userId'] = 'users|other';
    }
    if (name === 'wrong balanceAfter') {
      debit['balanceAfter'] = 1;
    }
    if (name === 'wrong payment account') {
      debit['paymentAccountId'] = 'paymentAccounts|other';
    }
    if (name === 'legacy completed') {
      debit['status'] = 'completed';
    }
    if (name === 'legacy reversal') {
      db.tables['walletTransactions']?.push({
        ...debit,
        _id: 'walletTransactions|legacy',
        type: 'credit',
        source: 'withdrawal_reversal',
        status: 'completed',
      });
    }
    const before = money(db);
    await settle(db, operation, receipt(operation, 'failed'));
    assert.deepEqual(money(db), before);
    assert.equal(operation['reviewNeeded'], true);
  });
}

for (const kind of ['mm', 'bank'] as const) {
  for (const status of ['failed', 'successful'] as const) {
    test(`${kind} ${status} after real owner deletion holds novel withdrawal accounting and preserves reservation`, async () => {
      const db = fixture();
      const operation = await initiate(db, kind);
      await invokeFakeFunction(users.deleteUser, createCtx(db, null), { userId: OWNER, clerkId: 'buyer' });
      assert.equal(db.tables['users']?.length, 0);
      assert.equal(row(db, 'wallets')['balance'], 75);
      assert.equal(row(db, 'wallets')['totalWithdrawn'], 25);
      assert.equal(row(db, 'walletTransactions')['status'], 'pending');
      assert.equal(operation['accounting'], undefined);
      const before = money(db);
      const value = receipt(operation, status);
      const acquisition = {
        kind: 'status_get',
        lookup: { kind: 'reference', reference: String(operation['providerReference']) },
      };
      const result = await settle(db, operation, value, acquisition);
      assert.deepEqual(money(db), before);
      assert.deepEqual(result, { operationId: operation._id, status: 'unknown', application: 'review' });
      assert.equal(operation['status'], 'unknown');
      assert.equal(operation['reviewNeeded'], true);
      assert.equal(operation['accounting'], undefined);
      assert.equal(operation['receivedFunds'], undefined);
      assert.equal(operation['providerId'], ID);
      assert.deepEqual(operation['receipt'], value);
      assert.equal((operation['acquisitions'] as unknown[]).length, 2);
      assert.deepEqual((operation['acquisitions'] as unknown[])[1], { receipt: value, acquisition });
      await settle(db, operation, value, acquisition);
      assert.deepEqual(money(db), before);
      assert.equal((operation['acquisitions'] as unknown[]).length, 2);
      assert.equal(operation['accounting'], undefined);
      assert.equal(db.tables['users']?.length, 0);
    });

    test(`${kind} ${status} after real Clerk anonymization honors banned tombstone owed funds without restoring access`, async () => {
      const db = fixture();
      const operation = await initiate(db, kind);
      await invokeFakeFunction(users.anonymizeDeletedUserByClerkId, createCtx(db, null), { clerkId: 'buyer' });
      const owner = row(db, 'users', OWNER);
      assert.equal(owner['isDeleted'], true);
      assert.equal(owner['isBanned'], true);
      assert.equal(owner['firstName'], 'Deleted');
      assert.equal(owner['lastName'], 'User');
      assert.equal(owner['email'], `deleted-${OWNER}@deleted.gettitonline.local`);
      assert.equal(db.tables['paymentAccounts']?.length, 0);
      const anonymized = structuredClone(owner);
      const wallet = row(db, 'wallets');
      assert.equal(wallet['isActive'], false);
      assert.equal(wallet['isFrozen'], true);
      assert.equal(wallet['freezeReason'], 'Account deleted');
      row(db, 'appConfig')['paymentsEnabled'] = false;
      const result = await settle(db, operation, receipt(operation, status));
      assert.deepEqual(result, {
        operationId: operation._id,
        status: status === 'failed' ? 'failed' : 'succeeded',
        application: 'applied',
      });
      assert.equal(wallet['balance'], status === 'failed' ? 100 : 75);
      assert.equal(wallet['totalWithdrawn'], status === 'failed' ? 0 : 25);
      assert.equal(wallet['pendingBalance'], 3);
      assert.equal(wallet['totalEarned'], 7);
      assert.equal(wallet['totalSpent'], 9);
      assert.equal(wallet['isActive'], false);
      assert.equal(wallet['isFrozen'], true);
      assert.equal(wallet['freezeReason'], 'Account deleted');
      assert.equal(operation['reviewNeeded'], undefined);
      const debit = row(db, 'walletTransactions', String(operation['walletTransactionId']));
      assert.equal(debit['status'], status === 'failed' ? 'failed' : 'completed');
      assert.equal(debit['amount'], 25);
      assert.equal(debit['externalReference'], ID);
      const accounting = operation['accounting'] as Record<string, unknown>;
      assert.equal(accounting['kind'], status === 'failed' ? 'withdrawal_reversed' : 'withdrawal_completed');
      assert.equal(accounting['debitId'], debit._id);
      assert.equal(db.tables['walletTransactions']?.length, status === 'failed' ? 2 : 1);
      assert.equal(db.tables['transactions']?.length, 0);
      if (status === 'failed') {
        const reversal = row(db, 'walletTransactions', String(accounting['reversalId']));
        assert.equal(reversal['source'], 'withdrawal_reversal');
        assert.equal(reversal['status'], 'completed');
        assert.equal(reversal['reversalOfId'], debit._id);
        assert.equal(reversal['operationId'], operation._id);
        assert.equal(reversal['userId'], OWNER);
        assert.equal(reversal['amount'], 25);
        assert.equal(reversal['balanceAfter'], 100);
      }
      const appliedMoney = money(db);
      const appliedProof = structuredClone(accounting);
      await settle(db, operation, receipt(operation, status));
      assert.deepEqual(money(db), appliedMoney);
      assert.deepEqual(operation['accounting'], appliedProof);
      assert.deepEqual(row(db, 'users', OWNER), anonymized);
      assert.equal(db.tables['paymentAccounts']?.length, 0);
      assert.equal(row(db, 'appConfig')['paymentsEnabled'], false);
    });

    test(`${kind} already-applied ${status} survives real owner deletion and harmless receipt replay without rewriting history`, async () => {
      const db = fixture();
      const operation = await initiate(db, kind, status);
      const proof = structuredClone(operation['accounting']);
      const originalAcquisitions = structuredClone(operation['acquisitions']) as unknown[];
      await invokeFakeFunction(users.deleteUser, createCtx(db, null), { userId: OWNER, clerkId: 'buyer' });
      assert.equal(db.tables['users']?.length, 0);
      const before = money(db);
      const result = await settle(db, operation, receipt(operation, status));
      assert.deepEqual(result, {
        operationId: operation._id,
        status: status === 'failed' ? 'failed' : 'succeeded',
        application: 'applied',
      });
      assert.deepEqual(money(db), before);
      assert.deepEqual(operation['accounting'], proof);
      assert.equal(operation['reviewNeeded'], undefined);
      assert.deepEqual(
        (operation['acquisitions'] as unknown[]).slice(0, originalAcquisitions.length),
        originalAcquisitions,
      );
      assert.equal((operation['acquisitions'] as unknown[]).length, originalAcquisitions.length + 1);
      await settle(db, operation, receipt(operation, status));
      assert.deepEqual(money(db), before);
      assert.deepEqual(operation['accounting'], proof);
      assert.equal((operation['acquisitions'] as unknown[]).length, originalAcquisitions.length + 1);
      assert.equal(operation['reviewNeeded'], undefined);
      assert.equal(db.tables['users']?.length, 0);
    });
  }
}

for (const kind of ['mm', 'bank'] as const) {
  test(`${kind} reversal uses frozen payout after account erasure and intervening wallet activity`, async () => {
    const db = fixture();
    const operation = await initiate(db, kind);
    db.tables['paymentAccounts'] = [];
    row(db, 'wallets')['balance'] = 81;
    row(db, 'wallets')['isFrozen'] = true;
    row(db, 'wallets')['isActive'] = false;
    await settle(db, operation, receipt(operation, 'failed'));
    assert.equal(row(db, 'wallets')['balance'], 106);
    assert.equal(row(db, 'wallets')['totalWithdrawn'], 0);
    assert.equal(row(db, 'wallets')['isFrozen'], true);
    assert.equal(row(db, 'wallets')['isActive'], false);
  });
}

for (const name of [
  'no marker',
  'missing effect',
  'wrong effect',
  'wrong proof receipt',
  'missing acquisition',
  'duplicate effect',
] as const) {
  test(`applied top-up ${name} cannot recover from bare terminal status or apply again`, async () => {
    const db = fixture();
    const operation = await initiate(db, 'topup', 'successful');
    if (name === 'no marker') {
      delete operation['accounting'];
    }
    if (name === 'missing effect') {
      db.tables['walletTransactions'] = [];
    }
    if (name === 'wrong effect') {
      row(db, 'walletTransactions')['amount'] = 26;
    }
    if (name === 'wrong proof receipt') {
      (operation['accounting'] as { receipt: ProviderReceiptFacts }).receipt.amountMinor = 2600;
    }
    if (name === 'missing acquisition') {
      delete operation['acquisitions'];
    }
    if (name === 'duplicate effect') {
      db.tables['walletTransactions']?.push({ ...row(db, 'walletTransactions'), _id: 'walletTransactions|dup' });
    }
    const before = money(db);
    await assert.rejects(
      () => invokeFakeFunction(providerOperations.getMine, createCtx(db, 'buyer'), { operationId: operation._id }),
      /review/,
    );
    await settle(db, operation);
    assert.deepEqual(money(db), before);
    assert.equal(operation['reviewNeeded'], true);
  });
}

for (const commit of [false, true]) {
  test(`lost settlement response ${commit ? 'after' : 'before'} commit: same-request recovery never posts or credits again`, async () => {
    const db = fixture();
    let posts = 0;
    const base = transport('successful');
    const action = providerOperations.createTopUpAction({
      env: () => ENV,
      fetchImpl: async (...args) => {
        posts++;
        return await base(...args);
      },
    });
    // Wrap only the unavoidable lost-response boundary; execute the actual
    // registered writer when commit=true, never fabricate financial effects.
    const real = providerSettlement.settleProviderReceipt;
    const lost = {
      ...real,
      _handler: async (ctx: unknown, args: unknown) => {
        if (commit) {
          await handlerOf<unknown, unknown>(real)(ctx, args);
        }
        throw new Error('lost response');
      },
    };
    const ctx = createFakeActionCtx({
      db,
      subject: 'buyer',
      modules: { providerOperations, providerSettlement: { settleProviderReceipt: lost } },
    });
    const args = { requestId: 'lost', amountCents: 2500, phone: PHONE, operator: 'mtn' };
    await assert.rejects(() => invokeFakeFunction(action, ctx, args), /lost response/);
    const result = (await invokeFakeFunction(action, ctx, args)) as { status: string };
    assert.equal(result.status, commit ? 'succeeded' : 'unknown');
    assert.equal(posts, 1);
    assert.equal(row(db, 'wallets')['balance'], commit ? 125 : 100);
    assert.equal(db.tables['walletTransactions']?.length, commit ? 1 : 0);
  });
}

for (const kind of ['mm', 'bank'] as const) {
  for (const field of ['debit account', 'destination', 'type', 'reference'] as const) {
    test(`${kind} trusted receipt wrong ${field} preserves reservation`, async () => {
      const db = fixture();
      const operation = await initiate(db, kind);
      const value = receipt(operation, 'failed');
      assert.equal(value.kind, 'transfer');
      if (value.kind !== 'transfer') {
        throw new Error('fixture');
      }
      if (field === 'debit account') {
        value.debitAccountId = OTHER_ID;
      }
      if (field === 'reference') {
        value.reference = 'WDR-other';
      }
      if (field === 'type') {
        value.transferType = value.transferType === 'mobile-money' ? 'bank-account' : 'mobile-money';
      }
      if (field === 'destination') {
        if (value.destination.kind === 'mobile-money') {
          value.destination.phone = '0970000000';
        } else {
          value.destination.accountNumber = '999';
        }
      }
      const before = money(db);
      await settle(db, operation, value);
      assert.deepEqual(money(db), before);
      assert.equal(operation['reviewNeeded'], true);
    });
  }
}

test('pending competitor ID mapping is review-held before any terminal receipt', async () => {
  const db = fixture();
  const operation = await initiate(db);
  db.tables['paymentOperations']?.push({
    ...operation,
    _id: 'paymentOperations|competing',
    providerReference: 'TOP-other',
    ownerId: 'users|other',
  });
  const before = money(db);
  await settle(db, operation, receipt(operation, 'pending'));
  assert.deepEqual(money(db), before);
  assert.equal(operation['reviewNeeded'], true);
});

test('receipt schema rejects wrong currency, collection kind/bearer/country without entering handler', async () => {
  const db = fixture();
  const operation = await initiate(db);
  const before = structuredClone(db.tables);
  for (const patch of [
    { currency: 'USD' },
    { collectionType: 'card' },
    { bearer: 'customer' },
    { country: null },
    { kind: 'transfer' },
  ]) {
    await assert.rejects(
      () =>
        invokeFakeFunction(providerSettlement.settleProviderReceipt, createCtx(db, null), {
          operationId: operation._id,
          receipt: { ...receipt(operation), ...patch },
          acquisition: { kind: 'status_get', lookup: { kind: 'reference', reference: operation['providerReference'] } },
        }),
      /Argument validation failed/,
    );
  }
  assert.deepEqual(db.tables, before);
});

test('unsupported/missing operations create no financial state, and ordinary evidence cannot promote itself to credit', async () => {
  const db = fixture();
  const operation = await initiate(db);
  await invokeFakeFunction(providerOperations.attachProviderResult, createCtx(db, null), {
    operationId: operation._id,
    receipt: receipt(operation),
  });
  assert.equal(db.tables['walletTransactions']?.length, 0);
  assert.equal(operation['accounting'], undefined);
  const before = structuredClone(db.tables);
  const result = (await invokeFakeFunction(providerSettlement.settleProviderReceipt, createCtx(db, null), {
    operationId: 'paymentOperations|missing',
    receipt: receipt(operation),
    acquisition: { kind: 'initiation_post', operationId: 'paymentOperations|missing' },
  })) as { application: string };
  assert.equal(result.application, 'unsupported');
  assert.deepEqual(db.tables, before);
});

test('conflicting typed receipt history is consumed even without a legacy review flag', async () => {
  for (const applied of [false, true]) {
    const db = fixture();
    const operation = await initiate(db, 'topup', applied ? 'successful' : 'pending');
    operation['receiptObservations'] = [{ ...receipt(operation, 'failed'), reference: 'TOP-foreign' }];
    const before = money(db);
    await settle(db, operation);
    assert.deepEqual(money(db), before);
    assert.equal(operation['reviewNeeded'], true);
    if (applied) {
      await assert.rejects(
        () => invokeFakeFunction(providerOperations.getMine, createCtx(db, 'buyer'), { operationId: operation._id }),
        /review/,
      );
    }
  }
});

for (const getFirst of [false, true]) {
  test(`real action/GET ordered writers: ${getFirst ? 'trusted GET before POST response' : 'POST response before trusted GET'} credit only once`, async () => {
    const db = fixture();
    let posts = 0;
    let gets = 0;
    const fetchImpl: LencoFetch = async (url, init) => {
      const operation = row(db, 'paymentOperations');
      if (init?.method === 'GET') {
        gets++;
        return envelope({
          id: ID,
          reference: operation['providerReference'],
          amount: '25',
          fee: '0.70',
          currency: 'ZMW',
          status: 'successful',
          type: 'mobile-money',
          bearer: 'merchant',
          mobileMoneyDetails: { country: 'zm', phone: PHONE, operator: 'mtn' },
          reasonForFailure: null,
          settlementStatus: 'settled',
        });
      }
      posts++;
      assert.equal(operation['status'], 'attempted');
      assert.equal(row(db, 'transactions')['status'], 'pending');
      if (getFirst) {
        const adapter = createLencoAdapter({ apiKey: ENV.LENCO_API_KEY }, fetchImpl);
        const acquired = await adapter.getCollectionByReference(String(operation['providerReference']));
        assert.ok(acquired.ok);
        if (!acquired.ok) {
          throw new Error('fixture GET failed');
        }
        await settle(db, operation, acquired.value as ProviderReceiptFacts);
      }
      return await transport(getFirst ? 'pending' : 'successful')(url, init);
    };
    const action = providerOperations.createTopUpAction({ env: () => ENV, fetchImpl });
    await invokeFakeFunction(
      action,
      createFakeActionCtx({ db, subject: 'buyer', modules: { providerOperations, providerSettlement } }),
      { requestId: 'ordered', amountCents: 2500, phone: PHONE, operator: 'mtn' },
    );
    const operation = row(db, 'paymentOperations');
    if (!getFirst) {
      const adapter = createLencoAdapter({ apiKey: ENV.LENCO_API_KEY }, fetchImpl);
      const acquired = await adapter.getCollectionByReference(String(operation['providerReference']));
      assert.ok(acquired.ok);
      if (!acquired.ok) {
        throw new Error('fixture GET failed');
      }
      await settle(db, operation, acquired.value as ProviderReceiptFacts);
    }
    assert.equal(posts, 1);
    assert.equal(gets, 1);
    assert.equal(row(db, 'wallets')['balance'], 125);
    assert.equal(db.tables['walletTransactions']?.length, 1);
    assert.equal(operation['status'], 'succeeded');
    assert.equal(operation['reviewNeeded'], undefined);
  });
}
