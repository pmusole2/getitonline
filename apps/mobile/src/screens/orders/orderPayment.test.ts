import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

import { resolveAccountAccess } from '@gettitonline/shared';
import {
  createControls,
  createHarness,
  findNodes,
  fixture,
  textOf,
  withFallback,
  type Props,
} from '../../../../../tests/support/componentHarness';

import * as quoteModule from '../../../../../convex/checkoutQuote';
import * as purchaseModule from '../../../../../convex/paymentOperations';
import * as ordersModule from '../../../../../convex/orders';
import { createDb, createCtx, type Row } from '../../../../../tests/support/convexFakeDb';
import { invokeFakeFunction } from '../../../../../tests/support/convexFakeActionCtx';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const file = (path: string): string => resolve(root, path);

function openOrder(order?: Props, user?: Props) {
  const controls = createControls();
  controls.auth = {
    isLoading: false,
    isSignedIn: true,
    authSyncError: null,
    clerkUser: { id: 'clerk_a' },
    user: { _id: 'users|a', clerkId: 'clerk_a', role: 'user', isBanned: false },
  };
  controls.queries = {
    'orders.getOrder': fixture({
      _id: 'orders|1',
      buyerId: 'users|a',
      sellerId: 'users|s',
      orderNumber: 'ORD-1',
      status: 'delivered',
      totalAmount: 100,
      items: [],
      shippingAddress: { street: 'Street', city: 'Lusaka', province: 'Lusaka', country: 'Zambia', phone: '0971234567' },
    }),
    'delivery.getOrderTrackingEvents': [],
    'delivery.getOrderReturnRequests': [],
    'delivery.listDeliveryMethods': [],
    'delivery.calculateDeliveryQuote': [],
    'delivery.listPickupPoints': [],
  };
  if (order) controls.queries['orders.getOrder'] = fixture(order);
  if (user) {
    controls.auth.user = user;
    controls.auth.clerkUser = { id: user.clerkId };
  }
  const harness = createHarness({
    controls,
    effects: true,
    files: {
      [file('apps/mobile/src/context/AuthProvider.tsx')]: withFallback({ useAppAuth: () => controls.auth }),
      [file('apps/mobile/src/hooks/useImageUpload.ts')]: withFallback({ useImageUpload: () => ({ images: [] }) }),
    },
    packages: {
      '@react-native-async-storage/async-storage': { __esModule: true, default: { getItem: async () => null } },
      'react-native': withFallback({
        Alert: { alert: (...args: unknown[]) => controls.calls.push({ name: 'Alert.alert', args }) },
      }),
      '@gettitonline/shared': withFallback({ resolveAccountAccess }),
    },
  });
  const screen = harness.load(file('apps/mobile/src/screens/orders/OrderDetailScreen.tsx')).default;
  const render = () => harness.render(screen, { route: { params: { orderId: 'orders|1' } }, navigation: {} });
  return { controls, render };
}

test('actual order completion presents accounting review before any success claim', async () => {
  const { controls, render } = openOrder();
  controls.mutations['orders.updateOrderStatus'] = async () => ({ accountingOutcome: 'review' });
  const result = render();
  const [complete] = findNodes(
    result.tree,
    (node) => node.name === 'Pressable' && textOf(node.children) === 'Complete Order',
  );
  assert.ok(complete, textOf(result.tree));
  await Reflect.apply(complete.props.onPress as () => Promise<void>, undefined, []);
  const alerts = controls.calls.filter((call) => call.name === 'Alert.alert').map((call) => call.args);
  assert.ok(
    alerts.some((args: readonly unknown[]) => args[0] === 'Accounting review pending'),
    JSON.stringify(alerts),
  );
  assert.ok(!alerts.some((args: readonly unknown[]) => args[0] === 'Success'));
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

async function fundedOrder() {
  const db = backendFixture();
  const admin = { _id: 'users|admin', clerkId: 'admin', role: 'admin', isBanned: false };
  db.tables.users?.push(admin);
  const selectors = { source: 'cart', shippingAddress: address };
  const quoted = object(await invokeFakeFunction(quoteModule.quoteCheckout, createCtx(db, 'buyer'), selectors));
  assert.equal(quoted.ok, true);
  const purchased = object(
    await invokeFakeFunction(purchaseModule.purchaseWithWallet, createCtx(db, 'buyer'), {
      ...selectors,
      requestId: 'order-screen-proof',
      expectedQuoteKey: object(quoted.quote).quoteKey,
    }),
  );
  assert.equal(purchased.ok, true);
  const order = db.tables.orders?.[0];
  assert.ok(order);
  const buyer = db.tables.users?.find((row) => row.clerkId === 'buyer');
  assert.ok(buyer);
  return { db, order, buyer, admin };
}
const address = { street: 'Street', city: 'Lusaka', province: 'Lusaka', country: 'Zambia', phone: '0971234567' };

for (const review of [false, true]) {
  test(`actual registered completion → actual screen preserves ${review ? 'review hold' : 'applied success'} truth`, async () => {
    const f = await fundedOrder();
    f.order.status = 'delivered';
    if (review) {
      assert.equal(typeof f.order.sellerId, 'string');
      await f.db.delete(String(f.order.sellerId));
    }
    const m = openOrder(f.order, f.buyer);
    m.controls.mutations['orders.updateOrderStatus'] = (args) =>
      invokeFakeFunction(ordersModule.updateOrderStatus, createCtx(f.db, 'buyer'), args);
    const result = m.render();
    const [complete] = findNodes(
      result.tree,
      (node) => node.name === 'Pressable' && textOf(node.children) === 'Complete Order',
    );
    assert.ok(complete);
    await Reflect.apply(complete.props.onPress as () => Promise<void>, undefined, []);
    const alerts = m.controls.calls.filter((call) => call.name === 'Alert.alert').map((call) => call.args);
    assert.ok(
      alerts.some((args) => args[0] === (review ? 'Accounting review pending' : 'Success')),
      JSON.stringify(alerts),
    );
    assert.equal(f.order.status, review ? 'delivered' : 'completed');
    assert.equal(
      alerts.some((args) => args[0] === 'Success'),
      !review,
    );
    const settled = m.render();
    assert.equal(
      findNodes(settled.tree, (node) => node.name === 'ActivityIndicator').length,
      0,
      'the completed registered outcome releases its loading before the next query projection',
    );
  });

  test(`actual registered admin cancel → actual screen preserves ${review ? 'refund review hold' : 'applied cancellation'} truth`, async () => {
    const f = await fundedOrder();
    if (review) await f.db.delete('users|buyer');
    const m = openOrder(f.order, f.admin);
    m.controls.mutations['orders.cancelOrder'] = (args) =>
      invokeFakeFunction(ordersModule.cancelOrder, createCtx(f.db, 'admin'), args);
    const result = m.render();
    const [cancel] = findNodes(
      result.tree,
      (node) => node.name === 'Pressable' && textOf(node.children) === 'Cancel & Refund Order',
    );
    const [fallback] = findNodes(
      result.tree,
      (node) => node.name === 'Pressable' && textOf(node.children).includes('Cancel'),
    );
    const control = cancel ?? fallback;
    assert.ok(control, textOf(result.tree));
    await Reflect.apply(control.props.onPress as () => void, undefined, []);
    const confirmation = m.controls.calls.find((call) => call.name === 'Alert.alert');
    assert.ok(confirmation);
    const buttons = confirmation.args[2];
    assert.ok(Array.isArray(buttons));
    const confirm = buttons.find((button) => button.text === 'Cancel Order');
    assert.ok(confirm);
    await confirm.onPress();
    const alerts = m.controls.calls.filter((call) => call.name === 'Alert.alert').map((call) => call.args);
    assert.ok(
      alerts.some((args) => args[0] === (review ? 'Accounting review pending' : 'Order cancelled')),
      JSON.stringify(alerts),
    );
    assert.equal(f.order.status, review ? 'paid' : 'cancelled');
    assert.equal(
      alerts.some((args) => args[0] === 'Order cancelled'),
      !review,
    );
    const settled = m.render();
    assert.equal(
      findNodes(settled.tree, (node) => node.name === 'ActivityIndicator').length,
      0,
      'the completed registered outcome releases its loading before the next query projection',
    );
  });
}
