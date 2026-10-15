import assert from 'node:assert/strict';
import test from 'node:test';

import * as appConfig from './appConfig';
import { denialMessage } from './lib/auth';
import { createCtx, createDb, handlerOf, type Db, type Row } from '../tests/support/convexFakeDb';

// The build gate and the payment switch are read without a session, so old and new builds can call them. Writes are
// admin-only, and a refused write must leave every table unchanged, because the fake does not roll back.

type Args = Record<string, unknown>;
type ClientGate = {
  updateRequired: boolean;
  minimumBuild: number;
  storeUrl: string | null;
  paymentsEnabled: boolean;
};

const getClientGate = handlerOf<Args, ClientGate>(appConfig.getClientGate);
const getPaymentAvailability = handlerOf<Args, { paymentsEnabled: boolean }>(appConfig.getPaymentAvailability);
const setAppConfig = handlerOf<Args, null>(appConfig.setAppConfig);

const ADMIN_SUBJECT = 'clerk_admin';

const STORE_URLS = {
  ios: 'https://apps.apple.com/app/gettitonline/id1',
  android: 'https://play.google.com/store/apps/details?id=com.gettitonline',
};

function account(id: string, clerkId: string, role: string): Row {
  return {
    _id: id,
    clerkId,
    email: `${clerkId}@example.invalid`,
    firstName: 'Fixture',
    lastName: id,
    role,
    isBanned: false,
  };
}

function usersFixture(): Row[] {
  return [
    account('users|admin', ADMIN_SUBJECT, 'admin'),
    account('users|moderator', 'clerk_moderator', 'moderator'),
    account('users|catalog', 'clerk_catalog', 'catalog_manager'),
    account('users|user', 'clerk_user', 'user'),
    { ...account('users|banned-admin', 'clerk_banned_admin', 'admin'), isBanned: true },
    { ...account('users|deleted-admin', 'clerk_deleted_admin', 'admin'), deletedAt: 1 },
  ];
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

function setup(subject: string | null, appConfigRows: Row[] = [configRow()]) {
  const db: Db = createDb({ users: usersFixture(), appConfig: appConfigRows });
  return { db, ctx: createCtx(db, subject) };
}

const VALID_WRITE: Args = {
  minimumBuilds: { ios: 120, android: 260 },
  storeUrls: { ...STORE_URLS },
  paymentsEnabled: true,
};

test('an iOS build below the minimum requires an update', async () => {
  const { ctx } = setup(null);

  const gate = await getClientGate(ctx, { platform: 'ios', build: 99 });

  assert.equal(gate.updateRequired, true);
  assert.equal(gate.minimumBuild, 100);
});

test('an iOS build equal to the minimum does not require an update', async () => {
  const { ctx } = setup(null);

  const gate = await getClientGate(ctx, { platform: 'ios', build: 100 });

  assert.equal(gate.updateRequired, false);
});

test('an iOS build above the minimum does not require an update', async () => {
  const { ctx } = setup(null);

  const gate = await getClientGate(ctx, { platform: 'ios', build: 101 });

  assert.equal(gate.updateRequired, false);
});

test('an Android build below the minimum requires an update', async () => {
  const { ctx } = setup(null);

  const gate = await getClientGate(ctx, { platform: 'android', build: 199 });

  assert.equal(gate.updateRequired, true);
  assert.equal(gate.minimumBuild, 200);
});

test('an Android build equal to the minimum does not require an update', async () => {
  const { ctx } = setup(null);

  const gate = await getClientGate(ctx, { platform: 'android', build: 200 });

  assert.equal(gate.updateRequired, false);
});

test('an Android build above the minimum does not require an update', async () => {
  const { ctx } = setup(null);

  const gate = await getClientGate(ctx, { platform: 'android', build: 201 });

  assert.equal(gate.updateRequired, false);
});

test('each platform is compared only against its own minimum', async () => {
  const { ctx } = setup(null);

  // iOS 150 clears its minimum of 100. Android 150 is under its minimum of 200.
  const ios = await getClientGate(ctx, { platform: 'ios', build: 150 });
  const android = await getClientGate(ctx, { platform: 'android', build: 150 });

  assert.deepEqual([ios.updateRequired, android.updateRequired], [false, true]);
  assert.deepEqual([ios.minimumBuild, android.minimumBuild], [100, 200]);
});

test('the gate returns the store URL for the requested platform', async () => {
  const { ctx } = setup(null);

  const ios = await getClientGate(ctx, { platform: 'ios', build: 1 });
  const android = await getClientGate(ctx, { platform: 'android', build: 1 });

  assert.equal(ios.storeUrl, STORE_URLS.ios);
  assert.equal(android.storeUrl, STORE_URLS.android);
});

test('a platform without a configured store URL returns a null store URL', async () => {
  const { ctx } = setup(null, [configRow({ storeUrls: { ios: STORE_URLS.ios } })]);

  const android = await getClientGate(ctx, { platform: 'android', build: 1 });

  assert.equal(android.storeUrl, null);
});

test('the gate reports the stored payment flag', async () => {
  const { ctx } = setup(null, [configRow({ paymentsEnabled: false })]);

  const gate = await getClientGate(ctx, { platform: 'ios', build: 1 });

  assert.equal(gate.paymentsEnabled, false);
});

test('a missing config row sets no minimum and keeps payments off', async () => {
  const { ctx } = setup(null, []);

  for (const platform of ['ios', 'android'] as const) {
    for (const build of [0, 5]) {
      const gate = await getClientGate(ctx, { platform, build });
      assert.deepEqual(gate, { updateRequired: false, minimumBuild: 0, storeUrl: null, paymentsEnabled: false });
    }
  }
});

test('payments are off when no config row exists', async () => {
  const { ctx } = setup(null, []);

  const availability = await getPaymentAvailability(ctx, {});

  assert.deepEqual(availability, { paymentsEnabled: false });
});

test('the payment availability query returns the stored flag', async () => {
  const on = setup(null, [configRow({ paymentsEnabled: true })]);
  const off = setup(null, [configRow({ paymentsEnabled: false })]);

  assert.deepEqual(await getPaymentAvailability(on.ctx, {}), { paymentsEnabled: true });
  assert.deepEqual(await getPaymentAvailability(off.ctx, {}), { paymentsEnabled: false });
});

test('anonymous callers can read both the gate and the payment availability', async () => {
  const { ctx } = setup(null);

  const gate = await getClientGate(ctx, { platform: 'android', build: 150 });
  const availability = await getPaymentAvailability(ctx, {});

  assert.equal(gate.updateRequired, true);
  assert.equal(availability.paymentsEnabled, true);
});

test('the gate rejects builds that are not non-negative integers', async () => {
  const { ctx } = setup(null);

  for (const build of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 1.5]) {
    await assert.rejects(getClientGate(ctx, { platform: 'ios', build }), {
      message: 'build must be a non-negative integer',
    });
  }
});

const REFUSED_WRITERS = [
  { label: 'an anonymous caller', subject: null, message: denialMessage('unauthenticated') },
  {
    label: 'a signed-in account with no stored record',
    subject: 'clerk_nobody',
    message: denialMessage('unknown_user'),
  },
  { label: 'a banned admin', subject: 'clerk_banned_admin', message: denialMessage('banned') },
  { label: 'a deleted admin', subject: 'clerk_deleted_admin', message: denialMessage('deleted') },
  { label: 'a moderator', subject: 'clerk_moderator', message: denialMessage('forbidden') },
  { label: 'a catalog manager', subject: 'clerk_catalog', message: denialMessage('forbidden') },
  { label: 'an ordinary user', subject: 'clerk_user', message: denialMessage('forbidden') },
] as const;

for (const writer of REFUSED_WRITERS) {
  test(`${writer.label} cannot change app config, and nothing is written`, async () => {
    const { db, ctx } = setup(writer.subject);
    const before = structuredClone(db.tables);

    await assert.rejects(setAppConfig(ctx, VALID_WRITE), { message: writer.message });

    assert.deepEqual(db.tables, before);
  });
}

test('an admin write rejects invalid builds, store URLs, and empty updates, and writes nothing', async () => {
  const invalidWrites: Array<{ args: Args; message: RegExp }> = [
    { args: { minimumBuilds: { ios: 0, android: 200 } }, message: /must be a positive integer/ },
    { args: { minimumBuilds: { ios: 1.5, android: 200 } }, message: /must be a positive integer/ },
    { args: { minimumBuilds: { ios: Number.NaN, android: 200 } }, message: /must be a positive integer/ },
    { args: { minimumBuilds: { ios: 100, android: -3 } }, message: /must be a positive integer/ },
    { args: { minimumBuilds: { ios: 100, android: Number.POSITIVE_INFINITY } }, message: /must be a positive integer/ },
    { args: { storeUrls: { ios: 'http://apps.apple.com/app/x' } }, message: /must be an https URL/ },
    { args: { storeUrls: { android: 'javascript:alert(1)' } }, message: /must be an https URL/ },
    { args: { storeUrls: { android: 'not a url' } }, message: /must be an https URL/ },
    { args: {}, message: /at least one field/ },
  ];

  for (const invalid of invalidWrites) {
    const { db, ctx } = setup(ADMIN_SUBJECT);
    const before = structuredClone(db.tables);

    await assert.rejects(setAppConfig(ctx, invalid.args), invalid.message);

    assert.deepEqual(db.tables, before);
  }
});

const CREDENTIALED_STORE_URLS: Array<{ platform: 'ios' | 'android'; form: string; url: string }> = [
  { platform: 'ios', form: 'username only', url: 'https://user@apps.apple.com/app/example' },
  { platform: 'ios', form: 'username and password', url: 'https://user:password@apps.apple.com/app/example' },
  { platform: 'android', form: 'username only', url: 'https://user@play.google.com/store/apps/details?id=com.example' },
  {
    platform: 'android',
    form: 'username and password',
    url: 'https://user:password@play.google.com/store/apps/details?id=com.example',
  },
];

for (const credentialed of CREDENTIALED_STORE_URLS) {
  test(`an admin write rejects an ${credentialed.platform} store URL with ${credentialed.form}, and writes nothing`, async () => {
    const { db, ctx } = setup(ADMIN_SUBJECT);
    const before = structuredClone(db.tables);

    await assert.rejects(
      setAppConfig(ctx, { storeUrls: { [credentialed.platform]: credentialed.url } }),
      /must be an https URL/,
    );

    assert.deepEqual(db.tables, before);
  });
}

test('an unauthorized account passing caller-identity fields in args is refused, and nothing is written', async () => {
  const { db, ctx } = setup('clerk_user');
  const before = structuredClone(db.tables);

  await assert.rejects(
    setAppConfig(ctx, { ...VALID_WRITE, userId: 'users|admin', adminId: 'users|admin', updatedBy: 'users|admin' }),
    { message: denialMessage('forbidden') },
  );

  assert.deepEqual(db.tables, before);
});

test('the first write needs minimumBuilds, and a refused first write creates no row', async () => {
  const { db, ctx } = setup(ADMIN_SUBJECT, []);
  const before = structuredClone(db.tables);

  await assert.rejects(setAppConfig(ctx, { paymentsEnabled: true }), /minimumBuilds is required/);

  assert.deepEqual(db.tables, before);
});

test('an admin write is read back by both queries', async () => {
  const { db, ctx } = setup(ADMIN_SUBJECT, []);

  await setAppConfig(ctx, VALID_WRITE);

  const anonymous = createCtx(db, null);
  const gate = await getClientGate(anonymous, { platform: 'ios', build: 119 });
  const android = await getClientGate(anonymous, { platform: 'android', build: 259 });
  const availability = await getPaymentAvailability(anonymous, {});
  const [stored] = db.tables.appConfig ?? [];

  assert.deepEqual(
    { updateRequired: gate.updateRequired, minimumBuild: gate.minimumBuild, storeUrl: gate.storeUrl },
    { updateRequired: true, minimumBuild: 120, storeUrl: STORE_URLS.ios },
  );
  assert.deepEqual(
    { updateRequired: android.updateRequired, minimumBuild: android.minimumBuild, storeUrl: android.storeUrl },
    { updateRequired: true, minimumBuild: 260, storeUrl: STORE_URLS.android },
  );
  assert.equal(availability.paymentsEnabled, true);
  assert.equal(stored?.updatedBy, 'users|admin');
  assert.equal(typeof stored?.updatedAt, 'number');
});

test('a first write without paymentsEnabled leaves payments off', async () => {
  const { db, ctx } = setup(ADMIN_SUBJECT, []);

  await setAppConfig(ctx, { minimumBuilds: { ios: 120, android: 260 } });

  assert.deepEqual(await getPaymentAvailability(createCtx(db, null), {}), { paymentsEnabled: false });
});

test('a second write updates the same singleton row instead of inserting another', async () => {
  const { db, ctx } = setup(ADMIN_SUBJECT, []);

  await setAppConfig(ctx, VALID_WRITE);
  await setAppConfig(ctx, { paymentsEnabled: false });

  const rows = db.tables.appConfig ?? [];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.paymentsEnabled, false);
  assert.deepEqual(rows[0]?.minimumBuilds, { ios: 120, android: 260 });
});

test('a write updates only the store URL platforms it names', async () => {
  const { db, ctx } = setup(ADMIN_SUBJECT);

  await setAppConfig(ctx, { storeUrls: { ios: 'https://apps.apple.com/app/new' } });

  assert.deepEqual(db.tables.appConfig?.[0]?.storeUrls, {
    ios: 'https://apps.apple.com/app/new',
    android: STORE_URLS.android,
  });
});

test('the recorded updatedBy is the verified admin, never a caller-supplied ID', async () => {
  const { db, ctx } = setup(ADMIN_SUBJECT);

  await setAppConfig(ctx, { paymentsEnabled: false, updatedBy: 'users|moderator' });

  assert.equal(db.tables.appConfig?.[0]?.updatedBy, 'users|admin');
});
