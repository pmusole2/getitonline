import assert from 'node:assert/strict';
import test from 'node:test';

import { didCategoryParentChange } from './categoryHierarchyPolicy';

test('treats missing and null parent IDs as the same top-level parent', () => {
  assert.equal(didCategoryParentChange(undefined, null), false);
  assert.equal(didCategoryParentChange(null, undefined), false);
});

test('does not report a change when the parent ID is unchanged', () => {
  assert.equal(didCategoryParentChange('parent-1', 'parent-1'), false);
});

test('reports actual parent changes', () => {
  assert.equal(didCategoryParentChange(undefined, 'parent-1'), true);
  assert.equal(didCategoryParentChange('parent-1', null), true);
  assert.equal(didCategoryParentChange('parent-1', 'parent-2'), true);
});
