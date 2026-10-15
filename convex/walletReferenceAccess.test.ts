import assert from 'node:assert/strict';
import test from 'node:test';

import * as wallet from './wallet';
import { createCtx, createDb, handlerOf, type Row } from '../tests/support/convexFakeDb';

// Real handler execution with DB/auth doubles. This does not test SDK validation or deployed JWT transport.
const lookup = handlerOf<Record<string, unknown>, Row | null>(wallet.getTransactionByReference);

function setup(subject: string | null) {
  const db = createDb({
    users: ['owner', 'other', 'admin', 'moderator', 'catalog', 'banned', 'deleted'].map((name) => ({
      _id: `users|${name}`,
      clerkId: name,
      email: `${name}@example.invalid`,
      firstName: name,
      lastName: 'Fixture',
      role: name === 'catalog' ? 'catalog_manager' : ['admin', 'moderator'].includes(name) ? name : 'user',
      isBanned: name === 'banned',
      ...(name === 'deleted' ? { deletedAt: 1 } : {}),
      isVerified: true,
      totalSales: 0,
      totalPurchases: 0,
    })),
    wallets: [
      {
        _id: 'wallets|owner',
        userId: 'users|owner',
        balance: 100,
        pendingBalance: 0,
        totalEarned: 100,
        totalSpent: 0,
        totalWithdrawn: 0,
        currency: 'ZMW',
        isActive: true,
        isFrozen: false,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    walletTransactions: [
      {
        _id: 'walletTransactions|credit',
        walletId: 'wallets|owner',
        userId: 'users|owner',
        reference: 'REF-credit',
        type: 'credit',
        source: 'sale',
        amount: 100,
        balanceAfter: 100,
        status: 'completed',
        createdAt: 1,
      },
    ],
  });

  return { db, ctx: createCtx(db, subject) };
}

test('wallet references return the full ledger row to its owner and verified admin', async () => {
  for (const subject of ['owner', 'admin']) {
    const { db, ctx } = setup(subject);
    const before = structuredClone(db.tables);
    assert.deepEqual(await lookup(ctx, { reference: 'REF-credit' }), db.tables.walletTransactions?.[0]);
    assert.deepEqual(db.tables, before);
  }
});

test('wallet references refuse other accounts, reviewers and catalog delegates despite supplied authority IDs', async () => {
  for (const subject of ['other', 'moderator', 'catalog']) {
    const { db, ctx } = setup(subject);
    const before = structuredClone(db.tables);
    await assert.rejects(
      () => lookup(ctx, { reference: 'REF-credit', userId: 'users|owner', adminId: 'users|admin' }),
      /Unauthorized/,
    );
    assert.deepEqual(db.tables, before);
  }
});

for (const [label, subject, message] of [
  ['anonymous', null, /Unauthenticated/],
  ['unknown', 'unknown', /Account not found/],
  ['banned', 'banned', /Account is banned/],
  ['deleted', 'deleted', /Account is deleted/],
] as const) {
  test(`wallet reference rejects ${label} before private lookup, including absent references`, async () => {
    const { db, ctx } = setup(subject);
    const before = structuredClone(db.tables);
    const query = db.query;
    db.query = (table) => {
      assert.equal(table, 'users');
      return query(table);
    };
    for (const reference of ['REF-credit', 'REF-missing']) {
      await assert.rejects(() => lookup(ctx, { reference }), message);
    }
    assert.deepEqual(db.tables, before);
  });
}

test('missing wallet references preserve null for active accounts', async () => {
  assert.equal(await lookup(setup('other').ctx, { reference: 'REF-missing' }), null);
});

test('ledger ownership cannot disclose a different wallet, and admins may inspect inconsistent legacy rows', async () => {
  for (const changedField of ['walletOwner', 'ledgerOwner', 'missingWallet']) {
    const { db, ctx } = setup('owner');
    const linkedWallet = db.tables.wallets?.[0];
    const row = db.tables.walletTransactions?.[0];
    assert.ok(linkedWallet && row);
    if (changedField === 'walletOwner') {
      linkedWallet.userId = 'users|other';
    }
    if (changedField === 'ledgerOwner') {
      row.userId = 'users|other';
    }
    if (changedField === 'missingWallet') {
      db.tables.wallets = [];
    }
    const before = structuredClone(db.tables);
    await assert.rejects(() => lookup(ctx, { reference: 'REF-credit' }), /Unauthorized/);
    assert.deepEqual(await lookup(createCtx(db, 'admin'), { reference: 'REF-credit' }), row);
    assert.deepEqual(db.tables, before);
  }
});
