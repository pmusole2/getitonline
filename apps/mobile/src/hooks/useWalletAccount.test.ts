import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, URL } from 'node:url';

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
import type { useWallet as UseWallet } from './useWallet';

// Runs the real useWallet hook. Convex is a fake that keeps each query's last realtime result, as the client does
// across an auth change, so a test can leave an old account's result in place after a switch. The HTTP service is a
// counting fake. Auth is controlled through the AuthProvider stand-in.

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const repoFile = (relativePath: string) => resolve(repoRoot, relativePath);
const hookFile = repoFile('apps/mobile/src/hooks/useWallet.ts');
const authFile = repoFile('apps/mobile/src/context/AuthProvider.tsx');
const apiFile = repoFile('apps/mobile/src/services/api.ts');

type WalletView = ReturnType<typeof UseWallet>;
type Ref = Parameters<typeof getFunctionName>[0];

const NAME = {
  balance: getFunctionName(api.wallet.getWalletBalance),
  activity: getFunctionName(api.wallet.getWalletActivity),
  transactions: getFunctionName(api.wallet.getWalletTransactions),
  ensure: getFunctionName(api.wallet.ensureWallet),
};

const EXPECTED_KEYS = [
  'activity',
  'balance',
  'canPayWithWallet',
  'clearError',
  'ensureWallet',
  'error',
  'isLoading',
  'operations',
  'refreshActivity',
  'refreshBalance',
  'refreshTransactions',
  'topUp',
  'transactions',
  'withdrawToBank',
  'withdrawToMobileMoney',
];

interface Reads {
  readonly balance: Props;
  readonly activity: Props;
  readonly transactions: Props[];
}

// Each call returns new objects, as Convex does for each new result. Shared references model a result that did not change.
function readsFor(tag: string, amount: number): Reads {
  const transaction = {
    _id: `walletTransactions_${tag}`,
    type: 'credit',
    source: 'sale',
    amount,
    balanceAfter: amount,
    status: 'completed',
    description: `Sale ${tag}`,
    reference: `REF-${tag}`,
    createdAt: 1,
  };
  return {
    balance: {
      balance: amount,
      pendingBalance: 0,
      totalEarned: amount,
      totalWithdrawn: 0,
      totalSpent: 0,
      hasWallet: true,
      isActive: true,
      isFrozen: false,
    },
    activity: {
      recentTransactions: [transaction],
      pendingWithdrawals: 0,
      thisMonthEarnings: amount,
      thisMonthWithdrawals: 0,
    },
    transactions: [transaction],
  };
}

function userRecord(clerkId: string): Props {
  return { _id: `users_${clerkId}`, clerkId, role: 'user', isBanned: false, createdAt: 0, updatedAt: 0 };
}

function signedInAs(clerkId: string, overrides: Props = {}): Props {
  return {
    isLoading: false,
    isSignedIn: true,
    user: userRecord(clerkId),
    clerkUser: { id: clerkId },
    authSyncError: null,
    ...overrides,
  };
}

const SIGNED_OUT: Props = { isLoading: false, isSignedIn: false, user: null, clerkUser: null, authSyncError: null };

interface ConvexCall {
  readonly kind: 'query' | 'mutation';
  readonly name: string;
  readonly args: unknown;
}

interface HeldCall {
  readonly name: string;
  readonly settle: (outcome: unknown) => void;
}

interface ConvexFake {
  readonly module: Props;
  // What a realtime subscription holds. An Error is a failed query.
  readonly realtime: Map<string, unknown>;
  // What a one-off read (or mutation) returns when it is not held.
  readonly oneOff: Map<string, unknown>;
  readonly calls: ConvexCall[];
  // Every name a render subscribed to.
  readonly subscriptions: string[];
  // Names whose one-off calls wait until the test releases them.
  readonly hold: Set<string>;
  release(name: string, outcome: unknown): void;
}

function createConvexFake(controls: HarnessControls): ConvexFake {
  const realtime = new Map<string, unknown>();
  const oneOff = new Map<string, unknown>();
  const calls: ConvexCall[] = [];
  const subscriptions: string[] = [];
  const hold = new Set<string>();
  const held: HeldCall[] = [];

  function run(kind: ConvexCall['kind'], name: string, args: unknown): Promise<unknown> {
    calls.push({ kind, name, args });
    return new Promise<unknown>((resolveCall, rejectCall) => {
      const settle = (outcome: unknown) => (outcome instanceof Error ? rejectCall(outcome) : resolveCall(outcome));
      if (hold.has(name)) {
        held.push({ name, settle });
        return;
      }
      settle(oneOff.get(name));
    });
  }

  // One client for the whole render tree, as the Convex provider gives.
  const client = {
    query: (reference: Ref, args: unknown) => run('query', getFunctionName(reference), args),
  };

  return {
    realtime,
    oneOff,
    calls,
    subscriptions,
    hold,
    release(name, outcome) {
      const index = held.findIndex((entry) => entry.name === name);
      const [entry] = held.splice(index, 1);
      entry?.settle(outcome);
    },
    module: {
      __esModule: true,
      useQuery: (reference: Ref, args: unknown) => {
        const name = getFunctionName(reference);
        if (args === 'skip') {
          return undefined;
        }
        subscriptions.push(name);
        const value = realtime.get(name);
        if (value instanceof Error) {
          throw value;
        }
        return value;
      },
      useQueries: (requests: Record<string, { query: Ref }>) => {
        const results: Props = {};
        for (const [key, request] of Object.entries(requests)) {
          const name = getFunctionName(request.query);
          subscriptions.push(name);
          results[key] = realtime.get(name);
        }
        return results;
      },
      useConvex: () => client,
      useMutation: (reference: Ref) => (args: unknown) => {
        void args;
        return run('mutation', getFunctionName(reference), args);
      },
      useConvexAuth: () => controls.convexAuth,
    },
  };
}

interface ApiCounter {
  readonly module: Props;
  calls(): number;
}

// Every method of the generic transport counts, so any HTTP account read shows up.
function countingApi(): ApiCounter {
  let count = 0;
  const record = (): Promise<undefined> => {
    count += 1;
    return Promise.resolve(undefined);
  };
  return {
    module: {
      apiService: withFallback({ get: record, post: record, put: record, patch: record, delete: record }),
    },
    calls: () => count,
  };
}

interface Mounted {
  readonly controls: HarnessControls;
  readonly convex: ConvexFake;
  readonly http: ApiCounter;
  // The view from the latest render.
  wallet(): WalletView;
  // One render. Returns what that render shows, before its effects set state.
  renderOnce(): WalletView;
  // Renders until effects have settled, so the view shows what a settled screen shows.
  settle(): Promise<WalletView>;
  setReads(reads: Reads): void;
}

function mountWallet(auth: Props = signedInAs('clerk_a')): Mounted {
  const controls = createControls();
  controls.auth = auth;
  const convex = createConvexFake(controls);
  const http = countingApi();
  const harness = createHarness({
    controls,
    effects: true,
    convexApi: { api },
    files: {
      [repoFile('apps/mobile/src/hooks/useWalletOperations.ts')]: withFallback({
        useWalletOperations: () => ({ topUp: async () => undefined, withdraw: async () => undefined }),
      }),
      [authFile]: withFallback({ useAppAuth: () => controls.auth }),
      [apiFile]: http.module,
    },
    packages: {
      '@gettitonline/shared': withFallback({ ...shared }),
      'convex/react': convex.module,
    },
  });
  const useHook = harness.load(hookFile).useWallet as typeof UseWallet;
  const holder: { view?: WalletView } = {};
  const Probe = (): null => {
    holder.view = useHook();
    return null;
  };
  const current = (): WalletView => {
    if (holder.view === undefined) {
      throw new Error('the hook must render');
    }
    return holder.view;
  };

  return {
    controls,
    convex,
    http,
    wallet: current,
    renderOnce() {
      harness.render(Probe);
      return current();
    },
    async settle() {
      for (let pass = 0; pass < 4; pass += 1) {
        await harness.settle();
        harness.render(Probe);
      }
      return current();
    },
    setReads(reads) {
      convex.realtime.set(NAME.balance, reads.balance);
      convex.realtime.set(NAME.activity, reads.activity);
      convex.realtime.set(NAME.transactions, reads.transactions);
      convex.oneOff.set(NAME.balance, reads.balance);
      convex.oneOff.set(NAME.activity, reads.activity);
      convex.oneOff.set(NAME.transactions, reads.transactions);
    },
  };
}

describe('useWallet account reads: state clearing', () => {
  it('switching accounts shows none of the old account in the first render, and the old cache stays hidden', async () => {
    const m = mountWallet();
    const a = readsFor('A', 500);
    m.setReads(a);
    assert.deepEqual((await m.settle()).balance, a.balance, 'precondition: A sees its own balance');

    // Clerk has switched to B, but the synced user record is still A's, so B is not verified yet.
    m.controls.auth = signedInAs('clerk_b', { isLoading: true, user: userRecord('clerk_a') });
    const first = m.renderOnce();
    assert.equal(first.balance, null, 'no A balance in the first render after the switch');
    assert.equal(first.activity, null, 'no A activity in the first render after the switch');
    assert.deepEqual(first.transactions, [], 'no A transactions in the first render after the switch');

    // B is verified. Convex still holds A's results, and B's own one-off reads are held until the test releases them.
    for (const name of [NAME.balance, NAME.activity, NAME.transactions]) {
      m.convex.hold.add(name);
    }
    m.controls.auth = signedInAs('clerk_b');
    const verified = await m.settle();
    assert.equal(verified.balance, null, 'B never sees the A balance Convex still holds');
    assert.equal(verified.activity, null, 'B never sees the A activity Convex still holds');
    assert.deepEqual(verified.transactions, [], 'B never sees A transactions');

    // B's realtime results arrive as new objects, and B sees its own wallet. Until they arrive B shows nothing, because
    // the client may still answer with A's results for the same query.
    const b = readsFor('B', 70);
    assert.equal((await m.settle()).balance, null, 'B shows nothing before its own subscription delivers');
    m.setReads(b);
    const settled = await m.settle();
    assert.deepEqual(settled.balance, b.balance, 'B sees its own balance');
    assert.deepEqual(settled.transactions, b.transactions, 'B sees its own transactions');
  });

  it('signing out clears the wallet, even while the old results are still held', async () => {
    const m = mountWallet();
    m.setReads(readsFor('A', 500));
    await m.settle();

    m.controls.auth = SIGNED_OUT;
    const view = await m.settle();

    assert.equal(view.balance, null);
    assert.equal(view.activity, null);
    assert.deepEqual(view.transactions, []);
    assert.equal(view.error, null);
    assert.equal(view.isLoading, false);
  });
});

describe('useWallet account reads: discarding results from another account', () => {
  it('a balance refresh that resolves after the switch is discarded, and B keeps its own balance', async () => {
    const m = mountWallet();
    m.setReads(readsFor('A', 500));
    await m.settle();

    m.convex.hold.add(NAME.balance);
    const pending = m.wallet().refreshBalance();
    assert.equal(
      m.convex.calls.filter((call) => call.name === NAME.balance).length,
      1,
      'the A refresh reached Convex before the switch',
    );

    m.controls.auth = signedInAs('clerk_b');
    const b = readsFor('B', 70);
    m.setReads(b);
    await m.settle();

    m.convex.release(NAME.balance, readsFor('A', 500).balance);
    await pending;
    const view = await m.settle();

    assert.deepEqual(view.balance, b.balance, "A's late balance never reaches B");
    assert.equal(view.error, null);
  });

  it('an ensure started by A cannot read a balance into B after the switch', async () => {
    const m = mountWallet();
    m.setReads(readsFor('A', 500));
    await m.settle();

    m.convex.hold.add(NAME.ensure);
    const pending = m.wallet().ensureWallet();

    m.controls.auth = signedInAs('clerk_b');
    const b = readsFor('B', 70);
    m.setReads(b);
    await m.settle();
    const callsBeforeRelease = m.convex.calls.length;

    m.convex.release(NAME.ensure, { walletId: 'wallets_a' });
    await pending;
    const view = await m.settle();

    const readsAfterRelease = m.convex.calls.slice(callsBeforeRelease).filter((call) => call.name === NAME.balance);
    assert.deepEqual(readsAfterRelease, [], "A's ensure does not read a balance once the account has changed");
    assert.deepEqual(view.balance, b.balance);
  });

  it('a refresh that resolves after sign-out does not put a balance back into the signed-out view', async () => {
    const m = mountWallet();
    m.setReads(readsFor('A', 500));
    await m.settle();

    m.convex.hold.add(NAME.balance);
    const pending = m.wallet().refreshBalance();
    m.controls.auth = SIGNED_OUT;
    await m.settle();

    m.convex.release(NAME.balance, readsFor('A', 500).balance);
    await pending;
    const view = await m.settle();

    assert.equal(view.balance, null);
  });
});

describe('useWallet account reads: no HTTP for account reads', () => {
  it('refresh and ensure read through Convex and make zero HTTP calls', async () => {
    const m = mountWallet();
    m.setReads(readsFor('A', 500));
    await m.settle();

    await m.wallet().refreshBalance();
    await m.wallet().refreshActivity();
    await m.wallet().refreshTransactions(10);
    await m.wallet().ensureWallet();

    assert.equal(m.http.calls(), 0, 'no account read reaches the HTTP service');
    assert.deepEqual(
      m.convex.calls.filter((call) => call.name === NAME.transactions).map((call) => call.args),
      [{ limit: 10 }],
      'a transaction refresh passes its limit to the Convex query',
    );
  });
});

describe('useWallet account reads: ensure then refresh', () => {
  it('ensure creates the wallet through Convex, then reads the balance through Convex and shows it', async () => {
    const m = mountWallet();
    m.setReads(readsFor('A', 500));
    await m.settle();

    const ensured = readsFor('A', 0).balance;
    m.convex.oneOff.set(NAME.balance, ensured);
    await m.wallet().ensureWallet();
    const view = await m.settle();

    assert.deepEqual(
      m.convex.calls.map((call) => `${call.kind}:${call.name}`),
      [`mutation:${NAME.ensure}`, `query:${NAME.balance}`],
      'the mutation runs first, then the refresh reads the balance',
    );
    assert.deepEqual(view.balance, ensured);
    assert.equal(m.http.calls(), 0);
  });
});

describe('useWallet account reads: error state', () => {
  it('a failed realtime query is an error state, and the screen does not crash', async () => {
    const m = mountWallet();
    m.convex.realtime.set(NAME.balance, new Error('wallet unavailable'));

    const view = await m.settle();

    assert.equal(view.error, 'wallet unavailable');
    assert.equal(view.balance, null);
  });

  it('a failed one-off refresh sets the error and resolves, and clearError dismisses it', async () => {
    const m = mountWallet();
    m.setReads(readsFor('A', 500));
    await m.settle();
    m.convex.oneOff.set(NAME.balance, new Error('timeout'));

    await m.wallet().refreshBalance();
    assert.equal((await m.settle()).error, 'timeout');

    m.wallet().clearError();
    assert.equal((await m.settle()).error, null);
  });
});

describe('useWallet account reads: loading and skip', () => {
  it('while auth is unsettled it issues no wallet query and reports loading', async () => {
    const m = mountWallet(signedInAs('clerk_a', { isLoading: true }));
    m.setReads(readsFor('A', 500));

    const view = await m.settle();

    assert.deepEqual(m.convex.subscriptions, [], 'no wallet query is subscribed');
    assert.equal(view.isLoading, true);
    assert.equal(view.balance, null);
  });

  it('while Convex is not yet authenticated it issues no wallet query and reports loading', async () => {
    const m = mountWallet();
    m.controls.convexAuth = { isLoading: true, isAuthenticated: false };
    m.setReads(readsFor('A', 500));

    const view = await m.settle();

    assert.deepEqual(m.convex.subscriptions, []);
    assert.equal(view.isLoading, true);
    assert.equal(view.balance, null);
  });

  it('when Convex is not authenticated and not loading, it still issues no wallet query', async () => {
    const m = mountWallet();
    m.controls.convexAuth = { isLoading: false, isAuthenticated: false };
    m.setReads(readsFor('A', 500));

    const view = await m.settle();

    assert.deepEqual(m.convex.subscriptions, []);
    assert.equal(view.balance, null);
  });
});

describe('useWallet account reads: public return shape', () => {
  it('returns the same keys for a signed-out and a signed-in account', async () => {
    const signedOut = await mountWallet(SIGNED_OUT).settle();
    const m = mountWallet();
    m.setReads(readsFor('A', 500));
    const signedIn = await m.settle();

    assert.deepEqual(Object.keys(signedOut).sort(), EXPECTED_KEYS);
    assert.deepEqual(Object.keys(signedIn).sort(), EXPECTED_KEYS);
  });

  it('signed out, the reads are empty and not loading; signed in, they carry the Convex results', async () => {
    const signedOut = await mountWallet(SIGNED_OUT).settle();
    assert.equal(signedOut.balance, null);
    assert.equal(signedOut.activity, null);
    assert.deepEqual(signedOut.transactions, []);
    assert.equal(signedOut.isLoading, false);
    assert.equal(signedOut.error, null);

    const m = mountWallet();
    const a = readsFor('A', 500);
    m.setReads(a);
    const signedIn = await m.settle();
    assert.deepEqual(signedIn.balance, a.balance);
    assert.deepEqual(signedIn.activity, a.activity);
    assert.deepEqual(signedIn.transactions, a.transactions);
    assert.equal(signedIn.isLoading, false);
  });
});
