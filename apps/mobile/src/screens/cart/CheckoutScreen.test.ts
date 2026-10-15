import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import React, { act, createElement, isValidElement, type ReactNode } from 'react';
import * as JsxRuntime from 'react/jsx-runtime';
import * as ConvexReact from 'convex/react';
import { getFunctionName } from 'convex/server';
import * as shared from '../../../../../packages/shared/src/index';
import * as cartModule from '../../../../../convex/cart';
import * as walletModule from '../../../../../convex/wallet';
import * as checkoutQuoteModule from '../../../../../convex/checkoutQuote';
import * as paymentOperationsModule from '../../../../../convex/paymentOperations';
import type { Row } from '../../../../../tests/support/convexFakeDb';
import * as ordersModule from '../../../../../convex/orders';
import { createDb, createCtx } from '../../../../../tests/support/convexFakeDb';
import { invokeFakeFunction } from '../../../../../tests/support/convexFakeActionCtx';
import { api } from '../../../../../convex/_generated/api';
import { createFakeConvexClient, deliver, mountUnderConvex } from '../../../../../tests/support/realReactRender';
import type { usePayment } from '../../hooks/usePayment';
import type { Props } from '../../../../../tests/support/componentHarness';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

import { resolveAccountAccess, resolvePaymentAvailability } from '@gettitonline/shared';
import {
  createControls,
  createHarness,
  findNodes,
  textOf,
  withFallback,
} from '../../../../../tests/support/componentHarness';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const file = (path: string): string => resolve(root, path);

test('actual cart checkout excludes card/bank transport and requires a current authoritative quote to pay', () => {
  const controls = createControls();
  controls.auth = {
    isLoading: false,
    isSignedIn: true,
    authSyncError: null,
    clerkUser: { id: 'clerk_a' },
    user: {
      _id: 'users|a',
      clerkId: 'clerk_a',
      role: 'user',
      isBanned: false,
      phone: '0971234567',
      address: { street: 'Street', city: 'Lusaka', province: 'Lusaka' },
    },
  };
  controls.queries = {
    'appConfig.getPaymentAvailability': { paymentsEnabled: true },
    'cart.getCartBySeller': [],
    'delivery.calculateDeliveryQuote': [],
    'delivery.listDeliveryMethods': [],
    'delivery.listPickupPoints': [],
    'loyalty.getMyLoyaltyAccount': null,
    'wallet.getWalletBalance': null,
    'wallet.getWalletActivity': null,
    'wallet.getWalletTransactions': [],
  };
  const harness = createHarness({
    controls,
    files: {
      [file('apps/mobile/src/context/AuthProvider.tsx')]: withFallback({ useAppAuth: () => controls.auth }),
      [file('apps/mobile/src/context/GuestCartProvider.tsx')]: withFallback({
        useGuestCart: () => ({ hasPendingMerge: false, isMerging: false, isHydrated: true, mergeFailed: false }),
      }),
      [file('apps/mobile/src/hooks/useWalletOperations.ts')]: withFallback({ useWalletOperations: () => ({}) }),
      [file('apps/mobile/src/services/api.ts')]: withFallback({}),
    },
    packages: { '@gettitonline/shared': withFallback({ resolveAccountAccess, resolvePaymentAvailability }) },
  });
  const screen = harness.load(file('apps/mobile/src/screens/cart/CheckoutScreen.tsx')).default;
  const result = harness.render(screen, { navigation: { goBack: () => undefined } });
  assert.equal(
    findNodes(result.tree, (node) => node.name === 'Pressable' && textOf(node.children) === 'card').length,
    0,
  );
  assert.equal(
    findNodes(result.tree, (node) => node.name === 'Pressable' && textOf(node.children) === 'bank transfer').length,
    0,
  );
  assert.ok(!textOf(result.tree).includes('Approve current quote'), textOf(result.tree));
  assert.equal(controls.calls.filter((call) => call.name.startsWith('mutation:')).length, 0);
});

const QUOTE = getFunctionName(api.checkoutQuote.quoteCheckout);
const STATUS = getFunctionName(api.paymentReconciliation.getStatus);
const AVAILABILITY = getFunctionName(api.appConfig.getPaymentAvailability);
const PURCHASE = getFunctionName(api.paymentOperations.purchaseWithWallet);
const COLLECTION = getFunctionName(api.checkoutCollection.initiateCheckoutCollection);
const METHODS = getFunctionName(api.delivery.listDeliveryMethods);
const POINTS = getFunctionName(api.delivery.listPickupPoints);
const DISCOVERY = getFunctionName(api.delivery.calculateDeliveryQuote);
const CART = getFunctionName(api.cart.getCartBySeller);
const ORDER = getFunctionName(api.orders.getOrder);
const address = { street: 'Street', city: 'Lusaka', province: 'Lusaka', country: 'Zambia', phone: '0971234567' };
const canonicalQuote = {
  source: 'cart',
  quoteKey: 'current-key',
  inputIdentity: 'current-input',
  totalAmountCents: 21000,
  subtotalCents: 20000,
  shippingCents: 0,
  platformFeeCents: 1000,
  discountCents: 0,
  promoCents: 0,
  loyaltyCents: 0,
  lines: [
    {
      productId: 'products|1',
      sellerId: 'users|s1',
      title: 'Red custom row',
      quantity: 1,
      lineTotalCents: 10000,
      variant: { sku: 'RED', attributes: [] },
      optionPairs: [],
      addOns: [],
      customizationKey: 'red',
    },
    {
      productId: 'products|1',
      sellerId: 'users|s2',
      title: 'Blue custom row',
      quantity: 1,
      lineTotalCents: 10000,
      variant: { sku: 'BLUE', attributes: [] },
      optionPairs: [],
      addOns: [],
      customizationKey: 'blue',
    },
  ],
  sellers: ['users|s1', 'users|s2'].map((sellerId) => ({
    sellerId,
    subtotalCents: 10000,
    shippingCents: 0,
    discountCents: 0,
    platformFeeCents: 500,
    totalAmountCents: 10500,
  })),
  shippingAddress: address,
  delivery: { name: 'Current seller delivery', methodType: 'product_fallback' },
};
function label(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(label).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return label(node.props.children);
  return '';
}
type HostProps = Props & { children?: ReactNode };

// Real React and Convex watches, actual screens + actual payment hook. Only native hosts/auth/storage/SDK are controlled.
function integratedScreen(order?: Props) {
  const controls = createControls();
  controls.auth = {
    isLoading: false,
    isSignedIn: true,
    authSyncError: null,
    clerkUser: { id: 'clerk_a' },
    user: { _id: 'users|a', clerkId: 'clerk_a', role: 'user', isBanned: false, phone: '0971234567', address },
  };
  const convex = createFakeConvexClient({
    [AVAILABILITY]: { paymentsEnabled: true },
    [QUOTE]: { ok: true, quote: canonicalQuote },
    [CART]: [],
    [DISCOVERY]: [],
    [METHODS]: [],
    [POINTS]: [],
    [ORDER]: order,
    [getFunctionName(api.wallet.getWalletBalance)]: {
      hasWallet: true,
      balance: 500,
      pendingBalance: 0,
      isFrozen: false,
    },
    [getFunctionName(api.wallet.getWalletActivity)]: null,
    [getFunctionName(api.wallet.getWalletTransactions)]: [],
    [getFunctionName(api.providerOperations.listPaymentAccounts)]: [],
    [getFunctionName(api.loyalty.getMyLoyaltyAccount)]: { pointsBalance: 100 },
    [getFunctionName(api.delivery.getOrderTrackingEvents)]: [],
    [getFunctionName(api.delivery.getOrderReturnRequests)]: [],
  });
  const hosts: { name: string; props: HostProps }[] = [];
  const calls: { name: string; args: Props }[] = [];
  const alerts: unknown[][] = [];
  const navigation: unknown[][] = [];
  const values = new Map<string, string>();
  const handlers = new Map<string, (args: Props) => Promise<unknown>>();
  const sdk = async (ref: Parameters<typeof getFunctionName>[0], args: Props): Promise<unknown> => {
    const name = getFunctionName(ref);
    calls.push({ name, args });
    const handler = handlers.get(name);
    return handler
      ? await handler(args)
      : { ok: true, operationId: 'paymentOperations|1', status: 'attempted', providerReference: 'opaque' };
  };
  Object.assign(convex.client, { action: sdk, mutation: sdk });
  const passthrough = ({ children }: HostProps): ReactNode => children ?? null;
  const host =
    (name: string) =>
    (props: HostProps): ReactNode => {
      hosts.push({ name, props });
      return props.children ?? null;
    };
  const modal = (props: HostProps): ReactNode => {
    hosts.push({ name: 'Modal', props });
    return props.visible ? (props.children ?? null) : null;
  };
  const TextInput = Object.assign(host('TextInput'), { Affix: () => null, Icon: () => null });
  const nav = {
    goBack: () => undefined,
    replace: (...args: unknown[]) => navigation.push(args),
    navigate: (...args: unknown[]) => navigation.push(args),
  };
  const guest = { isHydrated: true, hasPendingMerge: false, isMerging: false, mergeFailed: false };
  const storage = {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: async (key: string) => {
      values.delete(key);
    },
  };
  const harness = createHarness({
    controls,
    convexApi: { api },
    files: {
      [file('apps/mobile/src/context/AuthProvider.tsx')]: withFallback({ useAppAuth: () => controls.auth }),
      [file('apps/mobile/src/context/GuestCartProvider.tsx')]: withFallback({ useGuestCart: () => guest }),
      [file('apps/mobile/src/components/ui/Header.tsx')]: withFallback({ StackHeader: () => null }),
      [file('apps/mobile/src/theme/index.ts')]: withFallback({ formatPrice: (value: unknown) => `K${String(value)}` }),
      [file('apps/mobile/src/hooks/useImageUpload.ts')]: withFallback({ useImageUpload: () => ({ images: [] }) }),
    },
    packages: {
      react: React,
      'react/jsx-runtime': JsxRuntime,
      'convex/react': { ...ConvexReact, useConvexAuth: () => controls.convexAuth },
      '@gettitonline/shared': shared,
      '@react-navigation/native': { useNavigation: () => nav },
      '@react-native-async-storage/async-storage': { __esModule: true, default: storage },
      'expo-crypto': {
        randomUUID: () => '11111111-2222-4333-8444-555555555555',
        CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
        digestStringAsync: async (_algorithm: string, text: string) => createHash('sha256').update(text).digest('hex'),
      },
      'react-native': withFallback({
        View: passthrough,
        ScrollView: passthrough,
        KeyboardAvoidingView: passthrough,
        Pressable: host('Pressable'),
        ActivityIndicator: host('ActivityIndicator'),
        Image: () => null,
        Alert: { alert: (...args: unknown[]) => alerts.push(args) },
        StyleSheet: { create: (styles: Props) => styles },
      }),
      'react-native-paper': withFallback({
        Text: host('Text'),
        Button: host('Button'),
        TextInput,
        Surface: passthrough,
        Chip: host('Chip'),
        Divider: () => null,
        Modal: modal,
        Portal: passthrough,
        useTheme: () => ({ colors: {} }),
      }),
      'expo-linear-gradient': { LinearGradient: passthrough },
      'react-native-reanimated': withFallback({
        default: { View: passthrough },
        FadeInDown: withFallback({}),
        FadeInUp: withFallback({}),
      }),
      'react-native-vector-icons/MaterialCommunityIcons': { __esModule: true, default: () => null },
    },
  });
  const actual = harness.load(file('apps/mobile/src/hooks/usePayment.ts')) as { usePayment: typeof usePayment };
  const original = actual.usePayment;
  let observed: ReturnType<typeof usePayment> | undefined;
  actual.usePayment = (options) => {
    observed = original(options);
    return observed;
  };
  const Screen = harness.load(
    file(
      order
        ? 'apps/mobile/src/screens/orders/OrderDetailScreen.tsx'
        : 'apps/mobile/src/screens/cart/CheckoutScreen.tsx',
    ),
  ).default as (props: Props) => ReactNode;
  const mounted = mountUnderConvex(convex);
  const providers: { ConvexProvider(props: { client: object; children?: ReactNode }): ReactNode | Promise<ReactNode> } =
    ConvexReact;
  const render = async (client = convex.client): Promise<void> => {
    hosts.length = 0;
    await mounted.render(
      createElement(
        providers.ConvexProvider,
        { client },
        createElement(Screen, { navigation: nav, route: { params: { orderId: 'orders|route-selector' } } }),
      ),
    );
  };
  const latest = (name: string, text: string): HostProps => {
    const item = hosts.findLast((entry) => entry.name === name && label(entry.props.children).trim() === text);
    assert.ok(item, `expected ${name}: ${text}`);
    return item.props;
  };
  const run = async (props: HostProps, event = 'onPress', ...args: unknown[]): Promise<void> => {
    assert.equal(typeof props[event], 'function');
    await act(async () => {
      await Reflect.apply(props[event] as (...args: unknown[]) => unknown, undefined, args);
    });
  };
  return {
    controls,
    setUser: (update: Props): void => {
      const user = controls.auth.user;
      assert.ok(typeof user === 'object' && user !== null);
      controls.auth.user = { ...user, ...update };
    },
    calls,
    hosts,
    values,
    alerts,
    navigation,
    guest,
    handlers,
    convex,
    storage,
    render,
    latest,
    run,
    press: async (name: string, text: string) => run(latest(name, text)),
    change: async (text: string, value: string) => {
      const input = hosts.findLast((entry) => entry.name === 'TextInput' && entry.props.label === text);
      assert.ok(input);
      await run(input.props, 'onChangeText', value);
    },
    push: async (name: string, value: unknown) => {
      hosts.length = 0;
      await deliver(convex, name, value);
    },
    view: () => {
      assert.ok(observed);
      return observed;
    },
    unmount: () => mounted.unmount(),
  };
}

test('integrated actual cart accepts the displayed quote with Pay and sends exactly one aggregate wallet purchase', async () => {
  const m = integratedScreen();
  await m.render();
  assert.ok(m.hosts.some((host) => label(host.props.children).includes('Red custom row')));
  assert.ok(m.hosts.some((host) => label(host.props.children).includes('Blue custom row')));
  await m.press('Pressable', 'wallet');
  assert.equal(m.latest('Button', 'Pay K210').disabled, false);
  assert.equal(
    m.hosts.some((host) => label(host.props.children) === 'Approve current quote'),
    false,
  );
  assert.equal(
    m.hosts.some((host) => label(host.props.children) === 'Current quote approved'),
    false,
  );
  const submit = m.latest('Button', 'Pay K210');
  await m.run(submit);
  await m.run(submit);
  assert.equal(m.calls.length, 1);
  assert.equal(m.calls[0]?.name, PURCHASE);
  assert.deepEqual(Object.keys(m.calls[0]?.args ?? {}).sort(), [
    'expectedQuoteKey',
    'loyaltyPoints',
    'requestId',
    'shippingAddress',
    'source',
  ]);
  assert.equal(m.view().outcome, 'unknown');
  assert.equal(m.alerts.length, 0);
  assert.ok(m.hosts.some((host) => label(host.props.children) === 'Payment confirmation pending'));
  await m.unmount();
});

test('integrated current quote same-total change retires captured Pay; invalid exact points cannot dispatch', async () => {
  const m = integratedScreen();
  await m.render();
  const stalePay = m.latest('Button', 'Pay K210');
  await m.push(QUOTE, { ok: true, quote: { ...canonicalQuote, quoteKey: 'same-total-changed' } });
  await m.run(stalePay);
  assert.equal(m.calls.length, 0);
  assert.equal(m.latest('Button', 'Pay K210').disabled, false);
  for (const value of ['1.5', '1x', '9007199254740992']) {
    await m.change('Loyalty points (100 available)', value);
    assert.equal(m.view().quote, null);
    await m.run(m.latest('Button', 'Pay K0'));
  }
  assert.equal(m.calls.length, 0);
  await m.unmount();
});

test('integrated pickup selects real active matching-zone IDs and a method change retires the point and blocks Pay', async () => {
  const m = integratedScreen();
  const method = {
    _id: 'deliveryMethods|pickup',
    name: 'Pickup',
    isActive: true,
    type: 'pickup',
    zoneId: 'deliveryZones|1',
  };
  const point = { _id: 'pickupPoints|valid', name: 'Depot', isActive: true, zoneId: 'deliveryZones|1', address };
  await m.push(METHODS, [method]);
  await m.push(DISCOVERY, [{ methodId: method._id, name: 'Pickup', type: 'pickup', fee: 0 }]);
  await m.push(POINTS, [point, { ...point, _id: 'pickupPoints|foreign', name: 'Foreign', zoneId: 'deliveryZones|2' }]);
  await m.render();
  await m.press('Chip', 'Pickup • Free');
  assert.equal(m.view().quote, null);
  assert.ok(!m.hosts.some((host) => label(host.props.children).includes('Foreign')));
  await m.press('Chip', 'Depot • Street, Lusaka');
  assert.equal(m.view().quote?.quoteKey, canonicalQuote.quoteKey);
  await m.push(POINTS, []);
  assert.equal(m.view().quote, null);
  assert.equal(m.latest('Button', 'Pay K0').disabled, true);
  await m.push(POINTS, [point]);
  await m.press('Chip', 'Pickup • Free');
  assert.equal(m.view().quote, null);
  assert.equal(m.latest('Button', 'Pay K0').disabled, true);
  assert.equal(m.calls.length, 0);
  await m.unmount();
});

test('integrated pending Pay Now uses queried order instead of route selector, saved promo code and no historical loyalty', async () => {
  const order = {
    _id: 'orders|queried',
    orderNumber: 'PENDING',
    buyerId: 'users|a',
    sellerId: 'users|s',
    status: 'pending_payment',
    totalAmount: 1,
    discountAmount: 999,
    subtotal: 100,
    shippingCost: 0,
    platformFee: 0,
    sellerPayout: 100,
    items: [],
    shippingAddress: address,
    promoCode: 'SAVED',
  };
  const m = integratedScreen(order);
  await m.push(QUOTE, {
    ok: true,
    quote: { ...canonicalQuote, source: 'pending_orders', orderIds: ['orders|queried'] },
  });
  await m.render();
  await m.press('Pressable', 'Pay Now - K1');
  assert.ok(m.hosts.some((host) => label(host.props.children).includes('Updated total or discount')));
  assert.equal(m.latest('Pressable', 'Pay K210').disabled, false);
  await m.press('Pressable', 'Pay K210');
  assert.equal(m.calls.length, 1);
  assert.equal(m.calls[0]?.name, COLLECTION);
  assert.deepEqual(m.calls[0]?.args.orderIds, ['orders|queried']);
  assert.equal(m.calls[0]?.args.promoCode, 'SAVED');
  assert.ok(!('loyaltyPoints' in (m.calls[0]?.args ?? {})));
  assert.ok(!('amount' in (m.calls[0]?.args ?? {})));
  await m.push(ORDER, { ...order, status: 'paid' });
  assert.ok(m.hosts.some((host) => label(host.props.children).includes('Payment confirmation pending')));
  assert.equal(m.alerts.length, 0);
  await m.unmount();
});

test('integrated recovery precedes empty cart and OFF; stale View Orders callbacks cannot claim success after review', async () => {
  const m = integratedScreen();
  await m.render();
  await m.press('Button', 'Pay K210');
  const token = m.view().recovery;
  assert.ok(token);
  const { buildCheckoutRequestIdentity, normalizeCheckoutCollectionRequest } =
    await import('../../../../../convex/lib/providerOperationContracts');
  const identity = await buildCheckoutRequestIdentity({
    actorId: 'users|a',
    request: normalizeCheckoutCollectionRequest({
      source: 'cart',
      shippingAddress: address,
      loyaltyPoints: 0,
      requestId: token.requestId,
      expectedQuoteKey: canonicalQuote.quoteKey,
      phone: '0971234567',
      operator: 'mtn',
    }),
  });
  const proof = {
    result: 'found',
    operationId: 'paymentOperations|1',
    requestId: token.requestId,
    requestIdentity: identity,
    kind: token.kind,
    status: 'succeeded',
    providerStatus: 'successful',
    application: 'applied',
    accountingApplied: true,
    reviewNeeded: false,
    amountCents: canonicalQuote.totalAmountCents,
    quoteKey: canonicalQuote.quoteKey,
    source: 'cart',
    orderIds: ['orders|1'],
    feeCents: null,
  };
  await m.push(STATUS, proof);
  assert.equal(m.view().outcome, 'completed');
  const staleView = m.latest('Button', 'View Orders');
  await m.run(staleView);
  const alert = m.alerts[0];
  assert.ok(alert);
  const buttons = alert[2];
  assert.ok(Array.isArray(buttons));
  const onPress = buttons[0].onPress;
  assert.equal(typeof onPress, 'function');
  await m.push(CART, undefined);
  await m.push(AVAILABILITY, { paymentsEnabled: false });
  assert.ok(m.latest('Button', 'View Orders'));
  await m.push(STATUS, { ...proof, reviewNeeded: true });
  await m.run(staleView);
  await act(async () => {
    onPress();
  });
  assert.equal(m.alerts.length, 1, 'retired terminal proof cannot announce success again');
  assert.equal(m.navigation.length, 0, 'a deferred View Orders acknowledgment is bound to current proof');
  assert.equal(m.calls.length, 1);
  await m.unmount();
});

test('integrated guest hydration/merge and invalid saved promo require explicit correction before new dispatch', async () => {
  const m = integratedScreen();
  m.guest.isHydrated = false;
  await m.render();
  assert.ok(m.hosts.some((host) => host.name === 'ActivityIndicator'));
  await act(async () => {
    await m.view().submit();
  });
  assert.equal(m.calls.length, 0);
  m.guest.isHydrated = true;
  m.guest.hasPendingMerge = true;
  await m.render();
  await act(async () => {
    await m.view().submit();
  });
  assert.equal(m.calls.length, 0);
  m.guest.hasPendingMerge = false;
  m.guest.mergeFailed = true;
  await m.render();
  await m.run(m.latest('Button', 'Pay K210'));
  assert.equal(m.calls.length, 0);
  await m.unmount();
  const order = {
    _id: 'orders|queried',
    orderNumber: 'PENDING',
    buyerId: 'users|a',
    sellerId: 'users|s',
    status: 'pending_payment',
    totalAmount: 1,
    subtotal: 100,
    shippingCost: 0,
    platformFee: 0,
    sellerPayout: 100,
    items: [],
    shippingAddress: address,
    promoCode: 'INVALID',
  };
  const pending = integratedScreen(order);
  await pending.push(QUOTE, { ok: false, code: 'promo_invalid' });
  await pending.render();
  await pending.press('Pressable', 'Pay Now - K1');
  assert.equal(pending.latest('Pressable', 'Pay Awaiting quote').disabled, true);
  await pending.press('Button', 'Remove promo');
  await pending.push(QUOTE, {
    ok: true,
    quote: { ...canonicalQuote, source: 'pending_orders', orderIds: ['orders|queried'] },
  });
  await pending.press('Pressable', 'Pay K210');
  assert.equal(pending.calls[0]?.args.promoCode, undefined);
  assert.equal(pending.calls.length, 1);
  await pending.unmount();
});

for (const retire of ['signout', 'unmount', 'incompatible-status'] as const) {
  test(`integrated completion pending result cannot alert/reset after ${retire}`, async () => {
    const order = {
      _id: 'orders|queried',
      orderNumber: 'DELIVERED',
      buyerId: 'users|a',
      sellerId: 'users|s',
      status: 'delivered',
      totalAmount: 100,
      subtotal: 100,
      shippingCost: 0,
      platformFee: 0,
      sellerPayout: 100,
      items: [],
      shippingAddress: address,
    };
    const m = integratedScreen(order);
    await m.render();
    let release: (value: unknown) => void = () => {
      throw Error('not initialized');
    };
    m.handlers.set(
      getFunctionName(api.orders.updateOrderStatus),
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const complete = m.latest('Pressable', 'Complete Order');
    let work: unknown;
    await act(async () => {
      work = Reflect.apply(complete.onPress as () => unknown, undefined, []);
    });
    if (retire === 'signout') {
      m.controls.auth = { ...m.controls.auth, isSignedIn: false, user: null };
      await m.render();
    }
    if (retire === 'unmount') await m.unmount();
    if (retire === 'incompatible-status') await m.push(ORDER, { ...order, status: 'disputed' });
    await act(async () => {
      release({ accountingOutcome: 'applied' });
      await work;
    });
    assert.equal(m.alerts.length, 0);
    assert.equal(m.navigation.length, 0);
    if (retire !== 'unmount') await m.unmount();
  });
}

test('equivalent cart projection with a changed seller display name preserves the captured Pay callback', async () => {
  const m = integratedScreen();
  const preview = { sellerId: 'users|seller', sellerName: 'Old name', subtotal: 200, shippingTotal: 0, items: [] };
  await m.push(CART, [preview]);
  await m.render();
  const captured = m.latest('Button', 'Pay K210');
  await m.push(CART, [{ ...preview, sellerName: 'New display name' }]);
  await m.run(captured);
  assert.equal(m.calls.length, 1);
  assert.equal(m.calls[0]?.args.expectedQuoteKey, 'current-key');
  await m.unmount();
});

const controlOrder = {
  _id: 'orders|queried',
  orderNumber: 'CONTROL',
  buyerId: 'users|a',
  sellerId: 'users|s',
  status: 'paid',
  totalAmount: 100,
  subtotal: 100,
  shippingCost: 0,
  platformFee: 0,
  sellerPayout: 100,
  items: [],
  shippingAddress: address,
};

for (const beforeReply of [true, false]) {
  for (const transition of [
    { from: 'paid', to: 'processing', actor: 'seller', button: 'Start Processing', next: 'Mark as Shipped' },
    { from: 'shipped', to: 'delivered', actor: 'buyer', button: 'Confirm Delivery', next: 'Complete Order' },
    { from: 'delivered', to: 'completed', actor: 'buyer', button: 'Complete Order', next: null },
    { from: 'paid', to: 'cancelled', actor: 'admin', button: 'Cancel Order', next: null },
  ]) {
    test(`own ${transition.from} → ${transition.to} reactive ${beforeReply ? 'before' : 'after'} SDK reply releases loading and preserves outcome`, async () => {
      const order = { ...controlOrder, status: transition.from };
      const m = integratedScreen(order);
      if (transition.actor === 'seller') m.setUser({ _id: 'users|s' });
      if (transition.actor === 'admin') m.setUser({ role: 'admin' });
      let release: (value: unknown) => void = () => {
        throw Error('not initialized');
      };
      const mutation = transition.actor === 'admin' ? api.orders.cancelOrder : api.orders.updateOrderStatus;
      m.handlers.set(
        getFunctionName(mutation),
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      await m.render();
      let work: unknown;
      if (transition.actor === 'admin') {
        await m.press('Pressable', transition.button);
        const buttons = m.alerts[0]?.[2];
        assert.ok(Array.isArray(buttons));
        const confirm = buttons.find((button) => button.text === 'Cancel Order');
        assert.ok(confirm);
        await act(async () => {
          work = confirm.onPress();
        });
      } else {
        const control = m.latest('Pressable', transition.button);
        await act(async () => {
          work = Reflect.apply(control.onPress as () => unknown, undefined, []);
        });
      }
      if (beforeReply) await m.push(ORDER, { ...order, status: transition.to });
      await act(async () => {
        release({
          ...order,
          status: transition.to,
          ...(transition.to === 'processing' || transition.to === 'delivered' ? {} : { accountingOutcome: 'applied' }),
        });
        await work;
      });
      if (!beforeReply) await m.push(ORDER, { ...order, status: transition.to });
      await m.render();
      if (transition.next) assert.equal(m.latest('Pressable', transition.next).disabled, false);
      assert.ok(!m.hosts.some((host) => host.name === 'ActivityIndicator'), 'own loading must finish');
      assert.equal(
        m.calls.filter((call) => call.name === getFunctionName(api.delivery.addOrderTrackingEvent)).length,
        transition.to === 'processing' ? 1 : 0,
      );
      assert.equal(
        m.alerts.filter((alert) => alert[0] === (transition.actor === 'admin' ? 'Order cancelled' : 'Success')).length,
        1,
      );
      await m.unmount();
    });
  }
}

for (const retire of ['foreign-order', 'role-ABA', 'status-ABA', 'access-ABA'] as const) {
  test(`started processing cannot track or announce after ${retire}`, async () => {
    const m = integratedScreen(controlOrder);
    m.setUser({ _id: 'users|s' });
    let release: (value: unknown) => void = () => {
      throw Error('not initialized');
    };
    m.handlers.set(
      getFunctionName(api.orders.updateOrderStatus),
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await m.render();
    const start = m.latest('Pressable', 'Start Processing');
    let work: unknown;
    await act(async () => {
      work = Reflect.apply(start.onPress as () => unknown, undefined, []);
    });
    if (retire === 'foreign-order')
      await m.push(ORDER, { ...controlOrder, _id: 'orders|foreign', status: 'processing' });
    if (retire === 'status-ABA') {
      await m.push(ORDER, { ...controlOrder, status: 'disputed' });
      await m.push(ORDER, controlOrder);
    }
    if (retire === 'role-ABA') {
      m.setUser({ role: 'admin' });
      await m.render();
      m.setUser({ role: 'user' });
      await m.render();
    }
    if (retire === 'access-ABA') {
      m.controls.auth.isSignedIn = false;
      await m.render();
      m.controls.auth.isSignedIn = true;
      await m.render();
    }
    await act(async () => {
      release({ ...controlOrder, status: 'processing' });
      await work;
    });
    assert.equal(m.calls.filter((call) => call.name === getFunctionName(api.delivery.addOrderTrackingEvent)).length, 0);
    assert.equal(m.alerts.length, 0);
    await m.unmount();
  });
}

test('canonical seller slices show matching readable names independent of preview order, with readable fallback and scoped rows', async () => {
  const m = integratedScreen();
  await m.push(CART, [
    { sellerId: 'users|s2', sellerName: 'Blue Store', subtotal: 999, shippingTotal: 999, items: [] },
    { sellerId: 'users|s1', sellerName: 'Red Store', subtotal: 999, shippingTotal: 999, items: [] },
  ]);
  await m.render();
  const names = m.hosts.filter((host) => host.name === 'Text').map((host) => label(host.props.children));
  assert.ok(names.includes('Red Store') && names.includes('Blue Store'));
  assert.ok(names.indexOf('Red Store') < names.indexOf('Red custom row ×1'));
  assert.ok(names.indexOf('Red custom row ×1') < names.indexOf('Blue Store'));
  assert.ok(names.indexOf('Blue Store') < names.indexOf('Blue custom row ×1'));
  const captured = m.latest('Button', 'Pay K210');
  await m.push(CART, [{ sellerId: 'users|s2', sellerName: 'Renamed Blue', items: [] }]);
  await m.run(captured);
  assert.equal(m.calls.length, 1);
  assert.equal(m.calls[0]?.args.expectedQuoteKey, 'current-key');
  const updated = m.hosts.filter((host) => host.name === 'Text').map((host) => label(host.props.children));
  assert.ok(updated.includes('Renamed Blue') && updated.includes('Seller'));
  assert.ok(!updated.some((text) => text.includes('users|s1') || text.includes('users|s2')));
  assert.equal(m.view().quote?.totalAmountCents, 21000);
  await m.unmount();
});

for (const field of ['street', 'city', 'province', 'country', 'phone'] as const) {
  test(`incomplete saved ${field} explicitly blocks payment and provides guarded back-to-order action`, async () => {
    const order = { ...controlOrder, status: 'pending_payment', shippingAddress: { ...address, [field]: '  ' } };
    const m = integratedScreen(order);
    await m.render();
    await m.press('Pressable', 'Pay Now - K100');
    assert.equal(m.view().quote, null);
    assert.ok(m.hosts.some((host) => label(host.props.children).includes('saved delivery address is incomplete')));
    assert.ok(!m.hosts.some((host) => label(host.props.children) === 'Awaiting quote'));
    assert.equal(m.latest('Pressable', 'Payment blocked').disabled, true);
    await m.run(m.latest('Pressable', 'Payment blocked'));
    await act(async () => {
      await m.view().submit();
    });
    assert.equal(m.calls.length, 0);
    const back = m.latest('Button', 'Back to order');
    await m.run(back);
    assert.equal(m.hosts.findLast((host) => host.name === 'Modal')?.props.visible, false);
    await m.press('Pressable', 'Pay Now - K100');
    // A missing field is an untrusted runtime boundary fixture; blank strings above are schema-valid stored data.
    const missingFieldAddress = { ...address };
    Reflect.deleteProperty(missingFieldAddress, field);
    await m.push(ORDER, { ...order, shippingAddress: missingFieldAddress });
    assert.equal(m.view().quote, null);
    assert.equal(m.latest('Pressable', 'Payment blocked').disabled, true);
    assert.ok(m.hosts.some((host) => label(host.props.children).includes('saved delivery address is incomplete')));
    assert.equal(m.calls.length, 0);
    m.setUser({ role: 'admin' });
    await m.render();
    await m.run(back);
    assert.equal(
      m.hosts.findLast((host) => host.name === 'Modal')?.props.visible,
      true,
      'retired control cannot close a newer modal',
    );
    await m.unmount();
  });
}

test('requested quote loading stays distinct from incomplete address and owed recovery takes priority after address loss', async () => {
  const order = { ...controlOrder, status: 'pending_payment' };
  const m = integratedScreen(order);
  await m.push(QUOTE, undefined);
  await m.render();
  await m.press('Pressable', 'Pay Now - K100');
  assert.ok(m.hosts.some((host) => label(host.props.children) === 'Awaiting quote'));
  assert.ok(!m.hosts.some((host) => label(host.props.children).includes('saved delivery address is incomplete')));
  await m.push(QUOTE, { ok: true, quote: { ...canonicalQuote, source: 'pending_orders', orderIds: [order._id] } });
  await m.press('Pressable', 'Pay K210');
  const token = m.view().recovery;
  assert.ok(token);
  await m.push(ORDER, { ...order, shippingAddress: { ...address, phone: '' } });
  assert.equal(m.view().recovery?.requestId, token.requestId);
  assert.ok(m.latest('Button', 'Check status'));
  assert.ok(!m.hosts.some((host) => label(host.props.children).includes('saved delivery address is incomplete')));
  assert.equal(m.calls.length, 1);
  await m.unmount();
});

for (const phase of ['started-client', 'deferred-status', 'deferred-role-ABA'] as const) {
  test(`order control retirement covers ${phase}`, async () => {
    const m = integratedScreen(controlOrder);
    m.setUser({ role: 'admin' });
    await m.render();
    await m.press('Pressable', 'Cancel Order');
    const buttons = m.alerts[0]?.[2];
    assert.ok(Array.isArray(buttons));
    const confirm = buttons.find((button) => button.text === 'Cancel Order');
    assert.ok(confirm);
    if (phase === 'started-client') {
      let release: (value: unknown) => void = () => {
        throw Error('not initialized');
      };
      m.handlers.set(
        getFunctionName(api.orders.cancelOrder),
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      let work: unknown;
      await act(async () => {
        work = confirm.onPress();
      });
      const other = createFakeConvexClient({});
      await m.render(other.client);
      await act(async () => {
        release({ accountingOutcome: 'applied' });
        await work;
      });
    } else {
      if (phase === 'deferred-status') await m.push(ORDER, { ...controlOrder, status: 'processing' });
      else {
        m.setUser({ role: 'user' });
        await m.render();
        m.setUser({ role: 'admin' });
        await m.render();
      }
      await act(async () => {
        await confirm.onPress();
      });
      assert.equal(m.calls.length, 0);
    }
    assert.equal(m.alerts.length, 1, 'retired cancellation cannot announce an outcome');
    await m.unmount();
  });
}

test('old status finally cannot release loading owned by a newer cancellation', async () => {
  const order = { ...controlOrder, status: 'paid' };
  const m = integratedScreen(order);
  m.setUser({ role: 'admin', _id: 'users|s' });
  let releaseOld: (value: unknown) => void = () => {
    throw Error('not initialized');
  };
  let releaseNew: (value: unknown) => void = () => {
    throw Error('not initialized');
  };
  m.handlers.set(
    getFunctionName(api.orders.updateOrderStatus),
    () =>
      new Promise((resolve) => {
        releaseOld = resolve;
      }),
  );
  m.handlers.set(
    getFunctionName(api.orders.cancelOrder),
    () =>
      new Promise((resolve) => {
        releaseNew = resolve;
      }),
  );
  await m.render();
  const complete = m.latest('Pressable', 'Start Processing');
  let oldWork: unknown;
  await act(async () => {
    oldWork = Reflect.apply(complete.onPress as () => unknown, undefined, []);
  });
  await m.press('Pressable', 'Cancel Order');
  const buttons = m.alerts[0]?.[2];
  assert.ok(Array.isArray(buttons));
  const confirm = buttons.find((button) => button.text === 'Cancel Order');
  assert.ok(confirm);
  let newWork: unknown;
  await act(async () => {
    newWork = confirm.onPress();
  });
  await act(async () => {
    releaseOld({ accountingOutcome: 'applied' });
    await oldWork;
  });
  await m.render();
  assert.ok(
    m.hosts.some((host) => host.name === 'ActivityIndicator'),
    'new work still owns the loading indicator',
  );
  assert.equal(m.alerts.length, 1);
  await act(async () => {
    releaseNew({ accountingOutcome: 'review' });
    await newWork;
  });
  await m.render();
  assert.ok(!m.hosts.some((host) => host.name === 'ActivityIndicator'));
  assert.equal(m.alerts[1]?.[0], 'Accounting review pending');
  assert.ok(!m.alerts.some((alert) => alert[0] === 'Success' || alert[0] === 'Order cancelled'));
  await m.unmount();
});

for (const status of ['paid', 'shipped'] as const) {
  test(`registered ${status} transition reaches actual React next control with query before SDK reply`, async () => {
    const actor = status === 'paid' ? 's' : 'a';
    const order = { ...controlOrder, status };
    const db = createDb({
      users: [{ _id: `users|${actor}`, clerkId: 'clerk_a', role: 'user', isBanned: false }],
      orders: [order],
      notifications: [],
      behaviorEvents: [],
    });
    const m = integratedScreen(order);
    m.setUser({ _id: `users|${actor}` });
    m.handlers.set(getFunctionName(api.orders.updateOrderStatus), async (args) => {
      const result = await invokeFakeFunction(ordersModule.updateOrderStatus, createCtx(db, 'clerk_a'), args);
      await m.push(ORDER, { ...db.tables.orders?.[0] });
      return result;
    });
    await m.render();
    await m.press('Pressable', status === 'paid' ? 'Start Processing' : 'Confirm Delivery');
    await m.render();
    assert.equal(db.tables.orders?.[0]?.status, status === 'paid' ? 'processing' : 'delivered');
    assert.equal(m.latest('Pressable', status === 'paid' ? 'Mark as Shipped' : 'Complete Order').disabled, false);
    assert.equal(m.alerts[0]?.[0], 'Success');
    assert.equal(
      m.calls.filter((call) => call.name === getFunctionName(api.delivery.addOrderTrackingEvent)).length,
      status === 'paid' ? 1 : 0,
    );
    await m.unmount();
  });
}

function backendFixture(): ReturnType<typeof createDb> {
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

// Genuine registered producers supply the quote, wallet and cart; only SDK/native boundaries are controlled.
test('exactly funded 29-cent cart enables Pay and one registered aggregate wallet purchase', async () => {
  const db = backendFixture();
  db.tables.products = [db.tables.products[0]];
  db.tables.products[0].price = 0.27;
  db.tables.cartItems = [db.tables.cartItems[0]];
  db.tables.wallets[0].balance = 0.29;
  const ctx = createCtx(db, 'buyer');
  const selectors = { source: 'cart', shippingAddress: address, loyaltyPoints: 0 };
  const produced = await invokeFakeFunction(checkoutQuoteModule.quoteCheckout, ctx, selectors);
  assertRegisteredRecord(produced);
  assertRegisteredRecord(produced.quote);
  assert.equal(produced.ok, true);
  assert.equal(produced.quote.subtotalCents, 27);
  assert.equal(produced.quote.platformFeeCents, 2);
  assert.equal(produced.quote.totalAmountCents, 29);
  const balance = await invokeFakeFunction(walletModule.getWalletBalance, ctx, {});
  assertRegisteredRecord(balance);
  assert.equal(balance.balance, 0.29);
  const cart = await invokeFakeFunction(cartModule.getCartBySeller, ctx, {});
  const m = integratedScreen();
  m.controls.auth.clerkUser = { id: 'buyer' };
  m.setUser({ _id: 'users|buyer', clerkId: 'buyer' });
  let purchase: Promise<unknown> | undefined;
  m.handlers.set(PURCHASE, (args) => {
    purchase = invokeFakeFunction(paymentOperationsModule.purchaseWithWallet, ctx, args);
    return purchase;
  });
  try {
    await m.push(CART, cart);
    await m.push(QUOTE, produced);
    await m.push(getFunctionName(api.wallet.getWalletBalance), balance);
    await m.render();
    await m.press('Pressable', 'wallet');
    assert.equal(m.latest('Button', 'Pay K0.29').disabled, false);
    await m.press('Button', 'Pay K0.29');
    assert.ok(purchase, 'enabled UI must start the registered purchase');
    await act(async () => {
      const result = await purchase;
      assert.ok(typeof result === 'object' && result !== null && 'ok' in result);
      assert.equal(result.ok, true, JSON.stringify(result));
    });
    assert.equal(m.calls.length, 1);
    assert.equal(m.calls[0].name, PURCHASE);
    assert.deepEqual(m.calls[0].args, {
      ...selectors,
      expectedQuoteKey: produced.quote.quoteKey,
      requestId: 'checkout_11111111-2222-4333-8444-555555555555',
    });
    assert.equal(m.view().error, null, String(m.view().error));
    assert.equal(db.tables.wallets[0].balance, 0);
    assert.equal(db.tables.wallets[0].totalSpent, 0.29);
    assert.equal(db.tables.orders.length, 1);
    assert.equal(db.tables.paymentOperations.length, 1);
    assert.equal(db.tables.paymentOperations[0].totalAmountCents, 29);
    assert.equal(db.tables.cartItems.length, 0);
  } finally {
    await m.unmount();
  }
});

for (const [reason, wallet] of [
  ['one-cent-short', { hasWallet: true, balance: 0.28, isFrozen: false }],
  ['unknown', undefined],
  ['missing-wallet', { hasWallet: false, balance: 500, isFrozen: false }],
  ['frozen', { hasWallet: true, balance: 500, isFrozen: true }],
  ['missing-balance', { hasWallet: true, isFrozen: false }],
  ...[NaN, Infinity, -1, 0.291, 0.30000000000000004, 90071992547410].map(
    (balance) => [`invalid-${balance}`, { hasWallet: true, balance, isFrozen: false }] as const,
  ),
] as const) {
  test(`wallet ${reason} cannot pay or dispatch the current 29-cent checkout`, async () => {
    const db = backendFixture();
    db.tables.products = [db.tables.products[0]];
    db.tables.products[0].price = 0.27;
    db.tables.cartItems = [db.tables.cartItems[0]];
    const ctx = createCtx(db, 'buyer');
    const produced = await invokeFakeFunction(checkoutQuoteModule.quoteCheckout, ctx, {
      source: 'cart',
      shippingAddress: address,
      loyaltyPoints: 0,
    });
    assertRegisteredRecord(produced);
    assertRegisteredRecord(produced.quote);
    assert.equal(produced.ok, true);
    assert.equal(produced.quote.totalAmountCents, 29);
    const cart = await invokeFakeFunction(cartModule.getCartBySeller, ctx, {});
    const m = integratedScreen();
    m.controls.auth.clerkUser = { id: 'buyer' };
    m.setUser({ _id: 'users|buyer', clerkId: 'buyer' });
    try {
      await m.push(CART, cart);
      await m.push(QUOTE, produced);
      await m.push(getFunctionName(api.wallet.getWalletBalance), wallet);
      await m.render();
      await m.press('Pressable', 'wallet');
      assert.equal(m.latest('Button', 'Pay K0.29').disabled, true);
      assert.equal(m.calls.length, 0);
    } finally {
      await m.unmount();
    }
  });
}

// Registered invocation intentionally returns unknown; validate the object shape before reading producer fields.
function assertRegisteredRecord(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
}

test('integrated Mobile Money checkout pays the displayed quote without a separate approval step', async () => {
  const m = integratedScreen();
  await m.render();
  assert.equal(m.latest('Button', 'Pay K210').disabled, false);
  await m.press('Button', 'Pay K210');
  assert.equal(m.calls.length, 1);
  assert.equal(m.calls[0]?.name, COLLECTION);
  assert.equal(m.calls[0]?.args.expectedQuoteKey, 'current-key');
  assert.equal(m.view().outcome, 'unknown');
  await m.unmount();
});
