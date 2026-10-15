import assert from 'node:assert/strict';
import test from 'node:test';

import type { Doc } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import * as checkoutCollection from './checkoutCollection';
import * as checkoutQuote from './checkoutQuote';
import * as escrowModule from './escrow';
import * as disputesModule from './disputes';
import * as ordersModule from './orders';
import { validateCheckoutAccounting } from './lib/checkoutSettlement';
import { requireWalletFundingProof } from './lib/fundingProof';
import { applyEscrowAccounting, type DisputeAccountingContext } from './lib/escrowAccounting';
import type { LencoFetch } from './lib/lencoAdapter';
import * as paymentOperations from './paymentOperations';
import * as providerOperations from './providerOperations';
import * as providerSettlement from './providerSettlement';
import * as usersModule from './users';
import * as transactionsModule from './transactions';
import { createFakeActionCtx, invokeFakeFunction } from '../tests/support/convexFakeActionCtx';
import { createCtx, createDb, type Db, type Row, type Tables } from '../tests/support/convexFakeDb';

// Real registered quote -> purchase OR checkout claim -> trusted receipt ->
// settlement -> escrow wrapper. Only external fetch is synthetic. This serial
// database models neither transactional rollback nor deployed OCC/JWT.
const ADDRESS = { street: 'Test', city: 'Lusaka', province: 'Lusaka', country: 'Zambia', phone: '0971234567' };
const PROVIDER_ID = '22222222-2222-3333-4444-555555555555';
type Source = 'wallet' | 'checkout';
type Kind = 'release' | 'full' | 'partial';
type Funded = { db: Db; operation: Row; escrow: Row; order: Row; source: Source };

function user(id: string, role = 'user'): Row {
  return {
    _id: `users|${id}`,
    clerkId: id,
    email: `${id}@example.invalid`,
    firstName: id,
    lastName: 'Test',
    role,
    totalSales: 0,
    totalPurchases: 0,
    isBanned: false,
    isVerified: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function wallet(id: string, balance = 1000): Row {
  return {
    _id: `wallets|${id}`,
    userId: `users|${id}`,
    balance,
    pendingBalance: 70,
    totalEarned: 9,
    totalSpent: 0,
    totalWithdrawn: 4,
    isActive: true,
    isFrozen: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function num(value: unknown): number {
  assert.equal(typeof value, 'number');
  return value as number;
}

function str(value: unknown): string {
  assert.equal(typeof value, 'string');
  return value as string;
}

function row(db: Db, table: string, id: string): Row {
  const value = db.tables[table]?.find((item) => item._id === id);
  assert.ok(value, `${table} ${id} must exist`);
  return value;
}

function tables(): Tables {
  return {
    users: [
      user('buyer'),
      user('seller'),
      user('other'),
      user('reviewer', 'moderator'),
      user('banned'),
      user('deleted'),
    ],
    wallets: [wallet('buyer'), wallet('seller', 10)],
    vendorProfiles: [
      {
        _id: 'vendorProfiles|seller',
        ownerUserId: 'users|seller',
        status: 'approved',
        storeName: 'Test',
        slug: 'test',
      },
    ],
    platformSettings: [
      {
        _id: 'platformSettings|1',
        key: 'singleton',
        companySellerUserId: 'users|company',
        companyDisplayName: 'Test',
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    appConfig: [
      {
        _id: 'appConfig|1',
        key: 'singleton',
        paymentsEnabled: true,
        minimumBuilds: { ios: 1, android: 1 },
        updatedAt: 1,
      },
    ],
    products: [
      {
        _id: 'products|1',
        sellerId: 'users|seller',
        title: 'Test',
        description: 'Test',
        price: 100,
        images: [],
        condition: 'good',
        status: 'active',
        quantity: 10,
        categoryId: 'categories|1',
        weightKg: 0,
        shippingOptions: [{ name: 'Free', price: 0 }],
        views: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    cartItems: [
      {
        _id: 'cartItems|1',
        userId: 'users|buyer',
        productId: 'products|1',
        quantity: 1,
        selectedShipping: { name: 'Free', price: 0 },
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    deliveryZones: [
      {
        _id: 'deliveryZones|1',
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
        _id: 'deliveryMethods|1',
        zoneId: 'deliveryZones|1',
        name: 'Standard',
        code: 'STD',
        type: 'standard',
        baseFee: 0,
        perKgFee: 0,
        minDays: 1,
        maxDays: 3,
        isActive: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    orders: [],
    escrow: [],
    transactions: [],
    walletTransactions: [],
    paymentOperations: [],
    paymentAccounts: [],
    promoCodes: [],
    promoCodeRedemptions: [],
    loyaltyAccounts: [],
    loyaltyTransactions: [],
    pickupPoints: [],
    notifications: [],
  };
}

async function fund(
  source: Source,
  configure?: (db: Db) => void,
  extra: Record<string, unknown> = {},
  providerFee?: string | null,
): Promise<Funded> {
  const db = createDb(tables());
  row(db, 'users', 'users|banned').isBanned = true;
  row(db, 'users', 'users|deleted').deletedAt = 1;
  configure?.(db);
  const selectors = { source: 'cart', shippingAddress: ADDRESS, deliveryMethodId: 'deliveryMethods|1', ...extra };
  const quoted = record(await invokeFakeFunction(checkoutQuote.quoteCheckout, createCtx(db, 'buyer'), selectors));
  assert.equal(quoted.ok, true);
  const quote = record(quoted.quote);
  let operationId: string;
  if (source === 'wallet') {
    const result = record(
      await invokeFakeFunction(paymentOperations.purchaseWithWallet, createCtx(db, 'buyer'), {
        ...selectors,
        requestId: 'escrow-funding',
        expectedQuoteKey: quote.quoteKey,
      }),
    );
    assert.equal(result.ok, true);
    operationId = str(result.operationId);
  } else {
    const fetchImpl: LencoFetch = async (_url, init) => {
      const body = record(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          status: true,
          data: {
            id: PROVIDER_ID,
            reference: body.reference,
            amount: String(body.amount),
            currency: 'ZMW',
            status: 'pending',
            ...(providerFee === undefined ? {} : { fee: providerFee }),
            type: 'mobile-money',
            bearer: 'merchant',
            mobileMoneyDetails: { country: 'zm', operator: body.operator, phone: body.phone },
            reasonForFailure: null,
            settlementStatus: null,
          },
        }),
        { status: 200 },
      );
    };
    const action = checkoutCollection.createCheckoutCollectionAction({
      env: () => ({ LENCO_API_KEY: 'synthetic-test-only' }),
      fetchImpl,
    });
    const ctx = createFakeActionCtx({
      db,
      subject: 'buyer',
      modules: { checkoutCollection, providerOperations, providerSettlement },
    });
    const result = record(
      await invokeFakeFunction(action, ctx, {
        ...selectors,
        requestId: 'escrow-funding',
        expectedQuoteKey: quote.quoteKey,
        phone: ADDRESS.phone,
        operator: 'mtn',
      }),
    );
    assert.equal(result.ok, true);
    operationId = str(result.operationId);
    const operation = row(db, 'paymentOperations', operationId);
    const receipt = { ...record(operation.receipt), status: 'successful' };
    const settled = record(
      await invokeFakeFunction(providerSettlement.settleProviderReceipt, createCtx(db, null), {
        operationId,
        receipt,
        acquisition: { kind: 'initiation_post', operationId },
      }),
    );
    assert.equal(settled.application, 'applied');
  }
  const operation = row(db, 'paymentOperations', operationId);
  const escrow = db.tables.escrow?.[0];
  assert.ok(escrow);
  const order = row(db, 'orders', str(escrow.orderId));
  order.status = 'delivered';
  return { db, operation, escrow, order, source };
}

async function outcome(
  f: Funded,
  kind: Kind,
  amount = 20,
  subject: string | null = kind === 'release' ? 'buyer' : 'reviewer',
): Promise<Record<string, unknown>> {
  const fn =
    kind === 'release'
      ? escrowModule.releaseFunds
      : kind === 'full'
        ? escrowModule.refundFull
        : escrowModule.refundPartial;
  const args = { escrowId: f.escrow._id, ...(kind === 'partial' ? { refundAmount: amount } : {}) };
  return record(await invokeFakeFunction(fn, createCtx(f.db, subject), args));
}

function proof(f: Funded): Record<string, unknown> {
  return record(f.escrow.lifecycleProof);
}

function business(db: Db): Tables {
  const copy = structuredClone(db.tables);
  for (const escrow of copy.escrow ?? []) {
    delete escrow.lifecycleProof;
  }
  return copy;
}

async function fundingStillValid(f: Funded): Promise<void> {
  // The fixture ids are synthetic; these casts bridge the serial fake to the
  // SDK types, never claim a signed JWT or deployed Convex database.
  const ctx = createCtx(f.db, null) as unknown as MutationCtx;
  const operation = f.operation as unknown as Doc<'paymentOperations'>;
  if (operation.kind === 'wallet_purchase') {
    await requireWalletFundingProof(ctx, operation);
  } else {
    assert.equal(operation.kind, 'checkout_collection');
    if (operation.kind === 'checkout_collection') {
      assert.equal(await validateCheckoutAccounting(ctx, operation), true);
    }
  }
}

for (const source of ['wallet', 'checkout'] as const) {
  test(`${source}: full refund restores exact gross to actual buyer wallet and preserves funding`, async () => {
    const f = await fund(source);
    const balance = num(row(f.db, 'wallets', 'wallets|buyer').balance);
    const original = structuredClone({
      operation: f.operation,
      transactions: f.db.tables.transactions,
      debit: f.db.tables.walletTransactions,
    });
    await outcome(f, 'full');
    assert.equal(row(f.db, 'wallets', 'wallets|buyer').balance, balance + 105);
    assert.equal(row(f.db, 'wallets', 'wallets|seller').balance, 10);
    assert.equal(f.escrow.status, 'refunded');
    assert.equal(record(proof(f).state).kind, 'applied');
    assert.deepEqual(f.operation, original.operation);
    assert.deepEqual(f.db.tables.transactions, original.transactions);
    assert.deepEqual(f.db.tables.walletTransactions?.slice(0, original.debit?.length ?? 0), original.debit);
    await fundingStillValid(f);
  });

  test(`${source}: seller release retains fee, unrelated pending obligations, and counts exactly once`, async () => {
    const f = await fund(source);
    const result = await outcome(f, 'release');
    assert.equal(row(f.db, 'wallets', 'wallets|seller').balance, 110);
    assert.equal(row(f.db, 'wallets', 'wallets|seller').pendingBalance, 70);
    assert.equal(row(f.db, 'wallets', 'wallets|seller').totalEarned, 109);
    assert.equal(row(f.db, 'users', 'users|seller').totalSales, 1);
    assert.equal(row(f.db, 'users', 'users|buyer').totalPurchases, 1);
    assert.equal(f.order.status, 'completed');
    assert.equal(result.accountingOutcome, 'applied');
    const once = structuredClone(f.db.tables);
    await outcome(f, 'release');
    assert.deepEqual(f.db.tables, once);
    await fundingStillValid(f);
  });

  for (const [refund, seller, platform] of [
    [20, 80, 5],
    [102, 0, 3],
    [105, 0, 0],
  ] as const) {
    test(`${source}: partial ${refund} conserves buyer/seller/platform`, async () => {
      const f = await fund(source);
      const before = num(row(f.db, 'wallets', 'wallets|buyer').balance);
      await outcome(f, 'partial', refund);
      assert.equal(row(f.db, 'wallets', 'wallets|buyer').balance, before + refund);
      assert.equal(row(f.db, 'wallets', 'wallets|seller').balance, 10 + num(seller));
      assert.equal(proof(f).retainedPlatformCents, num(platform) * 100);
      assert.equal(row(f.db, 'users', 'users|buyer').totalPurchases, 0);
      assert.equal(row(f.db, 'users', 'users|seller').totalSales, 0);
      const once = structuredClone(f.db.tables);
      await outcome(f, 'partial', refund);
      assert.deepEqual(f.db.tables, once);
      await fundingStillValid(f);
    });
  }

  test(`${source}: missing seller row holds all partial effects with an immutable approval`, async () => {
    const f = await fund(source);
    await f.db.delete('users|seller');
    const before = business(f.db);
    const result = await outcome(f, 'partial', 20);
    assert.equal(result.accountingOutcome, 'review');
    assert.deepEqual(business(f.db), before);
    const approved = structuredClone(proof(f));
    await outcome(f, 'partial', 20);
    assert.deepEqual(proof(f), approved);
    await assert.rejects(outcome(f, 'full'), /decision/i);
    assert.deepEqual(proof(f), approved);
  });

  test(`${source}: missing funding marker never authorizes credit or approval`, async () => {
    const f = await fund(source);
    if (source === 'wallet') {
      delete f.operation.walletTransactionId;
    } else {
      delete f.operation.accounting;
    }
    const before = structuredClone(f.db.tables);
    await assert.rejects(outcome(f, 'full'), /funding/i);
    assert.deepEqual(f.db.tables, before);
  });

  test(`${source}: preexisting linked refund evidence holds instead of duplicate money`, async () => {
    const f = await fund(source);
    f.db.tables.walletTransactions?.push({
      _id: 'walletTransactions|legacy',
      walletId: 'wallets|buyer',
      userId: 'users|buyer',
      orderId: f.order._id,
      type: 'refund',
      source: 'refund',
      amount: 105,
      balanceAfter: 1000,
      reference: 'LEGACY',
      status: 'completed',
      description: 'Test',
      createdAt: 1,
      completedAt: 1,
      updatedAt: 1,
    });
    const before = business(f.db);
    const result = await outcome(f, 'full');
    assert.equal(result.accountingOutcome, 'review');
    assert.deepEqual(business(f.db), before);
    assert.equal(record(proof(f).state).kind, 'pending');
  });
}

for (const kind of ['release', 'full', 'partial'] as const) {
  for (const [subject, error] of [
    [null, /Unauthenticated/],
    ['unknown', /Account not found/],
    ['banned', /banned/],
    ['deleted', /deleted/],
    ['other', /Unauthorized/],
  ] as const) {
    test(`${kind}: denied initiator ${subject} causes no writes`, async () => {
      const f = await fund('wallet');
      const before = structuredClone(f.db.tables);
      await assert.rejects(outcome(f, kind, 20, subject), error);
      assert.deepEqual(f.db.tables, before);
    });
  }
}

for (const amount of [0, -1, 105.01, 0.001, NaN, Infinity]) {
  test(`partial: invalid refund ${amount} causes no approval or business writes`, async () => {
    const f = await fund('wallet');
    const before = structuredClone(f.db.tables);
    await assert.rejects(outcome(f, 'partial', amount), /refund amount/i);
    assert.deepEqual(f.db.tables, before);
  });
}

for (const flags of [{ isFrozen: true }, { isActive: false }, { isFrozen: true, isActive: false }]) {
  test(`release: owned wallet receives money preserving restrictions ${JSON.stringify(flags)}`, async () => {
    const f = await fund('wallet');
    Object.assign(row(f.db, 'wallets', 'wallets|seller'), flags);
    row(f.db, 'appConfig', 'appConfig|1').paymentsEnabled = false;
    await outcome(f, 'release');
    const sellerWallet = row(f.db, 'wallets', 'wallets|seller');
    assert.equal(sellerWallet.balance, 110);
    for (const [key, value] of Object.entries(flags)) {
      assert.equal(sellerWallet[key], value);
    }
    assert.equal(sellerWallet.pendingBalance, 70);
  });
}

for (const deleted of [false, true]) {
  test(`partial: denied beneficiary with owned wallet gets promised money (${deleted ? 'deleted' : 'banned'})`, async () => {
    const f = await fund('wallet');
    Object.assign(row(f.db, 'users', 'users|buyer'), deleted ? { isDeleted: true, deletedAt: 1 } : { isBanned: true });
    Object.assign(row(f.db, 'users', 'users|seller'), deleted ? { isDeleted: true, deletedAt: 1 } : { isBanned: true });
    await outcome(f, 'partial', 20);
    assert.equal(row(f.db, 'wallets', 'wallets|buyer').balance, 915);
    assert.equal(row(f.db, 'wallets', 'wallets|seller').balance, 90);
  });
}

for (const denied of ['banned', 'deleted', 'missing'] as const) {
  test(`partial: ${denied} seller without wallet holds buyer credit too`, async () => {
    const f = await fund('checkout');
    await f.db.delete('wallets|seller');
    if (denied === 'missing') {
      await f.db.delete('users|seller');
    } else {
      Object.assign(
        row(f.db, 'users', 'users|seller'),
        denied === 'deleted' ? { deletedAt: 1, isDeleted: true } : { isBanned: true },
      );
    }
    const before = business(f.db);
    await outcome(f, 'partial');
    assert.deepEqual(business(f.db), before);
    assert.equal(record(proof(f).state).kind, 'pending');
  });
}

for (const corrupt of [
  'duplicate',
  'wrong_owner',
  'balance',
  'pending',
  'earned',
  'spent',
  'withdrawn',
  'counter',
] as const) {
  test(`release: ${corrupt} beneficiary evidence holds without business writes`, async () => {
    const f = await fund('wallet');
    const w = row(f.db, 'wallets', 'wallets|seller');
    if (corrupt === 'duplicate') {
      f.db.tables.wallets?.push({ ...w, _id: 'wallets|duplicate' });
    } else if (corrupt === 'wrong_owner') {
      // Query-selected id points to a conflicting row: do not trust first().
      f.db.tables.wallets?.push({ ...w, _id: 'wallets|buyer' });
    } else if (corrupt === 'counter') {
      row(f.db, 'users', 'users|seller').totalSales = Number.MAX_SAFE_INTEGER;
    } else {
      w[
        {
          balance: 'balance',
          pending: 'pendingBalance',
          earned: 'totalEarned',
          spent: 'totalSpent',
          withdrawn: 'totalWithdrawn',
        }[corrupt]
      ] = NaN;
    }
    const before = business(f.db);
    await outcome(f, 'release');
    assert.deepEqual(business(f.db), before);
    assert.equal(record(proof(f).state).kind, 'pending');
  });
}

for (const corrupt of [
  'escrow_amount',
  'duplicate_escrow',
  'order_owner',
  'order_money',
  'debit_source',
  'debit_amount',
  'duplicate_debit',
] as const) {
  test(`funding: ${corrupt} rejects before approval`, async () => {
    const f = await fund('wallet');
    const debit = row(f.db, 'walletTransactions', str(f.operation.walletTransactionId));
    if (corrupt === 'escrow_amount') {
      f.escrow.amount = 0;
    } else if (corrupt === 'duplicate_escrow') {
      f.db.tables.escrow?.push({ ...f.escrow, _id: 'escrow|duplicate' });
    } else if (corrupt === 'order_owner') {
      f.order.sellerId = 'users|other';
    } else if (corrupt === 'order_money') {
      f.order.platformFee = 0;
    } else if (corrupt === 'debit_source') {
      debit.source = 'admin_adjustment';
    } else if (corrupt === 'debit_amount') {
      debit.amount = 1;
    } else {
      f.db.tables.walletTransactions?.push({ ...debit, _id: 'walletTransactions|duplicate', reference: 'OTHER' });
    }
    const before = structuredClone(f.db.tables);
    await assert.rejects(outcome(f, 'full'), /funding/i);
    assert.deepEqual(f.db.tables, before);
  });
}

test('release requires delivered order before approving', async () => {
  const f = await fund('wallet');
  f.order.status = 'paid';
  const before = structuredClone(f.db.tables);
  await assert.rejects(outcome(f, 'release'), /delivered/i);
  assert.deepEqual(f.db.tables, before);
});

test('full refund retry has no second credit, counters, or notices', async () => {
  const f = await fund('wallet');
  await outcome(f, 'full');
  const once = structuredClone(f.db.tables);
  await outcome(f, 'full');
  assert.deepEqual(f.db.tables, once);
});

function assertCredit(f: Funded, recipient: 'buyer' | 'seller', cents: number, balance: number): void {
  const effects = f.db.tables.walletTransactions?.filter(
    (entry) => entry.escrowId === f.escrow._id && entry.userId === `users|${recipient}`,
  );
  assert.equal(effects?.length, 1);
  const effect = effects?.[0];
  assert.ok(effect);
  assert.equal(effect.amount, cents / 100);
  assert.equal(effect.balanceAfter, balance);
  assert.equal(effect.type, recipient === 'buyer' ? 'refund' : 'credit');
  assert.equal(effect.source, recipient === 'buyer' ? 'refund' : 'escrow_release');
  assert.equal(effect.operationId, f.operation._id);
  assert.equal(effect.orderId, f.order._id);
  assert.equal(effect.walletId, row(f.db, 'wallets', `wallets|${recipient}`)._id);
  assert.equal(effect.status, 'completed');
  assert.equal(effect.createdAt, effect.completedAt);
  assert.equal(effect.updatedAt, effect.completedAt);
  assert.notEqual(effect.reference, f.operation.walletReference);
  assert.notEqual(effect.reference, f.operation.providerReference);
  assert.equal(f.db.tables.walletTransactions?.filter((entry) => entry.reference === effect.reference).length, 1);
}

for (const source of ['wallet', 'checkout'] as const) {
  test(`${source}: completed reciprocal refund and seller ledgers retain lifetime semantics`, async () => {
    const f = await fund(source);
    const buyer = row(f.db, 'wallets', 'wallets|buyer');
    const before = structuredClone(buyer);
    await outcome(f, 'partial', 20);
    assertCredit(f, 'buyer', 2000, num(before.balance) + 20);
    assertCredit(f, 'seller', 8000, 90);
    assert.equal(buyer.totalEarned, before.totalEarned);
    assert.equal(buyer.totalSpent, before.totalSpent);
    assert.equal(buyer.totalWithdrawn, before.totalWithdrawn);
    assert.equal(buyer.pendingBalance, before.pendingBalance);
    assert.equal(row(f.db, 'wallets', 'wallets|seller').pendingBalance, 70);
    assert.equal(proof(f).approvedBy, 'users|reviewer');
  });

  test(`${source}: approval held for missing recipient can retry exactly without replacing approver/time`, async () => {
    const f = await fund(source);
    const seller = structuredClone(row(f.db, 'users', 'users|seller'));
    await f.db.delete(seller._id);
    await outcome(f, 'partial');
    const approval = structuredClone(proof(f));
    f.db.tables.users?.push(seller);
    // Another legitimate reviewer retries the same approval.
    row(f.db, 'users', 'users|other').role = 'admin';
    const result = await outcome(f, 'partial', 20, 'other');
    assert.equal(result.accountingOutcome, 'applied');
    assert.equal(proof(f).approvedBy, approval.approvedBy);
    assert.equal(proof(f).approvedAt, approval.approvedAt);
    assert.equal(row(f.db, 'wallets', 'wallets|seller').balance, 90);
    const once = structuredClone(f.db.tables);
    await outcome(f, 'partial');
    assert.deepEqual(f.db.tables, once);
  });

  for (const kind of ['release', 'full', 'partial'] as const) {
    test(`${source}: ${kind} applied replay ignores later spending and freeze`, async () => {
      const f = await fund(source);
      await outcome(f, kind);
      Object.assign(row(f.db, 'wallets', 'wallets|buyer'), { balance: 0, isActive: false, isFrozen: true });
      Object.assign(row(f.db, 'wallets', 'wallets|seller'), { balance: 0, isActive: false, isFrozen: true });
      const once = structuredClone(f.db.tables);
      assert.equal((await outcome(f, kind)).accountingOutcome, 'applied');
      assert.deepEqual(f.db.tables, once);
    });
  }

  test(`${source}: actual Clerk erasure preserves funding and approved refund replay`, async () => {
    const f = await fund(source);
    await outcome(f, 'partial');
    await invokeFakeFunction(usersModule.anonymizeDeletedUserByClerkId, createCtx(f.db, null), { clerkId: 'buyer' });
    await invokeFakeFunction(usersModule.anonymizeDeletedUserByClerkId, createCtx(f.db, null), { clerkId: 'seller' });
    await fundingStillValid(f);
    const once = structuredClone(f.db.tables);
    assert.equal((await outcome(f, 'partial')).accountingOutcome, 'applied');
    assert.deepEqual(f.db.tables, once);
  });

  for (const tamper of [
    'missing_marker',
    'missing_ledger',
    'amount',
    'owner',
    'wallet',
    'order',
    'escrow',
    'operation',
    'source',
    'type',
    'status',
    'reference',
    'balance',
    'timestamp',
    'duplicate_reference',
    'extra_link',
    'marker_amount',
    'marker_ledger',
    'marker_recipient',
    'counts',
  ] as const) {
    test(`${source}: applied ${tamper} gives review without repair or repeat money`, async () => {
      const f = await fund(source);
      await outcome(f, 'partial');
      const state = record(proof(f).state);
      const effects = state.effects;
      assert.ok(Array.isArray(effects));
      const marker = record(effects[0]);
      const ledger = row(f.db, 'walletTransactions', str(marker.ledgerId));
      if (tamper === 'missing_marker') {
        delete f.escrow.lifecycleProof;
      } else if (tamper === 'missing_ledger') {
        await f.db.delete(ledger._id);
      } else if (tamper === 'duplicate_reference') {
        f.db.tables.walletTransactions?.push({ ...ledger, _id: 'walletTransactions|duplicate' });
      } else if (tamper === 'extra_link') {
        f.db.tables.walletTransactions?.push({ ...ledger, _id: 'walletTransactions|extra', reference: 'EXTRA' });
      } else if (tamper === 'marker_amount') {
        marker.cents = 1;
      } else if (tamper === 'marker_ledger') {
        marker.ledgerId = 'walletTransactions|missing';
      } else if (tamper === 'marker_recipient') {
        marker.recipient = 'seller';
      } else if (tamper === 'counts') {
        state.counts = { buyerBefore: 0, sellerBefore: 0 };
      } else {
        const edits: Record<string, [string, unknown]> = {
          amount: ['amount', 1],
          owner: ['userId', 'users|other'],
          wallet: ['walletId', 'wallets|seller'],
          order: ['orderId', 'orders|foreign'],
          escrow: ['escrowId', 'escrow|foreign'],
          operation: ['operationId', 'paymentOperations|foreign'],
          source: ['source', 'sale'],
          type: ['type', 'credit'],
          status: ['status', 'pending'],
          reference: ['reference', 'FOREIGN'],
          balance: ['balanceAfter', 1],
          timestamp: ['completedAt', 1],
        };
        const edit = edits[tamper];
        assert.ok(edit);
        ledger[edit[0]] = edit[1];
      }
      const before = structuredClone(f.db.tables);
      assert.equal((await outcome(f, 'partial')).accountingOutcome, 'review');
      assert.deepEqual(f.db.tables, before);
    });
  }

  for (const terminal of ['released', 'refunded', 'partially_refunded']) {
    test(`${source}: legacy ${terminal} without proof stays reconciliation-only`, async () => {
      const f = await fund(source);
      f.escrow.status = terminal;
      const before = structuredClone(f.db.tables);
      assert.equal((await outcome(f, 'full')).accountingOutcome, 'review');
      assert.deepEqual(f.db.tables, before);
    });
  }
}

test('partial: fresh active recipients may receive atomically created wallets', async () => {
  const f = await fund('checkout', (db) => {
    db.tables.wallets = [];
  });
  await outcome(f, 'partial');
  const wallets = f.db.tables.wallets ?? [];
  assert.equal(wallets.length, 2);
  const buyer = wallets.find((entry) => entry.userId === 'users|buyer');
  const seller = wallets.find((entry) => entry.userId === 'users|seller');
  assert.ok(buyer && seller);
  assert.equal(buyer.balance, 20);
  assert.equal(buyer.totalSpent, 0);
  assert.equal(buyer.totalEarned, 0);
  assert.equal(seller.balance, 80);
  assert.equal(seller.totalEarned, 80);
  assert.equal(seller.pendingBalance, 0);
});

test('partial: no buyer wallet is created if seller preflight holds', async () => {
  const f = await fund('checkout', (db) => {
    db.tables.wallets = [];
  });
  row(f.db, 'users', 'users|seller').isBanned = true;
  const before = business(f.db);
  await outcome(f, 'partial');
  assert.deepEqual(business(f.db), before);
  assert.equal(f.db.tables.wallets?.length, 0);
});

test('partial: gross refund has zero seller effect and needs no arbitrary seller wallet', async () => {
  const f = await fund('checkout');
  await f.db.delete('wallets|seller');
  await f.db.delete('users|seller');
  await outcome(f, 'partial', 105);
  assert.equal(row(f.db, 'wallets', 'wallets|buyer').balance, 1105);
  assert.equal(f.db.tables.walletTransactions?.filter((entry) => entry.escrowId === f.escrow._id).length, 1);
  assert.equal(record(proof(f).state).kind, 'applied');
});

for (const field of ['balance', 'totalEarned'] as const) {
  test(`release: overflowing ${field} holds instead of clamping`, async () => {
    const f = await fund('wallet');
    row(f.db, 'wallets', 'wallets|seller')[field] = 90071992547409;
    const before = business(f.db);
    await outcome(f, 'release');
    assert.deepEqual(business(f.db), before);
    assert.equal(record(proof(f).state).kind, 'pending');
  });
}

for (const tamper of ['review', 'receipt', 'companion', 'acquisition', 'quote']) {
  test(`checkout funding: ${tamper} denies approval and money`, async () => {
    const f = await fund('checkout');
    if (tamper === 'review') {
      f.operation.reviewNeeded = true;
    } else if (tamper === 'receipt') {
      record(f.operation.receipt).amountMinor = 1;
    } else if (tamper === 'companion') {
      row(f.db, 'transactions', str(f.operation.transactionId)).status = 'refunded';
    } else if (tamper === 'acquisition') {
      f.operation.acquisitions = [];
    } else {
      record(f.operation.quoteSnapshot).totalAmountCents = 1;
    }
    const before = structuredClone(f.db.tables);
    await assert.rejects(outcome(f, 'full'), /funding/i);
    assert.deepEqual(f.db.tables, before);
  });
}

for (const source of ['wallet', 'checkout'] as const) {
  test(`${source}: positive aggregate with a zero order slice counts release without zero credit`, async () => {
    const f = await fund(source, (db) => {
      row(db, 'products', 'products|1').price = 0;
      db.tables.users?.push(user('seller2'));
      db.tables.vendorProfiles?.push({
        _id: 'vendorProfiles|seller2',
        ownerUserId: 'users|seller2',
        status: 'approved',
        storeName: 'Second',
        slug: 'second',
      });
      db.tables.products?.push({
        ...row(db, 'products', 'products|1'),
        _id: 'products|2',
        sellerId: 'users|seller2',
        price: 100,
      });
      db.tables.cartItems?.push({
        ...row(db, 'cartItems', 'cartItems|1'),
        _id: 'cartItems|2',
        productId: 'products|2',
      });
      db.tables.wallets = db.tables.wallets?.filter((w) => w.userId !== 'users|seller') ?? [];
    });
    assert.equal(f.escrow.grossAmount, 0);
    assert.equal(
      f.operation.kind === 'wallet_purchase' ? f.operation.totalAmountCents : f.operation.amountCents,
      10500,
    );
    await outcome(f, 'release');
    assert.equal(row(f.db, 'users', 'users|buyer').totalPurchases, 1);
    assert.equal(row(f.db, 'users', 'users|seller').totalSales, 1);
    assert.equal(f.db.tables.wallets?.filter((w) => w.userId === 'users|seller').length, 0);
    assert.equal(f.db.tables.walletTransactions?.filter((w) => w.escrowId === f.escrow._id).length, 0);
    const once = structuredClone(f.db.tables);
    await outcome(f, 'release');
    assert.deepEqual(f.db.tables, once);
    await fundingStillValid(f);
    const other = f.db.tables.escrow?.find((entry) => entry._id !== f.escrow._id);
    assert.ok(other);
    const sibling = { ...f, escrow: other, order: row(f.db, 'orders', str(other.orderId)) };
    sibling.order.status = 'delivered';
    await outcome(sibling, 'full');
    await fundingStillValid(f);
  });

  test(`${source}: unequal same-seller order slices allow independent lifecycle effects`, async () => {
    const ids = ['orders|first', 'orders|second'];
    const f = await fund(
      source,
      (db) => {
        db.tables.cartItems = [];
        for (const [index, id] of ids.entries()) {
          db.tables.orders?.push({
            _id: id,
            orderNumber: id,
            buyerId: 'users|buyer',
            sellerId: 'users|seller',
            items: [{ productId: 'products|1', title: 'Stale', price: 1, quantity: index + 1, image: '' }],
            subtotal: 0,
            shippingCost: 0,
            platformFee: 0,
            sellerPayout: 0,
            totalAmount: 0,
            shippingAddress: ADDRESS,
            status: 'pending_payment',
            createdAt: 1,
            updatedAt: 1,
          });
        }
      },
      { source: 'pending_orders', orderIds: ids },
    );
    assert.equal(f.escrow.grossAmount, 105);
    await outcome(f, 'partial', 20);
    const second = f.db.tables.escrow?.find((entry) => entry.orderId === 'orders|second');
    assert.ok(second);
    const sibling = { ...f, escrow: second, order: row(f.db, 'orders', str(second.orderId)) };
    sibling.order.status = 'delivered';
    await outcome(sibling, 'release');
    assert.equal(row(f.db, 'wallets', 'wallets|seller').balance, 290);
    assert.equal(row(f.db, 'users', 'users|seller').totalSales, 1);
    assert.equal(row(f.db, 'users', 'users|buyer').totalPurchases, 1);
    await fundingStillValid(f);
    const once = structuredClone(f.db.tables);
    await outcome(f, 'partial');
    await outcome(sibling, 'release');
    assert.deepEqual(f.db.tables, once);
  });
}

for (const historical of [
  { releasedAt: 1 },
  { refundAmount: 105 },
  { sellerPayoutTransactionId: 'transactions|legacy' },
]) {
  test(`novel approval: legacy escrow effect fields hold ${JSON.stringify(historical)}`, async () => {
    const f = await fund('wallet');
    Object.assign(f.escrow, historical);
    const before = business(f.db);
    await outcome(f, 'full');
    assert.deepEqual(business(f.db), before);
    assert.equal(record(proof(f).state).kind, 'pending');
  });
}

test('pending approval with future approval time cannot apply a predating effect', async () => {
  const f = await fund('wallet');
  const seller = structuredClone(row(f.db, 'users', 'users|seller'));
  await f.db.delete(seller._id);
  await outcome(f, 'partial');
  f.db.tables.users?.push(seller);
  proof(f).approvedAt = Date.now() + 3600000;
  const before = structuredClone(f.db.tables);
  assert.equal((await outcome(f, 'partial')).accountingOutcome, 'review');
  assert.deepEqual(f.db.tables, before);
});

test('stored pending proof state corruption cannot be overwritten with financial effects', async () => {
  const f = await fund('wallet');
  const seller = structuredClone(row(f.db, 'users', 'users|seller'));
  await f.db.delete(seller._id);
  await outcome(f, 'partial');
  f.db.tables.users?.push(seller);
  record(proof(f).state).kind = 'corrupt';
  const before = structuredClone(f.db.tables);
  assert.equal((await outcome(f, 'partial')).accountingOutcome, 'review');
  assert.deepEqual(f.db.tables, before);
});

for (const kind of ['release', 'full', 'partial'] as const) {
  test(`${kind}: existing escrow-only legacy release ledger blocks second effects`, async () => {
    const f = await fund('wallet');
    f.db.tables.walletTransactions?.push({
      _id: 'walletTransactions|legacy-release',
      walletId: 'wallets|seller',
      userId: 'users|seller',
      escrowId: f.escrow._id,
      type: 'credit',
      source: 'escrow_release',
      amount: 100,
      balanceAfter: 10,
      reference: 'LEGACY-RELEASE',
      status: 'completed',
      description: 'Test',
      createdAt: 1,
      completedAt: 1,
      updatedAt: 1,
    });
    const before = business(f.db);
    assert.equal((await outcome(f, kind)).accountingOutcome, 'review');
    assert.deepEqual(business(f.db), before);
  });
}

for (const denied of ['missing', 'banned', 'deleted'] as const) {
  test(`checkout: ${denied} buyer without wallet holds full refund`, async () => {
    const f = await fund('checkout');
    await f.db.delete('wallets|buyer');
    if (denied === 'missing') {
      await f.db.delete('users|buyer');
    } else {
      Object.assign(
        row(f.db, 'users', 'users|buyer'),
        denied === 'deleted' ? { deletedAt: 1, isDeleted: true } : { isBanned: true },
      );
    }
    const before = business(f.db);
    await outcome(f, 'full');
    assert.deepEqual(business(f.db), before);
    assert.equal(record(proof(f).state).kind, 'pending');
  });
}

test('checkout: missing buyer with orphan wallet holds promised refund', async () => {
  const f = await fund('checkout');
  await f.db.delete('users|buyer');
  const before = business(f.db);
  await outcome(f, 'full');
  assert.deepEqual(business(f.db), before);
  assert.equal(record(proof(f).state).kind, 'pending');
});

test('refund approval cannot change amount, recipient, or full/partial policy on retry', async () => {
  const f = await fund('wallet');
  await f.db.delete('users|seller');
  await outcome(f, 'partial', 20);
  const before = structuredClone(f.db.tables);
  await assert.rejects(outcome(f, 'partial', 30), /decision/i);
  await assert.rejects(outcome(f, 'full'), /decision/i);
  assert.deepEqual(f.db.tables, before);
});

test('disputed escrow retains original policy for approved refunds', async () => {
  const f = await fund('wallet');
  f.escrow.status = 'disputed';
  f.order.status = 'disputed';
  await outcome(f, 'full');
  assert.equal(row(f.db, 'wallets', 'wallets|buyer').balance, 1000);
  assert.equal(f.order.status, 'disputed');
  assert.equal(row(f.db, 'products', 'products|1').quantity, 9);
  assert.equal(proof(f).originalStatus, 'disputed');
});

for (const kind of ['release', 'full'] as const) {
  test(`${kind}: obsolete internal actor authority arguments are rejected`, async () => {
    const f = await fund('wallet');
    const before = structuredClone(f.db.tables);
    await assert.rejects(
      invokeFakeFunction(
        kind === 'release' ? escrowModule.releaseFunds : escrowModule.refundFull,
        createCtx(f.db, kind === 'release' ? 'buyer' : 'reviewer'),
        {
          escrowId: f.escrow._id,
          ...(kind === 'release' ? { buyerId: 'users|other' } : { moderatorId: 'users|other' }),
        },
      ),
      /Argument validation failed/,
    );
    assert.deepEqual(f.db.tables, before);
  });
}

test('checkout: real discount capture and Clerk erasure still authorize owed refund and replay', async () => {
  const f = await fund(
    'checkout',
    (db) => {
      db.tables.loyaltyAccounts?.push({
        _id: 'loyaltyAccounts|buyer',
        userId: 'users|buyer',
        pointsBalance: 100,
        lifetimeEarned: 100,
        lifetimeRedeemed: 0,
        tier: 'bronze',
        createdAt: 1,
        updatedAt: 1,
      });
    },
    { loyaltyPoints: 20 },
  );
  assert.equal(f.escrow.grossAmount, 102.9);
  await invokeFakeFunction(usersModule.anonymizeDeletedUserByClerkId, createCtx(f.db, null), { clerkId: 'buyer' });
  assert.equal(f.db.tables.loyaltyTransactions?.length, 0);
  assert.equal(f.db.tables.loyaltyAccounts?.length, 0);
  await fundingStillValid(f);
  await outcome(f, 'full');
  assert.equal(row(f.db, 'wallets', 'wallets|buyer').balance, 1102.9);
  assert.equal(row(f.db, 'wallets', 'wallets|buyer').isActive, false);
  assert.equal(row(f.db, 'wallets', 'wallets|buyer').isFrozen, true);
  await fundingStillValid(f);
  const once = structuredClone(f.db.tables);
  assert.equal((await outcome(f, 'full')).accountingOutcome, 'applied');
  assert.deepEqual(f.db.tables, once);
});

test('novel effect reference collision with an unrelated ledger stays held', async () => {
  const f = await fund('wallet');
  f.db.tables.walletTransactions?.push({
    _id: 'walletTransactions|collision',
    walletId: 'wallets|seller',
    userId: 'users|seller',
    type: 'credit',
    source: 'admin_adjustment',
    amount: 1,
    balanceAfter: 10,
    reference: `ESC-${f.escrow._id}-buyer`,
    status: 'completed',
    description: 'Test',
    createdAt: 1,
    completedAt: 1,
    updatedAt: 1,
  });
  const before = business(f.db);
  await outcome(f, 'full');
  assert.deepEqual(business(f.db), before);
  assert.equal(record(proof(f).state).kind, 'pending');
});

test('self-purchase remains prohibited at the real quote boundary, so shared buyer/seller wallet is unreachable', async () => {
  const db = createDb(tables());
  row(db, 'products', 'products|1').sellerId = 'users|buyer';
  const before = structuredClone(db.tables);
  const result = record(
    await invokeFakeFunction(checkoutQuote.quoteCheckout, createCtx(db, 'buyer'), {
      source: 'cart',
      shippingAddress: ADDRESS,
      deliveryMethodId: 'deliveryMethods|1',
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'self_purchase');
  assert.deepEqual(db.tables, before);
});

for (const table of ['walletTransactions', 'transactions']) {
  test(`legacy ${table} metadata-only order linkage holds without guessing absence of effects`, async () => {
    const f = await fund('checkout');
    f.db.tables[table]?.push({
      _id: `${table}|metadata-legacy`,
      userId: 'users|buyer',
      walletId: 'wallets|buyer',
      type: 'refund',
      source: 'refund',
      amount: 105,
      balanceAfter: 1000,
      reference: 'LEGACY-METADATA',
      status: 'completed',
      description: 'Test',
      metadata: { checkoutOrderIds: [f.order._id] },
      createdAt: 1,
      completedAt: 1,
      updatedAt: 1,
    });
    const before = business(f.db);
    await outcome(f, 'full');
    assert.deepEqual(business(f.db), before);
  });
}

for (const status of ['completed', 'cancelled'] as const) {
  test(`refund: positive funding and held escrow retain reviewer policy after order ${status}`, async () => {
    const f = await fund('wallet');
    // Lifecycle labels do not erase complete original funding or change the
    // existing reviewer held/disputed refund policy. No stock is restored.
    f.order.status = status;
    await outcome(f, 'full');
    assert.equal(row(f.db, 'wallets', 'wallets|buyer').balance, 1000);
    assert.equal(f.order.status, status);
    assert.equal(row(f.db, 'products', 'products|1').quantity, 9);
    assert.equal(row(f.db, 'users', 'users|buyer').totalPurchases, 0);
  });
}

async function holdCheckout(f: Funded): Promise<void> {
  const receipt = structuredClone(record(record(f.operation.accounting).receipt));
  const held = record(
    await invokeFakeFunction(providerSettlement.settleProviderReceipt, createCtx(f.db, null), {
      operationId: f.operation._id,
      receipt,
      acquisition: { kind: 'status_get', lookup: { kind: 'reference', reference: 'TXN-unrelated' } },
    }),
  );
  assert.equal(held.application, 'review');
  assert.equal(f.operation.reviewNeeded, true);
  await fundingStillValid(f);
}

// Enforce a synthetic read boundary, without replacing query matching or the
// business writer. The guard accepts any actual indexed equality scope.
function restrictFinancialReads(db: Db): string[] {
  const query = db.query;
  const unscoped: string[] = [];
  db.query = (table) => {
    const builder = query(table);
    if (table !== 'walletTransactions' && table !== 'transactions') {
      return builder;
    }
    let scoped = false;
    const withIndex = builder.withIndex;
    builder.withIndex = (name, build) =>
      withIndex(name, (q) =>
        build({
          eq(field, value) {
            scoped = scoped || value !== undefined;
            return q.eq(field, value);
          },
        }),
      );
    const check = (): void => {
      if (!scoped) {
        unscoped.push(table);
        throw new Error('Synthetic query budget: unscoped financial collection');
      }
    };
    const collect = builder.collect;
    const first = builder.first;
    const take = builder.take;
    builder.collect = async () => {
      check();
      return await collect();
    };
    builder.first = async () => {
      check();
      return await first();
    };
    builder.take = async (count) => {
      check();
      return await take(count);
    };
    return builder;
  };
  return unscoped;
}

for (const kind of ['release', 'full', 'partial'] as const) {
  test(`S1: checkout ${kind} exact applied replay survives real provenance hold`, async () => {
    const f = await fund('checkout');
    assert.equal((await outcome(f, kind)).accountingOutcome, 'applied');
    const approval = structuredClone(proof(f));
    await holdCheckout(f);
    const held = structuredClone(f.db.tables);
    assert.equal((await outcome(f, kind)).accountingOutcome, 'applied');
    assert.deepEqual(f.db.tables, held);
    assert.deepEqual(proof(f), approval);
  });
}

for (const state of ['novel', 'pending'] as const) {
  test(`S1: real checkout review still denies ${state} effects without approval changes`, async () => {
    const f = await fund('checkout');
    if (state === 'pending') {
      const seller = structuredClone(row(f.db, 'users', 'users|seller'));
      await f.db.delete(seller._id);
      assert.equal((await outcome(f, 'partial')).accountingOutcome, 'review');
      f.db.tables.users?.push(seller);
    }
    await holdCheckout(f);
    const before = structuredClone(f.db.tables);
    await assert.rejects(outcome(f, 'partial'), /Escrow funding needs review/);
    assert.deepEqual(f.db.tables, before);
  });
}

for (const tamper of ['receipt', 'companion', 'acquisition', 'quote'] as const) {
  test(`S1: applied checkout with corrupt intrinsic ${tamper} cannot replay`, async () => {
    const f = await fund('checkout');
    await outcome(f, 'full');
    await holdCheckout(f);
    if (tamper === 'receipt') {
      record(f.operation.receipt).amountMinor = 1;
    } else if (tamper === 'companion') {
      row(f.db, 'transactions', str(f.operation.transactionId)).status = 'refunded';
    } else if (tamper === 'acquisition') {
      f.operation.acquisitions = [];
    } else {
      record(f.operation.quoteSnapshot).totalAmountCents = 1;
    }
    const before = structuredClone(f.db.tables);
    await assert.rejects(outcome(f, 'full'), /Escrow funding needs review/);
    assert.deepEqual(f.db.tables, before);
  });
}

for (const tamper of ['decision', 'effect'] as const) {
  test(`S1: applied-looking ${tamper} corruption after hold stays review without novel money`, async () => {
    const f = await fund('checkout');
    await outcome(f, 'partial');
    await holdCheckout(f);
    if (tamper === 'decision') {
      proof(f).approvedAt = Date.now() + 3600000;
    } else {
      const effects = record(proof(f).state).effects;
      assert.ok(Array.isArray(effects));
      record(effects[0]).cents = 1;
    }
    const before = structuredClone(f.db.tables);
    assert.equal((await outcome(f, 'partial')).accountingOutcome, 'review');
    assert.deepEqual(f.db.tables, before);
  });
}

for (const source of ['wallet', 'checkout'] as const) {
  for (const kind of ['release', 'full', 'partial'] as const) {
    test(`Q1: ${source} ${kind} applies and replays with scoped financial reads only`, async () => {
      const f = await fund(source);
      const buyer = num(row(f.db, 'wallets', 'wallets|buyer').balance);
      const original = structuredClone(f.operation);
      const unscoped = restrictFinancialReads(f.db);
      assert.equal((await outcome(f, kind)).accountingOutcome, 'applied');
      assert.equal(
        row(f.db, 'wallets', 'wallets|buyer').balance,
        buyer + (kind === 'full' ? 105 : kind === 'partial' ? 20 : 0),
      );
      assert.equal(
        row(f.db, 'wallets', 'wallets|seller').balance,
        kind === 'release' ? 110 : kind === 'partial' ? 90 : 10,
      );
      assert.equal(row(f.db, 'wallets', 'wallets|seller').pendingBalance, 70);
      const once = structuredClone(f.db.tables);
      assert.equal((await outcome(f, kind)).accountingOutcome, 'applied');
      assert.deepEqual(f.db.tables, once);
      assert.deepEqual(f.operation, original);
      await fundingStillValid(f);
      assert.deepEqual(unscoped, []);
    });
  }

  for (const state of ['novel', 'applied'] as const) {
    test(`Q1: ${source} ${state} foreign-owner escrow-only conflict stays review`, async () => {
      const f = await fund(source);
      if (state === 'applied') {
        await outcome(f, 'full');
      }
      f.db.tables.wallets?.push(wallet('other', 20));
      f.db.tables.walletTransactions?.push({
        _id: 'walletTransactions|foreign-escrow-only',
        walletId: 'wallets|other',
        userId: 'users|other',
        escrowId: f.escrow._id,
        type: 'credit',
        source: 'escrow_release',
        amount: 100,
        balanceAfter: 120,
        reference: 'WLT-foreign-legacy',
        status: 'completed',
        description: 'Synthetic conflicting legacy evidence',
        createdAt: 1,
        completedAt: 1,
        updatedAt: 1,
      });
      const before = business(f.db);
      const approval = state === 'applied' ? structuredClone(proof(f)) : undefined;
      assert.equal((await outcome(f, 'full')).accountingOutcome, 'review');
      assert.deepEqual(business(f.db), before);
      if (approval) {
        assert.deepEqual(proof(f), approval);
      } else {
        assert.equal(record(proof(f).state).reason, 'effect_review');
      }
    });
  }
}

test('Q1: pending checkout approval retries under scoped financial read restriction', async () => {
  const f = await fund('checkout');
  const seller = structuredClone(row(f.db, 'users', 'users|seller'));
  await f.db.delete(seller._id);
  assert.equal((await outcome(f, 'partial')).accountingOutcome, 'review');
  const approved = structuredClone(proof(f));
  f.db.tables.users?.push(seller);
  const unscoped = restrictFinancialReads(f.db);
  assert.equal((await outcome(f, 'partial')).accountingOutcome, 'applied');
  assert.equal(proof(f).approvedBy, approved.approvedBy);
  assert.equal(proof(f).approvedAt, approved.approvedAt);
  assert.equal(row(f.db, 'wallets', 'wallets|buyer').balance, 1020);
  assert.equal(row(f.db, 'wallets', 'wallets|seller').balance, 90);
  assert.deepEqual(unscoped, []);
});

// ---- Task4C2a: public order completion and valid pre-shipping cancellation ----
// These tests execute the REAL registered order handlers (completeOrder,
// updateOrderStatus, cancelOrder) against genuine quote -> wallet purchase or
// checkout claim -> trusted settlement funding chains. Only external fetch is
// synthetic. Serial fake models neither rollback nor deployed OCC/JWT/index.

async function completeVia(
  f: Funded,
  entry: 'complete' | 'status',
  subject: string | null = 'buyer',
): Promise<Record<string, unknown>> {
  if (entry === 'complete') {
    return record(
      await invokeFakeFunction(ordersModule.completeOrder, createCtx(f.db, subject), { orderId: f.order._id }),
    );
  }
  return record(
    await invokeFakeFunction(ordersModule.updateOrderStatus, createCtx(f.db, subject), {
      orderId: f.order._id,
      status: 'completed',
    }),
  );
}

async function cancelVia(
  f: Funded,
  entry: 'cancel' | 'status',
  subject: string | null,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  if (entry === 'cancel') {
    return record(
      await invokeFakeFunction(ordersModule.cancelOrder, createCtx(f.db, subject), {
        orderId: f.order._id,
        ...extra,
      }),
    );
  }
  return record(
    await invokeFakeFunction(ordersModule.updateOrderStatus, createCtx(f.db, subject), {
      orderId: f.order._id,
      status: 'cancelled',
      ...extra,
    }),
  );
}

for (const source of ['wallet', 'checkout'] as const) {
  for (const entry of ['complete', 'status'] as const) {
    test(`C2a: ${source} ${entry} completes a funded delivered order with seller payout counted once`, async () => {
      const f = await fund(source);
      assert.equal(f.order.status, 'delivered');
      const completed = await completeVia(f, entry);
      assert.equal(completed.status, 'completed');
      assert.equal(completed.accountingOutcome, 'applied');
      assert.equal(row(f.db, 'wallets', 'wallets|seller').balance, 110);
      assert.equal(row(f.db, 'wallets', 'wallets|seller').pendingBalance, 70);
      assert.equal(row(f.db, 'users', 'users|seller').totalSales, 1);
      assert.equal(row(f.db, 'users', 'users|buyer').totalPurchases, 1);
      assert.equal(f.escrow.status, 'released');
      assert.equal(record(proof(f).state).kind, 'applied');
      await fundingStillValid(f);
      // The completed order is terminal: a second completion is refused
      // without repeat money, counters, or notices.
      const once = structuredClone(f.db.tables);
      await assert.rejects(completeVia(f, entry), /delivered|Cannot transition/);
      assert.deepEqual(f.db.tables, once);
    });
  }

  test(`C2a: ${source} completeOrder holds review with business state unchanged when seller is gone`, async () => {
    const f = await fund(source);
    await f.db.delete('users|seller');
    const before = business(f.db);
    const completed = await completeVia(f, 'complete');
    assert.equal(completed.accountingOutcome, 'review');
    assert.equal(completed.status, 'delivered');
    assert.equal(row(f.db, 'users', 'users|buyer').totalPurchases, 0);
    assert.deepEqual(business(f.db), before);
    assert.equal(record(proof(f).state).kind, 'pending');
  });

  test(`C2a: ${source} completeOrder never authorizes seller credit from a missing funding marker`, async () => {
    const f = await fund(source);
    if (source === 'wallet') {
      delete f.operation.walletTransactionId;
    } else {
      delete f.operation.accounting;
    }
    const before = structuredClone(f.db.tables);
    await assert.rejects(completeVia(f, 'complete'), /funding/i);
    assert.deepEqual(f.db.tables, before);
  });

  test(`C2a: ${source} cancelOrder refunds a paid order to the buyer wallet with stock restored`, async () => {
    const f = await fund(source);
    f.order.status = 'paid';
    const buyerBefore = num(row(f.db, 'wallets', 'wallets|buyer').balance);
    const original = structuredClone({
      operation: f.operation,
      transactions: f.db.tables.transactions,
      debit: f.db.tables.walletTransactions?.slice(0, f.db.tables.walletTransactions?.length ?? 0),
    });
    assert.equal(row(f.db, 'products', 'products|1').quantity, 9);
    const cancelled = await cancelVia(f, 'cancel', 'buyer', { reason: 'Changed my mind' });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.accountingOutcome, 'applied');
    assert.equal(row(f.db, 'wallets', 'wallets|buyer').balance, buyerBefore + 105);
    assert.equal(row(f.db, 'wallets', 'wallets|seller').balance, 10);
    assert.equal(f.escrow.status, 'refunded');
    assert.equal(record(proof(f).state).kind, 'applied');
    assert.equal(proof(f).kind, 'full_refund');
    assert.equal(row(f.db, 'orders', f.order._id).notes, 'Changed my mind');
    assert.equal(row(f.db, 'products', 'products|1').quantity, 10);
    assert.equal(row(f.db, 'products', 'products|1').status, 'active');
    // Original funding evidence is immutable: the purchase debit and the
    // captured provider companion keep their recorded outcome.
    assert.deepEqual(f.operation, original.operation);
    assert.deepEqual(f.db.tables.walletTransactions?.slice(0, original.debit?.length ?? 0), original.debit);
    await fundingStillValid(f);
    // Terminal without a second refund or restock.
    const once = structuredClone(f.db.tables);
    await assert.rejects(cancelVia(f, 'cancel', 'buyer'), /cannot be cancelled/);
    assert.deepEqual(f.db.tables, once);
    assert.equal(row(f.db, 'wallets', 'wallets|buyer').balance, buyerBefore + 105);
    assert.equal(row(f.db, 'products', 'products|1').quantity, 10);
  });
}

test('C2a: checkout updateOrderStatus cancelled refunds a captured order through the moderator path', async () => {
  const f = await fund('checkout');
  f.order.status = 'paid';
  const companion = structuredClone(row(f.db, 'transactions', str(f.operation.transactionId)));
  assert.equal(companion.status, 'successful');
  const buyerBefore = num(row(f.db, 'wallets', 'wallets|buyer').balance);
  const cancelled = await cancelVia(f, 'status', 'reviewer');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.accountingOutcome, 'applied');
  assert.equal(row(f.db, 'wallets', 'wallets|buyer').balance, buyerBefore + 105);
  assert.equal(f.escrow.status, 'refunded');
  assert.equal(row(f.db, 'products', 'products|1').quantity, 10);
  // The captured provider companion is refund authority history, never
  // relabeled by one slice of the aggregate checkout.
  assert.deepEqual(row(f.db, 'transactions', str(f.operation.transactionId)), companion);
  await fundingStillValid(f);
});

test('C2a: wallet updateOrderStatus cancelled refunds a paid order through the moderator path', async () => {
  const f = await fund('wallet');
  f.order.status = 'paid';
  const buyerBefore = num(row(f.db, 'wallets', 'wallets|buyer').balance);
  const cancelled = await cancelVia(f, 'status', 'reviewer');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.accountingOutcome, 'applied');
  assert.equal(row(f.db, 'wallets', 'wallets|buyer').balance, buyerBefore + 105);
  assert.equal(f.escrow.status, 'refunded');
  await fundingStillValid(f);
});

test('C2a: wallet cancel restores repeated lines sharing one product stock exactly', async () => {
  const f = await fund('wallet', (db) => {
    db.tables.cartItems?.push({
      _id: 'cartItems|2',
      userId: 'users|buyer',
      productId: 'products|1',
      quantity: 2,
      selectedShipping: { name: 'Free', price: 0 },
      createdAt: 1,
      updatedAt: 1,
    });
  });
  f.order.status = 'paid';
  const gross = num(f.escrow.grossAmount);
  assert.equal(row(f.db, 'products', 'products|1').quantity, 10 - 3);
  const buyerBefore = num(row(f.db, 'wallets', 'wallets|buyer').balance);
  const cancelled = await cancelVia(f, 'cancel', 'buyer');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.accountingOutcome, 'applied');
  assert.equal(row(f.db, 'wallets', 'wallets|buyer').balance, buyerBefore + gross);
  assert.equal(row(f.db, 'products', 'products|1').quantity, 10);
  await fundingStillValid(f);
});

test('C2a: paid legacy marker escrow cannot cancel with a pretend refund', async () => {
  const f = await fund('wallet');
  f.order.status = 'paid';
  delete f.order.operationId;
  delete f.escrow.operationId;
  const before = structuredClone(f.db.tables);
  await assert.rejects(cancelVia(f, 'cancel', 'buyer'), /review/i);
  assert.deepEqual(f.db.tables, before);
  await assert.rejects(cancelVia(f, 'status', 'reviewer'), /review/i);
  assert.deepEqual(f.db.tables, before);
});

for (const [subject, pattern] of [
  [null, /Unauthenticated/],
  ['unknown', /Account not found/],
  ['banned', /banned/],
  ['deleted', /deleted/],
  ['other', /Unauthorized/],
  ['seller', /Unauthorized/],
] as const) {
  test(`C2a: denied initiator ${subject} cannot complete a funded delivered order`, async () => {
    const f = await fund('wallet');
    const before = structuredClone(f.db.tables);
    await assert.rejects(completeVia(f, 'complete', subject), pattern);
    assert.deepEqual(f.db.tables, before);
    // The status entry turns the same non-buyer away at its transition gate.
    const statusPattern = subject === 'other' || subject === 'seller' ? /Cannot transition/ : pattern;
    await assert.rejects(completeVia(f, 'status', subject), statusPattern);
    assert.deepEqual(f.db.tables, before);
  });

  test(`C2a: denied initiator ${subject} cannot cancel a funded paid order`, async () => {
    const f = await fund('wallet');
    f.order.status = 'paid';
    const before = structuredClone(f.db.tables);
    const expected = subject === 'other' || subject === 'seller' ? /Unauthorized|Cannot transition/ : pattern;
    await assert.rejects(cancelVia(f, 'cancel', subject), expected);
    assert.deepEqual(f.db.tables, before);
  });
}

// ---- Task4C2a fix r1 (S1/Q1): participant-owned ambiguity before the unfunded fallback ----
// These regressions execute the REAL registered createOrder/cancelOrder/
// updateOrderStatus handlers. The funded fixture supplies unchanged existing
// money; the unfunded target is a genuine registered createOrder; only the
// legacy/corruption links below are clearly labelled synthetic plants. Serial
// fake models neither rollback nor deployed OCC/JWT/index.

async function createUnfundedTarget(f: Funded): Promise<string> {
  return str(
    await invokeFakeFunction(ordersModule.createOrder, createCtx(f.db, 'buyer'), {
      sellerId: 'users|seller',
      items: [
        {
          productId: 'products|1',
          title: 'Synthetic lamp',
          price: 100,
          quantity: 1,
          image: 'https://images.invalid/lamp.jpg',
        },
      ],
      subtotal: 100,
      shippingCost: 0,
      shippingAddress: {
        street: 'Synthetic street',
        city: 'Test',
        province: 'Test',
        country: 'Zambia',
        phone: '+260971234567',
      },
    }),
  );
}

async function cancelTargetVia(
  f: Funded,
  entry: 'cancel' | 'status',
  subject: string | null,
  targetId: string,
): Promise<Record<string, unknown>> {
  f.order = row(f.db, 'orders', targetId);
  return cancelVia(f, entry, subject);
}

for (const entry of ['cancel', 'status'] as const) {
  const subject = entry === 'cancel' ? 'buyer' : 'reviewer';

  test(`C2aR1: ${entry} holds review for buyer-owned wallet ledger metadata naming the unfunded target`, async () => {
    const f = await fund('wallet');
    const targetId = await createUnfundedTarget(f);
    f.db.tables.walletTransactions?.push({
      _id: 'walletTransactions|legacy-buyer-meta',
      walletId: 'wallets|buyer',
      userId: 'users|buyer',
      type: 'debit',
      source: 'purchase',
      amount: 105,
      balanceAfter: 1,
      reference: 'WLT-legacy-buyer-meta',
      status: 'completed',
      description: 'Synthetic legacy buyer history',
      metadata: { orderIds: [targetId] },
      createdAt: 1,
      completedAt: 1,
      updatedAt: 1,
    });
    const before = structuredClone(f.db.tables);
    const stockBefore = num(row(f.db, 'products', 'products|1').quantity);
    await assert.rejects(cancelTargetVia(f, entry, subject, targetId), /missing payment record to review/);
    assert.deepEqual(f.db.tables, before);
    assert.equal(num(row(f.db, 'products', 'products|1').quantity), stockBefore);
    assert.deepEqual(f.db.tables.escrow, before.escrow);
  });

  test(`C2aR1: ${entry} holds review for buyer-owned provider transaction metadata naming the unfunded target`, async () => {
    const f = await fund('wallet');
    const targetId = await createUnfundedTarget(f);
    f.db.tables.transactions?.push({
      _id: 'transactions|legacy-buyer-meta',
      userId: 'users|buyer',
      type: 'collection',
      paymentMethod: 'mobile_money',
      reference: 'TXN-legacy-buyer-meta',
      amount: 105,
      currency: 'ZMW',
      status: 'processing',
      metadata: { checkoutOrderIds: [targetId] },
      initiatedAt: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    const before = structuredClone(f.db.tables);
    const stockBefore = num(row(f.db, 'products', 'products|1').quantity);
    await assert.rejects(cancelTargetVia(f, entry, subject, targetId), /missing payment record to review/);
    assert.deepEqual(f.db.tables, before);
    assert.equal(num(row(f.db, 'products', 'products|1').quantity), stockBefore);
    assert.deepEqual(f.db.tables.escrow, before.escrow);
  });

  test(`C2aR1: ${entry} holds review for buyer-owned operation reverse orderIds naming the unfunded target`, async () => {
    const f = await fund('wallet');
    const targetId = await createUnfundedTarget(f);
    (f.operation.orderIds as Array<string>).push(targetId);
    const before = structuredClone(f.db.tables);
    const stockBefore = num(row(f.db, 'products', 'products|1').quantity);
    await assert.rejects(cancelTargetVia(f, entry, subject, targetId), /missing payment record to review/);
    assert.deepEqual(f.db.tables, before);
    assert.equal(num(row(f.db, 'products', 'products|1').quantity), stockBefore);
    assert.deepEqual(f.db.tables.escrow, before.escrow);
  });

  test(`C2aR1: ${entry} holds review for seller-owned wallet ledger metadata naming the unfunded target`, async () => {
    const f = await fund('wallet');
    const targetId = await createUnfundedTarget(f);
    f.db.tables.walletTransactions?.push({
      _id: 'walletTransactions|legacy-seller-meta',
      walletId: 'wallets|seller',
      userId: 'users|seller',
      type: 'credit',
      source: 'sale',
      amount: 100,
      balanceAfter: 110,
      reference: 'WLT-legacy-seller-meta',
      status: 'completed',
      description: 'Synthetic legacy seller history',
      metadata: { orderIds: [targetId] },
      createdAt: 1,
      completedAt: 1,
      updatedAt: 1,
    });
    const before = structuredClone(f.db.tables);
    const stockBefore = num(row(f.db, 'products', 'products|1').quantity);
    await assert.rejects(cancelTargetVia(f, entry, subject, targetId), /missing payment record to review/);
    assert.deepEqual(f.db.tables, before);
    assert.equal(num(row(f.db, 'products', 'products|1').quantity), stockBefore);
    assert.deepEqual(f.db.tables.escrow, before.escrow);
  });

  test(`C2aR1: ${entry} holds review for seller-owned provider transaction metadata naming the unfunded target`, async () => {
    const f = await fund('wallet');
    const targetId = await createUnfundedTarget(f);
    f.db.tables.transactions?.push({
      _id: 'transactions|legacy-seller-meta',
      userId: 'users|seller',
      type: 'collection',
      paymentMethod: 'mobile_money',
      reference: 'TXN-legacy-seller-meta',
      amount: 100,
      currency: 'ZMW',
      status: 'processing',
      metadata: { checkoutOrderIds: [targetId] },
      initiatedAt: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    const before = structuredClone(f.db.tables);
    const stockBefore = num(row(f.db, 'products', 'products|1').quantity);
    await assert.rejects(cancelTargetVia(f, entry, subject, targetId), /missing payment record to review/);
    assert.deepEqual(f.db.tables, before);
    assert.equal(num(row(f.db, 'products', 'products|1').quantity), stockBefore);
    assert.deepEqual(f.db.tables.escrow, before.escrow);
  });

  test(`C2aR1: ${entry} still stock-cancels a genuine unfunded target despite unrelated owned history`, async () => {
    const f = await fund('wallet');
    const targetId = await createUnfundedTarget(f);
    // Unrelated-owner metadata naming the target grants no authority and
    // must not block the owner heuristic; the fixture's own prior funding
    // names only its funded order, never this target.
    f.db.tables.walletTransactions?.push({
      _id: 'walletTransactions|unrelated-meta',
      walletId: 'wallets|other',
      userId: 'users|other',
      type: 'debit',
      source: 'purchase',
      amount: 50,
      balanceAfter: 1,
      reference: 'WLT-unrelated-meta',
      status: 'completed',
      description: 'Synthetic unrelated history',
      metadata: { orderIds: [targetId] },
      createdAt: 1,
      completedAt: 1,
      updatedAt: 1,
    });
    assert.equal(num(row(f.db, 'products', 'products|1').quantity), 8);
    const buyerBefore = num(row(f.db, 'wallets', 'wallets|buyer').balance);
    const sellerBefore = num(row(f.db, 'wallets', 'wallets|seller').balance);
    const escrowBefore = structuredClone(f.db.tables.escrow);
    const cancelled = await cancelTargetVia(f, entry, subject, targetId);
    assert.equal(cancelled.status, 'cancelled');
    assert.ok(!('accountingOutcome' in cancelled));
    assert.equal(num(row(f.db, 'products', 'products|1').quantity), 9);
    assert.equal(num(row(f.db, 'wallets', 'wallets|buyer').balance), buyerBefore);
    assert.equal(num(row(f.db, 'wallets', 'wallets|seller').balance), sellerBefore);
    assert.deepEqual(f.db.tables.escrow, escrowBefore);
  });
}

// ---- Task4C2b1: genuine funding -> shipping -> dispute -> public decision ----
type StaffDecision = 'full_refund' | 'partial_refund' | 'no_refund' | 'mutual_agreement';
type BuyerDecision = 'withdraw' | 'received_item' | 'issue_resolved' | 'agreed_refund';
type Disputed = Funded & { dispute: Row };

async function openFundedDispute(source: Source, delivered = true): Promise<Disputed> {
  const f = await fund(source);
  // fund's old wrapper fixture sets delivered; start from the actual paid
  // funding result and exercise each registered transport lifecycle handler.
  f.order.status = 'paid';
  await invokeFakeFunction(ordersModule.updateOrderStatus, createCtx(f.db, 'seller'), {
    orderId: f.order._id,
    status: 'processing',
  });
  await invokeFakeFunction(ordersModule.updateOrderStatus, createCtx(f.db, 'seller'), {
    orderId: f.order._id,
    status: 'shipped',
  });
  if (delivered) {
    await invokeFakeFunction(ordersModule.confirmDelivery, createCtx(f.db, 'buyer'), { orderId: f.order._id });
  }
  const id = str(
    await invokeFakeFunction(disputesModule.createDispute, createCtx(f.db, 'buyer'), {
      orderId: f.order._id,
      title: 'Synthetic defect',
      description: 'Synthetic test only',
      category: 'defective',
      evidence: [],
    }),
  );
  return { ...f, dispute: row(f.db, 'disputes', id) };
}

async function staffDecision(
  f: Disputed,
  resolutionType: StaffDecision,
  refundAmount?: number,
  subject: string | null = 'reviewer',
): Promise<Record<string, unknown>> {
  return record(
    await invokeFakeFunction(disputesModule.resolveDispute, createCtx(f.db, subject), {
      disputeId: f.dispute._id,
      resolutionType,
      notes: 'Verified staff notes',
      ...(refundAmount === undefined ? {} : { refundAmount }),
    }),
  );
}

async function buyerDecision(
  f: Disputed,
  resolutionType: BuyerDecision,
  subject: string | null = 'buyer',
): Promise<Record<string, unknown>> {
  return record(
    await invokeFakeFunction(disputesModule.buyerResolveDispute, createCtx(f.db, subject), {
      disputeId: f.dispute._id,
      resolutionType,
      notes: 'Verified buyer notes',
    }),
  );
}

for (const source of ['wallet', 'checkout'] as const) {
  for (const decision of [
    { type: 'full_refund', amount: 3, buyer: 105, seller: 0, fee: 0 },
    { type: 'partial_refund', amount: 20, buyer: 20, seller: 80, fee: 5 },
    { type: 'partial_refund', amount: 102, buyer: 102, seller: 0, fee: 3 },
    { type: 'partial_refund', amount: 105, buyer: 105, seller: 0, fee: 0 },
    { type: 'no_refund', amount: 2, buyer: 0, seller: 100, fee: 5 },
  ] as const) {
    test(`C2b1: ${source} staff ${decision.type} ${decision.amount} moves owed money and preserves funding and stock`, async () => {
      const f = await openFundedDispute(source, decision.type !== 'full_refund');
      const buyerBefore = num(row(f.db, 'wallets', 'wallets|buyer').balance);
      const original = structuredClone({
        operation: f.operation,
        transactions: f.db.tables.transactions,
        debit: f.db.tables.walletTransactions,
        products: f.db.tables.products,
      });
      const result = await staffDecision(f, decision.type, decision.amount);
      // Money first: the original RED must prove marker-only behavior.
      assert.equal(row(f.db, 'wallets', 'wallets|buyer').balance, buyerBefore + decision.buyer);
      assert.equal(row(f.db, 'wallets', 'wallets|seller').balance, 10 + decision.seller);
      assert.equal(result.accountingOutcome, 'applied');
      assert.equal(result.status, 'resolved');
      assert.equal(f.order.status, decision.type === 'full_refund' ? 'cancelled' : 'completed');
      assert.equal(
        record(f.dispute.resolution).refundAmount,
        decision.type === 'no_refund' ? undefined : decision.buyer,
      );
      assert.equal(proof(f).retainedPlatformCents, decision.fee * 100);
      assert.equal(row(f.db, 'users', 'users|seller').totalSales, decision.type === 'no_refund' ? 1 : 0);
      assert.equal(row(f.db, 'users', 'users|buyer').totalPurchases, decision.type === 'no_refund' ? 1 : 0);
      assert.equal(row(f.db, 'wallets', 'wallets|seller').pendingBalance, 70);
      assert.deepEqual(f.operation, original.operation);
      assert.deepEqual(f.db.tables.transactions, original.transactions);
      assert.deepEqual(f.db.tables.walletTransactions?.slice(0, original.debit?.length ?? 0), original.debit);
      assert.deepEqual(f.db.tables.products, original.products);
      assert.equal(
        f.db.tables.walletTransactions?.length,
        (original.debit?.length ?? 0) + Number(decision.buyer > 0) + Number(decision.seller > 0),
      );
      assert.equal(f.db.tables.messages?.at(-1)?.speakerSide, 'moderator');
      assert.equal(record(f.dispute.resolution).notes, 'Verified staff notes');
      await fundingStillValid(f);
      const after = structuredClone(f.db.tables);
      await assert.rejects(() => staffDecision(f, decision.type, decision.amount), /already resolved or closed/);
      assert.deepEqual(f.db.tables, after);
    });
  }
  for (const decision of ['withdraw', 'received_item', 'issue_resolved'] as const) {
    test(`C2b1: ${source} buyer ${decision} releases seller money once with original funding intact`, async () => {
      const f = await openFundedDispute(source);
      const result = await buyerDecision(f, decision);
      assert.equal(row(f.db, 'wallets', 'wallets|seller').balance, 110);
      assert.equal(result.accountingOutcome, 'applied');
      assert.equal(f.order.status, 'completed');
      assert.equal(row(f.db, 'users', 'users|seller').totalSales, 1);
      assert.equal(row(f.db, 'users', 'users|buyer').totalPurchases, 1);
      assert.equal(record(f.dispute.resolution).type, 'mutual_agreement');
      assert.equal(f.db.tables.messages?.at(-1)?.speakerSide, 'buyer');
      assert.equal(f.db.tables.notifications?.at(-1)?.title, 'Dispute Resolved');
      await fundingStillValid(f);
      const after = structuredClone(f.db.tables);
      await assert.rejects(() => buyerDecision(f, decision), /cannot be resolved at this stage/);
      assert.deepEqual(f.db.tables, after);
    });
  }
  test(`C2b1: ${source} missing beneficiary holds immutable staff approval without business writes`, async () => {
    const f = await openFundedDispute(source);
    await f.db.delete('users|seller');
    const before = business(f.db);
    const result = await staffDecision(f, 'no_refund');
    assert.deepEqual(business(f.db), before);
    assert.equal(result.accountingOutcome, 'review');
    assert.equal(proof(f).approvedBy, 'users|reviewer');
    assert.equal(record(proof(f).state).kind, 'pending');
  });
}

test('C2b1: unsupported new staff mutual agreement changes nothing', async () => {
  const f = await openFundedDispute('wallet');
  const before = structuredClone(f.db.tables);
  await assert.rejects(() => staffDecision(f, 'mutual_agreement'), /Unsupported dispute resolution/);
  assert.deepEqual(f.db.tables, before);
});

for (const entry of ['staff', 'buyer'] as const) {
  test(`C2b1: ${entry} rejects a foreign authoritative dispute triple before any write`, async () => {
    const f = await openFundedDispute('wallet');
    f.dispute.orderId = 'orders|foreign';
    f.db.tables.orders?.push({ ...structuredClone(f.order), _id: 'orders|foreign' });
    const before = structuredClone(f.db.tables);
    await assert.rejects(
      () => (entry === 'staff' ? staffDecision(f, 'full_refund') : buyerDecision(f, 'withdraw')),
      /Dispute records need review/,
    );
    assert.deepEqual(f.db.tables, before);
  });
}

test('C2b1: buyer agreed refund cannot bypass a sealed pending financial approval', async () => {
  const f = await openFundedDispute('wallet');
  await f.db.delete('users|seller');
  await staffDecision(f, 'no_refund');
  const before = structuredClone(f.db.tables);
  await assert.rejects(() => buyerDecision(f, 'agreed_refund'), /immutable approved decision/);
  assert.deepEqual(f.db.tables, before);
});

test('C2b1: buyer agreed refund remains pending with no financial or order effects', async () => {
  const f = await openFundedDispute('checkout');
  const before = structuredClone({
    escrow: f.escrow,
    order: f.order,
    wallets: f.db.tables.wallets,
    ledgers: f.db.tables.walletTransactions,
    transactions: f.db.tables.transactions,
    users: f.db.tables.users,
    products: f.db.tables.products,
  });
  const result = await buyerDecision(f, 'agreed_refund');
  assert.equal(result.status, 'in_discussion');
  assert.equal(result.accountingOutcome, undefined);
  assert.equal(f.dispute.resolution, undefined);
  assert.deepEqual(
    {
      escrow: f.escrow,
      order: f.order,
      wallets: f.db.tables.wallets,
      ledgers: f.db.tables.walletTransactions,
      transactions: f.db.tables.transactions,
      users: f.db.tables.users,
      products: f.db.tables.products,
    },
    before,
  );
  assert.equal(f.db.tables.notifications?.at(-1)?.title, 'Refund Agreement Pending');
  assert.match(str(f.db.tables.messages?.at(-1)?.content), /pending processing/);
});

for (const amount of [undefined, 0, -1, 106, 20.001, Number.MAX_SAFE_INTEGER, NaN, Infinity]) {
  test(`C2b1: partial refund ${String(amount)} rejects before all writes`, async () => {
    const f = await openFundedDispute('wallet');
    const before = structuredClone(f.db.tables);
    await assert.rejects(() => staffDecision(f, 'partial_refund', amount), /Invalid refund amount/);
    assert.deepEqual(f.db.tables, before);
  });
}

for (const entry of ['staff', 'buyer'] as const) {
  for (const attempt of [
    { subject: null, pattern: /Unauthenticated/ },
    { subject: 'unknown', pattern: /Account not found/ },
    { subject: 'banned', pattern: /Account is banned/ },
    { subject: 'deleted', pattern: /Account is deleted/ },
    { subject: 'seller', pattern: entry === 'staff' ? /Unauthorized/ : /Only the buyer/ },
    { subject: 'other', pattern: entry === 'staff' ? /Unauthorized/ : /Only the buyer/ },
  ]) {
    test(`C2b1: ${entry} denies ${String(attempt.subject)} before approval or any write`, async () => {
      const f = await openFundedDispute('wallet');
      const before = structuredClone(f.db.tables);
      await assert.rejects(
        () =>
          entry === 'staff'
            ? staffDecision(f, 'no_refund', undefined, attempt.subject)
            : buyerDecision(f, 'withdraw', attempt.subject),
        attempt.pattern,
      );
      assert.deepEqual(f.db.tables, before);
    });
  }
}

test('C2b1: catalog/company delegate has no financial staff decision authority', async () => {
  const f = await openFundedDispute('wallet');
  row(f.db, 'users', 'users|other').role = 'catalog_manager';
  const before = structuredClone(f.db.tables);
  await assert.rejects(() => staffDecision(f, 'no_refund', undefined, 'other'), /Unauthorized/);
  assert.deepEqual(f.db.tables, before);
});

for (const tamper of [
  'buyer',
  'seller',
  'missing_order',
  'missing_escrow',
  'duplicate_escrow',
  'duplicate_dispute',
  'order_status',
  'recorded_resolution',
] as const) {
  test(`C2b1: authoritative ${tamper} rejects staff and buyer including nonmoney agreement`, async () => {
    const f = await openFundedDispute('checkout');
    if (tamper === 'buyer') {
      f.escrow.buyerId = 'users|other';
    }
    if (tamper === 'seller') {
      f.dispute.sellerId = 'users|other';
    }
    if (tamper === 'missing_order') {
      await f.db.delete(str(f.order._id));
    }
    if (tamper === 'missing_escrow') {
      await f.db.delete(str(f.escrow._id));
    }
    if (tamper === 'duplicate_escrow') {
      f.db.tables.escrow?.push({ ...structuredClone(f.escrow), _id: 'escrow|duplicate' });
    }
    if (tamper === 'duplicate_dispute') {
      f.db.tables.disputes?.push({ ...structuredClone(f.dispute), _id: 'disputes|duplicate' });
    }
    if (tamper === 'order_status') {
      f.order.status = 'delivered';
    }
    if (tamper === 'recorded_resolution') {
      f.dispute.resolution = {
        type: 'full_refund',
        refundAmount: 105,
        resolvedBy: 'users|reviewer',
        notes: 'Historical',
        resolvedAt: 1,
      };
    }
    const before = structuredClone(f.db.tables);
    const pattern =
      tamper === 'missing_escrow'
        ? /Escrow not found/
        : tamper === 'recorded_resolution'
          ? /recorded resolution/
          : /Dispute records need review/;
    await assert.rejects(() => staffDecision(f, 'full_refund'), pattern);
    await assert.rejects(() => buyerDecision(f, 'withdraw'), pattern);
    await assert.rejects(() => buyerDecision(f, 'agreed_refund'), pattern);
    assert.deepEqual(f.db.tables, before);
  });
}

for (const tamper of ['receipt', 'funding', 'checkout_hold'] as const) {
  test(`C2b1: invalid ${tamper} cannot approve or apply a dispute decision`, async () => {
    const f = await openFundedDispute(tamper === 'funding' ? 'wallet' : 'checkout');
    if (tamper === 'receipt') {
      record(f.operation.receipt).status = 'pending';
    }
    if (tamper === 'funding') {
      f.operation.walletTransactionId = 'walletTransactions|unknown';
    }
    if (tamper === 'checkout_hold') {
      f.operation.reviewNeeded = true;
    }
    const before = structuredClone(f.db.tables);
    await assert.rejects(() => staffDecision(f, 'full_refund'), /Escrow funding needs review/);
    assert.deepEqual(f.db.tables, before);
  });
}

test('C2b1: first held staff approval survives another authorized processor and preserves original audit', async () => {
  const f = await openFundedDispute('checkout');
  f.escrow.status = 'held'; // Legitimate holding state inside verified dispute context.
  const seller = structuredClone(row(f.db, 'users', 'users|seller'));
  await f.db.delete(seller._id);
  assert.equal((await staffDecision(f, 'no_refund')).accountingOutcome, 'review');
  const approved = structuredClone(proof(f));
  assert.equal(record(approved.disputeOrigin).role, 'moderator');
  assert.equal(approved.originalStatus, 'held');
  f.db.tables.users?.push(user('admin', 'admin'));
  row(f.db, 'users', 'users|reviewer').isBanned = true;
  const held = structuredClone(f.db.tables);
  await assert.rejects(() => staffDecision(f, 'full_refund', undefined, 'admin'), /immutable approved decision/);
  await assert.rejects(() => buyerDecision(f, 'withdraw'), /immutable approved decision/);
  await assert.rejects(() => buyerDecision(f, 'agreed_refund'), /immutable approved decision/);
  assert.deepEqual(f.db.tables, held);
  f.db.tables.users?.push(seller);
  assert.equal((await staffDecision(f, 'no_refund', undefined, 'admin')).accountingOutcome, 'applied');
  assert.equal(proof(f).approvedBy, approved.approvedBy);
  assert.equal(proof(f).approvedAt, approved.approvedAt);
  assert.deepEqual(proof(f).disputeOrigin, approved.disputeOrigin);
  assert.equal(record(f.dispute.resolution).resolvedBy, 'users|admin');
  assert.equal(record(f.dispute.resolution).resolvedAt, record(proof(f).state).appliedAt);
  assert.equal(row(f.db, 'users', 'users|seller').totalSales, 1);
  await fundingStillValid(f);
});

test('C2b1: pending partial refund cannot change amount and matching retry preserves first approval', async () => {
  const f = await openFundedDispute('wallet');
  const seller = structuredClone(row(f.db, 'users', 'users|seller'));
  await f.db.delete(seller._id);
  assert.equal((await staffDecision(f, 'partial_refund', 20)).accountingOutcome, 'review');
  const first = structuredClone(proof(f));
  const before = structuredClone(f.db.tables);
  await assert.rejects(() => staffDecision(f, 'partial_refund', 21), /immutable approved decision/);
  assert.deepEqual(f.db.tables, before);
  f.db.tables.users?.push(seller, user('admin', 'admin'));
  assert.equal((await staffDecision(f, 'partial_refund', 20, 'admin')).accountingOutcome, 'applied');
  assert.equal(proof(f).approvedBy, first.approvedBy);
  assert.equal(proof(f).approvedAt, first.approvedAt);
  assert.equal(row(f.db, 'wallets', 'wallets|buyer').balance, 915);
  assert.equal(row(f.db, 'wallets', 'wallets|seller').balance, 90);
});

test('C2b1: buyer review cannot change release context, matching retry applies once', async () => {
  const f = await openFundedDispute('wallet');
  const seller = structuredClone(row(f.db, 'users', 'users|seller'));
  await f.db.delete(seller._id);
  const before = business(f.db);
  assert.equal((await buyerDecision(f, 'received_item')).accountingOutcome, 'review');
  assert.deepEqual(business(f.db), before);
  const first = structuredClone(proof(f));
  const held = structuredClone(f.db.tables);
  await assert.rejects(() => buyerDecision(f, 'issue_resolved'), /immutable approved decision/);
  await assert.rejects(() => staffDecision(f, 'no_refund'), /immutable approved decision/);
  assert.deepEqual(f.db.tables, held);
  f.db.tables.users?.push(seller);
  assert.equal((await buyerDecision(f, 'received_item')).accountingOutcome, 'applied');
  assert.equal(proof(f).approvedAt, first.approvedAt);
  assert.equal(row(f.db, 'wallets', 'wallets|seller').balance, 110);
});

async function replayDispute(f: Disputed, context: DisputeAccountingContext): Promise<string> {
  // Same private writer, synthetic IDs bridged only at the SDK boundary.
  const result = await applyEscrowAccounting(
    createCtx(f.db, null) as unknown as MutationCtx,
    f.escrow as unknown as Doc<'escrow'>,
    row(f.db, 'users', context.kind === 'buyer_dispute' ? 'users|buyer' : 'users|reviewer') as unknown as Doc<'users'>,
    'release',
    undefined,
    context,
  );
  return result.application;
}

for (const entry of ['staff', 'buyer'] as const) {
  test(`C2b1: ${entry} exact applied disputed release replay preserves all money counters and notices after spending`, async () => {
    const f = await openFundedDispute('checkout');
    if (entry === 'staff') {
      await staffDecision(f, 'no_refund');
    } else {
      await buyerDecision(f, 'withdraw');
    }
    row(f.db, 'wallets', 'wallets|seller').balance = 1;
    row(f.db, 'wallets', 'wallets|seller').isFrozen = true;
    const before = structuredClone(f.db.tables);
    const context: DisputeAccountingContext =
      entry === 'staff'
        ? { kind: 'reviewer_dispute', dispute: f.dispute as unknown as Doc<'disputes'>, resolutionType: 'no_refund' }
        : { kind: 'buyer_dispute', dispute: f.dispute as unknown as Doc<'disputes'>, resolutionType: 'withdraw' };
    assert.equal(await replayDispute(f, context), 'applied');
    assert.deepEqual(f.db.tables, before);
  });
}

for (const tamper of ['effect', 'approval', 'counter', 'reference', 'origin', 'resolution'] as const) {
  test(`C2b1: corrupt applied ${tamper} returns review with no second financial or business effects`, async () => {
    const f = await openFundedDispute('checkout');
    await staffDecision(f, 'no_refund');
    if (tamper === 'effect') {
      const effects = record(proof(f).state).effects;
      assert.ok(Array.isArray(effects));
      record(effects[0]).cents = 1;
    }
    if (tamper === 'approval') {
      proof(f).approvedAt = -1;
    }
    if (tamper === 'counter') {
      row(f.db, 'users', 'users|seller').totalSales = 0;
    }
    if (tamper === 'reference') {
      const ledger = f.db.tables.walletTransactions?.find((item) => item.escrowId === f.escrow._id);
      assert.ok(ledger);
      ledger.reference = 'wrong';
    }
    if (tamper === 'origin') {
      record(proof(f).disputeOrigin).disputeId = 'disputes|foreign';
    }
    if (tamper === 'resolution') {
      record(f.dispute.resolution).type = 'full_refund';
    }
    const before = structuredClone(f.db.tables);
    if (tamper === 'origin') {
      await assert.rejects(
        () =>
          replayDispute(f, {
            kind: 'reviewer_dispute',
            dispute: f.dispute as unknown as Doc<'disputes'>,
            resolutionType: 'no_refund',
          }),
        /immutable approved decision/,
      );
    } else {
      assert.equal(
        await replayDispute(f, {
          kind: 'reviewer_dispute',
          dispute: f.dispute as unknown as Doc<'disputes'>,
          resolutionType: 'no_refund',
        }),
        'review',
      );
    }
    assert.deepEqual(f.db.tables, before);
  });
}

for (const source of ['wallet', 'checkout'] as const) {
  test(`C2b1: ${source} disputed release validates immutable origin before sibling money`, async () => {
    const ids = ['orders|first', 'orders|second'];
    const f = await fund(
      source,
      (db) => {
        db.tables.cartItems = [];
        for (const [index, id] of ids.entries()) {
          db.tables.orders?.push({
            _id: id,
            orderNumber: id,
            buyerId: 'users|buyer',
            sellerId: 'users|seller',
            items: [{ productId: 'products|1', title: 'Stale', price: 1, quantity: index + 1, image: '' }],
            subtotal: 0,
            shippingCost: 0,
            platformFee: 0,
            sellerPayout: 0,
            totalAmount: 0,
            shippingAddress: ADDRESS,
            status: 'pending_payment',
            createdAt: 1,
            updatedAt: 1,
          });
        }
      },
      { source: 'pending_orders', orderIds: ids },
    );
    f.order.status = 'paid';
    await invokeFakeFunction(ordersModule.updateOrderStatus, createCtx(f.db, 'seller'), {
      orderId: f.order._id,
      status: 'processing',
    });
    await invokeFakeFunction(ordersModule.updateOrderStatus, createCtx(f.db, 'seller'), {
      orderId: f.order._id,
      status: 'shipped',
    });
    await invokeFakeFunction(ordersModule.confirmDelivery, createCtx(f.db, 'buyer'), { orderId: f.order._id });
    const disputeId = str(
      await invokeFakeFunction(disputesModule.createDispute, createCtx(f.db, 'buyer'), {
        orderId: f.order._id,
        title: 'Synthetic defect',
        description: 'Synthetic',
        category: 'defective',
        evidence: [],
      }),
    );
    const disputed = { ...f, dispute: row(f.db, 'disputes', disputeId) };
    assert.equal((await staffDecision(disputed, 'no_refund')).accountingOutcome, 'applied');
    const first = structuredClone(proof(f));
    row(f.db, 'users', 'users|reviewer').role = 'user';
    row(f.db, 'users', 'users|reviewer').isBanned = true;
    const escrow = f.db.tables.escrow?.find((item) => item.orderId === ids[1]);
    assert.ok(escrow);
    const sibling = { ...f, escrow, order: row(f.db, 'orders', str(escrow.orderId)) };
    sibling.order.status = 'delivered';
    assert.equal((await completeVia(sibling, 'complete')).accountingOutcome, 'applied');
    assert.equal(row(f.db, 'wallets', 'wallets|seller').balance, 310);
    assert.equal(row(f.db, 'users', 'users|seller').totalSales, 2);
    assert.deepEqual(proof(f), first);
    await fundingStillValid(f);
    const before = structuredClone(f.db.tables);
    assert.equal((await outcome(sibling, 'release')).accountingOutcome, 'applied');
    assert.deepEqual(f.db.tables, before);
  });
}

for (const tamper of ['legacy_effect', 'reference_collision', 'counter_overflow', 'orphan_wallet'] as const) {
  test(`C2b1: public ${tamper} review seals approval only without business effects`, async () => {
    const f = await openFundedDispute('wallet');
    if (tamper === 'legacy_effect') {
      f.db.tables.walletTransactions?.push({
        _id: 'walletTransactions|legacy',
        walletId: 'wallets|other',
        userId: 'users|other',
        escrowId: f.escrow._id,
        type: 'credit',
        source: 'escrow_release',
        amount: 100,
        balanceAfter: 100,
        reference: 'legacy-foreign',
        status: 'completed',
        description: 'Synthetic',
        createdAt: 1,
      });
    }
    if (tamper === 'reference_collision') {
      f.db.tables.walletTransactions?.push({
        _id: 'walletTransactions|collision',
        walletId: 'wallets|other',
        userId: 'users|other',
        type: 'credit',
        source: 'sale',
        amount: 1,
        balanceAfter: 1,
        reference: `ESC-${f.escrow._id}-seller`,
        status: 'completed',
        description: 'Synthetic',
        createdAt: 1,
      });
    }
    if (tamper === 'counter_overflow') {
      row(f.db, 'users', 'users|seller').totalSales = Number.MAX_SAFE_INTEGER;
    }
    if (tamper === 'orphan_wallet') {
      await f.db.delete('users|seller');
    }
    const before = business(f.db);
    assert.equal((await staffDecision(f, 'no_refund')).accountingOutcome, 'review');
    assert.deepEqual(business(f.db), before);
    assert.equal(record(proof(f).state).kind, 'pending');
  });
}

test('C2b1: staff party permissions remain valid and inactive tombstone wallet receives owed refund', async () => {
  const f = await openFundedDispute('checkout');
  row(f.db, 'users', 'users|seller').role = 'admin';
  Object.assign(row(f.db, 'users', 'users|buyer'), { isDeleted: true, deletedAt: 1 });
  Object.assign(row(f.db, 'wallets', 'wallets|buyer'), { isFrozen: true, isActive: false });
  row(f.db, 'appConfig', 'appConfig|1').paymentsEnabled = false;
  assert.equal((await staffDecision(f, 'full_refund', undefined, 'seller')).accountingOutcome, 'applied');
  const wallet = row(f.db, 'wallets', 'wallets|buyer');
  assert.equal(wallet.balance, 1105);
  assert.equal(wallet.isFrozen, true);
  assert.equal(wallet.isActive, false);
  assert.equal(proof(f).approvedBy, 'users|seller');
  assert.equal(record(proof(f).disputeOrigin).role, 'admin');
  await fundingStillValid(f);
});

for (const field of ['refundAmount', 'releasedAt', 'sellerPayoutTransactionId'] as const) {
  test(`C2b1: agreed refund rejects inconsistent legacy ${field} without erasing history or announcing pending money`, async () => {
    const f = await openFundedDispute('wallet');
    f.escrow[field] = field === 'sellerPayoutTransactionId' ? 'transactions|legacy' : 1;
    const before = structuredClone(f.db.tables);
    await assert.rejects(() => buyerDecision(f, 'agreed_refund'), /Dispute records need review/);
    assert.deepEqual(f.db.tables, before);
  });
}

test('C2b1: accepted internal approval cannot be bypassed by public agreed refund', async () => {
  const f = await openFundedDispute('wallet');
  await f.db.delete('users|seller');
  // Genuine accepted 4C1 reviewer approval, held for the absent beneficiary.
  // This establishes the sealed state independently of the new public writer.
  assert.equal((await outcome(f, 'partial', 20)).accountingOutcome, 'review');
  assert.equal(record(proof(f).state).kind, 'pending');
  assert.equal(proof(f).disputeOrigin, undefined);
  const before = structuredClone(f.db.tables);
  await assert.rejects(() => buyerDecision(f, 'agreed_refund'), /immutable approved decision/);
  assert.deepEqual(f.db.tables, before);
});

// ---- Task4C2b2: actual read-only financial summary, accepted real funding ----
async function financialSummary(db: Db): Promise<Record<string, unknown>> {
  if (!(db.tables.users ?? []).some((item) => item._id === 'users|admin')) {
    db.tables.users = [...(db.tables.users ?? []), user('admin', 'admin')];
  }
  const before = structuredClone(db.tables);
  const result = record(
    await invokeFakeFunction(transactionsModule.getPlatformFinancialSummary, createCtx(db, 'admin'), {
      adminId: 'users|other',
    }),
  );
  assert.deepEqual(db.tables, before, 'summary must not write or repair any table');
  return result;
}

for (const source of ['wallet', 'checkout'] as const) {
  // Fixed amounts from the settled brief, independent of the implementation formula.
  for (const expected of [
    { state: 'held', held: 105, seller: 0, refund: 0, earned: 0 },
    { state: 'disputed', held: 105, seller: 0, refund: 0, earned: 0 },
    { state: 'release', held: 0, seller: 100, refund: 0, earned: 5 },
    { state: 'full', held: 0, seller: 0, refund: 105, earned: 0 },
    { state: 'partial20', held: 0, seller: 80, refund: 20, earned: 5 },
    { state: 'partial102', held: 0, seller: 0, refund: 102, earned: 3 },
    { state: 'partial105', held: 0, seller: 0, refund: 105, earned: 0 },
  ] as const) {
    test(`C2b2: ${source} proven ${expected.state} conserves actual money without earning held fees`, async () => {
      const state = expected.state;
      let f: Funded;
      if (state === 'held') {
        f = await fund(source);
        f.order.status = 'paid';
      } else {
        const disputed = await openFundedDispute(source);
        f = disputed;
        if (state === 'release' || state === 'full') {
          await staffDecision(disputed, state === 'release' ? 'no_refund' : 'full_refund');
        } else if (state.startsWith('partial')) {
          await staffDecision(disputed, 'partial_refund', Number(state.slice(7)));
        }
      }
      const summary = await financialSummary(f.db);
      assert.equal(summary.heldInEscrow, expected.held);
      assert.equal(summary.totalPlatformFees, expected.earned);
      assert.equal(summary.totalGrossReceived, 105);
      assert.equal(summary.releasedToSellers, expected.seller);
      assert.equal(summary.refundedToBuyers, expected.refund);
      assert.equal(summary.unaccountedFunds, source === 'wallet' ? 0 : null);
      assert.equal(summary.totalGatewayFees, source === 'wallet' ? 0 : null);
      assert.equal(summary.netPlatformProfit, source === 'wallet' ? expected.earned : null);
      assert.equal(record(summary.completeness).escrow, true);
      assert.equal(record(summary.completeness).fees, source === 'wallet');
    });
  }
}

for (const fee of ['0', '6', null] as const) {
  test(`C2b2: validated receipt fee ${String(fee)} preserves zero and negative profit`, async () => {
    const f = await fund('checkout', undefined, {}, fee);
    await outcome(f, 'release');
    const summary = await financialSummary(f.db);
    assert.equal(summary.totalGatewayFees, fee === null ? null : Number(fee));
    assert.equal(summary.netPlatformProfit, fee === null ? null : 5 - Number(fee));
    assert.equal(record(summary.completeness).fees, fee !== null);
  });
}

for (const tamper of ['funding', 'effect', 'origin', 'terminal', 'zero', 'invalid', 'unrepresentable'] as const) {
  test(`C2b2: unproven ${tamper} makes totals unavailable and counts review without repair`, async () => {
    const f = await fund('wallet');
    if (tamper === 'effect') {
      await outcome(f, 'release');
      const effects = record(proof(f).state).effects;
      assert.ok(Array.isArray(effects));
      record(effects[0]).cents = 1;
    } else if (tamper === 'origin') {
      const d = await openFundedDispute('wallet');
      await staffDecision(d, 'no_refund');
      record(proof(d).disputeOrigin).resolutionType = 'full_refund';
      const summary = await financialSummary(d.db);
      assert.equal(summary.totalGrossReceived, null);
      assert.equal(record(summary.review).unprovenEscrows, 1);
      return;
    } else if (tamper === 'funding') {
      f.db.tables.walletTransactions = [];
    } else if (tamper === 'terminal') {
      f.escrow.status = 'released';
    } else {
      f.escrow.grossAmount = tamper === 'zero' ? 0 : tamper === 'invalid' ? NaN : Number.MAX_VALUE;
    }
    const summary = await financialSummary(f.db);
    assert.equal(summary.totalGrossReceived, null);
    assert.equal(summary.heldInEscrow, null);
    assert.equal(summary.totalPlatformFees, null);
    assert.equal(summary.netPlatformProfit, null);
    assert.equal(summary.unaccountedFunds, null);
    assert.equal(record(summary.review).unprovenEscrows, 1);
    assert.equal(record(summary.verifiedSubtotals).totalGrossReceived, 0);
  });
}

test('C2b2: valid pending approval retains gross custody but never claims processed or balanced', async () => {
  const f = await openFundedDispute('wallet');
  f.db.tables.wallets = (f.db.tables.wallets ?? []).filter((item) => item.userId !== 'users|seller');
  f.db.tables.users = (f.db.tables.users ?? []).filter((item) => item._id !== 'users|seller');
  await staffDecision(f, 'no_refund');
  const summary = await financialSummary(f.db);
  assert.equal(summary.heldInEscrow, 105);
  assert.equal(summary.totalPlatformFees, 0);
  assert.equal(summary.releasedToSellers, 0);
  assert.equal(summary.netPlatformProfit, null);
  assert.equal(summary.unaccountedFunds, null);
  assert.equal(record(summary.review).pendingEscrows, 1);
  assert.equal(record(summary.completeness).complete, false);
});

test('C2b2: empty history is positively complete zero', async () => {
  const summary = await financialSummary(createDb(tables()));
  assert.equal(summary.totalGrossReceived, 0);
  assert.equal(summary.totalGatewayFees, 0);
  assert.equal(summary.netPlatformProfit, 0);
  assert.equal(summary.unaccountedFunds, 0);
  assert.equal(record(summary.completeness).complete, true);
});

test('C2b2: database failure propagates instead of producing healthy or review fallback', async () => {
  const f = await fund('wallet');
  f.db.tables.users = [...(f.db.tables.users ?? []), user('admin', 'admin')];
  const original = f.db.get;
  f.db.get = async (id) => {
    if (id === f.operation._id) {
      throw new Error('synthetic storage unavailable');
    }
    return await original(id);
  };
  await assert.rejects(() => financialSummary(f.db), /synthetic storage unavailable/);
});

for (const subject of [null, 'unknown', 'banned', 'deleted', 'buyer', 'reviewer'] as const) {
  test(`C2b2: ${String(subject)} cannot read private summary with spoofed adminId`, async () => {
    const f = await fund('wallet');
    f.db.tables.users = [...(f.db.tables.users ?? []), user('admin', 'admin')];
    const before = structuredClone(f.db.tables);
    const originalQuery = f.db.query;
    f.db.query = (table) => {
      assert.equal(table, 'users', 'authorization must deny before any private history query');
      return originalQuery(table);
    };
    await assert.rejects(
      () =>
        invokeFakeFunction(transactionsModule.getPlatformFinancialSummary, createCtx(f.db, subject), {
          adminId: 'users|admin',
        }),
      /Unauthenticated|Unauthorized|Account is banned|Account is deleted|Account not found/,
    );
    assert.deepEqual(f.db.tables, before);
  });
}

async function externalFeeOperation(
  db: Db,
  kind: 'topup' | 'withdrawal',
  requestId: string,
  fee: string | null,
  providerId: string,
  status: 'successful' | 'failed' | 'pending' = 'successful',
): Promise<Row> {
  const debitAccount = '11111111-2222-3333-4444-555555555555';
  if (kind === 'withdrawal') {
    db.tables.paymentAccounts = [
      {
        _id: 'paymentAccounts|mm',
        userId: 'users|buyer',
        type: 'mobile_money',
        mobileMoneyProvider: 'mtn',
        mobileNumber: ADDRESS.phone,
        isVerified: true,
        providerResolvedAt: 1,
      },
    ];
  }
  const fetchImpl: LencoFetch = async (url, init) => {
    const body = record(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify({
        status: true,
        data: {
          id: providerId,
          reference: body.reference,
          amount: String(body.amount),
          currency: 'ZMW',
          status,
          fee,
          ...(url.endsWith('/collections/mobile-money')
            ? {
                type: 'mobile-money',
                bearer: 'merchant',
                mobileMoneyDetails: { country: 'zm', phone: body.phone, operator: body.operator },
              }
            : {
                accountId: debitAccount,
                creditAccount: { type: 'mobile-money', country: 'zm', phone: body.phone, operator: body.operator },
              }),
          reasonForFailure: null,
          settlementStatus: null,
        },
      }),
      { status: 200 },
    );
  };
  const deps = { env: () => ({ LENCO_API_KEY: 'synthetic-test-only', LENCO_ACCOUNT_ID: debitAccount }), fetchImpl };
  const action =
    kind === 'topup' ? providerOperations.createTopUpAction(deps) : providerOperations.createWithdrawalAction(deps);
  const result = record(
    await invokeFakeFunction(
      action,
      createFakeActionCtx({
        db,
        subject: 'buyer',
        modules: { providerOperations, providerSettlement },
      }),
      kind === 'topup'
        ? {
            requestId,
            amountCents: 2500,
            phone: ADDRESS.phone,
            operator: 'mtn',
          }
        : {
            requestId,
            amountCents: 2500,
            paymentAccountId: 'paymentAccounts|mm',
            expectedDestinationKey: `mm:zm:mtn:${ADDRESS.phone}`,
          },
    ),
  );
  assert.equal(result.ok, true);
  return row(db, 'paymentOperations', str(result.operationId));
}

for (const kind of ['topup', 'withdrawal'] as const) {
  for (const status of ['successful', 'failed', 'pending'] as const) {
    test(`C2b2: real ${kind} ${status} fee remains counted once or explicitly unsettled`, async () => {
      const db = createDb(tables());
      const op = await externalFeeOperation(db, kind, 'fee-one', '0.70', PROVIDER_ID, status);
      const summary = await financialSummary(db);
      assert.equal(summary.totalGatewayFees, status === 'pending' ? null : 0.7);
      assert.equal(summary.netPlatformProfit, status === 'pending' ? null : -0.7);
      assert.equal(record(summary.review).unsettledProviderOperations, status === 'pending' ? 1 : 0);
      assert.equal(record(summary.verifiedCounts).feeOperations, status === 'pending' ? 0 : 1);
      if (status !== 'pending') {
        assert.ok(op.accounting, 'actual settlement must have applied');
        assert.equal(record(summary.review).unprovenTransactions, 0);
        assert.equal(record(summary.review).unprovenProviderLedgerEntries, 0);
      }
    });
  }
}

test('C2b2: independent equal provider costs are added without companion double-counting', async () => {
  const db = createDb(tables());
  await externalFeeOperation(db, 'topup', 'fee-one', '0.70', PROVIDER_ID);
  await externalFeeOperation(db, 'withdrawal', 'fee-two', '0.70', '44444444-2222-3333-4444-555555555555');
  const summary = await financialSummary(db);
  assert.equal(summary.totalGatewayFees, 1.4);
  assert.equal(summary.netPlatformProfit, -1.4);
  assert.equal(record(summary.verifiedCounts).feeOperations, 2);
});

for (const source of ['wallet', 'checkout'] as const) {
  test(`C2b2: ${source} mixed multiorder outcomes conserve money and one checkout fee`, async () => {
    const f = await fund(
      source,
      (db) => {
        db.tables.users?.push(user('seller2'));
        db.tables.vendorProfiles?.push({
          _id: 'vendorProfiles|seller2',
          ownerUserId: 'users|seller2',
          status: 'approved',
          storeName: 'Second',
          slug: 'second',
        });
        db.tables.products?.push({
          ...row(db, 'products', 'products|1'),
          _id: 'products|2',
          sellerId: 'users|seller2',
          price: 200,
        });
        db.tables.cartItems?.push({
          ...row(db, 'cartItems', 'cartItems|1'),
          _id: 'cartItems|2',
          productId: 'products|2',
        });
      },
      {},
      '2',
    );
    await outcome(f, 'partial', 20);
    const second = (f.db.tables.escrow ?? []).find((item) => item._id !== f.escrow._id);
    assert.ok(second);
    const summary = await financialSummary(f.db);
    assert.equal(summary.totalGrossReceived, 315);
    assert.equal(summary.heldInEscrow, 210);
    assert.equal(summary.releasedToSellers, 80);
    assert.equal(summary.refundedToBuyers, 20);
    assert.equal(summary.totalPlatformFees, 5);
    assert.equal(summary.totalGatewayFees, source === 'checkout' ? 2 : 0);
    assert.equal(summary.netPlatformProfit, source === 'checkout' ? 3 : 5);
    assert.equal(summary.unaccountedFunds, 0);
    if (source === 'checkout') {
      assert.equal(record(summary.verifiedCounts).feeOperations, 1);
    }
    const sibling = { ...f, escrow: second, order: row(f.db, 'orders', str(second.orderId)) };
    sibling.order.status = 'delivered';
    await outcome(sibling, 'full');
    const later = await financialSummary(f.db);
    assert.equal(later.refundedToBuyers, 230);
    assert.equal(later.heldInEscrow, 0);
    assert.equal(later.totalGatewayFees, summary.totalGatewayFees);
  });
}

for (const tamper of ['receipt', 'duplicate-companion', 'fee-conflict', 'fee-invalid', 'late-fee'] as const) {
  test(`C2b2: provider ${tamper} ${tamper === 'late-fee' ? 'promotes a qualified late cost' : 'cannot become a healthy zero cost'}`, async () => {
    const f = await fund('checkout', undefined, {}, tamper === 'late-fee' ? null : '0');
    if (tamper === 'receipt') {
      record(record(f.operation.accounting).receipt).amountMinor = 1;
    } else if (tamper === 'duplicate-companion') {
      const companion = row(f.db, 'transactions', str(f.operation.transactionId));
      f.db.tables.transactions?.push({ ...companion, _id: 'transactions|duplicate' });
    } else if (tamper === 'fee-invalid') {
      record(record(f.operation.accounting).receipt).feeMinor = -1;
    } else {
      const receipt = { ...record(f.operation.receipt), feeMinor: 100 };
      await invokeFakeFunction(providerSettlement.settleProviderReceipt, createCtx(f.db, null), {
        operationId: f.operation._id,
        receipt,
        acquisition: { kind: 'status_get', lookup: { kind: 'reference', reference: f.operation.providerReference } },
      });
    }
    const summary = await financialSummary(f.db);
    assert.equal(summary.totalGatewayFees, tamper === 'late-fee' ? 1 : null);
    assert.equal(summary.netPlatformProfit, tamper === 'late-fee' ? num(summary.totalPlatformFees) - 1 : null);
    assert.equal(record(summary.completeness).complete, tamper === 'late-fee');
    assert.equal(record(summary.review).unknownFeeOperations, tamper === 'late-fee' ? 0 : 1);
  });
}

for (const source of ['wallet', 'checkout'] as const) {
  for (const tamper of ['counter', 'reference', 'resolution', 'owner', 'sibling'] as const) {
    test(`C2b2: ${source} corrupted ${tamper} proof is unknown without touching history`, async () => {
      const f = await openFundedDispute(source);
      await staffDecision(f, 'no_refund');
      if (tamper === 'counter') {
        row(f.db, 'users', 'users|seller').totalSales = 0;
      } else if (tamper === 'reference') {
        const effect = (f.db.tables.walletTransactions ?? []).find((item) => item.escrowId === f.escrow._id);
        assert.ok(effect);
        effect.reference = 'wrong';
      } else if (tamper === 'resolution') {
        record(f.dispute.resolution).type = 'full_refund';
      } else if (tamper === 'owner') {
        f.escrow.sellerId = 'users|other';
      } else {
        const effects = record(proof(f).state).effects;
        assert.ok(Array.isArray(effects));
        const originalEffect = row(f.db, 'walletTransactions', str(record(effects[0]).ledgerId));
        f.db.tables.walletTransactions?.push({ ...originalEffect, _id: 'walletTransactions|foreign' });
      }
      const summary = await financialSummary(f.db);
      assert.equal(summary.totalGrossReceived, null);
      assert.equal(summary.unaccountedFunds, null);
      assert.equal(record(summary.review).unprovenEscrows, 1);
    });
  }
}

test('C2b2: historical reviewer role changes and later wallet spending do not erase applied proof', async () => {
  const f = await openFundedDispute('wallet');
  await staffDecision(f, 'no_refund');
  row(f.db, 'users', 'users|reviewer').role = 'user';
  row(f.db, 'users', 'users|reviewer').isBanned = true;
  row(f.db, 'wallets', 'wallets|seller').balance = 1;
  const summary = await financialSummary(f.db);
  assert.equal(summary.releasedToSellers, 100);
  assert.equal(summary.totalPlatformFees, 5);
  assert.equal(summary.unaccountedFunds, 0);
  assert.equal(record(summary.completeness).complete, true);
});

test('C2b2: accepted origin-absent proof remains valid and corrupt approval becomes unknown', async () => {
  const f = await fund('wallet');
  await outcome(f, 'release');
  assert.equal(proof(f).disputeOrigin, undefined);
  assert.equal((await financialSummary(f.db)).releasedToSellers, 100);
  proof(f).approvedBy = 'users|reviewer';
  const summary = await financialSummary(f.db);
  assert.equal(summary.releasedToSellers, null);
  assert.equal(record(summary.review).unprovenEscrows, 1);
});

for (const paymentMethod of ['mobile_money', 'card', 'bank_transfer'] as const) {
  test(`C2b2: legacy successful ${paymentMethod} transaction fee is unproven even with numeric zero`, async () => {
    const db = createDb(tables());
    db.tables.transactions = [
      {
        _id: 'transactions|legacy',
        userId: 'users|buyer',
        type: 'collection',
        paymentMethod,
        status: 'successful',
        amount: 25,
        gatewayFee: 0,
        fee: 8,
        currency: 'ZMW',
      },
    ];
    const summary = await financialSummary(db);
    assert.equal(summary.totalGatewayFees, null);
    assert.equal(summary.netPlatformProfit, null);
    assert.equal(record(summary.review).unprovenTransactions, 1);
  });
}

test('C2b2: legacy withdrawal ledger without operation carries explicit unknown expense', async () => {
  const db = createDb(tables());
  db.tables.walletTransactions = [
    {
      _id: 'walletTransactions|legacy',
      userId: 'users|buyer',
      walletId: 'wallets|buyer',
      type: 'debit',
      source: 'withdrawal_mobile_money',
      amount: 25,
      balanceAfter: 975,
      reference: 'WLT-legacy',
      description: 'Synthetic historical withdrawal',
      createdAt: 1,
      updatedAt: 1,
      completedAt: 1,
      status: 'completed',
      externalReference: PROVIDER_ID,
    },
  ];
  const summary = await financialSummary(db);
  assert.equal(summary.totalGatewayFees, null);
  assert.equal(record(summary.review).unprovenProviderLedgerEntries, 1);
});

test('C2b2: aggregate known fee overflow is explicit unknown without clamping', async () => {
  const db = createDb(tables());
  await externalFeeOperation(db, 'topup', 'fee-one', '45035996273704.95', PROVIDER_ID);
  await externalFeeOperation(db, 'topup', 'fee-two', '45035996273704.95', '44444444-2222-3333-4444-555555555555');
  await externalFeeOperation(db, 'topup', 'fee-three', '1', '66666666-2222-3333-4444-555555555555');
  const summary = await financialSummary(db);
  assert.equal(summary.totalGatewayFees, null);
  assert.equal(summary.netPlatformProfit, null);
  assert.equal(record(summary.review).aggregateOverflow, true);
  assert.equal(record(summary.verifiedCounts).feeOperations, 3);
});

for (const source of ['wallet', 'checkout'] as const) {
  test(`C2b2: ${source} captured operation missing all escrow records cannot look like empty healthy history`, async () => {
    const f = await fund(source, undefined, {}, '0');
    f.db.tables.escrow = [];
    const summary = await financialSummary(f.db);
    assert.equal(summary.totalGrossReceived, null);
    assert.equal(summary.heldInEscrow, null);
    assert.equal(summary.unaccountedFunds, null);
    assert.equal(record(summary.review).unprovenFundingOperations, 1);
  });
}

test('C2b2: verified subtotal remains identified separately from unavailable global totals', async () => {
  const f = await fund('wallet');
  f.db.tables.escrow?.push({
    ...f.escrow,
    _id: 'escrow|legacy',
    orderId: 'orders|legacy',
    operationId: undefined,
    amount: 0,
    grossAmount: 0,
    sellerAmount: 0,
    platformFee: 0,
  });
  const summary = await financialSummary(f.db);
  assert.equal(summary.totalGrossReceived, null);
  assert.equal(summary.totalPlatformFees, null);
  assert.equal(summary.heldInEscrow, null);
  assert.equal(summary.unaccountedFunds, null);
  assert.equal(record(summary.verifiedSubtotals).totalGrossReceived, 105);
  assert.equal(record(summary.verifiedSubtotals).heldInEscrow, 105);
  assert.equal(record(summary.review).unprovenEscrows, 1);
  assert.equal(record(summary.verifiedCounts).escrows, 1);
});

test('C2b2: known zero receipt cost overrides informational companion fees without fallback', async () => {
  const f = await fund('checkout', undefined, {}, '0');
  const companion = row(f.db, 'transactions', str(f.operation.transactionId));
  companion.gatewayFee = 50;
  companion.fee = 4;
  const summary = await financialSummary(f.db);
  assert.equal(summary.totalGatewayFees, 0);
  assert.equal(summary.netPlatformProfit, 0);
  assert.equal(record(summary.completeness).complete, true);
});

test('C2b2: three genuine independent wallet purchases overflow gross totals explicitly', async () => {
  const f = await fund('wallet', (db) => {
    row(db, 'products', 'products|1').price = 30000000000000;
    row(db, 'wallets', 'wallets|buyer').balance = 40000000000000;
  });
  for (const buyer of ['secondBuyer', 'thirdBuyer']) {
    f.db.tables.users?.push(user(buyer));
    f.db.tables.wallets?.push(wallet(buyer, 40000000000000));
    f.db.tables.cartItems?.push({
      _id: `cartItems|${buyer}`,
      userId: `users|${buyer}`,
      productId: 'products|1',
      quantity: 1,
      selectedShipping: { name: 'Free', price: 0 },
      createdAt: 1,
      updatedAt: 1,
    });
    const selectors = { source: 'cart', shippingAddress: ADDRESS, deliveryMethodId: 'deliveryMethods|1' };
    const quoted = record(await invokeFakeFunction(checkoutQuote.quoteCheckout, createCtx(f.db, buyer), selectors));
    assert.equal(quoted.ok, true);
    const purchase = record(
      await invokeFakeFunction(paymentOperations.purchaseWithWallet, createCtx(f.db, buyer), {
        ...selectors,
        requestId: 'overflow-purchase',
        expectedQuoteKey: record(quoted.quote).quoteKey,
      }),
    );
    assert.equal(purchase.ok, true);
  }
  const summary = await financialSummary(f.db);
  assert.equal(summary.totalGrossReceived, null);
  assert.equal(summary.heldInEscrow, null);
  assert.equal(summary.netPlatformProfit, null);
  assert.equal(summary.unaccountedFunds, null);
  assert.equal(record(summary.review).aggregateOverflow, true);
  assert.equal(record(summary.verifiedCounts).escrows, 3);
});

for (const source of ['wallet', 'checkout'] as const) {
  for (const status of ['completed', 'cancelled', 'pending_payment'] as const) {
    test(`C2b2: ${source} unproved order ${status} marker cannot declare held history complete`, async () => {
      const f = await fund(source, undefined, {}, '0');
      f.order.status = status;
      const summary = await financialSummary(f.db);
      assert.equal(summary.totalGrossReceived, null);
      assert.equal(summary.unaccountedFunds, null);
      assert.equal(record(summary.review).unprovenEscrows, 1);
    });
  }
}

for (const source of ['wallet', 'checkout'] as const) {
  for (const tamper of ['missing', 'status-mismatch', 'resolved'] as const) {
    test(`C2b2: ${source} disputed custody with ${tamper} business evidence requires review`, async () => {
      const f = await openFundedDispute(source);
      if (tamper === 'missing') {
        f.db.tables.disputes = [];
      } else if (tamper === 'status-mismatch') {
        f.escrow.status = 'held';
      } else {
        f.dispute.status = 'resolved';
      }
      const summary = await financialSummary(f.db);
      assert.equal(summary.heldInEscrow, null);
      assert.equal(summary.unaccountedFunds, null);
      assert.equal(record(summary.review).unprovenEscrows, 1);
    });
  }
}
