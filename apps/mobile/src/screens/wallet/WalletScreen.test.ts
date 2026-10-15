import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

import React, { act, createElement, isValidElement, type ReactNode } from 'react';
import * as JsxRuntime from 'react/jsx-runtime';
import * as ConvexReact from 'convex/react';
import { getFunctionName } from 'convex/server';

import * as shared from '../../../../../packages/shared/src/index';
import { api } from '../../../../../convex/_generated/api';
import { createFakeConvexClient, deliver, mountUnderConvex } from '../../../../../tests/support/realReactRender';
import type { WalletOperations } from '../../hooks/useWalletOperations';
import { resolvePaymentAvailability } from '../../../../../packages/shared/src/utils/clientGate';
import {
  createControls,
  createHarness,
  findNodes,
  textOf,
  withFallback,
  type Props,
} from '../../../../../tests/support/componentHarness';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const file = (path: string): string => resolve(root, path);

test('actual wallet screen excludes card initiation and never announces funds success on an initiation reply', async () => {
  const controls = createControls();
  controls.auth = {
    isLoading: false,
    isSignedIn: true,
    authSyncError: null,
    user: { _id: 'users|a', clerkId: 'clerk_a', role: 'user', isBanned: false },
    clerkUser: { id: 'clerk_a' },
  };
  controls.queries = { 'appConfig.getPaymentAvailability': { paymentsEnabled: true } };
  const calls: unknown[][] = [];
  const alerts: unknown[][] = [];
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
    balance: { balance: 100, pendingBalance: 0 },
    transactions: [],
    refreshBalance: async () => undefined,
    refreshActivity: async () => undefined,
    refreshTransactions: async () => undefined,
    ensureWallet: async () => undefined,
    clearError: () => undefined,
    topUp: async (...args: unknown[]) => {
      calls.push(args);
      return { ok: true, status: 'pending', message: 'Initiated' };
    },
  };
  const harness = createHarness({
    controls,
    effects: true,
    files: {
      [file('apps/mobile/src/context/AuthProvider.tsx')]: withFallback({ useAppAuth: () => controls.auth }),
      [file('apps/mobile/src/hooks/useWallet.ts')]: withFallback({ useWallet: () => wallet }),
    },
    packages: {
      '@gettitonline/shared': withFallback({ resolvePaymentAvailability }),
      'react-native': withFallback({
        Alert: {
          alert: (...args: unknown[]) => {
            alerts.push(args);
          },
        },
      }),
    },
  });
  const Screen = harness.load(file('apps/mobile/src/screens/wallet/WalletScreen.tsx')).default;
  const render = () => harness.render(Screen, { navigation: {} });
  const change = (label: string, value: string): void => {
    const [input] = findNodes(render().tree, (node) => node.props.label === label);
    assert.ok(input);
    Reflect.apply(input.props.onChangeText as (value: string) => void, undefined, [value]);
  };
  change('Amount (ZMW)', '10.00');
  change('Phone Number', '0971234567');
  const [submit] = findNodes(
    render().tree,
    (node) => node.name.endsWith('Button') && textOf(node.children) === 'Top Up',
  );
  assert.ok(submit);
  await Reflect.apply(submit.props.onPress as () => Promise<void>, undefined, []);
  assert.equal(calls.length, 1, 'a valid current handler reached initiation');
  assert.equal(
    alerts.some((args) => args[0] === 'Success'),
    false,
  );
  assert.equal(
    findNodes(
      render().tree,
      (node) =>
        Array.isArray(node.props.buttons) && node.props.buttons.some((button: Props) => button.value === 'card'),
    ).length,
    0,
    'no card selector exists',
  );
});

const AVAILABILITY = getFunctionName(api.appConfig.getPaymentAvailability);
const ACCOUNTS = getFunctionName(api.providerOperations.listPaymentAccounts);
const STATUS = getFunctionName(api.paymentReconciliation.getStatus);
const TOPUP = getFunctionName(api.providerOperations.initiateTopUpCollection);
const WITHDRAW = getFunctionName(api.providerOperations.initiateWithdrawal);
const REGISTER = getFunctionName(api.providerOperations.registerPaymentAccount);
const BANKS = getFunctionName(api.providerOperations.listBanks);
const REFRESH = getFunctionName(api.paymentReconciliation.refresh);
const mm = {
  accountId: 'paymentAccounts|mm',
  type: 'mobile_money',
  destinationKey: 'mm:zm:mtn:0971234567',
  phone: '0971234567',
  operator: 'mtn',
  accountName: 'Resolved Synthetic',
  isVerified: true,
  providerResolvedAt: 1,
};
const bank = {
  accountId: 'paymentAccounts|bank',
  type: 'bank_account',
  destinationKey: 'bank:zm:directory-id:1234567890',
  bankId: 'directory-id',
  bankName: 'Directory Bank',
  accountNumber: '1234567890',
  accountName: 'Resolved Bank Synthetic',
  isVerified: true,
  providerResolvedAt: 1,
};
function auth(subject = 'clerk_a'): Props {
  return {
    isLoading: false,
    isSignedIn: true,
    authSyncError: null,
    clerkUser: { id: subject },
    user: { _id: `users|${subject}`, clerkId: subject, role: 'user', isBanned: false },
    retryUserSync: () => undefined,
    signOut: async () => undefined,
  };
}
function label(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(label).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return label(node.props.children);
  return '';
}
type HostProps = Props & { children?: ReactNode };
function pending<T>() {
  let resolve: (value: T) => void = () => {
    throw Error('uninitialized');
  };
  let reject: (error: Error) => void = () => {
    throw Error('uninitialized');
  };
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// Actual screen + actual operations hook, real React/Convex watches. Native hosts and SDK/storage are the only boundaries.
function realScreen() {
  const controls = createControls();
  controls.auth = auth();
  const convex = createFakeConvexClient({ [AVAILABILITY]: { paymentsEnabled: true }, [ACCOUNTS]: [mm, bank] });
  const hosts: { name: string; props: HostProps }[] = [];
  const calls: { name: string; args: Props }[] = [];
  const alerts: unknown[][] = [];
  const values = new Map<string, string>();
  const handlers = new Map<string, (args: Props) => Promise<unknown>>();
  const queries = new Map<string, (args: Props) => Promise<unknown>>();
  Object.assign(convex.client, {
    action: async (ref: Parameters<typeof getFunctionName>[0], args: Props) => {
      const name = getFunctionName(ref);
      calls.push({ name, args });
      const handler = handlers.get(name);
      if (handler) return await handler(args);
      if (name === BANKS) return { ok: true, banks: [{ id: 'directory-id', name: 'Directory Bank', country: 'zm' }] };
      if (name === REGISTER) return { accountId: mm.accountId, destinationKey: mm.destinationKey };
      if (name === REFRESH) return null;
      return { ok: true, operationId: 'paymentOperations|1', status: 'attempted', providerReference: 'opaque' };
    },
    query: async (ref: Parameters<typeof getFunctionName>[0], args: Props) => {
      const name = getFunctionName(ref);
      calls.push({ name, args });
      const handler = queries.get(name);
      return handler ? await handler(args) : [mm, bank];
    },
  });
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
  const TextInput = Object.assign(host('TextInput'), { Affix: () => null });
  let observed: WalletOperations | undefined;
  const readRefreshes: string[] = [];
  const readError = { value: null as string | null, clears: 0 };
  const harness = createHarness({
    controls,
    convexApi: { api },
    files: {
      [file('apps/mobile/src/context/AuthProvider.tsx')]: withFallback({ useAppAuth: () => controls.auth }),
      [file('apps/mobile/src/components/ui/Header.tsx')]: withFallback({ StackHeader: () => null }),
      [file('apps/mobile/src/hooks/useWallet.ts')]: withFallback({
        useWallet: () => {
          observed = useOperations();
          return {
            operations: observed,
            topUp: observed.topUp,
            withdrawToMobileMoney: observed.withdraw,
            withdrawToBank: observed.withdraw,
            balance: { balance: 500, pendingBalance: 0, totalEarned: 500, isFrozen: false },
            transactions: [],
            activity: null,
            error: readError.value,
            isLoading: false,
            clearError: () => {
              readError.clears += 1;
            },
            ensureWallet: async () => undefined,
            refreshBalance: async () => {
              readRefreshes.push('balance');
            },
            refreshActivity: async () => {
              readRefreshes.push('activity');
            },
            refreshTransactions: async () => {
              readRefreshes.push('transactions');
            },
          };
        },
      }),
    },
    packages: {
      react: React,
      'react/jsx-runtime': JsxRuntime,
      'convex/react': withFallback({ ...ConvexReact, useConvexAuth: () => controls.convexAuth }),
      '@gettitonline/shared': withFallback({ ...shared }),
      '@react-native-async-storage/async-storage': {
        __esModule: true,
        default: {
          getItem: async (key: string) => values.get(key) ?? null,
          setItem: async (key: string, value: string) => {
            values.set(key, value);
          },
          removeItem: async (key: string) => {
            values.delete(key);
          },
        },
      },
      'expo-crypto': { randomUUID: () => '11111111-2222-4333-8444-555555555555' },
      'react-native': withFallback({
        View: passthrough,
        ScrollView: passthrough,
        Pressable: host('Pressable'),
        ActivityIndicator: () => null,
        RefreshControl: host('RefreshControl'),
        Alert: {
          alert: (...args: unknown[]) => {
            alerts.push(args);
          },
        },
        StyleSheet: { create: (styles: Props) => styles },
      }),
      'react-native-paper': withFallback({
        Text: host('Text'),
        Button: host('Button'),
        TextInput,
        Surface: passthrough,
        Chip: passthrough,
        Divider: () => null,
        Modal: modal,
        Portal: passthrough,
        SegmentedButtons: host('SegmentedButtons'),
        useTheme: () => ({ colors: {} }),
      }),
      'expo-linear-gradient': { LinearGradient: passthrough },
      moti: { MotiView: passthrough },
      'react-native-reanimated': withFallback({ default: { View: passthrough }, FadeInDown: withFallback({}) }),
      'react-native-vector-icons/MaterialCommunityIcons': { __esModule: true, default: () => null },
    },
  });
  const useOperations = harness.load(file('apps/mobile/src/hooks/useWalletOperations.ts'))
    .useWalletOperations as () => WalletOperations;
  const Screen = harness.load(file('apps/mobile/src/screens/wallet/WalletScreen.tsx')).default as (
    props: Props,
  ) => ReactNode;
  const providers: { ConvexProvider(props: { client: object; children?: ReactNode }): ReactNode | Promise<ReactNode> } =
    ConvexReact;
  const mounted = mountUnderConvex(convex);
  const render = async (client: object = convex.client): Promise<void> => {
    hosts.length = 0;
    await mounted.render(
      createElement(
        providers.ConvexProvider,
        { client },
        createElement(Screen, { navigation: { goBack: () => undefined, navigate: () => undefined } }),
      ),
    );
  };
  const latest = (name: string, text: string): HostProps => {
    const item = hosts.findLast((entry) => entry.name === name && label(entry.props.children).trim() === text);
    assert.ok(item, `expected ${name}: ${text}`);
    return item.props;
  };
  const run = async (props: HostProps, event: string, ...args: unknown[]): Promise<void> => {
    assert.equal(typeof props[event], 'function');
    await act(async () => {
      await Reflect.apply(props[event] as (...args: unknown[]) => unknown, undefined, args);
    });
  };
  return {
    controls,
    calls,
    alerts,
    values,
    handlers,
    queries,
    hosts,
    convex,
    readRefreshes,
    readError,
    render,
    latest,
    run,
    view: () => {
      assert.ok(observed);
      return observed;
    },
    unmount: () => mounted.unmount(),
    press: async (name: string, text: string) => {
      await run(latest(name, text), 'onPress');
    },
    type: async (text: string, value: string) => {
      const input = hosts.findLast((entry) => entry.name === 'TextInput' && entry.props.label === text);
      assert.ok(input);
      await run(input.props, 'onChangeText', value);
    },
    push: async (name: string, value: unknown) => {
      await deliver(convex, name, value);
    },
  };
}

test('real screen/hook: a dismissed lost-response top-up keeps recovery, truthful wording and status access with payments off', async () => {
  const m = realScreen();
  await m.render();
  await m.press('Pressable', 'Top Up');
  await m.type('Amount (ZMW)', '10.00');
  await m.type('Phone Number', '0971234567');
  const held = pending<unknown>();
  m.handlers.set(TOPUP, () => held.promise);
  let submitting: Promise<unknown> = Promise.resolve();
  await act(async () => {
    submitting = Reflect.apply(m.latest('Button', 'Top Up').onPress as () => Promise<void>, undefined, []);
    await Promise.resolve();
  });
  const modal = m.hosts.findLast((entry) => entry.name === 'Modal' && entry.props.visible === true);
  assert.ok(modal);
  await m.run(modal.props, 'onDismiss');
  await act(async () => {
    held.reject(Error('lost'));
    await submitting;
  });
  await m.render();
  assert.ok(m.view().recovery);
  assert.equal(m.calls.filter((call) => call.name === TOPUP).length, 1);
  assert.equal(m.alerts.length, 0);
  assert.deepEqual(m.readRefreshes, []);
  assert.ok(m.hosts.some((entry) => label(entry.props.children).includes('not confirmed as complete')));
  assert.equal(
    m.hosts.some((entry) => entry.name === 'Modal' && entry.props.visible),
    false,
  );
  await m.push(AVAILABILITY, { paymentsEnabled: false });
  await m.press('Button', 'Check Status');
  assert.equal(m.calls.filter((call) => call.name === REFRESH).length, 1);
  assert.equal(m.latest('Pressable', 'Top Up').disabled, true);
  await m.unmount();
});

test('real screen/hook: resolved mobile destination requires explicit amount-bound approval, with no transfer on registration', async () => {
  const m = realScreen();
  await m.render();
  await m.press('Pressable', 'Withdraw');
  await m.type('Amount (ZMW)', '10.00');
  await m.type('Phone Number', '0971234567');
  await m.press('Button', 'Resolve Destination');
  assert.equal(m.calls.filter((call) => call.name === WITHDRAW).length, 0);
  await m.press('Button', 'Withdraw');
  assert.equal(m.calls.filter((call) => call.name === WITHDRAW).length, 0);
  const staleReview = m.latest('Button', 'Review Resolved Synthetic: 0971234567');
  await m.type('Phone Number', '0970000000');
  await m.run(staleReview, 'onPress');
  assert.equal(
    m.latest('Button', 'Withdraw').disabled,
    true,
    'an edited draft retires captured destination approval controls',
  );
  await m.press('Button', 'Review Resolved Synthetic: 0971234567');
  const staleSubmit = m.latest('Button', 'Withdraw');
  await m.type('Amount (ZMW)', '20.00');
  await m.run(staleSubmit, 'onPress');
  assert.equal(
    m.calls.filter((call) => call.name === WITHDRAW).length,
    0,
    'captured approval cannot approve an edited amount',
  );
  await m.press('Button', 'Review Resolved Synthetic: 0971234567');
  await m.press('Button', 'Withdraw');
  assert.deepEqual(m.calls.find((call) => call.name === WITHDRAW)?.args, {
    requestId: 'wallet_11111111-2222-4333-8444-555555555555',
    amountCents: 2000,
    paymentAccountId: mm.accountId,
    expectedDestinationKey: mm.destinationKey,
  });
  assert.equal(m.alerts.length, 0);
  await m.unmount();
});

test('real screen/hook: bank selection uses directory id and server-owned name, with explicit withdrawal approval', async () => {
  const m = realScreen();
  await m.render();
  await m.press('Pressable', 'Withdraw');
  await m.type('Amount (ZMW)', '15.50');
  const methods = m.hosts.findLast((entry) => entry.name === 'SegmentedButtons');
  assert.ok(methods);
  await m.run(methods.props, 'onValueChange', 'bank');
  await m.press('Button', 'Load Banks');
  await m.press('Button', 'Directory Bank');
  await m.type('Account Number', '1234567890');
  m.handlers.set(REGISTER, async () => ({ accountId: bank.accountId, destinationKey: bank.destinationKey }));
  await m.press('Button', 'Resolve Destination');
  assert.deepEqual(m.calls.find((call) => call.name === REGISTER)?.args, {
    destination: { type: 'bank_account', bankId: 'directory-id', accountNumber: '1234567890' },
  });
  assert.equal(m.calls.filter((call) => call.name === WITHDRAW).length, 0);
  assert.ok(!m.hosts.some((entry) => entry.props.label === 'Account Name' || entry.props.label === 'Bank Code'));
  await m.press('Button', 'Review Resolved Bank Synthetic: Directory Bank 1234567890');
  await m.press('Button', 'Withdraw');
  assert.equal(m.calls.filter((call) => call.name === WITHDRAW).length, 1);
  await m.unmount();
});

test('real screen/hook: dismissing a resolving destination retires old UI work without automatically approving or transferring', async () => {
  const m = realScreen();
  await m.render();
  await m.press('Pressable', 'Withdraw');
  await m.type('Amount (ZMW)', '10');
  await m.type('Phone Number', '0971234567');
  const held = pending<unknown>();
  m.handlers.set(REGISTER, () => held.promise);
  let resolving: Promise<unknown> = Promise.resolve();
  await act(async () => {
    resolving = Reflect.apply(m.latest('Button', 'Resolve Destination').onPress as () => Promise<void>, undefined, []);
  });
  const modal = m.hosts.findLast((entry) => entry.name === 'Modal' && entry.props.visible);
  assert.ok(modal);
  await m.run(modal.props, 'onDismiss');
  const before = m.calls.length;
  await act(async () => {
    held.resolve({ accountId: mm.accountId, destinationKey: mm.destinationKey });
    await resolving;
  });
  assert.equal(m.calls.length, before, 'dismissal retires the registration-to-owned-read continuation');
  assert.equal(m.view().error, null);
  assert.equal(m.view().working, false);
  assert.equal(m.calls.filter((call) => call.name === WITHDRAW).length, 0);
  await m.unmount();
});

test('real screen/hook: denied access hides cached wallet and all private destination controls with actionable notices', async () => {
  const m = realScreen();
  await m.render();
  for (const [patch, message] of [
    [{ isSignedIn: false, user: null }, 'Sign in to continue'],
    [{ user: null, authSyncError: 'failed' }, 'Account setup did not finish'],
    [{ user: { ...(auth().user as Props), isBanned: true } }, 'Account unavailable'],
    [{ user: { ...(auth().user as Props), deletedAt: 1 } }, 'Account unavailable'],
    [{ clerkUser: { id: 'other' } }, 'Account setup did not finish'],
  ] as const) {
    m.controls.auth = { ...auth(), ...patch };
    await m.render();
    assert.ok(m.hosts.some((entry) => label(entry.props.children).includes(message)));
    assert.ok(!m.hosts.some((entry) => label(entry.props.children).includes('Available Balance')));
    assert.equal(m.view().accounts.length, 0);
  }
  assert.equal(m.calls.length, 0);
  await m.unmount();
});

for (const boundary of ['signout', 'client', 'unmount', 'aba'] as const) {
  test(`real screen/hook: deferred submission cannot alert, reset drafts, refresh or navigate after ${boundary}`, async () => {
    const m = realScreen();
    await m.render();
    await m.press('Pressable', 'Top Up');
    await m.type('Amount (ZMW)', '10');
    await m.type('Phone Number', '0971234567');
    const held = pending<unknown>();
    m.handlers.set(TOPUP, () => held.promise);
    let submitting: Promise<unknown> = Promise.resolve();
    await act(async () => {
      submitting = Reflect.apply(m.latest('Button', 'Top Up').onPress as () => Promise<void>, undefined, []);
      await Promise.resolve();
    });
    const old = m.view();
    if (boundary === 'unmount') await m.unmount();
    else if (boundary === 'client') await m.render(createFakeConvexClient().client);
    else {
      m.controls.auth = { ...auth(), isSignedIn: false, user: null };
      await m.render();
      if (boundary === 'aba') {
        m.controls.auth = auth();
        await m.render();
      }
    }
    assert.equal(old.isCurrent(), false);
    await act(async () => {
      held.resolve({ ok: true, operationId: 'paymentOperations|1', status: 'succeeded', providerReference: 'opaque' });
      await submitting;
    });
    assert.equal(m.alerts.length, 0);
    assert.deepEqual(m.readRefreshes, []);
    assert.equal(m.calls.filter((call) => call.name === TOPUP).length, 1);
    if (boundary !== 'unmount') await m.unmount();
  });
}

test('real screen/hook: review prevents success, unknown fee stays unknown, and proven completion refreshes wallet once', async () => {
  const m = realScreen();
  await m.render();
  await m.press('Pressable', 'Top Up');
  await m.type('Amount (ZMW)', '10');
  await m.type('Phone Number', '0971234567');
  await m.press('Button', 'Top Up');
  const token = m.view().recovery;
  assert.ok(token);
  const completed = {
    result: 'found',
    operationId: 'paymentOperations|1',
    requestId: token.requestId,
    requestIdentity: null,
    kind: token.kind,
    status: 'succeeded',
    providerStatus: 'successful',
    application: 'applied',
    accountingApplied: true,
    reviewNeeded: true,
    amountCents: 1000,
    quoteKey: null,
    source: null,
    orderIds: [],
    feeCents: null,
  };
  await m.push(STATUS, completed);
  assert.equal(m.view().outcome, 'review');
  assert.deepEqual(m.readRefreshes, []);
  await m.render();
  assert.ok(m.hosts.some((entry) => label(entry.props.children) === 'Provider fee: Unknown'));
  assert.ok(!m.hosts.some((entry) => label(entry.props.children).includes('confirms this request completed')));
  await m.push(STATUS, { ...completed, reviewNeeded: false });
  assert.deepEqual(m.readRefreshes, ['balance', 'activity', 'transactions']);
  await m.render();
  assert.deepEqual(m.readRefreshes, ['balance', 'activity', 'transactions']);
  assert.equal(m.alerts.length, 0);
  await m.unmount();
});

test('real screen/hook: destination mismatch retires captured approval and requires a new explicit review', async () => {
  const m = realScreen();
  await m.render();
  await m.press('Pressable', 'Withdraw');
  await m.type('Amount (ZMW)', '10');
  await m.press('Button', 'Review Resolved Synthetic: 0971234567');
  const old = m.latest('Button', 'Withdraw');
  m.handlers.set(WITHDRAW, async () => ({ ok: false, code: 'destination_mismatch', destinationKey: 'changed-key' }));
  await m.run(old, 'onPress');
  assert.equal(m.calls.filter((call) => call.name === WITHDRAW).length, 1);
  assert.equal(m.latest('Button', 'Withdraw').disabled, true);
  await m.run(old, 'onPress');
  assert.equal(m.calls.filter((call) => call.name === WITHDRAW).length, 1);
  assert.equal(m.view().recovery, null);
  assert.equal(m.alerts.length, 0);
  await m.unmount();
});

test('an old wallet error alert cannot clear a later owner error', async () => {
  const m = realScreen();
  m.readError.value = 'Synthetic read failure';
  await m.render();
  const alert = m.alerts[0];
  assert.ok(alert);
  const buttons: unknown = alert[2];
  assert.ok(Array.isArray(buttons));
  const button: unknown = buttons[0];
  assert.ok(
    typeof button === 'object' && button !== null && 'onPress' in button && typeof button.onPress === 'function',
  );
  const onPress = button.onPress;
  m.controls.auth = auth('clerk_b');
  await m.render();
  await act(async () => {
    Reflect.apply(onPress, undefined, []);
  });
  assert.equal(m.readError.clears, 0);
  await m.unmount();
});

test('the open top-up form shows validation errors and truthful pending recovery instructions', async () => {
  const m = realScreen();
  await m.render();
  await m.press('Pressable', 'Top Up');
  await m.type('Amount (ZMW)', '10junk');
  await m.type('Phone Number', '0971234567');
  await m.press('Button', 'Top Up');
  let modal = m.hosts.findLast((entry) => entry.name === 'Modal' && entry.props.visible);
  assert.ok(modal);
  assert.ok(
    label(modal.props.children).includes('Enter a positive amount'),
    'the visible form shows its validation error',
  );
  assert.equal(m.calls.filter((call) => call.name === TOPUP).length, 0);
  await m.type('Amount (ZMW)', '10');
  await m.press('Button', 'Top Up');
  modal = m.hosts.findLast((entry) => entry.name === 'Modal' && entry.props.visible);
  assert.ok(modal);
  assert.ok(label(modal.props.children).includes('Close this form to check status'));
  assert.equal(m.alerts.length, 0);
  await m.unmount();
});

for (const boundary of ['replacement', 'aba', 'unmount', 'current'] as const) {
  test(`read-error acknowledgement respects the latest committed error revision at ${boundary}`, async () => {
    const m = realScreen();
    m.readError.value = 'First synthetic read error';
    await m.render();
    const first = m.alerts[0];
    assert.ok(first);
    const buttons: unknown = first[2];
    assert.ok(Array.isArray(buttons));
    const button: unknown = buttons[0];
    assert.ok(
      typeof button === 'object' && button !== null && 'onPress' in button && typeof button.onPress === 'function',
    );
    const oldAcknowledge = button.onPress;
    if (boundary === 'replacement' || boundary === 'aba') {
      m.readError.value = 'Second synthetic read error';
      await m.render();
      if (boundary === 'aba') {
        m.readError.value = 'First synthetic read error';
        await m.render();
      }
    }
    if (boundary === 'unmount') await m.unmount();
    await act(async () => {
      Reflect.apply(oldAcknowledge, undefined, []);
    });
    assert.equal(m.readError.clears, boundary === 'current' ? 1 : 0);
    if (boundary === 'replacement' || boundary === 'aba') {
      const currentAlert = m.alerts.at(-1);
      assert.ok(currentAlert);
      const latestButtons: unknown = currentAlert[2];
      assert.ok(Array.isArray(latestButtons));
      const latestButton: unknown = latestButtons[0];
      assert.ok(
        typeof latestButton === 'object' &&
          latestButton !== null &&
          'onPress' in latestButton &&
          typeof latestButton.onPress === 'function',
      );
      const latestAcknowledge = latestButton.onPress;
      await act(async () => {
        Reflect.apply(latestAcknowledge, undefined, []);
      });
      assert.equal(m.readError.clears, 1, 'current acknowledgment still clears its own error');
    }
    if (boundary !== 'unmount') await m.unmount();
  });
}
