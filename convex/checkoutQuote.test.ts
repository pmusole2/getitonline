import assert from 'node:assert/strict';
import test from 'node:test';

import * as checkoutQuote from './checkoutQuote';
import { invokeFakeFunction } from '../tests/support/convexFakeActionCtx';
import { createCtx, createDb, type Db, type Row, type Tables } from '../tests/support/convexFakeDb';
import type { CheckoutQuote, QuoteResult } from './lib/checkoutQuote';

// End-to-end quote checks through the real registered query. Every test runs
// quoteCheckout against the fake database, asserts exact independently
// computed cents, and proves the read-only query changed no table on success
// or denial.

const ADDRESS = {
  street: '123 Main',
  city: 'Lusaka',
  province: 'Lusaka',
  country: 'Zambia',
  phone: '0971234567',
};

function userRow(id: string, clerkId: string, role: string, extra: Record<string, unknown> = {}): Row {
  return {
    _id: id,
    clerkId,
    email: `${clerkId}@example.invalid`,
    firstName: id,
    lastName: 'Test',
    role,
    isBanned: false,
    totalSales: 0,
    totalPurchases: 0,
    isVerified: true,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

function productRow(id: string, sellerId: string, extra: Record<string, unknown> = {}): Row {
  return {
    _id: id,
    sellerId,
    title: `Title ${id}`,
    description: 'A test listing',
    price: 100,
    images: ['https://images.invalid/x.jpg'],
    condition: 'good',
    status: 'active',
    quantity: 10,
    categoryId: 'categories|1',
    shippingOptions: [{ name: 'Courier', price: 50 }],
    views: 0,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

function fixtureTables(delivery: boolean): Tables {
  const users: Row[] = [
    userRow('users|buyer', 'clerk_buyer', 'user'),
    userRow('users|other', 'clerk_other', 'user'),
    userRow('users|seller', 'clerk_seller', 'user'),
    userRow('users|seller2', 'clerk_seller2', 'user'),
    userRow('users|suspended', 'clerk_suspended', 'user'),
    userRow('users|admin', 'clerk_admin', 'admin'),
    userRow('users|banned', 'clerk_banned', 'user', { isBanned: true }),
    userRow('users|deleted', 'clerk_deleted', 'user', { deletedAt: 1 }),
    userRow('users|company', 'clerk_company', 'admin'),
  ];
  const vendorProfiles: Row[] = [
    {
      _id: 'vendorProfiles|seller',
      ownerUserId: 'users|seller',
      status: 'approved',
      storeName: 'Seller',
      slug: 'seller',
    },
    {
      _id: 'vendorProfiles|seller2',
      ownerUserId: 'users|seller2',
      status: 'approved',
      storeName: 'Seller2',
      slug: 'seller2',
    },
    { _id: 'vendorProfiles|buyer', ownerUserId: 'users|buyer', status: 'approved', storeName: 'Buyer', slug: 'buyer' },
    {
      _id: 'vendorProfiles|suspended',
      ownerUserId: 'users|suspended',
      status: 'suspended',
      storeName: 'Susp',
      slug: 'susp',
    },
  ];
  const products: Row[] = [
    productRow('products|lamp', 'users|seller', { price: 100, quantity: 10, weightKg: 2 }),
    productRow('products|shirt', 'users|seller', {
      price: 20,
      quantity: 10,
      weightKg: 1,
      variantCombinations: [
        { id: 'c1', sku: 'SH-1', attributes: [{ name: 'Color', value: 'Red' }], price: 30, stock: 5, status: 'active' },
        {
          id: 'c2',
          sku: 'SH-2',
          attributes: [{ name: 'Color', value: 'Blue' }],
          price: 40,
          stock: 0,
          status: 'out_of_stock',
        },
      ],
    }),
    productRow('products|ambig', 'users|seller', {
      price: 10,
      variantCombinations: [
        { id: 'a1', sku: 'DUP', attributes: [], price: 10, stock: 5, status: 'active' },
        { id: 'a2', sku: 'DUP', attributes: [], price: 12, stock: 5, status: 'active' },
      ],
    }),
    productRow('products|mug', 'users|seller', {
      price: 50,
      weightKg: 1,
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
    }),
    productRow('products|cap', 'users|seller2', {
      price: 10,
      quantity: 100,
      weightKg: 0.5,
      shippingOptions: [{ name: 'Standard', price: 20 }],
    }),
    productRow('products|tiny1', 'users|seller', {
      price: 0.1,
      quantity: 5,
      weightKg: 0,
      shippingOptions: [{ name: 'Free', price: 0 }],
    }),
    productRow('products|tiny2', 'users|seller2', {
      price: 0.1,
      quantity: 5,
      weightKg: 0,
      shippingOptions: [{ name: 'Free', price: 0 }],
    }),
    productRow('products|freebie', 'users|seller', {
      price: 0,
      weightKg: 0,
      shippingOptions: [{ name: 'Free', price: 0 }],
    }),
    productRow('products|free2', 'users|seller2', {
      price: 0,
      weightKg: 0,
      shippingOptions: [{ name: 'Free', price: 0 }],
    }),
    productRow('products|own', 'users|buyer', { price: 25, quantity: 5 }),
    productRow('products|hidden', 'users|seller', { price: 999, status: 'draft' }),
    productRow('products|private', 'users|suspended', { price: 999 }),
  ];
  const now = Date.now();
  const promoCodes: Row[] = [
    {
      _id: 'promoCodes|save10',
      code: 'SAVE10',
      title: 'Save',
      scope: 'platform',
      discountType: 'percent',
      discountValue: 10,
      startsAt: now - 3600000,
      isActive: true,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      _id: 'promoCodes|sell50',
      code: 'SELL50',
      title: 'Seller',
      scope: 'seller',
      sellerId: 'users|seller2',
      discountType: 'percent',
      discountValue: 50,
      startsAt: now - 3600000,
      isActive: true,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      _id: 'promoCodes|fix5',
      code: 'FIX5',
      title: 'Fixed',
      scope: 'platform',
      discountType: 'fixed_amount',
      discountValue: 5,
      maxDiscount: 3,
      startsAt: now - 3600000,
      isActive: true,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      _id: 'promoCodes|old',
      code: 'OLD',
      title: 'Old',
      scope: 'platform',
      discountType: 'percent',
      discountValue: 10,
      startsAt: now - 7200000,
      endsAt: now - 3600000,
      isActive: true,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      _id: 'promoCodes|once',
      code: 'ONCE',
      title: 'Once',
      scope: 'platform',
      discountType: 'percent',
      discountValue: 10,
      perUserLimit: 1,
      startsAt: now - 3600000,
      isActive: true,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      _id: 'promoCodes|cap1',
      code: 'CAP1',
      title: 'Cap',
      scope: 'platform',
      discountType: 'percent',
      discountValue: 10,
      usageLimit: 1,
      startsAt: now - 3600000,
      isActive: true,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      _id: 'promoCodes|min200',
      code: 'MIN200',
      title: 'Min',
      scope: 'platform',
      discountType: 'percent',
      discountValue: 10,
      minimumSubtotal: 200,
      startsAt: now - 3600000,
      isActive: true,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      _id: 'promoCodes|catx',
      code: 'CATX',
      title: 'Cat',
      scope: 'category',
      categoryId: 'categories|9',
      discountType: 'percent',
      discountValue: 10,
      startsAt: now - 3600000,
      isActive: true,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      _id: 'promoCodes|prodlamp',
      code: 'PRODLAMP',
      title: 'Prod',
      scope: 'product',
      productId: 'products|lamp',
      discountType: 'percent',
      discountValue: 20,
      startsAt: now - 3600000,
      isActive: true,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      _id: 'promoCodes|p33',
      code: 'P33',
      title: 'Third',
      scope: 'platform',
      discountType: 'percent',
      discountValue: 33.333,
      startsAt: now - 3600000,
      isActive: true,
      createdAt: 1,
      updatedAt: 1,
    },
  ];
  const tables: Tables = {
    users,
    vendorProfiles,
    platformSettings: [
      {
        _id: 'platformSettings|1',
        key: 'singleton',
        companySellerUserId: 'users|company',
        companyDisplayName: 'Gettitonline',
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    products,
    cartItems: [],
    orders: [],
    promoCodes,
    promoCodeRedemptions: [],
    loyaltyAccounts: [
      {
        _id: 'loyaltyAccounts|buyer',
        userId: 'users|buyer',
        pointsBalance: 100,
        lifetimeEarned: 100,
        lifetimeRedeemed: 0,
        tier: 'bronze',
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  };
  if (delivery) {
    tables.deliveryZones = [
      {
        _id: 'deliveryZones|z1',
        name: 'Lusaka',
        slug: 'lusaka',
        province: 'Lusaka',
        city: 'Lusaka',
        isActive: true,
        sortOrder: 0,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        _id: 'deliveryZones|z2',
        name: 'Kitwe',
        slug: 'kitwe',
        province: 'Copperbelt',
        city: 'Kitwe',
        isActive: true,
        sortOrder: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    tables.deliveryMethods = [
      {
        _id: 'deliveryMethods|m1',
        zoneId: 'deliveryZones|z1',
        name: 'Standard',
        code: 'STD',
        type: 'standard',
        baseFee: 20,
        perKgFee: 10,
        minDays: 1,
        maxDays: 3,
        isActive: true,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        _id: 'deliveryMethods|mfree',
        zoneId: 'deliveryZones|z1',
        name: 'FreeBig',
        code: 'FREE',
        type: 'standard',
        baseFee: 5,
        freeAboveSubtotal: 200,
        minDays: 1,
        maxDays: 2,
        isActive: true,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        _id: 'deliveryMethods|mpick',
        zoneId: 'deliveryZones|z1',
        name: 'Pickup',
        code: 'PICK',
        type: 'pickup',
        baseFee: 0,
        minDays: 0,
        maxDays: 1,
        isActive: true,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        _id: 'deliveryMethods|mfar',
        zoneId: 'deliveryZones|z2',
        name: 'Far',
        code: 'FAR',
        type: 'standard',
        baseFee: 99,
        minDays: 5,
        maxDays: 9,
        isActive: true,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        _id: 'deliveryMethods|mtiny',
        zoneId: 'deliveryZones|z1',
        name: 'Tiny',
        code: 'TINY',
        type: 'standard',
        baseFee: 0.01,
        minDays: 1,
        maxDays: 1,
        isActive: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    tables.pickupPoints = [
      {
        _id: 'pickupPoints|p1',
        zoneId: 'deliveryZones|z1',
        name: 'Point',
        code: 'P1',
        address: ADDRESS,
        isActive: true,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        _id: 'pickupPoints|poff',
        zoneId: 'deliveryZones|z1',
        name: 'Off',
        code: 'POFF',
        address: ADDRESS,
        isActive: false,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
  } else {
    tables.deliveryZones = [];
    tables.deliveryMethods = [];
    tables.pickupPoints = [];
  }
  return tables;
}

function open(delivery = true): Db {
  return createDb(fixtureTables(delivery));
}

async function quote(db: Db, clerkId: string | null, args: Record<string, unknown>): Promise<QuoteResult> {
  return (await invokeFakeFunction(checkoutQuote.quoteCheckout, createCtx(db, clerkId), args)) as QuoteResult;
}

function okQuote(result: QuoteResult): CheckoutQuote {
  if (!result.ok) {
    throw new Error(`expected an ok quote, got ${result.code}`);
  }
  return result.quote;
}

function failCode(result: QuoteResult): string {
  if (result.ok) {
    throw new Error('expected a denial');
  }
  return result.code;
}

function snapshot(db: Db): Tables {
  return structuredClone(db.tables);
}

function cartArgs(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { source: 'cart', deliveryMethodId: 'deliveryMethods|m1', shippingAddress: ADDRESS, ...extra };
}

function seedCartLine(db: Db, productId: string, quantity: number, extra: Record<string, unknown> = {}): string {
  const rows = db.tables.cartItems;
  assert.ok(rows, 'cartItems table must exist');
  const id = `cartItems|seed${rows.length + 1}`;
  rows.push({
    _id: id,
    userId: 'users|buyer',
    productId,
    quantity,
    selectedShipping: { name: 'Courier', price: 50 },
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  });
  return id;
}

function seedOrder(
  db: Db,
  orderId: string,
  buyerId: string,
  sellerId: string,
  status: string,
  items: Record<string, unknown>[],
): void {
  const rows = db.tables.orders;
  assert.ok(rows, 'orders table must exist');
  rows.push({
    _id: orderId,
    orderNumber: orderId,
    buyerId,
    sellerId,
    items,
    subtotal: 0,
    shippingCost: 0,
    platformFee: 0,
    totalAmount: 0,
    sellerPayout: 0,
    shippingAddress: ADDRESS,
    status,
    createdAt: 1,
    updatedAt: 1,
  });
}

function lampItem(quantity: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    productId: 'products|lamp',
    title: 'Stale title',
    price: 0.01,
    quantity,
    image: 'https://images.invalid/stale.jpg',
    ...extra,
  };
}

function findRow(db: Db, table: string, id: string): Row {
  const row = db.tables[table]?.find((candidate) => candidate._id === id);
  assert.ok(row, `${id} must exist in ${table}`);
  return row;
}

// ---- Auth: denials happen before any catalog read, with no writes ----

test('anonymous, banned, deleted, and unknown callers are denied with no writes', async () => {
  const db = open();
  seedCartLine(db, 'products|lamp', 1);

  const before = snapshot(db);
  await assert.rejects(() => quote(db, null, cartArgs()), /Unauthenticated/);
  await assert.rejects(() => quote(db, 'clerk_banned', cartArgs()), /banned/);
  await assert.rejects(() => quote(db, 'clerk_deleted', cartArgs()), /deleted/);
  await assert.rejects(() => quote(db, 'clerk_missing', cartArgs()), /not found/);
  assert.deepEqual(db.tables, before);
});

test('a legacy tombstone row denies the subject with no writes', async () => {
  const db = open();
  seedCartLine(db, 'products|lamp', 1);
  db.tables.users?.push({
    _id: 'users|ghost',
    clerkId: 'deleted:clerk_ghost',
    email: 'g@example.invalid',
    firstName: 'Ghost',
    lastName: 'Test',
    role: 'user',
    isBanned: false,
    deletedAt: 2,
    totalSales: 0,
    totalPurchases: 0,
    isVerified: true,
    createdAt: 1,
    updatedAt: 1,
  });

  const before = snapshot(db);
  await assert.rejects(() => quote(db, 'clerk_ghost', cartArgs()), /deleted/);
  assert.deepEqual(db.tables, before);
});

// ---- Request shape: the public args carry no prices, sellers, or actors ----

test('caller-supplied price, seller, and actor fields are rejected by validation', async () => {
  const db = open();
  seedCartLine(db, 'products|lamp', 1);

  const before = snapshot(db);
  await assert.rejects(() => quote(db, 'clerk_buyer', { ...cartArgs(), subtotal: 1 }), /Argument validation failed/);
  await assert.rejects(
    () => quote(db, 'clerk_buyer', { ...cartArgs(), sellerId: 'users|seller' }),
    /Argument validation failed/,
  );
  await assert.rejects(
    () => quote(db, 'clerk_buyer', { ...cartArgs(), userId: 'users|other' }),
    /Argument validation failed/,
  );
  assert.deepEqual(db.tables, before);
});

test('order selectors are unique and source-appropriate', async () => {
  const db = open();
  seedCartLine(db, 'products|lamp', 1);
  seedOrder(db, 'orders|o1', 'users|buyer', 'users|seller', 'pending_payment', [lampItem(1)]);

  assert.equal(failCode(await quote(db, 'clerk_buyer', { ...cartArgs(), orderIds: ['orders|o1'] })), 'invalid_request');
  const pending = { source: 'pending_orders', shippingAddress: ADDRESS };
  assert.equal(failCode(await quote(db, 'clerk_buyer', pending)), 'invalid_request');
  assert.equal(
    failCode(await quote(db, 'clerk_buyer', { ...pending, orderIds: ['orders|o1', 'orders|o1'] })),
    'invalid_request',
  );
});

test('a blank address is an invalid request', async () => {
  const db = open();
  seedCartLine(db, 'products|lamp', 1);

  assert.equal(
    failCode(await quote(db, 'clerk_buyer', cartArgs({ shippingAddress: { ...ADDRESS, city: '  ' } }))),
    'invalid_request',
  );
});

// ---- Cart happy path with exact independently computed cents ----

test('a cart checkout prices delivery, promo, loyalty, and fee in exact cents', async () => {
  const db = open();
  seedCartLine(db, 'products|lamp', 2);
  seedCartLine(db, 'products|mug', 1, { selectedVariantOptions: [{ name: 'Size', value: 'L' }] });
  const before = snapshot(db);

  const result = await quote(db, 'clerk_buyer', cartArgs({ promoCode: ' save10 ', loyaltyPoints: 50 }));
  const priced = okQuote(result);

  assert.equal(priced.currency, 'ZMW');
  assert.equal(priced.source, 'cart');
  assert.equal(priced.lines.length, 2);
  assert.equal(priced.subtotalCents, 26300);
  assert.equal(priced.shippingCents, 7000);
  assert.equal(priced.promo?.discountCents, 2630);
  assert.equal(priced.loyalty?.points, 50);
  assert.equal(priced.loyalty?.discountCents, 500);
  assert.equal(priced.discountCents, 3130);
  assert.equal(priced.discountedSubtotalCents, 23170);
  assert.equal(priced.platformFeeCents, 1159);
  assert.equal(priced.sellerPayoutCents, 30170);
  assert.equal(priced.totalAmountCents, 31329);
  assert.equal(priced.sellers.length, 1);
  assert.equal(priced.delivery.methodId, 'deliveryMethods|m1');
  assert.equal(priced.delivery.methodType, 'standard');
  assert.equal(priced.promo?.promoCodeId, 'promoCodes|save10');
  assert.match(priced.inputIdentity, /^[0-9a-f]{64}$/);
  assert.match(priced.quoteKey, /^[0-9a-f]{64}$/);
  assert.notEqual(priced.inputIdentity, priced.quoteKey);
  assert.deepEqual(db.tables, before);
});

test('two sellers conserve every cent across shipping and fee splits', async () => {
  const db = open();
  seedCartLine(db, 'products|lamp', 1);
  seedCartLine(db, 'products|cap', 1);

  const priced = okQuote(await quote(db, 'clerk_buyer', cartArgs()));

  assert.equal(priced.subtotalCents, 11000);
  assert.equal(priced.shippingCents, 4500);
  assert.equal(priced.platformFeeCents, 550);
  assert.equal(priced.totalAmountCents, 16050);
  assert.equal(priced.sellers.length, 2);
  assert.equal(priced.sellers[0]?.sellerId, 'users|seller');
  assert.equal(priced.sellers[0]?.shippingCents, 4091);
  assert.equal(priced.sellers[0]?.platformFeeCents, 500);
  assert.equal(priced.sellers[0]?.totalAmountCents, 14591);
  assert.equal(priced.sellers[1]?.shippingCents, 409);
  assert.equal(priced.sellers[1]?.platformFeeCents, 50);
  assert.equal(priced.sellers[1]?.totalAmountCents, 1459);
  for (const field of [
    'subtotalCents',
    'promoCents',
    'loyaltyCents',
    'discountCents',
    'discountedSubtotalCents',
    'shippingCents',
    'platformFeeCents',
    'sellerPayoutCents',
    'totalAmountCents',
  ] as const) {
    assert.equal(
      (priced.sellers[0]?.[field] ?? 0) + (priced.sellers[1]?.[field] ?? 0),
      priced[field],
      `aggregate ${field} must equal the sum of seller fields`,
    );
  }
});

test('tiny multi-seller values never over-discount a group', async () => {
  const db = open();
  seedCartLine(db, 'products|tiny1', 1);
  seedCartLine(db, 'products|tiny2', 1);

  const priced = okQuote(await quote(db, 'clerk_buyer', cartArgs({ deliveryMethodId: 'deliveryMethods|mtiny' })));

  assert.equal(priced.subtotalCents, 20);
  assert.equal(priced.shippingCents, 1);
  assert.equal(priced.platformFeeCents, 1);
  assert.equal(priced.totalAmountCents, 22);
  assert.deepEqual(
    priced.sellers.map((seller) => seller.totalAmountCents),
    [12, 10],
  );
});

test('free items split a positive shipping fee to the last stable seller', async () => {
  const db = open();
  seedCartLine(db, 'products|freebie', 1);
  seedCartLine(db, 'products|free2', 1);

  const priced = okQuote(await quote(db, 'clerk_buyer', cartArgs({ deliveryMethodId: 'deliveryMethods|mtiny' })));

  assert.equal(priced.subtotalCents, 0);
  assert.equal(priced.shippingCents, 1);
  assert.equal(priced.totalAmountCents, 1);
  assert.deepEqual(
    priced.sellers.map((seller) => seller.shippingCents),
    [0, 1],
  );
});

test('an all-free checkout with no fees is denied as a non-positive total', async () => {
  const db = open(false);
  seedCartLine(db, 'products|freebie', 1);

  assert.equal(failCode(await quote(db, 'clerk_buyer', cartArgs({ deliveryMethodId: undefined }))), 'invalid_request');
});

// ---- Canonical prices override tampered stored values ----

test('stale nested cart and order prices never move the quote', async () => {
  const db = open();
  seedCartLine(db, 'products|shirt', 1, {
    selectedVariant: {
      variantId: 'c1',
      sku: 'SH-1',
      attributes: [],
      price: 0.01,
      image: 'https://images.invalid/stale.jpg',
    },
  });
  seedCartLine(db, 'products|mug', 1, {
    selectedVariantOptions: [{ name: 'Size', value: 'L', priceDelta: 9999 }],
    selectedAddOns: [{ name: 'Gift wrap', price: 9999 }],
  });

  const cartPriced = okQuote(await quote(db, 'clerk_buyer', cartArgs()));
  assert.equal(cartPriced.subtotalCents, 3000 + 7000);

  seedOrder(db, 'orders|o1', 'users|buyer', 'users|seller', 'pending_payment', [lampItem(1)]);
  const pendingPriced = okQuote(
    await quote(db, 'clerk_buyer', {
      source: 'pending_orders',
      orderIds: ['orders|o1'],
      deliveryMethodId: 'deliveryMethods|m1',
      shippingAddress: ADDRESS,
    }),
  );
  assert.equal(pendingPriced.subtotalCents, 10000);
  assert.equal(pendingPriced.lines[0]?.title, 'Title products|lamp');
});

// ---- Eligibility: self-purchase, visibility, sellers, stock ----

test('self-purchase is denied even for a public storefront seller', async () => {
  const db = open();
  seedCartLine(db, 'products|own', 1);

  assert.equal(failCode(await quote(db, 'clerk_buyer', cartArgs())), 'self_purchase');
});

test('hidden listings and non-public sellers are unavailable', async () => {
  const db = open();
  seedCartLine(db, 'products|hidden', 1);
  assert.equal(failCode(await quote(db, 'clerk_buyer', cartArgs())), 'unavailable');

  const second = open();
  seedCartLine(second, 'products|private', 1);
  assert.equal(failCode(await quote(second, 'clerk_buyer', cartArgs())), 'unavailable');

  const third = open();
  seedCartLine(third, 'products|gone', 1);
  assert.equal(failCode(await quote(third, 'clerk_buyer', cartArgs())), 'unavailable');
});

test('a banned seller makes their listings unavailable', async () => {
  const db = open();
  seedCartLine(db, 'products|lamp', 1);
  findRow(db, 'users', 'users|seller').isBanned = true;

  assert.equal(failCode(await quote(db, 'clerk_buyer', cartArgs())), 'unavailable');
});

test('cumulative cart pools enforce stock while owned reservations do not', async () => {
  const db = open();
  seedCartLine(db, 'products|lamp', 6);
  seedCartLine(db, 'products|lamp', 5);
  assert.equal(failCode(await quote(db, 'clerk_buyer', cartArgs())), 'insufficient_stock');

  const reserved = open();
  seedOrder(reserved, 'orders|o1', 'users|buyer', 'users|seller', 'pending_payment', [lampItem(11)]);
  findRow(reserved, 'products', 'products|lamp').quantity = 2;
  const priced = okQuote(
    await quote(reserved, 'clerk_buyer', {
      source: 'pending_orders',
      orderIds: ['orders|o1'],
      deliveryMethodId: 'deliveryMethods|m1',
      shippingAddress: ADDRESS,
    }),
  );
  assert.equal(priced.subtotalCents, 110000);
});

test('a zeroed variant denies carts but quotes owned pending orders', async () => {
  const db = open();
  seedCartLine(db, 'products|shirt', 1, {
    selectedVariant: { variantId: 'c2', sku: 'SH-2', attributes: [], price: 40 },
  });
  assert.equal(failCode(await quote(db, 'clerk_buyer', cartArgs())), 'insufficient_stock');

  const reserved = open();
  seedOrder(reserved, 'orders|o1', 'users|buyer', 'users|seller', 'pending_payment', [
    lampItem(1, {
      productId: 'products|shirt',
      selectedVariant: { variantId: 'c2', sku: 'SH-2', attributes: [], price: 40 },
    }),
  ]);
  const priced = okQuote(
    await quote(reserved, 'clerk_buyer', {
      source: 'pending_orders',
      orderIds: ['orders|o1'],
      deliveryMethodId: 'deliveryMethods|m1',
      shippingAddress: ADDRESS,
    }),
  );
  assert.equal(priced.subtotalCents, 4000);
});

test('an intentionally out-of-stock variant with stock left denies every source', async () => {
  for (const source of ['cart', 'pending_orders'] as const) {
    const db = open();
    findRow(db, 'products', 'products|shirt').variantCombinations = [
      { id: 'c1', sku: 'SH-1', attributes: [{ name: 'Color', value: 'Red' }], price: 30, stock: 5, status: 'active' },
      {
        id: 'c2',
        sku: 'SH-2',
        attributes: [{ name: 'Color', value: 'Blue' }],
        price: 40,
        stock: 3,
        status: 'out_of_stock',
      },
    ];
    if (source === 'cart') {
      seedCartLine(db, 'products|shirt', 1, {
        selectedVariant: { variantId: 'c2', sku: 'SH-2', attributes: [], price: 40 },
      });
      assert.equal(failCode(await quote(db, 'clerk_buyer', cartArgs())), 'invalid_variant');
    } else {
      seedOrder(db, 'orders|o1', 'users|buyer', 'users|seller', 'pending_payment', [
        lampItem(1, {
          productId: 'products|shirt',
          selectedVariant: { variantId: 'c2', sku: 'SH-2', attributes: [], price: 40 },
        }),
      ]);
      assert.equal(
        failCode(
          await quote(db, 'clerk_buyer', {
            source,
            orderIds: ['orders|o1'],
            deliveryMethodId: 'deliveryMethods|m1',
            shippingAddress: ADDRESS,
          }),
        ),
        'invalid_variant',
      );
    }
  }
});

test('a sold listing still quotes owned pending orders but not carts', async () => {
  const db = open();
  findRow(db, 'products', 'products|lamp').status = 'sold';
  seedCartLine(db, 'products|lamp', 1);
  assert.equal(failCode(await quote(db, 'clerk_buyer', cartArgs())), 'unavailable');

  const reserved = open();
  findRow(reserved, 'products', 'products|lamp').status = 'sold';
  seedOrder(reserved, 'orders|o1', 'users|buyer', 'users|seller', 'pending_payment', [lampItem(1)]);
  const priced = okQuote(
    await quote(reserved, 'clerk_buyer', {
      source: 'pending_orders',
      orderIds: ['orders|o1'],
      deliveryMethodId: 'deliveryMethods|m1',
      shippingAddress: ADDRESS,
    }),
  );
  assert.equal(priced.subtotalCents, 10000);
});

test('an ambiguous stored variant and an unknown add-on are rejected', async () => {
  const db = open();
  seedCartLine(db, 'products|ambig', 1, {
    selectedVariant: { variantId: 'missing', sku: 'DUP', attributes: [], price: 10 },
  });
  assert.equal(failCode(await quote(db, 'clerk_buyer', cartArgs())), 'invalid_variant');

  const second = open();
  seedCartLine(second, 'products|mug', 1, {
    selectedVariantOptions: [{ name: 'Size', value: 'L' }],
    selectedAddOns: [{ name: 'Nope', price: 1 }],
  });
  assert.equal(failCode(await quote(second, 'clerk_buyer', cartArgs())), 'invalid_addon');
});

test('malformed stored money denies the quote with no writes', async () => {
  const db = open();
  seedCartLine(db, 'products|lamp', 1);
  findRow(db, 'products', 'products|lamp').price = 10.001;
  const before = snapshot(db);

  assert.equal(failCode(await quote(db, 'clerk_buyer', cartArgs())), 'malformed_money');
  assert.deepEqual(db.tables, before);
});

test('a stored non-integer cart quantity is corrupt, not clamped', async () => {
  const db = open();
  seedCartLine(db, 'products|lamp', 1.5);

  assert.equal(failCode(await quote(db, 'clerk_buyer', cartArgs())), 'malformed_catalog');
});

test('an empty cart and an empty pending set are empty denials', async () => {
  const db = open();
  assert.equal(failCode(await quote(db, 'clerk_buyer', cartArgs())), 'empty');

  seedOrder(db, 'orders|o1', 'users|buyer', 'users|seller', 'pending_payment', []);
  assert.equal(
    failCode(
      await quote(db, 'clerk_buyer', {
        source: 'pending_orders',
        orderIds: ['orders|o1'],
        deliveryMethodId: 'deliveryMethods|m1',
        shippingAddress: ADDRESS,
      }),
    ),
    'empty',
  );
});

// ---- Pending orders: ownership, status, and seller consistency ----

test('pending quotes need ownership, pending status, and seller consistency', async () => {
  const db = open();
  seedOrder(db, 'orders|mine', 'users|buyer', 'users|seller', 'pending_payment', [lampItem(1)]);
  seedOrder(db, 'orders|theirs', 'users|other', 'users|seller', 'pending_payment', [lampItem(1)]);
  seedOrder(db, 'orders|paid', 'users|buyer', 'users|seller', 'paid', [lampItem(1)]);
  seedOrder(db, 'orders|mixed', 'users|buyer', 'users|seller', 'pending_payment', [
    lampItem(1, { productId: 'products|cap' }),
  ]);
  const args = (orderIds: string[]): Record<string, unknown> => ({
    source: 'pending_orders',
    orderIds,
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });

  assert.equal(failCode(await quote(db, 'clerk_buyer', args(['orders|theirs']))), 'order_not_owned');
  assert.equal(failCode(await quote(db, 'clerk_buyer', args(['orders|nope']))), 'order_not_owned');
  assert.equal(failCode(await quote(db, 'clerk_buyer', args(['orders|paid']))), 'order_not_pending');
  assert.equal(failCode(await quote(db, 'clerk_buyer', args(['orders|mixed']))), 'malformed_catalog');
  const priced = okQuote(await quote(db, 'clerk_buyer', args(['orders|mine'])));
  assert.deepEqual(priced.orderIds, ['orders|mine']);
  assert.equal(priced.subtotalCents, 10000);
});

test('staff cannot quote another buyer’s orders or loyalty balance', async () => {
  const db = open();
  seedOrder(db, 'orders|mine', 'users|buyer', 'users|seller', 'pending_payment', [lampItem(1)]);

  assert.equal(
    failCode(
      await quote(db, 'clerk_admin', {
        source: 'pending_orders',
        orderIds: ['orders|mine'],
        deliveryMethodId: 'deliveryMethods|m1',
        shippingAddress: ADDRESS,
      }),
    ),
    'order_not_owned',
  );
});

// ---- Delivery: eligibility, pickup, thresholds, and fallback ----

test('an inapplicable method, a missing selector, and an inactive method are denied', async () => {
  const db = open();
  seedCartLine(db, 'products|lamp', 1);

  assert.equal(
    failCode(await quote(db, 'clerk_buyer', cartArgs({ deliveryMethodId: 'deliveryMethods|mfar' }))),
    'invalid_delivery',
  );
  assert.equal(failCode(await quote(db, 'clerk_buyer', cartArgs({ deliveryMethodId: undefined }))), 'invalid_delivery');
  assert.equal(
    failCode(await quote(db, 'clerk_buyer', cartArgs({ deliveryMethodId: 'deliveryMethods|nope' }))),
    'invalid_delivery',
  );
  findRow(db, 'deliveryMethods', 'deliveryMethods|m1').isActive = false;
  assert.equal(failCode(await quote(db, 'clerk_buyer', cartArgs())), 'invalid_delivery');
});

test('pickup needs an active point in the method zone and never rides along', async () => {
  const db = open();
  seedCartLine(db, 'products|lamp', 1);
  const pickup = { deliveryMethodId: 'deliveryMethods|mpick', shippingAddress: ADDRESS };

  assert.equal(failCode(await quote(db, 'clerk_buyer', { source: 'cart', ...pickup })), 'invalid_pickup');
  assert.equal(
    failCode(await quote(db, 'clerk_buyer', { source: 'cart', ...pickup, pickupPointId: 'pickupPoints|poff' })),
    'invalid_pickup',
  );
  const priced = okQuote(
    await quote(db, 'clerk_buyer', { source: 'cart', ...pickup, pickupPointId: 'pickupPoints|p1' }),
  );
  assert.equal(priced.delivery.pickupPointId, 'pickupPoints|p1');
  assert.equal(priced.shippingCents, 0);
  assert.equal(
    failCode(await quote(db, 'clerk_buyer', cartArgs({ pickupPointId: 'pickupPoints|p1' }))),
    'invalid_pickup',
  );
});

test('free shipping uses the pre-discount subtotal', async () => {
  const db = open();
  seedCartLine(db, 'products|lamp', 2);

  const priced = okQuote(
    await quote(db, 'clerk_buyer', cartArgs({ deliveryMethodId: 'deliveryMethods|mfree', promoCode: 'SAVE10' })),
  );
  assert.equal(priced.subtotalCents, 20000);
  assert.equal(priced.shippingCents, 0);

  const second = open();
  seedCartLine(second, 'products|lamp', 1);
  const paid = okQuote(await quote(second, 'clerk_buyer', cartArgs({ deliveryMethodId: 'deliveryMethods|mfree' })));
  assert.equal(paid.shippingCents, 500);
});

test('with no eligible methods the cart falls back to canonical product shipping', async () => {
  const db = open(false);
  seedCartLine(db, 'products|lamp', 2, { selectedShipping: { name: 'Courier', price: 1 } });
  findRow(db, 'products', 'products|lamp').shippingOptions = [{ name: 'Courier', price: 60 }];

  const priced = okQuote(await quote(db, 'clerk_buyer', { source: 'cart', shippingAddress: ADDRESS }));
  assert.equal(priced.shippingCents, 6000);
  assert.equal(priced.delivery.methodType, 'product_fallback');
  assert.equal(priced.delivery.methodId, undefined);
});

test('an explicit missing method never falls back to product shipping', async () => {
  const db = open(false);
  seedCartLine(db, 'products|lamp', 1);

  assert.equal(
    failCode(
      await quote(db, 'clerk_buyer', {
        source: 'cart',
        shippingAddress: ADDRESS,
        deliveryMethodId: 'deliveryMethods|nope',
      }),
    ),
    'invalid_delivery',
  );
});

test('pending lines use the default product shipping option in a fallback', async () => {
  const db = open(false);
  seedOrder(db, 'orders|o1', 'users|buyer', 'users|seller', 'pending_payment', [lampItem(1)]);

  const priced = okQuote(
    await quote(db, 'clerk_buyer', { source: 'pending_orders', orderIds: ['orders|o1'], shippingAddress: ADDRESS }),
  );
  assert.equal(priced.shippingCents, 5000);
  assert.equal(priced.delivery.methodType, 'product_fallback');
});

// ---- Promotions: scope, limits, and exact rounding ----

test('a platform code discounts the whole subtotal while a seller code stays in its group', async () => {
  const db = open();
  seedCartLine(db, 'products|lamp', 1);
  seedCartLine(db, 'products|cap', 1);

  const priced = okQuote(await quote(db, 'clerk_buyer', cartArgs({ promoCode: 'SELL50' })));
  assert.equal(priced.promo?.discountCents, 500);
  assert.equal(priced.sellers[0]?.promoCents, 0);
  assert.equal(priced.sellers[1]?.promoCents, 500);
  assert.equal(priced.discountedSubtotalCents, 10500);
});

test('a product-scoped code applies when any line matches', async () => {
  const db = open();
  seedCartLine(db, 'products|lamp', 1);
  seedCartLine(db, 'products|cap', 1);

  const priced = okQuote(await quote(db, 'clerk_buyer', cartArgs({ promoCode: 'PRODLAMP' })));
  assert.equal(priced.promo?.discountCents, 2200);
});

test('expired, limited, minimum, and mismatched codes are promo_invalid', async () => {
  const db = open();
  seedCartLine(db, 'products|lamp', 1);

  assert.equal(failCode(await quote(db, 'clerk_buyer', cartArgs({ promoCode: 'OLD' }))), 'promo_invalid');
  assert.equal(failCode(await quote(db, 'clerk_buyer', cartArgs({ promoCode: 'MISSING' }))), 'promo_invalid');
  assert.equal(failCode(await quote(db, 'clerk_buyer', cartArgs({ promoCode: 'MIN200' }))), 'promo_invalid');
  assert.equal(failCode(await quote(db, 'clerk_buyer', cartArgs({ promoCode: 'CATX' }))), 'promo_invalid');
  assert.equal(failCode(await quote(db, 'clerk_buyer', cartArgs({ promoCode: '   ' }))), 'promo_invalid');

  db.tables.promoCodeRedemptions?.push({
    _id: 'promoCodeRedemptions|1',
    promoCodeId: 'promoCodes|once',
    userId: 'users|buyer',
    discountAmount: 100,
    redeemedAt: 1,
  });
  assert.equal(failCode(await quote(db, 'clerk_buyer', cartArgs({ promoCode: 'ONCE' }))), 'promo_invalid');

  const second = open();
  seedCartLine(second, 'products|lamp', 1);
  second.tables.promoCodeRedemptions?.push({
    _id: 'promoCodeRedemptions|1',
    promoCodeId: 'promoCodes|cap1',
    userId: 'users|other',
    discountAmount: 100,
    redeemedAt: 1,
  });
  assert.equal(failCode(await quote(second, 'clerk_buyer', cartArgs({ promoCode: 'CAP1' }))), 'promo_invalid');
});

test('fixed promos respect the maximum and percent promos round half up', async () => {
  const db = open();
  seedCartLine(db, 'products|lamp', 1);

  const fixed = okQuote(await quote(db, 'clerk_buyer', cartArgs({ promoCode: 'FIX5' })));
  assert.equal(fixed.promo?.discountCents, 300);

  const second = open();
  seedCartLine(second, 'products|cap', 1);
  const third = okQuote(await quote(second, 'clerk_buyer', cartArgs({ promoCode: 'P33' })));
  assert.equal(third.promo?.discountCents, 333);
});

// ---- Loyalty: caps, accounts, and counters ----

test('loyalty is capped by balance and by the post-promo subtotal', async () => {
  const db = open();
  seedCartLine(db, 'products|lamp', 1);

  const capped = okQuote(await quote(db, 'clerk_buyer', cartArgs({ loyaltyPoints: 200 })));
  assert.equal(capped.loyalty?.points, 100);
  assert.equal(capped.loyalty?.discountCents, 1000);

  const tiny = open();
  seedCartLine(tiny, 'products|tiny1', 1);
  const afforded = okQuote(
    await quote(tiny, 'clerk_buyer', cartArgs({ deliveryMethodId: 'deliveryMethods|mtiny', loyaltyPoints: 100 })),
  );
  assert.equal(afforded.loyalty?.points, 1);
  assert.equal(afforded.loyalty?.discountCents, 10);
});

test('loyalty without an account denies only when points are requested', async () => {
  const db = open();
  seedCartLine(db, 'products|lamp', 1, { userId: 'users|other' });

  assert.equal(failCode(await quote(db, 'clerk_other', cartArgs({ loyaltyPoints: 5 }))), 'loyalty_invalid');
  const priced = okQuote(await quote(db, 'clerk_other', cartArgs()));
  assert.equal(priced.loyalty, undefined);
});

test('a corrupt loyalty account denies point use with no writes', async () => {
  const db = open();
  seedCartLine(db, 'products|lamp', 1);
  findRow(db, 'loyaltyAccounts', 'loyaltyAccounts|buyer').pointsBalance = 1.5;
  const before = snapshot(db);

  assert.equal(failCode(await quote(db, 'clerk_buyer', cartArgs({ loyaltyPoints: 5 }))), 'loyalty_invalid');
  assert.deepEqual(db.tables, before);
});

// ---- Fingerprint: stale keys refresh, fresh keys pass, prices move the key ----

test('a stale expected key refreshes with the fresh quote and writes nothing', async () => {
  const db = open();
  seedCartLine(db, 'products|lamp', 1);
  const before = snapshot(db);

  const first = okQuote(await quote(db, 'clerk_buyer', cartArgs()));
  const stale = await quote(db, 'clerk_buyer', cartArgs({ expectedQuoteKey: 'wrong' }));
  if (stale.ok) {
    throw new Error('expected a quote_mismatch');
  }
  assert.equal(stale.code, 'quote_mismatch');
  assert.equal(stale.quote?.quoteKey, first.quoteKey);
  const fresh = okQuote(await quote(db, 'clerk_buyer', cartArgs({ expectedQuoteKey: first.quoteKey })));
  assert.equal(fresh.quoteKey, first.quoteKey);
  assert.deepEqual(db.tables, before);
});

test('a catalog price move keeps the selector identity but changes the priced key', async () => {
  const db = open();
  seedCartLine(db, 'products|lamp', 1);

  const first = okQuote(await quote(db, 'clerk_buyer', cartArgs()));
  findRow(db, 'products', 'products|lamp').price = 110;
  const second = okQuote(await quote(db, 'clerk_buyer', cartArgs()));

  assert.equal(first.inputIdentity, second.inputIdentity);
  assert.notEqual(first.quoteKey, second.quoteKey);
  assert.equal(second.subtotalCents, 11000);
  assert.equal(
    failCode(await quote(db, 'clerk_buyer', cartArgs({ expectedQuoteKey: first.quoteKey }))),
    'quote_mismatch',
  );
});

// ---- Round-1 corrections: validated contract defects with real-query regressions ----

test('negative and fractional catalog stock is malformed, never normalized', async () => {
  const pendingArgs = (orderIds: string[]): Record<string, unknown> => ({
    source: 'pending_orders',
    orderIds,
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });

  for (const bad of [-1.5, -5]) {
    const db = open();
    findRow(db, 'products', 'products|lamp').quantity = bad;
    seedOrder(db, 'orders|o1', 'users|buyer', 'users|seller', 'pending_payment', [lampItem(1)]);
    assert.equal(
      failCode(await quote(db, 'clerk_buyer', pendingArgs(['orders|o1']))),
      'malformed_catalog',
      `stock ${bad} must be malformed`,
    );
  }

  const variant = open();
  findRow(variant, 'products', 'products|shirt').variantCombinations = [
    { id: 'c1', sku: 'SH-1', attributes: [{ name: 'Color', value: 'Red' }], price: 30, stock: -2, status: 'active' },
  ];
  seedCartLine(variant, 'products|shirt', 1, {
    selectedVariant: { variantId: 'c1', sku: 'SH-1', attributes: [], price: 30 },
  });
  assert.equal(failCode(await quote(variant, 'clerk_buyer', cartArgs())), 'malformed_catalog');

  const option = open(false);
  option.tables.products?.push(
    productRow('products|optneg', 'users|seller', {
      price: 10,
      quantity: 10,
      variants: [{ name: 'Size', options: [{ value: 'S', quantity: -1 }] }],
      shippingOptions: [{ name: 'Free', price: 0 }],
    }),
  );
  seedCartLine(option, 'products|optneg', 1, {
    selectedShipping: { name: 'Free', price: 0 },
    selectedVariantOptions: [{ name: 'Size', value: 'S' }],
  });
  assert.equal(
    failCode(await quote(option, 'clerk_buyer', { source: 'cart', shippingAddress: ADDRESS })),
    'malformed_catalog',
  );

  const zeroed = open();
  findRow(zeroed, 'products', 'products|lamp').quantity = 0;
  seedOrder(zeroed, 'orders|o1', 'users|buyer', 'users|seller', 'pending_payment', [lampItem(1)]);
  assert.equal(okQuote(await quote(zeroed, 'clerk_buyer', pendingArgs(['orders|o1']))).subtotalCents, 10000);
});

test('a changed shipping address moves the identity and requires fresh review', async () => {
  const db = open();
  seedCartLine(db, 'products|lamp', 1);

  const first = okQuote(await quote(db, 'clerk_buyer', cartArgs()));
  const changed = { ...ADDRESS, street: '  456 Changed Ave  ' };
  const before = snapshot(db);
  const replay = await quote(
    db,
    'clerk_buyer',
    cartArgs({ shippingAddress: changed, expectedQuoteKey: first.quoteKey }),
  );
  if (replay.ok) {
    throw new Error('expected a quote_mismatch when the address changes');
  }
  assert.equal(replay.code, 'quote_mismatch');
  assert.notEqual(replay.quote?.inputIdentity, first.inputIdentity);
  assert.notEqual(replay.quote?.quoteKey, first.quoteKey);
  assert.deepEqual(replay.quote?.shippingAddress, { ...ADDRESS, street: '456 Changed Ave' });
  assert.deepEqual(first.shippingAddress, ADDRESS);
  assert.deepEqual(db.tables, before);
});

test('compensating component price moves keep money but require fresh review', async () => {
  const db = open(false);
  db.tables.products?.push(
    productRow('products|kit', 'users|seller', {
      price: 10,
      quantity: 10,
      weightKg: 0,
      addOns: [{ name: 'Wrap', price: 1, isRequired: false }],
      shippingOptions: [{ name: 'Free', price: 0 }],
    }),
  );
  seedCartLine(db, 'products|kit', 1, {
    selectedShipping: { name: 'Free', price: 0 },
    selectedAddOns: [{ name: 'Wrap', price: 1 }],
  });
  const noMethod = { source: 'cart', shippingAddress: ADDRESS };

  const first = okQuote(await quote(db, 'clerk_buyer', noMethod));
  assert.equal(first.subtotalCents, 1100);

  findRow(db, 'products', 'products|kit').price = 9;
  findRow(db, 'products', 'products|kit').addOns = [{ name: 'Wrap', price: 2, isRequired: false }];
  const second = okQuote(await quote(db, 'clerk_buyer', noMethod));
  assert.equal(second.subtotalCents, 1100);
  assert.equal(second.totalAmountCents, first.totalAmountCents);
  assert.equal(second.inputIdentity, first.inputIdentity);
  assert.notEqual(second.quoteKey, first.quoteKey);
  assert.equal(second.lines[0]?.baseCents, 900);
  assert.deepEqual(second.lines[0]?.addOns, [{ name: 'Wrap', priceCents: 200 }]);

  const replay = await quote(db, 'clerk_buyer', { ...noMethod, expectedQuoteKey: first.quoteKey });
  if (replay.ok) {
    throw new Error('expected a quote_mismatch when component prices compensate');
  }
  assert.equal(replay.code, 'quote_mismatch');
  assert.equal(replay.quote?.quoteKey, second.quoteKey);
});

test('a changed fallback shipping choice moves the identity and the priced key', async () => {
  const db = open(false);
  findRow(db, 'products', 'products|lamp').shippingOptions = [
    { name: 'A', price: 1 },
    { name: 'B', price: 1 },
  ];
  const rowId = seedCartLine(db, 'products|lamp', 1, { selectedShipping: { name: 'A', price: 1 } });
  const noMethod = { source: 'cart', shippingAddress: ADDRESS };

  const first = okQuote(await quote(db, 'clerk_buyer', noMethod));
  assert.deepEqual(first.lines[0]?.fallbackShipping, { name: 'A', priceCents: 100 });

  findRow(db, 'cartItems', rowId).selectedShipping = { name: 'B', price: 1 };
  const before = snapshot(db);
  const second = okQuote(await quote(db, 'clerk_buyer', noMethod));
  assert.deepEqual(second.lines[0]?.fallbackShipping, { name: 'B', priceCents: 100 });
  assert.notEqual(second.inputIdentity, first.inputIdentity);
  assert.notEqual(second.quoteKey, first.quoteKey);

  const replay = await quote(db, 'clerk_buyer', { ...noMethod, expectedQuoteKey: first.quoteKey });
  if (replay.ok) {
    throw new Error('expected a quote_mismatch when the fallback choice changes');
  }
  assert.equal(replay.code, 'quote_mismatch');
  assert.deepEqual(db.tables, before);
});

test('pending fallback lines surface the canonical default shipping choice', async () => {
  const db = open(false);
  seedOrder(db, 'orders|o1', 'users|buyer', 'users|seller', 'pending_payment', [lampItem(1)]);

  const priced = okQuote(
    await quote(db, 'clerk_buyer', { source: 'pending_orders', orderIds: ['orders|o1'], shippingAddress: ADDRESS }),
  );
  assert.equal(priced.shippingCents, 5000);
  assert.deepEqual(priced.lines[0]?.fallbackShipping, { name: 'Courier', priceCents: 5000 });
});

test('identical customized rows quote identically regardless of row order', async () => {
  const firstDb = open(false);
  seedCartLine(firstDb, 'products|lamp', 1);
  seedCartLine(firstDb, 'products|lamp', 1);
  const noMethod = { source: 'cart', shippingAddress: ADDRESS };
  const first = okQuote(await quote(firstDb, 'clerk_buyer', noMethod));

  const secondDb = open(false);
  seedCartLine(secondDb, 'products|lamp', 1);
  seedCartLine(secondDb, 'products|lamp', 1);
  secondDb.tables.cartItems?.reverse();
  const second = okQuote(await quote(secondDb, 'clerk_buyer', noMethod));

  assert.equal(first.lines.length, 2);
  assert.equal(second.lines.length, 2);
  assert.equal(first.inputIdentity, second.inputIdentity);
  assert.equal(first.quoteKey, second.quoteKey);
  assert.deepEqual(
    first.lines.map((line) => line.cartItemId),
    second.lines.map((line) => line.cartItemId),
  );
});

test('pending quotes are identical regardless of order selector order', async () => {
  const db = open();
  seedOrder(db, 'orders|o1', 'users|buyer', 'users|seller', 'pending_payment', [lampItem(1)]);
  seedOrder(db, 'orders|o2', 'users|buyer', 'users|seller', 'pending_payment', [lampItem(1)]);
  const args = (orderIds: string[]): Record<string, unknown> => ({
    source: 'pending_orders',
    orderIds,
    deliveryMethodId: 'deliveryMethods|m1',
    shippingAddress: ADDRESS,
  });

  const first = okQuote(await quote(db, 'clerk_buyer', args(['orders|o1', 'orders|o2'])));
  const second = okQuote(await quote(db, 'clerk_buyer', args(['orders|o2', 'orders|o1'])));
  assert.equal(first.inputIdentity, second.inputIdentity);
  assert.equal(first.quoteKey, second.quoteKey);
});

test('an explicit method with no eligible methods is denied, not replaced', async () => {
  const db = open(false);
  db.tables.deliveryMethods?.push({
    _id: 'deliveryMethods|foreign',
    zoneId: 'deliveryZones|foreign',
    name: 'Foreign',
    code: 'F',
    type: 'standard',
    baseFee: 999,
    minDays: 1,
    maxDays: 1,
    isActive: true,
    createdAt: 1,
    updatedAt: 1,
  });
  seedCartLine(db, 'products|lamp', 1);
  const before = snapshot(db);

  assert.equal(
    failCode(
      await quote(db, 'clerk_buyer', {
        source: 'cart',
        shippingAddress: ADDRESS,
        deliveryMethodId: 'deliveryMethods|foreign',
      }),
    ),
    'invalid_delivery',
  );
  assert.deepEqual(db.tables, before);
});

test('an unprojectable major total is denied with no writes', async () => {
  const db = open(false);
  db.tables.products?.push(
    productRow('products|huge', 'users|seller', {
      price: 80000000000003,
      quantity: 10,
      weightKg: 0,
      shippingOptions: [
        { name: 'A', price: 1 },
        { name: 'B', price: 1 },
      ],
    }),
  );
  seedCartLine(db, 'products|huge', 1, { selectedShipping: { name: 'A', price: 1 } });
  const before = snapshot(db);
  assert.equal(
    failCode(await quote(db, 'clerk_buyer', { source: 'cart', shippingAddress: ADDRESS })),
    'malformed_money',
  );
  assert.deepEqual(db.tables, before);

  const valid = open(false);
  valid.tables.products?.push(
    productRow('products|big', 'users|seller', {
      price: 80000000000000,
      quantity: 10,
      weightKg: 0,
      shippingOptions: [
        { name: 'A', price: 1 },
        { name: 'B', price: 1 },
      ],
    }),
  );
  seedCartLine(valid, 'products|big', 1, { selectedShipping: { name: 'A', price: 1 } });
  const priced = okQuote(await quote(valid, 'clerk_buyer', { source: 'cart', shippingAddress: ADDRESS }));
  assert.equal(priced.subtotalCents, 8000000000000000);
  assert.equal(priced.totalAmountCents, 8400000000000100);
});

test('pending option caps are enforced without topping up owned quantities', async () => {
  const cappedArgs = { source: 'cart', shippingAddress: ADDRESS };
  const pendingArgs = { source: 'pending_orders', orderIds: ['orders|o1'], shippingAddress: ADDRESS };
  const optionLine = { selectedVariantOptions: [{ name: 'Size', value: 'S' }] };

  const cartDb = open(false);
  cartDb.tables.products?.push(
    productRow('products|capped', 'users|seller', {
      price: 10,
      quantity: 10,
      weightKg: 0,
      variants: [{ name: 'Size', options: [{ value: 'S', quantity: 2 }] }],
      shippingOptions: [{ name: 'Free', price: 0 }],
    }),
  );
  seedCartLine(cartDb, 'products|capped', 3, { selectedShipping: { name: 'Free', price: 0 }, ...optionLine });
  assert.equal(failCode(await quote(cartDb, 'clerk_buyer', cappedArgs)), 'insufficient_stock');

  const pendingDb = open(false);
  pendingDb.tables.products?.push(
    productRow('products|capped', 'users|seller', {
      price: 10,
      quantity: 10,
      weightKg: 0,
      variants: [{ name: 'Size', options: [{ value: 'S', quantity: 2 }] }],
      shippingOptions: [{ name: 'Free', price: 0 }],
    }),
  );
  seedOrder(pendingDb, 'orders|o1', 'users|buyer', 'users|seller', 'pending_payment', [
    {
      productId: 'products|capped',
      title: 't',
      price: 0.01,
      quantity: 3,
      image: 'https://images.invalid/x.jpg',
      ...optionLine,
    },
  ]);
  assert.equal(failCode(await quote(pendingDb, 'clerk_buyer', pendingArgs)), 'insufficient_stock');

  const fitting = open(false);
  fitting.tables.products?.push(
    productRow('products|capped', 'users|seller', {
      price: 10,
      quantity: 10,
      weightKg: 0,
      variants: [{ name: 'Size', options: [{ value: 'S', quantity: 2 }] }],
      shippingOptions: [{ name: 'Free', price: 0 }],
    }),
  );
  seedOrder(fitting, 'orders|o1', 'users|buyer', 'users|seller', 'pending_payment', [
    {
      productId: 'products|capped',
      title: 't',
      price: 0.01,
      quantity: 2,
      image: 'https://images.invalid/x.jpg',
      ...optionLine,
    },
  ]);
  assert.equal(okQuote(await quote(fitting, 'clerk_buyer', pendingArgs)).subtotalCents, 2000);
});

test('a deleted seller denies the quote under the existing seller policy', async () => {
  const db = open();
  seedCartLine(db, 'products|lamp', 1);
  findRow(db, 'users', 'users|seller').deletedAt = 1;

  assert.equal(failCode(await quote(db, 'clerk_buyer', cartArgs())), 'unavailable');
});

// ---- Round-2 correction: the priced key approves the complete canonical snapshot ----

test('a canonical variant attribute change requires fresh review at equal money', async () => {
  const db = open();
  seedCartLine(db, 'products|shirt', 1, {
    selectedVariant: { variantId: 'c1', sku: 'SH-1', attributes: [], price: 999 },
  });

  const first = okQuote(await quote(db, 'clerk_buyer', cartArgs()));
  assert.deepEqual(first.lines[0]?.variant?.attributes, [{ name: 'Color', value: 'Red' }]);

  findRow(db, 'products', 'products|shirt').variantCombinations = [
    { id: 'c1', sku: 'SH-1', attributes: [{ name: 'Color', value: 'Blue' }], price: 30, stock: 5, status: 'active' },
  ];
  const before = snapshot(db);
  const second = okQuote(await quote(db, 'clerk_buyer', cartArgs()));
  assert.deepEqual(second.lines[0]?.variant?.attributes, [{ name: 'Color', value: 'Blue' }]);
  assert.equal(second.subtotalCents, first.subtotalCents);
  assert.equal(second.totalAmountCents, first.totalAmountCents);
  assert.equal(second.inputIdentity, first.inputIdentity);
  assert.notEqual(second.quoteKey, first.quoteKey);

  const replay = await quote(db, 'clerk_buyer', cartArgs({ expectedQuoteKey: first.quoteKey }));
  if (replay.ok) {
    throw new Error('expected a quote_mismatch when variant attributes change');
  }
  assert.equal(replay.code, 'quote_mismatch');
  assert.equal(replay.quote?.quoteKey, second.quoteKey);
  assert.deepEqual(replay.quote?.lines[0]?.variant?.attributes, [{ name: 'Color', value: 'Blue' }]);
  assert.deepEqual(db.tables, before);
});

test('a product title change requires fresh review at equal money', async () => {
  const db = open();
  seedCartLine(db, 'products|lamp', 1);

  const first = okQuote(await quote(db, 'clerk_buyer', cartArgs()));
  assert.equal(first.lines[0]?.title, 'Title products|lamp');

  findRow(db, 'products', 'products|lamp').title = 'Title products|lamp Renamed';
  const before = snapshot(db);
  const second = okQuote(await quote(db, 'clerk_buyer', cartArgs()));
  assert.equal(second.lines[0]?.title, 'Title products|lamp Renamed');
  assert.equal(second.subtotalCents, first.subtotalCents);
  assert.equal(second.totalAmountCents, first.totalAmountCents);
  assert.equal(second.inputIdentity, first.inputIdentity);
  assert.notEqual(second.quoteKey, first.quoteKey);

  const replay = await quote(db, 'clerk_buyer', cartArgs({ expectedQuoteKey: first.quoteKey }));
  if (replay.ok) {
    throw new Error('expected a quote_mismatch when the product title changes');
  }
  assert.equal(replay.code, 'quote_mismatch');
  assert.equal(replay.quote?.quoteKey, second.quoteKey);
  assert.equal(replay.quote?.lines[0]?.title, 'Title products|lamp Renamed');
  assert.deepEqual(db.tables, before);
});

test('a product image change requires fresh review, including the variant fallback', async () => {
  const db = open();
  seedCartLine(db, 'products|lamp', 1);

  const first = okQuote(await quote(db, 'clerk_buyer', cartArgs()));
  assert.equal(first.lines[0]?.image, 'https://images.invalid/x.jpg');

  findRow(db, 'products', 'products|lamp').images = ['https://images.invalid/changed.jpg'];
  const before = snapshot(db);
  const second = okQuote(await quote(db, 'clerk_buyer', cartArgs()));
  assert.equal(second.lines[0]?.image, 'https://images.invalid/changed.jpg');
  assert.equal(second.subtotalCents, first.subtotalCents);
  assert.equal(second.inputIdentity, first.inputIdentity);
  assert.notEqual(second.quoteKey, first.quoteKey);

  const replay = await quote(db, 'clerk_buyer', cartArgs({ expectedQuoteKey: first.quoteKey }));
  if (replay.ok) {
    throw new Error('expected a quote_mismatch when the product image changes');
  }
  assert.equal(replay.code, 'quote_mismatch');
  assert.equal(replay.quote?.quoteKey, second.quoteKey);
  assert.equal(replay.quote?.lines[0]?.image, 'https://images.invalid/changed.jpg');
  assert.deepEqual(db.tables, before);

  const variantDb = open();
  seedCartLine(variantDb, 'products|shirt', 1, {
    selectedVariant: { variantId: 'c1', sku: 'SH-1', attributes: [], price: 30 },
  });
  const variantFirst = okQuote(await quote(variantDb, 'clerk_buyer', cartArgs()));
  assert.equal(variantFirst.lines[0]?.variant?.image, undefined);
  assert.equal(variantFirst.lines[0]?.image, 'https://images.invalid/x.jpg');

  findRow(variantDb, 'products', 'products|shirt').images = ['https://images.invalid/shirt-changed.jpg'];
  const variantBefore = snapshot(variantDb);
  const variantSecond = okQuote(await quote(variantDb, 'clerk_buyer', cartArgs()));
  assert.equal(variantSecond.lines[0]?.image, 'https://images.invalid/shirt-changed.jpg');
  assert.equal(variantSecond.subtotalCents, variantFirst.subtotalCents);
  assert.equal(variantSecond.inputIdentity, variantFirst.inputIdentity);
  assert.notEqual(variantSecond.quoteKey, variantFirst.quoteKey);

  const variantReplay = await quote(variantDb, 'clerk_buyer', cartArgs({ expectedQuoteKey: variantFirst.quoteKey }));
  if (variantReplay.ok) {
    throw new Error('expected a quote_mismatch when the fallback product image changes');
  }
  assert.equal(variantReplay.code, 'quote_mismatch');
  assert.equal(variantReplay.quote?.quoteKey, variantSecond.quoteKey);
  assert.deepEqual(variantDb.tables, variantBefore);
});
