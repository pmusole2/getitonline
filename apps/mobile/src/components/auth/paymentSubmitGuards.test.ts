import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

import React, { act, createElement, Suspense, isValidElement, type ReactNode } from 'react';
import * as JsxRuntime from 'react/jsx-runtime';
import * as ConvexReact from 'convex/react';
import { anyApi, getFunctionName } from 'convex/server';

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

// Runs the real order and wallet screens with payment availability controlled through the Convex query result.
// Payment and wallet service functions are fakes that record each call, so a test can assert that a blocked
// submit reached none of them. Both render-time and handler-time checks are exercised: a submit handler captured while
// payments were on is pressed after availability turns off, the way a stale tap would reach it.
const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const file = (path: string) => resolve(root, path);
const availabilityKey = 'appConfig.getPaymentAvailability';
const unavailableMessage = 'Payments are temporarily unavailable';
const user = { _id: 'user_1', clerkId: 'clerk_1', role: 'user', isBanned: false, email: 'ada@example.com', phone: '' };
const order = {
  _id: 'order_1',
  orderNumber: 'ORD-1',
  buyerId: 'user_1',
  sellerId: 'seller_2',
  status: 'pending_payment',
  totalAmount: 100,
  items: [],
  shippingAddress: { street: 'Street', city: 'Lusaka', province: 'Lusaka', country: 'Zambia', phone: '0971234567' },
};

type Node = Parameters<typeof findNodes>[0];

// The availability states that must all block payment entry: the switch is off, the result is still loading, the
// query failed, and the result is malformed.
const unavailableStates: readonly (readonly [string, unknown])[] = [
  ['the switch is off', { paymentsEnabled: false }],
  ['the availability is still loading', undefined],
  ['the availability query failed', new Error('server unavailable')],
  ['the availability result is malformed', { paymentsEnabled: 'true' }],
];

function orderPayNowPressables(tree: Node) {
  return findNodes(
    tree,
    (node) => typeof node.props.onPress === 'function' && textOf(node.children).startsWith('Pay Now'),
  );
}

// The modal's submit control: a pressable whose text starts with "Pay" but is not the "Pay Now" entry point.
function orderPaySubmit(tree: Node) {
  return findNodes(
    tree,
    (node) =>
      typeof node.props.onPress === 'function' &&
      textOf(node.children).startsWith('Pay ') &&
      !textOf(node.children).startsWith('Pay Now'),
  );
}

// The payment modal is the paper Modal whose content is the payment sheet. The harness renders its children whether or
// not it is visible, so the modal's own visible prop is what shows whether it was opened.
function paymentModalVisible(tree: Node): boolean | undefined {
  const [modal] = findNodes(
    tree,
    (node) => node.name === 'Modal' && textOf(node.children).includes('Complete Payment'),
  );
  assert.ok(modal, 'expected the payment modal');
  return modal.props.visible === true;
}

function pressFirst(matches: readonly { readonly props: Props }[]): void {
  const handler = matches[0]?.props.onPress;
  assert.equal(typeof handler, 'function', 'expected a pressable control');
  Reflect.apply(handler as () => unknown, undefined, []);
}

class PaymentFakes {
  readonly calls: string[] = [];
  readonly submit = async () => {
    this.calls.push('initiateCheckoutCollection');
  };
}

function orderSetup(availability: unknown) {
  const controls = createControls();
  controls.auth = {
    isLoading: false,
    isSignedIn: true,
    authSyncError: null,
    clerkUser: { id: 'clerk_1' },
    user: { ...user, phone: '0971234567' },
    retryUserSync: () => undefined,
  };
  controls.queries = {
    [availabilityKey]: availability,
    'orders.getOrder': fixture(order),
    'escrow.getEscrowByOrder': null,
    'disputes.getDisputeByOrder': null,
    'delivery.getOrderTrackingEvents': [],
    'delivery.getOrderReturnRequests': [],
    'reviews.canReviewOrder': false,
    'reviews.getReviewByOrder': null,
    'delivery.listDeliveryMethods': [],
    'delivery.calculateDeliveryQuote': [],
  };
  const fakes = new PaymentFakes();
  const harness = createHarness({
    controls,
    // Layout effects run on each commit, as they do in the app. The availability ref is published in one.
    effects: true,
    files: {
      [file('apps/mobile/src/context/AuthProvider.tsx')]: withFallback({ useAppAuth: () => controls.auth }),
      [file('apps/mobile/src/components/auth/useAccountAccess.ts')]: withFallback({
        useAccountAccess: () => ({ status: 'ready' }),
      }),
      [file('apps/mobile/src/hooks/useImageUpload.ts')]: withFallback({ useImageUpload: () => ({ images: [] }) }),
      [file('apps/mobile/src/hooks/usePayment.ts')]: withFallback({
        usePayment: () => ({
          working: false,
          ready: true,
          recovery: null,
          sessionKey: 1,
          isCurrent: () => true,
          quote: { totalAmountCents: 10000, lines: [], delivery: { name: 'Seller delivery' } },
          submit: fakes.submit,
        }),
        detectProvider: () => 'mtn',
        formatZambianPhoneNumber: (value: unknown) => value,
        getProviderColor: () => '#000000',
      }),
    },
    packages: {
      '@gettitonline/shared': withFallback({ resolvePaymentAvailability }),
    },
  });
  const screen = harness.load(file('apps/mobile/src/screens/orders/OrderDetailScreen.tsx')).default as (
    props: Props,
  ) => unknown;
  return {
    fakes,
    controls,
    render: () => harness.render(screen, { route: { params: { orderId: 'order_1' } }, navigation: {} }),
  };
}

function walletSetup(availability: unknown) {
  const controls = createControls();
  controls.auth = { isLoading: false, isSignedIn: true, authSyncError: null, user };
  controls.queries = { [availabilityKey]: availability };
  const calls: string[] = [];
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
    balance: { balance: 100, pendingBalance: 0, isFrozen: false },
    activity: null,
    transactions: [],
    isLoading: false,
    error: null,
    refreshBalance: async () => undefined,
    refreshActivity: async () => undefined,
    refreshTransactions: async () => undefined,
    withdrawToMobileMoney: async () => {
      calls.push('withdrawToMobileMoney');
      return {};
    },
    withdrawToBank: async () => {
      calls.push('withdrawToBank');
      return {};
    },
    topUp: async () => {
      calls.push('topUp');
      return { message: 'Top up started', checkoutUrl: null };
    },
    ensureWallet: async () => undefined,
    clearError: () => undefined,
  };
  const harness = createHarness({
    controls,
    // Layout effects run on each commit, as they do in the app. The availability ref is published in one.
    effects: true,
    files: {
      [file('apps/mobile/src/context/AuthProvider.tsx')]: withFallback({ useAppAuth: () => controls.auth }),
      [file('apps/mobile/src/hooks/useWallet.ts')]: withFallback({ useWallet: () => wallet }),
    },
    packages: {
      '@gettitonline/shared': withFallback({ resolvePaymentAvailability }),
    },
  });
  const screen = harness.load(file('apps/mobile/src/screens/wallet/WalletScreen.tsx')).default as (
    props: Props,
  ) => unknown;
  return {
    calls,
    controls,
    render: () => harness.render(screen, { navigation: { navigate: () => undefined } }),
  };
}

function walletSubmit(tree: Node, label: string) {
  return findNodes(
    tree,
    (node) =>
      node.name.endsWith('Button') && typeof node.props.onPress === 'function' && textOf(node.children) === label,
  );
}

function typeInto(tree: Node, label: string, value: string) {
  const [input] = findNodes(
    tree,
    (node) => node.props.label === label && typeof node.props.onChangeText === 'function',
  );
  assert.ok(input, `expected an input labelled ${label}`);
  Reflect.apply(input.props.onChangeText as (text: string) => unknown, undefined, [value]);
}

test('the order Pay Now control and its payment submit are unavailable and make no payment call when payments are off', async () => {
  for (const [label, availability] of unavailableStates) {
    const setup = orderSetup(availability);
    const tree = setup.render().tree;
    assert.ok(textOf(tree).includes(unavailableMessage), `${label}: ${textOf(tree)}`);
    pressFirst(orderPayNowPressables(tree));
    const afterOpen = setup.render().tree;
    assert.equal(paymentModalVisible(afterOpen), false, `${label}: the payment modal must not open`);
    pressFirst(orderPaySubmit(afterOpen));
    assert.deepEqual(setup.fakes.calls, [], label);
  }
});

test('the order payment submit reaches accepted collection with one Pay tap when payments are on', async () => {
  const setup = orderSetup({ paymentsEnabled: true });
  const tree = setup.render().tree;
  assert.ok(!textOf(tree).includes(unavailableMessage), textOf(tree));
  assert.equal(paymentModalVisible(tree), false);
  pressFirst(orderPayNowPressables(tree));
  assert.equal(paymentModalVisible(setup.render().tree), true, 'Pay Now opens the payment modal when payments are on');
  pressFirst(orderPaySubmit(setup.render().tree));
  await new Promise<void>((resolveTick) => setImmediate(resolveTick));
  assert.deepEqual(setup.fakes.calls, ['initiateCheckoutCollection']);
});

test('an order payment submit captured while payments were on does nothing after availability turns off', async () => {
  const setup = orderSetup({ paymentsEnabled: true });
  const staleSubmit = orderPaySubmit(setup.render().tree);
  assert.equal(staleSubmit.length > 0, true);

  setup.controls.queries[availabilityKey] = { paymentsEnabled: false };
  const afterFlip = setup.render().tree;
  assert.ok(textOf(afterFlip).includes(unavailableMessage), textOf(afterFlip));
  pressFirst(staleSubmit);
  await new Promise<void>((resolveTick) => setImmediate(resolveTick));
  assert.deepEqual(setup.fakes.calls, []);
});

test('wallet top-up and withdraw submits make no service call while payments are unavailable', async () => {
  for (const [label, availability] of unavailableStates) {
    const setup = walletSetup(availability);
    const tree = setup.render().tree;
    assert.ok(textOf(tree).includes(unavailableMessage), label);
    typeInto(tree, 'Amount (ZMW)', '10');
    typeInto(tree, 'Phone Number', '0971234567');
    const topUpSubmit = walletSubmit(setup.render().tree, 'Top Up');
    const withdrawSubmit = walletSubmit(setup.render().tree, 'Withdraw');
    assert.ok(topUpSubmit.length > 0 && withdrawSubmit.length > 0);
    pressFirst(topUpSubmit);
    pressFirst(withdrawSubmit);
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    assert.deepEqual(setup.calls, [], label);
  }
});

test('a wallet submit captured while payments were on does nothing after availability turns off', async () => {
  const setup = walletSetup({ paymentsEnabled: true });
  typeInto(setup.render().tree, 'Amount (ZMW)', '10');
  typeInto(setup.render().tree, 'Phone Number', '0971234567');
  const staleTopUp = walletSubmit(setup.render().tree, 'Top Up');
  const staleWithdraw = walletSubmit(setup.render().tree, 'Withdraw');
  assert.equal(staleTopUp.length > 0 && staleWithdraw.length > 0, true);

  setup.controls.queries[availabilityKey] = { paymentsEnabled: false };
  const afterFlip = setup.render().tree;
  assert.ok(textOf(afterFlip).includes(unavailableMessage), textOf(afterFlip));
  pressFirst(staleTopUp);
  pressFirst(staleWithdraw);
  await new Promise<void>((resolveTick) => setImmediate(resolveTick));
  assert.deepEqual(setup.calls, []);
});

test('wallet top-up and withdraw submits reach the wallet service when payments are on', async () => {
  const setup = walletSetup({ paymentsEnabled: true });
  typeInto(setup.render().tree, 'Amount (ZMW)', '10');
  typeInto(setup.render().tree, 'Phone Number', '0971234567');
  pressFirst(walletSubmit(setup.render().tree, 'Top Up'));
  await new Promise<void>((resolveTick) => setImmediate(resolveTick));
  pressFirst(
    findNodes(
      setup.render().tree,
      (node) => node.name.endsWith('Button') && textOf(node.children).startsWith('Review Synthetic Resolved'),
    ),
  );
  pressFirst(walletSubmit(setup.render().tree, 'Withdraw'));
  await new Promise<void>((resolveTick) => setImmediate(resolveTick));
  assert.deepEqual(setup.calls, ['topUp', 'withdrawToMobileMoney']);
});

// Real React mounts a payment screen with real usePaymentAvailability and real convex/react. Stand-in host components
// record each element's latest props and render their children, so a test presses controls as a user does. The gradient
// can be made to suspend, which keeps a render React started from being committed.
type Stand = Props & { readonly children?: ReactNode };

interface Recorded {
  readonly name: string;
  readonly props: Stand;
}

// The text a React node shows, so a control can be found by its label.
function labelOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(labelOf).join('');
  }
  if (isValidElement<{ readonly children?: ReactNode }>(node)) {
    return labelOf(node.props.children);
  }
  return '';
}

function Passthrough({ children }: { readonly children?: ReactNode }): ReactNode {
  return children ?? null;
}

function nothing(): null {
  return null;
}

function handlerOf(props: Stand, key: string): (...args: unknown[]) => void {
  const handler = props[key];
  if (typeof handler !== 'function') {
    throw new Error(`${key} is not a handler`);
  }
  return (...args: unknown[]) => {
    Reflect.apply(handler, undefined, args);
  };
}

interface RealScreen {
  readonly log: Recorded[];
  readonly suspension: { active: boolean; suspended: number };
  readonly convex: ReturnType<typeof createFakeConvexClient>;
  // Renders the screen under Suspense, so a suspended render shows the fallback and is not committed.
  render(): Promise<void>;
  unmount(): Promise<void>;
  // The latest recorded element of a name whose text is the label.
  latest(name: string, label: string): Stand;
  // Presses the handler of a recorded element, inside act.
  press(entry: Stand): Promise<void>;
  // Types into the input with the label.
  typeInto(label: string, value: string): Promise<void>;
}

function mountRealScreen(options: {
  readonly screenFile: string;
  readonly packages?: Props;
  readonly files: Record<string, Props>;
  readonly controls: ReturnType<typeof createControls>;
  // Route params for a screen that reads its record id from the route.
  readonly route?: Props;
}): RealScreen {
  const convex = createFakeConvexClient();
  const log: Recorded[] = [];
  const suspension = { active: false, suspended: 0 };

  function host(name: string) {
    return function Host(props: Stand): ReactNode {
      log.push({ name, props });
      return props.children ?? null;
    };
  }
  function Gradient(props: Stand): ReactNode {
    log.push({ name: 'LinearGradient', props });
    if (suspension.active) {
      suspension.suspended += 1;
      throw new Promise<void>(() => undefined);
    }
    return props.children ?? null;
  }
  function Modal(props: Stand): ReactNode {
    log.push({ name: 'Modal', props });
    return props.visible === true ? (props.children ?? null) : null;
  }
  const Animated = Object.assign(Passthrough, { View: Passthrough });
  const TextInput = Object.assign(host('TextInput'), { Affix: nothing });

  const harness = createHarness({
    controls: options.controls,
    // Layout effects run on each commit, as they do in the app. The availability ref is published in one.
    effects: true,
    convexApi: { api: anyApi },
    files: {
      [file('apps/mobile/src/context/AuthProvider.tsx')]: withFallback({ useAppAuth: () => options.controls.auth }),
      [file('apps/mobile/src/components/ui/Header.tsx')]: withFallback({ StackHeader: nothing }),
      [file('apps/mobile/src/theme/index.ts')]: withFallback({ formatPrice: (value: unknown) => `K${String(value)}` }),
      ...options.files,
    },
    packages: {
      react: React,
      'react/jsx-runtime': JsxRuntime,
      'convex/react': ConvexReact,
      '@gettitonline/shared': withFallback({ resolvePaymentAvailability }),
      'react-native': withFallback({
        ActivityIndicator: nothing,
        Alert: withFallback({ alert: () => undefined }),
        Image: nothing,
        Pressable: host('Pressable'),
        RefreshControl: nothing,
        ScrollView: Passthrough,
        StyleSheet: withFallback({ create: (styles: Props) => styles }),
        View: Passthrough,
      }),
      'react-native-paper': withFallback({
        Button: host('Button'),
        Chip: host('Chip'),
        Divider: nothing,
        Modal,
        Portal: Passthrough,
        SegmentedButtons: host('SegmentedButtons'),
        Surface: Passthrough,
        Text: Passthrough,
        TextInput,
        useTheme: () => withFallback({ colors: withFallback({}) }),
      }),
      'expo-linear-gradient': withFallback({ LinearGradient: Gradient }),
      'react-native-reanimated': withFallback({
        default: Animated,
        FadeInDown: withFallback({}),
        FadeInUp: withFallback({}),
      }),
      'react-native-vector-icons/MaterialCommunityIcons': withFallback({ default: nothing }),
      moti: withFallback({ MotiView: Passthrough }),
      ...options.packages,
    },
  });
  const Screen = harness.load(options.screenFile).default as (props: Props) => ReactNode;
  const mounted = mountUnderConvex(convex);

  return {
    log,
    suspension,
    convex,
    render: () =>
      mounted.render(
        createElement(
          Suspense,
          { fallback: null },
          createElement(Screen, { navigation: { navigate: nothing }, route: options.route ?? { params: {} } }),
        ),
      ),
    unmount: () => mounted.unmount(),
    latest(name, label) {
      const match = log.findLast((entry) => entry.name === name && labelOf(entry.props.children).trim() === label);
      if (match === undefined) {
        throw new Error(`no ${name} labelled ${label}`);
      }
      return match.props;
    },
    async press(entry) {
      await act(async () => {
        handlerOf(entry, 'onPress')();
      });
    },
    async typeInto(label, value) {
      const input = log.findLast((entry) => entry.name === 'TextInput' && entry.props.label === label);
      if (input === undefined) {
        throw new Error(`no input labelled ${label}`);
      }
      await act(async () => {
        handlerOf(input.props, 'onChangeText')(value);
      });
    },
  };
}

const realPaymentsKey = getFunctionName(anyApi.appConfig.getPaymentAvailability);

test('real React: a wallet top-up submit captured while payments were on makes no service call after an abandoned render turned them on', async () => {
  const topUpCalls: unknown[][] = [];
  const controls = createControls();
  controls.auth = { isLoading: false, isSignedIn: true, authSyncError: null, user, retryUserSync: () => undefined };
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
    balance: {
      balance: 500,
      pendingBalance: 0,
      totalEarned: 500,
      totalWithdrawn: 0,
      totalSpent: 0,
      hasWallet: true,
      isActive: true,
      isFrozen: false,
    },
    activity: null,
    transactions: [],
    isLoading: false,
    error: null,
    refreshBalance: () => Promise.resolve(),
    refreshActivity: () => Promise.resolve(),
    refreshTransactions: () => Promise.resolve(),
    withdrawToMobileMoney: () => Promise.resolve(),
    withdrawToBank: () => Promise.resolve(),
    topUp: (...args: unknown[]) => {
      topUpCalls.push(args);
      return Promise.resolve({ message: 'Top-up started' });
    },
    payWithWallet: () => Promise.resolve(),
    canPayWithWallet: () => Promise.resolve({ canPay: true }),
    ensureWallet: () => Promise.resolve(),
    clearError: () => undefined,
  };
  const screen = mountRealScreen({
    screenFile: file('apps/mobile/src/screens/wallet/WalletScreen.tsx'),
    controls,
    files: {
      [file('apps/mobile/src/hooks/useWallet.ts')]: withFallback({ useWallet: () => wallet }),
      [file('apps/mobile/src/services/wallet.ts')]: withFallback({
        formatWalletAmount: (value: unknown) => String(value),
        getTransactionColor: () => '#000000',
        getTransactionIcon: () => 'swap-horizontal',
        getTransactionSourceLabel: () => '',
      }),
    },
  });

  // Payments are on, the top-up sheet is open, and an amount is entered: the submit the user sees is enabled.
  await deliver(screen.convex, realPaymentsKey, { paymentsEnabled: true });
  await screen.render();
  await screen.press(screen.latest('Pressable', 'Top Up'));
  await screen.typeInto('Amount (ZMW)', '50');
  const submitWhileOn = screen.latest('Button', 'Top Up');
  assert.equal(submitWhileOn.disabled, false, 'the committed submit is enabled while payments are on');
  const retainedSubmit = handlerOf(submitWhileOn, 'onPress');

  // Payments turn off and that render commits, so the committed submit is disabled.
  await deliver(screen.convex, realPaymentsKey, { paymentsEnabled: false });
  assert.equal(
    screen.latest('Button', 'Top Up').disabled,
    true,
    'the committed submit is disabled once payments are off',
  );

  // A speculative render reads payments on, but it suspends before it commits.
  screen.suspension.active = true;
  await deliver(screen.convex, realPaymentsKey, { paymentsEnabled: true });
  assert.ok(screen.suspension.suspended > 0, 'the speculative render ran and suspended');

  // The submit captured while payments were on is pressed now. The committed screen has payments off.
  await act(async () => {
    retainedSubmit();
  });
  assert.deepEqual(topUpCalls, [], 'no top-up reaches the wallet service after payments were turned off');
  screen.suspension.active = false;
  await screen.unmount();
});

test('real React: an order payment submit captured while payments were on makes no service call after an abandoned render turned them on', async () => {
  const collectionCalls: unknown[][] = [];
  const controls = createControls();
  controls.auth = {
    isLoading: false,
    isSignedIn: true,
    authSyncError: null,
    clerkUser: { id: 'clerk_1' },
    user: { ...user, phone: '0971234567' },
    retryUserSync: () => undefined,
  };
  const screen = mountRealScreen({
    screenFile: file('apps/mobile/src/screens/orders/OrderDetailScreen.tsx'),
    controls,
    packages: { 'convex/react': { ...ConvexReact, useConvexAuth: () => controls.convexAuth } },
    route: { params: { orderId: 'order_1' } },
    files: {
      [file('apps/mobile/src/components/auth/useAccountAccess.ts')]: withFallback({
        useAccountAccess: () => ({ status: 'ready' }),
      }),
      [file('apps/mobile/src/hooks/useImageUpload.ts')]: withFallback({ useImageUpload: () => ({ images: [] }) }),
      [file('apps/mobile/src/hooks/usePayment.ts')]: withFallback({
        usePayment: () => {
          return {
            working: false,
            ready: true,
            recovery: null,
            sessionKey: 1,
            isCurrent: () => true,
            quote: { totalAmountCents: 10000, lines: [], delivery: { name: 'Seller delivery' } },
            submit: (...args: unknown[]) => {
              collectionCalls.push(args);
              return Promise.resolve();
            },
          };
        },
        detectProvider: () => 'mtn',
        formatZambianPhoneNumber: (value: unknown) => value,
        getProviderColor: () => '#000000',
      }),
    },
  });
  await deliver(screen.convex, realPaymentsKey, { paymentsEnabled: true });
  await deliver(screen.convex, getFunctionName(anyApi.orders.getOrder), order);
  await deliver(screen.convex, getFunctionName(anyApi.escrow.getEscrowByOrder), null);
  await deliver(screen.convex, getFunctionName(anyApi.disputes.getDisputeByOrder), null);
  await deliver(screen.convex, getFunctionName(anyApi.delivery.getOrderTrackingEvents), []);
  await deliver(screen.convex, getFunctionName(anyApi.delivery.getOrderReturnRequests), []);
  await deliver(screen.convex, getFunctionName(anyApi.reviews.canReviewOrder), false);
  await deliver(screen.convex, getFunctionName(anyApi.reviews.getReviewByOrder), null);
  await screen.render();

  await screen.press(screen.latest('Pressable', 'Pay Now - K100'));
  const submitWhileOn = screen.latest('Pressable', 'Pay K100');
  assert.equal(submitWhileOn.disabled, false, 'the committed submit is enabled while payments are on');
  const retainedSubmit = handlerOf(submitWhileOn, 'onPress');

  await deliver(screen.convex, realPaymentsKey, { paymentsEnabled: false });
  assert.equal(
    screen.latest('Pressable', 'Pay K100').disabled,
    true,
    'the committed submit is disabled once payments are off',
  );

  screen.suspension.active = true;
  await deliver(screen.convex, realPaymentsKey, { paymentsEnabled: true });
  assert.ok(screen.suspension.suspended > 0, 'the speculative render ran and suspended');

  await act(async () => {
    retainedSubmit();
  });
  assert.deepEqual(collectionCalls, [], 'no collection reaches the accepted boundary after payments were turned off');
  screen.suspension.active = false;
  await screen.unmount();
});
