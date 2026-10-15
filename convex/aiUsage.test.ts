import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import * as aiUsage from './aiUsage';
import { createCtx, createDb, handlerOf, type Db, type Row, type Tables } from '../tests/support/convexFakeDb';

// These tests run the real reserveAiCall handler against the in-memory fake. The fake does not roll back, so every
// refusal must be decided before the first write, and each refusal must leave every table unchanged.

type Args = Record<string, unknown>;

const reserveAiCall = handlerOf<Args, null>(aiUsage.reserveAiCall);

const INDEXES = {
  aiUsage: { by_scope_key_window: ['scope', 'key', 'window', 'windowStart'] },
  appConfig: { by_key: ['key'] },
};

const MINUTE = 60_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 10, 12, 0, 0);
const NEXT_DAY = Date.UTC(2026, 9, 11, 0, 0, 0);

const REFUSAL = 'AI usage limit reached';

type Caller = { kind: 'account'; userId: string } | { kind: 'guest'; sessionId: string };

const account = (userId: string): Caller => ({ kind: 'account', userId });
const guest = (sessionId: string): Caller => ({ kind: 'guest', sessionId });

// Replaces Date.now for one call, so windows can be placed exactly. Calls in these tests run one at a time.
async function atTime<T>(now: number, run: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  Date.now = () => now;
  try {
    return await run();
  } finally {
    Date.now = realNow;
  }
}

function newDb(tables: Tables = {}): Db {
  return createDb(tables, INDEXES);
}

// Resolves true when the call is accepted and false when it is refused for any usage limit.
async function reserve(db: Db, caller: Caller, now: number): Promise<boolean> {
  try {
    await atTime(now, () => reserveAiCall(createCtx(db, null), { caller }));
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && error.message === REFUSAL) {
      return false;
    }
    throw error;
  }
}

function usage(db: Db, scope: string, key: string, window: 'minute' | 'day', windowStart: number): number {
  const row: Row | undefined = db.tables.aiUsage?.find(
    (candidate) =>
      candidate.scope === scope &&
      candidate.key === key &&
      candidate.window === window &&
      candidate.windowStart === windowStart,
  );
  return typeof row?.count === 'number' ? row.count : 0;
}

async function reserveMany(db: Db, caller: Caller, now: number, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    assert.equal(await reserve(db, caller, now), true, `call ${i + 1} of ${times} must be accepted`);
  }
}

const dayOf = (now: number): number => Math.floor(now / DAY) * DAY;

test('reserveAiCall is internal, so no client can call it', () => {
  const source = readFileSync(new URL('./aiUsage.ts', import.meta.url), 'utf8');
  assert.match(source, /export const reserveAiCall = internalMutation\(/);
  assert.doesNotMatch(source, /export const reserveAiCall = mutation\(/);
});

test('an account is limited to 10 calls per minute, and the next minute opens a new counter', async () => {
  const db = newDb();
  await reserveMany(db, account('users|a'), T0, 10);

  assert.equal(await reserve(db, account('users|a'), T0 + 59_000), false);
  assert.equal(await reserve(db, account('users|a'), T0 + MINUTE), true);
  assert.equal(usage(db, 'account', 'users|a', 'minute', T0), 10, 'the earlier minute keeps its count');
  assert.equal(usage(db, 'account', 'users|a', 'minute', T0 + MINUTE), 1, 'the new minute starts a new row');
});

test('an account is limited to 100 calls per UTC day, across minutes, and the next day starts fresh', async () => {
  const db = newDb();
  for (let minute = 0; minute < 10; minute++) {
    await reserveMany(db, account('users|a'), T0 + minute * MINUTE, 10);
  }

  assert.equal(await reserve(db, account('users|a'), T0 + 10 * MINUTE), false, 'the 101st call of the day is refused');
  assert.equal(await reserve(db, account('users|a'), NEXT_DAY), true, 'the next UTC day allows calls again');
  assert.equal(usage(db, 'account', 'users|a', 'day', dayOf(T0)), 100);
  assert.equal(usage(db, 'account', 'users|a', 'day', NEXT_DAY), 1);
});

test('a guest session is limited to 5 calls per minute', async () => {
  const db = newDb();
  await reserveMany(db, guest('session-1'), T0, 5);

  assert.equal(await reserve(db, guest('session-1'), T0), false);
  assert.equal(await reserve(db, guest('session-1'), T0 + MINUTE), true);
});

test('a guest session is limited to 20 calls per UTC day, across minutes', async () => {
  const db = newDb();
  for (let minute = 0; minute < 4; minute++) {
    await reserveMany(db, guest('session-1'), T0 + minute * MINUTE, 5);
  }

  assert.equal(await reserve(db, guest('session-1'), T0 + 4 * MINUTE), false);
  assert.equal(await reserve(db, guest('session-1'), NEXT_DAY), true);
});

test('the global per-minute limit of 100 applies to accounts as well as guests', async () => {
  const db = newDb();
  for (let i = 1; i <= 10; i++) {
    await reserveMany(db, account(`users|${i}`), T0, 10);
  }

  assert.equal(await reserve(db, account('users|fresh'), T0), false, 'a fresh account is still stopped by global');
  assert.equal(usage(db, 'global', 'global', 'minute', T0), 100);
  assert.equal(await reserve(db, account('users|fresh'), T0 + MINUTE), true);
});

test('the global per-day limit of 1000 stops calls even when every account has room', async () => {
  const db = newDb();
  for (let minute = 0; minute < 10; minute++) {
    for (let i = 1; i <= 10; i++) {
      await reserveMany(db, account(`users|${i}`), T0 + minute * MINUTE, 10);
    }
  }

  assert.equal(usage(db, 'global', 'global', 'day', dayOf(T0)), 1000);
  assert.equal(await reserve(db, account('users|fresh'), T0 + 10 * MINUTE), false);
  assert.equal(await reserve(db, account('users|fresh'), NEXT_DAY), true, 'global day counter rolls over');
});

test('guest traffic takes at most 20 of the 100 per-minute global calls, and signed-in callers still get the other 80', async () => {
  const db = newDb();
  for (let i = 1; i <= 4; i++) {
    await reserveMany(db, guest(`guest-${i}`), T0, 5);
  }

  assert.equal(await reserve(db, guest('guest-5'), T0), false, 'the all-guests minute cap stops the fifth session');
  assert.equal(usage(db, 'global', 'global', 'minute', T0), 20);

  for (let i = 1; i <= 8; i++) {
    await reserveMany(db, account(`users|${i}`), T0, 10);
  }

  assert.equal(usage(db, 'global', 'global', 'minute', T0), 100);
  assert.equal(await reserve(db, account('users|9'), T0), false, 'the global minute is full after 80 signed-in calls');
});

test('guest traffic takes at most 200 of the 1000 daily global calls, and signed-in callers still reserve afterwards', async () => {
  const db = newDb();
  for (let minute = 0; minute < 10; minute++) {
    for (let i = 1; i <= 10; i++) {
      await reserveMany(db, guest(`guest-${i}`), T0 + minute * MINUTE, 2);
    }
  }

  assert.equal(usage(db, 'allGuests', 'all', 'day', dayOf(T0)), 200);
  assert.equal(usage(db, 'global', 'global', 'day', dayOf(T0)), 200);
  assert.equal(await reserve(db, guest('guest-new'), T0 + 10 * MINUTE), false, 'the all-guests day cap is reached');

  assert.equal(await reserve(db, account('users|signed-in'), T0 + 10 * MINUTE), true);
  assert.equal(usage(db, 'global', 'global', 'day', dayOf(T0)), 201);
});

test('one abusive guest exhausts only its own bucket, and other guests stay available', async () => {
  const db = newDb();
  for (let minute = 0; minute < 4; minute++) {
    await reserveMany(db, guest('abuser'), T0 + minute * MINUTE, 5);
  }

  assert.equal(await reserve(db, guest('abuser'), T0 + 4 * MINUTE), false, 'the abuser is stopped at 20 per day');
  assert.equal(await reserve(db, guest('abuser'), NEXT_DAY), true, 'the abuser recovers on the next UTC day');

  assert.equal(await reserve(db, guest('bystander'), T0 + 4 * MINUTE), true, 'the bystander is not affected');
  assert.equal(usage(db, 'allGuests', 'all', 'day', dayOf(T0)), 21);
});

test('two different accounts are counted independently', async () => {
  const db = newDb();
  await reserveMany(db, account('users|a'), T0, 10);

  assert.equal(await reserve(db, account('users|a'), T0), false);
  await reserveMany(db, account('users|b'), T0, 10);
});

test('a successful account call increments the global and account counters only', async () => {
  const db = newDb();
  assert.equal(await reserve(db, account('users|a'), T0), true);

  assert.equal(usage(db, 'global', 'global', 'minute', T0), 1);
  assert.equal(usage(db, 'global', 'global', 'day', dayOf(T0)), 1);
  assert.equal(usage(db, 'account', 'users|a', 'minute', T0), 1);
  assert.equal(usage(db, 'account', 'users|a', 'day', dayOf(T0)), 1);
  assert.equal(db.tables.aiUsage?.length, 4);
});

test('a successful guest call increments the guest, all-guests, and global counters', async () => {
  const db = newDb();
  assert.equal(await reserve(db, guest('session-1'), T0), true);

  assert.equal(usage(db, 'guest', 'session-1', 'minute', T0), 1);
  assert.equal(usage(db, 'guest', 'session-1', 'day', dayOf(T0)), 1);
  assert.equal(usage(db, 'allGuests', 'all', 'minute', T0), 1);
  assert.equal(usage(db, 'allGuests', 'all', 'day', dayOf(T0)), 1);
  assert.equal(usage(db, 'global', 'global', 'minute', T0), 1);
  assert.equal(usage(db, 'global', 'global', 'day', dayOf(T0)), 1);
  assert.equal(db.tables.aiUsage?.length, 6);
});

test('a refused account call leaves every table unchanged', async () => {
  const db = newDb({ appConfig: [] });
  await reserveMany(db, account('users|a'), T0, 10);
  const before = structuredClone(db.tables);

  assert.equal(await reserve(db, account('users|a'), T0), false);
  assert.deepEqual(db.tables, before);
});

test('a refused guest call writes nothing, even when the guest bucket still has room', async () => {
  const db = newDb();
  for (let i = 1; i <= 4; i++) {
    await reserveMany(db, guest(`guest-${i}`), T0, 5);
  }
  const before = structuredClone(db.tables);

  assert.equal(await reserve(db, guest('guest-5'), T0), false);
  assert.deepEqual(db.tables, before, 'no guest row, no all-guests increment, and no global increment');
});

test('a call with an empty guest session is rejected before any write', async () => {
  const db = newDb();
  const before = structuredClone(db.tables);

  await assert.rejects(() => reserveAiCall(createCtx(db, null), { caller: guest('') }), /Invalid AI session/);
  assert.deepEqual(db.tables, before);
});

const INVALID_SESSION = { message: 'Invalid AI session' };

// Asserts a guest session is refused before any database access and leaves every table unchanged. The first context's
// db throws on any use, so a read or write ahead of the session check fails the test.
async function assertGuestSessionRejected(sessionId: string, label: string): Promise<void> {
  const untouchable = {
    db: new Proxy(
      {},
      {
        get: () => {
          throw new Error('database accessed before the session check');
        },
      },
    ),
  };
  await assert.rejects(() => reserveAiCall(untouchable, { caller: guest(sessionId) }), INVALID_SESSION, label);

  const db = newDb();
  await reserveMany(db, account('users|a'), T0, 1);
  const before = structuredClone(db.tables);
  await assert.rejects(() => reserveAiCall(createCtx(db, null), { caller: guest(sessionId) }), INVALID_SESSION, label);
  assert.deepEqual(db.tables, before, label);
}

test('a guest session ID of exactly 128 characters is accepted, and 129 characters is rejected', async () => {
  assert.equal(await reserve(newDb(), guest('a'.repeat(128)), T0), true);
  await assertGuestSessionRejected('a'.repeat(129), '129-character session ID');
});

test('a 100,000-character guest session ID is rejected before any row is written', async () => {
  await assertGuestSessionRejected('x'.repeat(100_000), '100,000-character session ID');
});

test('a guest session ID with whitespace or control characters is rejected', async () => {
  const rejected = [
    'guest one',
    'guest\tone',
    'guest\none',
    'guest\rone',
    ' guest',
    'guest ',
    '   ',
    'guest\u0000',
    'guest\u007f',
  ];
  for (const sessionId of rejected) {
    await assertGuestSessionRejected(sessionId, JSON.stringify(sessionId));
  }
});

test('a guest session ID with non-ASCII characters is rejected', async () => {
  const rejected = ['café', 'guest-🛒', 'guest id', 'ｇｕｅｓｔ'];
  for (const sessionId of rejected) {
    await assertGuestSessionRejected(sessionId, JSON.stringify(sessionId));
  }
});

test('ordinary guest session IDs such as a UUID or a dotted id are accepted', async () => {
  for (const sessionId of ['3f2504e0-4f89-41d3-9a0c-0305e82c3301', 'guest_abc-123.def', 'x']) {
    assert.equal(await reserve(newDb(), guest(sessionId), T0), true, sessionId);
  }
});

test('the guest session check does not apply to account callers', async () => {
  const longUserId = `users|${'a'.repeat(200)}`;
  const db = newDb();
  assert.equal(await reserve(db, account(longUserId), T0), true);
  assert.equal(usage(db, 'account', longUserId, 'minute', T0), 1);
});

test('an unset or malformed aiLimits override falls back to the defaults', async () => {
  for (const aiLimits of [undefined, 'bogus', { account: { perMinute: -3, perDay: 2.5 } }]) {
    const db = newDb({ appConfig: [{ _id: 'appConfig|1', key: 'singleton', aiLimits }] });
    await reserveMany(db, account('users|a'), T0, 10);

    assert.equal(await reserve(db, account('users|a'), T0), false, `${JSON.stringify(aiLimits)} keeps 10 per minute`);
  }
});

test('a configured aiLimits override raises the limit it names without changing the others', async () => {
  const db = newDb({
    appConfig: [{ _id: 'appConfig|1', key: 'singleton', aiLimits: { account: { perMinute: 12 } } }],
  });
  await reserveMany(db, account('users|a'), T0, 12);

  assert.equal(await reserve(db, account('users|a'), T0), false);

  await reserveMany(db, guest('session-1'), T0, 5);
  assert.equal(await reserve(db, guest('session-1'), T0), false, 'guest per-minute stays at the default 5');
});

test('an aiLimits override saved after deploy applies to the next call', async () => {
  const db = newDb();
  await reserveMany(db, guest('session-1'), T0, 5);
  assert.equal(await reserve(db, guest('session-1'), T0), false);

  db.tables.appConfig = [{ _id: 'appConfig|1', key: 'singleton', aiLimits: { guest: { perMinute: 6 } } }];
  assert.equal(await reserve(db, guest('session-1'), T0), true);
});
