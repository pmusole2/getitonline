import assert from 'node:assert/strict';
import test from 'node:test';

import * as users from './users';
import { createCtx, createDb, handlerOf, type Db, type Row, type Tables } from '../tests/support/convexFakeDb';

// Runs the real profile and preference handlers against the in-memory database. Each account reads and changes only its
// own record, and no caller-supplied user ID can name another account, staff accounts included. Every rejection also
// asserts that no table changed, because the fake does not roll writes back.

type Args = Record<string, unknown>;

const updateProfile = handlerOf<Args, Row | null>(users.updateProfile);
const updateInterests = handlerOf<Args, Row | null>(users.updateInterests);
const getPreferences = handlerOf<Args, Row>(users.getPreferences);
const updatePreferences = handlerOf<Args, Row>(users.updatePreferences);
const updateThemeMode = handlerOf<Args, string>(users.updateThemeMode);

const DEFAULT_PREFERENCES = { themeMode: 'system', notificationsEnabled: true };

function account(id: string, clerkId: string, role: string, extra: Record<string, unknown> = {}): Row {
  return {
    _id: id,
    clerkId,
    email: `${clerkId}@example.invalid`,
    firstName: 'Fixture',
    lastName: id,
    role,
    isBanned: false,
    isVerified: true,
    totalSales: 0,
    totalPurchases: 0,
    ...extra,
  };
}

function fixtureTables(): Tables {
  return {
    users: [
      account('users|ada', 'clerk_ada', 'user', {
        firstName: 'Ada',
        lastName: 'Lovelace',
        phone: '+260 971 000 001',
        avatar: 'https://example.invalid/ada.png',
        interests: ['categories|tech'],
        preferences: { themeMode: 'dark', notificationsEnabled: true, language: 'en' },
      }),
      account('users|bea', 'clerk_bea', 'user', { firstName: 'Bea', lastName: 'Buyer', phone: '+260 971 000 002' }),
      account('users|moderator', 'clerk_moderator', 'moderator', {
        firstName: 'Mo',
        lastName: 'Derator',
        preferences: { themeMode: 'light', notificationsEnabled: true },
      }),
      account('users|admin', 'clerk_admin', 'admin', { firstName: 'Ada', lastName: 'Min' }),
      account('users|banned', 'clerk_banned', 'user', { isBanned: true }),
      account('users|deleted', 'clerk_deleted', 'user', { deletedAt: 1 }),
    ],
  };
}

function setup(clerkId: string | null) {
  const db: Db = createDb(fixtureTables());
  return { db, ctx: createCtx(db, clerkId) };
}

function userRow(db: Db, id: string): Row {
  const row = db.tables.users?.find((candidate) => candidate._id === id);
  assert.ok(row, `${id} must exist`);
  return row;
}

async function rejectsWithoutWrites(db: Db, attempt: () => Promise<unknown>, pattern: RegExp) {
  const before = structuredClone(db.tables);
  await assert.rejects(attempt, pattern);
  assert.deepEqual(db.tables, before, 'a rejected call must not change any table');
}

const ADDRESS = { street: '1 Main Road', city: 'Lusaka', province: 'Lusaka', country: 'Zambia' };

test('updateProfile changes only the verified account, and a caller-supplied userId names nobody', async () => {
  const { db, ctx } = setup('clerk_ada');
  const bea = structuredClone(userRow(db, 'users|bea'));

  const updated = await updateProfile(ctx, { userId: 'users|bea', firstName: 'Grace' });

  assert.equal(updated?._id, 'users|ada');
  assert.equal(updated?.firstName, 'Grace');
  assert.deepEqual(userRow(db, 'users|bea'), bea, 'the other account must not change');
  assert.equal('userId' in userRow(db, 'users|ada'), false, 'the acting ID must never be stored');
});

test('updateProfile applies only the fields given and keeps every omitted field', async () => {
  const { db, ctx } = setup('clerk_ada');

  await updateProfile(ctx, { lastName: 'King' });

  const ada = userRow(db, 'users|ada');
  assert.equal(ada.firstName, 'Ada');
  assert.equal(ada.lastName, 'King');
  assert.equal(ada.phone, '+260 971 000 001');
  assert.equal(ada.avatar, 'https://example.invalid/ada.png');
});

test('updateProfile stores an address and an avatar, and returns the account record', async () => {
  const { db, ctx } = setup('clerk_ada');

  const updated = await updateProfile(ctx, { avatar: 'https://example.invalid/new.png', address: ADDRESS });

  assert.deepEqual(updated?.address, ADDRESS);
  assert.equal(userRow(db, 'users|ada').avatar, 'https://example.invalid/new.png');
  assert.equal(typeof updated?.updatedAt, 'number');
});

test('updateInterests sets the verified account categories, and ignores a caller-supplied userId', async () => {
  const { db, ctx } = setup('clerk_ada');
  const bea = structuredClone(userRow(db, 'users|bea'));

  const updated = await updateInterests(ctx, {
    userId: 'users|bea',
    interests: ['categories|music', 'categories|books'],
  });

  assert.deepEqual(updated?.interests, ['categories|music', 'categories|books']);
  assert.deepEqual(userRow(db, 'users|bea'), bea);
});

test('getPreferences returns the verified account preferences, not those of a requested user', async () => {
  const { ctx } = setup('clerk_ada');

  const prefs = await getPreferences(ctx, { userId: 'users|bea' });

  assert.deepEqual(prefs, { themeMode: 'dark', notificationsEnabled: true, language: 'en' });
});

test('getPreferences returns the defaults for an account without saved preferences', async () => {
  const { ctx } = setup('clerk_bea');
  assert.deepEqual(await getPreferences(ctx, {}), DEFAULT_PREFERENCES);
});

test('updatePreferences merges a partial update, keeps false values, and keeps omitted fields', async () => {
  const { db, ctx } = setup('clerk_ada');
  const bea = structuredClone(userRow(db, 'users|bea'));

  const prefs = await updatePreferences(ctx, { userId: 'users|bea', preferences: { notificationsEnabled: false } });

  assert.deepEqual(prefs, { themeMode: 'dark', notificationsEnabled: false, language: 'en' });
  assert.deepEqual(userRow(db, 'users|ada').preferences, prefs);
  assert.deepEqual(userRow(db, 'users|bea'), bea, 'the other account must not change');
});

test('updatePreferences starts from the defaults for an account without saved preferences', async () => {
  const { db, ctx } = setup('clerk_bea');

  const prefs = await updatePreferences(ctx, { preferences: { themeMode: 'light' } });

  assert.deepEqual(prefs, { themeMode: 'light', notificationsEnabled: true });
  assert.deepEqual(userRow(db, 'users|bea').preferences, prefs);
});

test('updateThemeMode stores each mode for the verified account only, and keeps the other preferences', async () => {
  for (const themeMode of ['light', 'dark', 'system']) {
    const { db, ctx } = setup('clerk_ada');
    const bea = structuredClone(userRow(db, 'users|bea'));

    const saved = await updateThemeMode(ctx, { userId: 'users|bea', themeMode });

    assert.equal(saved, themeMode);
    assert.deepEqual(userRow(db, 'users|ada').preferences, { themeMode, notificationsEnabled: true, language: 'en' });
    assert.deepEqual(userRow(db, 'users|bea'), bea);
  }
});

test('staff accounts change only their own profile and preferences', async () => {
  const moderator = setup('clerk_moderator');
  await updateProfile(moderator.ctx, { userId: 'users|ada', firstName: 'Moderated' });
  assert.equal(userRow(moderator.db, 'users|moderator').firstName, 'Moderated');
  assert.equal(userRow(moderator.db, 'users|ada').firstName, 'Ada');

  const admin = setup('clerk_admin');
  await updateThemeMode(admin.ctx, { userId: 'users|ada', themeMode: 'light' });
  assert.deepEqual(userRow(admin.db, 'users|admin').preferences, {
    themeMode: 'light',
    notificationsEnabled: true,
  });
  assert.deepEqual(userRow(admin.db, 'users|ada').preferences, {
    themeMode: 'dark',
    notificationsEnabled: true,
    language: 'en',
  });
});

// Denied callers never reach a read or a write. Each case names the account that tries, and a caller-supplied ID that
// points at another account.
const DENIALS: Array<{ label: string; clerkId: string | null; pattern: RegExp }> = [
  { label: 'anonymous', clerkId: null, pattern: /Unauthenticated/ },
  { label: 'unknown', clerkId: 'clerk_nobody', pattern: /Account not found/ },
  { label: 'banned', clerkId: 'clerk_banned', pattern: /Account is banned/ },
  { label: 'deleted', clerkId: 'clerk_deleted', pattern: /Account is deleted/ },
];

const CALLS: Array<{ name: string; call: (ctx: unknown) => Promise<unknown> }> = [
  { name: 'updateProfile', call: (ctx) => updateProfile(ctx, { userId: 'users|bea', firstName: 'Grace' }) },
  {
    name: 'updateInterests',
    call: (ctx) => updateInterests(ctx, { userId: 'users|bea', interests: ['categories|music'] }),
  },
  { name: 'getPreferences', call: (ctx) => getPreferences(ctx, { userId: 'users|bea' }) },
  {
    name: 'updatePreferences',
    call: (ctx) => updatePreferences(ctx, { userId: 'users|bea', preferences: { notificationsEnabled: false } }),
  },
  { name: 'updateThemeMode', call: (ctx) => updateThemeMode(ctx, { userId: 'users|bea', themeMode: 'light' }) },
];

for (const { name, call } of CALLS) {
  test(`${name}: anonymous, unknown, banned, and deleted callers are refused, and nothing changes`, async () => {
    for (const denial of DENIALS) {
      const { db, ctx } = setup(denial.clerkId);
      await rejectsWithoutWrites(db, () => call(ctx), denial.pattern);
    }
  });
}
