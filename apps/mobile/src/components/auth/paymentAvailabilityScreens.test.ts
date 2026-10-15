import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

import React from 'react';
import * as ConvexReact from 'convex/react';
import { anyApi } from 'convex/server';

import { resolvePaymentAvailability } from '../../../../../packages/shared/src/utils/clientGate';
import {
  createControls,
  createHarness,
  findNodes,
  fixture,
  textOf,
  withFallback,
  type Props,
} from '../../../../../tests/support/componentHarness';
import { createFakeConvexClient, deliver, mountUnderConvex } from '../../../../../tests/support/realReactRender';

// Runs the real checkout and wallet screens. Payment availability is faked through the Convex query result.
// A missing result (loading), a failed query (an Error), a null result, and a malformed one must all leave payment
// entry points off, and a failed query must not replace the screen with the error screen.
const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const file = (path: string) => resolve(root, path);
const availabilityKey = 'appConfig.getPaymentAvailability';
const unavailableMessage = 'Payments are temporarily unavailable';
const user = { _id: 'user_1', clerkId: 'clerk_1', role: 'user', isBanned: false, email: 'ada@example.com' };

function paymentButtons(tree: Parameters<typeof findNodes>[0], label: string) {
  return findNodes(tree, (node) => node.name.endsWith('Button') && textOf(node.children) === label);
}

function payButtons(tree: Parameters<typeof findNodes>[0]) {
  return findNodes(tree, (node) => node.name.endsWith('Button') && textOf(node.children).startsWith('Pay '));
}

function pressables(tree: Parameters<typeof findNodes>[0], label: string) {
  return findNodes(tree, (node) => node.name === 'Pressable' && textOf(node.children) === label);
}

function checkoutSetup(availability: unknown) {
  const controls = createControls();
  controls.auth = {
    isLoading: false,
    isSignedIn: true,
    authSyncError: null,
    clerkUser: { id: 'clerk_1' },
    user: { ...user, phone: '0971234567', address: { street: 'Street', city: 'Lusaka', province: 'Lusaka' } },
    retryUserSync: () => undefined,
  };
  controls.queries = {
    [availabilityKey]: availability,
    'cart.getCartBySeller': [
      fixture({
        sellerId: 'seller_1',
        sellerName: 'Fixture Seller',
        subtotal: 100,
        shippingTotal: 0,
        items: [
          {
            productId: 'product_1',
            quantity: 1,
            lineUnitPrice: 100,
            selectedShipping: { name: 'Pickup', price: 0 },
            product: { title: 'Fixture item', price: 100, images: [], quantity: 1 },
          },
        ],
      }),
    ],
    'delivery.calculateDeliveryQuote': [],
    'delivery.listDeliveryMethods': [],
    'delivery.listPickupPoints': [],
    'loyalty.getMyLoyaltyAccount': fixture({ pointsBalance: 0 }),
    'wallet.getWalletBalance': null,
    'wallet.getWalletActivity': null,
    'wallet.getWalletTransactions': [],
  };
  const harness = createHarness({
    controls,
    files: {
      [file('apps/mobile/src/context/AuthProvider.tsx')]: withFallback({
        useAppAuth: () => {
          controls.hook('useContext');
          return controls.auth;
        },
      }),
      [file('apps/mobile/src/context/GuestCartProvider.tsx')]: withFallback({
        useGuestCart: () => ({ hasPendingMerge: false, isMerging: false, isHydrated: true, mergeFailed: false }),
      }),
      [file('apps/mobile/src/services/api.ts')]: withFallback({}),
      [file('apps/mobile/src/hooks/useWalletOperations.ts')]: withFallback({ useWalletOperations: () => ({}) }),
    },
    packages: {
      '@gettitonline/shared': withFallback({ resolvePaymentAvailability, resolveAccountAccess: () => 'ready' }),
    },
  });
  const screen = harness.load(file('apps/mobile/src/screens/cart/CheckoutScreen.tsx')).default;
  return { render: () => harness.render(screen, { navigation: { goBack: () => undefined } }) };
}

function walletSetup(
  availability: unknown,
  balance: Props | null = { balance: 100, pendingBalance: 0, isFrozen: false },
) {
  const controls = createControls();
  controls.auth = { isLoading: false, isSignedIn: true, authSyncError: null, user };
  controls.queries = { [availabilityKey]: availability };
  const wallet = {
    operations: {
      access: 'ready',
      sessionKey: 1,
      isCurrent: () => true,
      ready: true,
      working: false,
      error: null,
      recovery: null,
      outcome: 'unknown',
      status: undefined,
      banks: [],
      accounts: [
        {
          accountId: 'paymentAccounts|mm',
          type: 'mobile_money',
          destinationKey: 'mm:zm:mtn:0971234567',
          phone: '0971234567',
          operator: 'mtn',
          accountName: 'Synthetic Resolved',
          isVerified: true,
          providerResolvedAt: 1,
        },
      ],
      accountsPending: false,
      accountsError: false,
      approvalRevision: 0,
      loadBanks: async () => undefined,
      registerDestination: async () => undefined,
      checkStatus: async () => undefined,
      newSubmission: async () => undefined,
      cancelDraft: () => undefined,
    },
    balance,
    activity: null,
    transactions: [],
    isLoading: false,
    error: null,
    refreshBalance: async () => undefined,
    refreshActivity: async () => undefined,
    refreshTransactions: async () => undefined,
    withdrawToMobileMoney: async () => ({}),
    withdrawToBank: async () => ({}),
    topUp: async () => ({}),
    ensureWallet: async () => undefined,
    clearError: () => undefined,
  };
  const harness = createHarness({
    controls,
    files: {
      [file('apps/mobile/src/context/AuthProvider.tsx')]: withFallback({
        useAppAuth: () => controls.auth,
      }),
      [file('apps/mobile/src/hooks/useWallet.ts')]: withFallback({ useWallet: () => wallet }),
    },
    packages: {
      '@gettitonline/shared': withFallback({ resolvePaymentAvailability }),
    },
  });
  const screen = harness.load(file('apps/mobile/src/screens/wallet/WalletScreen.tsx')).default;
  return { render: () => harness.render(screen, { navigation: { navigate: () => undefined } }) };
}

for (const [label, availability] of [
  ['loading', undefined],
  ['a null result', null],
  ['a failed query', new Error('server unavailable')],
  ['a malformed result', { paymentsEnabled: 'true' }],
  ['payments switched off', { paymentsEnabled: false }],
] as const) {
  test(`checkout disables payment and says so when ${label}`, () => {
    const result = checkoutSetup(availability).render();
    assert.ok(textOf(result.tree).includes(unavailableMessage), textOf(result.tree));
    const [pay] = payButtons(result.tree);
    assert.ok(pay, textOf(result.tree));
    assert.equal(pay.props.disabled, true);
  });

  test(`wallet top-up and withdraw are disabled and say so when ${label}`, () => {
    const result = walletSetup(availability).render();
    assert.ok(textOf(result.tree).includes(unavailableMessage), textOf(result.tree));
    const [topUp] = pressables(result.tree, 'Top Up');
    const [withdraw] = pressables(result.tree, 'Withdraw');
    assert.equal(topUp?.props.disabled, true);
    assert.equal(withdraw?.props.disabled, true);
  });
}

test('checkout requires a current quote and explicit approval even when payments are on', () => {
  const result = checkoutSetup({ paymentsEnabled: true }).render();
  assert.ok(!textOf(result.tree).includes(unavailableMessage));
  const [pay] = payButtons(result.tree);
  assert.equal(pay?.props.disabled, true);
});

test('wallet top-up and withdraw are enabled only when payments are available', () => {
  const result = walletSetup({ paymentsEnabled: true }).render();
  assert.ok(!textOf(result.tree).includes(unavailableMessage));
  const [topUp] = pressables(result.tree, 'Top Up');
  const [withdraw] = pressables(result.tree, 'Withdraw');
  assert.ok(topUp, textOf(result.tree));
  assert.ok(withdraw, textOf(result.tree));
  assert.notEqual(topUp.props.disabled, true);
  assert.notEqual(withdraw.props.disabled, true);
});

test('wallet withdraw stays disabled for a zero balance even when payments are available', () => {
  const result = walletSetup({ paymentsEnabled: true }, { balance: 0, pendingBalance: 0, isFrozen: false }).render();
  const [withdraw] = pressables(result.tree, 'Withdraw');
  assert.equal(withdraw?.props.disabled, true);
});

test('wallet top-up submit is disabled while payments are unavailable', () => {
  const result = walletSetup(undefined).render();
  const [submit] = paymentButtons(result.tree, 'Top Up');
  assert.equal(submit?.props.disabled, true);
});

// Real React and convex/react, with the hook loaded from source. The result arrives through the real watch protocol.
const realAvailabilityName = 'appConfig:getPaymentAvailability';

test('the real useQueries reads payment availability without a render loop, and a parent re-render keeps it', async () => {
  const harness = createHarness({
    controls: createControls(),
    convexApi: { api: anyApi },
    packages: {
      react: React,
      'convex/react': ConvexReact,
      '@gettitonline/shared': withFallback({ resolvePaymentAvailability }),
    },
  });
  const usePaymentAvailability = harness.load(file('apps/mobile/src/hooks/usePaymentAvailability.ts'))
    .usePaymentAvailability as () => string;
  const observed = { renders: 0, last: '' };
  function Probe(): null {
    observed.renders += 1;
    observed.last = usePaymentAvailability();
    return null;
  }
  const convex = createFakeConvexClient();
  const mounted = mountUnderConvex(convex);
  await mounted.render(React.createElement(Probe));
  assert.equal(observed.last, 'unavailable');
  await deliver(convex, realAvailabilityName, { paymentsEnabled: true });
  assert.equal(observed.last, 'available');
  await mounted.render(React.createElement(Probe));
  assert.equal(observed.last, 'available');
  assert.ok(observed.renders <= 4, `rendered ${observed.renders} times`);
  assert.deepEqual(convex.lifecycle, [`subscribe:${realAvailabilityName}`]);
  await mounted.unmount();
});

test('the real useQueries keeps payments unavailable when the availability query fails', async () => {
  const harness = createHarness({
    controls: createControls(),
    convexApi: { api: anyApi },
    packages: {
      react: React,
      'convex/react': ConvexReact,
      '@gettitonline/shared': withFallback({ resolvePaymentAvailability }),
    },
  });
  const usePaymentAvailability = harness.load(file('apps/mobile/src/hooks/usePaymentAvailability.ts'))
    .usePaymentAvailability as () => string;
  const observed = { last: '' };
  function Probe(): null {
    observed.last = usePaymentAvailability();
    return null;
  }
  const convex = createFakeConvexClient({ [realAvailabilityName]: { paymentsEnabled: true } });
  const mounted = mountUnderConvex(convex);
  await mounted.render(React.createElement(Probe));
  assert.equal(observed.last, 'available');
  await deliver(convex, realAvailabilityName, new Error('server unavailable'));
  assert.equal(observed.last, 'unavailable');
  await mounted.unmount();
});
