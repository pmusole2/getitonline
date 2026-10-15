import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkoutPayerPhoneValid,
  claimCheckoutRecovery,
  clearCheckoutRecovery,
  readCheckoutRecovery,
  type CheckoutRecovery,
} from './checkoutOperationState';
import type { RecoveryStorage } from './walletOperationState';

const uuid = '11111111-2222-4333-8444-555555555555';
const token: CheckoutRecovery = { version: 1, kind: 'wallet_purchase', requestId: `checkout_${uuid}` };
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

test('concurrent claims and remount reads retain one opaque owner-partitioned identity without private intent', async () => {
  const s = storage();
  const results = await Promise.all([
    claimCheckoutRecovery(
      s,
      'a',
      token.kind,
      () => uuid,
      () => true,
    ),
    claimCheckoutRecovery(
      s,
      'a',
      'checkout_collection',
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
  assert.deepEqual(await readCheckoutRecovery(s, 'a'), token);
  assert.equal(await readCheckoutRecovery(s, 'b'), null);
  assert.deepEqual(JSON.parse([...s.values.values()][0]), token);
  assert.equal(await clearCheckoutRecovery(s, 'a', { ...token, requestId: 'other' }, () => true), false);
  assert.deepEqual(await readCheckoutRecovery(s, 'a'), token);
});

test('corrupt or extended recovery fails closed without deleting or replacing it', async () => {
  for (const raw of [
    '{',
    '{}',
    JSON.stringify({ ...token, phone: 'synthetic' }),
    JSON.stringify({ ...token, kind: 'card' }),
  ]) {
    const s = storage();
    s.values.set('@gettit/checkout-operation/v1/a', raw);
    await assert.rejects(readCheckoutRecovery(s, 'a'));
    await assert.rejects(
      claimCheckoutRecovery(
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
    await claimCheckoutRecovery(
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
    claimCheckoutRecovery(
      s,
      'a',
      token.kind,
      () => uuid,
      () => true,
    ),
    /disk/,
  );
  s.setItem = async (key, value) => {
    s.values.set(key, value);
  };
  assert.deepEqual(await readCheckoutRecovery(s, 'a'), token);
  await clearCheckoutRecovery(s, 'a', token, () => true);
});

test('a late obsolete clear never erases a new identity queued behind it', async () => {
  const s = storage();
  await claimCheckoutRecovery(
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
  const clearing = clearCheckoutRecovery(s, 'a', token, () => true);
  // Flush the queued storage read, without a timer or polling.
  await new Promise<void>((resolve) => setImmediate(resolve));
  const next = claimCheckoutRecovery(
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
  assert.equal((await readCheckoutRecovery(s, 'a'))?.requestId, claimed?.recovery.requestId);
  assert.equal(await clearCheckoutRecovery(s, 'a', token, () => true), false);
});

test('proof retirement during remove preserves the token before a queued claim can create another identity', async () => {
  const s = storage();
  const owner = 'retired-clear';
  await claimCheckoutRecovery(
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
  const clearing = clearCheckoutRecovery(s, owner, token, () => current);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const next = claimCheckoutRecovery(
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
  assert.deepEqual(await readCheckoutRecovery(s, owner), token);
});

test('native delete failure after mutation restores the verified token and rejects clear success', async () => {
  const s = storage();
  const owner = 'failed-delete';
  await claimCheckoutRecovery(
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
    clearCheckoutRecovery(s, owner, token, () => true),
    /storage|support/,
  );
  assert.deepEqual(await readCheckoutRecovery(s, owner), token);
  const next = await claimCheckoutRecovery(
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
  const key = '@gettit/checkout-operation/v1/binding-change';
  const newer: CheckoutRecovery = { ...token, requestId: 'checkout_aaaaaaaa-2222-4333-8444-555555555555' };
  await claimCheckoutRecovery(
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
    clearCheckoutRecovery(s, owner, token, () => current),
    /storage changed|support/,
  );
  assert.equal(s.values.get(key), JSON.stringify(newer));
  await assert.rejects(
    claimCheckoutRecovery(
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
  await claimCheckoutRecovery(
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
  const clearing = clearCheckoutRecovery(
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
  assert.equal(await readCheckoutRecovery(s, owner), null);
});

test('loyalty selection rejects fractional/truncated/unsafe text without clamping', async () => {
  const { checkoutPoints } = await import('./checkoutOperationState');
  for (const [value, expected] of [
    ['', 0],
    ['0', 0],
    ['012', 12],
    ['9007199254740991', Number.MAX_SAFE_INTEGER],
  ] as const) {
    assert.equal(checkoutPoints(value), expected);
  }
  for (const value of ['1.5', '-1', '1x', '+1', '1e2', ' 1', '1 ', '9007199254740992', 'NaN']) {
    assert.equal(checkoutPoints(value), null, value);
  }
});

test('retained namespace encodes Clerk owner and failed first write preserves the same identity across a later claim', async () => {
  const s = storage();
  const owner = 'subject/encoded?test';
  let fail = true;
  s.setItem = async (key, value) => {
    if (fail) throw Error('storage unavailable');
    s.values.set(key, value);
  };
  await assert.rejects(
    claimCheckoutRecovery(
      s,
      owner,
      token.kind,
      () => uuid,
      () => true,
    ),
  );
  await assert.rejects(readCheckoutRecovery(s, owner));
  fail = false;
  const result = await claimCheckoutRecovery(
    s,
    owner,
    token.kind,
    () => {
      throw Error('must retain original UUID');
    },
    () => true,
  );
  assert.equal(result?.created, false);
  assert.deepEqual(result?.recovery, token);
  assert.deepEqual(JSON.parse(s.values.get(`@gettit/checkout-operation/v1/${encodeURIComponent(owner)}`) ?? ''), token);
});

test('comparison fingerprint matches both frozen producer builders with every optional selector and trimmed payer/address', async () => {
  const { createHash } = await import('node:crypto');
  const { checkoutRequestDocument } = await import('./checkoutOperationState');
  const { buildRequestIdentity, normalizePurchaseRequest } =
    await import('../../../../convex/lib/paymentOperationContracts');
  const { buildCheckoutRequestIdentity, normalizeCheckoutCollectionRequest } =
    await import('../../../../convex/lib/providerOperationContracts');
  type Selectors = import('./checkoutOperationState').CheckoutSelectors;
  // Synthetic fixture ids are branded only at this test boundary; registered-handler tests separately validate real query ids.
  const input: Selectors = {
    source: 'pending_orders',
    shippingAddress: {
      street: ' Street ',
      city: ' Lusaka ',
      province: ' Lusaka ',
      country: ' Zambia ',
      phone: ' 0971234567 ',
    },
    orderIds: ['orders|b', 'orders|a'] as NonNullable<Selectors['orderIds']>,
    deliveryMethodId: 'deliveryMethods|1' as NonNullable<Selectors['deliveryMethodId']>,
    pickupPointId: 'pickupPoints|1' as NonNullable<Selectors['pickupPointId']>,
    promoCode: ' saved ',
    loyaltyPoints: 7,
  };
  const args = { ...input, requestId: token.requestId, expectedQuoteKey: 'approved-key' };
  const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
  assert.equal(
    digest(checkoutRequestDocument('users|buyer', 'wallet_purchase', input, args.expectedQuoteKey)),
    await buildRequestIdentity({ actorId: 'users|buyer', request: normalizePurchaseRequest(args) }),
  );
  for (const operator of ['mtn', 'airtel', 'zamtel'] as const) {
    assert.equal(
      digest(
        checkoutRequestDocument(
          'users|buyer',
          'checkout_collection',
          input,
          args.expectedQuoteKey,
          ' 0971234567 ',
          operator,
        ),
      ),
      await buildCheckoutRequestIdentity({
        actorId: 'users|buyer',
        request: normalizeCheckoutCollectionRequest({ ...args, phone: ' 0971234567 ', operator }),
      }),
    );
  }
});

test('local payer validation matches the frozen producer trim-only acceptance boundary', async () => {
  const { normalizePhone } = await import('../../../../convex/lib/providerOperationContracts');
  const cases = [
    { phone: undefined, valid: false },
    { phone: '', valid: false },
    { phone: '   ', valid: false },
    { phone: 'bad-phone', valid: false },
    { phone: '097-12345', valid: false },
    { phone: '1234', valid: false },
    { phone: '1'.repeat(33), valid: false },
    { phone: '1234\t5', valid: false },
    { phone: '１２３４５', valid: false },
    { phone: '12345', valid: true },
    { phone: '1'.repeat(32), valid: true },
    { phone: '  0971234567  ', valid: true },
    { phone: '+260 971 234567', valid: true },
    { phone: '+++++', valid: true },
    { phone: '1 + 2', valid: true },
  ];
  for (const { phone, valid } of cases) {
    assert.equal(checkoutPayerPhoneValid(phone), valid, JSON.stringify(phone));
    if (phone === undefined) continue;
    if (valid) assert.equal(normalizePhone(phone), phone.trim());
    else assert.throws(() => normalizePhone(phone), /valid Zambian mobile number/);
  }
});
