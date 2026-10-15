import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

import React, { act, createElement, type ReactNode } from 'react';
import * as ConvexReact from 'convex/react';
import { getFunctionName } from 'convex/server';

import * as shared from '../../../../packages/shared/src/index';
import { api } from '../../../../convex/_generated/api';
import {
  createControls,
  createHarness,
  withFallback,
  type HarnessControls,
  type Props,
} from '../../../../tests/support/componentHarness';
import {
  createFakeConvexClient,
  deliver,
  mountUnderConvex,
  type FakeConvexClient,
} from '../../../../tests/support/realReactRender';
import type { useWallet as UseWallet } from './useWallet';

// Runs the real useWallet with real React and the real convex/react hooks. The Convex client is a fake that delivers
// realtime results through the watch protocol, and keeps a cache for one-off queries. The cache holds the last result
// it saw, as the real client does across an auth change. Auth is controlled through the AuthProvider stand-in.

type WalletView = ReturnType<typeof UseWallet>;
type Reference = Parameters<typeof getFunctionName>[0];

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const file = (path: string) => resolve(root, path);
const hookFile = file('apps/mobile/src/hooks/useWallet.ts');
const authFile = file('apps/mobile/src/context/AuthProvider.tsx');
const apiFile = file('apps/mobile/src/services/api.ts');

const BALANCE = getFunctionName(api.wallet.getWalletBalance);
const ACTIVITY = getFunctionName(api.wallet.getWalletActivity);
const TRANSACTIONS = getFunctionName(api.wallet.getWalletTransactions);

// Values are tagged with their account, so a test can tell whose wallet a view shows.
function balanceOf(tag: string, amount: number): Props {
  return {
    balance: amount,
    pendingBalance: 0,
    totalEarned: amount,
    totalWithdrawn: 0,
    totalSpent: 0,
    hasWallet: true,
    isActive: true,
    isFrozen: false,
    tag,
  };
}

function activityOf(tag: string, amount: number): Props {
  return {
    recentTransactions: [{ _id: `activity_${tag}_${amount}`, description: `${tag}-transaction`, amount }],
    pendingWithdrawals: 0,
    thisMonthEarnings: amount,
    thisMonthWithdrawals: 0,
  };
}

function transactionsOf(tag: string, amount: number): Props[] {
  return [{ _id: `transaction_${tag}_${amount}`, description: `${tag}-transaction`, amount }];
}

function signedInAs(clerkId: string, overrides: Props = {}): Props {
  return {
    isLoading: false,
    isSignedIn: true,
    user: { _id: `users_${clerkId}`, clerkId, role: 'user', isBanned: false, createdAt: 0, updatedAt: 0 },
    clerkUser: { id: clerkId },
    authSyncError: null,
    ...overrides,
  };
}

interface WalletConvex {
  readonly convex: FakeConvexClient;
  // What the client holds for each query. A realtime delivery replaces it, and a one-off read answers from it.
  readonly cache: Map<string, unknown>;
  // Every one-off read issued, by query name.
  readonly oneOffs: string[];
  // Holds one-off reads for a query name until the test releases them with the server's answer.
  hold(name: string): void;
  release(name: string, value: unknown, which?: 'oldest' | 'newest'): void;
  // A realtime delivery, which also updates what a one-off read would return.
  push(name: string, value: unknown): Promise<void>;
}

interface WaitingRead {
  readonly name: string;
  readonly resolve: (value: unknown) => void;
}

function createWalletConvex(): WalletConvex {
  const base = createFakeConvexClient();
  const cache = new Map<string, unknown>();
  const oneOffs: string[] = [];
  const holding = new Set<string>();
  const waiting: WaitingRead[] = [];

  // Object.assign adds the one-off method to the fake client, which is what useConvex hands to the hook.
  Object.assign(base.client, {
    query(reference: Reference): Promise<unknown> {
      const name = getFunctionName(reference);
      oneOffs.push(name);
      if (holding.has(name)) {
        return new Promise<unknown>((resolveRead) => {
          waiting.push({ name, resolve: resolveRead });
        });
      }
      return Promise.resolve(cache.get(name));
    },
  });

  return {
    convex: base,
    cache,
    oneOffs,
    hold(name) {
      holding.add(name);
    },
    release(name, value, which = 'oldest') {
      const matching = waiting.filter((read) => read.name === name);
      const target = which === 'oldest' ? matching[0] : matching[matching.length - 1];
      if (target === undefined) {
        throw new Error(`no held one-off read for ${name}`);
      }
      waiting.splice(waiting.indexOf(target), 1);
      target.resolve(value);
    },
    async push(name, value) {
      cache.set(name, value);
      await deliver(base, name, value);
    },
  };
}

// The provider takes the client as a prop, so a test can give the hook a different client instance mid-mount.
interface ProviderModule {
  ConvexProvider(props: { client: object; children?: ReactNode }): ReactNode | Promise<ReactNode>;
}

const providers: ProviderModule = ConvexReact;

interface Mounted {
  readonly controls: HarnessControls;
  readonly wallet: WalletConvex;
  // The latest view, and how many times the hook rendered.
  readonly observed: { view: WalletView | undefined; renders: number };
  // Renders the parent with a tick, so a parent re-render reaches the hook. The client defaults to the mounted one.
  render(tick?: number, client?: object): Promise<void>;
  unmount(): Promise<void>;
}

function mountWallet(auth: Props): Mounted {
  const controls = createControls();
  controls.auth = auth;
  controls.convexAuth = { isLoading: false, isAuthenticated: true };
  const wallet = createWalletConvex();
  const harness = createHarness({
    controls,
    convexApi: { api },
    files: {
      [file('apps/mobile/src/hooks/useWalletOperations.ts')]: withFallback({
        useWalletOperations: () => ({ topUp: async () => undefined, withdraw: async () => undefined }),
      }),
      [authFile]: withFallback({ useAppAuth: () => controls.auth }),
      [apiFile]: withFallback({}),
    },
    packages: {
      react: React,
      'convex/react': withFallback({ ...ConvexReact, useConvexAuth: () => controls.convexAuth }),
      '@gettitonline/shared': withFallback({ ...shared }),
    },
  });
  const useWallet = harness.load(hookFile).useWallet as typeof UseWallet;
  const observed: { view: WalletView | undefined; renders: number } = { view: undefined, renders: 0 };

  function Probe(): null {
    observed.renders += 1;
    observed.view = useWallet();
    return null;
  }
  // A parent that re-renders with a new tick, so the hook sees a render it did not cause. It provides the client the
  // hook reads, in the same position every render, so the hook keeps its state when the client changes.
  function Parent({ tick, client }: { readonly tick: number; readonly client: object }) {
    void tick;
    return createElement(providers.ConvexProvider, { client }, createElement(Probe));
  }

  const mounted = mountUnderConvex(wallet.convex);
  return {
    controls,
    wallet,
    observed,
    async render(tick = 0, client: object = wallet.convex.client) {
      await mounted.render(createElement(Parent, { tick, client }));
    },
    unmount: () => mounted.unmount(),
  };
}

function viewOf(m: Mounted): WalletView {
  if (m.observed.view === undefined) {
    throw new Error('the hook must render');
  }
  return m.observed.view;
}

// Runs a refresh inside act, so the state it sets is flushed before the test reads the view.
async function refresh(m: Mounted, action: () => Promise<void>): Promise<void> {
  await act(async () => {
    await action();
  });
  await m.render();
}

test('switching to another account shows none of the old account, even when Convex still returns the old results', async () => {
  const m = mountWallet(signedInAs('clerk_a'));
  await m.render();
  await m.wallet.push(BALANCE, balanceOf('A', 500));
  await m.wallet.push(ACTIVITY, activityOf('A', 500));
  await m.wallet.push(TRANSACTIONS, transactionsOf('A', 500));
  assert.equal(viewOf(m).balance?.balance, 500, 'precondition: A sees its own balance');

  // The auth switch to B is verified, and the client still answers with A's cached results.
  m.controls.auth = signedInAs('clerk_b');
  await m.render();
  const view = viewOf(m);
  assert.equal(view.balance, null, 'B does not show the A balance the cache still holds');
  assert.equal(view.activity, null, 'B does not show the A activity');
  assert.deepEqual(view.transactions, [], 'B does not show A transactions');
  assert.equal(view.error, null);

  await refresh(m, () => viewOf(m).refreshBalance());
  await refresh(m, () => viewOf(m).refreshActivity());
  await refresh(m, () => viewOf(m).refreshTransactions());
  const after = viewOf(m);
  assert.equal(after.balance, null, 'a refresh for B does not read A the cache holds');
  assert.equal(after.activity, null);
  assert.deepEqual(after.transactions, []);
  assert.deepEqual(m.wallet.oneOffs, [], 'no one-off read is issued for B before its subscription delivers');

  await m.wallet.push(BALANCE, balanceOf('B', 70));
  await m.wallet.push(ACTIVITY, activityOf('B', 70));
  await m.wallet.push(TRANSACTIONS, transactionsOf('B', 70));
  await m.render();
  assert.equal(viewOf(m).balance?.balance, 70, 'B sees its own balance once its subscription delivers');
  assert.deepEqual(
    viewOf(m).transactions.map((t) => t.description),
    ['B-transaction'],
  );
  await m.unmount();
});

test('a one-off refresh started before a newer realtime value does not replace that value', async () => {
  const m = mountWallet(signedInAs('clerk_a'));
  await m.render();
  await m.wallet.push(BALANCE, balanceOf('A', 500));
  await m.render();

  m.wallet.hold(BALANCE);
  const pending = viewOf(m).refreshBalance();
  assert.equal(m.wallet.oneOffs.filter((name) => name === BALANCE).length, 1, 'the refresh reached the client');

  // A newer realtime value commits while the refresh is in flight. Then the refresh's older answer arrives.
  await m.wallet.push(BALANCE, balanceOf('A', 400));
  await act(async () => {
    m.wallet.release(BALANCE, balanceOf('A', 500));
    await pending;
  });
  await m.render();

  assert.equal(
    viewOf(m).balance?.balance,
    400,
    'the older refresh reply (500) does not overwrite the newer realtime value',
  );
  await m.unmount();
});

test('a one-off refresh that still matches the newest value applies its reply', async () => {
  const m = mountWallet(signedInAs('clerk_a'));
  await m.render();
  await m.wallet.push(BALANCE, balanceOf('A', 500));
  await m.render();

  m.wallet.hold(BALANCE);
  const pending = viewOf(m).refreshBalance();
  await act(async () => {
    m.wallet.release(BALANCE, balanceOf('A', 600));
    await pending;
  });
  await m.render();

  assert.equal(viewOf(m).balance?.balance, 600, 'with no newer realtime value, the refresh reply is shown');
  await m.unmount();
});

test('a newer refresh supersedes an older one, so the older reply is dropped', async () => {
  const m = mountWallet(signedInAs('clerk_a'));
  await m.render();
  await m.wallet.push(BALANCE, balanceOf('A', 500));
  await m.render();

  m.wallet.hold(BALANCE);
  const older = viewOf(m).refreshBalance();
  const newer = viewOf(m).refreshBalance();
  await act(async () => {
    m.wallet.release(BALANCE, balanceOf('A', 700), 'newest');
    await newer;
    m.wallet.release(BALANCE, balanceOf('A', 500), 'oldest');
    await older;
  });
  await m.render();

  assert.equal(viewOf(m).balance?.balance, 700, 'the older reply (500) arriving last does not replace the newer one');
  await m.unmount();
});

test('the wallet subscriptions keep their identity across parent re-renders, so the render count stays bounded', async () => {
  const m = mountWallet(signedInAs('clerk_a'));
  await m.render(0);
  await m.wallet.push(BALANCE, balanceOf('A', 500));
  for (let tick = 1; tick <= 5; tick += 1) {
    await m.render(tick);
  }

  const subscribes = m.wallet.convex.lifecycle.filter((event) => event.startsWith('subscribe:'));
  assert.deepEqual(
    subscribes,
    [`subscribe:${BALANCE}`, `subscribe:${ACTIVITY}`, `subscribe:${TRANSACTIONS}`],
    'the three reads subscribe once and are not re-subscribed on re-render',
  );
  assert.ok(m.observed.renders <= 16, `rendered ${m.observed.renders} times`);
  assert.equal(viewOf(m).balance?.balance, 500);
  await m.unmount();
});

test('the same owner on the same client gets its values back after readiness is temporarily unsettled', async () => {
  const m = mountWallet(signedInAs('clerk_a'));
  await m.render();
  await m.wallet.push(BALANCE, balanceOf('A', 500));
  await m.wallet.push(ACTIVITY, activityOf('A', 500));
  await m.wallet.push(TRANSACTIONS, transactionsOf('A', 500));
  assert.equal(viewOf(m).balance?.balance, 500, 'precondition: A sees its own balance');

  // Readiness drops from the auth state, then returns for the same account on the same client. The client's cache
  // still holds A's results, which are A's own, so they are shown again once readiness is back.
  m.controls.auth = signedInAs('clerk_a', { isLoading: true });
  await m.render();
  assert.equal(viewOf(m).balance, null, 'values are hidden while readiness is unsettled');

  m.controls.auth = signedInAs('clerk_a');
  await m.render();
  const recovered = viewOf(m);
  assert.equal(recovered.balance?.balance, 500, 'the same owner sees its balance again after recovery');
  assert.equal(recovered.activity?.thisMonthEarnings, 500, 'the same owner sees its activity again');
  assert.deepEqual(
    recovered.transactions.map((t) => t.description),
    ['A-transaction'],
    'the same owner sees its transactions again',
  );
  assert.equal(recovered.isLoading, false, 'recovery does not leave the wallet loading');

  // The same recovery holds when the unsettled state comes from the Convex auth state instead of the app auth.
  m.controls.convexAuth = { isLoading: true, isAuthenticated: true };
  await m.render();
  assert.equal(viewOf(m).balance, null, 'values are hidden while Convex auth is loading');
  m.controls.convexAuth = { isLoading: false, isAuthenticated: true };
  await m.render();
  assert.equal(viewOf(m).balance?.balance, 500, 'the same owner sees its balance after Convex auth settles');
  await m.unmount();
});

test('a different client instance for the same owner does not show the old client values until its own results arrive', async () => {
  const m = mountWallet(signedInAs('clerk_a'));
  await m.render();
  await m.wallet.push(BALANCE, balanceOf('A', 500));
  await m.wallet.push(ACTIVITY, activityOf('A', 500));
  await m.wallet.push(TRANSACTIONS, transactionsOf('A', 500));
  assert.equal(viewOf(m).balance?.balance, 500, 'precondition: A sees its own balance on the first client');

  // The same owner resubscribes through a second client whose cache holds nothing yet.
  const second = createWalletConvex();
  await m.render(1, second.convex.client);
  assert.equal(viewOf(m).balance, null, 'the first client value is not carried onto the second client');
  assert.equal(viewOf(m).activity, null);
  assert.deepEqual(viewOf(m).transactions, []);

  await second.push(BALANCE, balanceOf('A', 300));
  await second.push(ACTIVITY, activityOf('A', 300));
  await second.push(TRANSACTIONS, transactionsOf('A', 300));
  await m.render(2, second.convex.client);
  assert.equal(viewOf(m).balance?.balance, 300, 'the second client shows its own fresh value');
  assert.equal(viewOf(m).error, null);
  await m.unmount();
});
