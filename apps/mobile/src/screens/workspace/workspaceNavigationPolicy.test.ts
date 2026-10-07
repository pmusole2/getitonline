import assert from 'node:assert/strict';
import test from 'node:test';
import { getPrimarySellerRoute } from './workspaceNavigationPolicy';

test('routes an unapproved seller to the vendor application screen', () => {
  assert.equal(getPrimarySellerRoute(false), 'Sell');
});

test('routes an approved seller to listing creation', () => {
  assert.equal(getPrimarySellerRoute(true), 'CreateProduct');
});
