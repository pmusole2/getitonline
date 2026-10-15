import assert from 'node:assert/strict';
import test from 'node:test';
import { getFunctionName } from 'convex/server';
import { convexToJson, jsonToConvex } from 'convex/values';
import * as reconciliation from './paymentReconciliation';
import * as paymentReconciliationData from './paymentReconciliationData';
import * as providerOperations from './providerOperations';
import * as providerSettlement from './providerSettlement';
import * as checkoutCollection from './checkoutCollection';
import * as checkoutQuote from './checkoutQuote';
import * as paymentOperations from './paymentOperations';
import * as lencoWebhookData from './lencoWebhookData';
import * as transactions from './transactions';
import * as escrow from './escrow';
import type { LencoFetch } from './lib/lencoAdapter';
import { createFakeActionCtx, invokeFakeFunction } from '../tests/support/convexFakeActionCtx';
import { createCtx, createDb, type Db, type Row, type Tables } from '../tests/support/convexFakeDb';

// Registered handlers and real adapter/settler. Only external env/fetch are
// synthetic. This serial fake cannot prove SDK/JWT/OCC/transaction rollback.
const OWNER = 'users|buyer';
const PHONE = '0971234567';
const ID = '22222222-2222-3333-4444-555555555555';
const OTHER_ID = '99999999-2222-3333-4444-555555555555';
const DEBIT = '11111111-2222-3333-4444-555555555555';
const ENV = { LENCO_API_KEY: 'synthetic-fixture', LENCO_ACCOUNT_ID: DEBIT };
const ADDRESS = { street: 'Test', city: 'Lusaka', province: 'Lusaka', country: 'Zambia', phone: PHONE };
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

async function prepare(kind: Kind = 'topup', bound = false): Promise<{ db: Db; operation: Row }> {
  const db = fixture();
  const fetchImpl: LencoFetch = async (_url, init) => {
    assert.equal(init.method, 'POST');
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

async function refresh(
  db: Db,
  operation: Row,
  data: Record<string, unknown> = wire(operation),
  options: {
    subject?: string | null;
    selector?: Record<string, unknown>;
    fetchImpl?: LencoFetch;
    onEnv?: () => void;
    calls?: string[];
  } = {},
): Promise<unknown> {
  const fetchImpl: LencoFetch =
    options.fetchImpl ??
    (async (_url, init) => {
      assert.equal(init.method, 'GET');
      return envelope(data);
    });
  const fn = reconciliation.createRefreshAction({
    env: () => {
      options.onEnv?.();
      return ENV;
    },
    fetchImpl,
  });
  return await invokeFakeFunction(
    fn,
    actionCtx(db, options.subject === undefined ? 'clerk_buyer' : options.subject, options.calls),
    options.selector ?? { operationId: operation._id },
  );
}

async function status(
  db: Db,
  selector: Record<string, unknown>,
  subject: string | null = 'clerk_buyer',
): Promise<unknown> {
  return await invokeFakeFunction(reconciliation.getStatus, createCtx(db, subject), selector);
}

function money(db: Db): Tables {
  return structuredClone(
    Object.fromEntries(
      Object.entries(db.tables).filter(
        ([table]) => table !== 'paymentOperations' && table !== 'lencoWebhookInbox' && table !== 'paymentInboxPolls',
      ),
    ),
  );
}

async function summary(db: Db): Promise<Record<string, unknown>> {
  return record(
    await invokeFakeFunction(transactions.getPlatformFinancialSummary, createCtx(db, 'admin'), {
      adminId: 'users|admin',
    }),
  );
}

async function internalGet(db: Db, operation: Row, fetchImpl: LencoFetch): Promise<Record<string, unknown>> {
  return record(
    await invokeFakeFunction(
      reconciliation.createReconcileOperationAction({ env: () => ENV, fetchImpl }),
      actionCtx(db, null),
      { operationId: operation._id },
    ),
  );
}

async function inbox(
  db: Db,
  operation: Row,
  classification = 'lookup_required',
  eventKind = operation.kind === 'withdrawal_transfer' ? 'transfer_successful' : 'collection_settled',
): Promise<Row> {
  await invokeFakeFunction(lencoWebhookData.ingest, createCtx(db, null), {
    bodyDigest: 'a'.repeat(64),
    eventKind,
    classification,
    reference: operation.providerReference,
  });
  return row(db, 'lencoWebhookInbox');
}

async function inboxGet(
  db: Db,
  entry: Row,
  fetchImpl: LencoFetch,
  ctx = actionCtx(db, null),
): Promise<Record<string, unknown>> {
  return record(
    await invokeFakeFunction(reconciliation.createReconcileInboxAction({ env: () => ENV, fetchImpl }), ctx, {
      inboxId: entry._id,
    }),
  );
}

for (const kind of ['topup', 'mm', 'bank', 'checkout'] as const) {
  for (const providerStatus of ['successful', 'failed', 'pending'] as const) {
    test(`GET alone ${kind} ${providerStatus} preserves once-only money and truth`, async () => {
      const { db, operation } = await prepare(kind);
      assert.equal(operation.providerId, undefined);
      row(db, 'appConfig').paymentsEnabled = false;
      row(db, 'wallets').isFrozen = true;
      const before = money(db);
      const calls: string[] = [];
      const urls: string[] = [];
      const fetchImpl: LencoFetch = async (url, init) => {
        assert.equal(init.method, 'GET');
        urls.push(url);
        return envelope(wire(operation, providerStatus));
      };
      const result = record(
        await refresh(db, operation, {}, { selector: { requestId: '  recover-request  ' }, fetchImpl, calls }),
      );
      assert.equal(result.providerStatus, providerStatus);
      assert.equal(result.accountingApplied, providerStatus !== 'pending');
      assert.equal(result.application, providerStatus === 'pending' ? 'pending' : 'applied');
      assert.equal(result.reviewNeeded, false);
      assert.match(urls[0] ?? '', new RegExp(`/status/${string(operation.providerReference)}$`));
      assert.ok(calls.includes('mutation:providerSettlement:settleProviderReceipt'));
      if (providerStatus === 'pending') {
        assert.deepEqual(money(db), before);
      } else if (kind === 'topup') {
        assert.equal(row(db, 'wallets').balance, providerStatus === 'successful' ? 1025 : 1000);
        assert.equal(db.tables.walletTransactions?.length ?? 0, providerStatus === 'successful' ? 1 : 0);
      } else if (kind === 'mm' || kind === 'bank') {
        assert.equal(row(db, 'wallets').balance, providerStatus === 'successful' ? 975 : 1000);
        assert.equal(row(db, 'wallets').totalWithdrawn, providerStatus === 'successful' ? 25 : 0);
        assert.equal(db.tables.walletTransactions?.length, providerStatus === 'successful' ? 1 : 2);
      } else {
        assert.equal(db.tables.orders?.length, 2);
        assert.ok(
          db.tables.orders?.every((order) => order.status === (providerStatus === 'successful' ? 'paid' : 'cancelled')),
        );
        assert.equal(db.tables.escrow?.length ?? 0, providerStatus === 'successful' ? 2 : 0);
        assert.ok(
          db.tables.promoCodeRedemptions?.every(
            (r) => r.status === (providerStatus === 'successful' ? 'captured' : 'released'),
          ),
        );
      }
      const once = money(db);
      const proof = structuredClone(operation.accounting);
      await refresh(db, operation, wire(operation, providerStatus));
      assert.deepEqual(money(db), once);
      assert.deepEqual(operation.accounting, proof);
      assert.equal(db.tables.paymentOperations?.length, 1);
    });
  }
}

for (const kind of ['topup', 'mm', 'bank', 'checkout'] as const) {
  for (const fault of ['404', '429', '500', 'network', 'timeout', 'malformed', 'ambiguous'] as const) {
    test(`${kind} GET ${fault} cannot settle or release reservations`, async () => {
      const { db, operation } = await prepare(kind);
      const before = structuredClone(db.tables);
      let attempts = 0;
      const fetchImpl: LencoFetch = async (_url, init) => {
        attempts++;
        assert.equal(init.method, 'GET');
        if (fault === 'network') {
          throw new Error('synthetic network');
        }
        if (fault === 'timeout') {
          const error = new Error('synthetic abort');
          error.name = 'AbortError';
          throw error;
        }
        if (fault === 'malformed') {
          return new Response('{');
        }
        if (fault === 'ambiguous') {
          return new Response(JSON.stringify({ status: false, data: null }));
        }
        return new Response('{}', { status: Number(fault) });
      };
      const result = record(await refresh(db, operation, {}, { fetchImpl }));
      assert.equal(result.application, 'pending');
      assert.equal(result.accountingApplied, false);
      assert.deepEqual(db.tables, before);
      assert.equal(attempts, ['429', '500', 'network', 'timeout'].includes(fault) ? 2 : 1);
    });
  }
}

test('one transient retry uses the same GET and then settles once', async () => {
  const { db, operation } = await prepare('mm');
  const urls: string[] = [];
  const result = record(
    await refresh(
      db,
      operation,
      {},
      {
        fetchImpl: async (url, init) => {
          assert.equal(init.method, 'GET');
          urls.push(url);
          return urls.length === 1 ? new Response('{}', { status: 429 }) : envelope(wire(operation));
        },
      },
    ),
  );
  assert.equal(result.application, 'applied');
  assert.equal(urls.length, 2);
  assert.equal(urls[0], urls[1]);
  assert.equal(db.tables.walletTransactions?.length, 1);
});

for (const kind of ['topup', 'mm', 'bank', 'checkout'] as const) {
  for (const field of [
    'amount',
    'currency',
    'id',
    'reference',
    'operator',
    'country',
    'destination',
    'debit',
  ] as const) {
    test(`${kind} wrong ${field} GET cannot apply money`, async () => {
      const { db, operation } = await prepare(kind, true);
      const data = wire(operation);
      if (field === 'amount') {
        data.amount = '24.99';
      }
      if (field === 'currency') {
        data.currency = 'USD';
      }
      if (field === 'id') {
        data.id = OTHER_ID;
      }
      if (field === 'reference') {
        data.reference = 'TOP-other';
      }
      if (field === 'debit') {
        if (kind === 'topup' || kind === 'checkout') {
          data.type = 'bank-account';
        } else {
          data.accountId = OTHER_ID;
        }
      }
      const destination =
        kind === 'topup' || kind === 'checkout' ? record(data.mobileMoneyDetails) : record(data.creditAccount);
      if (field === 'operator') {
        if (kind === 'bank') {
          record(destination.bank).id = 'other';
        } else {
          destination.operator = 'airtel';
        }
      }
      if (field === 'country') {
        if (kind === 'bank') {
          record(destination.bank).country = 'ng';
        } else {
          destination.country = 'ng';
        }
      }
      if (field === 'destination') {
        if (kind === 'bank') {
          destination.accountNumber = '456';
        } else {
          destination.phone = '0979999999';
        }
      }
      const before = money(db);
      const result = record(await refresh(db, operation, data));
      assert.equal(result.accountingApplied, false);
      assert.deepEqual(money(db), before);
      assert.equal(operation.accounting, undefined);
      // Malformed adapter shapes remain unresolved; normalized mismatches are held by the writer.
      if (!['currency', 'country', 'debit'].includes(field) || (field === 'debit' && ['mm', 'bank'].includes(kind))) {
        assert.equal(result.application, 'review');
      }
    });
  }
}

// Deployment analysis requires object argument roots; the SDK serializes a
// union without enforcing that server rule. Inspect the actual registrations.
for (const [name, fn] of [
  ['getStatus', reconciliation.getStatus],
  ['refresh', reconciliation.refresh],
  ['getOwnedOperation', paymentReconciliationData.getOwnedOperation],
] as const) {
  test(`${name} exports deployable flat recovery arguments with typed selector fields`, () => {
    assert.ok('exportArgs' in fn && typeof fn.exportArgs === 'function');
    assert.deepEqual(JSON.parse(fn.exportArgs()), {
      type: 'object',
      value: {
        operationId: { fieldType: { type: 'id', tableName: 'paymentOperations' }, optional: true },
        requestId: { fieldType: { type: 'string' }, optional: true },
      },
    });
  });
}

for (const selectorKind of ['none', 'both'] as const) {
  for (const wrapper of ['status', 'refresh', 'owned'] as const) {
    test(`${wrapper} rejects ${selectorKind} recovery selectors before payment selection or provider work`, async () => {
      const { db, operation } = await prepare();
      const before = structuredClone(db.tables);
      const selector = selectorKind === 'none' ? {} : { operationId: operation._id, requestId: 'recover-request' };
      const get = db.get.bind(db);
      const query = db.query.bind(db);
      db.get = (id) => {
        assert.fail(`invalid selector must not get payment data: ${id}`);
      };
      db.query = (table) => {
        assert.equal(table, 'users', 'only authentication may read before selector rejection');
        return query(table);
      };
      const calls: string[] = [];
      try {
        await assert.rejects(
          wrapper === 'status'
            ? status(db, selector)
            : wrapper === 'owned'
              ? invokeFakeFunction(paymentReconciliationData.getOwnedOperation, createCtx(db, 'clerk_buyer'), selector)
              : refresh(
                  db,
                  operation,
                  {},
                  {
                    selector,
                    calls,
                    onEnv: () => assert.fail('invalid selector must not read provider config'),
                    fetchImpl: async () => assert.fail('invalid selector must not call provider'),
                  },
                ),
          /Argument validation failed/,
        );
        assert.ok(calls.every((call) => call === 'query:paymentReconciliationData:getOwnedOperation'));
        assert.deepEqual(db.tables, before);
      } finally {
        db.get = get;
        db.query = query;
      }
    });
  }
}

for (const selectorKind of ['operationId', 'requestId'] as const) {
  test(`flat ${selectorKind} recovery preserves SDK serialization, owner access and refresh`, async () => {
    const { db, operation } = await prepare();
    const selector =
      selectorKind === 'operationId' ? { operationId: operation._id } : { requestId: ' recover-request ' };
    // This is the real SDK value round-trip. Synthetic table|id fixtures below
    // are checked by the fake; native Convex ID validity is not proven here.
    assert.deepEqual(jsonToConvex(convexToJson(selector)), selector);
    assert.equal(record(await status(db, selector)).operationId, operation._id);
    assert.equal(
      record(
        await invokeFakeFunction(paymentReconciliationData.getOwnedOperation, createCtx(db, 'clerk_buyer'), selector),
      ).result,
      'found',
    );
    const before = structuredClone(db.tables);
    for (const subject of [null, 'clerk_other'] as const) {
      for (const fn of [reconciliation.getStatus, paymentReconciliationData.getOwnedOperation]) {
        const result = invokeFakeFunction(fn, createCtx(db, subject), selector);
        if (subject === 'clerk_other' && selectorKind === 'requestId') {
          assert.equal(await result, null);
        } else {
          await assert.rejects(result, subject === null ? /Unauthenticated/ : /Unauthorized/);
        }
      }
      const result = refresh(
        db,
        operation,
        {},
        {
          subject,
          selector,
          onEnv: () => assert.fail('denied recovery must not read provider config'),
          fetchImpl: async () => assert.fail('denied recovery must not call provider'),
        },
      );
      if (subject === 'clerk_other' && selectorKind === 'requestId') {
        assert.equal(await result, null);
      } else {
        await assert.rejects(result, subject === null ? /Unauthenticated/ : /Unauthorized/);
      }
      assert.deepEqual(db.tables, before);
    }
    const recovered = record(await refresh(db, operation, wire(operation), { selector }));
    assert.equal(recovered.operationId, operation._id);
    assert.equal(recovered.accountingApplied, true);
    assert.equal(recovered.application, 'applied');
  });
}

for (const subject of [null, 'unknown', 'clerk_other', 'admin', 'banned', 'deleted'] as const) {
  for (const wrapper of ['status', 'refresh'] as const) {
    test(`${wrapper} denies ${subject ?? 'anonymous'} before config/network/private reads`, async () => {
      const { db, operation } = await prepare();
      db.tables.users?.push(
        userRow('users|banned', 'banned', 'user', { isBanned: true }),
        userRow('users|deleted', 'deleted', 'user', { deletedAt: 1 }),
      );
      let env = 0;
      let gets = 0;
      const before = structuredClone(db.tables);
      await assert.rejects(
        wrapper === 'status'
          ? status(db, { operationId: operation._id }, subject)
          : refresh(
              db,
              operation,
              {},
              {
                subject,
                onEnv: () => env++,
                fetchImpl: async () => {
                  gets++;
                  return envelope(wire(operation));
                },
              },
            ),
      );
      assert.equal(env, 0);
      assert.equal(gets, 0);
      assert.deepEqual(db.tables, before);
    });
  }
}

for (const extra of [
  { ownerId: OWNER },
  { actorId: OWNER },
  { verified: true },
  { receipt: {} },
  { status: 'successful' },
  { amountCents: 2500 },
  { operationId: 'paymentOperations|missing', requestId: 'recover-request' },
  {},
]) {
  test(`private recovery schema rejects authority/invalid selector ${JSON.stringify(Object.keys(extra))}`, async () => {
    const { db, operation } = await prepare();
    const args =
      Object.keys(extra).length === 0 || 'requestId' in extra ? extra : { operationId: operation._id, ...extra };
    await assert.rejects(status(db, args), /Argument validation failed/);
    await assert.rejects(refresh(db, operation, {}, { selector: args }), /Argument validation failed/);
  });
}

test('request recovery is normalized/owner scoped and missing lookup never GETs', async () => {
  const { db, operation } = await prepare();
  row(db, 'appConfig').paymentsEnabled = false;
  row(db, 'wallets').isFrozen = true;
  const found = record(await status(db, { requestId: ' recover-request ' }));
  assert.equal(found.operationId, operation._id);
  assert.equal(found.requestId, 'recover-request');
  assert.equal(found.requestIdentity, operation.requestIdentity);
  assert.match(string(found.requestIdentity), /^[a-f0-9]{64}$/);
  assert.equal(await status(db, { requestId: 'recover-request' }, 'clerk_other'), null);
  assert.equal(await status(db, { operationId: 'paymentOperations|missing' }), null);
  assert.equal(
    await refresh(
      db,
      operation,
      {},
      { selector: { requestId: 'missing' }, onEnv: () => assert.fail('missing must not read config') },
    ),
    null,
  );
  await assert.rejects(status(db, { requestId: ' bad request ' }), /request id/);
  const forbidden = [
    'ownerId',
    'phone',
    'destinationKey',
    'receipt',
    'acquisitions',
    'accounting',
    'metadata',
    'configuredDebitAccountId',
    'failureCode',
  ];
  assert.ok(forbidden.every((key) => !(key in found)));
});

test('duplicate owned request yields explicit review, chooses no first and performs no GET', async () => {
  const { db, operation } = await prepare();
  db.tables.paymentOperations?.push({ ...operation, _id: 'paymentOperations|duplicate' });
  const before = structuredClone(db.tables);
  assert.deepEqual(await status(db, { requestId: 'recover-request' }), {
    result: 'review',
    reason: 'ambiguous_request',
  });
  assert.deepEqual(
    await refresh(
      db,
      operation,
      {},
      { selector: { requestId: 'recover-request' }, onEnv: () => assert.fail('duplicate must not read config') },
    ),
    { result: 'review', reason: 'ambiguous_request' },
  );
  assert.deepEqual(db.tables, before);
});

for (const kind of ['topup', 'mm', 'checkout', 'wallet'] as const) {
  test(`${kind} bare terminal/missing proof is readonly review`, async () => {
    const { db, operation } = await prepare(kind);
    if (kind !== 'wallet') {
      operation.status = 'succeeded';
    } else {
      delete operation.walletTransactionId;
    }
    const before = structuredClone(db.tables);
    const result = record(await status(db, { operationId: operation._id }));
    assert.equal(result.application, 'review');
    assert.equal(result.accountingApplied, false);
    assert.deepEqual(db.tables, before);
  });
}

for (const kind of ['topup', 'mm', 'checkout'] as const) {
  for (const corruption of ['marker', 'ledger', 'companion', 'sticky'] as const) {
    test(`${kind} ${corruption} cannot appear financially healthy`, async () => {
      const { db, operation } = await prepare(kind);
      await refresh(db, operation);
      if (corruption === 'marker') {
        record(operation.accounting).appliedAt = -1;
      }
      if (corruption === 'ledger') {
        if (kind === 'checkout') {
          row(db, 'escrow').grossAmount = 1;
        } else {
          row(db, 'walletTransactions').amount = 1;
        }
      }
      if (corruption === 'companion') {
        if (kind === 'mm') {
          row(db, 'walletTransactions').providerReference = 'wrong';
        } else {
          row(db, 'transactions').amount = 1;
        }
      }
      if (corruption === 'sticky') {
        operation.reviewNeeded = true;
      }
      const before = structuredClone(db.tables);
      const result = record(await status(db, { operationId: operation._id }));
      assert.equal(result.application, 'review');
      assert.equal(result.accountingApplied, corruption === 'sticky');
      assert.equal(result.feeCents, null);
      assert.deepEqual(db.tables, before);
    });
  }
}

test('wallet recovery uses positive original funding and performs no GET with initiation off/frozen', async () => {
  const { db, operation } = await prepare('wallet');
  row(db, 'wallets').isFrozen = true;
  row(db, 'appConfig').paymentsEnabled = false;
  const before = structuredClone(db.tables);
  const result = record(
    await refresh(
      db,
      operation,
      {},
      { onEnv: () => assert.fail('wallet must not read config'), selector: { requestId: 'recover-request' } },
    ),
  );
  assert.equal(result.application, 'applied');
  assert.equal(result.accountingApplied, true);
  assert.equal(result.providerStatus, 'not_applicable');
  assert.equal(result.orderIds instanceof Array, true);
  assert.equal(result.quoteKey, operation.quoteKey);
  assert.equal(result.source, 'cart');
  assert.equal(result.amountCents, operation.totalAmountCents);
  assert.deepEqual(db.tables, before);
});

test('real storage errors propagate rather than become business review', async () => {
  const { db, operation } = await prepare('wallet');
  const get = db.get;
  db.get = async (id) => {
    if (id.startsWith('walletTransactions|')) {
      throw new Error('synthetic storage failure');
    }
    return await get(id);
  };
  await assert.rejects(status(db, { operationId: operation._id }), /synthetic storage failure/);
});

for (const access of ['banned', 'deleted', 'legacy-tombstone', 'owner-change'] as const) {
  test(`access lost during deferred GET ${access}: owed money settles, private response denied`, async () => {
    const { db, operation } = await prepare();
    let started: (() => void) | undefined;
    let resolve: ((value: Response) => void) | undefined;
    const startedPromise = new Promise<void>((r) => {
      started = r;
    });
    const response = new Promise<Response>((r) => {
      resolve = r;
    });
    const data = wire(operation);
    const pending = refresh(
      db,
      operation,
      {},
      {
        fetchImpl: async () => {
          started?.();
          return await response;
        },
      },
    );
    await startedPromise;
    if (access === 'banned') {
      row(db, 'users', OWNER).isBanned = true;
    }
    if (access === 'deleted') {
      row(db, 'users', OWNER).deletedAt = 1;
    }
    if (access === 'legacy-tombstone') {
      db.tables.users?.push(userRow('users|tombstone', 'deleted:clerk_buyer', 'user', { deletedAt: 1 }));
    }
    if (access === 'owner-change') {
      // Ownership changes invalidate companion lineage; writer holds money.
      operation.ownerId = 'users|other';
    }
    resolve?.(envelope(data));
    await assert.rejects(pending);
    if (access === 'owner-change') {
      assert.equal(operation.reviewNeeded, true);
      assert.equal(db.tables.walletTransactions?.length ?? 0, 0);
    } else {
      assert.equal(row(db, 'wallets').balance, 1025);
      assert.equal(db.tables.walletTransactions?.length, 1);
      await internalGet(db, operation, async () => envelope(data));
      assert.equal(db.tables.walletTransactions?.length, 1);
    }
  });
}

for (const access of ['banned', 'deleted', 'missing-owner', 'frozen'] as const) {
  test(`actor-free internal GET ${access} obeys accepted beneficiary policy`, async () => {
    const { db, operation } = await prepare();
    row(db, 'appConfig').paymentsEnabled = false;
    if (access === 'banned') {
      row(db, 'users', OWNER).isBanned = true;
    }
    if (access === 'deleted') {
      row(db, 'users', OWNER).deletedAt = 1;
    }
    if (access === 'missing-owner') {
      await db.delete(OWNER);
    }
    if (access === 'frozen') {
      row(db, 'wallets').isFrozen = true;
    }
    const result = await internalGet(db, operation, async () => envelope(wire(operation)));
    assert.equal(result.application, access === 'missing-owner' ? 'review' : 'applied');
    assert.equal(row(db, 'wallets').balance, access === 'missing-owner' ? 1000 : 1025);
  });
}

for (const kind of ['topup', 'mm', 'bank', 'checkout'] as const) {
  test(`${kind} stale pending/opposite terminal evidence never duplicates or reverses original effects`, async () => {
    const { db, operation } = await prepare(kind);
    await refresh(db, operation);
    const original = structuredClone(operation.accounting);
    const before = money(db);
    await refresh(db, operation, wire(operation, 'pending'));
    assert.equal(operation.status, 'succeeded');
    assert.notEqual(operation.reviewNeeded, true);
    const result = record(await refresh(db, operation, wire(operation, 'failed')));
    assert.equal(result.application, 'review');
    assert.equal(operation.reviewNeeded, true);
    await refresh(db, operation);
    assert.deepEqual(money(db), before);
    assert.deepEqual(operation.accounting, original);
  });
}

test('reference GET raced with an attempted ID attach preserves bound identity and holds contradiction', async () => {
  const { db, operation } = await prepare();
  const before = money(db);
  const result = record(
    await refresh(
      db,
      operation,
      {},
      {
        fetchImpl: async (url) => {
          assert.match(url, /\/status\//);
          await invokeFakeFunction(providerOperations.attachProviderResult, createCtx(db, null), {
            operationId: operation._id,
            receipt: {
              kind: 'collection',
              id: OTHER_ID,
              reference: operation.providerReference,
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
            },
          });
          return envelope(wire(operation));
        },
      },
    ),
  );
  assert.equal(result.application, 'review');
  assert.equal(operation.providerId, OTHER_ID);
  assert.deepEqual(money(db), before);
  const acquisitions = operation.acquisitions;
  assert.ok(Array.isArray(acquisitions));
  assert.deepEqual(record(record(acquisitions.at(-1)).acquisition).lookup, {
    kind: 'reference',
    reference: operation.providerReference,
  });
});

for (const classification of ['lookup_required', 'enrichment', 'review', 'terminal'] as const) {
  test(`associated ${classification} inbox uses actual GET and minimal completion`, async () => {
    const { db, operation } = await prepare('mm');
    const entry = await inbox(db, operation, classification);
    const ingestedAt = entry.ingestedAt;
    entry.result = 'review'; // this label supplies no selector or authority
    const result = await inboxGet(db, entry, async (_url, init) => {
      assert.equal(init.method, 'GET');
      return envelope(wire(operation));
    });
    assert.equal(result.application, 'applied');
    assert.equal(entry.lookupResult, 'applied');
    assert.equal(typeof entry.lookupCompletedAt, 'number');
    assert.equal(entry.operationId, operation._id);
    assert.equal(entry.ingestedAt, ingestedAt);
    assert.equal(entry.result, 'review');
    assert.deepEqual(
      Object.keys(entry).sort(),
      [
        '_id',
        'bodyDigest',
        'classification',
        'eventKind',
        'ingestedAt',
        'lookupCompletedAt',
        'lookupResult',
        'operationId',
        'result',
      ].sort(),
    );
    assert.equal(db.tables.walletTransactions?.length, 1);
  });
}

for (const fault of [
  'malformed',
  'unhandled',
  'unmapped',
  'ambiguous',
  'unsupported',
  'unknown-event',
  'foreign-kind',
  'missing-operation',
  'duplicate-digest',
  'duplicate-reference',
  'duplicate-id',
] as const) {
  test(`${fault} inbox fails closed without intent guess or GET`, async () => {
    const { db, operation } = await prepare('topup', true);
    const entry = await inbox(db, operation);
    if (['malformed', 'unhandled', 'unmapped', 'ambiguous', 'unsupported'].includes(fault)) {
      entry.classification = fault;
    }
    if (fault === 'unknown-event') {
      entry.eventKind = 'unknown';
    }
    if (fault === 'foreign-kind') {
      entry.eventKind = 'transfer_successful';
    }
    if (fault === 'missing-operation') {
      entry.operationId = 'paymentOperations|missing';
    }
    if (fault === 'duplicate-digest') {
      db.tables.lencoWebhookInbox?.push({ ...entry, _id: 'lencoWebhookInbox|duplicate' });
    }
    if (fault === 'duplicate-reference' || fault === 'duplicate-id') {
      db.tables.paymentOperations?.push({
        ...operation,
        _id: 'paymentOperations|duplicate',
        ...(fault === 'duplicate-id' ? { providerReference: 'TOP-other' } : { providerId: OTHER_ID }),
      });
    }
    const before = structuredClone(db.tables);
    const result = await inboxGet(db, entry, async () => {
      assert.fail('ineligible work must not GET');
    });
    assert.equal(result.result, 'ineligible');
    assert.deepEqual(db.tables, before);
  });
}

test('lookup completion remains honest for pending/null fee; transport failure does not complete', async () => {
  const { db, operation } = await prepare();
  const entry = await inbox(db, operation);
  const original = structuredClone(entry);
  assert.equal((await inboxGet(db, entry, async () => new Response('{}', { status: 404 }))).result, 'unresolved');
  assert.deepEqual(entry, original);
  assert.equal(
    (await inboxGet(db, entry, async () => envelope(wire(operation, 'pending', null)))).application,
    'pending',
  );
  assert.equal(entry.lookupResult, 'pending');
  assert.equal(typeof entry.lookupCompletedAt, 'number');
  assert.equal(operation.accounting, undefined);
  assert.notEqual(operation.reviewNeeded, true);
  assert.equal(
    (await inboxGet(db, entry, async () => envelope(wire(operation, 'successful', null)))).application,
    'applied',
  );
  assert.equal(entry.lookupResult, 'applied');
  assert.equal(record(await status(db, { operationId: operation._id })).feeCents, null);
});

test('inbox completion persistence failure after money commit propagates; replay credits once', async () => {
  const { db, operation } = await prepare();
  const entry = await inbox(db, operation);
  const first = structuredClone(entry);
  const ctx = actionCtx(db, null);
  const runMutation = ctx.runMutation;
  ctx.runMutation = async (ref, args) => {
    if (getFunctionName(ref) === 'paymentReconciliationData:recordLookupResult') {
      throw new Error('synthetic metadata failure');
    }
    return await runMutation(ref, args);
  };
  await assert.rejects(
    inboxGet(db, entry, async () => envelope(wire(operation)), ctx),
    /synthetic metadata failure/,
  );
  assert.deepEqual(entry, first);
  assert.equal(row(db, 'wallets').balance, 1025);
  const original = structuredClone(operation.accounting);
  assert.equal((await inboxGet(db, entry, async () => envelope(wire(operation)))).application, 'applied');
  assert.equal(db.tables.walletTransactions?.length, 1);
  assert.deepEqual(operation.accounting, original);
  assert.equal(entry.lookupResult, 'applied');
  assert.equal(entry.ingestedAt, first.ingestedAt);
});

for (const changed of ['classification', 'operationId', 'bodyDigest', 'eventKind'] as const) {
  test(`completion rebind rejects raced inbox ${changed} after once-only settlement`, async () => {
    const { db, operation } = await prepare();
    const entry = await inbox(db, operation);
    await assert.rejects(
      inboxGet(db, entry, async () => {
        entry[changed] =
          changed === 'classification'
            ? 'review'
            : changed === 'operationId'
              ? 'paymentOperations|missing'
              : changed === 'eventKind'
                ? 'collection_failed'
                : 'b'.repeat(64);
        return envelope(wire(operation));
      }),
      /Lookup result mismatch/,
    );
    assert.equal(row(db, 'wallets').balance, 1025);
    assert.equal(entry.lookupCompletedAt, undefined);
  });
}

for (const late of ['1.00', '0', null] as const) {
  test(`original null fee projects only actual matching GET ${late ?? 'null'} without proof/money mutation`, async () => {
    const { db, operation } = await prepare('checkout');
    await refresh(db, operation, wire(operation, 'successful', null));
    const original = structuredClone(operation.accounting);
    const before = money(db);
    const entry = await inbox(db, operation, 'enrichment');
    assert.equal(
      (await inboxGet(db, entry, async () => envelope(wire(operation, 'successful', late)))).application,
      'applied',
    );
    const expected = late === null ? null : Number(late);
    const financial = await summary(db);
    assert.equal(financial.totalGatewayFees, expected);
    assert.equal(record(financial.review).unknownFeeOperations, late === null ? 1 : 0);
    assert.equal(record(financial.completeness).complete, late !== null);
    assert.equal(
      record(await status(db, { operationId: operation._id })).feeCents,
      late === null ? null : Number(late) * 100,
    );
    assert.deepEqual(operation.accounting, original);
    assert.deepEqual(money(db), before);
    assert.equal(db.tables.escrow?.length, 2);
    assert.notEqual(operation.reviewNeeded, true);
    // Null fees must not block actual seller release.
    for (const order of db.tables.orders ?? []) {
      order.status = 'delivered';
    }
    for (const hold of db.tables.escrow ?? []) {
      await invokeFakeFunction(escrow.releaseFunds, createCtx(db, 'clerk_buyer'), { escrowId: hold._id });
    }
    const released = await summary(db);
    assert.equal(released.totalGatewayFees, expected);
    assert.equal(
      released.netPlatformProfit,
      expected === null
        ? null
        : (Math.round(numeric(released.totalPlatformFees) * 100) - Math.round(expected * 100)) / 100,
    );
  });
}

for (const cost of ['0', '1.00'] as const) {
  test(`original known ${cost} is frozen; conflicting known late fee is unknown`, async () => {
    const { db, operation } = await prepare();
    await refresh(db, operation, wire(operation, 'successful', cost));
    assert.equal((await summary(db)).totalGatewayFees, Number(cost));
    const proof = structuredClone(operation.accounting);
    const before = money(db);
    await refresh(db, operation, wire(operation, 'successful', cost === '0' ? '1.00' : '0'));
    assert.equal((await summary(db)).totalGatewayFees, null);
    assert.equal(record(await status(db, { operationId: operation._id })).accountingApplied, true);
    assert.notEqual(operation.reviewNeeded, true);
    assert.deepEqual(operation.accounting, proof);
    assert.deepEqual(money(db), before);
  });
}

for (const source of [
  'signed',
  'primary',
  'observation',
  'pending-get',
  'invalid-acquisition',
  'gateway-fee',
] as const) {
  test(`${source} cannot manufacture original-null late fee authority`, async () => {
    const { db, operation } = await prepare();
    await refresh(db, operation, wire(operation, 'successful', null));
    const receipt = { ...record(operation.receipt), feeMinor: 100 };
    if (source === 'signed') {
      await invokeFakeFunction(providerSettlement.settleProviderReceipt, createCtx(db, null), {
        operationId: operation._id,
        receipt,
        acquisition: { kind: 'signed_webhook', eventId: 'synthetic-signed' },
      });
    }
    if (source === 'primary') {
      operation.receipt = receipt;
    }
    if (source === 'observation') {
      operation.receiptObservations = [receipt];
    }
    if (source === 'pending-get') {
      await refresh(db, operation, wire(operation, 'pending', '1.00'));
    }
    if (source === 'invalid-acquisition') {
      const acquired = operation.acquisitions;
      assert.ok(Array.isArray(acquired));
      acquired.push({
        receipt,
        acquisition: { kind: 'status_get', lookup: { kind: 'reference', reference: 'TOP-other' } },
      });
    }
    if (source === 'gateway-fee') {
      row(db, 'transactions').gatewayFee = 1;
      row(db, 'transactions').fee = 1;
    }
    assert.equal((await summary(db)).totalGatewayFees, null);
    assert.equal(record(await status(db, { operationId: operation._id })).feeCents, null);
    assert.notEqual(operation.reviewNeeded, true);
  });
}

for (const late of [
  'malformed',
  'contradiction',
  'same-value',
  'signed-contradiction',
  'invalid-fee',
  'wrong-amount',
  'wrong-id',
] as const) {
  test(`late fee ${late} retains correct qualification and original proof`, async () => {
    const { db, operation } = await prepare();
    await refresh(db, operation, wire(operation, 'successful', null));
    const proof = structuredClone(operation.accounting);
    const before = money(db);
    if (late === 'malformed') {
      await refresh(db, operation, wire(operation, 'successful', 'not-money'));
    } else if (late === 'invalid-fee') {
      operation.receiptObservations = [{ ...record(operation.receipt), feeMinor: -1 }];
    } else if (late === 'wrong-amount' || late === 'wrong-id') {
      await refresh(db, operation, {
        ...wire(operation, 'successful', '1.00'),
        ...(late === 'wrong-amount' ? { amount: '24.99' } : { id: OTHER_ID }),
      });
    } else {
      await refresh(db, operation, wire(operation, 'successful', '1.00'));
      if (late === 'signed-contradiction') {
        await invokeFakeFunction(providerSettlement.settleProviderReceipt, createCtx(db, null), {
          operationId: operation._id,
          receipt: { ...record(operation.receipt), feeMinor: 200 },
          acquisition: { kind: 'signed_webhook', eventId: 'signed-cost' },
        });
      } else {
        await refresh(db, operation, {
          ...wire(operation, 'successful', late === 'contradiction' ? '2.00' : '1.00'),
          settlementStatus: 'settled',
        });
      }
    }
    assert.equal((await summary(db)).totalGatewayFees, late === 'same-value' ? 1 : null);
    assert.deepEqual(operation.accounting, proof);
    assert.deepEqual(money(db), before);
  });
}

for (const malformed of [
  'missing-receipt',
  'missing-acquisition',
  'null-observation',
  'null-entry',
  'wallet-missing-quote',
  'wallet-null-seller',
] as const) {
  test(`malformed legacy ${malformed} becomes readonly review without hiding storage errors`, async () => {
    const { db, operation } = await prepare(malformed.startsWith('wallet') ? 'wallet' : 'topup');
    if (!malformed.startsWith('wallet')) {
      await refresh(db, operation);
    }
    if (malformed === 'missing-receipt') {
      delete record(operation.accounting).receipt;
    }
    if (malformed === 'missing-acquisition') {
      delete record(operation.accounting).acquisition;
    }
    if (malformed === 'null-observation') {
      operation.receiptObservations = [null];
    }
    if (malformed === 'null-entry') {
      operation.acquisitions = [null];
    }
    if (malformed === 'wallet-missing-quote') {
      delete operation.quoteSnapshot;
    }
    if (malformed === 'wallet-null-seller') {
      record(operation.quoteSnapshot).sellers = [null];
    }
    const before = structuredClone(db.tables);
    const result = record(await status(db, { operationId: operation._id }));
    assert.equal(result.application, 'review');
    assert.equal(result.accountingApplied, false);
    assert.deepEqual(db.tables, before);
  });
}

test('malformed pending receipt history is review rather than pending financial health', async () => {
  const { db, operation } = await prepare('topup', true);
  record(operation.receipt).amountMinor = 1;
  const result = record(await status(db, { operationId: operation._id }));
  assert.equal(result.application, 'review');
  assert.equal(result.providerStatus, 'unknown');
});

for (const originalFee of [null, '0'] as const) {
  for (const conflict of ['id', 'outcome'] as const) {
    test(`original fee ${originalFee ?? 'null'} cannot use terminal acquisition ${conflict} disagreement`, async () => {
      const { db, operation } = await prepare();
      await refresh(db, operation, wire(operation, 'successful', originalFee));
      if (originalFee === null) {
        await refresh(db, operation, wire(operation, 'successful', '1.00'));
      }
      const acquisitions = operation.acquisitions;
      assert.ok(Array.isArray(acquisitions));
      acquisitions.push({
        receipt: { ...record(operation.receipt), ...(conflict === 'id' ? { id: OTHER_ID } : { status: 'failed' }) },
        acquisition: { kind: 'status_get', lookup: { kind: 'reference', reference: operation.providerReference } },
      });
      const proof = structuredClone(operation.accounting);
      const before = money(db);
      assert.equal((await summary(db)).totalGatewayFees, null);
      assert.equal(record(await status(db, { operationId: operation._id })).feeCents, null);
      assert.deepEqual(operation.accounting, proof);
      assert.deepEqual(money(db), before);
    });
  }
}

for (const malformed of ['checkout-order-links', 'checkout-escrow-links', 'topup-received-funds'] as const) {
  test(`malformed original ${malformed} containers remain explicit review`, async () => {
    const { db, operation } = await prepare(malformed.startsWith('checkout') ? 'checkout' : 'topup');
    await refresh(db, operation);
    if (malformed === 'checkout-order-links') {
      delete record(operation.accounting).orderIds;
    }
    if (malformed === 'checkout-escrow-links') {
      delete record(operation.accounting).escrowIds;
    }
    if (malformed === 'topup-received-funds') {
      delete record(operation.receivedFunds).receipt;
    }
    const before = structuredClone(db.tables);
    const result = record(await status(db, { operationId: operation._id }));
    assert.equal(result.application, 'review');
    assert.equal(result.accountingApplied, false);
    assert.deepEqual(db.tables, before);
  });
}

test('missing/unsupported internal operation and wallet-associated inbox perform no GET', async () => {
  const { db, operation } = await prepare('wallet');
  const deps = {
    env: () => {
      assert.fail('ineligible must not read config');
      return ENV;
    },
  };
  assert.deepEqual(
    await invokeFakeFunction(reconciliation.createReconcileOperationAction(deps), actionCtx(db, null), {
      operationId: 'paymentOperations|missing',
    }),
    { result: 'not_found' },
  );
  assert.deepEqual(
    await invokeFakeFunction(reconciliation.createReconcileOperationAction(deps), actionCtx(db, null), {
      operationId: operation._id,
    }),
    { result: 'ineligible' },
  );
  const entry: Row = {
    _id: 'lencoWebhookInbox|wallet',
    operationId: operation._id,
    bodyDigest: 'd'.repeat(64),
    eventKind: 'collection_successful',
    classification: 'lookup_required',
    ingestedAt: 1,
  };
  db.tables.lencoWebhookInbox = [entry];
  assert.deepEqual(
    await inboxGet(db, entry, async () => {
      assert.fail('wallet inbox must not GET');
    }),
    { result: 'ineligible' },
  );
  assert.deepEqual(
    await inboxGet(db, { _id: 'lencoWebhookInbox|missing' }, async () => {
      assert.fail('missing inbox must not GET');
    }),
    { result: 'ineligible' },
  );
});
