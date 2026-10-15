import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

import React, { act, createElement, type ReactNode } from 'react';
import * as ConvexReact from 'convex/react';
import { getFunctionName } from 'convex/server';

import * as shared from '../../../../packages/shared/src/index';
import { api } from '../../../../convex/_generated/api';
import * as providerOperations from '../../../../convex/providerOperations';
import * as providerSettlement from '../../../../convex/providerSettlement';
import * as reconciliation from '../../../../convex/paymentReconciliation';
import * as reconciliationData from '../../../../convex/paymentReconciliationData';
import * as paymentOperations from '../../../../convex/paymentOperations';
import { createFakeActionCtx, invokeFakeFunction } from '../../../../tests/support/convexFakeActionCtx';
import { createDb, createCtx } from '../../../../tests/support/convexFakeDb';
import { createControls, createHarness, withFallback, type Props } from '../../../../tests/support/componentHarness';
import { createFakeConvexClient, deliver, mountUnderConvex } from '../../../../tests/support/realReactRender';
import type { RecoveryStorage, WalletRecovery } from '../services/walletOperationState';
import type { WalletOperations } from './useWalletOperations';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const file = (path: string): string => resolve(root, path);
const uuid = '11111111-2222-4333-8444-555555555555';
const key = '@gettit/wallet-operation/v1/clerk_a';
const recovery: WalletRecovery = { version: 1, kind: 'top_up_collection', requestId: `wallet_${uuid}` };
const name = (ref: Parameters<typeof getFunctionName>[0]): string => getFunctionName(ref);
const TOPUP = name(api.providerOperations.initiateTopUpCollection);
const WITHDRAW = name(api.providerOperations.initiateWithdrawal);
const REGISTER = name(api.providerOperations.registerPaymentAccount);
const BANKS = name(api.providerOperations.listBanks);
const ACCOUNTS = name(api.providerOperations.listPaymentAccounts);
const STATUS = name(api.paymentReconciliation.getStatus);
const REFRESH = name(api.paymentReconciliation.refresh);
const AVAILABILITY = name(api.appConfig.getPaymentAvailability);
const mm = {
  accountId: 'paymentAccounts|mm',
  type: 'mobile_money',
  destinationKey: 'mm:zm:mtn:0971234567',
  phone: '0971234567',
  operator: 'mtn',
  accountName: 'Synthetic Resolved',
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
  accountName: 'Synthetic Resolved',
  isVerified: true,
  providerResolvedAt: 1,
};
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
function found(token: WalletRecovery = recovery, changes: Props = {}): Props {
  return {
    result: 'found',
    operationId: 'paymentOperations|1',
    requestId: token.requestId,
    requestIdentity: null,
    kind: token.kind,
    status: 'attempted',
    providerStatus: 'pending',
    application: 'pending',
    accountingApplied: false,
    reviewNeeded: false,
    amountCents: 1000,
    quoteKey: null,
    source: null,
    orderIds: [],
    feeCents: null,
    ...changes,
  };
}
function mount(
  options: {
    storage?: ReturnType<typeof memory>;
    auth?: Props;
    actualWallet?: boolean;
    operationState?: typeof import('../services/walletOperationState');
  } = {},
) {
  const controls = createControls();
  controls.auth = options.auth ?? ready();
  const storage = options.storage ?? memory();
  const convex = createFakeConvexClient({ [AVAILABILITY]: { paymentsEnabled: true }, [ACCOUNTS]: [mm, bank] });
  const calls: { name: string; args: Props }[] = [];
  const handlers = new Map<string, (args: Props) => Promise<unknown>>();
  const queryHandlers = new Map<string, (args: Props) => Promise<unknown>>();
  Object.assign(convex.client, {
    action: async (ref: Parameters<typeof getFunctionName>[0], args: Props) => {
      const called = name(ref);
      calls.push({ name: called, args });
      const handler = handlers.get(called);
      if (handler) return await handler(args);
      if (called === BANKS) return { ok: true, banks: [{ id: 'directory-id', name: 'Directory Bank', country: 'zm' }] };
      if (called === REGISTER) return { accountId: mm.accountId, destinationKey: mm.destinationKey };
      if (called === REFRESH) return null;
      return { ok: true, operationId: 'paymentOperations|1', status: 'attempted', providerReference: 'opaque' };
    },
    query: async (ref: Parameters<typeof getFunctionName>[0], args: Props) => {
      const called = name(ref);
      calls.push({ name: called, args });
      const handler = queryHandlers.get(called);
      return handler ? await handler(args) : called === ACCOUNTS ? [mm, bank] : null;
    },
  });
  let ids = storage.values.has(key) ? 1 : 0;
  const harness = createHarness({
    controls,
    convexApi: { api },
    files: {
      ...(options.operationState
        ? { [file('apps/mobile/src/services/walletOperationState.ts')]: options.operationState }
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
        randomUUID: () => {
          ids += 1;
          return ids === 1 ? uuid : 'aaaaaaaa-2222-4333-8444-555555555555';
        },
      },
    },
  });
  const useOperations = harness.load(file('apps/mobile/src/hooks/useWalletOperations.ts'))
    .useWalletOperations as () => WalletOperations;
  const useWallet = options.actualWallet
    ? (harness.load(file('apps/mobile/src/hooks/useWallet.ts')).useWallet as () => { operations: WalletOperations })
    : null;
  let observed: WalletOperations | undefined;
  function OperationsProbe(): null {
    observed = useOperations();
    return null;
  }
  function WalletProbe(): null {
    assert.ok(useWallet);
    observed = useWallet().operations;
    return null;
  }
  const Probe = options.actualWallet ? WalletProbe : OperationsProbe;
  const providers: { ConvexProvider(props: { client: object; children?: ReactNode }): ReactNode | Promise<ReactNode> } =
    ConvexReact;
  const mounted = mountUnderConvex(convex);
  return {
    controls,
    storage,
    uuidCount: (): number => ids,
    operationState: harness.load(
      file('apps/mobile/src/services/walletOperationState.ts'),
    ) as typeof import('../services/walletOperationState'),
    convex,
    calls,
    handlers,
    queryHandlers,
    view: (): WalletOperations => {
      assert.ok(observed);
      return observed;
    },
    render: (client: object = convex.client) =>
      mounted.render(createElement(providers.ConvexProvider, { client }, createElement(Probe))),
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

test('actual useWallet consumes authenticated top-up with exact cents for every Zambia operator and no HTTP', async () => {
  for (const operator of ['airtel', 'mtn', 'zamtel'] as const) {
    const m = mount({ actualWallet: true });
    await m.render();
    assert.equal(m.view().ready, true);
    await m.invoke(() => m.view().topUp('10.01', '0971234567', operator));
    assert.deepEqual(m.calls, [
      { name: TOPUP, args: { requestId: recovery.requestId, amountCents: 1001, phone: '0971234567', operator } },
    ]);
    assert.deepEqual(JSON.parse(m.storage.values.get(key) ?? ''), recovery);
    assert.equal(m.view().outcome, 'unknown', 'initiation success is never money success');
    await m.unmount();
  }
});

test('malformed amounts and unresolved approvals dispatch no financial action', async () => {
  const m = mount();
  await m.render();
  for (const amount of ['10oops', '1.001', 'NaN', 'Infinity', '-1', '90071992547409.92']) {
    await m.invoke(() => m.view().topUp(amount, '0971234567', 'mtn'));
  }
  const account = m.view().accounts[0];
  assert.ok(account);
  await m.invoke(() => m.view().withdraw('10', account.accountId, 'unapproved-key'));
  await m.push(ACCOUNTS, [
    { ...mm, isVerified: false },
    { ...bank, providerResolvedAt: null },
  ]);
  await m.invoke(() => m.view().withdraw('10', account.accountId, mm.destinationKey));
  assert.equal(m.calls.length, 0);
  assert.equal(m.storage.values.size, 0);
  await m.unmount();
});

test('signed out, unknown, banned, deleted, sync failed, mismatched and pending Convex actors issue no private query or action', async () => {
  const denied = [
    { ...ready(), isSignedIn: false, user: null, clerkUser: null },
    { ...ready(), isLoading: true },
    { ...ready(), user: null },
    { ...ready(), user: { ...(ready().user as Props), isBanned: true } },
    { ...ready(), user: { ...(ready().user as Props), deletedAt: 1 } },
    { ...ready(), authSyncError: 'failed' },
    { ...ready(), clerkUser: { id: 'other' } },
  ];
  for (const auth of denied) {
    const m = mount({ auth });
    await m.render();
    await m.invoke(() => m.view().topUp('10', '0971234567', 'mtn'));
    await m.invoke(() => m.view().loadBanks());
    assert.equal(m.calls.length, 0, JSON.stringify(auth));
    assert.equal(m.view().accounts.length, 0);
    assert.ok(!m.convex.lifecycle.includes(`subscribe:${ACCOUNTS}`));
    await m.unmount();
  }
  for (const convexAuth of [
    { isLoading: true, isAuthenticated: true },
    { isLoading: false, isAuthenticated: false },
  ]) {
    const m = mount();
    m.controls.convexAuth = convexAuth;
    await m.render();
    await m.invoke(() => m.view().topUp('10', '0971234567', 'mtn'));
    assert.equal(m.calls.length, 0);
    assert.equal(m.view().accounts.length, 0);
    assert.ok(!m.convex.lifecycle.includes(`subscribe:${ACCOUNTS}`));
    await m.unmount();
  }
});

test('duplicate taps share one durable request; lost response, null lookup and remount never reinitiate', async () => {
  const m = mount();
  const held = deferred<unknown>();
  m.handlers.set(TOPUP, () => held.promise);
  await m.render();
  let first: Promise<void> = Promise.resolve();
  await act(async () => {
    first = m.view().topUp('10', '0971234567', 'mtn');
    await Promise.resolve();
  });
  await m.invoke(() => m.view().topUp('20', '0971234567', 'airtel'));
  assert.equal(m.calls.filter((call) => call.name === TOPUP).length, 1);
  await act(async () => {
    held.reject(Error('lost response'));
    await first;
  });
  assert.deepEqual(m.view().recovery, recovery);
  await m.invoke(() => m.view().checkStatus());
  assert.deepEqual(m.calls.find((call) => call.name === REFRESH)?.args, { requestId: recovery.requestId });
  await m.invoke(() => m.view().newSubmission());
  await m.invoke(() => m.view().topUp('10', '0971234567', 'mtn'));
  assert.equal(m.calls.filter((call) => call.name === TOPUP).length, 1);
  await m.unmount();
  const next = mount({ storage: m.storage });
  await next.render();
  assert.deepEqual(next.view().recovery, recovery);
  await next.invoke(() => next.view().topUp('10', '0971234567', 'mtn'));
  assert.equal(next.calls.length, 0);
  assert.ok(next.convex.lifecycle.includes(`subscribe:${STATUS}`));
  await next.unmount();
});

test('storage failure and corruption fail closed before any financial action', async () => {
  const s = memory();
  s.setItem = async () => {
    throw Error('disk full');
  };
  const m = mount({ storage: s });
  await m.render();
  await m.invoke(() => m.view().topUp('10', '0971234567', 'mtn'));
  assert.equal(m.calls.length, 0);
  assert.ok(m.view().error);
  await m.unmount();
  for (const raw of ['broken', JSON.stringify({ ...recovery, phone: 'forbidden' })]) {
    const s = memory();
    s.values.set(key, raw);
    const m = mount({ storage: s });
    await m.render();
    assert.equal(m.view().ready, false);
    await m.invoke(() => m.view().topUp('10', '0971234567', 'mtn'));
    assert.equal(m.calls.length, 0);
    assert.equal(s.values.get(key), raw);
    await m.unmount();
  }
});

test('directory ids and server-resolved owned approval govern mobile and bank withdrawal; registration never transfers', async () => {
  for (const type of ['mobile_money', 'bank_account'] as const) {
    const m = mount();
    await m.render();
    if (type === 'bank_account') await m.invoke(() => m.view().loadBanks());
    const account = m.view().accounts.find((entry) => entry.type === type);
    assert.ok(account);
    const destination =
      type === 'mobile_money'
        ? { type, phone: '0971234567', operator: 'mtn' as const }
        : { type, bankId: m.view().banks[0].id, accountNumber: '1234567890' };
    m.handlers.set(REGISTER, async () => ({ accountId: account.accountId, destinationKey: account.destinationKey }));
    await m.invoke(() => m.view().registerDestination(destination));
    assert.equal(m.calls.filter((call) => call.name === WITHDRAW).length, 0);
    assert.deepEqual(m.calls.find((call) => call.name === REGISTER)?.args, { destination });
    await m.invoke(() => m.view().withdraw('10.25', account.accountId, account.destinationKey));
    assert.deepEqual(m.calls.find((call) => call.name === WITHDRAW)?.args, {
      requestId: recovery.requestId,
      amountCents: 1025,
      paymentAccountId: account.accountId,
      expectedDestinationKey: account.destinationKey,
    });
    await m.unmount();
  }
});

test('destination mismatch requires explicit renewed approval and never retries with the returned key', async () => {
  const m = mount();
  await m.render();
  const account = m.view().accounts[0];
  assert.ok(account);
  m.handlers.set(WITHDRAW, async () => ({ ok: false, code: 'destination_mismatch', destinationKey: 'new-key' }));
  await m.invoke(() => m.view().withdraw('10', account.accountId, account.destinationKey));
  assert.equal(m.calls.filter((call) => call.name === WITHDRAW).length, 1);
  assert.equal(m.view().recovery, null);
  assert.equal(m.view().approvalRevision, 1);
  assert.match(m.view().error ?? '', /explicitly approve again/);
  assert.equal(m.storage.values.size, 0);
  await m.unmount();
});

test('switch off blocks new initiation but preserves owed recovery, review priority and proven failure/completion', async () => {
  const s = memory();
  s.values.set(key, JSON.stringify(recovery));
  const m = mount({ storage: s });
  await m.render();
  await m.push(AVAILABILITY, { paymentsEnabled: false });
  await m.invoke(() => m.view().topUp('10', '0971234567', 'mtn'));
  m.handlers.set(REFRESH, async () => found());
  await m.invoke(() => m.view().checkStatus());
  assert.equal(m.view().outcome, 'pending');
  for (const [patch, outcome] of [
    [{ status: 'unknown', providerStatus: 'unknown' }, 'unknown'],
    [{ status: 'failed' }, 'pending'],
    [
      {
        status: 'succeeded',
        providerStatus: 'successful',
        application: 'applied',
        accountingApplied: true,
        reviewNeeded: true,
      },
      'review',
    ],
    [{ status: 'failed', providerStatus: 'failed', application: 'applied', accountingApplied: true }, 'failed'],
    [
      { status: 'succeeded', providerStatus: 'successful', application: 'applied', accountingApplied: true },
      'completed',
    ],
  ] as const) {
    await m.push(STATUS, found(recovery, patch));
    assert.equal(m.view().outcome, outcome);
  }
  assert.equal(m.calls.filter((call) => call.name === TOPUP).length, 0);
  await m.invoke(() => m.view().newSubmission());
  assert.equal(m.view().recovery, null);
  assert.equal(m.storage.values.size, 0);
  await m.unmount();
});

for (const stage of ['banks', 'registration', 'intent', 'refresh', 'storage'] as const) {
  test(`deferred ${stage} retires on signout, account/client replacement, unmount and A→B→A`, async () => {
    for (const boundary of [
      'signout',
      'account',
      'client',
      'unmount',
      'aba',
      'banned',
      'deleted',
      'sync',
      'pending',
    ] as const) {
      const s = memory();
      if (stage === 'refresh') s.values.set(key, JSON.stringify(recovery));
      const m = mount({ storage: s });
      const held = deferred<unknown>();
      await m.render();
      let work: () => Promise<void>;
      if (stage === 'banks') {
        m.handlers.set(BANKS, () => held.promise);
        work = () => m.view().loadBanks();
      } else if (stage === 'registration') {
        m.handlers.set(REGISTER, () => held.promise);
        work = () => m.view().registerDestination({ type: 'mobile_money', phone: '0971234567', operator: 'mtn' });
      } else if (stage === 'refresh') {
        m.handlers.set(REFRESH, () => held.promise);
        work = () => m.view().checkStatus();
      } else {
        if (stage === 'storage')
          s.setItem = async (key, value) => {
            await held.promise;
            s.values.set(key, value);
          };
        else m.handlers.set(TOPUP, () => held.promise);
        work = () => m.view().topUp('10', '0971234567', 'mtn');
      }
      const old = m.view();
      let pending: Promise<void> = Promise.resolve();
      await act(async () => {
        pending = work();
        await Promise.resolve();
      });
      const before = m.calls.length;
      if (boundary === 'unmount') await m.unmount();
      else if (boundary === 'client') await m.render(createFakeConvexClient().client);
      else {
        m.controls.auth =
          boundary === 'signout'
            ? { ...ready(), isSignedIn: false, user: null }
            : boundary === 'banned'
              ? { ...ready(), user: { ...(ready().user as Props), isBanned: true } }
              : boundary === 'deleted'
                ? { ...ready(), user: { ...(ready().user as Props), deletedAt: 1 } }
                : boundary === 'sync'
                  ? { ...ready(), authSyncError: 'failed' }
                  : boundary === 'pending'
                    ? { ...ready(), isLoading: true }
                    : ready('clerk_b');
        await m.render();
        if (boundary === 'aba') {
          m.controls.auth = ready();
          await m.render();
        }
      }
      assert.equal(old.isCurrent(), false);
      const beforeView = m.view();
      await act(async () => {
        held.resolve(
          stage === 'banks'
            ? { ok: true, banks: [{ id: 'old', name: 'Old Private', country: 'zm' }] }
            : stage === 'registration'
              ? { accountId: mm.accountId, destinationKey: mm.destinationKey }
              : stage === 'refresh'
                ? found()
                : { ok: true, operationId: 'paymentOperations|1', status: 'attempted', providerReference: 'opaque' },
        );
        await pending;
      });
      assert.equal(m.calls.length, before, 'no next SDK stage after retirement');
      if (boundary !== 'unmount') {
        assert.equal(m.view().error, beforeView.error);
        assert.equal(m.view().working, false);
        assert.ok(!m.view().banks.some((bank) => bank.id === 'old'));
        await m.unmount();
      }
    }
  });
}

test('private cached owned destinations disappear immediately on access loss and cannot cross A→B→A', async () => {
  const m = mount();
  await m.render();
  assert.equal(m.view().accounts.length, 2);
  m.controls.auth = { ...ready(), isLoading: true };
  await m.render();
  assert.equal(m.view().accounts.length, 0);
  m.controls.auth = ready('clerk_b');
  await m.render();
  assert.equal(m.view().accounts.length, 0);
  m.controls.auth = ready();
  await m.render();
  assert.equal(m.view().accounts.length, 0);
  await m.push(ACCOUNTS, [{ ...mm }]);
  assert.equal(m.view().accounts.length, 1);
  await m.unmount();
});

test('actual hook reaches real registered top-up and by-request recovery with SDK-valid arguments and owned authority', async () => {
  const db = createDb({
    users: [
      {
        _id: 'users|clerk_a',
        clerkId: 'clerk_a',
        email: 'fixture@example.invalid',
        firstName: 'Synthetic',
        lastName: 'User',
        role: 'user',
        isBanned: false,
        isVerified: true,
        totalSales: 0,
        totalPurchases: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    appConfig: [{ _id: 'appConfig|1', key: 'singleton', paymentsEnabled: true }],
  });
  let posts = 0;
  const action = providerOperations.createTopUpAction({
    env: () => ({ LENCO_API_KEY: 'synthetic-fixture' }),
    fetchImpl: async (_url, init) => {
      posts += 1;
      const body: unknown = JSON.parse(init?.body ?? '{}');
      assert.ok(typeof body === 'object' && body !== null && 'reference' in body);
      assert.equal(db.tables['paymentOperations']?.length, 1, 'real persistence precedes transport');
      return new Response(
        JSON.stringify({
          status: true,
          data: {
            id: '22222222-2222-4333-8444-555555555555',
            reference: body.reference,
            amount: '10.00',
            currency: 'ZMW',
            status: 'pending',
            type: 'mobile-money',
            bearer: 'merchant',
            mobileMoneyDetails: { country: 'zm', operator: 'mtn', phone: '0971234567' },
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
    subject: 'clerk_a',
    modules: {
      providerOperations,
      providerSettlement,
      paymentOperations,
      paymentReconciliation: reconciliation,
      paymentReconciliationData: reconciliationData,
    },
  });
  const m = mount();
  m.handlers.set(TOPUP, (args) => invokeFakeFunction(action, ctx, args));
  m.handlers.set(REFRESH, (args) => invokeFakeFunction(reconciliation.getStatus, createCtx(db, 'clerk_a'), args));
  await m.render();
  await m.invoke(() => m.view().topUp('10.00', '0971234567', 'mtn'));
  assert.equal(posts, 1);
  assert.equal(db.tables['paymentOperations']?.[0]['requestId'], recovery.requestId);
  await m.invoke(() => m.view().checkStatus());
  assert.equal(
    m.view().outcome,
    'pending',
    JSON.stringify({
      error: m.view().error,
      status: db.tables['paymentOperations']?.[0]['status'],
      failure: db.tables['paymentOperations']?.[0]['failureCode'],
    }),
  );
  const other = createFakeActionCtx({ db, subject: null, modules: { paymentReconciliation: reconciliation } });
  await assert.rejects(invokeFakeFunction(reconciliation.getStatus, other, { requestId: recovery.requestId }));
  await assert.rejects(
    invokeFakeFunction(reconciliation.getStatus, createCtx(db, 'clerk_a'), {
      requestId: recovery.requestId,
      operationId: 'paymentOperations|1',
    }),
    /Argument validation failed/,
  );
  await m.unmount();
});

test('captured withdrawal and terminal-clear handlers revalidate current owned key and current recovery proof', async () => {
  const m = mount();
  await m.render();
  const old = m.view();
  const account = old.accounts[0];
  assert.ok(account);
  await m.push(ACCOUNTS, [{ ...mm, destinationKey: 'changed-key' }]);
  await m.invoke(() => old.withdraw('10', account.accountId, account.destinationKey));
  assert.equal(m.calls.length, 0, 'stale owned key must not reach initiation');
  await m.unmount();
  const s = memory();
  s.values.set(key, JSON.stringify(recovery));
  const n = mount({ storage: s });
  await n.render();
  await n.push(
    STATUS,
    found(recovery, {
      status: 'succeeded',
      providerStatus: 'successful',
      application: 'applied',
      accountingApplied: true,
    }),
  );
  const completed = n.view();
  assert.equal(completed.outcome, 'completed');
  await n.push(STATUS, found(recovery, { reviewNeeded: true, application: 'review' }));
  await n.invoke(() => completed.newSubmission());
  assert.deepEqual(n.view().recovery, recovery, 'old success cannot clear a request now held for review');
  assert.ok(s.values.has(key));
  await n.unmount();
});

test('a deferred explicit refresh cannot overwrite a newer reactive review result', async () => {
  const s = memory();
  s.values.set(key, JSON.stringify(recovery));
  const m = mount({ storage: s });
  await m.render();
  const held = deferred<unknown>();
  m.handlers.set(REFRESH, () => held.promise);
  let checking: Promise<void> = Promise.resolve();
  await act(async () => {
    checking = m.view().checkStatus();
  });
  await m.push(STATUS, found(recovery, { reviewNeeded: true, application: 'review' }));
  await act(async () => {
    held.resolve(
      found(recovery, {
        status: 'succeeded',
        providerStatus: 'successful',
        application: 'applied',
        accountingApplied: true,
      }),
    );
    await checking;
  });
  assert.equal(m.view().outcome, 'review');
  assert.deepEqual(m.view().recovery, recovery);
  await m.unmount();
});

test('all mobile operators register without a payout, and invalid owned projections fail closed', async () => {
  for (const operator of ['airtel', 'mtn', 'zamtel'] as const) {
    const m = mount();
    await m.render();
    await m.invoke(() => m.view().registerDestination({ type: 'mobile_money', phone: '0971234567', operator }));
    assert.deepEqual(m.calls.find((call) => call.name === REGISTER)?.args, {
      destination: { type: 'mobile_money', phone: '0971234567', operator },
    });
    assert.equal(
      m.calls.some((call) => call.name === WITHDRAW),
      false,
    );
    await m.unmount();
  }
  const m = mount();
  await m.render();
  const account = m.view().accounts[0];
  assert.ok(account);
  for (const malformed of [
    null,
    {},
    { ...mm, destinationKey: '' },
    { ...mm, isVerified: false },
    { ...mm, providerResolvedAt: NaN },
  ]) {
    await m.push(ACCOUNTS, [malformed]);
    await m.invoke(() => m.view().withdraw('10', account.accountId, account.destinationKey));
  }
  assert.equal(m.calls.length, 0);
  await m.unmount();
});

test('reactive query failure and ambiguous recovery keep identity and never permit fresh initiation', async () => {
  const s = memory();
  s.values.set(key, JSON.stringify(recovery));
  const m = mount({ storage: s });
  await m.render();
  for (const status of [new Error('query failed'), { result: 'review', reason: 'ambiguous_request' }, null]) {
    await m.push(STATUS, status);
    assert.ok(['unknown', 'review'].includes(m.view().outcome));
    await m.invoke(() => m.view().newSubmission());
    await m.invoke(() => m.view().topUp('10', '0971234567', 'mtn'));
    assert.deepEqual(m.view().recovery, recovery);
    assert.equal(m.calls.length, 0);
  }
  await m.unmount();
});

test('late boot storage completion cannot restore another owner state', async () => {
  const s = memory();
  const held = deferred<string | null>();
  s.getItem = async (readKey) => (readKey === key ? await held.promise : null);
  const m = mount({ storage: s });
  await m.render();
  assert.equal(m.view().ready, false);
  const old = m.view();
  m.controls.auth = ready('clerk_b');
  await m.render();
  assert.equal(m.view().ready, true);
  await act(async () => {
    held.resolve(JSON.stringify(recovery));
    await Promise.resolve();
  });
  assert.equal(old.isCurrent(), false);
  assert.equal(m.view().recovery, null);
  assert.equal(m.view().error, null);
  await m.unmount();
});

test('cancelled deferred persistence keeps the opaque token and dispatches no initiation', async () => {
  const s = memory();
  const held = deferred<void>();
  s.setItem = async (key, value) => {
    await held.promise;
    s.values.set(key, value);
  };
  const m = mount({ storage: s });
  await m.render();
  let work: Promise<void> = Promise.resolve();
  await act(async () => {
    work = m.view().topUp('10', '0971234567', 'mtn');
    await Promise.resolve();
  });
  await m.invoke(async () => {
    m.view().cancelDraft();
  });
  await act(async () => {
    held.resolve();
    await work;
  });
  assert.equal(m.calls.length, 0);
  assert.deepEqual(m.view().recovery, recovery);
  assert.equal(m.view().working, false);
  await m.unmount();
});

test('hook registration rereads the real owned account projection; callers cannot supply verification or a name', async () => {
  const db = createDb({
    users: [{ _id: 'users|clerk_a', clerkId: 'clerk_a', role: 'user', isBanned: false, createdAt: 1, updatedAt: 1 }],
  });
  const action = providerOperations.createRegisterAccountAction({
    env: () => ({ LENCO_API_KEY: 'synthetic-fixture' }),
    fetchImpl: async (url, init) => {
      assert.ok(url.endsWith('/resolve/mobile-money'));
      const value: unknown = JSON.parse(init.body ?? '{}');
      assert.ok(typeof value === 'object' && value !== null && 'phone' in value && 'operator' in value);
      return new Response(
        JSON.stringify({
          status: true,
          data: {
            type: 'mobile-money',
            country: 'zm',
            phone: value.phone,
            operator: value.operator,
            accountName: 'Provider Resolved Synthetic',
          },
        }),
        { status: 200 },
      );
    },
  });
  const ctx = createFakeActionCtx({ db, subject: 'clerk_a', modules: { providerOperations } });
  const m = mount();
  await m.render();
  m.handlers.set(REGISTER, (args) => invokeFakeFunction(action, ctx, args));
  m.queryHandlers.set(ACCOUNTS, (args) =>
    invokeFakeFunction(providerOperations.listPaymentAccounts, createCtx(db, 'clerk_a'), args),
  );
  await m.invoke(() => m.view().registerDestination({ type: 'mobile_money', phone: '0971234567', operator: 'airtel' }));
  const rows = db.tables['paymentAccounts'];
  assert.equal(rows?.length, 1);
  assert.equal(rows?.[0]['userId'], 'users|clerk_a');
  assert.equal(rows?.[0]['accountName'], 'Provider Resolved Synthetic');
  assert.equal(rows?.[0]['isVerified'], true);
  assert.equal(
    m.calls.some((call) => call.name === WITHDRAW),
    false,
  );
  await assert.rejects(
    invokeFakeFunction(action, ctx, {
      destination: { type: 'mobile_money', phone: '0971234567', operator: 'mtn', accountName: 'Caller' },
    }),
    /Argument validation failed/,
  );
  const other = createCtx(db, 'clerk_other');
  await assert.rejects(invokeFakeFunction(providerOperations.listPaymentAccounts, other, {}));
  await m.unmount();
});

test('cancel/reset retires captured draft callbacks while allowing a new explicit current draft', async () => {
  const m = mount();
  await m.render();
  const old = m.view();
  await m.invoke(async () => {
    m.view().cancelDraft();
  });
  await m.invoke(() => old.loadBanks());
  await m.invoke(() => old.registerDestination({ type: 'mobile_money', phone: '0971234567', operator: 'mtn' }));
  await m.invoke(() => old.topUp('invalid', '0971234567', 'mtn'));
  assert.equal(m.calls.length, 0);
  assert.equal(m.view().error, null);
  await m.invoke(() => m.view().loadBanks());
  assert.equal(m.calls.length, 1);
  await m.unmount();
});

test('nullable provider names are display-only; complete owned verified destination facts still authorize explicit withdrawal', async () => {
  const m = mount();
  await m.render();
  const account = m.view().accounts[0];
  assert.ok(account);
  await m.push(ACCOUNTS, [{ ...mm, accountName: null }]);
  await m.invoke(() => m.view().withdraw('10', account.accountId, account.destinationKey));
  assert.equal(m.calls.filter((call) => call.name === WITHDRAW).length, 1);
  await m.unmount();
});

test('an explicit terminal reset retires old request callbacks and permits only a new current submission', async () => {
  const s = memory();
  s.values.set(key, JSON.stringify(recovery));
  const m = mount({ storage: s });
  await m.render();
  const old = m.view();
  await m.push(
    STATUS,
    found(recovery, {
      status: 'succeeded',
      providerStatus: 'successful',
      application: 'applied',
      accountingApplied: true,
    }),
  );
  await m.invoke(() => m.view().newSubmission());
  assert.equal(m.view().recovery, null);
  await m.invoke(() => old.checkStatus());
  await m.invoke(() => old.topUp('10', '0971234567', 'mtn'));
  assert.equal(m.calls.length, 0, 'old financial and recovery callbacks cannot enter a new request generation');
  await m.invoke(() => m.view().topUp('10', '0971234567', 'mtn'));
  assert.equal(m.calls.filter((call) => call.name === TOPUP).length, 1);
  assert.notEqual(m.view().recovery?.requestId, recovery.requestId);
  assert.ok(m.view().recovery);
  await m.unmount();
});

for (const boundary of ['review', 'null', 'query-error', 'signout', 'cancel', 'unmount'] as const) {
  test(`terminal clear retains the same durable request when ${boundary} retires proof during deletion`, async () => {
    const s = memory();
    s.values.set(key, JSON.stringify(recovery));
    const m = mount({ storage: s });
    await m.render();
    await m.push(
      STATUS,
      found(recovery, {
        status: 'succeeded',
        providerStatus: 'successful',
        application: 'applied',
        accountingApplied: true,
      }),
    );
    const held = deferred<void>();
    const remove = s.removeItem;
    let entered = false;
    s.removeItem = async (storageKey) => {
      entered = true;
      await held.promise;
      await remove(storageKey);
    };
    let clearing: Promise<void> = Promise.resolve();
    await act(async () => {
      clearing = m.view().newSubmission();
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
    assert.equal(entered, true, 'the actual destructive storage boundary must be reached');
    if (boundary === 'review') await m.push(STATUS, found(recovery, { application: 'review', reviewNeeded: true }));
    if (boundary === 'null') await m.push(STATUS, null);
    if (boundary === 'query-error') await m.push(STATUS, Error('status unavailable'));
    if (boundary === 'signout') {
      m.controls.auth = { ...ready(), isSignedIn: false, user: null };
      await m.render();
    }
    if (boundary === 'cancel') await m.invoke(async () => m.view().cancelDraft());
    if (boundary === 'unmount') await m.unmount();
    await act(async () => {
      held.resolve();
      await clearing;
    });
    assert.equal(s.values.get(key), JSON.stringify(recovery), 'obsolete removal restores exactly the owned token');
    if (boundary === 'signout') {
      m.controls.auth = ready();
      await m.render();
    }
    if (boundary !== 'unmount') {
      assert.deepEqual(m.view().recovery, recovery);
      await m.invoke(() => m.view().topUp('10', '0971234567', 'mtn'));
      assert.equal(m.calls.filter((call) => call.name === TOPUP).length, 0);
      await m.unmount();
    }
  });
}

test('deletion that throws after removing storage retains recovery and blocks fresh SDK intent across remount', async () => {
  const s = memory();
  s.values.set(key, JSON.stringify(recovery));
  const m = mount({ storage: s });
  await m.render();
  await m.push(
    STATUS,
    found(recovery, {
      status: 'succeeded',
      providerStatus: 'successful',
      application: 'applied',
      accountingApplied: true,
    }),
  );
  s.removeItem = async (storageKey) => {
    s.values.delete(storageKey);
    throw Error('native remove failed after deletion');
  };
  s.setItem = async () => {
    throw Error('native preservation failed');
  };
  await m.invoke(() => m.view().newSubmission());
  assert.deepEqual(m.view().recovery, recovery);
  assert.match(m.view().error ?? '', /storage|support|recovery/i);
  await m.invoke(() => m.view().topUp('10', '0971234567', 'mtn'));
  assert.equal(m.calls.length, 0);
  await m.unmount();
  const n = mount({ storage: s, operationState: m.operationState });
  await n.render();
  await n.invoke(() => n.view().topUp('10', '0971234567', 'mtn'));
  assert.equal(n.calls.length, 0, 'failed preservation must remain a process-local hold, not authorize a new ID');
  assert.equal(n.view().ready, false);
  await n.unmount();
  // Release the test-owned storage failure while keeping the verified token, for subsequent tests in this process.
  s.setItem = async (storageKey, value) => {
    s.values.set(storageKey, value);
  };
  const restored = mount({ storage: s, operationState: m.operationState });
  await restored.render();
  assert.deepEqual(restored.view().recovery, recovery);
  await restored.unmount();
});

for (const stage of ['registration', 'status', 'submission'] as const) {
  test(`captured old cancel cannot retire newer ${stage} work or its owned continuation`, async () => {
    const s = memory();
    if (stage === 'status') s.values.set(key, JSON.stringify(recovery));
    const m = mount({ storage: s });
    await m.render();
    const old = m.view();
    await m.invoke(async () => m.view().cancelDraft());
    const held = deferred<unknown>();
    m.handlers.set(stage === 'registration' ? REGISTER : stage === 'status' ? REFRESH : TOPUP, () => held.promise);
    let running: Promise<void> = Promise.resolve();
    await act(async () => {
      running =
        stage === 'registration'
          ? m.view().registerDestination({ type: 'mobile_money', phone: '0971234567', operator: 'mtn' })
          : stage === 'status'
            ? m.view().checkStatus()
            : m.view().topUp('10', '0971234567', 'mtn');
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
    assert.equal(m.view().working, true);
    await m.invoke(async () => old.cancelDraft());
    const remainedWorking = m.view().working;
    await act(async () => {
      held.resolve(
        stage === 'registration'
          ? { accountId: mm.accountId, destinationKey: mm.destinationKey }
          : stage === 'status'
            ? found()
            : { ok: true, operationId: 'paymentOperations|1', status: 'attempted', providerReference: 'opaque' },
      );
      await running;
    });
    assert.equal(remainedWorking, true, 'an obsolete reset cannot release the current busy slot');
    assert.equal(m.view().working, false);
    if (stage === 'registration') assert.equal(m.calls.filter((call) => call.name === ACCOUNTS).length, 1);
    if (stage === 'status') assert.equal(m.view().outcome, 'pending');
    if (stage === 'submission') {
      assert.equal(m.calls.filter((call) => call.name === TOPUP).length, 1);
      assert.deepEqual(m.view().recovery, recovery);
    }
    await m.unmount();
  });
}

for (const boundary of [
  'key',
  'removed',
  'unverified',
  'unresolved',
  'query-error',
  'pending',
  'aba',
  'cancel',
  'off',
] as const) {
  test(`withdrawal rechecks owned approval after persistence when ${boundary} changes before SDK dispatch`, async () => {
    const s = memory();
    const m = mount({ storage: s });
    await m.render();
    const account = m.view().accounts[0];
    assert.ok(account);
    const held = deferred<void>();
    const set = s.setItem;
    let durableValue: string | undefined;
    s.setItem = async (storageKey, value) => {
      durableValue = value;
      await held.promise;
      await set(storageKey, value);
    };
    let sending: Promise<void> = Promise.resolve();
    await act(async () => {
      sending = m.view().withdraw('10.25', account.accountId, account.destinationKey);
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
    assert.equal(typeof durableValue, 'string', 'valid approval reaches actual persistence');
    if (boundary === 'key' || boundary === 'aba') {
      await m.push(ACCOUNTS, [{ ...mm, phone: '0977654321', destinationKey: 'mm:zm:mtn:0977654321' }]);
      if (boundary === 'aba') await m.push(ACCOUNTS, [mm, bank]);
    }
    if (boundary === 'removed') await m.push(ACCOUNTS, []);
    if (boundary === 'unverified') await m.push(ACCOUNTS, [{ ...mm, isVerified: false }]);
    if (boundary === 'unresolved') await m.push(ACCOUNTS, [{ ...mm, providerResolvedAt: null }]);
    if (boundary === 'query-error') await m.push(ACCOUNTS, Error('accounts unavailable'));
    if (boundary === 'pending') await m.push(ACCOUNTS, undefined);
    if (boundary === 'cancel') await m.invoke(async () => m.view().cancelDraft());
    if (boundary === 'off') await m.push(AVAILABILITY, { paymentsEnabled: false });
    await act(async () => {
      held.resolve();
      await sending;
    });
    assert.equal(
      m.calls.filter((call) => call.name === WITHDRAW).length,
      0,
      'retired approval cannot send a financial SDK action',
    );
    assert.equal(s.values.get(key), durableValue);
    assert.deepEqual(m.view().recovery, { ...recovery, kind: 'withdrawal_transfer' });
    await m.invoke(() => m.view().withdraw('20', account.accountId, account.destinationKey));
    assert.equal(
      m.calls.filter((call) => call.name === WITHDRAW).length,
      0,
      'the durable token is held without automatic reapproval',
    );
    await m.unmount();
  });
}

test('unchanged approved mobile and bank destinations dispatch exact arguments once after deferred persistence', async () => {
  for (const projection of [mm, bank]) {
    const s = memory();
    const m = mount({ storage: s });
    await m.render();
    const account = m.view().accounts.find((entry) => entry.accountId === projection.accountId);
    assert.ok(account);
    const held = deferred<void>();
    const set = s.setItem;
    s.setItem = async (storageKey, value) => {
      await held.promise;
      await set(storageKey, value);
    };
    let sending: Promise<void> = Promise.resolve();
    await act(async () => {
      sending = m.view().withdraw('10.25', account.accountId, account.destinationKey);
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
    // Display-only names and an equivalent projection do not revoke a still-current approval.
    await m.push(ACCOUNTS, [
      { ...mm, accountName: null },
      { ...bank, accountName: null },
    ]);
    await act(async () => {
      held.resolve();
      await sending;
    });
    assert.deepEqual(
      m.calls.filter((call) => call.name === WITHDRAW),
      [
        {
          name: WITHDRAW,
          args: {
            requestId: recovery.requestId,
            amountCents: 1025,
            paymentAccountId: account.accountId,
            expectedDestinationKey: account.destinationKey,
          },
        },
      ],
    );
    await m.unmount();
  }
});

test('a reset captured before a later work generation cannot cancel its owned registration', async () => {
  const m = mount();
  await m.render();
  const old = m.view();
  await m.invoke(() => m.view().loadBanks());
  const held = deferred<unknown>();
  m.handlers.set(REGISTER, () => held.promise);
  let registering: Promise<void> = Promise.resolve();
  await act(async () => {
    registering = m.view().registerDestination({ type: 'mobile_money', phone: '0971234567', operator: 'mtn' });
  });
  await m.invoke(async () => old.cancelDraft());
  const working = m.view().working;
  await act(async () => {
    held.resolve({ accountId: mm.accountId, destinationKey: mm.destinationKey });
    await registering;
  });
  assert.equal(working, true);
  assert.equal(m.calls.filter((call) => call.name === ACCOUNTS).length, 1);
  await m.unmount();
});

test('an unrelated owned destination change preserves current selected withdrawal approval during persistence', async () => {
  const s = memory();
  const m = mount({ storage: s });
  await m.render();
  const account = m.view().accounts.find((entry) => entry.accountId === mm.accountId);
  assert.ok(account);
  const held = deferred<void>();
  const set = s.setItem;
  s.setItem = async (storageKey, value) => {
    await held.promise;
    await set(storageKey, value);
  };
  let sending: Promise<void> = Promise.resolve();
  await act(async () => {
    sending = m.view().withdraw('10', account.accountId, account.destinationKey);
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  await m.push(ACCOUNTS, [
    mm,
    { ...bank, accountNumber: '9999999999', destinationKey: 'bank:zm:directory-id:9999999999' },
  ]);
  await act(async () => {
    held.resolve();
    await sending;
  });
  assert.deepEqual(
    m.calls.filter((call) => call.name === WITHDRAW),
    [
      {
        name: WITHDRAW,
        args: {
          requestId: recovery.requestId,
          amountCents: 1000,
          paymentAccountId: account.accountId,
          expectedDestinationKey: account.destinationKey,
        },
      },
    ],
  );
  await m.unmount();
});

// Removing the preclaim phone guard must fail here before storage or any financial action.
for (const phone of ['123-45', 'abcde', '1234', '1'.repeat(33), '12\t345', '１２３４５', '', '   ']) {
  test(`editable invalid top-up phone ${JSON.stringify(phone)} leaves no intent and accepts explicit correction`, async () => {
    const s = memory();
    let writes = 0;
    const setItem = s.setItem;
    s.setItem = async (key, value) => {
      writes += 1;
      await setItem(key, value);
    };
    const m = mount({ storage: s });
    try {
      await m.render();
      await m.invoke(() => m.view().topUp('10.01', phone, 'mtn'));
      assert.equal(m.calls.length, 0, 'invalid phone must not reach financial SDK');
      assert.equal(m.uuidCount(), 0);
      assert.equal(writes, 0);
      assert.equal(s.values.size, 0);
      assert.equal(m.view().recovery, null);
      assert.match(m.view().error ?? '', /destination|phone/i);
      await m.invoke(() => m.view().topUp('10.01', '  +260 971234567  ', 'mtn'));
      assert.deepEqual(m.calls, [
        {
          name: TOPUP,
          args: { requestId: recovery.requestId, amountCents: 1001, phone: '  +260 971234567  ', operator: 'mtn' },
        },
      ]);
      assert.equal(m.uuidCount(), 1);
      assert.equal(writes, 1);
      assert.deepEqual(JSON.parse(s.values.get(key) ?? ''), recovery);
      assert.equal(m.view().outcome, 'unknown');
    } finally {
      await m.unmount();
    }
  });
}

for (const [operator, phone] of [
  ['airtel', '+++++'],
  ['mtn', '1 + 2'],
  ['zamtel', '  0971234567  '],
] as const) {
  test(`top-up preserves frozen broad phone parity and original payload for ${operator}`, async () => {
    const m = mount();
    try {
      await m.render();
      await m.invoke(() => m.view().topUp('0.29', phone, operator));
      assert.deepEqual(m.calls, [
        {
          name: TOPUP,
          args: { requestId: recovery.requestId, amountCents: 29, phone, operator },
        },
      ]);
      assert.deepEqual(JSON.parse(m.storage.values.get(key) ?? ''), recovery);
    } finally {
      await m.unmount();
    }
  });
}
