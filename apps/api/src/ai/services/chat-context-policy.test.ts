import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSafeAccountContext,
  buildSafeProductContext,
} from './chat-context-policy';

test('account context includes aggregate activity without personal or transaction details', () => {
  const context = buildSafeAccountContext({
    orders: {
      totalOrders: 4,
      pendingOrders: 1,
      completedOrders: 2,
      disputedOrders: 1,
    },
    sellerOrders: [
      {
        status: 'paid',
        orderNumber: 'GIO-SENSITIVE-123',
        totalAmount: 9876,
        shippingAddress: {
          street: '12 Sensitive Street',
          phone: '+260 900 000 000',
        },
      },
    ],
    listings: {
      totalListings: 3,
      activeListings: 2,
      soldListings: 1,
      totalViews: 25,
    },
  });

  assert.match(context, /Total orders: 4/);
  assert.match(context, /Pending fulfillment: 1/);
  assert.match(context, /Total listings: 3/);
  assert.doesNotMatch(context, /GIO-SENSITIVE-123/);
  assert.doesNotMatch(context, /9876/);
  assert.doesNotMatch(context, /Sensitive Street/);
  assert.doesNotMatch(context, /260 900/);
});

test('product context omits seller identity while retaining public listing data', () => {
  const context = buildSafeProductContext({
    title: 'Desk Lamp',
    description: 'A public listing description.',
    price: 450,
    condition: 'new',
    views: 12,
    seller: {
      firstName: 'PrivateFirst',
      lastName: 'PrivateLast',
      rating: 4.8,
    },
  });

  assert.match(context, /Desk Lamp/);
  assert.match(context, /Seller rating: 4\.8\/5/);
  assert.doesNotMatch(context, /PrivateFirst/);
  assert.doesNotMatch(context, /PrivateLast/);
});
