import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

import { resolveAccountAccess } from '../../../../../packages/shared/src/utils/accountAccess';
import {
  createControls,
  createHarness,
  findNodes,
  fixture,
  hasNode,
  pressButton,
  textOf,
  withFallback,
  type Props,
} from '../../../../../tests/support/componentHarness';

// Executes the actual checkout and wallet hooks. Auth and guest-cart providers are controlled; effects/provider
// transport are not run. These tests catch premature private requests and cached checkout state after access loss.
const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const file = (path: string) => resolve(root, path);
const user = {
  _id: 'user_1',
  clerkId: 'clerk_1',
  role: 'user',
  isBanned: false,
  phone: '0971234567',
  address: { street: 'First address', city: 'Lusaka', province: 'Lusaka' },
};

function open(auth: Props = {}) {
  const controls = createControls();
  controls.auth = {
    isLoading: false,
    isSignedIn: true,
    authSyncError: null,
    clerkUser: { id: 'clerk_1' },
    user,
    retryUserSync: () => controls.calls.push({ name: 'retry', args: [] }),
    signOut: async () => controls.calls.push({ name: 'signOut', args: [] }),
    ...auth,
  };
  controls.queries = {
    'cart.getCartBySeller': [],
    'delivery.calculateDeliveryQuote': [],
    'delivery.listDeliveryMethods': [],
    'delivery.listPickupPoints': [],
    'loyalty.getMyLoyaltyAccount': fixture({ pointsBalance: 125 }),
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
        useGuestCart: () => {
          controls.hook('useContext');
          return { hasPendingMerge: false, isMerging: false, isHydrated: true, mergeFailed: false };
        },
      }),
      [file('apps/mobile/src/services/api.ts')]: withFallback({}),
    },
    packages: { '@gettitonline/shared': withFallback({ resolveAccountAccess }) },
  });
  const screen = harness.load(file('apps/mobile/src/screens/cart/CheckoutScreen.tsx')).default;

  return {
    controls,
    render: () => harness.render(screen, { navigation: { goBack: () => undefined } }),
  };
}

for (const [label, auth, expected] of [
  ['signed out', { isSignedIn: false, user: null }, 'Sign In'],
  ['banned', { user: { ...user, isBanned: true } }, 'Account unavailable'],
  ['banned staff', { user: { ...user, role: 'admin', isBanned: true } }, 'Account unavailable'],
  ['deleted', { user: { ...user, isBanned: true, deletedAt: 1 } }, 'Account unavailable'],
  ['failed sync', { user: null, authSyncError: 'Sync failed' }, 'Account setup did not finish'],
] as const) {
  test(`checkout ${label} shows the access notice without protected requests`, () => {
    const result = open(auth).render();
    assert.ok(textOf(result.tree).includes(expected), textOf(result.tree));
    assert.equal(result.queryCalls.filter((call) => call.args !== 'skip').length, 0);
    assert.ok(!textOf(result.tree).includes('Delivery Address'));
  });
}

test('checkout waits for auth, then requests loyalty without acting IDs and requires a valid quote and explicit approval', () => {
  const { controls, render } = open({ isLoading: true });
  const pending = render();
  assert.ok(hasNode(pending.tree, 'ActivityIndicator'));
  assert.equal(pending.queryCalls.length, 0);
  controls.auth = { ...controls.auth, isLoading: false };
  controls.queries['cart.getCartBySeller'] = [
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
  ];
  const ready = render();
  assert.ok(textOf(ready.tree).includes('Delivery Address'));
  assert.deepEqual(ready.queryCalls.find((call) => call.name === 'loyalty.getMyLoyaltyAccount')?.args, {});
  assert.ok(findNodes(ready.tree, (node) => node.props.label === 'Loyalty points (125 available)').length === 1);
  const paymentButtons = findNodes(
    ready.tree,
    (node) => node.name.endsWith('Button') && textOf(node.children).startsWith('Pay '),
  );
  assert.equal(paymentButtons.length, 1);
  assert.equal(paymentButtons[0].props.disabled, true, 'a nonempty cart alone cannot approve a financial quote');
});

test('checkout query loading is requested, and absent loyalty renders an empty balance', () => {
  const { controls, render } = open();
  controls.queries['cart.getCartBySeller'] = undefined;
  const pending = render();
  assert.ok(hasNode(pending.tree, 'ActivityIndicator'));
  assert.ok(pending.queryCalls.some((call) => call.name === 'cart.getCartBySeller' && call.args !== 'skip'));
  controls.queries['cart.getCartBySeller'] = [];
  controls.queries['loyalty.getMyLoyaltyAccount'] = null;
  assert.ok(findNodes(render().tree, (node) => node.props.label === 'Loyalty points (0 available)').length === 1);
});

test('checkout recovery controls run retry and sign-out', () => {
  const { controls, render } = open({ user: null, authSyncError: 'Sync failed' });
  const result = render();
  assert.ok(pressButton(result.tree, 'Try Again'));
  assert.ok(pressButton(result.tree, 'Sign Out'));
  assert.deepEqual(
    controls.calls.map((call) => call.name),
    ['retry', 'signOut'],
  );
});

test('checkout discards private content and address drafts on access loss or account switch', () => {
  const { controls, render } = open();
  const first = render();
  const input = findNodes(first.tree, (node) => node.props.label === 'Street address')[0];
  assert.equal(input.props.value, 'First address');
  assert.ok(typeof input.props.onChangeText === 'function');
  input.props.onChangeText('Private draft');
  controls.auth = { ...controls.auth, user: { ...user, isBanned: true } };
  const denied = render();
  assert.ok(!textOf(denied.tree).includes('Delivery Address'));
  assert.equal(denied.queryCalls.length, 0);
  controls.auth = { ...controls.auth, user };
  const restored = render();
  assert.equal(
    findNodes(restored.tree, (node) => node.props.label === 'Street address')[0].props.value,
    'First address',
  );
  controls.auth = { ...controls.auth, user: { ...user, _id: 'user_2', address: { street: 'Second address' } } };
  assert.equal(
    findNodes(render().tree, (node) => node.props.label === 'Street address')[0].props.value,
    'Second address',
  );
});
