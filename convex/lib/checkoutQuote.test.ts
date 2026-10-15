import assert from 'node:assert/strict';
import test from 'node:test';

import {
  QuoteError,
  buildInputIdentity,
  buildQuoteKey,
  normalizeStock,
  quotesMatch,
  resolveLinePricing,
  stableStringify,
  sumWeightTerms,
} from './checkoutQuote';
import type { CanonicalLineSelector, CheckoutQuote, QuotedProduct, StoredVariantSelection } from './checkoutQuote';

// Pure resolver, identity, and fingerprint checks. No database is involved:
// every product below is a plain object, and failures surface as QuoteError
// codes rather than thrown Convex errors.

async function captureCode(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof QuoteError) {
      return error.code;
    }
    throw error;
  }
  throw new Error('expected a QuoteError');
}

function simpleProduct(extra: Partial<QuotedProduct> = {}): QuotedProduct {
  return {
    _id: 'products|base',
    sellerId: 'users|seller',
    title: 'Base product',
    price: 100,
    quantity: 10,
    status: 'active',
    images: ['https://images.invalid/base.jpg'],
    categoryId: 'categories|1',
    ...extra,
  };
}

function comboProduct(): QuotedProduct {
  return simpleProduct({
    _id: 'products|combo',
    price: 20,
    variantCombinations: [
      { id: 'cA', sku: 'SA', attributes: [{ name: 'Color', value: 'Red' }], price: 10, stock: 5, status: 'active' },
      { id: 'cB', sku: 'SB', attributes: [{ name: 'Color', value: 'Blue' }], price: 20, stock: 5, status: 'active' },
    ],
  });
}

function optionsProduct(): QuotedProduct {
  return simpleProduct({
    _id: 'products|options',
    price: 50,
    variants: [
      {
        name: 'Size',
        options: [
          { value: 'S', priceDelta: -5 },
          { value: 'L', priceDelta: 10 },
        ],
      },
    ],
    addOns: [
      { name: 'Gift wrap', price: 7, isRequired: false },
      { name: 'Warranty', price: 3, isRequired: true },
    ],
  });
}

function storedVariant(variantId: string, sku: string): StoredVariantSelection {
  return { variantId, sku, attributes: [] };
}

function baseQuote(): CheckoutQuote {
  return {
    currency: 'ZMW',
    source: 'cart',
    lines: [],
    sellers: [],
    subtotalCents: 110,
    promoCents: 0,
    loyaltyCents: 0,
    discountCents: 0,
    discountedSubtotalCents: 110,
    shippingCents: 0,
    platformFeeCents: 6,
    sellerPayoutCents: 110,
    totalAmountCents: 116,
    delivery: { name: 'Standard', code: 'STD', methodType: 'standard' },
    shippingAddress: { street: 's', city: 'c', province: 'p', country: 'z', phone: 't' },
    inputIdentity: 'identity',
    quoteKey: 'key',
  };
}

function baseSelector(line: Partial<CanonicalLineSelector> = {}): CanonicalLineSelector {
  return {
    productId: 'products|base',
    quantity: 1,
    options: [],
    addOns: [],
    ...line,
  };
}

test('stableStringify is stable across key order and skips undefined', () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
  assert.equal(stableStringify([1, 2]), '[1,2]');
  assert.notEqual(stableStringify([1, 2]), stableStringify([2, 1]));
  assert.equal(stableStringify({ a: 1, b: undefined }), '{"a":1}');
});

test('normalizeStock rejects every negative, fractional, or unsafe holding', () => {
  assert.equal(normalizeStock(10), 10);
  assert.equal(normalizeStock(0), 0);
  assert.equal(normalizeStock(-5), null);
  assert.equal(normalizeStock(-1.5), null);
  assert.equal(normalizeStock(2.5), null);
  assert.equal(normalizeStock(Number.NaN), null);
  assert.equal(normalizeStock(Number.POSITIVE_INFINITY), null);
  assert.equal(normalizeStock(Number.MAX_SAFE_INTEGER + 1), null);
});

test('a variant id match wins over a conflicting sku', () => {
  const resolved = resolveLinePricing({
    product: comboProduct(),
    selectedVariant: storedVariant('cA', 'SB'),
    allowReservedStock: false,
  });

  assert.equal(resolved.variant?.variantId, 'cA');
  assert.equal(resolved.unitCents, 1000);
});

test('a unique sku resolves only when no id matches', () => {
  const resolved = resolveLinePricing({
    product: comboProduct(),
    selectedVariant: storedVariant('missing', 'SB'),
    allowReservedStock: false,
  });

  assert.equal(resolved.variant?.variantId, 'cB');
  assert.equal(resolved.unitCents, 2000);
});

test('an unknown variant and an empty variant id are invalid', async () => {
  assert.equal(
    await captureCode(() =>
      resolveLinePricing({
        product: comboProduct(),
        selectedVariant: storedVariant('missing', 'missing'),
        allowReservedStock: false,
      }),
    ),
    'invalid_variant',
  );
  assert.equal(
    await captureCode(() => resolveLinePricing({ product: comboProduct(), allowReservedStock: false })),
    'invalid_variant',
  );
});

test('an ambiguous sku fallback is rejected instead of guessed', async () => {
  const product = simpleProduct({
    variantCombinations: [
      { id: 'a1', sku: 'DUP', attributes: [], price: 10, stock: 5, status: 'active' },
      { id: 'a2', sku: 'DUP', attributes: [], price: 12, stock: 5, status: 'active' },
    ],
  });

  assert.equal(
    await captureCode(() =>
      resolveLinePricing({
        product,
        selectedVariant: storedVariant('missing', 'DUP'),
        allowReservedStock: false,
      }),
    ),
    'invalid_variant',
  );
});

test('inactive and intentionally out-of-stock variants are denied', async () => {
  const inactive = simpleProduct({
    variantCombinations: [{ id: 'v', sku: 'S', attributes: [], price: 10, stock: 5, status: 'inactive' }],
  });
  const stuck = simpleProduct({
    variantCombinations: [{ id: 'v', sku: 'S', attributes: [], price: 10, stock: 3, status: 'out_of_stock' }],
  });

  assert.equal(
    await captureCode(() =>
      resolveLinePricing({ product: inactive, selectedVariant: storedVariant('v', 'S'), allowReservedStock: true }),
    ),
    'invalid_variant',
  );
  assert.equal(
    await captureCode(() =>
      resolveLinePricing({ product: stuck, selectedVariant: storedVariant('v', 'S'), allowReservedStock: true }),
    ),
    'invalid_variant',
  );
});

test('a zeroed variant is denied for carts but priced for owned reservations', async () => {
  const product = simpleProduct({
    variantCombinations: [{ id: 'v', sku: 'S', attributes: [], price: 10, stock: 0, status: 'out_of_stock' }],
  });

  assert.equal(
    await captureCode(() =>
      resolveLinePricing({ product, selectedVariant: storedVariant('v', 'S'), allowReservedStock: false }),
    ),
    'insufficient_stock',
  );
  const reserved = resolveLinePricing({
    product,
    selectedVariant: storedVariant('v', 'S'),
    allowReservedStock: true,
  });
  assert.equal(reserved.unitCents, 1000);
});

test('stored options never move a combination price', () => {
  const resolved = resolveLinePricing({
    product: comboProduct(),
    selectedVariant: storedVariant('cA', 'SA'),
    selectedVariantOptions: [{ name: 'Size', value: 'L', priceDelta: 9999 }],
    allowReservedStock: false,
  });

  assert.equal(resolved.unitCents, 1000);
  assert.deepEqual(resolved.optionPairs, []);
});

test('option choices resolve canonically with signed deltas and required add-ons', () => {
  const large = resolveLinePricing({
    product: optionsProduct(),
    selectedVariantOptions: [{ name: 'Size', value: 'L' }],
    allowReservedStock: false,
  });
  assert.equal(large.unitCents, 6300);
  assert.deepEqual(large.optionPairs, [{ name: 'Size', value: 'L', deltaCents: 1000 }]);
  assert.deepEqual(large.addOns, [{ name: 'Warranty', priceCents: 300 }]);

  const small = resolveLinePricing({
    product: optionsProduct(),
    selectedVariantOptions: [{ name: 'Size', value: 'S' }],
    selectedAddOns: [{ name: 'Gift wrap', price: 9999 }],
    allowReservedStock: false,
  });
  assert.equal(small.unitCents, 5500);
  assert.deepEqual(small.optionPairs, [{ name: 'Size', value: 'S', deltaCents: -500 }]);
  assert.deepEqual(small.addOns, [
    { name: 'Gift wrap', priceCents: 700 },
    { name: 'Warranty', priceCents: 300 },
  ]);
});

test('a negative delta that passes zero clamps the unit at zero', () => {
  const product = simpleProduct({
    price: 5,
    variants: [{ name: 'Size', options: [{ value: 'S', priceDelta: -10 }] }],
  });
  const resolved = resolveLinePricing({
    product,
    selectedVariantOptions: [{ name: 'Size', value: 'S' }],
    allowReservedStock: false,
  });

  assert.equal(resolved.unitCents, 0);
});

test('missing or unknown option choices are invalid, extras are ignored', async () => {
  assert.equal(
    await captureCode(() => resolveLinePricing({ product: optionsProduct(), allowReservedStock: false })),
    'invalid_variant',
  );
  assert.equal(
    await captureCode(() =>
      resolveLinePricing({
        product: optionsProduct(),
        selectedVariantOptions: [{ name: 'Size', value: 'XL' }],
        allowReservedStock: false,
      }),
    ),
    'invalid_variant',
  );
  const withExtra = resolveLinePricing({
    product: optionsProduct(),
    selectedVariantOptions: [
      { name: 'Size', value: 'L' },
      { name: 'Unknown', value: 'X' },
    ],
    allowReservedStock: false,
  });
  assert.equal(withExtra.unitCents, 6300);
});

test('ambiguous option and add-on definitions fail safe', async () => {
  const duplicateNames = simpleProduct({
    variants: [
      { name: 'Size', options: [{ value: 'S' }] },
      { name: 'Size', options: [{ value: 'M' }] },
    ],
  });
  const duplicateValues = simpleProduct({
    variants: [{ name: 'Size', options: [{ value: 'S' }, { value: 'S' }] }],
  });
  const duplicateAddOns = simpleProduct({
    addOns: [
      { name: 'Wrap', price: 1, isRequired: false },
      { name: 'Wrap', price: 2, isRequired: false },
    ],
  });

  assert.equal(
    await captureCode(() =>
      resolveLinePricing({
        product: duplicateNames,
        selectedVariantOptions: [{ name: 'Size', value: 'S' }],
        allowReservedStock: false,
      }),
    ),
    'malformed_catalog',
  );
  assert.equal(
    await captureCode(() =>
      resolveLinePricing({
        product: duplicateValues,
        selectedVariantOptions: [{ name: 'Size', value: 'S' }],
        allowReservedStock: false,
      }),
    ),
    'malformed_catalog',
  );
  assert.equal(
    await captureCode(() =>
      resolveLinePricing({
        product: duplicateAddOns,
        selectedAddOns: [{ name: 'Wrap', price: 1 }],
        allowReservedStock: false,
      }),
    ),
    'malformed_catalog',
  );
});

test('an unknown requested add-on is rejected', async () => {
  assert.equal(
    await captureCode(() =>
      resolveLinePricing({
        product: optionsProduct(),
        selectedVariantOptions: [{ name: 'Size', value: 'L' }],
        selectedAddOns: [{ name: 'Nope', price: 1 }],
        allowReservedStock: false,
      }),
    ),
    'invalid_addon',
  );
});

test('malformed stored money is denied, never rounded', async () => {
  assert.equal(
    await captureCode(() =>
      resolveLinePricing({ product: simpleProduct({ price: 10.001 }), allowReservedStock: false }),
    ),
    'malformed_money',
  );
  assert.equal(
    await captureCode(() =>
      resolveLinePricing({
        product: simpleProduct({
          variants: [{ name: 'Size', options: [{ value: 'S', priceDelta: 1.005 }] }],
        }),
        selectedVariantOptions: [{ name: 'Size', value: 'S' }],
        allowReservedStock: false,
      }),
    ),
    'malformed_money',
  );
  assert.equal(
    await captureCode(() =>
      resolveLinePricing({
        product: simpleProduct({ addOns: [{ name: 'Wrap', price: Number.NaN, isRequired: true }] }),
        allowReservedStock: false,
      }),
    ),
    'malformed_money',
  );
});

test('the customization key is canonical across option and add-on order', () => {
  const first = resolveLinePricing({
    product: optionsProduct(),
    selectedVariantOptions: [{ name: 'Size', value: 'L' }],
    selectedAddOns: [
      { name: 'Gift wrap', price: 1 },
      { name: 'Warranty', price: 1 },
    ],
    allowReservedStock: false,
  });
  const second = resolveLinePricing({
    product: optionsProduct(),
    selectedVariantOptions: [{ name: 'Size', value: 'L' }],
    selectedAddOns: [
      { name: 'Warranty', price: 1 },
      { name: 'Gift wrap', price: 1 },
    ],
    allowReservedStock: false,
  });

  assert.equal(first.customizationKey, second.customizationKey);
  assert.match(first.customizationKey, /products\|options/);
  const combo = resolveLinePricing({
    product: comboProduct(),
    selectedVariant: storedVariant('cB', 'SB'),
    allowReservedStock: false,
  });
  assert.notEqual(combo.customizationKey, first.customizationKey);
});

test('sumWeightTerms keeps the exact rational across mixed decimals', () => {
  assert.deepEqual(
    sumWeightTerms([
      { kilos: 1.5, quantity: 2 },
      { kilos: 0.25, quantity: 1 },
    ]),
    {
      numerator: BigInt(325),
      denominator: BigInt(100),
    },
  );
  assert.deepEqual(sumWeightTerms([]), { numerator: BigInt(0), denominator: BigInt(1) });
  assert.equal(sumWeightTerms([{ kilos: -1, quantity: 1 }]), null);
  assert.equal(sumWeightTerms([{ kilos: 1, quantity: 0 }]), null);
  assert.equal(sumWeightTerms([{ kilos: Number.NaN, quantity: 1 }]), null);
});

test('the selector identity is stable, actor-bound, and price-free', async () => {
  const address = { street: 's', city: 'c', province: 'p', country: 'z', phone: 't' };
  const lines = [baseSelector({ productId: 'products|b' }), baseSelector({ productId: 'products|a' })];
  const first = await buildInputIdentity({
    actorId: 'users|buyer',
    source: 'cart',
    lines,
    address,
    loyaltyPoints: 0,
  });
  const reordered = await buildInputIdentity({
    actorId: 'users|buyer',
    source: 'cart',
    lines: [...lines].reverse(),
    address,
    loyaltyPoints: 0,
  });
  const otherActor = await buildInputIdentity({
    actorId: 'users|other',
    source: 'cart',
    lines,
    address,
    loyaltyPoints: 0,
  });

  assert.equal(first, reordered);
  assert.notEqual(first, otherActor);
  assert.match(first, /^[0-9a-f]{64}$/);
});

test('the priced key moves on allocation-only changes with equal aggregates', async () => {
  const snapshot = {
    totals: { subtotalCents: 20, shippingCents: 1, platformFeeCents: 1, totalAmountCents: 22 },
    sellers: [
      { sellerId: 's1', shippingCents: 1, platformFeeCents: 1 },
      { sellerId: 's2', shippingCents: 0, platformFeeCents: 0 },
    ],
  };
  const moved = {
    totals: { subtotalCents: 20, shippingCents: 1, platformFeeCents: 1, totalAmountCents: 22 },
    sellers: [
      { sellerId: 's1', shippingCents: 0, platformFeeCents: 1 },
      { sellerId: 's2', shippingCents: 1, platformFeeCents: 0 },
    ],
  };

  assert.equal(await buildQuoteKey(snapshot), await buildQuoteKey(structuredClone(snapshot)));
  assert.notEqual(await buildQuoteKey(snapshot), await buildQuoteKey(moved));
});

test('quotesMatch needs both the selectors and the priced cents', () => {
  const first = baseQuote();
  assert.equal(quotesMatch(first, { ...first }), true);
  assert.equal(quotesMatch(first, { ...first, quoteKey: 'other' }), false);
  assert.equal(quotesMatch(first, { ...first, inputIdentity: 'other' }), false);
});

test('resolved lines carry canonical price facts, never cached display data', () => {
  const combo = resolveLinePricing({
    product: comboProduct(),
    selectedVariant: storedVariant('cA', 'SA'),
    allowReservedStock: false,
  });
  assert.equal(combo.baseCents, 2000);
  assert.equal(combo.variant?.priceCents, 1000);
  assert.equal(combo.variant?.sku, 'SA');
  assert.equal(combo.variant?.image, undefined);

  const imaged = resolveLinePricing({
    product: simpleProduct({
      _id: 'products|imaged',
      price: 20,
      variantCombinations: [
        {
          id: 'cA',
          sku: 'SA',
          attributes: [{ name: 'Color', value: 'Red' }],
          price: 10,
          stock: 5,
          status: 'active',
          primaryImage: 'https://images.invalid/canonical.jpg',
        },
      ],
    }),
    selectedVariant: storedVariant('cA', 'SA'),
    allowReservedStock: false,
  });
  assert.equal(imaged.variant?.image, 'https://images.invalid/canonical.jpg');

  const skuDelta = resolveLinePricing({
    product: simpleProduct({
      _id: 'products|sku',
      price: 50,
      variants: [{ name: 'Size', options: [{ value: 'S', priceDelta: -5, sku: 'SKU-S', quantity: 4 }] }],
      addOns: [{ name: 'Card', price: 2, description: 'A gift card', isRequired: false }],
    }),
    selectedVariantOptions: [{ name: 'Size', value: 'S' }],
    selectedAddOns: [{ name: 'Card', price: 9999, description: 'stale' }],
    allowReservedStock: false,
  });
  assert.deepEqual(skuDelta.optionPairs, [
    { name: 'Size', value: 'S', deltaCents: -500, sku: 'SKU-S', capQuantity: 4 },
  ]);
  assert.deepEqual(skuDelta.addOns, [{ name: 'Card', priceCents: 200, description: 'A gift card' }]);
  assert.equal(skuDelta.baseCents, 5000);
  assert.equal(skuDelta.unitCents, 4700);
});

test('the selector identity binds the address and the fallback shipping choice', async () => {
  const address = { street: 's', city: 'c', province: 'p', country: 'z', phone: 't' };
  const identityArgs = {
    actorId: 'users|buyer',
    source: 'cart' as const,
    lines: [baseSelector()],
    address,
    loyaltyPoints: 0,
  };
  const first = await buildInputIdentity(identityArgs);
  const moved = await buildInputIdentity({
    ...identityArgs,
    address: { ...address, street: 'elsewhere' },
  });
  assert.notEqual(first, moved);

  const shipA = await buildInputIdentity({ ...identityArgs, lines: [baseSelector({ shippingName: 'A' })] });
  const shipB = await buildInputIdentity({ ...identityArgs, lines: [baseSelector({ shippingName: 'B' })] });
  assert.notEqual(shipA, shipB);
});
