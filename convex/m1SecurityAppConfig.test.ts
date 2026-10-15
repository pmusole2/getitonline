import assert from 'node:assert/strict';
import test from 'node:test';

import * as appConfig from './appConfig';
import { denialMessage } from './lib/auth';
import { createCtx, createDb, handlerOf, type Db, type Row } from '../tests/support/convexFakeDb';

// Operators set app config at cutover and roll back payments from a shell, with no signed-in admin session. That path
// is `applyAppConfig`, an internal mutation. It must validate exactly like the admin path `setAppConfig`, and it must
// never record a caller identity. A refused write leaves every table unchanged, because the fake does not roll back.

type Args = Record<string, unknown>;

const setAppConfig = handlerOf<Args, null>(appConfig.setAppConfig);
const applyAppConfig = handlerOf<Args, null>(appConfig.applyAppConfig);
const getPaymentAvailability = handlerOf<Args, { paymentsEnabled: boolean }>(appConfig.getPaymentAvailability);

const ADMIN_SUBJECT = 'clerk_admin';
const STORE_URLS = {
  ios: 'https://apps.apple.com/app/gettitonline/id1',
  android: 'https://play.google.com/store/apps/details?id=com.gettitonline',
};

function flag(fn: unknown, name: 'isPublic' | 'isInternal'): unknown {
  return typeof fn === 'function' && name in fn ? Reflect.get(fn, name) : undefined;
}

function usersFixture(): Row[] {
  return [{ _id: 'users|admin', clerkId: ADMIN_SUBJECT, role: 'admin', isBanned: false, email: 'a@example.invalid' }];
}

function configRow(overrides: Record<string, unknown> = {}): Row {
  return {
    _id: 'appConfig|1',
    key: 'singleton',
    minimumBuilds: { ios: 100, android: 200 },
    storeUrls: { ...STORE_URLS },
    paymentsEnabled: true,
    updatedAt: 1,
    updatedBy: 'users|admin',
    ...overrides,
  };
}

function setup(appConfigRows: Row[] = [configRow()], subject: string | null = null) {
  const db: Db = createDb({ users: usersFixture(), appConfig: appConfigRows });
  return { db, ctx: createCtx(db, subject) };
}

test('applyAppConfig is internal, so no client can call it', () => {
  assert.equal(flag(appConfig.applyAppConfig, 'isInternal'), true);
  assert.notEqual(flag(appConfig.applyAppConfig, 'isPublic'), true);
});

test('an operator first-time setup creates the singleton with payments off by default', async () => {
  const { db, ctx } = setup([]);

  await applyAppConfig(ctx, { minimumBuilds: { ios: 120, android: 260 }, storeUrls: { ...STORE_URLS } });

  const [stored] = db.tables.appConfig ?? [];
  assert.equal(db.tables.appConfig?.length, 1);
  assert.deepEqual(stored?.minimumBuilds, { ios: 120, android: 260 });
  assert.deepEqual(stored?.storeUrls, STORE_URLS);
  assert.equal(stored?.paymentsEnabled, false);
});

test('an operator first write without minimumBuilds is refused, and creates no row', async () => {
  const { db, ctx } = setup([]);
  const before = structuredClone(db.tables);

  await assert.rejects(applyAppConfig(ctx, { paymentsEnabled: true }), /minimumBuilds is required/);

  assert.deepEqual(db.tables, before);
});

test('an operator raising the minimum builds keeps the stored payment flag and store URLs', async () => {
  const { db, ctx } = setup([configRow({ paymentsEnabled: true })]);

  await applyAppConfig(ctx, { minimumBuilds: { ios: 130, android: 270 } });

  const [stored] = db.tables.appConfig ?? [];
  assert.deepEqual(stored?.minimumBuilds, { ios: 130, android: 270 });
  assert.equal(stored?.paymentsEnabled, true);
  assert.deepEqual(stored?.storeUrls, STORE_URLS);
});

test('an operator payments-off rollback takes effect for the public payment query', async () => {
  const { db, ctx } = setup([configRow({ paymentsEnabled: true })]);
  assert.deepEqual(await getPaymentAvailability(createCtx(db, null), {}), { paymentsEnabled: true });

  await applyAppConfig(ctx, { paymentsEnabled: false });

  assert.deepEqual(await getPaymentAvailability(createCtx(db, null), {}), { paymentsEnabled: false });
  assert.deepEqual(db.tables.appConfig?.[0]?.minimumBuilds, { ios: 100, android: 200 });
});

test('an operator write never records an updatedBy, and clears one left by an earlier admin write', async () => {
  const { db, ctx } = setup([configRow({ updatedBy: 'users|admin' })]);

  await applyAppConfig(ctx, { paymentsEnabled: false });

  assert.equal(db.tables.appConfig?.[0]?.updatedBy, undefined);
  assert.equal(db.tables.appConfig?.length, 1);
});

test('an operator write ignores a caller-supplied identity in args', async () => {
  const { db, ctx } = setup([configRow({ updatedBy: undefined })]);

  await applyAppConfig(ctx, { paymentsEnabled: false, updatedBy: 'users|admin' });

  assert.equal(db.tables.appConfig?.[0]?.updatedBy, undefined);
});

// The same invalid inputs run through both entry points. Each must refuse with the same message and write nothing.
const INVALID_INPUTS: Array<{ label: string; args: Args }> = [
  { label: 'no fields at all', args: {} },
  { label: 'an iOS minimum of zero', args: { minimumBuilds: { ios: 0, android: 200 } } },
  { label: 'a fractional Android minimum', args: { minimumBuilds: { ios: 100, android: 1.5 } } },
  { label: 'a NaN iOS minimum', args: { minimumBuilds: { ios: Number.NaN, android: 200 } } },
  { label: 'a negative Android minimum', args: { minimumBuilds: { ios: 100, android: -3 } } },
  { label: 'an infinite Android minimum', args: { minimumBuilds: { ios: 100, android: Number.POSITIVE_INFINITY } } },
  { label: 'an http iOS store URL', args: { storeUrls: { ios: 'http://apps.apple.com/app/x' } } },
  { label: 'a javascript Android store URL', args: { storeUrls: { android: 'javascript:alert(1)' } } },
  { label: 'a non-URL Android store URL', args: { storeUrls: { android: 'not a url' } } },
  {
    label: 'an iOS store URL with a username',
    args: { storeUrls: { ios: 'https://user@apps.apple.com/app/example' } },
  },
  {
    label: 'an Android store URL with a password',
    args: { storeUrls: { android: 'https://user:password@play.google.com/store/apps/details?id=com.example' } },
  },
];

for (const invalid of INVALID_INPUTS) {
  test(`${invalid.label} is refused identically by both entry points, and writes nothing`, async () => {
    const adminSetup = setup([configRow()], ADMIN_SUBJECT);
    const adminBefore = structuredClone(adminSetup.db.tables);
    const adminError = await setAppConfig(adminSetup.ctx, invalid.args).then(
      () => assert.fail('setAppConfig must refuse'),
      (error: unknown) => error,
    );

    const operatorSetup = setup([configRow()]);
    const operatorBefore = structuredClone(operatorSetup.db.tables);
    const operatorError = await applyAppConfig(operatorSetup.ctx, invalid.args).then(
      () => assert.fail('applyAppConfig must refuse'),
      (error: unknown) => error,
    );

    assert.ok(adminError instanceof Error);
    assert.ok(operatorError instanceof Error);
    assert.equal(operatorError.message, adminError.message);
    assert.deepEqual(adminSetup.db.tables, adminBefore);
    assert.deepEqual(operatorSetup.db.tables, operatorBefore);
  });
}

test('an operator first write with invalid input creates no row', async () => {
  const { db, ctx } = setup([]);
  const before = structuredClone(db.tables);

  await assert.rejects(applyAppConfig(ctx, { minimumBuilds: { ios: 0, android: 200 } }), /must be a positive integer/);

  assert.deepEqual(db.tables, before);
});

test('the admin path still refuses an unauthenticated caller, and the operator path needs no session', async () => {
  const anonymous = setup([configRow()], null);
  const before = structuredClone(anonymous.db.tables);

  await assert.rejects(setAppConfig(anonymous.ctx, { paymentsEnabled: false }), {
    message: denialMessage('unauthenticated'),
  });
  assert.deepEqual(anonymous.db.tables, before);

  const operator = setup([configRow()], null);
  await applyAppConfig(operator.ctx, { paymentsEnabled: false });
  assert.equal(operator.db.tables.appConfig?.[0]?.paymentsEnabled, false);
});
