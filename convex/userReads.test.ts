import assert from 'node:assert/strict';
import test from 'node:test';

import * as users from './users';
import { createCtx, createDb, handlerOf, type Db, type Row, type Tables } from '../tests/support/convexFakeDb';

// Runs the real user read handlers against the in-memory database. A user record holds contact details, so an account
// reads its own record, and reviewers and admins read any record. Another signed-in account is refused, and a
// caller-supplied ID never grants authority. The role listing is for admins only.

type Args = Record<string, unknown>;

const getUser = handlerOf<Args, Row | null>(users.getUser);
const getUsersByRole = handlerOf<Args, Row[]>(users.getUsersByRole);

function account(id: string, clerkId: string, role: string, extra: Record<string, unknown> = {}): Row {
  return {
    _id: id,
    clerkId,
    email: `${clerkId}@example.invalid`,
    phone: `+260 ${id}`,
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
      account('users|ada', 'clerk_ada', 'user'),
      account('users|bea', 'clerk_bea', 'user'),
      account('users|catalog', 'clerk_catalog', 'catalog_manager'),
      account('users|moderator', 'clerk_moderator', 'moderator'),
      account('users|admin', 'clerk_admin', 'admin'),
      account('users|admin2', 'clerk_admin2', 'admin'),
      account('users|banned', 'clerk_banned', 'user', { isBanned: true }),
      account('users|deleted', 'clerk_deleted', 'user', { deletedAt: 1 }),
    ],
  };
}

function setup(clerkId: string | null) {
  const db: Db = createDb(fixtureTables());
  return { db, ctx: createCtx(db, clerkId) };
}

const DENIALS: Array<{ label: string; clerkId: string | null; pattern: RegExp }> = [
  { label: 'anonymous', clerkId: null, pattern: /Unauthenticated/ },
  { label: 'unknown', clerkId: 'clerk_nobody', pattern: /Account not found/ },
  { label: 'banned', clerkId: 'clerk_banned', pattern: /Account is banned/ },
  { label: 'deleted', clerkId: 'clerk_deleted', pattern: /Account is deleted/ },
];

test('getUser: an account reads its own full record', async () => {
  const { db, ctx } = setup('clerk_ada');
  const own = await getUser(ctx, { userId: 'users|ada' });
  assert.deepEqual(
    own,
    db.tables.users?.find((row) => row._id === 'users|ada'),
  );
});

test('getUser: reviewers and admins read any account', async () => {
  for (const clerkId of ['clerk_moderator', 'clerk_admin']) {
    const { ctx } = setup(clerkId);
    const other = await getUser(ctx, { userId: 'users|bea' });
    assert.equal(other?._id, 'users|bea', `${clerkId} must read the record`);
    assert.equal(other?.email, 'clerk_bea@example.invalid');
  }
});

test('getUser: another signed-in account is refused, whatever ID or role it names', async () => {
  for (const clerkId of ['clerk_ada', 'clerk_catalog']) {
    const { ctx } = setup(clerkId);
    await assert.rejects(() => getUser(ctx, { userId: 'users|bea' }), /Unauthorized/);
    await assert.rejects(() => getUser(ctx, { userId: 'users|admin' }), /Unauthorized/);
    await assert.rejects(
      () => getUser(ctx, { userId: 'users|bea', viewerId: 'users|admin', adminId: 'users|admin' }),
      /Unauthorized/,
      'a caller-supplied staff ID must not grant access',
    );
  }
});

test('getUser: a missing record reads as null for any signed-in account', async () => {
  for (const clerkId of ['clerk_ada', 'clerk_admin']) {
    const { ctx } = setup(clerkId);
    assert.equal(await getUser(ctx, { userId: 'users|missing' }), null);
  }
});

test('getUser: anonymous, unknown, banned, and deleted callers are refused, and nothing changes', async () => {
  for (const denial of DENIALS) {
    const { db, ctx } = setup(denial.clerkId);
    const before = structuredClone(db.tables);
    await assert.rejects(() => getUser(ctx, { userId: 'users|ada' }), denial.pattern, denial.label);
    assert.deepEqual(db.tables, before);
  }
});

test('getUsersByRole: admins list accounts by role', async () => {
  const { ctx } = setup('clerk_admin');
  const admins = await getUsersByRole(ctx, { role: 'admin' });
  assert.deepEqual(admins.map((row) => row._id).sort(), ['users|admin', 'users|admin2']);
});

test('getUsersByRole: every other signed-in role is refused', async () => {
  for (const clerkId of ['clerk_ada', 'clerk_catalog', 'clerk_moderator']) {
    const { ctx } = setup(clerkId);
    await assert.rejects(() => getUsersByRole(ctx, { role: 'admin' }), /Unauthorized/, clerkId);
  }
});

test('getUsersByRole: anonymous, unknown, banned, and deleted callers are refused', async () => {
  for (const denial of DENIALS) {
    const { ctx } = setup(denial.clerkId);
    await assert.rejects(() => getUsersByRole(ctx, { role: 'admin' }), denial.pattern, denial.label);
  }
});
