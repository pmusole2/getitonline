import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import {
  createControls,
  createHarness,
  findNodes,
  textOf,
  withFallback,
} from '../../../../../tests/support/componentHarness';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const file = (path: string): string => resolve(root, path);

function renderCart(
  status = 'ready',
  guest = false,
  variants?: { status: string; price: number; stock: number }[],
): {
  rendered: ReturnType<ReturnType<typeof createHarness>['render']>;
  calls: unknown[][];
} {
  const controls = createControls();
  const calls: unknown[][] = [];
  const product = {
    _id: 'ps5',
    title: 'PS5 Slim',
    price: 9000,
    images: [],
    quantity: 5,
    status: 'active',
    sellerId: 'seller',
    sellerName: 'Games',
  };
  controls.auth = { user: guest ? null : { _id: 'buyer' } };
  controls.queries['cart.getCart'] = {
    items: [{ _id: 'line', product, quantity: 1, selectedShipping: { name: 'Pickup', price: 0 } }],
    subtotal: 9000,
  };
  const harness = createHarness({
    controls,
    files: {
      [file('apps/mobile/src/context/AuthProvider.tsx')]: withFallback({ useAppAuth: () => controls.auth }),
      [file('apps/mobile/src/components/auth/useAccountAccess.ts')]: withFallback({
        useAccountAccess: () => ({ status: 'ready' }),
      }),
      [file('apps/mobile/src/context/GuestCartProvider.tsx')]: withFallback({
        useGuestCart: () => ({
          items: [{ productId: 'ps5', product, quantity: 1, selectedShipping: { name: 'Pickup', price: 0 } }],
          summary: { itemCount: 1, subtotal: 9000 },
          isHydrated: true,
          hasPendingMerge: false,
        }),
      }),
      [file('apps/mobile/src/hooks/useCartRecommendations.ts')]: withFallback({
        useCartRecommendations: () => ({
          status,
          products:
            status === 'ready'
              ? [{ _id: 'controller', title: 'DualSense Controller', price: 1200, variantCombinations: variants }]
              : [],
          error: 'Recommendations are unavailable. Try again.',
          askPinkie: () => calls.push(['ask']),
          refresh: () => calls.push(['refresh']),
        }),
      }),
      [file('apps/mobile/src/theme/index.ts')]: withFallback({ formatPrice: (price: number) => `K${price}` }),
    },
  });
  const screen = harness.load(file('apps/mobile/src/screens/cart/CartScreen.tsx')).default;
  const rendered = harness.render(screen, {
    navigation: { navigate: (...args: unknown[]) => calls.push(args), goBack: () => undefined },
  });
  return { rendered, calls };
}

test('PS5 cart retains Pinkie and displays a real recommended product with its detail link', () => {
  const { rendered, calls } = renderCart();
  const text = textOf(rendered.tree);
  assert.match(text, /PS5 Slim/);
  assert.match(text, /Pinkie\s*'s Recommendation/);
  assert.doesNotMatch(text, /brake fluid/i);
  assert.match(text, /DualSense Controller/);
  assert.match(text, /K1260/);
  const row = findNodes(rendered.tree, (node) => node.props.accessibilityLabel === 'View DualSense Controller')[0];
  assert.ok(row);
  (row.props.onPress as () => void)();
  assert.deepEqual(calls, [['ProductDetail', { productId: 'controller' }]]);
});

test('cart card truthfully presents loading, empty, failure, consent and guest states', () => {
  for (const [status, copy] of [
    ['loading', 'Finding suggestions for your cart'],
    ['empty', 'No suitable recommendations for this cart right now.'],
    ['error', 'Recommendations are unavailable. Try again.'],
    ['consent_required', 'Ask Pinkie'],
    ['guest', 'Sign in for cart recommendations'],
  ]) {
    const { rendered } = renderCart(status);
    assert.match(textOf(rendered.tree), new RegExp(copy.replace('.', '\\.')));
    assert.doesNotMatch(textOf(rendered.tree), /DualSense Controller|brake fluid/i);
  }
  const { rendered, calls } = renderCart('guest', true);
  const button = findNodes(
    rendered.tree,
    (node) => textOf(node.children) === 'Sign In' && typeof node.props.onPress === 'function',
  )[0];
  assert.ok(button);
  (button.props.onPress as () => void)();
  assert.deepEqual(calls, [['Auth']]);
});

test('cart suggestions use the active variant price range and platform-inclusive display price', () => {
  const { rendered } = renderCart('ready', false, [
    { status: 'inactive', price: 1, stock: 4 },
    { status: 'active', price: 1400, stock: 2 },
    { status: 'active', price: 1800, stock: 3 },
  ]);
  assert.match(textOf(rendered.tree), /From K1470/);
});

test('cart suggestions never advertise a cheap sold-out active variant as the available minimum', () => {
  const { rendered } = renderCart('ready', false, [
    { status: 'active', price: 100, stock: 0 },
    { status: 'inactive', price: 200, stock: 4 },
    { status: 'out_of_stock', price: 300, stock: 5 },
    { status: 'active', price: 1400, stock: 2 },
  ]);
  const text = textOf(rendered.tree);
  assert.match(text, /DualSense Controller K1470/);
  assert.doesNotMatch(text, /From K105|From K1470|K210|K315/);
});

test('cart suggestion prices ignore invalid fractional and unsafe variant stock', () => {
  const { rendered } = renderCart('ready', false, [
    { status: 'active', price: 100, stock: 0.5 },
    { status: 'active', price: 200, stock: Number.MAX_SAFE_INTEGER + 1 },
    { status: 'active', price: 1400, stock: 2 },
  ]);
  assert.match(textOf(rendered.tree), /DualSense Controller K1470/);
  assert.doesNotMatch(textOf(rendered.tree), /From K105|K210/);
});
