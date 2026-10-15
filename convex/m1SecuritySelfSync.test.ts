import assert from 'node:assert/strict';
import test from 'node:test';

import * as users from './users';
import { denialMessage } from './lib/auth';
import { createCtx, createDb, handlerOf, type Db, type Row } from '../tests/support/convexFakeDb';

// The public self-sync runs on a valid token and writes the caller's own record. A banned account must not be able
// to keep rewriting its own contact details. The verified Clerk webhook still syncs banned accounts: it is signed
// maintenance, not the account acting for itself.

type Args = Record<string, unknown>;

const upsertUser = handlerOf<Args, unknown>(users.upsertUser);
const upsertUserFromClerkWebhook = handlerOf<Args, unknown>(users.upsertUserFromClerkWebhook);

const PROFILE = {
  email: 'new@example.invalid',
  firstName: 'New',
  lastName: 'Name',
  avatar: 'https://cdn.example/a.png',
};

function setup(rows: Row[]): { db: Db } {
  return { db: createDb({ users: rows }) };
}

function bannedAccount(): Row {
  return {
    _id: 'users|banned',
    clerkId: 'clerk_banned',
    email: 'old@example.invalid',
    firstName: 'Old',
    lastName: 'Name',
    role: 'user',
    isBanned: true,
    updatedAt: 1,
  };
}

test('an active user first sync creates the account with the default role', async () => {
  const { db } = setup([]);

  const userId = await upsertUser(createCtx(db, 'clerk_new'), PROFILE);

  const created = db.tables.users?.[0];
  assert.equal(db.tables.users?.length, 1);
  assert.equal(created?._id, userId);
  assert.equal(created?.clerkId, 'clerk_new');
  assert.equal(created?.email, PROFILE.email);
  assert.equal(created?.role, 'user');
  assert.equal(created?.isBanned, false);
});

test('an active user sync updates the signed-in user record', async () => {
  const { db } = setup([
    {
      _id: 'users|active',
      clerkId: 'clerk_active',
      email: 'old@example.invalid',
      firstName: 'Old',
      role: 'user',
      isBanned: false,
    },
  ]);

  const userId = await upsertUser(createCtx(db, 'clerk_active'), PROFILE);

  assert.equal(userId, 'users|active');
  assert.equal(db.tables.users?.[0]?.email, PROFILE.email);
  assert.equal(db.tables.users?.[0]?.firstName, 'New');
});

test('a banned account cannot change its own email, name, or avatar through the public sync', async () => {
  const { db } = setup([bannedAccount()]);
  const before = structuredClone(db.tables);

  await assert.rejects(upsertUser(createCtx(db, 'clerk_banned'), PROFILE), { message: denialMessage('banned') });

  assert.deepEqual(db.tables, before);
});

test('a banned account that also has a deleted marker is reported as deleted, and nothing is written', async () => {
  const { db } = setup([
    bannedAccount(),
    { _id: 'users|legacy', clerkId: 'deleted:clerk_banned', deletedAt: 1, isBanned: true, role: 'user' },
  ]);
  const before = structuredClone(db.tables);

  await assert.rejects(upsertUser(createCtx(db, 'clerk_banned'), PROFILE), { message: denialMessage('deleted') });

  assert.deepEqual(db.tables, before);
});

test('the verified Clerk webhook still syncs a banned account', async () => {
  const { db } = setup([bannedAccount()]);

  const userId = await upsertUserFromClerkWebhook(createCtx(db, null), { clerkId: 'clerk_banned', ...PROFILE });

  assert.equal(userId, 'users|banned');
  assert.equal(db.tables.users?.[0]?.email, PROFILE.email);
  assert.equal(db.tables.users?.[0]?.isBanned, true);
});

test('the verified Clerk webhook still creates a record for a new subject', async () => {
  const { db } = setup([]);

  const userId = await upsertUserFromClerkWebhook(createCtx(db, null), { clerkId: 'clerk_webhook', ...PROFILE });

  assert.equal(db.tables.users?.[0]?._id, userId);
  assert.equal(db.tables.users?.[0]?.clerkId, 'clerk_webhook');
});
