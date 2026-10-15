import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import React, { act, createElement } from 'react';
import { AiRequestError } from '../../../../packages/shared/src/ai/aiRequests';
import { createControls, createHarness } from '../../../../tests/support/componentHarness';
import { createFakeConvexClient, mountUnderConvex } from '../../../../tests/support/realReactRender';
import type { RecommendationsResponse } from '../services/aiAdapters';
import type { useCartRecommendations } from './useCartRecommendations';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const file = (path: string): string => resolve(root, path);
interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}
const controller = {
  _id: 'controller',
  title: 'DualSense Controller',
  price: 1200,
  sellerId: 'seller',
  status: 'active',
  quantity: 2,
};
const reply: RecommendationsResponse = {
  source: 'ai',
  productIds: ['controller'],
  reasoning: 'Suggested for your cart',
};

interface Rig {
  mounted: ReturnType<typeof mountUnderConvex>;
  requests: { input: unknown; gate: Deferred<RecommendationsResponse> }[];
  queries: { input: unknown; gate: Deferred<unknown[]> }[];
  observations: ReturnType<typeof useCartRecommendations>[];
  readonly latest: ReturnType<typeof useCartRecommendations>;
  render(): Promise<void>;
  cart(productId: string, quantity?: number): void;
  account(next: string | null): void;
  consent(accepted: boolean): Promise<void>;
  resolve(index?: number, value?: RecommendationsResponse): Promise<void>;
  products(index?: number, value?: unknown[]): Promise<void>;
}

function rig(strictRoot = false): Rig {
  let items = [{ productId: 'ps5', quantity: 1 }];
  let subject = 'account:a';
  let generation = 0;
  let user: { _id: string } | null = { _id: 'buyer' };
  let consent = deferred<boolean>();
  const requests: { input: unknown; gate: ReturnType<typeof deferred<RecommendationsResponse>> }[] = [];
  const queries: { input: unknown; gate: ReturnType<typeof deferred<unknown[]>> }[] = [];
  const actionsFor = () => {
    const started = generation;
    return {
      subject,
      isCurrent: () => started === generation,
      getRecommendations: (input: unknown) => {
        const gate = deferred<RecommendationsResponse>();
        requests.push({ input, gate });
        return gate.promise;
      },
    };
  };
  let actions = actionsFor();
  const client = {
    query: (_reference: unknown, input: unknown) => {
      const gate = deferred<unknown[]>();
      queries.push({ input, gate });
      return gate.promise;
    },
  };
  const controls = createControls();
  const harness = createHarness({
    controls,
    files: {
      [file('apps/mobile/src/context/AuthProvider.tsx')]: { useAppAuth: () => ({ user }) },
      [file('apps/mobile/src/hooks/useAiActions.ts')]: { useAiActions: () => actions },
      [file('apps/mobile/src/services/aiConsent.ts')]: { requestAIConsent: () => consent.promise },
    },
    packages: { react: React, 'convex/react': { useConvex: () => client }, '@gettitonline/shared': { AiRequestError } },
  });
  const useHook = harness.load(file('apps/mobile/src/hooks/useCartRecommendations.ts'))
    .useCartRecommendations as typeof useCartRecommendations;
  let latest!: ReturnType<typeof useCartRecommendations>;
  const observations: ReturnType<typeof useCartRecommendations>[] = [];
  const Probe = (): null => {
    latest = useHook({ items: items.map((item) => ({ ...item })), enabled: true });
    observations.push(latest);
    return null;
  };
  const mounted = mountUnderConvex(createFakeConvexClient(), { strictRoot });
  return {
    mounted,
    requests,
    queries,
    observations,
    get latest() {
      return latest;
    },
    render: () => mounted.render(createElement(Probe)),
    cart: (productId: string, quantity = 1) => {
      items = [{ productId, quantity }];
    },
    account: (next: string | null) => {
      generation += 1;
      subject = next ? `account:${next}` : 'guest';
      user = next ? { _id: next } : null;
      actions = actionsFor();
    },
    consent: async (accepted: boolean) => {
      await act(async () => consent.resolve(accepted));
      consent = deferred<boolean>();
    },
    resolve: async (index = 0, value = reply) => {
      await act(async () => requests[index]?.gate.resolve(value));
    },
    products: async (index = 0, value: unknown[] = [controller]) => {
      await act(async () => queries[index]?.gate.resolve(value));
    },
  };
}

test('cart hook sends cart IDs, loads real details and excludes in-cart, self, inactive and unexpected products', async () => {
  const r = rig();
  try {
    await r.render();
    assert.equal(r.latest.status, 'loading');
    assert.deepEqual(r.requests[0]?.input, { limit: 3, cartProductIds: ['ps5'] });
    await r.resolve(0, { ...reply, productIds: ['ps5', 'controller', 'own', 'inactive', 'sold'] });
    await r.products(0, [
      controller,
      { ...controller, _id: 'ps5' },
      { ...controller, _id: 'own', sellerId: 'buyer' },
      { ...controller, _id: 'inactive', status: 'inactive' },
      { ...controller, _id: 'sold', quantity: 0 },
      { ...controller, _id: 'unexpected' },
    ]);
    assert.equal(r.latest.status, 'ready');
    assert.deepEqual(
      r.latest.products.map((p) => p._id),
      ['controller'],
    );
    await r.render();
    await r.render();
    assert.equal(r.requests.length, 1, 'recreated item arrays do not loop');
  } finally {
    await r.mounted.unmount();
  }
});

test('cart changes hide existing products on the first render and an A-B-A cycle discards old replies', async () => {
  const r = rig();
  try {
    await r.render();
    await r.resolve();
    await r.products();
    r.cart('headphones');
    const start = r.observations.length;
    await r.render();
    assert.deepEqual(r.observations[start]?.products, [], 'no stale product during the changed-cart render');
    r.cart('ps5');
    await r.render();
    await r.resolve(1);
    assert.equal(r.queries.length, 1, 'old B reply cannot request details for new A');
    await r.resolve(2);
    assert.equal(r.queries.length, 2);
    r.cart('ps5', 2);
    await r.render();
    await r.products(1);
    assert.deepEqual(r.latest.products, [], 'late details are discarded after a quantity change');
  } finally {
    await r.mounted.unmount();
  }
});

test('a superseded original A reply and account-switch replies cannot return after A-B-A', async () => {
  const r = rig();
  try {
    await r.render();
    r.cart('headphones');
    await r.render();
    r.cart('ps5');
    await r.render();
    await r.resolve(0);
    assert.equal(r.queries.length, 0);
    await r.resolve(2);
    r.account('b');
    await r.render();
    r.account('a');
    await r.render();
    await r.products();
    assert.deepEqual(r.latest.products, []);
    await r.resolve(3);
    assert.equal(r.queries.length, 1);
  } finally {
    await r.mounted.unmount();
  }
});

test('fallback IDs are never displayed and provider or details failures show an honest error', async () => {
  const r = rig();
  try {
    await r.render();
    await r.resolve(0, { ...reply, source: 'fallback' });
    assert.equal(r.latest.status, 'empty');
    assert.equal(r.queries.length, 0);
    r.cart('headphones');
    await r.render();
    await act(async () => r.requests[1]?.gate.reject(new Error('offline')));
    assert.equal(r.latest.status, 'error');
    assert.deepEqual(r.latest.products, []);
    r.cart('ps5');
    await r.render();
    await r.resolve(2);
    await act(async () => r.queries[0]?.gate.reject(new Error('offline')));
    assert.equal(r.latest.status, 'error');
  } finally {
    await r.mounted.unmount();
  }
});

test('consent denial dispatches nothing, acceptance refreshes only the same current cart, guests ask for sign-in', async () => {
  const r = rig();
  try {
    await r.render();
    await act(async () => r.requests[0]?.gate.reject(new AiRequestError('consent_required')));
    assert.equal(r.latest.status, 'consent_required');
    let ask!: Promise<void>;
    await act(async () => {
      ask = r.latest.askPinkie();
    });
    await r.consent(false);
    await ask;
    assert.equal(r.requests.length, 1);
    assert.equal(r.latest.status, 'consent_required');
    await act(async () => {
      ask = r.latest.askPinkie();
    });
    r.cart('headphones');
    await r.render();
    await r.consent(true);
    await ask;
    assert.equal(r.requests.length, 2, 'stale consent continuation starts no extra request');
    await act(async () => r.requests[1]?.gate.reject(new AiRequestError('consent_required')));
    await act(async () => {
      ask = r.latest.askPinkie();
    });
    await r.consent(true);
    await ask;
    assert.equal(r.requests.length, 3, 'current consent acceptance requests recommendations');
    r.account(null);
    await r.render();
    assert.equal(r.latest.status, 'guest');
    assert.deepEqual(r.latest.products, []);
    assert.equal(r.requests.length, 3);
  } finally {
    await r.mounted.unmount();
  }
});

test('unmount retires a provider request and a pending consent prompt', async () => {
  const r = rig();
  await r.render();
  await r.mounted.unmount();
  await r.resolve();
  assert.equal(r.queries.length, 0);
  const c = rig();
  await c.render();
  await act(async () => c.requests[0]?.gate.reject(new AiRequestError('consent_required')));
  let ask!: Promise<void>;
  await act(async () => {
    ask = c.latest.askPinkie();
  });
  await c.mounted.unmount();
  await c.consent(true);
  await ask;
  assert.equal(c.requests.length, 1);
});

test('StrictMode replay retires its first request and does not create a render loop', async () => {
  const r = rig(true);
  try {
    await r.render();
    assert.equal(r.requests.length, 2);
    await r.resolve(0);
    assert.equal(r.queries.length, 0, 'replayed effect request is retired');
    await r.resolve(1);
    await r.products();
    assert.equal(r.latest.status, 'ready');
    await r.render();
    assert.equal(r.requests.length, 2);
  } finally {
    await r.mounted.unmount();
  }
});

test('a product query settling after unmount publishes no state', async () => {
  const r = rig();
  await r.render();
  await r.resolve();
  assert.equal(r.queries.length, 1);
  await r.mounted.unmount();
  const before = r.observations.length;
  await r.products();
  assert.equal(r.observations.length, before);
});

test('details which became out of stock or preorder while loading are excluded', async () => {
  const r = rig();
  try {
    await r.render();
    await r.resolve(0, { ...reply, productIds: ['controller', 'sold', 'preorder', 'scheduled'] });
    await r.products(0, [
      controller,
      { ...controller, _id: 'sold', availabilityStatus: 'out_of_stock' },
      { ...controller, _id: 'preorder', availabilityStatus: 'preorder' },
      { ...controller, _id: 'scheduled', preorder: { isPreorder: true } },
    ]);
    assert.deepEqual(
      r.latest.products.map((product) => product._id),
      ['controller'],
    );
  } finally {
    await r.mounted.unmount();
  }
});

for (const variant of [
  { status: 'inactive', stock: 4 },
  { status: 'out_of_stock', stock: 4 },
  { status: 'active', stock: 0 },
  { status: 'active', stock: 0.5 },
  { status: 'active', stock: Number.MAX_SAFE_INTEGER + 1 },
]) {
  test(`details exclude ${variant.status} variant stock ${variant.stock} despite positive parent stock`, async () => {
    const r = rig();
    try {
      await r.render();
      await r.resolve();
      assert.equal(r.queries.length, 1, 'the provider reply is accepted before variant details settle');
      await r.products(0, [{ ...controller, quantity: 4, variantCombinations: [variant] }]);
      assert.equal(r.latest.status, 'empty');
      assert.deepEqual(r.latest.products, [], 'no purchasable variant remains');
    } finally {
      await r.mounted.unmount();
    }
  });
}

test('details keep a variant product when an active positive-stock combination remains', async () => {
  const r = rig();
  try {
    await r.render();
    await r.resolve();
    await r.products(0, [
      {
        ...controller,
        quantity: 8,
        variantCombinations: [
          { status: 'inactive', stock: 4 },
          { status: 'out_of_stock', stock: 1 },
          { status: 'active', stock: 0 },
          { status: 'active', stock: 3 },
        ],
      },
    ]);
    assert.equal(r.latest.status, 'ready');
    assert.deepEqual(
      r.latest.products.map((product) => product._id),
      ['controller'],
    );
  } finally {
    await r.mounted.unmount();
  }
});

for (const quantity of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
  test(`details reject unavailable legacy options with quantity ${quantity} in any dimension`, async () => {
    const r = rig();
    try {
      await r.render();
      await r.resolve();
      await r.products(0, [
        {
          ...controller,
          quantity: 4,
          variantCombinations: [],
          variants: [
            { name: 'Colour', options: [{ name: 'Black', value: 'black' }] },
            { name: 'Size', options: [{ name: 'Small', value: 'small', quantity }] },
          ],
        },
      ]);
      assert.equal(r.latest.status, 'empty');
      assert.deepEqual(r.latest.products, []);
    } finally {
      await r.mounted.unmount();
    }
  });
}

test('legacy options remain available when each dimension has an unspecified or positive integer quantity', async () => {
  const r = rig();
  try {
    await r.render();
    await r.resolve();
    await r.products(0, [
      {
        ...controller,
        variants: [
          { name: 'Colour', options: [{ name: 'Black', value: 'black' }] },
          {
            name: 'Size',
            options: [
              { name: 'Small', value: 'small', quantity: 0 },
              { name: 'Large', value: 'large', quantity: 2 },
            ],
          },
        ],
      },
    ]);
    assert.equal(r.latest.status, 'ready');
    assert.deepEqual(
      r.latest.products.map((product) => product._id),
      ['controller'],
    );
  } finally {
    await r.mounted.unmount();
  }
});
