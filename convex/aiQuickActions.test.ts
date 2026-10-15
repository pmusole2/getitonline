import assert from 'node:assert/strict';
import test from 'node:test';

import * as aiQuickActions from './aiQuickActions';
import { invokeFakeFunction } from '../tests/support/convexFakeActionCtx';

// The quick actions are static suggestions. They take no account, make no provider call, and read nothing, so this
// file proves each of those by making any fetch or any database or identity access throw.

const LEGACY: Record<string, string[]> = {
  Home: [
    'How many products are listed?',
    'What categories are available?',
    'Show me the cheapest items',
    'What are the newest listings?',
  ],
  Browse: ['Filter by price range', 'Show new arrivals only', 'Find items near me', 'Compare similar products'],
  ProductDetail: [
    'Is this a good price?',
    'What shipping options are available?',
    'Tell me about the seller',
    'Are there similar products?',
  ],
  Cart: ['What is my total?', 'Apply discount code', 'Change shipping method', 'Checkout help'],
  Orders: ['Track my latest order', 'How many orders do I have?', 'Request a refund', 'Contact the seller'],
  Profile: [
    'How many items have I sold?',
    'What is my seller rating?',
    'Show my active listings',
    'How many views on my products?',
  ],
};

// A context whose every property access throws, so any database or identity read fails the test.
const SEALED_CTX = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`the quick action touched ctx.${String(property)}`);
    },
  },
);

async function withoutNetwork<T>(run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('the quick action called fetch');
  };
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('getQuickActions is a public query', () => {
  assert.equal(Reflect.get(aiQuickActions.getQuickActions, 'isPublic'), true);
});

test('getQuickActions with no arguments returns the legacy Home list, without a db read, identity read, or fetch', async () => {
  const result = await withoutNetwork(
    async () => await invokeFakeFunction(aiQuickActions.getQuickActions, SEALED_CTX, {}),
  );
  assert.deepEqual(result, LEGACY.Home);
});

test('getQuickActions returns the legacy list for each known screen', async () => {
  for (const screen of Object.keys(LEGACY)) {
    const result = await withoutNetwork(
      async () => await invokeFakeFunction(aiQuickActions.getQuickActions, SEALED_CTX, { currentScreen: screen }),
    );
    assert.deepEqual(result, LEGACY[screen], screen);
  }
});

test('getQuickActions returns the Home list for an unknown or missing screen, including prototype names', async () => {
  for (const screen of ['Checkout', '', 'constructor', '__proto__', 'toString']) {
    const result = await withoutNetwork(
      async () => await invokeFakeFunction(aiQuickActions.getQuickActions, SEALED_CTX, { currentScreen: screen }),
    );
    assert.deepEqual(result, LEGACY.Home, `screen ${JSON.stringify(screen)}`);
  }
});

test('getQuickActions returns a stable shape: a list of non-empty strings', async () => {
  const result = await withoutNetwork(
    async () => await invokeFakeFunction(aiQuickActions.getQuickActions, SEALED_CTX, { currentScreen: 'Cart' }),
  );
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 4);
  for (const item of result) {
    assert.equal(typeof item, 'string');
    assert.notEqual(item, '');
  }
});
