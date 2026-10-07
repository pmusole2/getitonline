import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addVariantAttributeValue,
  createVariantEditorState,
  deriveProductColor,
  deriveVariantMediaState,
  findRemovedStockedCombinations,
  getCombinationKey,
  materializeVariantMedia,
  reconcileVariantCombinations,
  removeVariantAttributeValue,
  resolveExactVariant,
  resolveVariantPreviewImages,
  isVariantValueAvailable,
  validateVariantDraft,
  type VariantCombination,
} from './productVariantDomain';

const existing: VariantCombination = {
  id: 'stored-red-m',
  sku: 'SHIRT-RED-M',
  attributes: [
    { name: 'Color', value: 'Red' },
    { name: 'Size', value: 'M' },
  ],
  price: 180,
  stock: 7,
  status: 'active',
  primaryImage: 'https://img.example/red.jpg',
};

test('combination identity ignores casing, whitespace, and attribute order', () => {
  assert.equal(
    getCombinationKey(existing.attributes),
    getCombinationKey([
      { name: 'size', value: 'M' },
      { name: 'color', value: ' red ' },
    ])
  );
});

test('reconciliation preserves a stored combination and initializes only new identities', () => {
  const combinations = reconcileVariantCombinations({
    attributes: [
      { name: 'Size', values: ['M', 'L'] },
      { name: 'Color', values: ['Red'] },
    ],
    existing: [existing],
    patches: {},
    baseSku: 'SHIRT',
    defaultPrice: 150,
    defaultStock: 2,
  });

  const preserved = combinations.find(
    (item) =>
      getCombinationKey(item.attributes) ===
      getCombinationKey(existing.attributes)
  );
  const created = combinations.find((item) =>
    item.attributes.some(
      (attribute) =>
        attribute.name === 'Size' && attribute.value === 'L'
    )
  );

  assert.deepEqual(preserved, existing);
  assert.equal(created?.sku, 'SHIRT-RED-L');
  assert.equal(created?.price, 150);
  assert.equal(created?.stock, 2);
  assert.equal(created?.status, 'active');
});

test('explicit patches take precedence over preserved stored values', () => {
  const key = getCombinationKey(existing.attributes);
  const [patched] = reconcileVariantCombinations({
    attributes: [
      { name: 'Color', values: ['Red'] },
      { name: 'Size', values: ['M'] },
    ],
    existing: [existing],
    patches: {
      [key]: {
        sku: 'CUSTOM-RED-M',
        price: 220,
        stock: 0,
        status: 'active',
      },
    },
    baseSku: 'SHIRT',
    defaultPrice: 150,
    defaultStock: 2,
  });

  assert.equal(patched.id, existing.id);
  assert.equal(patched.sku, 'CUSTOM-RED-M');
  assert.equal(patched.price, 220);
  assert.equal(patched.stock, 0);
  assert.equal(patched.status, 'out_of_stock');
  assert.equal(patched.primaryImage, existing.primaryImage);
});

test('reports removed combinations that still have stock', () => {
  const removedWithoutStock: VariantCombination = {
    ...existing,
    id: 'stored-black-m',
    sku: 'SHIRT-BLACK-M',
    attributes: [
      { name: 'Color', value: 'Black' },
      { name: 'Size', value: 'M' },
    ],
    stock: 0,
    status: 'out_of_stock',
  };

  assert.deepEqual(
    findRemovedStockedCombinations([existing, removedWithoutStock], []),
    [existing]
  );
});

test('inherits color media across sizes and lets a combination override it', () => {
  const combinations = reconcileVariantCombinations({
    attributes: [
      { name: 'Color', values: ['Red'] },
      { name: 'Size', values: ['S', 'M'] },
    ],
    existing: [],
    patches: {},
    baseSku: 'SHIRT',
    defaultPrice: 150,
    defaultStock: 3,
  });
  const mediumKey = getCombinationKey([
    { name: 'Color', value: 'Red' },
    { name: 'Size', value: 'M' },
  ]);

  const result = materializeVariantMedia({
    combinations,
    colorMedia: { red: ['https://img.example/red-front.jpg'] },
    combinationMedia: {
      [mediumKey]: ['https://img.example/red-m-special.jpg'],
    },
    productImages: [
      'https://img.example/red-front.jpg',
      'https://img.example/red-m-special.jpg',
    ],
  });

  assert.equal(result[0].primaryImage, 'https://img.example/red-front.jpg');
  assert.equal(
    result.find(
      (item) => getCombinationKey(item.attributes) === mediumKey
    )?.primaryImage,
    'https://img.example/red-m-special.jpg'
  );
});

test('derives color-owned media and retains a differing combination override', () => {
  const inheritedImages = [
    'https://img.example/red-front.jpg',
    'https://img.example/red-back.jpg',
  ];
  const overrideImages = ['https://img.example/red-m-special.jpg'];
  const combinations: VariantCombination[] = [
    {
      ...existing,
      primaryImage: inheritedImages[0],
      galleryImages: [inheritedImages[1]],
    },
    {
      ...existing,
      id: 'stored-red-l',
      sku: 'SHIRT-RED-L',
      attributes: [
        { name: 'Color', value: 'Red' },
        { name: 'Size', value: 'L' },
      ],
      primaryImage: overrideImages[0],
    },
  ];

  const media = deriveVariantMediaState({ combinations });

  assert.deepEqual(media.colorMedia.red, inheritedImages);
  assert.deepEqual(
    media.combinationMedia[getCombinationKey(combinations[1].attributes)],
    overrideImages
  );
});

test('materialization rejects media that is not part of the product gallery', () => {
  assert.throws(
    () =>
      materializeVariantMedia({
        combinations: [existing],
        colorMedia: { red: ['https://img.example/not-uploaded.jpg'] },
        combinationMedia: {},
        productImages: ['https://img.example/red.jpg'],
      }),
    /product images/i
  );
});

test('validation rejects normalized duplicates and malformed combination values', () => {
  const malformed: VariantCombination[] = [
    {
      ...existing,
      sku: ' SHIRT ',
      price: 0,
      stock: 1.5,
      primaryImage: 'https://img.example/not-uploaded.jpg',
    },
    {
      ...existing,
      id: 'stored-red-l',
      sku: 'shirt',
      attributes: [{ name: 'Color', value: 'Red' }],
      price: 180,
      stock: -1,
    },
  ];
  const issues = validateVariantDraft({
    attributes: [
      { name: 'Color', values: ['Red', ' red '] },
      { name: ' color ', values: ['Black'] },
      { name: 'Size', values: ['M', 'L'] },
    ],
    combinations: malformed,
    productImages: ['https://img.example/red.jpg'],
    productSku: 'SHIRT',
  });

  for (const field of ['attributes', 'combinations', 'sku', 'price', 'stock', 'media'] as const) {
    assert.ok(
      issues.some((issue) => issue.field === field),
      `expected a ${field} validation issue`
    );
  }
});

test('validation rejects more than 100 generated combinations', () => {
  const combinations = Array.from({ length: 101 }, (_, index) => ({
    ...existing,
    id: `variant-${index}`,
    sku: `SHIRT-${index}`,
    attributes: [{ name: 'Size', value: String(index) }],
  }));

  const issues = validateVariantDraft({
    attributes: [
      {
        name: 'Size',
        values: Array.from({ length: 101 }, (_, index) => String(index)),
      },
    ],
    combinations,
    productImages: ['https://img.example/red.jpg'],
  });

  assert.ok(
    issues.some(
      (issue) =>
        issue.field === 'combinations' && issue.message.includes('100')
    )
  );
});

test('derives canonical product color with a legacy fallback', () => {
  assert.equal(
    deriveProductColor(
      [
        { name: 'Size', values: ['S', 'M'] },
        { name: ' color ', values: [' Red ', 'Black'] },
      ],
      'Legacy blue'
    ),
    'Red, Black'
  );
  assert.equal(deriveProductColor([], ' Legacy blue '), 'Legacy blue');
  assert.equal(deriveProductColor([], '   '), undefined);
});

test('structured attribute editing rejects duplicate normalized values', () => {
  const result = addVariantAttributeValue({
    attributes: [{ name: 'Color', values: ['Red'] }],
    attributeName: ' color ',
    value: ' red ',
  });

  assert.deepEqual(result.attributes, [
    { name: 'Color', values: ['Red'] },
  ]);
  assert.equal(result.issue?.field, 'attributes');
});

test('structured attribute editing rejects empty values', () => {
  const result = addVariantAttributeValue({
    attributes: [{ name: 'Size', values: ['M'] }],
    attributeName: 'Size',
    value: '   ',
  });

  assert.deepEqual(result.attributes, [
    { name: 'Size', values: ['M'] },
  ]);
  assert.equal(result.issue?.field, 'attributes');
});

test('structured attribute editing adds a new named attribute', () => {
  assert.deepEqual(
    addVariantAttributeValue({
      attributes: [{ name: 'Color', values: ['Red'] }],
      attributeName: 'Size',
      value: 'M',
    }),
    {
      attributes: [
        { name: 'Color', values: ['Red'] },
        { name: 'Size', values: ['M'] },
      ],
    }
  );
});

test('structured attribute editing removes only the selected value', () => {
  assert.deepEqual(
    removeVariantAttributeValue({
      attributes: [{ name: 'Size', values: ['S', 'M', 'L'] }],
      attributeName: 'Size',
      value: 'M',
    }),
    [{ name: 'Size', values: ['S', 'L'] }]
  );
});

test('edit state keeps stored combinations and derives inherited media', () => {
  const stored: VariantCombination[] = [
    {
      id: 'red-s',
      sku: 'SHIRT-RED-S-CUSTOM',
      attributes: [
        { name: 'Color', value: 'Red' },
        { name: 'Size', value: 'S' },
      ],
      price: 199,
      stock: 4,
      status: 'inactive',
      primaryImage: 'https://img.example/red.jpg',
      galleryImages: ['https://img.example/red-back.jpg'],
    },
  ];
  const attributes = [
    { name: 'Size', values: ['S'] },
    { name: 'Color', values: ['Red'] },
  ];

  const state = createVariantEditorState({
    attributes,
    combinations: stored,
  });
  const reconciled = reconcileVariantCombinations({
    attributes: state.attributes,
    existing: state.existingCombinations,
    patches: state.combinationPatches,
    baseSku: 'SHIRT',
    defaultPrice: 150,
    defaultStock: 1,
  });

  assert.deepEqual(state.existingCombinations, stored);
  assert.notEqual(state.existingCombinations, stored);
  assert.notEqual(state.existingCombinations[0], stored[0]);
  assert.deepEqual(state.colorMedia.red, [
    'https://img.example/red.jpg',
    'https://img.example/red-back.jpg',
  ]);
  assert.deepEqual(reconciled, stored);
});

test('removing the last stored value reports its stocked combination', () => {
  const stored: VariantCombination = {
    ...existing,
    attributes: [{ name: 'Size', value: 'M' }],
  };
  const state = createVariantEditorState({
    attributes: [{ name: 'Size', values: ['M'] }],
    combinations: [stored],
  });
  const next = reconcileVariantCombinations({
    attributes: removeVariantAttributeValue({
      attributes: state.attributes,
      attributeName: 'Size',
      value: 'M',
    }),
    existing: state.existingCombinations,
    patches: {},
    baseSku: 'SHIRT',
    defaultPrice: 150,
    defaultStock: 1,
  });

  assert.deepEqual(
    findRemovedStockedCombinations(state.existingCombinations, next),
    [stored]
  );
});

test('unavailable values are disabled against the current partial selection', () => {
  const attributes = [
    { name: 'Color', values: ['Red', 'Black'] },
    { name: 'Size', values: ['S', 'M'] },
  ];
  const combinations = reconcileVariantCombinations({
    attributes,
    existing: [],
    patches: {
      [getCombinationKey([
        { name: 'Color', value: 'Red' },
        { name: 'Size', value: 'M' },
      ])]: { stock: 0 },
    },
    baseSku: 'SHIRT',
    defaultPrice: 150,
    defaultStock: 2,
  });

  assert.equal(
    isVariantValueAvailable({
      combinations,
      attributes,
      selection: { Color: 'Red' },
      attributeName: 'Size',
      value: 'M',
    }),
    false
  );
  assert.equal(
    isVariantValueAvailable({
      combinations,
      attributes,
      selection: { Color: 'Red' },
      attributeName: 'Size',
      value: 'S',
    }),
    true
  );
});

test('only a complete selection resolves the exact cart identity', () => {
  const attributes = [
    { name: 'Color', values: ['Red'] },
    { name: 'Size', values: ['M'] },
  ];
  const combinations = reconcileVariantCombinations({
    attributes,
    existing: [],
    patches: {},
    baseSku: 'SHIRT',
    defaultPrice: 150,
    defaultStock: 2,
  });

  assert.equal(
    resolveExactVariant(combinations, attributes, { Color: 'Red' }),
    null
  );
  assert.equal(
    resolveExactVariant(combinations, attributes, {
      Color: ' red ',
      Size: 'm',
    })?.sku,
    'SHIRT-RED-M'
  );
});

test('a partial color selection changes preview without resolving a cart identity', () => {
  const attributes = [
    { name: 'Color', values: ['Red', 'Black'] },
    { name: 'Size', values: ['S', 'M'] },
  ];
  const combinations = materializeVariantMedia({
    combinations: reconcileVariantCombinations({
      attributes,
      existing: [],
      patches: {},
      baseSku: 'SHIRT',
      defaultPrice: 150,
      defaultStock: 3,
    }),
    colorMedia: {
      red: ['https://img.example/red.jpg'],
      black: ['https://img.example/black.jpg'],
    },
    combinationMedia: {},
    productImages: [
      'https://img.example/red.jpg',
      'https://img.example/black.jpg',
    ],
  });

  const selection = { Color: 'Red' };
  assert.equal(
    resolveExactVariant(combinations, attributes, selection),
    null
  );
  assert.deepEqual(
    resolveVariantPreviewImages({
      baseImages: ['https://img.example/base.jpg'],
      combinations,
      attributes,
      selection,
    }),
    ['https://img.example/red.jpg']
  );
});

test('preview falls back to base images when a selected color has no media', () => {
  const attributes = [
    { name: 'Color', values: ['Red'] },
    { name: 'Size', values: ['M'] },
  ];
  const combinations = reconcileVariantCombinations({
    attributes,
    existing: [],
    patches: {},
    baseSku: 'SHIRT',
    defaultPrice: 150,
    defaultStock: 2,
  });

  assert.deepEqual(
    resolveVariantPreviewImages({
      baseImages: [
        'https://img.example/base.jpg',
        'https://img.example/base.jpg',
      ],
      combinations,
      attributes,
      selection: { Color: 'Red' },
    }),
    ['https://img.example/base.jpg']
  );
});
