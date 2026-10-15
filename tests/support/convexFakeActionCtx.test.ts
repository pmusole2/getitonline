import assert from 'node:assert/strict';
import test from 'node:test';

import { actionGeneric, internalQueryGeneric, makeFunctionReference } from 'convex/server';
import { convexToJson, v } from 'convex/values';

import { createDb } from './convexFakeDb';
import { createFakeActionCtx, invokeFakeFunction } from './convexFakeActionCtx';

// The fake must reject what the real Convex runtime rejects: unknown object fields, literals outside the union, ids from
// the wrong table, and malformed nested values. A rejected call must never reach the handler.

const historyArgs = v.optional(
  v.array(
    v.object({
      role: v.union(v.literal('user'), v.literal('assistant')),
      content: v.string(),
    }),
  ),
);

function chatLike() {
  let runs = 0;
  const action = actionGeneric({
    args: { message: v.string(), history: historyArgs, productId: v.optional(v.id('products')) },
    handler: async (_ctx, args) => {
      runs += 1;
      return args;
    },
  });
  return { action, runs: () => runs };
}

function expectRejection(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  return assert.rejects(promise, (error: unknown) => error instanceof Error && pattern.test(error.message));
}

const CTX = {};

test('a valid call reaches the handler with its arguments', async () => {
  const { action, runs } = chatLike();

  const result = await invokeFakeFunction(action, CTX, {
    message: 'hi',
    history: [{ role: 'user', content: 'earlier' }],
    productId: 'products|7',
  });

  assert.deepEqual(result, { message: 'hi', history: [{ role: 'user', content: 'earlier' }], productId: 'products|7' });
  assert.equal(runs(), 1);
});

test('omitted and undefined optional fields are valid', async () => {
  const { action, runs } = chatLike();

  await invokeFakeFunction(action, CTX, { message: 'hi', history: undefined, productId: undefined });
  await invokeFakeFunction(action, CTX, { message: 'hi' });

  assert.equal(runs(), 2);
});

test('an unexpected top-level field is rejected before the handler runs', async () => {
  const { action, runs } = chatLike();

  await expectRejection(
    invokeFakeFunction(action, CTX, { message: 'hi', userId: 'users|1' }),
    /argument validation.*userId/i,
  );
  assert.equal(runs(), 0);
});

test('a history role outside the literal union is rejected', async () => {
  const { action, runs } = chatLike();

  await expectRejection(
    invokeFakeFunction(action, CTX, { message: 'hi', history: [{ role: 'system', content: 'x' }] }),
    /argument validation.*role/i,
  );
  assert.equal(runs(), 0);
});

test('an unexpected field inside a nested object is rejected', async () => {
  const { action, runs } = chatLike();

  await expectRejection(
    invokeFakeFunction(action, CTX, { message: 'hi', history: [{ role: 'user', content: 'x', extra: 1 }] }),
    /argument validation.*extra/i,
  );
  assert.equal(runs(), 0);
});

test('a malformed element inside a nested array is rejected', async () => {
  const { action, runs } = chatLike();

  await expectRejection(
    invokeFakeFunction(action, CTX, { message: 'hi', history: [{ role: 'user', content: 'x' }, 'oops'] }),
    /argument validation.*history/i,
  );
  await expectRejection(
    invokeFakeFunction(action, CTX, { message: 'hi', history: 'not an array' }),
    /argument validation.*history/i,
  );
  assert.equal(runs(), 0);
});

test('a missing required argument is rejected', async () => {
  const { action, runs } = chatLike();

  await expectRejection(invokeFakeFunction(action, CTX, { history: undefined }), /argument validation.*message/i);
  assert.equal(runs(), 0);
});

test('a value of the wrong primitive type is rejected', async () => {
  const { action, runs } = chatLike();

  await expectRejection(invokeFakeFunction(action, CTX, { message: 5 }), /argument validation.*message/i);
  assert.equal(runs(), 0);
});

test('an id from the wrong table is rejected, and an id with the right table prefix is accepted', async () => {
  const { action, runs } = chatLike();

  await expectRejection(
    invokeFakeFunction(action, CTX, { message: 'hi', productId: 'users|1' }),
    /argument validation.*productId/i,
  );
  await expectRejection(
    invokeFakeFunction(action, CTX, { message: 'hi', productId: 'products' }),
    /argument validation/i,
  );
  assert.equal(runs(), 0);

  await invokeFakeFunction(action, CTX, { message: 'hi', productId: 'products|1' });
  assert.equal(runs(), 1);
});

test('a registered function without a validator is rejected rather than run unchecked', async () => {
  let runs = 0;
  const bare = {
    _handler: async () => {
      runs += 1;
      return null;
    },
  };

  await expectRejection(invokeFakeFunction(bare, CTX, {}), /no argument validator/i);
  assert.equal(runs, 0);
});

const callerArgs = v.union(
  v.object({ kind: v.literal('account'), userId: v.id('users') }),
  v.object({ kind: v.literal('guest') }),
);

function registeredQuery() {
  let runs = 0;
  const query = internalQueryGeneric({
    args: { caller: callerArgs },
    handler: async (_ctx, args) => {
      runs += 1;
      return args.caller.kind;
    },
  });
  return { query, runs: () => runs };
}

test('runQuery enforces the validator and does not run the handler on a wrong-table id', async () => {
  const { query, runs } = registeredQuery();
  const ref = makeFunctionReference<'query', { caller: unknown }, string>('aiData:chatContext');
  const calls: string[] = [];
  const ctx = createFakeActionCtx({
    db: createDb({}),
    subject: null,
    modules: { aiData: { chatContext: query } },
    calls,
  });

  await expectRejection(
    ctx.runQuery(ref, { caller: { kind: 'account', userId: 'products|1' } }),
    /argument validation/i,
  );
  assert.equal(runs(), 0);
  assert.deepEqual(calls, []);
});

test('runQuery rejects an extra field inside a union member and passes a valid caller', async () => {
  const { query, runs } = registeredQuery();
  const ref = makeFunctionReference<'query', { caller: unknown }, string>('aiData:chatContext');
  const ctx = createFakeActionCtx({
    db: createDb({}),
    subject: null,
    modules: { aiData: { chatContext: query } },
  });

  await expectRejection(ctx.runQuery(ref, { caller: { kind: 'guest', sessionId: 'x' } }), /argument validation/i);
  assert.equal(runs(), 0);

  assert.equal(await ctx.runQuery(ref, { caller: { kind: 'guest' } }), 'guest');
  assert.equal(runs(), 1);
});

// Arguments pass through the real Convex serialization before validation, so a value that convexToJson rejects never
// reaches a handler, and a validator literal is compared in the same encoding the runtime uses.

function anyArgAction() {
  let runs = 0;
  const action = actionGeneric({
    args: { value: v.any() },
    handler: async (_ctx, args) => {
      runs += 1;
      return args;
    },
  });
  return { action, runs: () => runs };
}

test('under v.any() a function, Date, Map, or undefined array element is rejected before the handler runs', async () => {
  const { action, runs } = anyArgAction();

  await expectRejection(invokeFakeFunction(action, CTX, { value: () => 1 }), /argument validation/i);
  await expectRejection(invokeFakeFunction(action, CTX, { value: new Date(0) }), /argument validation/i);
  await expectRejection(invokeFakeFunction(action, CTX, { value: new Map([['a', 1]]) }), /argument validation/i);
  await expectRejection(invokeFakeFunction(action, CTX, { value: [undefined] }), /argument validation/i);
  assert.equal(runs(), 0);
});

test('under v.any() an out-of-range bigint and a $-prefixed object field are rejected before the handler runs', async () => {
  const { action, runs } = anyArgAction();

  await expectRejection(invokeFakeFunction(action, CTX, { value: 2n ** 63n }), /argument validation/i);
  await expectRejection(
    invokeFakeFunction(action, CTX, { value: { $integer: 'x', plain: 1 } }),
    /argument validation/i,
  );
  await expectRejection(invokeFakeFunction(action, CTX, { value: { $x: 1 } }), /argument validation/i);
  assert.equal(runs(), 0);
});

test('a v.literal(1n) argument is accepted when it is 1n and rejected otherwise', async () => {
  let runs = 0;
  const action = actionGeneric({
    args: { mode: v.literal(1n) },
    handler: async (_ctx, args) => {
      runs += 1;
      return args.mode;
    },
  });

  assert.equal(await invokeFakeFunction(action, CTX, { mode: 1n }), 1n);
  await expectRejection(invokeFakeFunction(action, CTX, { mode: 2n }), /argument validation.*mode/i);
  await expectRejection(invokeFakeFunction(action, CTX, { mode: 1 }), /argument validation.*mode/i);
  assert.equal(runs, 1);
});

test('a v.record(v.string(), v.number()) argument is accepted when every value matches and rejected otherwise', async () => {
  let runs = 0;
  const action = actionGeneric({
    args: { counts: v.record(v.string(), v.number()) },
    handler: async (_ctx, args) => {
      runs += 1;
      return args.counts;
    },
  });

  assert.deepEqual(await invokeFakeFunction(action, CTX, { counts: { a: 1, b: 2 } }), { a: 1, b: 2 });
  await expectRejection(invokeFakeFunction(action, CTX, { counts: { a: 'x' } }), /argument validation.*counts/i);
  await expectRejection(invokeFakeFunction(action, CTX, { counts: 'nope' }), /argument validation.*counts/i);
  assert.equal(runs, 1);
});

test('v.nullable and a union of literals keep accepting their members and rejecting others', async () => {
  let runs = 0;
  const action = actionGeneric({
    args: { note: v.nullable(v.string()), kind: v.union(v.literal('a'), v.literal(2)) },
    handler: async (_ctx, args) => {
      runs += 1;
      return args;
    },
  });

  await invokeFakeFunction(action, CTX, { note: null, kind: 'a' });
  await invokeFakeFunction(action, CTX, { note: 'x', kind: 2 });
  await expectRejection(invokeFakeFunction(action, CTX, { note: 5, kind: 'a' }), /argument validation.*note/i);
  await expectRejection(invokeFakeFunction(action, CTX, { note: null, kind: 3 }), /argument validation.*kind/i);
  assert.equal(runs, 2);
});

test('the handler receives the round-tripped arguments, with undefined fields dropped and bigints decoded', async () => {
  const { action } = anyArgAction();

  const result = await invokeFakeFunction(action, CTX, { value: { a: undefined, b: 1n } });

  assert.deepStrictEqual(result, { value: { b: 1n } });
});

test('a validator kind the fake does not know still throws instead of passing', async () => {
  let runs = 0;
  const unknownKind = {
    exportArgs: () => JSON.stringify({ type: 'mystery' }),
    _handler: async () => {
      runs += 1;
      return null;
    },
  };

  await expectRejection(invokeFakeFunction(unknownKind, CTX, {}), /Unsupported validator mystery/);
  assert.equal(runs, 0);
});

// Each value is checked against the real serializer: the fake must accept an argument exactly when convexToJson
// accepts it under v.any(). The args object wraps the value because the runtime drops undefined top-level fields.
const SERIALIZATION_CASES: ReadonlyArray<readonly [string, unknown]> = [
  ['null', null],
  ['string', 'text'],
  ['boolean', true],
  ['finite number', 1.5],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['negative zero', -0],
  ['in-range bigint', 2n ** 63n - 1n],
  ['out-of-range bigint', 2n ** 63n],
  ['ArrayBuffer', new ArrayBuffer(4)],
  ['Uint8Array', new Uint8Array(2)],
  ['function', () => 1],
  ['Date', new Date(0)],
  ['Map', new Map([['a', 1]])],
  ['Set', new Set([1])],
  [
    'class instance',
    new (class Foo {
      x = 1;
    })(),
  ],
  ['array', [1, 'two']],
  ['array with undefined element', [undefined]],
  ['array with a function element', [() => 1]],
  ['object with an undefined field', { a: undefined, b: 1 }],
  ['object with a $-prefixed field', { $x: 1 }],
  ['object with a control-character field', { 'a\u0001': 1 }],
  ['object with a non-ASCII field', { é: 1 }],
  ['object with an over-long field', { ['k'.repeat(1025)]: 1 }],
  ['nested object with a Date', { inner: { when: new Date(0) } }],
];

for (const [label, value] of SERIALIZATION_CASES) {
  test(`under v.any() the fake agrees with convexToJson on ${label}`, async () => {
    let realRejects = false;
    try {
      convexToJson({ value });
    } catch {
      realRejects = true;
    }

    const { action } = anyArgAction();
    let fakeAccepts = true;
    try {
      await invokeFakeFunction(action, CTX, { value });
    } catch {
      fakeAccepts = false;
    }

    assert.equal(fakeAccepts, !realRejects);
  });
}
