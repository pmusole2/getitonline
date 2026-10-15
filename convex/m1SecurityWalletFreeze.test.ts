import assert from 'node:assert/strict';
import test from 'node:test';

import * as wallet from './wallet';
import { denialMessage } from './lib/auth';
import { createCtx, createDb, handlerOf, type Db, type Row } from '../tests/support/convexFakeDb';

// Freezing and unfreezing a wallet is an admin-only server action. The acting admin comes from the verified token.
// The fake database does not roll back, so every refusal must leave the wallet and notification tables unchanged.

type Args = Record<string, unknown>;

const freezeWallet = handlerOf<Args, { success: boolean }>(wallet.freezeWallet);
const unfreezeWallet = handlerOf<Args, { success: boolean }>(wallet.unfreezeWallet);

const WALLET_ID = 'wallets|buyer';

function account(id: string, clerkId: string, role: string, extra: Record<string, unknown> = {}): Row {
  return {
    _id: id,
    clerkId,
    email: `${clerkId}@example.invalid`,
    firstName: 'Fixture',
    role,
    isBanned: false,
    ...extra,
  };
}

function setup(subject: string | null, walletOverrides: Record<string, unknown> = {}) {
  const db: Db = createDb({
    users: [
      account('users|admin', 'clerk_admin', 'admin'),
      account('users|moderator', 'clerk_moderator', 'moderator'),
      account('users|catalog', 'clerk_catalog', 'catalog_manager'),
      account('users|user', 'clerk_user', 'user'),
      account('users|buyer', 'clerk_buyer', 'user'),
      account('users|banned-admin', 'clerk_banned_admin', 'admin', { isBanned: true }),
      account('users|deleted-admin', 'clerk_deleted_admin', 'admin', { deletedAt: 1 }),
    ],
    wallets: [{ _id: WALLET_ID, userId: 'users|buyer', isFrozen: false, balance: 10, ...walletOverrides }],
    notifications: [],
  });
  return { db, ctx: createCtx(db, subject) };
}

test('an active admin freezes a wallet, records the reason, and notifies the wallet owner', async () => {
  const { db, ctx } = setup('clerk_admin');

  assert.deepEqual(await freezeWallet(ctx, { walletId: WALLET_ID, reason: 'Chargeback review' }), { success: true });

  const frozen = db.tables.wallets?.[0];
  assert.equal(frozen?.isFrozen, true);
  assert.equal(frozen?.freezeReason, 'Chargeback review');
  assert.equal(db.tables.notifications?.length, 1);
  assert.equal(db.tables.notifications?.[0]?.userId, 'users|buyer');
  assert.equal(db.tables.notifications?.[0]?.title, 'Wallet Frozen');
});

test('an active admin unfreezes a wallet, clears the reason, and notifies the wallet owner', async () => {
  const { db, ctx } = setup('clerk_admin', { isFrozen: true, freezeReason: 'Chargeback review' });

  assert.deepEqual(await unfreezeWallet(ctx, { walletId: WALLET_ID }), { success: true });

  const restored = db.tables.wallets?.[0];
  assert.equal(restored?.isFrozen, false);
  assert.equal(restored?.freezeReason, undefined);
  assert.equal(db.tables.notifications?.length, 1);
  assert.equal(db.tables.notifications?.[0]?.title, 'Wallet Unfrozen');
});

const REFUSED_ACTORS = [
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

for (const actor of REFUSED_ACTORS) {
  test(`${actor.label} cannot freeze a wallet, and nothing is written`, async () => {
    const { db, ctx } = setup(actor.subject);
    const before = structuredClone(db.tables);

    await assert.rejects(freezeWallet(ctx, { walletId: WALLET_ID, reason: 'Probe' }), { message: actor.message });

    assert.deepEqual(db.tables, before);
  });

  test(`${actor.label} cannot unfreeze a wallet, and nothing is written`, async () => {
    const { db, ctx } = setup(actor.subject, { isFrozen: true, freezeReason: 'Hold' });
    const before = structuredClone(db.tables);

    await assert.rejects(unfreezeWallet(ctx, { walletId: WALLET_ID }), { message: actor.message });

    assert.deepEqual(db.tables, before);
  });
}

// The guard runs before the wallet is read. A refused caller may cause only the account lookup inside the guard; any
// read of the wallet table, even one that is later refused, would show the guard was moved below the read.
function recordReads(db: Db, reads: string[]): Db {
  return {
    ...db,
    get: async (id: string) => {
      reads.push(id.split('|')[0] ?? id);
      return await db.get(id);
    },
    query: (table: string) => {
      reads.push(table);
      return db.query(table);
    },
  };
}

for (const actor of REFUSED_ACTORS) {
  test(`${actor.label} is refused before any wallet read when freezing`, async () => {
    const { db } = setup(actor.subject);
    const reads: string[] = [];
    const ctx = createCtx(recordReads(db, reads), actor.subject);

    await assert.rejects(freezeWallet(ctx, { walletId: WALLET_ID, reason: 'Probe' }), { message: actor.message });

    assert.deepEqual(
      reads.filter((table) => table !== 'users'),
      [],
    );
  });

  test(`${actor.label} is refused before any wallet read when unfreezing`, async () => {
    const { db } = setup(actor.subject, { isFrozen: true, freezeReason: 'Hold' });
    const reads: string[] = [];
    const ctx = createCtx(recordReads(db, reads), actor.subject);

    await assert.rejects(unfreezeWallet(ctx, { walletId: WALLET_ID }), { message: actor.message });

    assert.deepEqual(
      reads.filter((table) => table !== 'users'),
      [],
    );
  });
}

test('a moderator cannot unfreeze a frozen wallet, so the hold stays in place', async () => {
  const { db, ctx } = setup('clerk_moderator', { isFrozen: true, freezeReason: 'Fraud hold' });
  const before = structuredClone(db.tables);

  await assert.rejects(unfreezeWallet(ctx, { walletId: WALLET_ID }), { message: denialMessage('forbidden') });

  assert.equal(db.tables.wallets?.[0]?.isFrozen, true);
  assert.deepEqual(db.tables, before);
});

test('a caller-supplied adminId does not elevate an ordinary user or a moderator', async () => {
  const ordinary = setup('clerk_user');
  const ordinaryBefore = structuredClone(ordinary.db.tables);
  await assert.rejects(freezeWallet(ordinary.ctx, { walletId: WALLET_ID, reason: 'x', adminId: 'users|admin' }), {
    message: denialMessage('forbidden'),
  });
  assert.deepEqual(ordinary.db.tables, ordinaryBefore);

  const moderator = setup('clerk_moderator', { isFrozen: true, freezeReason: 'Hold' });
  const moderatorBefore = structuredClone(moderator.db.tables);
  await assert.rejects(unfreezeWallet(moderator.ctx, { walletId: WALLET_ID, adminId: 'users|admin' }), {
    message: denialMessage('forbidden'),
  });
  assert.deepEqual(moderator.db.tables, moderatorBefore);
});

test('a real admin acting with a spoofed adminId of another user still acts as themself', async () => {
  const { db, ctx } = setup('clerk_admin');

  await freezeWallet(ctx, { walletId: WALLET_ID, reason: 'Review', adminId: 'users|moderator' });

  assert.equal(db.tables.wallets?.[0]?.isFrozen, true);
  assert.equal(db.tables.notifications?.length, 1);
});
