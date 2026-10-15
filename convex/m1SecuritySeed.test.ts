import assert from 'node:assert/strict';
import test from 'node:test';

import * as seed from './seed';
import { createCtx, createDb, handlerOf } from '../tests/support/convexFakeDb';

// Category seeding is an operator step, not a client action. Convex refuses client calls to internal functions, so a
// signed-out caller or an ordinary user cannot win initial setup. The trusted path still seeds an empty table, and a
// non-empty table is a no-op.

type Args = Record<string, unknown>;
type SeedResult = { success: boolean; message: string };

const seedAllCategories = handlerOf<Args, SeedResult>(seed.seedAllCategories);

function flag(fn: unknown, name: 'isPublic' | 'isInternal'): unknown {
  return typeof fn === 'function' && name in fn ? Reflect.get(fn, name) : undefined;
}

test('seedAllCategories is internal, so no anonymous caller or ordinary user can call it', () => {
  assert.equal(flag(seed.seedAllCategories, 'isInternal'), true);
  assert.notEqual(flag(seed.seedAllCategories, 'isPublic'), true);
});

test('the trusted path seeds an empty categories table with parents and subcategories', async () => {
  const db = createDb({ categories: [] });

  const result = await seedAllCategories(createCtx(db, null), {});

  assert.equal(result.success, true);
  const rows = db.tables.categories ?? [];
  const parent = rows.find((row) => row.slug === 'auto-parts');
  const child = rows.find((row) => row.slug === 'engine-parts');
  assert.ok(parent, 'auto-parts parent category must be seeded');
  assert.equal(parent.parentId, undefined);
  assert.ok(child, 'engine-parts subcategory must be seeded');
  assert.equal(child.parentId, parent._id);
  assert.equal(child.isActive, true);
});

test('the trusted path is a no-op once any category exists, and writes nothing', async () => {
  const existing = { _id: 'categories|1', name: 'Existing', slug: 'existing', isActive: true };
  const db = createDb({ categories: [existing] });
  const before = structuredClone(db.tables);

  const result = await seedAllCategories(createCtx(db, null), {});

  assert.deepEqual(result, { success: false, message: 'Categories already seeded' });
  assert.deepEqual(db.tables, before);
});
