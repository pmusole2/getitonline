import assert from 'node:assert/strict';
import test from 'node:test';

import { centsToStoredMajor, majorNumberToCents } from '../../../../convex/lib/catalogMoney';

import {
  storedMajorAmountCents,
  positiveDecimalMajorAmount,
  claimWalletRecovery,
  clearWalletRecovery,
  readWalletRecovery,
  walletAmountCents,
  walletOutcome,
  type RecoveryStorage,
  type WalletRecovery,
  type WalletStatus,
} from './walletOperationState';

const uuid = '11111111-2222-4333-8444-555555555555';
const token: WalletRecovery = { version: 1, kind: 'top_up_collection', requestId: `wallet_${uuid}` };
function storage(): RecoveryStorage & { values: Map<string, string> } {
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

test('decimal input is lossless and rejects fractional cents, junk, nonpositive and overflow', () => {
  for (const [text, cents] of [
    ['0.01', 1],
    ['10', 1000],
    ['001.20', 120],
    ['90071992547409.91', Number.MAX_SAFE_INTEGER],
  ] as const) {
    assert.equal(walletAmountCents(text), cents);
  }
  for (const text of [
    '0',
    '0.00',
    '-1',
    '+1',
    ' 1',
    '1 ',
    '1x',
    '1.001',
    '1.',
    '.1',
    'NaN',
    'Infinity',
    '1e3',
    '90071992547409.92',
  ]) {
    assert.equal(walletAmountCents(text), null, text);
  }
});

test('review precedes terminal labels and success requires current request, kind and proven applied accounting', () => {
  // Branded ids are obtained from the SDK type at this boundary; no backend validator claim is made here.
  const found: WalletStatus = {
    result: 'found',
    operationId: 'op' as Extract<WalletStatus, { result: 'found' }>['operationId'],
    requestId: token.requestId,
    requestIdentity: null,
    kind: token.kind,
    status: 'succeeded',
    providerStatus: 'successful',
    application: 'applied',
    accountingApplied: true,
    reviewNeeded: false,
    amountCents: 1000,
    quoteKey: null,
    source: null,
    orderIds: [],
    feeCents: null,
  };
  assert.equal(walletOutcome(token, found), 'completed');
  assert.equal(found.feeCents, null);
  for (const change of [
    { reviewNeeded: true },
    { application: 'review' },
    { requestId: 'other' },
    { kind: 'withdrawal_transfer' },
  ] as const) {
    assert.equal(walletOutcome(token, { ...found, ...change }), 'review');
  }
  assert.equal(walletOutcome(token, { ...found, accountingApplied: false, application: 'pending' }), 'pending');
  assert.equal(walletOutcome(token, { ...found, status: 'failed', providerStatus: 'failed' }), 'failed');
  assert.equal(
    walletOutcome(token, {
      ...found,
      status: 'unknown',
      providerStatus: 'unknown',
      application: 'pending',
      accountingApplied: false,
    }),
    'unknown',
  );
  assert.equal(walletOutcome(token, null), 'unknown');
  assert.equal(walletOutcome(token, new Error('offline')), 'unknown');
});

test('concurrent claims and remount reads retain one opaque owner-partitioned identity without private intent', async () => {
  const s = storage();
  const results = await Promise.all([
    claimWalletRecovery(
      s,
      'a',
      token.kind,
      () => uuid,
      () => true,
    ),
    claimWalletRecovery(
      s,
      'a',
      'withdrawal_transfer',
      () => {
        throw Error('must not regenerate');
      },
      () => true,
    ),
  ]);
  assert.deepEqual(
    results.map((result) => result?.created),
    [true, false],
  );
  assert.deepEqual(await readWalletRecovery(s, 'a'), token);
  assert.equal(await readWalletRecovery(s, 'b'), null);
  assert.deepEqual(JSON.parse([...s.values.values()][0]), token);
  assert.equal(await clearWalletRecovery(s, 'a', { ...token, requestId: 'other' }, () => true), false);
  assert.deepEqual(await readWalletRecovery(s, 'a'), token);
});

test('corrupt or extended recovery fails closed without deleting or replacing it', async () => {
  for (const raw of [
    '{',
    '{}',
    JSON.stringify({ ...token, phone: 'synthetic' }),
    JSON.stringify({ ...token, kind: 'card' }),
  ]) {
    const s = storage();
    s.values.set('@gettit/wallet-operation/v1/a', raw);
    await assert.rejects(readWalletRecovery(s, 'a'));
    await assert.rejects(
      claimWalletRecovery(
        s,
        'a',
        token.kind,
        () => uuid,
        () => true,
      ),
    );
    assert.equal([...s.values.values()][0], raw);
  }
});

test('obsolete claim cannot write; failed persistence rejects before any caller can dispatch', async () => {
  const s = storage();
  assert.equal(
    await claimWalletRecovery(
      s,
      'a',
      token.kind,
      () => uuid,
      () => false,
    ),
    null,
  );
  assert.equal(s.values.size, 0);
  s.setItem = async () => {
    throw Error('disk');
  };
  await assert.rejects(
    claimWalletRecovery(
      s,
      'a',
      token.kind,
      () => uuid,
      () => true,
    ),
    /disk/,
  );
});

test('a late obsolete clear never erases a new identity queued behind it', async () => {
  const s = storage();
  await claimWalletRecovery(
    s,
    'a',
    token.kind,
    () => uuid,
    () => true,
  );
  let release: (() => void) | undefined;
  const remove = s.removeItem;
  s.removeItem = async (key) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await remove(key);
  };
  const clearing = clearWalletRecovery(s, 'a', token, () => true);
  // Flush the queued storage read, without a timer or polling.
  await new Promise<void>((resolve) => setImmediate(resolve));
  const next = claimWalletRecovery(
    s,
    'a',
    token.kind,
    () => 'aaaaaaaa-2222-4333-8444-555555555555',
    () => true,
  );
  assert.ok(release);
  release();
  assert.equal(await clearing, true);
  const claimed = await next;
  assert.equal(claimed?.created, true);
  assert.equal((await readWalletRecovery(s, 'a'))?.requestId, claimed?.recovery.requestId);
  assert.equal(await clearWalletRecovery(s, 'a', token, () => true), false);
});

test('proof retirement during remove preserves the token before a queued claim can create another identity', async () => {
  const s = storage();
  const owner = 'retired-clear';
  await claimWalletRecovery(
    s,
    owner,
    token.kind,
    () => uuid,
    () => true,
  );
  let release: (() => void) | undefined;
  let current = true;
  const remove = s.removeItem;
  s.removeItem = async (key) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await remove(key);
  };
  const clearing = clearWalletRecovery(s, owner, token, () => current);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const next = claimWalletRecovery(
    s,
    owner,
    token.kind,
    () => {
      throw Error('must retain previous identity');
    },
    () => true,
  );
  current = false;
  assert.ok(release);
  release();
  assert.equal(await clearing, false);
  assert.deepEqual(await next, { recovery: token, created: false });
  assert.deepEqual(await readWalletRecovery(s, owner), token);
});

test('native delete failure after mutation restores the verified token and rejects clear success', async () => {
  const s = storage();
  const owner = 'failed-delete';
  await claimWalletRecovery(
    s,
    owner,
    token.kind,
    () => uuid,
    () => true,
  );
  s.removeItem = async (key) => {
    s.values.delete(key);
    throw Error('native delete uncertain');
  };
  await assert.rejects(
    clearWalletRecovery(s, owner, token, () => true),
    /storage|support/,
  );
  assert.deepEqual(await readWalletRecovery(s, owner), token);
  const next = await claimWalletRecovery(
    s,
    owner,
    token.kind,
    () => {
      throw Error('no new identity');
    },
    () => true,
  );
  assert.deepEqual(next, { recovery: token, created: false });
});

test('preservation does not overwrite a different token observed after retired deletion', async () => {
  const s = storage();
  const owner = 'binding-change';
  const key = '@gettit/wallet-operation/v1/binding-change';
  const newer: WalletRecovery = { ...token, requestId: 'wallet_aaaaaaaa-2222-4333-8444-555555555555' };
  await claimWalletRecovery(
    s,
    owner,
    token.kind,
    () => uuid,
    () => true,
  );
  let current = true;
  s.removeItem = async () => {
    s.values.set(key, JSON.stringify(newer));
    current = false;
  };
  await assert.rejects(
    clearWalletRecovery(s, owner, token, () => current),
    /storage changed|support/,
  );
  assert.equal(s.values.get(key), JSON.stringify(newer));
  await assert.rejects(
    claimWalletRecovery(
      s,
      owner,
      token.kind,
      () => uuid,
      () => true,
    ),
    /storage changed|support/,
  );
  assert.equal(
    s.values.get(key),
    JSON.stringify(newer),
    'the binding conflict stays held, never repaired by overwriting',
  );
});

test('reset finalization occurs only after the actual storage delete resolves under current proof', async () => {
  const s = storage();
  const owner = 'clear-finalization';
  await claimWalletRecovery(
    s,
    owner,
    token.kind,
    () => uuid,
    () => true,
  );
  let release: (() => void) | undefined;
  let finalized = 0;
  const remove = s.removeItem;
  s.removeItem = async (key) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await remove(key);
  };
  const clearing = clearWalletRecovery(
    s,
    owner,
    token,
    () => true,
    () => {
      finalized += 1;
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(finalized, 0);
  assert.ok(release);
  release();
  assert.equal(await clearing, true);
  assert.equal(finalized, 1);
  assert.equal(await readWalletRecovery(s, owner), null);
});

test('stored balances match the actual backend exact decimal cent oracle, including zero and malformed values', () => {
  for (const [major, expected] of [
    [0, 0],
    [-0, 0],
    [0.29, 29],
    [0.3, 30],
    [25.01, 2501],
    [90071992547409.9, 9007199254740990],
    [0.001, null],
    [0.30000000000000004, null],
    [-1, null],
    [NaN, null],
    [Infinity, null],
    [90071992547410, null],
    [1e-7, null],
  ] as const) {
    assert.equal(majorNumberToCents(major), expected);
    assert.equal(storedMajorAmountCents(major), expected);
  }
});

test('whole positive refund text preserves every cent through the actual backend numeric-major roundtrip', () => {
  for (const [text, cents, major] of [
    [' 25.01 ', 2501, 25.01],
    ['0.5', 50, 0.5],
    ['25', 2500, 25],
    ['90071992547409.90', 9007199254740990, 90071992547409.9],
  ] as const) {
    assert.equal(centsToStoredMajor(cents), major);
    assert.equal(positiveDecimalMajorAmount(text), major);
    assert.equal(majorNumberToCents(major), cents);
  }
  for (const text of [
    '25garbage',
    '25.001',
    '0',
    '0.00',
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
    assert.equal(positiveDecimalMajorAmount(text), null, text);
  }
  assert.equal(walletAmountCents('90071992547409.91'), Number.MAX_SAFE_INTEGER, 'cent-only input remains valid');
  assert.equal(centsToStoredMajor(Number.MAX_SAFE_INTEGER), null, 'backend rejects the same numeric-major cent loss');
  assert.equal(majorNumberToCents(Number.MAX_SAFE_INTEGER / 100), Number.MAX_SAFE_INTEGER - 1);
});
