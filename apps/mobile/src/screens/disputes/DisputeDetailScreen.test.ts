import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import React, { act, createElement, type ReactNode } from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import * as ConvexReact from 'convex/react';
import { getFunctionName } from 'convex/server';
import * as checkoutQuoteModule from '../../../../../convex/checkoutQuote';
import * as paymentOperationsModule from '../../../../../convex/paymentOperations';
import type { Row } from '../../../../../tests/support/convexFakeDb';
import * as disputesModule from '../../../../../convex/disputes';
import { createDb, createCtx } from '../../../../../tests/support/convexFakeDb';
import { invokeFakeFunction } from '../../../../../tests/support/convexFakeActionCtx';
import { api } from '../../../../../convex/_generated/api';
import { resolveAccountAccess } from '../../../../../packages/shared/src/utils/accountAccess';
import { createControls, createHarness, type Props } from '../../../../../tests/support/componentHarness';
import { createFakeConvexClient, mountUnderConvex } from '../../../../../tests/support/realReactRender';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const file = (path: string): string => resolve(root, path);
const USER = { _id: 'users|buyer', clerkId: 'buyer', role: 'user', isBanned: false };
const DISPUTE = {
  _id: 'disputes|1',
  orderId: 'orders|1',
  escrowId: 'escrow|1',
  buyerId: USER._id,
  sellerId: 'users|seller',
  title: 'Late delivery',
  description: 'Missing item',
  category: 'not_received',
  status: 'open',
  evidence: [],
  createdAt: 1,
  updatedAt: 1,
};

function deferred() {
  let resolvePromise: (value: unknown) => void = () => undefined;
  let rejectPromise: (error: Error) => void = () => undefined;
  const promise = new Promise<unknown>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(text).join('');
  if (React.isValidElement<{ children?: unknown }>(value)) return text(value.props.children);
  return '';
}

function rig(reviewer = false, strictRoot = false) {
  const controls = createControls();
  let user: Props = reviewer ? { ...USER, _id: 'users|reviewer', clerkId: 'reviewer', role: 'moderator' } : USER;
  let auth: Props = { isLoading: false, isSignedIn: true, user, authSyncError: null, clerkUser: { id: user.clerkId } };
  let resource = DISPUTE._id;
  let dispute: Props = { ...DISPUTE, escrow: { grossAmount: 105, amount: 105 } };
  const buttons = new Map<string, Props>();
  const inputs = new Map<string, Props>();
  const dialogs = new Map<string, Props>();
  const alerts: unknown[][] = [];
  const calls: { name: string; args: unknown }[] = [];
  const implementations = new Map<string, (args: unknown) => unknown>();
  const host = (name: string) =>
    function Host(props: Props): ReactNode {
      if (['Button', 'Pressable', 'Chip'].includes(name)) buttons.set(text(props.children), props);
      if (name === 'TextInput') inputs.set(String(props.label), props);
      if (name === 'Dialog') {
        dialogs.set(text(props.children).startsWith('Resolve Dispute') ? 'buyer' : 'reviewer', props);
        if (!props.visible) return null;
      }
      return createElement('div', null, props.children as ReactNode);
    };
  const chain = { delay: () => chain, duration: () => chain };
  const theme = { colors: new Proxy({}, { get: () => '#ffffff' }) };
  const ui = new Proxy(
    {},
    {
      get: (_target, key) => {
        if (key === '__esModule') return true;
        if (key === 'useTheme') return () => theme;
        const component = host(String(key));
        Object.assign(component, {
          Content: host(`${String(key)}.Content`),
          Title: host(`${String(key)}.Title`),
          Actions: host(`${String(key)}.Actions`),
          Text: host(`${String(key)}.Text`),
        });
        return component;
      },
    },
  );
  const harness = createHarness({
    controls,
    convexApi: { api },
    files: {
      [file('apps/mobile/src/context/AuthProvider.tsx')]: { useAppAuth: () => auth },
      [file('apps/mobile/src/components/auth/useAccountAccess.ts')]: {
        useAccountAccess: () => ({
          status: resolveAccountAccess({
            isLoading: Boolean(auth.isLoading),
            isSignedIn: Boolean(auth.isSignedIn),
            syncFailed: auth.authSyncError !== null,
            user: auth.user as typeof USER | null,
          }),
        }),
      },
      [file('apps/mobile/src/components/auth/AccountAccessNotice.tsx')]: { AccountAccessNotice: host('Notice') },
      [file('apps/mobile/src/components/ui/Header.tsx')]: { StackHeader: host('Header') },
      [file('apps/mobile/src/hooks/useAiActions.ts')]: {
        useAiActions: () => ({ subject: user.clerkId, isCurrent: () => true }),
      },
      [file('apps/mobile/src/services/aiAdapters.ts')]: { disputeFailureMessage: () => 'AI error' },
      [file('apps/mobile/src/services/aiConsent.ts')]: { requestAIConsent: async () => false },
      [file('apps/mobile/src/theme/index.ts')]: { formatPrice: (amount: number) => `K${amount}` },
    },
    packages: {
      react: React,
      'react/jsx-runtime': jsxRuntime,
      'convex/react': ConvexReact,
      'react-native': {
        View: host('View'),
        ScrollView: host('ScrollView'),
        Pressable: host('Pressable'),
        ActivityIndicator: host('ActivityIndicator'),
        Alert: { alert: (...args: unknown[]) => alerts.push(args) },
        StyleSheet: { create: (value: unknown) => value },
      },
      'react-native-paper': ui,
      moti: { MotiView: host('MotiView') },
      'react-native-reanimated': { __esModule: true, default: { View: host('Animated.View') }, FadeInDown: chain },
      'react-native-vector-icons/MaterialCommunityIcons': { __esModule: true, default: host('Icon') },
    },
  });
  const screen = harness.load(file('apps/mobile/src/screens/disputes/DisputeDetailScreen.tsx'))
    .default as React.ComponentType<Props>;
  const convex = createFakeConvexClient({ 'disputes:getDispute': dispute });
  const transport = async (ref: Parameters<typeof getFunctionName>[0], args: unknown): Promise<unknown> => {
    const name = getFunctionName(ref);
    calls.push({ name, args });
    return implementations.get(name)?.(args);
  };
  Object.assign(convex.client, { mutation: transport });
  let client: object = convex.client;
  const mounted = mountUnderConvex(convex, { strictRoot });
  const providers: { ConvexProvider(props: { client: object; children?: ReactNode }): ReactNode | Promise<ReactNode> } =
    ConvexReact;
  let childOverride: ReactNode | undefined;
  const render = async (child?: ReactNode): Promise<void> => {
    if (child !== undefined) childOverride = child;
    buttons.clear();
    inputs.clear();
    dialogs.clear();
    await mounted.render(
      createElement(
        providers.ConvexProvider,
        { client },
        childOverride ??
          createElement(screen, {
            route: { params: { disputeId: resource } },
            navigation: {
              navigate: (value: unknown) => calls.push({ name: 'navigate', args: value }),
              goBack: () => calls.push({ name: 'back', args: null }),
            },
          }),
      ),
    );
  };
  const project = async (patch: Props): Promise<void> => {
    dispute = { ...dispute, ...patch };
    await act(async () => convex.deliver('disputes:getDispute', dispute));
    await render();
  };
  const press = async (label: string): Promise<void> => {
    const button = buttons.get(label);
    assert.ok(button, [...buttons.keys()].join(','));
    await invoke(button.onPress);
    await render();
  };
  const confirmation = (): unknown => {
    const buttons = alerts.at(-1)?.[2];
    assert.ok(Array.isArray(buttons));
    return buttons.find((value: Props) => value.text === 'Confirm')?.onPress;
  };
  const draft = async (outcome = 'no_refund'): Promise<void> => {
    await press('Resolve as Reviewer-Approver');
    if (outcome !== 'no_refund') await press(outcome === 'full_refund' ? 'Full Refund' : 'Partial Refund');
    await act(async () => {
      const notes = inputs.get('Resolution Notes');
      assert.ok(notes);
      assert.ok(typeof notes.onChangeText === 'function');
      Reflect.apply(notes.onChangeText, undefined, ['Keep these notes']);
      if (outcome === 'partial_refund') {
        const refund = [...inputs.values()].find((p) => String(p.label).startsWith('Refund Amount'));
        assert.ok(refund);
        assert.ok(typeof refund.onChangeText === 'function');
        Reflect.apply(refund.onChangeText, undefined, ['25']);
      }
    });
    await render();
  };
  return {
    render,
    project,
    press,
    draft,
    confirmation,
    mounted,
    convex,
    buttons,
    inputs,
    dialogs,
    alerts,
    calls,
    implementations,
    screen,
    setUser: (next: Props): void => {
      user = next;
      auth = { ...auth, user, clerkUser: { id: user.clerkId } };
    },
    setAccess: (next: Props): void => {
      auth = { ...auth, ...next };
    },
    setResource: (next: string): void => {
      resource = next;
    },
    replaceClient: (): void => {
      const next = createFakeConvexClient({ 'disputes:getDispute': dispute });
      Object.assign(next.client, { mutation: transport });
      client = next.client;
    },
  };
}
async function invoke(callback: unknown): Promise<void> {
  assert.ok(typeof callback === 'function');
  await act(async () => {
    await Reflect.apply(callback, undefined, []);
  });
}
const buyerOptions = {
  withdraw: 'Withdraw DisputeCancel complaint and release funds to seller',
  received_item: 'I Received the ItemThe item was eventually delivered',
  issue_resolved: 'Seller Resolved the IssueThe seller fixed the problem',
  agreed_refund: 'Agreed on RefundSeller agreed to refund (support will process)',
};
const resolved = (reviewer = false, type = 'no_refund'): Props => ({
  ...DISPUTE,
  status: 'resolved',
  accountingOutcome: 'applied',
  resolution: {
    type: reviewer ? type : 'mutual_agreement',
    resolvedBy: reviewer ? 'users|reviewer' : USER._id,
    resolvedAt: 2,
    notes: 'Keep these notes',
  },
});

for (const type of ['withdraw', 'received_item', 'issue_resolved', 'agreed_refund'] as const) {
  for (const outcome of ['review', 'applied', 'missing', 'error']) {
    test(`real buyer ${type}: ${outcome} retains truthful dialog and outcome`, async () => {
      const r = rig();
      r.implementations.set('disputes:buyerResolveDispute', () => {
        if (outcome === 'error') throw new Error('transport failed');
        if (outcome === 'missing') return undefined;
        if (outcome === 'review') return { ...DISPUTE, accountingOutcome: 'review' };
        return type === 'agreed_refund' ? { ...DISPUTE, status: 'in_discussion' } : resolved();
      });
      try {
        await r.render();
        await r.press('Resolve Dispute');
        await r.press(buyerOptions[type]);
        await invoke(r.confirmation());
        await r.render();
        const feedback = r.alerts
          .slice(1)
          .map((a) => `${a[0]} ${a[1]}`)
          .join(' ');
        assert.equal(r.dialogs.get('buyer')?.visible, outcome !== 'applied');
        if (outcome === 'review') {
          assert.match(feedback, /review/i);
          assert.ok(!/Success|has been resolved|credited|released/.test(feedback));
        }
        if (outcome === 'missing' || outcome === 'error') assert.match(feedback, /Error|not confirmed/i);
        if (outcome === 'applied' && type === 'agreed_refund') {
          assert.match(feedback, /pending processing/i);
          assert.ok(!/resolved|refunded|released/.test(feedback));
        }
        if (outcome === 'applied' && type !== 'agreed_refund') assert.match(feedback, /resolved/);
        assert.deepEqual(r.calls[0]?.args, { disputeId: DISPUTE._id, resolutionType: type });
      } finally {
        await r.mounted.unmount();
      }
    });
  }
}

for (const type of ['full_refund', 'partial_refund', 'no_refund']) {
  for (const outcome of ['review', 'applied', 'missing', 'malformed', 'error']) {
    test(`real reviewer ${type}: ${outcome} preserves drafts unless confirmed applied`, async () => {
      const r = rig(true);
      r.implementations.set('disputes:resolveDispute', () => {
        if (outcome === 'error') throw new Error('transport failed');
        if (outcome === 'missing') return null;
        if (outcome === 'malformed')
          return { ...resolved(true, type), resolution: { type: 'mutual_agreement', resolvedBy: 'users|other' } };
        return outcome === 'review' ? { ...DISPUTE, accountingOutcome: 'review' } : resolved(true, type);
      });
      try {
        await r.render();
        await r.draft(type);
        await r.press('Submit');
        assert.equal(r.dialogs.get('reviewer')?.visible, outcome !== 'applied');
        if (outcome !== 'applied') {
          assert.equal(r.inputs.get('Resolution Notes')?.value, 'Keep these notes');
          if (type === 'partial_refund')
            assert.equal([...r.inputs.values()].find((p) => String(p.label).startsWith('Refund Amount'))?.value, '25');
          assert.ok(!r.alerts.some((a) => a[0] === 'Dispute resolved'));
        } else {
          assert.ok(r.alerts.some((a) => a[0] === 'Dispute resolved'));
          if (type !== 'no_refund') assert.match(String(r.alerts.at(-1)?.[1]), /marketplace wallet/i);
        }
        if (outcome === 'review') assert.match(String(r.alerts.at(-1)?.[0]), /review/i);
      } finally {
        await r.mounted.unmount();
      }
    });
  }
}

for (const loss of ['access', 'resource', 'role', 'client', 'aba', 'status', 'unmount']) {
  test(`real mobile deferred native confirmation retires on ${loss}`, async () => {
    const r = rig(false, true);
    try {
      await r.render();
      await r.press('Resolve Dispute');
      await r.press(buyerOptions.withdraw);
      const callback = r.confirmation();
      if (loss === 'access') {
        r.setAccess({ isSignedIn: false, user: null });
        await r.render();
        r.setAccess({ isSignedIn: true, user: USER });
      }
      if (loss === 'resource' || loss === 'aba') {
        r.setResource('disputes|2');
        await r.project({ _id: 'disputes|2' });
        if (loss === 'aba') {
          r.setResource(DISPUTE._id);
          await r.project({ _id: DISPUTE._id });
        }
      }
      if (loss === 'role') r.setUser({ ...USER, role: 'moderator' });
      if (loss === 'client') r.replaceClient();
      if (loss === 'status') await r.project({ status: 'resolved' });
      if (loss === 'unmount') {
        await r.mounted.unmount();
        await invoke(callback);
        assert.equal(r.calls.length, 0);
        return;
      }
      await r.render();
      await invoke(callback);
      assert.equal(r.calls.length, 0);
      assert.equal(r.alerts.length, 1);
    } finally {
      if (loss !== 'unmount') await r.mounted.unmount();
    }
  });
}

for (const reviewer of [false, true]) {
  for (const before of [false, true]) {
    test(`real mobile ${reviewer ? 'reviewer' : 'buyer'} own terminal projection ${before ? 'before' : 'after'} SDK keeps feedback`, async () => {
      const r = rig(reviewer, true);
      const wait = deferred();
      r.implementations.set(reviewer ? 'disputes:resolveDispute' : 'disputes:buyerResolveDispute', () => wait.promise);
      try {
        await r.render();
        let callback: unknown;
        if (reviewer) {
          await r.draft();
          callback = r.buttons.get('Submit')?.onPress;
        } else {
          await r.press('Resolve Dispute');
          await r.press(buyerOptions.withdraw);
          callback = r.confirmation();
        }
        await act(async () => {
          assert.ok(typeof callback === 'function');
          assert.ok(typeof callback === 'function');
          void Reflect.apply(callback, undefined, [{ preventDefault: () => undefined }]);
        });
        await act(async () => {
          assert.ok(typeof callback === 'function');
          void Reflect.apply(callback, undefined, [{ preventDefault: () => undefined }]);
        });
        assert.equal(r.calls.length, 1);
        if (before) await r.project(resolved(reviewer));
        await act(async () => wait.resolve(resolved(reviewer)));
        if (!before) await r.project(resolved(reviewer));
        await r.render();
        assert.ok(r.alerts.some((a) => a[0] === (reviewer ? 'Dispute resolved' : 'Success')));
        assert.equal(r.dialogs.get(reviewer ? 'reviewer' : 'buyer')?.visible, false);
      } finally {
        await r.mounted.unmount();
      }
    });
  }
}

for (const reviewer of [false, true]) {
  for (const loss of ['access', 'resource', 'role', 'client', 'aba', 'decision', 'unmount']) {
    for (const rejects of [false, true]) {
      test(`real mobile late ${reviewer ? 'reviewer' : 'buyer'} ${rejects ? 'error' : 'applied'} retires on ${loss}`, async () => {
        const r = rig(reviewer);
        const wait = deferred();
        r.implementations.set(
          reviewer ? 'disputes:resolveDispute' : 'disputes:buyerResolveDispute',
          () => wait.promise,
        );
        let unmounted = false;
        try {
          await r.render();
          if (reviewer) {
            await r.draft();
            await r.press('Submit');
          } else {
            await r.press('Resolve Dispute');
            await r.press(buyerOptions.withdraw);
            const callback = r.confirmation();
            await act(async () => {
              assert.ok(typeof callback === 'function');
              assert.ok(typeof callback === 'function');
              void Reflect.apply(callback, undefined, []);
            });
          }
          const count = r.alerts.length;
          if (loss === 'access') {
            r.setAccess({ isLoading: true, user: null });
            await r.render();
            r.setAccess({
              isLoading: false,
              user: reviewer ? { ...USER, _id: 'users|reviewer', clerkId: 'reviewer', role: 'moderator' } : USER,
            });
          }
          if (loss === 'resource' || loss === 'aba') {
            r.setResource('disputes|2');
            await r.project({ _id: 'disputes|2' });
            if (loss === 'aba') {
              r.setResource(DISPUTE._id);
              await r.project({ _id: DISPUTE._id });
            }
          }
          if (loss === 'role') r.setUser({ ...USER, role: reviewer ? 'user' : 'moderator' });
          if (loss === 'client') r.replaceClient();
          if (loss === 'decision')
            await r.project({ status: 'resolved', resolution: { type: 'full_refund', resolvedBy: 'users|other' } });
          if (loss === 'unmount') {
            await r.mounted.unmount();
            unmounted = true;
          } else await r.render();
          await act(async () => {
            if (rejects) wait.reject(new Error('old failure'));
            else wait.resolve(resolved(reviewer));
          });
          assert.equal(r.alerts.length, count);
          assert.equal(r.calls.length, 1);
        } finally {
          if (!unmounted) await r.mounted.unmount();
        }
      });
    }
  }
}

test('real mobile old finally cannot unlock newer reviewer resolution', async () => {
  const r = rig(true);
  const old = deferred();
  const newer = deferred();
  let n = 0;
  r.implementations.set('disputes:resolveDispute', () => (++n === 1 ? old.promise : newer.promise));
  try {
    await r.render();
    await r.draft();
    await r.press('Submit');
    r.setResource('disputes|2');
    await r.project({ _id: 'disputes|2' });
    await r.draft();
    await r.press('Submit');
    await act(async () => old.reject(new Error('old failure')));
    await r.render();
    assert.equal(r.buttons.get('Submit')?.loading, true);
    assert.equal(r.alerts.length, 0);
    await act(async () => newer.resolve({ ...DISPUTE, _id: 'disputes|2', accountingOutcome: 'review' }));
    await r.render();
    assert.equal(r.buttons.get('Submit')?.loading, false);
    assert.equal(r.inputs.get('Resolution Notes')?.value, 'Keep these notes');
  } finally {
    await r.mounted.unmount();
  }
});

for (const before of [false, true]) {
  test(`real mobile pending agreement projected ${before ? 'before' : 'after'} SDK stays pending and releases owned loading`, async () => {
    const r = rig();
    const wait = deferred();
    r.implementations.set('disputes:buyerResolveDispute', () => wait.promise);
    try {
      await r.render();
      await r.press('Resolve Dispute');
      await r.press(buyerOptions.agreed_refund);
      const callback = r.confirmation();
      await act(async () => {
        assert.ok(typeof callback === 'function');
        assert.ok(typeof callback === 'function');
        void Reflect.apply(callback, undefined, []);
      });
      if (before) await r.project({ status: 'in_discussion' });
      await act(async () => wait.resolve({ ...DISPUTE, status: 'in_discussion' }));
      if (!before) await r.project({ status: 'in_discussion' });
      await r.render();
      assert.match(String(r.alerts.at(-1)?.[0]), /pending processing/);
      assert.equal(r.dialogs.get('buyer')?.visible, false);
      await r.press('Resolve Dispute');
      assert.equal(r.buttons.get(buyerOptions.withdraw)?.disabled, false);
    } finally {
      await r.mounted.unmount();
    }
  });
}

for (const denied of ['loading', 'signed-out', 'banned', 'deleted', 'recovery']) {
  test(`real mobile ${denied} skips private dispute query and removes cached content`, async () => {
    const r = rig();
    try {
      await r.render();
      r.setAccess(
        denied === 'loading'
          ? { isLoading: true }
          : denied === 'signed-out'
            ? { isSignedIn: false }
            : denied === 'banned'
              ? { user: { ...USER, isBanned: true } }
              : denied === 'deleted'
                ? { user: null }
                : { user: null, authSyncError: 'sync failed' },
      );
      await r.render();
      assert.equal(r.dialogs.size, 0);
      assert.equal(r.buttons.size, 0);
      assert.equal(
        r.convex.lifecycle.filter((x) => x === 'subscribe:disputes:getDispute').length,
        r.convex.lifecycle.filter((x) => x === 'unsubscribe:disputes:getDispute').length,
      );
    } finally {
      await r.mounted.unmount();
    }
  });
}

test('real mobile target then reversal permanently retires buyer resolution', async () => {
  const r = rig();
  const wait = deferred();
  r.implementations.set('disputes:buyerResolveDispute', () => wait.promise);
  try {
    await r.render();
    await r.press('Resolve Dispute');
    await r.press(buyerOptions.withdraw);
    const callback = r.confirmation();
    await act(async () => {
      assert.ok(typeof callback === 'function');
      assert.ok(typeof callback === 'function');
      void Reflect.apply(callback, undefined, []);
    });
    await r.project(resolved());
    await r.project({ status: 'open', resolution: undefined });
    await act(async () => wait.resolve(resolved()));
    assert.equal(r.alerts.length, 1);
  } finally {
    await r.mounted.unmount();
  }
});

test('registered agreed-refund producer → real mobile consumer remains pending with no wallet writes', async () => {
  const r = rig();
  const db = createDb({
    users: [{ ...USER, firstName: 'Buyer', lastName: 'Fixture', email: 'buyer@example.invalid', isVerified: true }],
    disputes: [DISPUTE],
    orders: [{ _id: DISPUTE.orderId, buyerId: USER._id, sellerId: DISPUTE.sellerId, status: 'disputed' }],
    escrow: [
      {
        _id: DISPUTE.escrowId,
        orderId: DISPUTE.orderId,
        buyerId: USER._id,
        sellerId: DISPUTE.sellerId,
        status: 'disputed',
      },
    ],
    messages: [],
    notifications: [],
    walletTransactions: [],
  });
  r.implementations.set('disputes:buyerResolveDispute', (args) =>
    invokeFakeFunction(disputesModule.buyerResolveDispute, createCtx(db, 'buyer'), args),
  );
  try {
    await r.render();
    await r.press('Resolve Dispute');
    await r.press(buyerOptions.agreed_refund);
    await invoke(r.confirmation());
    await r.render();
    assert.equal(db.tables.disputes?.[0]?.status, 'in_discussion');
    assert.equal(db.tables.walletTransactions?.length, 0);
    assert.equal(db.tables.notifications?.[0]?.title, 'Refund Agreement Pending');
    assert.match(String(r.alerts.at(-1)?.[0]), /pending processing/);
    assert.equal(r.dialogs.get('buyer')?.visible, false);
  } finally {
    await r.mounted.unmount();
  }
});

test('real mobile speculative role render cannot publish authority or retire committed native confirmation', async () => {
  const r = rig();
  const never = new Promise<void>(() => undefined);
  let suspend = false;
  function Suspender(): ReactNode {
    if (suspend) throw never;
    return null;
  }
  const tree = (): ReactNode =>
    createElement(
      React.Suspense,
      { fallback: null },
      createElement(r.screen, { route: { params: { disputeId: DISPUTE._id } }, navigation: {} }),
      createElement(Suspender),
    );
  r.implementations.set('disputes:buyerResolveDispute', () => resolved());
  try {
    await r.render(tree());
    await invoke(r.buttons.get('Resolve Dispute')?.onPress);
    await invoke(r.buttons.get(buyerOptions.withdraw)?.onPress);
    const callback = r.confirmation();
    r.setUser({ ...USER, role: 'moderator' });
    suspend = true;
    await act(async () => {
      React.startTransition(() => {
        void r.render(tree());
      });
    });
    await invoke(callback);
    assert.equal(r.calls.length, 1);
    assert.equal(r.alerts.at(-1)?.[0], 'Success');
  } finally {
    await r.mounted.unmount();
  }
});

test('real native Alert Cancel leaves current buyer dialog controls usable without a render', async () => {
  const r = rig();
  try {
    await r.render();
    await r.press('Resolve Dispute');
    const option = r.buttons.get(buyerOptions.withdraw)?.onPress;
    await invoke(option);
    const choices = r.alerts.at(-1)?.[2];
    assert.ok(Array.isArray(choices));
    await invoke(choices.find((value: Props) => value.text === 'Cancel')?.onPress);
    await invoke(option);
    assert.equal(r.alerts.length, 2, 'cancelling a native confirmation must permit a fresh confirmation');
    const dialogCancel = r.buttons.get('Cancel')?.onPress;
    await invoke(dialogCancel);
    await r.render();
    assert.equal(r.dialogs.get('buyer')?.visible, false);
    assert.equal(r.calls.length, 0);
  } finally {
    await r.mounted.unmount();
  }
});

test('real mobile account A→B→A permanently retires a native confirmation and in-flight reply', async () => {
  const r = rig();
  const wait = deferred();
  r.implementations.set('disputes:buyerResolveDispute', () => wait.promise);
  try {
    await r.render();
    await r.press('Resolve Dispute');
    await r.press(buyerOptions.withdraw);
    const captured = r.confirmation();
    await act(async () => {
      assert.ok(typeof captured === 'function');
      void Reflect.apply(captured, undefined, []);
    });
    r.setUser({ ...USER, _id: 'users|b', clerkId: 'b', role: 'moderator' });
    await r.render();
    r.setUser(USER);
    await r.render();
    await invoke(captured);
    await act(async () => wait.resolve(resolved()));
    assert.equal(r.calls.length, 1);
    assert.equal(r.alerts.length, 1);
  } finally {
    await r.mounted.unmount();
  }
});

test('real mobile a later changed decision cannot reuse the first owned expected transition', async () => {
  const r = rig(true);
  const wait = deferred();
  r.implementations.set('disputes:resolveDispute', () => wait.promise);
  try {
    await r.render();
    await r.draft();
    await r.press('Submit');
    await r.project(resolved(true));
    await r.project({
      ...resolved(true),
      resolution: { type: 'no_refund', resolvedBy: 'users|reviewer', resolvedAt: 3, notes: 'A later changed decision' },
    });
    await act(async () => wait.resolve(resolved(true)));
    assert.equal(r.alerts.length, 0, 'only the first owned expected transition can retain old feedback');
  } finally {
    await r.mounted.unmount();
  }
});

test('real mobile assignment keeps its business-only policy through an early owned review projection', async () => {
  const r = rig(true);
  const wait = deferred();
  r.implementations.set('disputes:assignModerator', () => wait.promise);
  try {
    await r.render();
    await r.press('Assign to Me');
    await r.project({
      status: 'moderator_review',
      moderatorId: 'users|reviewer',
      moderator: { _id: 'users|reviewer', firstName: 'Review', lastName: 'Fixture' },
    });
    assert.equal(r.buttons.get('Resolve as Reviewer-Approver')?.disabled, true);
    await act(async () => wait.resolve({ ...DISPUTE, status: 'moderator_review', moderatorId: 'users|reviewer' }));
    await r.render();
    assert.equal(r.buttons.get('Resolve as Reviewer-Approver')?.disabled, false);
    assert.equal(r.alerts.length, 0);
    assert.deepEqual(r.calls[0].args, { disputeId: DISPUTE._id, moderatorId: 'users|reviewer' });
  } finally {
    await r.mounted.unmount();
  }
});

test('real mobile close-case old error and finally cannot affect a newer financial decision', async () => {
  const r = rig(true);
  const old = deferred();
  const newer = deferred();
  r.implementations.set('disputes:updateDisputeStatus', () => old.promise);
  r.implementations.set('disputes:resolveDispute', () => newer.promise);
  try {
    await r.render();
    await r.project(resolved(true));
    await r.press('Close Case');
    r.setResource('disputes|2');
    await r.project({ ...DISPUTE, _id: 'disputes|2', resolution: undefined });
    await r.draft();
    await r.press('Submit');
    await act(async () => old.reject(new Error('old close failure')));
    await r.render();
    assert.equal(r.alerts.length, 0);
    assert.equal(r.buttons.get('Submit')?.loading, true);
    await act(async () => newer.resolve({ ...DISPUTE, _id: 'disputes|2', accountingOutcome: 'review' }));
    await r.render();
    assert.equal(r.buttons.get('Submit')?.loading, false);
    assert.equal(r.inputs.get('Resolution Notes')?.value, 'Keep these notes');
    assert.deepEqual(r.calls[0].args, { disputeId: DISPUTE._id, status: 'closed' });
  } finally {
    await r.mounted.unmount();
  }
});

async function enterPartialRefund(r: ReturnType<typeof rig>, amount: string): Promise<void> {
  const input = [...r.inputs.values()].find((props) => String(props.label).startsWith('Refund Amount'));
  assert.ok(input);
  const onChangeText = input.onChangeText;
  assert.ok(typeof onChangeText === 'function');
  await act(async () => Reflect.apply(onChangeText, undefined, [amount]));
  await r.render();
}

for (const amount of [
  '25garbage',
  '25.001',
  '0',
  '-1',
  'NaN',
  'Infinity',
  '1e1',
  '+25',
  '.5',
  '25.',
  '90071992547409.92',
  '90071992547409.91',
]) {
  test(`partial refund ${amount} never dispatches, preserves the draft and gives actionable validation`, async () => {
    const r = rig(true);
    r.implementations.set('disputes:resolveDispute', () => ({ ...DISPUTE, accountingOutcome: 'review' }));
    try {
      await r.render();
      // Adequate gross ensures large inputs are rejected by representation, not the unrelated upper bound.
      await r.project({ escrow: { grossAmount: 90071992547410, amount: 90071992547410 } });
      await r.draft('partial_refund');
      await enterPartialRefund(r, amount);
      assert.equal(r.buttons.get('Submit')?.disabled, false);
      await r.press('Submit');
      assert.equal(r.calls.length, 0, 'invalid editable text must not authorize a different numeric amount');
      assert.equal(r.dialogs.get('reviewer')?.visible, true);
      assert.equal(r.inputs.get('Resolution Notes')?.value, 'Keep these notes');
      assert.equal(
        [...r.inputs.values()].find((props) => String(props.label).startsWith('Refund Amount'))?.value,
        amount,
      );
      assert.equal(r.alerts.at(-1)?.[0], 'Invalid refund amount');
      assert.match(String(r.alerts.at(-1)?.[1]), /Enter.*refund/);
    } finally {
      await r.mounted.unmount();
    }
  });
}

for (const [amount, expected] of [
  [' 25.01 ', 25.01],
  ['0.5', 0.5],
  ['25', 25],
  ['105', 105],
] as const) {
  test(`whole decimal partial refund ${JSON.stringify(amount)} keeps exact SDK payload and review-held draft`, async () => {
    const r = rig(true);
    r.implementations.set('disputes:resolveDispute', () => ({ ...DISPUTE, accountingOutcome: 'review' }));
    try {
      await r.render();
      await r.draft('partial_refund');
      await enterPartialRefund(r, amount);
      await r.press('Submit');
      assert.deepEqual(r.calls, [
        {
          name: 'disputes:resolveDispute',
          args: {
            disputeId: DISPUTE._id,
            resolutionType: 'partial_refund',
            refundAmount: expected,
            notes: 'Keep these notes',
          },
        },
      ]);
      assert.equal(r.dialogs.get('reviewer')?.visible, true);
      assert.equal(r.inputs.get('Resolution Notes')?.value, 'Keep these notes');
      assert.equal(r.alerts.at(-1)?.[0], 'Accounting review pending');
    } finally {
      await r.mounted.unmount();
    }
  });
}

test('partial refund above the unchanged gross limit stays locally blocked', async () => {
  const r = rig(true);
  try {
    await r.render();
    await r.draft('partial_refund');
    await enterPartialRefund(r, '105.01');
    await r.press('Submit');
    assert.equal(r.calls.length, 0);
    assert.equal(r.dialogs.get('reviewer')?.visible, true);
    assert.equal(r.inputs.get('Resolution Notes')?.value, 'Keep these notes');
    assert.equal(r.alerts.at(-1)?.[0], 'Invalid refund amount');
  } finally {
    await r.mounted.unmount();
  }
});

function refundFundingFixture(): ReturnType<typeof createDb> {
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

test('whole decimal partial refund travels from actual reviewer UI through funded registered accounting to buyer wallet', async () => {
  const db = refundFundingFixture();
  db.tables.cartItems = [db.tables.cartItems[0]];
  db.tables.users.push({ ...db.tables.users[0], _id: 'users|reviewer', clerkId: 'reviewer', role: 'moderator' });
  const buyerCtx = createCtx(db, 'buyer');
  const selectors = {
    source: 'cart',
    shippingAddress: {
      street: 'Street',
      city: 'Lusaka',
      province: 'Lusaka',
      country: 'Zambia',
      phone: '0971234567',
    },
  };
  const quoted = await invokeFakeFunction(checkoutQuoteModule.quoteCheckout, buyerCtx, selectors);
  assertRegisteredRecord(quoted);
  assertRegisteredRecord(quoted.quote);
  assert.equal(quoted.ok, true);
  assert.equal(quoted.quote.totalAmountCents, 10500);
  const purchase = await invokeFakeFunction(paymentOperationsModule.purchaseWithWallet, buyerCtx, {
    ...selectors,
    expectedQuoteKey: quoted.quote.quoteKey,
    requestId: 'checkout_11111111-2222-4333-8444-555555555555',
  });
  assertRegisteredRecord(purchase);
  assert.equal(purchase.ok, true);
  const order = db.tables.orders[0];
  assert.equal(db.tables.wallets[0].balance, 895);
  // Business-only delivered projection lets the actual create-dispute handler move the funded hold into dispute.
  await db.patch(String(order._id), { status: 'delivered' });
  const disputeId = await invokeFakeFunction(disputesModule.createDispute, buyerCtx, {
    orderId: order._id,
    title: DISPUTE.title,
    description: DISPUTE.description,
    category: DISPUTE.category,
    evidence: [],
  });
  assert.ok(typeof disputeId === 'string');
  const reviewerCtx = createCtx(db, 'reviewer');
  const projection = await invokeFakeFunction(disputesModule.getDispute, reviewerCtx, { disputeId });
  assertRegisteredRecord(projection);
  assertRegisteredRecord(projection.escrow);
  assert.equal(projection.escrow.grossAmount, 105);
  const r = rig(true);
  r.setResource(disputeId);
  let applied: unknown;
  r.implementations.set('disputes:resolveDispute', async (args) => {
    applied = await invokeFakeFunction(disputesModule.resolveDispute, reviewerCtx, args);
    return applied;
  });
  try {
    await r.project(projection);
    await r.draft('partial_refund');
    await enterPartialRefund(r, ' 25.01 ');
    assert.equal(r.buttons.get('Submit')?.disabled, false);
    await r.press('Submit');
    assert.deepEqual(r.calls, [
      {
        name: 'disputes:resolveDispute',
        args: {
          disputeId,
          resolutionType: 'partial_refund',
          refundAmount: 25.01,
          notes: 'Keep these notes',
        },
      },
    ]);
    assert.ok(typeof applied === 'object' && applied !== null && 'accountingOutcome' in applied);
    assert.equal(applied.accountingOutcome, 'applied');
    assert.equal(db.tables.wallets[0].balance, 920.01);
    assert.equal(db.tables.escrow[0].refundAmount, 25.01);
    const proof = db.tables.escrow[0].lifecycleProof;
    assert.ok(typeof proof === 'object' && proof !== null && 'refundCents' in proof);
    assert.equal(proof.refundCents, 2501);
    assert.equal(
      db.tables.walletTransactions.filter((row) => row.userId === USER._id && row.type === 'refund').length,
      1,
    );
    assert.equal(r.alerts.at(-1)?.[0], 'Dispute resolved');
    assert.equal(r.dialogs.get('reviewer')?.visible, false);
    await r.press('Resolve as Reviewer-Approver');
    assert.equal(r.inputs.get('Resolution Notes')?.value, '');
  } finally {
    await r.mounted.unmount();
  }
});

// Registered invocation intentionally returns unknown; validate the object shape before reading producer fields.
function assertRegisteredRecord(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
}
