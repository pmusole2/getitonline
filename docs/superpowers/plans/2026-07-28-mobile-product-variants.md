# Mobile Product Variants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not use subagents unless the user explicitly requests them.

**Goal:** Tighten mobile product variants so vendors can safely create and edit Color/Size combinations with color-owned media, while buyers receive immediate color previews and can purchase only an exact active, in-stock combination.

**Architecture:** Put all variant identity, reconciliation, validation, media inheritance, availability, and selection behavior in a React-free TypeScript domain module. A reusable React Native editor renders that state for both creation and editing, while product detail consumes the same domain functions for preview and exact selection. Existing Convex `variantAttributes` and `variantCombinations` remain the persistence contract.

**Tech Stack:** TypeScript 5.9, React Native 0.81, Expo 54, React Native Paper 5, Convex, Node test runner through `tsx`.

## Global Constraints

- Mobile only: do not alter web creation, web detail, or browse-level filtering.
- Preserve the current uncommitted worktree and make focused edits only.
- Do not stage or commit implementation files that already contain pre-existing user changes; use scoped diffs as task checkpoints.
- Do not deploy Convex, mutate production data, or rewrite existing product records.
- Keep `variantCombinations` as the exact cart and inventory identity.
- Assign media once per Color, inherit it across sizes, and permit an explicit combination override.
- A partial Color selection may control preview media but must never become a cart selection.
- Reject more than 100 generated combinations.
- Keep compatibility with legacy `product.variants`.
- Use TDD for each domain behavior: run the new test and observe the expected failure before implementing it.

---

## File Structure

- Create `apps/mobile/src/screens/product/productVariantDomain.ts`
  - Pure types and functions for identity, generation, reconciliation, validation, media, availability, preview, and exact selection.
- Create `apps/mobile/src/screens/product/productVariantDomain.test.ts`
  - Node tests for every domain rule and regression.
- Create `apps/mobile/src/screens/product/ProductVariantEditor.tsx`
  - Shared structured React Native editor for attributes, color media, and combinations.
- Modify `apps/mobile/src/screens/product/CreateProductScreen.tsx`
  - Replace `variantsText` parsing and generated base clones with structured editor state and materialized combinations.
- Modify `apps/mobile/src/screens/product/EditProductScreen.tsx`
  - Load stored combinations into the structured editor, preserve overrides, and warn when stocked combinations are removed.
- Modify `apps/mobile/src/screens/product/ProductDetailScreen.tsx`
  - Use domain selection functions and switch preview media on partial Color selection.
- Modify `package.json`
  - Add the domain test to the existing `test:app-review` verification script.

---

### Task 1: Stable variant identity and combination reconciliation

**Files:**

- Create: `apps/mobile/src/screens/product/productVariantDomain.test.ts`
- Create: `apps/mobile/src/screens/product/productVariantDomain.ts`

**Interfaces:**

- Produces:

```ts
export type VariantStatus = 'active' | 'inactive' | 'out_of_stock';

export interface VariantAttribute {
  name: string;
  values: string[];
}

export interface VariantAttributeValue {
  name: string;
  value: string;
}

export interface VariantCombination {
  id: string;
  sku: string;
  attributes: VariantAttributeValue[];
  price: number;
  stock: number;
  status: VariantStatus;
  primaryImage?: string;
  galleryImages?: string[];
}

export interface VariantCombinationPatch {
  id?: string;
  sku?: string;
  price?: number;
  stock?: number;
  status?: VariantStatus;
}

export function getCombinationKey(
  attributes: readonly VariantAttributeValue[]
): string;

export function reconcileVariantCombinations(input: {
  attributes: readonly VariantAttribute[];
  existing: readonly VariantCombination[];
  patches: Readonly<Record<string, VariantCombinationPatch>>;
  baseSku: string;
  defaultPrice: number;
  defaultStock: number;
}): VariantCombination[];

export function findRemovedStockedCombinations(
  previous: readonly VariantCombination[],
  next: readonly VariantCombination[]
): VariantCombination[];
```

- Consumed later by create/edit state, the shared editor, and product detail.

- [ ] **Step 1: Write failing identity and reconciliation tests**

Add tests that describe the desired API before creating the production module:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findRemovedStockedCombinations,
  getCombinationKey,
  reconcileVariantCombinations,
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

test('combination identity ignores casing and attribute order', () => {
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
    (item) => getCombinationKey(item.attributes) === getCombinationKey(existing.attributes)
  );
  const created = combinations.find((item) =>
    item.attributes.some((attribute) => attribute.name === 'Size' && attribute.value === 'L')
  );

  assert.deepEqual(preserved, existing);
  assert.equal(created?.price, 150);
  assert.equal(created?.stock, 2);
  assert.equal(created?.status, 'active');
});

test('reports removed combinations that still have stock', () => {
  assert.deepEqual(findRemovedStockedCombinations([existing], []), [existing]);
});
```

- [ ] **Step 2: Run the test and verify the expected RED failure**

Run:

```bash
npx tsx --test apps/mobile/src/screens/product/productVariantDomain.test.ts
```

Expected: FAIL because `./productVariantDomain` does not exist.

- [ ] **Step 3: Implement normalization, stable keys, Cartesian generation, and reconciliation**

Implement the exact public interfaces above. Use these rules:

```ts
const normalizeToken = (value: string) => value.trim().toLocaleLowerCase();

export function getCombinationKey(
  attributes: readonly VariantAttributeValue[]
): string {
  return [...attributes]
    .map(({ name, value }) => `${normalizeToken(name)}=${normalizeToken(value)}`)
    .sort()
    .join('|');
}
```

`reconcileVariantCombinations` must:

1. Trim display names and values while preserving capitalization.
2. Deduplicate values case-insensitively.
3. Generate the full Cartesian product.
4. Look up `existing` and `patches` by `getCombinationKey`.
5. Preserve every stored field for surviving identities.
6. Apply an explicit patch after the stored value.
7. Initialize only new identities from `baseSku`, `defaultPrice`, and `defaultStock`.
8. Force status to `out_of_stock` when stock is zero.
9. Generate deterministic IDs and SKUs from normalized values.

- [ ] **Step 4: Run the targeted test and verify GREEN**

Run:

```bash
npx tsx --test apps/mobile/src/screens/product/productVariantDomain.test.ts
```

Expected: all Task 1 tests pass.

- [ ] **Step 5: Record a scoped checkpoint without staging dirty files**

Run:

```bash
git diff --check -- \
  apps/mobile/src/screens/product/productVariantDomain.ts \
  apps/mobile/src/screens/product/productVariantDomain.test.ts
git status --short -- \
  apps/mobile/src/screens/product/productVariantDomain.ts \
  apps/mobile/src/screens/product/productVariantDomain.test.ts
```

Expected: no whitespace errors; only the two new files appear.

---

### Task 2: Media inheritance and validation

**Files:**

- Modify: `apps/mobile/src/screens/product/productVariantDomain.test.ts`
- Modify: `apps/mobile/src/screens/product/productVariantDomain.ts`

**Interfaces:**

- Produces:

```ts
export type VariantMediaMap = Readonly<Record<string, readonly string[]>>;

export interface VariantValidationIssue {
  field:
    | 'attributes'
    | 'combinations'
    | 'sku'
    | 'price'
    | 'stock'
    | 'media';
  combinationKey?: string;
  message: string;
}

export function deriveVariantMediaState(input: {
  combinations: readonly VariantCombination[];
}): {
  colorMedia: Record<string, string[]>;
  combinationMedia: Record<string, string[]>;
};

export function materializeVariantMedia(input: {
  combinations: readonly VariantCombination[];
  colorMedia: VariantMediaMap;
  combinationMedia: VariantMediaMap;
  productImages: readonly string[];
}): VariantCombination[];

export function validateVariantDraft(input: {
  attributes: readonly VariantAttribute[];
  combinations: readonly VariantCombination[];
  productImages: readonly string[];
  productSku?: string;
}): VariantValidationIssue[];

export function deriveProductColor(
  attributes: readonly VariantAttribute[],
  legacyColor: string
): string | undefined;
```

- [ ] **Step 1: Add failing media and validation tests**

Add explicit cases:

```ts
import {
  deriveProductColor,
  deriveVariantMediaState,
  materializeVariantMedia,
  validateVariantDraft,
} from './productVariantDomain';

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
    result.find((item) => getCombinationKey(item.attributes) === mediumKey)?.primaryImage,
    'https://img.example/red-m-special.jpg'
  );
});

test('validation rejects duplicate normalized attributes', () => {
  const issues = validateVariantDraft({
    attributes: [
      { name: 'Color', values: ['Red'] },
      { name: ' color ', values: ['Black'] },
    ],
    combinations: [],
    productImages: [],
    productSku: 'SHIRT',
  });

  assert.ok(issues.some((issue) => issue.field === 'attributes'));
});
```

Also cover `deriveVariantMediaState`, more than 100 combinations, duplicate SKU, non-positive price, fractional or negative stock, unknown media URLs, and `deriveProductColor`.

- [ ] **Step 2: Run the test and verify the expected RED failures**

Run:

```bash
npx tsx --test apps/mobile/src/screens/product/productVariantDomain.test.ts
```

Expected: FAIL because the new exported functions do not exist.

- [ ] **Step 3: Implement media and validation behavior**

Implementation rules:

```ts
const COLOR_ATTRIBUTE = 'color';

function combinationImages(combination: VariantCombination): string[] {
  return [combination.primaryImage, ...(combination.galleryImages ?? [])].filter(
    (image): image is string => Boolean(image)
  );
}
```

- `deriveVariantMediaState` groups by normalized Color.
- The first non-empty gallery for a color becomes inherited `colorMedia`.
- A different non-empty gallery on another combination becomes a `combinationMedia` override.
- `materializeVariantMedia` rejects references outside `productImages`, applies combination override before color media, and clears inherited media fields when neither exists.
- `deriveProductColor` returns the comma-separated Color values for canonical color variants, otherwise the trimmed legacy value.

- [ ] **Step 4: Run the targeted test and verify GREEN**

Run:

```bash
npx tsx --test apps/mobile/src/screens/product/productVariantDomain.test.ts
```

Expected: all Task 1 and Task 2 tests pass.

- [ ] **Step 5: Record the domain checkpoint**

Run:

```bash
git diff --check -- \
  apps/mobile/src/screens/product/productVariantDomain.ts \
  apps/mobile/src/screens/product/productVariantDomain.test.ts
npm run typecheck --workspace=apps/mobile
```

Expected: zero whitespace errors and mobile TypeScript exit code 0.

---

### Task 3: Shared structured editor and mobile creation flow

**Files:**

- Create: `apps/mobile/src/screens/product/ProductVariantEditor.tsx`
- Modify: `apps/mobile/src/screens/product/CreateProductScreen.tsx`
- Modify: `package.json`
- Test: `apps/mobile/src/screens/product/productVariantDomain.test.ts`

**Interfaces:**

- Consumes all Task 1 and Task 2 domain types and functions.
- Extends the domain module with:

```ts
export function addVariantAttributeValue(input: {
  attributes: readonly VariantAttribute[];
  attributeName: string;
  value: string;
}): {
  attributes: VariantAttribute[];
  issue?: VariantValidationIssue;
};

export function removeVariantAttributeValue(input: {
  attributes: readonly VariantAttribute[];
  attributeName: string;
  value: string;
}): VariantAttribute[];
```

- Produces:

```ts
export interface ProductVariantEditorProps {
  attributes: VariantAttribute[];
  combinations: VariantCombination[];
  combinationPatches: Record<string, VariantCombinationPatch>;
  colorMedia: Record<string, string[]>;
  combinationMedia: Record<string, string[]>;
  productImages: string[];
  validationIssues: VariantValidationIssue[];
  onAttributesChange: (attributes: VariantAttribute[]) => void;
  onCombinationPatchChange: (
    combinationKey: string,
    patch: VariantCombinationPatch
  ) => void;
  onColorMediaChange: (colorKey: string, images: string[]) => void;
  onCombinationMediaChange: (
    combinationKey: string,
    images: string[]
  ) => void;
}
```

- [ ] **Step 1: Add failing structured-attribute editing tests**

Add domain tests proving that the editor rejects normalized duplicates and removes only the targeted value:

```ts
import {
  addVariantAttributeValue,
  removeVariantAttributeValue,
} from './productVariantDomain';

test('structured attribute editing rejects duplicate normalized values', () => {
  const result = addVariantAttributeValue({
    attributes: [{ name: 'Color', values: ['Red'] }],
    attributeName: ' color ',
    value: ' red ',
  });

  assert.deepEqual(result.attributes, [{ name: 'Color', values: ['Red'] }]);
  assert.equal(result.issue?.field, 'attributes');
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
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npx tsx --test apps/mobile/src/screens/product/productVariantDomain.test.ts
```

Expected: FAIL because `addVariantAttributeValue` and `removeVariantAttributeValue` do not exist.

- [ ] **Step 3: Implement the structured attribute helpers**

Implement both pure functions in `productVariantDomain.ts`. Attribute and value matching must use the same normalization as `getCombinationKey`. Empty values return an `attributes` validation issue instead of modifying state.

- [ ] **Step 4: Implement `ProductVariantEditor`**

Build a focused React Native Paper component:

- Attribute cards for Color, Size, and retained custom attributes.
- Add/remove value inputs rendered as chips.
- Prevent duplicate normalized attribute names and values in the UI.
- Color media rows that select one primary and zero or more gallery URLs from `productImages`.
- Scrollable combination cards with SKU, seller price, stock, status, inherited-media label, and override controls.
- Display `validationIssues` next to the relevant section or combination.
- Use `getCombinationKey` for React keys and callback identity.

Do not call Convex or own base product fields in this component.

- [ ] **Step 5: Integrate structured state into `CreateProductScreen`**

Remove:

```ts
const [variantsText, setVariantsText] = useState('');
parseVariantAttributes(...)
buildVariantCombinations(...)
```

Add state:

```ts
const [variantAttributes, setVariantAttributes] = useState<VariantAttribute[]>([]);
const [variantPatches, setVariantPatches] = useState<
  Record<string, VariantCombinationPatch>
>({});
const [colorMedia, setColorMedia] = useState<Record<string, string[]>>({});
const [combinationMedia, setCombinationMedia] = useState<
  Record<string, string[]>
>({});
```

Derive combinations with `reconcileVariantCombinations`, validate them with `validateVariantDraft`, and materialize media immediately before `createProduct`.

Set the mutation payload:

```ts
variantAttributes: variantAttributes.length ? variantAttributes : undefined,
variantCombinations: persistedCombinations.length
  ? persistedCombinations
  : undefined,
color: deriveProductColor(variantAttributes, color),
```

The general price and stock inputs become defaults for new combinations. The review step must show generated combination count and total stock.

- [ ] **Step 6: Register the new test in `test:app-review`**

Append:

```text
apps/mobile/src/screens/product/productVariantDomain.test.ts
```

to the existing `tsx --test` path list in the root `package.json`.

- [ ] **Step 7: Run focused tests and mobile typechecking**

Run:

```bash
npx tsx --test apps/mobile/src/screens/product/productVariantDomain.test.ts
npm run typecheck --workspace=apps/mobile
```

Expected: all variant tests pass and mobile TypeScript exits 0.

- [ ] **Step 8: Record the create-flow checkpoint**

Run:

```bash
git diff --check -- \
  apps/mobile/src/screens/product/ProductVariantEditor.tsx \
  apps/mobile/src/screens/product/CreateProductScreen.tsx \
  apps/mobile/src/screens/product/productVariantDomain.ts \
  apps/mobile/src/screens/product/productVariantDomain.test.ts \
  package.json
git diff -- \
  apps/mobile/src/screens/product/CreateProductScreen.tsx \
  apps/mobile/src/screens/product/ProductVariantEditor.tsx
```

Review only the mobile variant additions; do not stage the pre-existing screen diff.

---

### Task 4: Safe mobile editing with preserved overrides

**Files:**

- Modify: `apps/mobile/src/screens/product/EditProductScreen.tsx`
- Modify: `apps/mobile/src/screens/product/productVariantDomain.test.ts`
- Consume: `apps/mobile/src/screens/product/ProductVariantEditor.tsx`
- Consume: `apps/mobile/src/screens/product/productVariantDomain.ts`

**Interfaces:**

- Uses `deriveVariantMediaState`, `reconcileVariantCombinations`, `findRemovedStockedCombinations`, `materializeVariantMedia`, and `deriveProductColor`.
- Extends the domain module with:

```ts
export interface VariantEditorState {
  attributes: VariantAttribute[];
  existingCombinations: VariantCombination[];
  combinationPatches: Record<string, VariantCombinationPatch>;
  colorMedia: Record<string, string[]>;
  combinationMedia: Record<string, string[]>;
}

export function createVariantEditorState(input: {
  attributes?: readonly VariantAttribute[];
  combinations?: readonly VariantCombination[];
}): VariantEditorState;
```

- [ ] **Step 1: Add a failing stored-product initialization test**

```ts
import { createVariantEditorState } from './productVariantDomain';

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

  const state = createVariantEditorState({
    attributes: [
      { name: 'Size', values: ['S'] },
      { name: 'Color', values: ['Red'] },
    ],
    combinations: stored,
  });

  assert.deepEqual(state.existingCombinations, stored);
  assert.deepEqual(state.colorMedia.red, [
    'https://img.example/red.jpg',
    'https://img.example/red-back.jpg',
  ]);
});
```

Add a second test that reconciling this state without attribute changes preserves the full stored combination, plus a third test that removing `Size=S` reports it through `findRemovedStockedCombinations`.

- [ ] **Step 2: Run the test and verify the expected RED regression**

Run:

```bash
npx tsx --test apps/mobile/src/screens/product/productVariantDomain.test.ts
```

Expected: FAIL because `createVariantEditorState` does not exist.

- [ ] **Step 3: Implement stored-product editor initialization**

Implement `createVariantEditorState` by cloning stored arrays, calling `deriveVariantMediaState`, and starting with an empty patch map. Never retain mutable references to Convex query results.

- [ ] **Step 4: Replace edit-screen free-form rebuilding with preserved editor state**

When the product loads:

```ts
const initialVariantEditorState = createVariantEditorState({
  attributes: product.variantAttributes ?? [],
  combinations: product.variantCombinations ?? [],
});
```

Initialize the editor once per product ID. Keep `initialVariantEditorState.existingCombinations` as the reconciliation baseline and never rebuild it from only base price, stock, and the first image.

Render `ProductVariantEditor` with the same callbacks as creation.

- [ ] **Step 5: Add destructive-removal confirmation before update**

Before calling `updateProduct`:

1. Reconcile and materialize the current draft.
2. Call `findRemovedStockedCombinations(storedCombinations, persistedCombinations)`.
3. If any are returned, show an `Alert.alert` containing their SKUs and total remaining stock.
4. Continue only from the destructive confirmation callback.
5. Call the mutation with preserved/materialized combinations and `deriveProductColor`.

The save path must still support products without canonical combinations.

- [ ] **Step 6: Run targeted tests and mobile typechecking**

Run:

```bash
npx tsx --test apps/mobile/src/screens/product/productVariantDomain.test.ts
npm run typecheck --workspace=apps/mobile
```

Expected: all variant tests pass and mobile TypeScript exits 0.

- [ ] **Step 7: Record the edit-flow checkpoint**

Run:

```bash
git diff --check -- \
  apps/mobile/src/screens/product/EditProductScreen.tsx \
  apps/mobile/src/screens/product/ProductVariantEditor.tsx \
  apps/mobile/src/screens/product/productVariantDomain.ts \
  apps/mobile/src/screens/product/productVariantDomain.test.ts
git diff -- apps/mobile/src/screens/product/EditProductScreen.tsx
```

Confirm the old `buildVariantCombinations` path is absent and existing combination data is the reconciliation baseline.

---

### Task 5: Immediate buyer color preview with exact cart selection

**Files:**

- Modify: `apps/mobile/src/screens/product/ProductDetailScreen.tsx`
- Modify: `apps/mobile/src/screens/product/productVariantDomain.test.ts`
- Consume: `apps/mobile/src/screens/product/productVariantDomain.ts`

**Interfaces:**

- Extends the domain module with:

```ts
export function resolveExactVariant(
  combinations: readonly VariantCombination[],
  attributes: readonly VariantAttribute[],
  selection: Readonly<Record<string, string>>
): VariantCombination | null;

export function isVariantValueAvailable(input: {
  combinations: readonly VariantCombination[];
  attributes: readonly VariantAttribute[];
  selection: Readonly<Record<string, string>>;
  attributeName: string;
  value: string;
}): boolean;

export function resolveVariantPreviewImages(input: {
  baseImages: readonly string[];
  combinations: readonly VariantCombination[];
  attributes: readonly VariantAttribute[];
  selection: Readonly<Record<string, string>>;
}): string[];
```

- Continues to emit the existing `selectedVariant` snapshot:

```ts
{
  variantId: selectedVariant.id,
  sku: selectedVariant.sku,
  attributes: selectedVariant.attributes,
  price: selectedVariant.price,
  image: selectedVariant.primaryImage,
}
```

- [ ] **Step 1: Add failing buyer-flow tests**

```ts
import {
  isVariantValueAvailable,
  resolveExactVariant,
  resolveVariantPreviewImages,
} from './productVariantDomain';

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

  assert.equal(resolveExactVariant(combinations, attributes, { Color: 'Red' }), null);
  assert.equal(
    resolveExactVariant(combinations, attributes, {
      Color: 'Red',
      Size: 'M',
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
  assert.equal(resolveExactVariant(combinations, attributes, selection), null);
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
```

- [ ] **Step 2: Run the test and verify RED for any incomplete selection behavior**

Run:

```bash
npx tsx --test apps/mobile/src/screens/product/productVariantDomain.test.ts
```

Expected: FAIL until the domain functions enforce partial-preview versus exact-selection separation.

- [ ] **Step 3: Implement exact selection, availability, and partial preview**

Implement normalized matching with these rules:

- exact selection requires one selected value for every canonical attribute;
- only active combinations with stock greater than zero are available;
- availability applies the proposed value to the current partial selection;
- preview prefers exact combination media, then the first compatible active/in-stock Color combination media, then base images.

- [ ] **Step 4: Replace local canonical variant logic in `ProductDetailScreen`**

Remove the screen-local `CanonicalVariantAttribute`, `CanonicalVariantCombination`, exact lookup, availability lookup, and selected-variant image construction.

Use:

```ts
const selectedVariant = resolveExactVariant(
  variantCombinations,
  variantAttributes,
  selectedVariantOptions
);

const displayImages = resolveVariantPreviewImages({
  baseImages: product.images,
  combinations: variantCombinations,
  attributes: variantAttributes,
  selection: selectedVariantOptions,
});
```

Keep seller price, SKU, stock, `selectedVariantSnapshot`, Add to Cart, and Buy Now tied only to `selectedVariant`. Reset the visible gallery index whenever the first resolved preview image changes.

- [ ] **Step 5: Make Color selection visibly update the gallery**

The existing option chips continue to update `selectedVariantOptions`. Add accessible labels such as `Select Color Red`. Show “Select all options to confirm stock and SKU” while the gallery is already using the partial Color preview.

Do not auto-select a Size and do not send a preview-only combination to cart.

- [ ] **Step 6: Run targeted tests and mobile typechecking**

Run:

```bash
npx tsx --test apps/mobile/src/screens/product/productVariantDomain.test.ts
npm run typecheck --workspace=apps/mobile
```

Expected: variant tests pass and mobile TypeScript exits 0.

- [ ] **Step 7: Record the buyer-flow checkpoint**

Run:

```bash
git diff --check -- \
  apps/mobile/src/screens/product/ProductDetailScreen.tsx \
  apps/mobile/src/screens/product/productVariantDomain.ts \
  apps/mobile/src/screens/product/productVariantDomain.test.ts
git diff -- apps/mobile/src/screens/product/ProductDetailScreen.tsx
```

Confirm preview media can resolve from a partial Color selection while `selectedVariantSnapshot` remains undefined until exact selection.

---

### Task 6: Completion verification and scope audit

**Files:**

- Verify all files listed in the File Structure section.
- Do not modify web files, Convex schema, or production data.

**Interfaces:**

- Verifies the complete approved design rather than adding another interface.

- [ ] **Step 1: Run the registered focused test suite**

Run:

```bash
npm run test:app-review
```

Expected: every existing app-review policy test plus `productVariantDomain.test.ts` passes with zero failures.

- [ ] **Step 2: Run the full repository typecheck**

Run:

```bash
npm run typecheck
```

Expected: shared, API, web, and mobile TypeScript checks all exit 0.

- [ ] **Step 3: Run repository lint and existing API tests**

Run:

```bash
npm run lint
npm run test
```

Expected: lint and existing API Jest tests exit 0. If an unrelated pre-existing failure appears, capture the exact command and output and do not claim that gate passed.

- [ ] **Step 4: Audit every completion criterion**

Use these commands:

```bash
rg -n 'variantsText|parseVariantAttributes|buildVariantCombinations' \
  apps/mobile/src/screens/product/CreateProductScreen.tsx \
  apps/mobile/src/screens/product/EditProductScreen.tsx

rg -n 'ProductVariantEditor|resolveVariantPreviewImages|resolveExactVariant' \
  apps/mobile/src/screens/product

git diff -- \
  apps/mobile/src/screens/product/productVariantDomain.ts \
  apps/mobile/src/screens/product/productVariantDomain.test.ts \
  apps/mobile/src/screens/product/ProductVariantEditor.tsx \
  apps/mobile/src/screens/product/CreateProductScreen.tsx \
  apps/mobile/src/screens/product/EditProductScreen.tsx \
  apps/mobile/src/screens/product/ProductDetailScreen.tsx \
  package.json
```

Expected:

- no free-form variant path remains in create/edit;
- both vendor screens use `ProductVariantEditor`;
- product detail uses shared preview and exact-selection functions;
- the scoped diff contains only the intended mobile variant behavior layered onto the pre-existing dirty files.

- [ ] **Step 5: Review the final diff and confirm no unrelated changes were staged**

Run:

```bash
git diff --check
git diff --cached --name-only
git status --short --branch
```

Expected:

- `git diff --check` exits 0;
- no implementation files are staged;
- pre-existing unrelated modifications remain present and untouched.

- [ ] **Step 6: Report runtime limitations honestly**

If no iOS or Android simulator was available, report that automated domain behavior and TypeScript contracts passed but interactive media selection was not device-rendered. Do not claim device verification without an actual simulator or device run.
