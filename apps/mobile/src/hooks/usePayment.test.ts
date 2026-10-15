import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  buildCheckoutRequestIdentity,
  normalizeCheckoutCollectionRequest,
} from '../../../../convex/lib/providerOperationContracts';
import { resolve } from 'node:path';
import test, { before } from 'node:test';
import { fileURLToPath, URL } from 'node:url';

import React, { act, createElement, Suspense, type ReactNode } from 'react';
import * as ConvexReact from 'convex/react';
import { getFunctionName } from 'convex/server';

import * as checkoutQuoteModule from '../../../../convex/checkoutQuote';
import * as purchaseModule from '../../../../convex/paymentOperations';
import * as collectionModule from '../../../../convex/checkoutCollection';
import * as providerModule from '../../../../convex/providerOperations';
import * as settlementModule from '../../../../convex/providerSettlement';
import * as statusModule from '../../../../convex/paymentReconciliation';
import { createDb, createCtx, type Row } from '../../../../tests/support/convexFakeDb';
import { createFakeActionCtx, invokeFakeFunction } from '../../../../tests/support/convexFakeActionCtx';
import * as shared from '../../../../packages/shared/src/index';
import { api } from '../../../../convex/_generated/api';
import { createControls, createHarness, withFallback, type Props } from '../../../../tests/support/componentHarness';
import { createFakeConvexClient, deliver, mountUnderConvex } from '../../../../tests/support/realReactRender';
import type { RecoveryStorage } from '../services/walletOperationState';
import type { CheckoutRecovery, CheckoutSelectors } from '../services/checkoutOperationState';
import type { usePayment, PaymentOptions } from './usePayment';
type Payment = ReturnType<typeof usePayment>;

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const file = (path: string): string => resolve(root, path);
const uuid = '11111111-2222-4333-8444-555555555555';
const key = '@gettit/checkout-operation/v1/clerk_a';
const recovery: CheckoutRecovery = { version: 1, kind: 'checkout_collection', requestId: `checkout_${uuid}` };
const name = (ref: Parameters<typeof getFunctionName>[0]): string => getFunctionName(ref);
const PURCHASE = name(api.paymentOperations.purchaseWithWallet);
const COLLECTION = name(api.checkoutCollection.initiateCheckoutCollection);
const STATUS = name(api.paymentReconciliation.getStatus);
const REFRESH = name(api.paymentReconciliation.refresh);
const QUOTE = name(api.checkoutQuote.quoteCheckout);
const AVAILABILITY = name(api.appConfig.getPaymentAvailability);
const address = { street: 'Street', city: 'Lusaka', province: 'Lusaka', country: 'Zambia', phone: '0971234567' };
const selectors: CheckoutSelectors = { source: 'cart', shippingAddress: address, loyaltyPoints: 0 };
const quote = {
  source: 'cart',
  quoteKey: 'quote-one',
  inputIdentity: 'input-one',
  totalAmountCents: 10500,
  subtotalCents: 10000,
  shippingCents: 0,
  platformFeeCents: 500,
  discountCents: 0,
  promoCents: 0,
  loyaltyCents: 0,
  lines: [],
  sellers: [],
  shippingAddress: address,
  delivery: { name: 'Pickup', methodType: 'product_fallback' },
};
let requestIdentity: string;
before(async () => {
  requestIdentity = await buildCheckoutRequestIdentity({
    actorId: 'users|clerk_a',
    request: normalizeCheckoutCollectionRequest({
      ...selectors,
      requestId: recovery.requestId,
      expectedQuoteKey: quote.quoteKey,
      phone: '0971234567',
      operator: 'mtn',
    }),
  });
});
function ready(subject = 'clerk_a'): Props {
  return {
    isLoading: false,
    isSignedIn: true,
    authSyncError: null,
    clerkUser: { id: subject },
    user: { _id: `users|${subject}`, clerkId: subject, role: 'user', isBanned: false },
  };
}
function memory(): RecoveryStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value);
    },
    removeItem: async (key) => {
      values.delete(key);
    },
  };
}
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw Error('not initialized');
  };
  let reject: (error: Error) => void = () => {
    throw Error('not initialized');
  };
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function found(token: CheckoutRecovery = recovery, changes: Props = {}): Props {
  return {
    result: 'found',
    operationId: 'paymentOperations|1',
    requestId: token.requestId,
    requestIdentity,
    kind: token.kind,
    status: 'attempted',
    providerStatus: 'pending',
    application: 'pending',
    accountingApplied: false,
    reviewNeeded: false,
    amountCents: 10500,
    quoteKey: 'quote-one',
    source: 'cart',
    orderIds: ['orders|1'],
    feeCents: null,
    ...changes,
  };
}
function mount(
  options: {
    storage?: ReturnType<typeof memory>;
    auth?: Props;
    options?: Partial<PaymentOptions>;
    operationState?: typeof import('../services/checkoutOperationState');
  } = {},
) {
  const controls = createControls();
  controls.auth = options.auth ?? ready();
  const storage = options.storage ?? memory();
  const convex = createFakeConvexClient({ [AVAILABILITY]: { paymentsEnabled: true }, [QUOTE]: { ok: true, quote } });
  const calls: { name: string; args: Props }[] = [];
  const handlers = new Map<string, (args: Props) => Promise<unknown>>();
  const queryHandlers = new Map<string, (args: Props) => Promise<unknown>>();
  const sdk = {
    action: async (ref: Parameters<typeof getFunctionName>[0], args: Props) => {
      const called = name(ref);
      calls.push({ name: called, args });
      const handler = handlers.get(called);
      if (handler) return await handler(args);
      if (called === REFRESH) return null;
      return { ok: true, operationId: 'paymentOperations|1', status: 'attempted', providerReference: 'opaque' };
    },
    query: async (ref: Parameters<typeof getFunctionName>[0], args: Props) => {
      const called = name(ref);
      calls.push({ name: called, args });
      const handler = queryHandlers.get(called);
      return handler ? await handler(args) : null;
    },
  };
  Object.assign(convex.client, sdk, { mutation: sdk.action });
  let paymentOptions: PaymentOptions = {
    selectors,
    kind: 'checkout_collection',
    phone: '0971234567',
    operator: 'mtn',
    enabled: true,
    ...options.options,
  };
  let ids = storage.values.has(key) ? 1 : 0;
  let digests = 0;
  const harness = createHarness({
    controls,
    convexApi: { api },
    files: {
      ...(options.operationState
        ? { [file('apps/mobile/src/services/checkoutOperationState.ts')]: options.operationState }
        : {}),
      [file('apps/mobile/src/context/AuthProvider.tsx')]: withFallback({ useAppAuth: () => controls.auth }),
      [file('apps/mobile/src/services/api.ts')]: withFallback({
        apiService: withFallback({
          post: () => {
            throw Error('legacy HTTP forbidden');
          },
        }),
      }),
    },
    packages: {
      react: React,
      'convex/react': withFallback({ ...ConvexReact, useConvexAuth: () => controls.convexAuth }),
      '@gettitonline/shared': withFallback({ ...shared }),
      '@react-native-async-storage/async-storage': { __esModule: true, default: storage },
      'expo-crypto': {
        CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
        digestStringAsync: async (_algorithm: string, text: string) => {
          digests += 1;
          return createHash('sha256').update(text).digest('hex');
        },
        randomUUID: () => {
          ids += 1;
          return ids === 1 ? uuid : 'aaaaaaaa-2222-4333-8444-555555555555';
        },
      },
    },
  });
  const useOperations = harness.load(file('apps/mobile/src/hooks/usePayment.ts')).usePayment as typeof usePayment;
  const suspension = { active: false, suspended: 0 };
  let observed: Payment | undefined;
  function Probe(): null {
    observed = useOperations(paymentOptions);
    if (suspension.active) {
      suspension.suspended += 1;
      throw new Promise<void>(() => undefined);
    }
    return null;
  }
  const providers: { ConvexProvider(props: { client: object; children?: ReactNode }): ReactNode | Promise<ReactNode> } =
    ConvexReact;
  const mounted = mountUnderConvex(convex);
  return {
    controls,
    suspension,
    setOptions: (update: Partial<PaymentOptions>): void => {
      paymentOptions = { ...paymentOptions, ...update };
    },
    storage,
    digests: () => digests,
    operationState: harness.load(
      file('apps/mobile/src/services/checkoutOperationState.ts'),
    ) as typeof import('../services/checkoutOperationState'),
    convex,
    calls,
    handlers,
    queryHandlers,
    view: (): Payment => {
      assert.ok(observed);
      return observed;
    },
    render: (client: object = convex.client) =>
      mounted.render(
        createElement(
          providers.ConvexProvider,
          { client },
          createElement(Suspense, { fallback: null }, createElement(Probe)),
        ),
      ),
    unmount: () => mounted.unmount(),
    invoke: async (work: () => Promise<void>) => {
      await act(async () => {
        await work();
      });
    },
    push: async (ref: string, value: unknown) => {
      await deliver(convex, ref, value);
    },
  };
}

test('Pay accepts the displayed quote, sends one exact owned collection and duplicate taps cannot mint another request', async () => {
  const m = mount();
  await m.render();
  assert.deepEqual(m.calls, []);
  const submit = m.view().submit;
  await m.invoke(async () => {
    await Promise.all([submit(), submit()]);
  });
  assert.deepEqual(m.calls, [
    {
      name: COLLECTION,
      args: {
        ...selectors,
        requestId: recovery.requestId,
        expectedQuoteKey: quote.quoteKey,
        phone: '0971234567',
        operator: 'mtn',
      },
    },
  ]);
  assert.deepEqual(JSON.parse(m.storage.values.get(key) ?? ''), recovery);
  assert.equal(m.view().outcome, 'unknown', 'initiation is never accounting proof');
  await m.unmount();
});

test('actual wallet cart submits one aggregate mutation with selectors only', async () => {
  const m = mount({ options: { kind: 'wallet_purchase' } });
  await m.render();
  await m.invoke(() => m.view().submit());
  assert.deepEqual(m.calls, [
    { name: PURCHASE, args: { ...selectors, requestId: recovery.requestId, expectedQuoteKey: quote.quoteKey } },
  ]);
  assert.equal(
    m.calls.filter((call) => call.name.includes('createOrder') || call.name.includes('clearCart')).length,
    0,
  );
  await m.unmount();
});

for (const [label, changes, outcome] of [
  ['provider success only', { providerStatus: 'successful' }, 'pending'],
  [
    'succeeded with review history',
    { status: 'succeeded', application: 'applied', accountingApplied: true, reviewNeeded: true },
    'review',
  ],
  ['failed release applied', { status: 'failed', application: 'applied', accountingApplied: true }, 'failed'],
  [
    'missing quote proof',
    { status: 'succeeded', application: 'applied', accountingApplied: true, quoteKey: null },
    'review',
  ],
  ['wrong kind', { kind: 'top_up_collection' }, 'review'],
  ['wrong request', { requestId: 'foreign' }, 'review'],
  ['wrong source', { source: 'pending_orders' }, 'review'],
  ['same total different quote', { quoteKey: 'changed-key' }, 'review'],
  ['correct terminal proof', { status: 'succeeded', application: 'applied', accountingApplied: true }, 'completed'],
] as const) {
  test(`actual hook proof classification: ${label}`, async () => {
    const m = mount();
    await m.render();
    await m.invoke(() => m.view().submit());
    await m.push(STATUS, found(recovery, changes));
    assert.equal(m.view().outcome, outcome);
    assert.equal(m.view().recovery?.requestId, recovery.requestId);
    await m.unmount();
  });
}

for (const [label, value] of [
  ['null', null],
  ['ambiguous', { result: 'review', reason: 'ambiguous_request' }],
  ['error', new Error('query error')],
] as const) {
  test(`actual hook retains original identity after ${label} lookup`, async () => {
    const m = mount();
    m.storage.values.set(key, JSON.stringify(recovery));
    await m.render();
    await m.push(STATUS, value);
    assert.notEqual(m.view().outcome, 'completed');
    await m.invoke(() => m.view().newSubmission());
    await m.invoke(() => m.view().submit());
    assert.equal(m.calls.length, 0);
    assert.equal(m.view().recovery?.requestId, recovery.requestId);
    await m.unmount();
  });
}

test('response loss remount recovers opaque request while switch is off without another POST', async () => {
  const m = mount();
  await m.render();
  m.handlers.set(COLLECTION, async () => {
    throw Error('response lost');
  });
  await m.invoke(() => m.view().submit());
  assert.ok(m.view().error);
  await m.unmount();
  const next = mount({ storage: m.storage, operationState: m.operationState });
  await next.push(AVAILABILITY, { paymentsEnabled: false });
  await next.render();
  await next.push(STATUS, found(recovery, { status: 'succeeded', application: 'applied', accountingApplied: true }));
  assert.equal(next.view().outcome, 'completed');
  assert.equal(next.view().recovery?.requestId, recovery.requestId);
  await next.invoke(() => next.view().submit());
  assert.equal(next.calls.length, 0);
  await next.invoke(() => next.view().checkStatus());
  assert.deepEqual(next.calls, [{ name: REFRESH, args: { requestId: recovery.requestId } }]);
  await next.unmount();
});

for (const change of [
  'phone',
  'operator',
  'selectors',
  'quote',
  'quoteABA',
  'enabledABA',
  'off',
  'cancel',
  'signout',
  'ownerABA',
  'unmount',
  'client',
] as const) {
  test(`actual persistence boundary retires ${change} and retains the same opaque identity`, async () => {
    const storage = memory();
    const set = deferred<void>();
    storage.setItem = async (key, value) => {
      await set.promise;
      storage.values.set(key, value);
    };
    const m = mount({ storage });
    await m.render();
    let work: Promise<void> = Promise.resolve();
    await act(async () => {
      work = m.view().submit();
    });
    if (change === 'phone') {
      m.setOptions({ phone: '0951234567' });
      await m.render();
    }
    if (change === 'operator') {
      m.setOptions({ operator: 'airtel' });
      await m.render();
    }
    if (change === 'selectors') {
      m.setOptions({ selectors: { ...selectors, promoCode: 'NEW' } });
      await m.render();
    }
    if (change === 'quote' || change === 'quoteABA') {
      await m.push(QUOTE, { ok: true, quote: { ...quote, quoteKey: 'new-same-total' } });
      if (change === 'quoteABA') await m.push(QUOTE, { ok: true, quote });
    }
    if (change === 'enabledABA') {
      m.setOptions({ enabled: false });
      await m.render();
      m.setOptions({ enabled: true });
      await m.render();
    }
    if (change === 'off') await m.push(AVAILABILITY, { paymentsEnabled: false });
    if (change === 'cancel') await m.invoke(async () => m.view().cancelDraft());
    if (change === 'signout' || change === 'ownerABA') {
      m.controls.auth = ready('clerk_b');
      await m.render();
      if (change === 'ownerABA') {
        m.controls.auth = ready();
        await m.render();
      }
    }
    if (change === 'unmount') await m.unmount();
    if (change === 'client') {
      const other = createFakeConvexClient({ [AVAILABILITY]: { paymentsEnabled: true }, [QUOTE]: { ok: true, quote } });
      await m.render(other.client);
    }
    set.resolve();
    await act(async () => {
      await work;
    });
    assert.equal(m.calls.filter((call) => call.name === COLLECTION).length, 0);
    assert.equal(JSON.parse(storage.values.get(key) ?? '').requestId, recovery.requestId);
    if (change !== 'unmount') await m.unmount();
  });
}

test('storage failure blocks financial dispatch and fresh request minting', async () => {
  const storage = memory();
  storage.setItem = async () => {
    throw Error('disk failure');
  };
  const m = mount({ storage });
  await m.render();
  await m.invoke(() => m.view().submit());
  assert.equal(m.calls.length, 0);
  assert.ok(m.view().error);
  await m.unmount();
});

for (const change of ['review', 'null', 'error', 'cancel', 'unmount'] as const) {
  test(`terminal deletion preserves original token if ${change} retires proof`, async () => {
    const m = mount();
    m.storage.values.set(key, JSON.stringify(recovery));
    await m.render();
    await m.push(STATUS, found(recovery, { status: 'succeeded', application: 'applied', accountingApplied: true }));
    assert.equal(m.view().outcome, 'completed');
    const remove = deferred<void>();
    m.storage.removeItem = async (key) => {
      await remove.promise;
      m.storage.values.delete(key);
    };
    let work: Promise<void> = Promise.resolve();
    await act(async () => {
      work = m.view().newSubmission();
    });
    if (change === 'review') await m.push(STATUS, found(recovery, { reviewNeeded: true }));
    if (change === 'null') await m.push(STATUS, null);
    if (change === 'error') await m.push(STATUS, new Error('query failed'));
    if (change === 'cancel') await m.invoke(async () => m.view().cancelDraft());
    if (change === 'unmount') await m.unmount();
    remove.resolve();
    await act(async () => {
      await work;
    });
    assert.equal(JSON.parse(m.storage.values.get(key) ?? '').requestId, recovery.requestId);
    if (change !== 'unmount') {
      await m.invoke(() => m.view().submit());
      assert.equal(m.calls.length, 0);
      await m.unmount();
    }
  });
}

test('current terminal reset allows a fresh Pay tap, while captured old reset cannot retire new work', async () => {
  const m = mount();
  m.storage.values.set(key, JSON.stringify(recovery));
  await m.render();
  const oldCancel = m.view().cancelDraft;
  await m.push(STATUS, found(recovery, { status: 'succeeded', application: 'applied', accountingApplied: true }));
  await m.invoke(() => m.view().newSubmission());
  assert.equal(m.view().recovery, null);
  const response = deferred<unknown>();
  m.handlers.set(COLLECTION, () => response.promise);
  let work: Promise<void> = Promise.resolve();
  await act(async () => {
    work = m.view().submit();
  });
  await m.invoke(async () => oldCancel());
  assert.equal(m.view().working, true);
  response.resolve({ ok: true, operationId: 'paymentOperations|2', status: 'attempted' });
  await act(async () => {
    await work;
  });
  assert.equal(m.view().working, false);
  await m.unmount();
});

test('a status with a different original request identity cannot prove the accepted collection', async () => {
  const m = mount();
  await m.render();
  await m.invoke(() => m.view().submit());
  await m.push(
    STATUS,
    found(recovery, {
      requestIdentity: 'different-original-request',
      status: 'succeeded',
      application: 'applied',
      accountingApplied: true,
    }),
  );
  assert.equal(m.view().outcome, 'review');
  await m.unmount();
});

test('exact quote mismatch retires only its own token and requires a fresh Pay tap for the replacement', async () => {
  const m = mount();
  await m.render();
  m.handlers.set(COLLECTION, async () => ({
    ok: false,
    code: 'quote_mismatch',
    quote: { ...quote, quoteKey: 'changed-key' },
  }));
  const stalePay = m.view().submit;
  await m.invoke(stalePay);
  assert.equal(m.view().recovery, null);
  assert.equal(m.storage.values.has(key), false);
  assert.equal(m.calls.length, 1, 'quote mismatch must not automatically resubmit');
  await m.push(QUOTE, { ok: true, quote: { ...quote, quoteKey: 'changed-key' } });
  await m.invoke(stalePay);
  assert.equal(m.calls.length, 1);
  await m.invoke(() => m.view().submit());
  assert.equal(m.calls.length, 2);
  assert.equal(m.calls[1]?.args.expectedQuoteKey, 'changed-key');
  await m.unmount();
});

for (const label of [
  'loading',
  'signedout',
  'banned',
  'deleted',
  'missing',
  'syncerror',
  'clerkmismatch',
  'convexloading',
  'convexdenied',
] as const) {
  test(`actual hook ${label} denies private queries and dispatch`, async () => {
    const m = mount();
    const auth = ready();
    if (label === 'loading') auth.isLoading = true;
    if (label === 'signedout') auth.isSignedIn = false;
    if (label === 'banned' || label === 'deleted')
      auth.user = { ...object(auth.user), isBanned: true, ...(label === 'deleted' ? { deletedAt: 1 } : {}) };
    if (label === 'missing') auth.user = null;
    if (label === 'syncerror') auth.authSyncError = 'failed';
    if (label === 'clerkmismatch') auth.clerkUser = { id: 'different' };
    m.controls.auth = auth;
    if (label === 'convexloading') m.controls.convexAuth.isLoading = true;
    if (label === 'convexdenied') m.controls.convexAuth.isAuthenticated = false;
    await m.render();
    await m.invoke(() => m.view().submit());
    assert.equal(m.view().ready, false);
    assert.equal(m.view().quote, null);
    assert.equal(m.view().recovery, null);
    assert.equal(m.calls.length, 0);
    assert.ok(!m.convex.lifecycle.some((name) => name === `subscribe:${QUOTE}` || name === `subscribe:${STATUS}`));
    await m.unmount();
  });
}

test('pending-order accepted selectors bind the genuine order set; unrelated recovered proof never proves that selection', async () => {
  const pending: CheckoutSelectors = {
    ...selectors,
    source: 'pending_orders',
    orderIds: ['orders|existing' as NonNullable<CheckoutSelectors['orderIds']>[number]],
  };
  const m = mount({ options: { selectors: pending } });
  await m.push(QUOTE, { ok: true, quote: { ...quote, source: 'pending_orders', orderIds: ['orders|existing'] } });
  await m.render();
  await m.invoke(() => m.view().submit());
  assert.deepEqual(m.calls[0]?.args.orderIds, ['orders|existing']);
  await m.push(
    STATUS,
    found(recovery, {
      source: 'pending_orders',
      orderIds: ['orders|different'],
      status: 'succeeded',
      application: 'applied',
      accountingApplied: true,
    }),
  );
  assert.equal(m.view().outcome, 'review');
  await m.unmount();
});

function backendFixture() {
  const user = (id: string): Row => ({
    _id: `users|${id}`,
    clerkId: id,
    role: 'user',
    isBanned: false,
    email: `${id}@example.invalid`,
    firstName: id,
    lastName: 'Fixture',
    isVerified: true,
    totalSales: 0,
    totalPurchases: 0,
    createdAt: 1,
    updatedAt: 1,
  });
  const product = (id: string, seller: string): Row => ({
    _id: `products|${id}`,
    sellerId: `users|${seller}`,
    title: id,
    description: 'Fixture',
    price: 100,
    images: [],
    condition: 'good',
    status: 'active',
    quantity: 10,
    categoryId: 'categories|1',
    shippingOptions: [{ name: 'Free', price: 0 }],
    views: 0,
    createdAt: 1,
    updatedAt: 1,
  });
  return createDb({
    users: [user('buyer'), user('seller'), user('second')],
    vendorProfiles: ['seller', 'second'].map((id) => ({
      _id: `vendorProfiles|${id}`,
      ownerUserId: `users|${id}`,
      status: 'approved',
      storeName: id,
      slug: id,
    })),
    platformSettings: [
      {
        _id: 'platformSettings|1',
        key: 'singleton',
        companySellerUserId: 'users|company',
        companyDisplayName: 'Fixture',
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
    products: [product('lamp', 'seller'), product('cap', 'second')],
    wallets: [
      {
        _id: 'wallets|buyer',
        userId: 'users|buyer',
        balance: 1000,
        pendingBalance: 0,
        totalEarned: 0,
        totalSpent: 0,
        totalWithdrawn: 0,
        isActive: true,
        isFrozen: false,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    cartItems: [
      {
        _id: 'cartItems|1',
        userId: 'users|buyer',
        productId: 'products|lamp',
        quantity: 1,
        selectedShipping: { name: 'Free', price: 0 },
        createdAt: 1,
        updatedAt: 1,
      },
      {
        _id: 'cartItems|2',
        userId: 'users|buyer',
        productId: 'products|cap',
        quantity: 1,
        selectedShipping: { name: 'Free', price: 0 },
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    deliveryZones: [],
    deliveryMethods: [],
    pickupPoints: [],
    promoCodes: [],
    promoCodeRedemptions: [],
    loyaltyAccounts: [],
    loyaltyTransactions: [],
    orders: [],
    escrow: [],
    transactions: [],
    walletTransactions: [],
    paymentOperations: [],
    paymentAccounts: [],
    notifications: [],
    behaviorEvents: [],
  });
}
function object(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

test('actual hook → registered quote/purchase/status performs one multi-seller customized wallet cart purchase and captured-row cleanup', async () => {
  const db = backendFixture();
  const lamp = db.tables.products?.[0];
  assert.ok(lamp);
  lamp.variantCombinations = [
    { id: 'red', sku: 'RED', attributes: [{ name: 'Color', value: 'Red' }], price: 120, stock: 5, status: 'active' },
    { id: 'blue', sku: 'BLUE', attributes: [{ name: 'Color', value: 'Blue' }], price: 130, stock: 5, status: 'active' },
  ];
  const first = db.tables.cartItems?.[0];
  assert.ok(first);
  first.selectedVariant = { variantId: 'red', sku: 'RED', attributes: [{ name: 'Color', value: 'Red' }], price: 1 };
  db.tables.cartItems?.push({
    ...first,
    _id: 'cartItems|3',
    selectedVariant: { variantId: 'blue', sku: 'BLUE', attributes: [{ name: 'Color', value: 'Blue' }], price: 1 },
  });
  const m = mount({ auth: ready('buyer'), options: { kind: 'wallet_purchase' } });
  const quoted = object(await invokeFakeFunction(checkoutQuoteModule.quoteCheckout, createCtx(db, 'buyer'), selectors));
  assert.equal(quoted.ok, true);
  await m.push(QUOTE, quoted);
  await m.render();
  assert.equal(m.view().quote?.lines.length, 3);
  assert.equal(m.view().quote?.sellers.length, 2);
  assert.equal(m.view().quote?.totalAmountCents, 36750);
  m.handlers.set(PURCHASE, (args) =>
    invokeFakeFunction(purchaseModule.purchaseWithWallet, createCtx(db, 'buyer'), args),
  );
  await m.invoke(() => m.view().submit());
  assert.equal(db.tables.paymentOperations?.length, 1);
  assert.equal(db.tables.orders?.length, 2);
  assert.equal(db.tables.cartItems?.length, 0);
  assert.equal(db.tables.wallets?.[0]?.balance, 632.5);
  const retained = m.view().recovery;
  assert.ok(retained);
  await m.push(
    STATUS,
    await invokeFakeFunction(statusModule.getStatus, createCtx(db, 'buyer'), { requestId: retained.requestId }),
  );
  assert.equal(m.view().outcome, 'completed');
  assert.equal(m.calls.length, 1);
  await m.unmount();
});

test('actual pending hook → registered collection → settlement/status preserves reserved zero stock and needs accounting proof', async () => {
  const db = backendFixture();
  db.tables.cartItems = [];
  const product = db.tables.products?.[0];
  assert.ok(product);
  product.status = 'sold';
  product.quantity = 0;
  db.tables.orders?.push({
    _id: 'orders|pending',
    buyerId: 'users|buyer',
    sellerId: 'users|seller',
    orderNumber: 'PENDING',
    status: 'pending_payment',
    items: [{ productId: 'products|lamp', title: 'Old title', price: 0.01, quantity: 1, image: '' }],
    totalAmount: 0.01,
    subtotal: 0.01,
    shippingCost: 0,
    platformFee: 0,
    sellerPayout: 0,
    shippingAddress: address,
    createdAt: 1,
    updatedAt: 1,
  });
  const pending: CheckoutSelectors = {
    source: 'pending_orders',
    orderIds: ['orders|pending' as NonNullable<CheckoutSelectors['orderIds']>[number]],
    shippingAddress: address,
  };
  const quoted = object(await invokeFakeFunction(checkoutQuoteModule.quoteCheckout, createCtx(db, 'buyer'), pending));
  assert.equal(quoted.ok, true);
  const modules = {
    checkoutCollection: collectionModule,
    providerOperations: providerModule,
    providerSettlement: settlementModule,
  };
  const actionCtx = createFakeActionCtx({ db, subject: 'buyer', modules });
  let posts = 0;
  const registered = collectionModule.createCheckoutCollectionAction({
    env: () => ({ LENCO_API_KEY: 'synthetic-test-key' }),
    fetchImpl: async (_url, init) => {
      posts += 1;
      const args = object(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          status: true,
          data: {
            id: '22222222-2222-3333-4444-555555555555',
            reference: args.reference,
            amount: String(args.amount),
            currency: 'ZMW',
            status: 'pending',
            type: 'mobile-money',
            bearer: 'merchant',
            mobileMoneyDetails: { country: 'zm', operator: args.operator, phone: args.phone },
            reasonForFailure: null,
            settlementStatus: null,
          },
        }),
        { status: 200 },
      );
    },
  });
  const m = mount({ auth: ready('buyer'), options: { selectors: pending } });
  await m.push(QUOTE, quoted);
  await m.render();
  m.handlers.set(COLLECTION, (args) => invokeFakeFunction(registered, actionCtx, args));
  await m.invoke(() => m.view().submit());
  assert.equal(posts, 1);
  assert.equal(db.tables.orders?.length, 1);
  assert.equal(product.quantity, 0);
  const retained = m.view().recovery;
  assert.ok(retained);
  await m.push(
    STATUS,
    await invokeFakeFunction(statusModule.getStatus, createCtx(db, 'buyer'), { requestId: retained.requestId }),
  );
  assert.equal(m.view().outcome, 'unknown');
  const pendingStatus = m.view().status;
  assert.ok(pendingStatus && !(pendingStatus instanceof Error) && pendingStatus.result === 'found');
  assert.equal(pendingStatus.accountingApplied, false);
  const operation = db.tables.paymentOperations?.[0];
  assert.ok(operation);
  await invokeFakeFunction(settlementModule.settleProviderReceipt, createCtx(db, null), {
    operationId: operation._id,
    receipt: {
      kind: 'collection',
      id: operation.providerId,
      reference: operation.providerReference,
      amountMinor: operation.amountCents,
      feeMinor: null,
      currency: 'ZMW',
      status: 'successful',
      collectionType: 'mobile-money',
      bearer: 'merchant',
      country: 'zm',
      operator: 'mtn',
      phone: '0971234567',
      settlementStatus: null,
      reasonForFailure: null,
    },
    acquisition: { kind: 'status_get', lookup: { kind: 'provider_id', providerId: operation.providerId } },
  });
  await m.push(
    STATUS,
    await invokeFakeFunction(statusModule.getStatus, createCtx(db, 'buyer'), { requestId: retained.requestId }),
  );
  assert.equal(m.view().outcome, 'completed');
  assert.equal(db.tables.orders?.[0]?.status, 'paid');
  assert.equal(posts, 1);
  await m.unmount();
});

for (const malformed of [{ reviewNeeded: undefined }, { reviewNeeded: 'false' }, { accountingApplied: 'true' }]) {
  test(`malformed terminal flags fail closed: ${Object.keys(malformed)[0]}=${String(Object.values(malformed)[0])}`, async () => {
    const m = mount();
    await m.render();
    await m.invoke(() => m.view().submit());
    await m.push(
      STATUS,
      found(recovery, { status: 'succeeded', application: 'applied', accountingApplied: true, ...malformed }),
    );
    assert.equal(m.view().outcome, 'review');
    await m.unmount();
  });
}

test('real hook committed OFF cannot be enabled by a speculative ON render suspended before commit', async () => {
  const m = mount();
  await m.render();
  const captured = m.view().submit;
  await m.push(AVAILABILITY, { paymentsEnabled: false });
  m.suspension.active = true;
  await m.push(AVAILABILITY, { paymentsEnabled: true });
  assert.ok(m.suspension.suspended > 0);
  await m.invoke(captured);
  assert.equal(m.calls.length, 0);
  assert.equal(m.storage.values.size, 0);
  m.suspension.active = false;
  await m.unmount();
});

test('simultaneous wallet and MM screens share one unresolved owned request across storage claims', async () => {
  const first = mount({ options: { kind: 'wallet_purchase' } });
  const second = mount({ storage: first.storage, operationState: first.operationState });
  await first.render();
  await second.render();
  await act(async () => {
    await Promise.all([first.view().submit(), second.view().submit()]);
  });
  assert.equal(first.calls.length + second.calls.length, 1);
  assert.equal(first.view().recovery?.requestId, second.view().recovery?.requestId);
  assert.equal(first.view().recovery?.kind, second.view().recovery?.kind);
  assert.equal(first.storage.values.size, 1);
  await first.unmount();
  await second.unmount();
});

test('equivalent quote projections preserve a captured Pay callback while quote loading retires it', async () => {
  const m = mount();
  await m.render();
  const captured = m.view().submit;
  await m.push(QUOTE, { ok: true, quote: { ...quote } });
  await m.invoke(captured);
  assert.equal(m.calls.length, 1);
  await m.unmount();

  const pending = mount();
  await pending.render();
  const beforeLoading = pending.view().submit;
  await pending.push(QUOTE, undefined);
  await pending.invoke(() => pending.view().submit());
  assert.equal(pending.calls.length, 0);
  await pending.push(QUOTE, { ok: true, quote });
  await pending.invoke(beforeLoading);
  assert.equal(pending.calls.length, 0, 'loading then the same quote cannot revive an old Pay callback');
  assert.equal(pending.storage.values.size, 0);
  await pending.invoke(() => pending.view().submit());
  assert.equal(pending.calls.length, 1);
  await pending.unmount();
});

test('a malformed or conflicting false initiation result cannot retire the original opaque identity', async () => {
  for (const response of [
    { ok: false, code: 'conflicting_reuse' },
    { ok: false, code: 'quote_mismatch' },
  ]) {
    const m = mount();
    await m.render();
    m.handlers.set(COLLECTION, async () => response);
    await m.invoke(() => m.view().submit());
    assert.equal(m.view().recovery?.requestId, recovery.requestId);
    assert.equal(JSON.parse(m.storage.values.get(key) ?? '').requestId, recovery.requestId);
    await m.unmount();
  }
});

test('another committed owner can submit work while an obsolete owner reply is pending; old finally cannot retire it', async () => {
  const m = mount();
  await m.render();
  const firstReply = deferred<unknown>();
  const secondReply = deferred<unknown>();
  let sends = 0;
  m.handlers.set(COLLECTION, () => (++sends === 1 ? firstReply.promise : secondReply.promise));
  let first: Promise<void> = Promise.resolve();
  await act(async () => {
    first = m.view().submit();
  });
  m.controls.auth = ready('clerk_b');
  await m.render();
  await m.push(QUOTE, { ok: true, quote: { ...quote } });
  let second: Promise<void> = Promise.resolve();
  await act(async () => {
    second = m.view().submit();
  });
  firstReply.reject(Error('obsolete reply'));
  await act(async () => {
    await first;
  });
  assert.equal(m.view().working, true);
  assert.equal(m.view().error, null);
  secondReply.resolve({ ok: true, operationId: 'paymentOperations|2', status: 'attempted' });
  await act(async () => {
    await second;
  });
  assert.equal(m.view().working, false);
  assert.equal(m.calls.length, 2);
  await m.unmount();
});

test('review arriving during exact mismatch deletion retains the original identity before the storage queue releases', async () => {
  const m = mount();
  await m.render();
  const response = deferred<unknown>();
  const removed = deferred<void>();
  m.handlers.set(COLLECTION, () => response.promise);
  m.storage.removeItem = async (key) => {
    await removed.promise;
    m.storage.values.delete(key);
  };
  let work: Promise<void> = Promise.resolve();
  await act(async () => {
    work = m.view().submit();
  });
  await act(async () => {
    response.resolve({ ok: false, code: 'quote_mismatch', quote: { ...quote, quoteKey: 'new' } });
  });
  await m.push(STATUS, { result: 'review', reason: 'ambiguous_request' });
  removed.resolve();
  await act(async () => {
    await work;
  });
  assert.equal(m.view().recovery?.requestId, recovery.requestId);
  assert.equal(m.storage.values.get(key), JSON.stringify(recovery));
  assert.equal(m.view().outcome, 'review');
  await m.unmount();
});

for (const phone of ['', '   ', 'bad-phone', '097-12345', '1234', '1'.repeat(33), '1234\t5', '１２３４５']) {
  test(`local invalid payer ${JSON.stringify(phone)} stays ready with zero intent, SDK and registered operation`, async () => {
    const db = backendFixture();
    let posts = 0;
    const registered = collectionModule.createCheckoutCollectionAction({
      env: () => ({ LENCO_API_KEY: 'synthetic-test-key' }),
      fetchImpl: async () => {
        posts += 1;
        throw Error('unexpected provider call');
      },
    });
    const ctx = createFakeActionCtx({
      db,
      subject: 'buyer',
      modules: {
        checkoutCollection: collectionModule,
        providerOperations: providerModule,
        providerSettlement: settlementModule,
      },
    });
    const m = mount({ auth: ready('buyer'), options: { phone } });
    m.handlers.set(COLLECTION, (args) => invokeFakeFunction(registered, ctx, args));
    await m.render();
    await m.invoke(() => m.view().submit());
    assert.equal(m.calls.length, 0, 'local draft errors must never reach SDK');
    assert.equal(m.digests(), 0, 'local validation precedes digest and intent claim');
    assert.equal(m.storage.values.size, 0);
    assert.equal(m.view().recovery, null);
    assert.equal(m.view().ready, true);
    assert.match(m.view().error ?? '', /mobile money number/i);
    assert.equal(db.tables.paymentOperations?.length, 0);
    assert.equal(posts, 0);
    await m.unmount();
  });
}

test('invalid payer correction needs a fresh Pay tap and executes one coherent registered collection', async () => {
  const db = backendFixture();
  let posts = 0;
  const registered = collectionModule.createCheckoutCollectionAction({
    env: () => ({ LENCO_API_KEY: 'synthetic-test-key' }),
    fetchImpl: async (_url, init) => {
      posts += 1;
      const args = object(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          status: true,
          data: {
            id: '22222222-2222-3333-4444-555555555555',
            reference: args.reference,
            amount: String(args.amount),
            currency: 'ZMW',
            status: 'pending',
            type: 'mobile-money',
            bearer: 'merchant',
            mobileMoneyDetails: { country: 'zm', operator: args.operator, phone: args.phone },
            reasonForFailure: null,
            settlementStatus: null,
          },
        }),
        { status: 200 },
      );
    },
  });
  const ctx = createFakeActionCtx({
    db,
    subject: 'buyer',
    modules: {
      checkoutCollection: collectionModule,
      providerOperations: providerModule,
      providerSettlement: settlementModule,
    },
  });
  const m = mount({ auth: ready('buyer'), options: { phone: 'bad-phone' } });
  const quoted = await invokeFakeFunction(checkoutQuoteModule.quoteCheckout, createCtx(db, 'buyer'), selectors);
  await m.push(QUOTE, quoted);
  await m.render();
  m.handlers.set(COLLECTION, (args) => invokeFakeFunction(registered, ctx, args));
  await m.invoke(() => m.view().submit());
  assert.equal(m.calls.length, 0);
  assert.equal(m.storage.values.size, 0);
  assert.equal(db.tables.paymentOperations?.length, 0);
  m.setOptions({ phone: '  +260 971234567  ' });
  await m.render();
  assert.equal(m.calls.length, 0, 'correction never submits automatically');
  await m.invoke(() => m.view().submit());
  assert.equal(m.calls.length, 1);
  assert.equal(posts, 1);
  assert.equal(db.tables.paymentOperations?.length, 1);
  assert.ok(m.view().recovery);
  assert.equal(m.view().outcome, 'unknown', 'initiation is not accounting proof');
  await m.invoke(() => m.view().submit());
  assert.equal(posts, 1);
  await m.unmount();
});

test('wallet ignores irrelevant malformed payer and a captured Pay callback cannot revive after invalid/corrected ABA', async () => {
  const wallet = mount({ options: { kind: 'wallet_purchase', phone: 'bad-phone', operator: null } });
  await wallet.render();
  await wallet.invoke(() => wallet.view().submit());
  assert.equal(wallet.calls[0]?.name, PURCHASE);
  await wallet.unmount();
  const m = mount();
  await m.render();
  const old = m.view().submit;
  m.setOptions({ phone: 'bad-phone' });
  await m.render();
  m.setOptions({ phone: '0971234567' });
  await m.render();
  await m.invoke(old);
  assert.equal(m.calls.length, 0);
  assert.equal(m.storage.values.size, 0);
  await m.invoke(() => m.view().submit());
  assert.equal(m.calls.length, 1);
  await m.unmount();
});

test('a Pay callback from before quote A to B to A cannot accept a later quote generation', async () => {
  const m = mount();
  await m.render();
  const stalePay = m.view().submit;
  await m.push(QUOTE, { ok: true, quote: { ...quote, quoteKey: 'quote-two' } });
  await m.push(QUOTE, { ok: true, quote });
  await m.invoke(stalePay);
  assert.equal(m.calls.length, 0);
  assert.equal(m.storage.values.size, 0);
  await m.invoke(() => m.view().submit());
  assert.equal(m.calls.length, 1);
  assert.equal(m.calls[0]?.args.expectedQuoteKey, 'quote-one');
  await m.unmount();
});
