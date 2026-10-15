import assert from 'node:assert/strict';
import test from 'node:test';

import { decideAccess } from './auth';

type UserRecord = Parameters<typeof decideAccess>[0]['user'];

const activeUser = {
  _id: 'users|1',
  clerkId: 'clerk_1',
  role: 'user',
  isBanned: false,
} as unknown as NonNullable<UserRecord>;

test('rejects a request without a verified identity', () => {
  assert.deepEqual(decideAccess({ subject: null, user: activeUser }), {
    ok: false,
    reason: 'unauthenticated',
  });
});

test('rejects a signed-in identity with no stored account', () => {
  assert.deepEqual(decideAccess({ subject: 'clerk_1', user: null }), {
    ok: false,
    reason: 'unknown_user',
  });
});

test('rejects banned and deleted accounts even for allowed roles', () => {
  const banned = { ...activeUser, role: 'admin', isBanned: true } as unknown as NonNullable<UserRecord>;
  const deleted = { ...activeUser, role: 'admin', deletedAt: 1 } as unknown as NonNullable<UserRecord>;
  assert.equal(decideAccess({ subject: 'clerk_1', user: banned, allowedRoles: ['admin'] }).ok, false);
  assert.deepEqual(decideAccess({ subject: 'clerk_1', user: banned }), { ok: false, reason: 'banned' });
  assert.deepEqual(decideAccess({ subject: 'clerk_1', user: deleted }), { ok: false, reason: 'deleted' });
});

test('enforces allowed roles', () => {
  const moderator = { ...activeUser, role: 'moderator' } as unknown as NonNullable<UserRecord>;
  assert.deepEqual(decideAccess({ subject: 'clerk_1', user: activeUser, allowedRoles: ['admin'] }), {
    ok: false,
    reason: 'forbidden',
  });
  assert.equal(decideAccess({ subject: 'clerk_1', user: moderator, allowedRoles: ['admin', 'moderator'] }).ok, true);
});

test('allows any active signed-in user when no role is required', () => {
  const decision = decideAccess({ subject: 'clerk_1', user: activeUser });
  assert.equal(decision.ok, true);
  if (decision.ok) {
    assert.equal(decision.user._id, 'users|1');
  }
});

import { canActFor } from './auth';

test('owners act for themselves; staff only when their role allows it', () => {
  const owner = { _id: 'users|1', role: 'user' } as unknown as Parameters<typeof canActFor>[0]['actor'];
  const admin = { _id: 'users|2', role: 'admin' } as unknown as Parameters<typeof canActFor>[0]['actor'];
  const target = 'users|1' as Parameters<typeof canActFor>[0]['targetUserId'];
  assert.equal(canActFor({ actor: owner, targetUserId: target }), true);
  assert.equal(canActFor({ actor: admin, targetUserId: target }), false);
  assert.equal(canActFor({ actor: admin, targetUserId: target, staffRoles: ['admin'] }), true);
});
