import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addOrderTrackingEvent,
  getOrderReturnRequests,
  getOrderTrackingEvents,
  getReturnRequests,
  requestReturn,
  reviewReturnRequest,
} from './delivery';
import { upsertNotificationCampaign } from './notifications';
import {
  addTrackingInfo,
  confirmDelivery,
  getManagedCatalogOrders,
  getOrder,
  getOrderByNumber,
  getSellerOrders,
  markAsShipped,
  updateOrderStatus,
} from './orders';
import {
  createProduct,
  deleteProduct,
  getManagedCatalogProducts,
  getMyListings,
  getProduct,
  getProductsBySeller,
  markAsSold,
  submitForReview,
  updateProduct,
} from './products';
import { getTransactionStats } from './transactions';
import { anonymizeDeletedUserByClerkId, getUserByClerkId, upsertUser, upsertUserFromClerkWebhook } from './users';
import { getMyVendorProfile, getVendorStorefront, submitApplication } from './vendors';
import { getWallet } from './wallet';
import {
  createCtx,
  createDb,
  handlerOf,
  type Db,
  type Handler,
  type Row,
  type Tables,
} from '../tests/support/convexFakeDb';

const usersOf = (db: Db) => db.tables.users ?? [];

const admin = { _id: 'users|admin', clerkId: 'clerk_admin', role: 'admin', isBanned: false, email: 'a@x' };
const buyer = { _id: 'users|buyer', clerkId: 'clerk_buyer', role: 'user', isBanned: false, email: 'b@x' };
const targetWallet = { _id: 'wallets|buyer', userId: 'users|buyer', isFrozen: false, balance: 10 };
const adminWallet = { _id: 'wallets|admin', userId: 'users|admin', isFrozen: false, balance: 99 };

const campaignDetails = {
  name: 'Recommendation campaign',
  type: 'product_recommendation' as const,
  status: 'draft' as const,
  audienceSegment: 'all_opted_in' as const,
  title: 'Recommendations',
  message: 'Browse recommended products',
  channels: ['in_app' as const],
  isAutomatic: false,
};

const campaignInput = { adminId: 'users|buyer', ...campaignDetails };

test('campaign creation records the authenticated admin despite a supplied customer ID', async () => {
  const db = createDb({ users: [admin, buyer] });
  const saveCampaign = handlerOf<typeof campaignInput, string>(upsertNotificationCampaign);

  const campaignId = await saveCampaign(createCtx(db, 'clerk_admin'), campaignInput);
  const stored = db.tables.notificationCampaigns?.find((row) => row._id === campaignId);

  assert.ok(stored);
  assert.equal(stored.createdByUserId, 'users|admin');
});

test('a customer cannot create a campaign by supplying an admin ID', async () => {
  const db = createDb({ users: [admin, buyer] });
  const saveCampaign = handlerOf<typeof campaignInput, string>(upsertNotificationCampaign);

  await assert.rejects(
    saveCampaign(createCtx(db, 'clerk_buyer'), { ...campaignInput, adminId: 'users|admin' }),
    /Unauthorized/,
  );
  assert.equal(db.tables.notificationCampaigns?.length ?? 0, 0);
});

test('campaign updates preserve the original creator', async () => {
  const existing = {
    _id: 'notificationCampaigns|existing',
    ...campaignDetails,
    maxPerUserPerDay: 3,
    createdByUserId: 'users|buyer',
    createdAt: 1,
    updatedAt: 1,
  };
  const db = createDb({ users: [admin, buyer], notificationCampaigns: [existing] });
  const saveCampaign = handlerOf<typeof campaignInput & { campaignId: string }, Row>(upsertNotificationCampaign);

  const saved = await saveCampaign(createCtx(db, 'clerk_admin'), {
    ...campaignInput,
    campaignId: 'notificationCampaigns|existing',
    name: 'Updated recommendations',
  });

  assert.equal(saved.name, 'Updated recommendations');
  assert.equal(saved.createdByUserId, 'users|buyer');
  assert.equal(saved.createdAt, 1);
  assert.equal(db.tables.notificationCampaigns?.length, 1);
});

test('an admin reading a customer wallet gets the customer wallet, not their own', async () => {
  const db = createDb({ users: [admin, buyer], wallets: [targetWallet, adminWallet] });
  const getWalletHandler = handlerOf<{ userId: string }, { _id: string } | null>(getWallet);
  const wallet = await getWalletHandler(createCtx(db, 'clerk_admin'), { userId: 'users|buyer' });
  assert.equal(wallet?._id, 'wallets|buyer');
});

test('a customer cannot read another customer wallet', async () => {
  const db = createDb({ users: [admin, buyer], wallets: [targetWallet, adminWallet] });
  const getWalletHandler = handlerOf<{ userId: string }, unknown>(getWallet);
  await assert.rejects(getWalletHandler(createCtx(db, 'clerk_buyer'), { userId: 'users|admin' }), /Unauthorized/);
});

const anonymize = handlerOf<{ clerkId: string }, unknown>(anonymizeDeletedUserByClerkId);

test('a deleted account cannot be recreated by a valid token or a late webhook', async () => {
  const db = createDb({ users: [buyer] });
  await anonymize(createCtx(db, null), { clerkId: 'clerk_buyer' });

  const usersBefore = usersOf(db).length;
  const upsertHandler = handlerOf<Record<string, unknown>, unknown>(upsertUser);
  await assert.rejects(
    upsertHandler(createCtx(db, 'clerk_buyer'), { email: 'new@x', firstName: 'New', lastName: 'Person' }),
    /Account is deleted/,
  );

  const webhookHandler = handlerOf<Record<string, unknown>, unknown>(upsertUserFromClerkWebhook);
  const result = await webhookHandler(createCtx(db, null), {
    clerkId: 'clerk_buyer',
    email: 'new@x',
    firstName: 'New',
    lastName: 'Person',
  });
  assert.equal(result, null);

  assert.equal(usersOf(db).length, usersBefore);
  const deleted = usersOf(db)[0];
  assert.ok(deleted);
  assert.equal(deleted.clerkId, 'clerk_buyer');
  assert.equal(deleted.firstName, 'Deleted');
  assert.notEqual(deleted.deletedAt, undefined);
});

test('accounts deleted under the old deleted: prefix are still refused', async () => {
  const legacy = { ...buyer, clerkId: 'deleted:clerk_buyer', deletedAt: 1, isBanned: true };
  const db = createDb({ users: [legacy] });
  const upsertHandler = handlerOf<Record<string, unknown>, unknown>(upsertUser);
  await assert.rejects(
    upsertHandler(createCtx(db, 'clerk_buyer'), { email: 'new@x', firstName: 'New', lastName: 'Person' }),
    /Account is deleted/,
  );
  assert.equal(usersOf(db).length, 1);
});

test('the current-user lookup returns only the signed-in subject and hides deleted accounts', async () => {
  const db = createDb({ users: [admin, buyer] });
  const lookup = handlerOf<{ clerkId: string }, { _id: string } | null>(getUserByClerkId);

  assert.equal(await lookup(createCtx(db, null), { clerkId: 'clerk_buyer' }), null);
  assert.equal(await lookup(createCtx(db, 'clerk_admin'), { clerkId: 'clerk_buyer' }), null);
  assert.equal((await lookup(createCtx(db, 'clerk_buyer'), { clerkId: 'clerk_buyer' }))?._id, 'users|buyer');

  await anonymize(createCtx(db, null), { clerkId: 'clerk_buyer' });
  assert.equal(await lookup(createCtx(db, 'clerk_buyer'), { clerkId: 'clerk_buyer' }), null);
});

test('a deletion marker wins over an active duplicate created before the fix', async () => {
  const legacy = { _id: 'users|legacy', clerkId: 'deleted:clerk_buyer', deletedAt: 1, isBanned: true, role: 'user' };
  const duplicate = { ...buyer, _id: 'users|duplicate' };
  const db = createDb({ users: [legacy, duplicate] });

  const getWalletHandler = handlerOf<{ userId: string }, unknown>(getWallet);
  await assert.rejects(
    getWalletHandler(createCtx(db, 'clerk_buyer'), { userId: 'users|duplicate' }),
    /Account is deleted/,
  );

  const lookup = handlerOf<{ clerkId: string }, unknown>(getUserByClerkId);
  assert.equal(await lookup(createCtx(db, 'clerk_buyer'), { clerkId: 'clerk_buyer' }), null);

  const upsertHandler = handlerOf<Record<string, unknown>, unknown>(upsertUser);
  await assert.rejects(
    upsertHandler(createCtx(db, 'clerk_buyer'), { email: 'new@x', firstName: 'New', lastName: 'Person' }),
    /Account is deleted/,
  );
});

test('a deletion that arrives before the first sync blocks later sync and creation', async () => {
  const db = createDb({ users: [] });
  const anonymizeHandler = handlerOf<{ clerkId: string }, { status: string }>(anonymizeDeletedUserByClerkId);
  assert.deepEqual(await anonymizeHandler(createCtx(db, null), { clerkId: 'clerk_new' }), { status: 'tombstoned' });

  const upsertHandler = handlerOf<Record<string, unknown>, unknown>(upsertUser);
  await assert.rejects(
    upsertHandler(createCtx(db, 'clerk_new'), { email: 'new@x', firstName: 'New', lastName: 'Person' }),
    /Account is deleted/,
  );

  const webhookHandler = handlerOf<Record<string, unknown>, unknown>(upsertUserFromClerkWebhook);
  assert.equal(
    await webhookHandler(createCtx(db, null), { clerkId: 'clerk_new', email: 'new@x', firstName: 'N', lastName: 'P' }),
    null,
  );
  assert.equal(usersOf(db).length, 1);
  assert.equal(usersOf(db)[0]?.firstName, 'Deleted');
});

test('a customer cannot pass an admin ID to act as that admin', async () => {
  const db = createDb({ users: [admin, buyer], transactions: [] });
  const statsHandler = handlerOf<{ adminId: string }, unknown>(getTransactionStats);
  await assert.rejects(statsHandler(createCtx(db, 'clerk_buyer'), { adminId: 'users|admin' }), /Unauthorized/);
});

test('an admin token still reads admin statistics', async () => {
  const db = createDb({ users: [admin, buyer], transactions: [] });
  const statsHandler = handlerOf<{ adminId: string }, { total: number }>(getTransactionStats);
  const stats = await statsHandler(createCtx(db, 'clerk_admin'), { adminId: 'users|buyer' });
  assert.equal(stats.total, 0);
});

test('only the order buyer, from their token, can confirm delivery', async () => {
  const other = { _id: 'users|other', clerkId: 'clerk_other', role: 'user', isBanned: false, email: 'o@x' };
  const order = { _id: 'orders|1', buyerId: 'users|buyer', status: 'shipped' };
  const db = createDb({ users: [admin, buyer, other], orders: [order] });
  const confirmHandler = handlerOf<{ orderId: string }, { status: string } | null>(confirmDelivery);

  await assert.rejects(confirmHandler(createCtx(db, 'clerk_other'), { orderId: 'orders|1' }), /Unauthorized/);
  assert.equal(db.tables.orders?.[0]?.status, 'shipped');

  const confirmed = await confirmHandler(createCtx(db, 'clerk_buyer'), { orderId: 'orders|1' });
  assert.equal(confirmed?.status, 'delivered');
});

// Order and seller-permission fixtures. Caller-supplied `userId`/`sellerId` values are passed
// in the handler arguments below only to prove they never grant authority.
const seller = { _id: 'users|seller', clerkId: 'clerk_seller', role: 'user', isBanned: false, email: 's@x' };
const outsider = { _id: 'users|outsider', clerkId: 'clerk_outsider', role: 'user', isBanned: false, email: 'x@x' };
const catalogManager = { _id: 'users|catalog', clerkId: 'clerk_catalog', role: 'catalog_manager', isBanned: false };
const companySeller = { _id: 'users|company', clerkId: 'clerk_company', role: 'user', isBanned: false };
const bannedSeller = { _id: 'users|banned', clerkId: 'clerk_banned', role: 'user', isBanned: true };
const deletedSeller = { _id: 'users|gone', clerkId: 'clerk_gone', role: 'user', isBanned: false, deletedAt: 1 };
const platformSettings = {
  _id: 'platformSettings|1',
  key: 'singleton',
  companySellerUserId: 'users|company',
  companyDisplayName: 'Gettitonline',
};
const orderUsers = [admin, buyer, seller, outsider, catalogManager, companySeller, bannedSeller, deletedSeller];

function orderRow(overrides: Record<string, unknown> = {}) {
  return { _id: 'orders|1', buyerId: 'users|buyer', sellerId: 'users|seller', status: 'paid', ...overrides };
}

type StatusArgs = { orderId: string; status: string; userId?: string };
type SellerArgs = { orderId: string; sellerId?: string; trackingNumber?: string; shippingCarrier?: string };

test("a customer cannot move someone else's order by passing the seller ID", async () => {
  const db = createDb({ users: orderUsers, platformSettings: [platformSettings], orders: [orderRow()] });
  const updateHandler = handlerOf<StatusArgs, unknown>(updateOrderStatus);

  await assert.rejects(
    updateHandler(createCtx(db, 'clerk_outsider'), {
      orderId: 'orders|1',
      status: 'processing',
      userId: 'users|seller',
    }),
    /Cannot transition/,
  );
  assert.equal(db.tables.orders?.[0]?.status, 'paid');
});

test('a buyer passing the seller ID cannot mark a paid order as processing', async () => {
  const db = createDb({ users: orderUsers, platformSettings: [platformSettings], orders: [orderRow()] });
  const updateHandler = handlerOf<StatusArgs, unknown>(updateOrderStatus);

  await assert.rejects(
    updateHandler(createCtx(db, 'clerk_buyer'), { orderId: 'orders|1', status: 'processing', userId: 'users|seller' }),
    /Cannot transition/,
  );
  assert.equal(db.tables.orders?.[0]?.status, 'paid');
});

test('a customer passing an admin ID cannot moderate a disputed order', async () => {
  const db = createDb({
    users: orderUsers,
    platformSettings: [platformSettings],
    orders: [orderRow({ status: 'disputed' })],
  });
  const updateHandler = handlerOf<StatusArgs, unknown>(updateOrderStatus);

  await assert.rejects(
    updateHandler(createCtx(db, 'clerk_outsider'), { orderId: 'orders|1', status: 'cancelled', userId: 'users|admin' }),
    /Cannot transition/,
  );
  assert.equal(db.tables.orders?.[0]?.status, 'disputed');
});

test('the seller can mark their paid order as processing', async () => {
  const db = createDb({ users: orderUsers, platformSettings: [platformSettings], orders: [orderRow()] });
  const updateHandler = handlerOf<StatusArgs, { status: string } | null>(updateOrderStatus);

  const updated = await updateHandler(createCtx(db, 'clerk_seller'), { orderId: 'orders|1', status: 'processing' });
  assert.equal(updated?.status, 'processing');
});

test('an admin cannot cancel a disputed order through the order status, because the dispute flow decides it', async () => {
  const db = createDb({
    users: orderUsers,
    platformSettings: [platformSettings],
    orders: [orderRow({ status: 'disputed' })],
  });
  const updateHandler = handlerOf<StatusArgs, { status: string } | null>(updateOrderStatus);

  await assert.rejects(
    updateHandler(createCtx(db, 'clerk_admin'), { orderId: 'orders|1', status: 'cancelled' }),
    /Cannot transition/,
  );
  assert.equal(db.tables.orders?.[0]?.status, 'disputed');
});

test('a catalog manager acts for the company seller account but not for other sellers', async () => {
  const db = createDb({
    users: orderUsers,
    platformSettings: [platformSettings],
    orders: [orderRow({ _id: 'orders|company', sellerId: 'users|company' }), orderRow({ _id: 'orders|other' })],
  });
  const updateHandler = handlerOf<StatusArgs, { status: string } | null>(updateOrderStatus);

  const updated = await updateHandler(createCtx(db, 'clerk_catalog'), {
    orderId: 'orders|company',
    status: 'processing',
  });
  assert.equal(updated?.status, 'processing');

  await assert.rejects(
    updateHandler(createCtx(db, 'clerk_catalog'), { orderId: 'orders|other', status: 'processing' }),
    /Cannot transition/,
  );
});

test('banned, deleted, anonymous, and unknown callers are refused before any order change', async () => {
  const db = createDb({
    users: orderUsers,
    platformSettings: [platformSettings],
    orders: [orderRow({ sellerId: 'users|banned' }), orderRow({ _id: 'orders|2', sellerId: 'users|gone' })],
  });
  const updateHandler = handlerOf<StatusArgs, unknown>(updateOrderStatus);

  await assert.rejects(
    updateHandler(createCtx(db, 'clerk_banned'), { orderId: 'orders|1', status: 'processing' }),
    /Account is banned/,
  );
  await assert.rejects(
    updateHandler(createCtx(db, 'clerk_gone'), { orderId: 'orders|2', status: 'processing' }),
    /Account is deleted/,
  );
  await assert.rejects(
    updateHandler(createCtx(db, null), { orderId: 'orders|1', status: 'processing' }),
    /Unauthenticated/,
  );
  await assert.rejects(
    updateHandler(createCtx(db, 'clerk_ghost'), { orderId: 'orders|1', status: 'processing' }),
    /Account not found/,
  );
  assert.equal(db.tables.orders?.[0]?.status, 'paid');
});

test("a customer passing the seller ID cannot add tracking to someone else's order", async () => {
  const db = createDb({ users: orderUsers, platformSettings: [platformSettings], orders: [orderRow()] });
  const trackingHandler = handlerOf<SellerArgs, { trackingNumber?: string } | null>(addTrackingInfo);

  await assert.rejects(
    trackingHandler(createCtx(db, 'clerk_outsider'), {
      orderId: 'orders|1',
      sellerId: 'users|seller',
      trackingNumber: 'FAKE',
    }),
    /Unauthorized/,
  );
  assert.equal(db.tables.orders?.[0]?.trackingNumber, undefined);
});

test('an admin passing the seller ID cannot add tracking to a non-company seller order', async () => {
  const db = createDb({ users: orderUsers, platformSettings: [platformSettings], orders: [orderRow()] });
  const trackingHandler = handlerOf<SellerArgs, unknown>(addTrackingInfo);

  await assert.rejects(
    trackingHandler(createCtx(db, 'clerk_admin'), {
      orderId: 'orders|1',
      sellerId: 'users|seller',
      trackingNumber: 'FAKE',
    }),
    /Unauthorized/,
  );
  assert.equal(db.tables.orders?.[0]?.trackingNumber, undefined);
});

test('the seller can add tracking to their own order', async () => {
  const db = createDb({ users: orderUsers, platformSettings: [platformSettings], orders: [orderRow()] });
  const trackingHandler = handlerOf<SellerArgs, { trackingNumber?: string } | null>(addTrackingInfo);

  const updated = await trackingHandler(createCtx(db, 'clerk_seller'), { orderId: 'orders|1', trackingNumber: 'TRK1' });
  assert.equal(updated?.trackingNumber, 'TRK1');
});

test("a buyer passing the seller ID cannot mark someone else's order as shipped", async () => {
  const db = createDb({ users: orderUsers, platformSettings: [platformSettings], orders: [orderRow()] });
  const shipHandler = handlerOf<SellerArgs, unknown>(markAsShipped);

  await assert.rejects(
    shipHandler(createCtx(db, 'clerk_buyer'), {
      orderId: 'orders|1',
      sellerId: 'users|seller',
      trackingNumber: 'FAKE',
    }),
    /Unauthorized/,
  );
  assert.equal(db.tables.orders?.[0]?.status, 'paid');
});

test('the seller can mark their paid order as shipped', async () => {
  const db = createDb({ users: orderUsers, platformSettings: [platformSettings], orders: [orderRow()] });
  const shipHandler = handlerOf<SellerArgs, { status: string; trackingNumber?: string } | null>(markAsShipped);

  const shipped = await shipHandler(createCtx(db, 'clerk_seller'), { orderId: 'orders|1', trackingNumber: 'TRK2' });
  assert.equal(shipped?.status, 'shipped');
  assert.equal(shipped?.trackingNumber, 'TRK2');
});

// Delivery and return fixtures. Caller-supplied actor/viewer/buyer IDs are passed in the
// arguments below only to prove they never grant authority or set audit fields.
type TrackingArgs = { actorUserId?: string; orderId: string; status: string; message: string };
type ReturnRequestArgs = {
  buyerId?: string;
  orderId: string;
  reason: string;
  requestedItems: Array<{ productId: string; quantity: number }>;
  description: string;
};
type ReviewArgs = {
  actorUserId?: string;
  returnRequestId: string;
  status: string;
  resolution?: { type: string; amount?: number };
};
type ViewerArgs = { viewerUserId?: string; orderId?: string; status?: string };

const returnRequest = {
  _id: 'returnRequests|1',
  orderId: 'orders|1',
  buyerId: 'users|buyer',
  sellerId: 'users|seller',
  status: 'requested',
  reason: 'defective',
  requestedItems: [{ productId: 'products|1', quantity: 1 }],
  description: 'Arrived broken',
  createdAt: 1,
  updatedAt: 1,
};
const trackingEvent = {
  _id: 'orderTrackingEvents|1',
  orderId: 'orders|1',
  status: 'processing',
  message: 'Packed',
  createdByUserId: 'users|seller',
  occurredAt: 1,
  createdAt: 1,
};
const trackingInput = { orderId: 'orders|1', status: 'in_transit', message: 'Left the depot' };
const returnInput = { orderId: 'orders|1', reason: 'defective', requestedItems: [], description: 'Arrived broken' };
const reviewInput = { returnRequestId: 'returnRequests|1', status: 'approved' };

function deliveryDb(overrides: Tables = {}) {
  return createDb({
    users: orderUsers,
    platformSettings: [platformSettings],
    orders: [orderRow()],
    returnRequests: [returnRequest],
    orderTrackingEvents: [trackingEvent],
    ...overrides,
  });
}

test("a customer passing the seller ID cannot record a tracking event on someone else's order", async () => {
  const db = deliveryDb();
  const trackingHandler = handlerOf<TrackingArgs, unknown>(addOrderTrackingEvent);

  await assert.rejects(
    trackingHandler(createCtx(db, 'clerk_outsider'), { ...trackingInput, actorUserId: 'users|seller' }),
    /Unauthorized/,
  );
  assert.equal(db.tables.orderTrackingEvents?.length, 1);
  assert.equal(db.tables.notifications?.length ?? 0, 0);
});

test('the seller records a tracking event stamped with their own ID and notifies the buyer', async () => {
  const db = deliveryDb();
  const trackingHandler = handlerOf<TrackingArgs, string>(addOrderTrackingEvent);

  const eventId = await trackingHandler(createCtx(db, 'clerk_seller'), trackingInput);
  const recorded = db.tables.orderTrackingEvents?.[1];
  assert.equal(recorded?._id, eventId);
  assert.equal(recorded?.createdByUserId, 'users|seller');
  assert.equal(db.tables.notifications?.[0]?.userId, 'users|buyer');
});

test('the audit field records the verified admin, not a caller-supplied seller ID', async () => {
  const db = deliveryDb();
  const trackingHandler = handlerOf<TrackingArgs, string>(addOrderTrackingEvent);

  await trackingHandler(createCtx(db, 'clerk_admin'), { ...trackingInput, actorUserId: 'users|seller' });
  assert.equal(db.tables.orderTrackingEvents?.[1]?.createdByUserId, 'users|admin');
});

test('a catalog manager records tracking for the company order but not another seller order', async () => {
  const db = deliveryDb({ orders: [orderRow({ _id: 'orders|company', sellerId: 'users|company' }), orderRow()] });
  const trackingHandler = handlerOf<TrackingArgs, string>(addOrderTrackingEvent);

  await trackingHandler(createCtx(db, 'clerk_catalog'), { ...trackingInput, orderId: 'orders|company' });
  await assert.rejects(
    trackingHandler(createCtx(db, 'clerk_catalog'), { ...trackingInput, orderId: 'orders|1' }),
    /Unauthorized/,
  );
  assert.equal(db.tables.orderTrackingEvents?.length, 2);
});

test("a customer passing the buyer ID cannot request a return on someone else's order", async () => {
  const db = deliveryDb({ returnRequests: [] });
  const returnHandler = handlerOf<ReturnRequestArgs, string>(requestReturn);

  await assert.rejects(
    returnHandler(createCtx(db, 'clerk_outsider'), { ...returnInput, buyerId: 'users|buyer' }),
    /Order not found/,
  );
  assert.equal(db.tables.returnRequests?.length ?? 0, 0);
  assert.equal(db.tables.notifications?.length ?? 0, 0);
});

test('the buyer requests a return stamped with their own ID and notifies the seller', async () => {
  const db = deliveryDb({ returnRequests: [] });
  const returnHandler = handlerOf<ReturnRequestArgs, string>(requestReturn);

  await returnHandler(createCtx(db, 'clerk_buyer'), { ...returnInput, buyerId: 'users|outsider' });
  assert.equal(db.tables.returnRequests?.[0]?.buyerId, 'users|buyer');
  assert.equal(db.tables.returnRequests?.[0]?.sellerId, 'users|seller');
  assert.equal(db.tables.notifications?.[0]?.userId, 'users|seller');
});

test("a customer passing the seller ID cannot review someone else's return request", async () => {
  const db = deliveryDb();
  const reviewHandler = handlerOf<ReviewArgs, unknown>(reviewReturnRequest);

  await assert.rejects(
    reviewHandler(createCtx(db, 'clerk_outsider'), { ...reviewInput, actorUserId: 'users|seller' }),
    /Unauthorized/,
  );
  assert.equal(db.tables.returnRequests?.[0]?.status, 'requested');
  assert.equal(db.tables.notifications?.length ?? 0, 0);
});

test('the seller approves a return and the resolution records their own ID', async () => {
  const db = deliveryDb();
  const reviewHandler = handlerOf<ReviewArgs, { status: string; resolution?: { resolvedByUserId?: string } } | null>(
    reviewReturnRequest,
  );

  const reviewed = await reviewHandler(createCtx(db, 'clerk_seller'), {
    ...reviewInput,
    resolution: { type: 'refund', amount: 10 },
  });
  assert.equal(reviewed?.status, 'approved');
  assert.equal(reviewed?.resolution?.resolvedByUserId, 'users|seller');
  assert.equal(db.tables.notifications?.[0]?.userId, 'users|buyer');
});

test('a catalog manager reviews the company return request but not another seller return', async () => {
  const db = deliveryDb({
    orders: [orderRow({ _id: 'orders|company', sellerId: 'users|company' }), orderRow()],
    returnRequests: [
      { ...returnRequest, _id: 'returnRequests|company', orderId: 'orders|company', sellerId: 'users|company' },
      returnRequest,
    ],
  });
  const reviewHandler = handlerOf<ReviewArgs, { status: string } | null>(reviewReturnRequest);

  const reviewed = await reviewHandler(createCtx(db, 'clerk_catalog'), {
    returnRequestId: 'returnRequests|company',
    status: 'approved',
  });
  assert.equal(reviewed?.status, 'approved');
  await assert.rejects(
    reviewHandler(createCtx(db, 'clerk_catalog'), { returnRequestId: 'returnRequests|1', status: 'approved' }),
    /Unauthorized/,
  );
  assert.equal(db.tables.returnRequests?.[1]?.status, 'requested');
});

test('an outsider passing the admin ID cannot read another seller tracking events', async () => {
  const db = deliveryDb();
  const eventsHandler = handlerOf<ViewerArgs, unknown[]>(getOrderTrackingEvents);

  await assert.rejects(
    eventsHandler(createCtx(db, 'clerk_outsider'), { orderId: 'orders|1', viewerUserId: 'users|admin' }),
    /Unauthorized/,
  );
});

test('the buyer reads their order tracking events and an outsider cannot', async () => {
  const db = deliveryDb();
  const eventsHandler = handlerOf<ViewerArgs, Array<{ _id: string }>>(getOrderTrackingEvents);

  const events = await eventsHandler(createCtx(db, 'clerk_buyer'), { orderId: 'orders|1' });
  assert.deepEqual(
    events.map((event) => event._id),
    ['orderTrackingEvents|1'],
  );
  await assert.rejects(
    eventsHandler(createCtx(db, 'clerk_outsider'), { orderId: 'orders|1', viewerUserId: 'users|buyer' }),
    /Unauthorized/,
  );
});

test('an outsider passing the admin ID cannot list another seller return requests', async () => {
  const db = deliveryDb({
    returnRequests: [returnRequest, { ...returnRequest, _id: 'returnRequests|2', buyerId: 'users|other' }],
  });
  const listHandler = handlerOf<ViewerArgs, Array<{ _id: string }>>(getReturnRequests);

  const visible = await listHandler(createCtx(db, 'clerk_outsider'), { viewerUserId: 'users|admin' });
  assert.deepEqual(visible, []);
});

test('the seller sees only their return requests and an admin sees all of them', async () => {
  const db = deliveryDb({
    returnRequests: [returnRequest, { ...returnRequest, _id: 'returnRequests|2', buyerId: 'users|other' }],
  });
  const listHandler = handlerOf<ViewerArgs, Array<{ _id: string }>>(getReturnRequests);

  const sellerView = await listHandler(createCtx(db, 'clerk_seller'), {});
  assert.deepEqual(
    sellerView.map((row) => row._id),
    ['returnRequests|1', 'returnRequests|2'],
  );
  const outsiderView = await listHandler(createCtx(db, 'clerk_outsider'), {});
  assert.deepEqual(outsiderView, []);
  const adminView = await listHandler(createCtx(db, 'clerk_admin'), {});
  assert.equal(adminView.length, 2);
});

test('an outsider passing the admin ID cannot read the return requests of an order', async () => {
  const db = deliveryDb();
  const orderReturnsHandler = handlerOf<ViewerArgs, unknown[]>(getOrderReturnRequests);

  await assert.rejects(
    orderReturnsHandler(createCtx(db, 'clerk_outsider'), { orderId: 'orders|1', viewerUserId: 'users|admin' }),
    /Unauthorized/,
  );
});

test('banned, deleted, anonymous, and unknown callers are refused by every delivery handler without state change', async () => {
  const cases: Array<[string | null, RegExp]> = [
    ['clerk_banned', /Account is banned/],
    ['clerk_gone', /Account is deleted/],
    [null, /Unauthenticated/],
    ['clerk_ghost', /Account not found/],
  ];
  const trackingHandler = handlerOf<TrackingArgs, unknown>(addOrderTrackingEvent);
  const eventsHandler = handlerOf<ViewerArgs, unknown[]>(getOrderTrackingEvents);
  const returnHandler = handlerOf<ReturnRequestArgs, unknown>(requestReturn);
  const reviewHandler = handlerOf<ReviewArgs, unknown>(reviewReturnRequest);
  const listHandler = handlerOf<ViewerArgs, unknown[]>(getReturnRequests);
  const orderReturnsHandler = handlerOf<ViewerArgs, unknown[]>(getOrderReturnRequests);

  for (const [subject, message] of cases) {
    const db = deliveryDb({
      orders: [orderRow({ sellerId: 'users|banned' })],
      returnRequests: [{ ...returnRequest, sellerId: 'users|banned' }],
    });
    const ctx = createCtx(db, subject);
    const attempts = [
      () => trackingHandler(ctx, trackingInput),
      () => eventsHandler(ctx, { orderId: 'orders|1' }),
      () => returnHandler(ctx, { ...returnInput, buyerId: 'users|buyer' }),
      () => reviewHandler(ctx, reviewInput),
      () => listHandler(ctx, {}),
      () => orderReturnsHandler(ctx, { orderId: 'orders|1' }),
    ];

    for (const attempt of attempts) {
      await assert.rejects(attempt(), message);
    }
    assert.equal(db.tables.orderTrackingEvents?.length, 1);
    assert.equal(db.tables.returnRequests?.length, 1);
    assert.equal(db.tables.returnRequests?.[0]?.status, 'requested');
    assert.equal(db.tables.notifications?.length ?? 0, 0);
  }
});

// Listing, catalog, and storefront authority. Caller-supplied actor and viewer IDs are ignored;
// the verified Clerk token decides who may act on a listing or see a private one.
const rival = { _id: 'users|rival', clerkId: 'clerk_rival', role: 'user', isBanned: false, email: 'r@x' };
const pendingSeller = { _id: 'users|pending', clerkId: 'clerk_pending', role: 'user', isBanned: false, email: 'p@x' };
const moderator = {
  _id: 'users|moderator',
  clerkId: 'clerk_moderator',
  role: 'moderator',
  isBanned: false,
  email: 'm@x',
};
const listingUsers = [
  admin,
  buyer,
  seller,
  rival,
  outsider,
  pendingSeller,
  moderator,
  catalogManager,
  companySeller,
  bannedSeller,
  deletedSeller,
];

function vendorProfileFor(ownerUserId: string, status: string) {
  const slug = ownerUserId.replace('users|', '');
  return {
    _id: `vendorProfiles|${slug}`,
    ownerUserId,
    storeName: `${slug} store`,
    slug,
    description: 'Hand-finished furniture',
    contactEmail: `${slug}@x`,
    address: { street: '1 Main', city: 'City', province: 'Province', country: 'Country' },
    status,
    createdAt: 1,
    updatedAt: 1,
  };
}

const listingFields = {
  categoryId: 'categories|1',
  description: 'Solid oak',
  images: [],
  price: 25,
  quantity: 3,
  condition: 'new',
  views: 0,
  createdAt: 1,
  updatedAt: 1,
};
const listingRows = [
  { ...listingFields, _id: 'products|active', sellerId: 'users|seller', status: 'active', title: 'Oak chair' },
  { ...listingFields, _id: 'products|draft', sellerId: 'users|seller', status: 'draft', title: 'Draft chair' },
  { ...listingFields, _id: 'products|rival', sellerId: 'users|rival', status: 'active', title: 'Rival desk' },
  { ...listingFields, _id: 'products|company', sellerId: 'users|company', status: 'active', title: 'Company lamp' },
  { ...listingFields, _id: 'products|pending', sellerId: 'users|pending', status: 'active', title: 'Pending stool' },
  { ...listingFields, _id: 'products|banned', sellerId: 'users|banned', status: 'draft', title: 'Banned draft' },
];

function listingDb(overrides: Tables = {}) {
  return createDb({
    users: listingUsers,
    platformSettings: [platformSettings],
    vendorProfiles: [
      vendorProfileFor('users|seller', 'approved'),
      vendorProfileFor('users|rival', 'approved'),
      vendorProfileFor('users|pending', 'pending'),
    ],
    products: listingRows,
    ...overrides,
  });
}

type ListingArgs = Record<string, unknown>;
const newListing = {
  title: 'New lamp',
  description: 'Brass',
  price: 40,
  categoryId: 'categories|1',
  images: [],
  condition: 'good',
  quantity: 2,
};
const createListing = handlerOf<ListingArgs, string>(createProduct);
const editListing = handlerOf<ListingArgs, unknown>(updateProduct);
const submitListing = handlerOf<ListingArgs, unknown>(submitForReview);
const removeListing = handlerOf<ListingArgs, unknown>(deleteProduct);
const soldListing = handlerOf<ListingArgs, unknown>(markAsSold);
const myListings = handlerOf<ListingArgs, Array<{ _id: string }>>(getMyListings);
const catalogProducts = handlerOf<ListingArgs, Array<{ _id: string }>>(getManagedCatalogProducts);
const catalogOrders = handlerOf<ListingArgs, Array<{ _id: string }>>(getManagedCatalogOrders);
const productView = handlerOf<ListingArgs, { _id: string } | null>(getProduct);
const sellerProducts = handlerOf<ListingArgs, Array<{ _id: string }>>(getProductsBySeller);
const storefront = handlerOf<ListingArgs, { storeName: string } | null>(getVendorStorefront);

const stateOf = (db: Db) => structuredClone(db.tables);
const idsOf = (rows: Array<{ _id: string }>) => rows.map((row) => row._id).sort();
const rowOf = (db: Db, table: string, id: string) => db.tables[table]?.find((row) => row._id === id);

test('a customer passing an approved vendor ID cannot create a listing for that vendor', async () => {
  const db = listingDb();
  const before = stateOf(db);

  await assert.rejects(
    createListing(createCtx(db, 'clerk_outsider'), { ...newListing, actorUserId: 'users|seller' }),
    /Only approved vendors can manage listings/,
  );
  assert.deepEqual(db.tables, before);
});

test('an approved vendor passing another vendor ID creates the listing under their own account', async () => {
  const db = listingDb();

  const productId = await createListing(createCtx(db, 'clerk_rival'), { ...newListing, actorUserId: 'users|seller' });

  const created = rowOf(db, 'products', productId);
  assert.equal(created?.sellerId, 'users|rival');
  assert.equal(created?.managedByUserId, 'users|rival');
});

test('a vendor whose application is pending cannot create a listing', async () => {
  const db = listingDb();
  const before = stateOf(db);

  await assert.rejects(
    createListing(createCtx(db, 'clerk_pending'), newListing),
    /Only approved vendors can manage listings/,
  );
  assert.deepEqual(db.tables, before);
});

test('a moderator cannot create a listing', async () => {
  const db = listingDb();
  const before = stateOf(db);

  await assert.rejects(
    createListing(createCtx(db, 'clerk_moderator'), newListing),
    /Moderators cannot manage listings/,
  );
  assert.deepEqual(db.tables, before);
});

test('an approved vendor creates a draft stamped with their verified ID', async () => {
  const db = listingDb();

  const productId = await createListing(createCtx(db, 'clerk_seller'), newListing);

  const created = rowOf(db, 'products', productId);
  assert.equal(created?.sellerId, 'users|seller');
  assert.equal(created?.managedByUserId, 'users|seller');
  assert.equal(created?.status, 'draft');
});

test('a catalog manager creates company listings under the company seller account', async () => {
  const db = listingDb();

  const productId = await createListing(createCtx(db, 'clerk_catalog'), newListing);

  const created = rowOf(db, 'products', productId);
  assert.equal(created?.sellerId, 'users|company');
  assert.equal(created?.managedByUserId, 'users|catalog');
});

test('a vendor passing another vendor ID cannot edit that vendor listing', async () => {
  const db = listingDb();
  const before = stateOf(db);

  await assert.rejects(
    editListing(createCtx(db, 'clerk_rival'), {
      productId: 'products|active',
      actorUserId: 'users|seller',
      title: 'Hijacked',
    }),
    /Unauthorized/,
  );
  assert.deepEqual(db.tables, before);
});

test('the owning vendor edits their listing and the audit field records their verified ID', async () => {
  const db = listingDb();

  await editListing(createCtx(db, 'clerk_seller'), { productId: 'products|draft', title: 'Edited chair' });

  const edited = rowOf(db, 'products', 'products|draft');
  assert.equal(edited?.title, 'Edited chair');
  assert.equal(edited?.managedByUserId, 'users|seller');
});

test('a catalog manager edits company listings but not another vendor listing', async () => {
  const db = listingDb();

  await editListing(createCtx(db, 'clerk_catalog'), { productId: 'products|company', title: 'Lamp v2' });
  assert.equal(rowOf(db, 'products', 'products|company')?.title, 'Lamp v2');

  await assert.rejects(
    editListing(createCtx(db, 'clerk_catalog'), { productId: 'products|active', title: 'Chair v2' }),
    /Unauthorized/,
  );
  assert.equal(rowOf(db, 'products', 'products|active')?.title, 'Oak chair');
});

test('a vendor passing another vendor ID cannot submit that listing for review', async () => {
  const db = listingDb();
  const before = stateOf(db);

  await assert.rejects(
    submitListing(createCtx(db, 'clerk_rival'), { productId: 'products|draft', actorUserId: 'users|seller' }),
    /Unauthorized/,
  );
  assert.deepEqual(db.tables, before);
});

test('the owning vendor submits their draft and the audit field records their verified ID', async () => {
  const db = listingDb();

  await submitListing(createCtx(db, 'clerk_seller'), { productId: 'products|draft' });

  const submitted = rowOf(db, 'products', 'products|draft');
  assert.equal(submitted?.status, 'pending_review');
  assert.equal(submitted?.managedByUserId, 'users|seller');
});

test('a vendor passing another vendor ID cannot delete that listing', async () => {
  const db = listingDb();
  const before = stateOf(db);

  await assert.rejects(
    removeListing(createCtx(db, 'clerk_rival'), { productId: 'products|active', actorUserId: 'users|seller' }),
    /Unauthorized/,
  );
  assert.deepEqual(db.tables, before);
});

test('the owning vendor deletes their listing', async () => {
  const db = listingDb();

  await removeListing(createCtx(db, 'clerk_seller'), { productId: 'products|draft' });

  assert.equal(rowOf(db, 'products', 'products|draft'), undefined);
});

test('a vendor passing another vendor ID cannot mark that listing sold', async () => {
  const db = listingDb();
  const before = stateOf(db);

  await assert.rejects(
    soldListing(createCtx(db, 'clerk_rival'), { productId: 'products|active', actorUserId: 'users|seller' }),
    /Unauthorized/,
  );
  assert.deepEqual(db.tables, before);
});

test('the owning vendor marks their listing sold under their verified ID', async () => {
  const db = listingDb();

  await soldListing(createCtx(db, 'clerk_seller'), { productId: 'products|active' });

  const sold = rowOf(db, 'products', 'products|active');
  assert.equal(sold?.status, 'sold');
  assert.equal(sold?.managedByUserId, 'users|seller');
});

test('banned, deleted, anonymous, and unknown callers are refused by every listing handler without state change', async () => {
  const cases: Array<[string | null, RegExp]> = [
    ['clerk_banned', /Account is banned/],
    ['clerk_gone', /Account is deleted/],
    [null, /Unauthenticated/],
    ['clerk_ghost', /Account not found/],
  ];
  const attempts: Array<[string, Handler<ListingArgs, unknown>, ListingArgs]> = [
    ['createProduct', createListing, newListing],
    ['updateProduct', editListing, { productId: 'products|active', title: 'Edited' }],
    ['submitForReview', submitListing, { productId: 'products|draft' }],
    ['deleteProduct', removeListing, { productId: 'products|draft' }],
    ['markAsSold', soldListing, { productId: 'products|active' }],
    ['getMyListings', myListings, {}],
  ];

  for (const [subject, message] of cases) {
    for (const [name, handler, args] of attempts) {
      const db = listingDb();
      const before = stateOf(db);

      await assert.rejects(handler(createCtx(db, subject), args), message, name);
      assert.deepEqual(db.tables, before, name);
    }
  }
});

test('getMyListings returns only the verified vendor listings even when another vendor ID is passed', async () => {
  const db = listingDb();

  const rows = await myListings(createCtx(db, 'clerk_rival'), { actorUserId: 'users|seller' });

  assert.deepEqual(idsOf(rows), ['products|rival']);
});

test('a catalog manager lists company listings and a vendor passing the catalog manager ID is refused', async () => {
  const db = listingDb();

  const companyRows = await catalogProducts(createCtx(db, 'clerk_catalog'), {});
  assert.deepEqual(idsOf(companyRows), ['products|company']);

  await assert.rejects(
    catalogProducts(createCtx(db, 'clerk_seller'), { actorUserId: 'users|catalog' }),
    /Unauthorized: Only admins and catalog managers/,
  );
});

test('a catalog manager reads company orders and a vendor passing the catalog manager ID is refused', async () => {
  const db = listingDb({
    orders: [orderRow({ _id: 'orders|company', sellerId: 'users|company' }), orderRow({ _id: 'orders|vendor' })],
  });

  const companyOrders = await catalogOrders(createCtx(db, 'clerk_catalog'), {});
  assert.deepEqual(idsOf(companyOrders), ['orders|company']);

  await assert.rejects(
    catalogOrders(createCtx(db, 'clerk_seller'), { actorUserId: 'users|catalog' }),
    /Unauthorized: Only admins and catalog managers/,
  );
});

test('a guest reads an active listing from an approved vendor but not that vendor draft', async () => {
  const db = listingDb();

  const visible = await productView(createCtx(db, null), { productId: 'products|active' });
  const hidden = await productView(createCtx(db, null), { productId: 'products|draft' });

  assert.equal(visible?._id, 'products|active');
  assert.equal(hidden, null);
});

test('a customer passing the seller ID cannot inspect that seller draft listing', async () => {
  const db = listingDb();

  const result = await productView(createCtx(db, 'clerk_outsider'), {
    productId: 'products|draft',
    viewerUserId: 'users|seller',
  });

  assert.equal(result, null);
});

test('the owning vendor, admins, and moderators inspect a draft; a banned owner is treated as a guest', async () => {
  const db = listingDb();

  assert.equal(
    (await productView(createCtx(db, 'clerk_seller'), { productId: 'products|draft' }))?._id,
    'products|draft',
  );
  assert.equal(
    (await productView(createCtx(db, 'clerk_admin'), { productId: 'products|draft' }))?._id,
    'products|draft',
  );
  assert.equal(
    (await productView(createCtx(db, 'clerk_moderator'), { productId: 'products|draft' }))?._id,
    'products|draft',
  );
  assert.equal(await productView(createCtx(db, 'clerk_banned'), { productId: 'products|banned' }), null);
});

test('a guest lists only the public listings of a vendor', async () => {
  const db = listingDb();

  const rows = await sellerProducts(createCtx(db, null), { sellerId: 'users|seller' });

  assert.deepEqual(idsOf(rows), ['products|active']);
});

test('an outsider passing the seller ID lists only the public listings of that seller', async () => {
  const db = listingDb();

  const rows = await sellerProducts(createCtx(db, 'clerk_outsider'), {
    sellerId: 'users|seller',
    viewerUserId: 'users|seller',
  });

  assert.deepEqual(idsOf(rows), ['products|active']);
});

test('the owning vendor, admins, and moderators list every listing of that vendor', async () => {
  const db = listingDb();

  const ownerRows = await sellerProducts(createCtx(db, 'clerk_seller'), { sellerId: 'users|seller' });
  const adminRows = await sellerProducts(createCtx(db, 'clerk_admin'), { sellerId: 'users|seller' });
  const moderatorRows = await sellerProducts(createCtx(db, 'clerk_moderator'), { sellerId: 'users|seller' });

  assert.deepEqual(idsOf(ownerRows), ['products|active', 'products|draft']);
  assert.deepEqual(idsOf(adminRows), ['products|active', 'products|draft']);
  assert.deepEqual(idsOf(moderatorRows), ['products|active', 'products|draft']);
});

test('a guest sees an approved vendor storefront but not a pending one', async () => {
  const db = listingDb();

  assert.equal((await storefront(createCtx(db, null), { sellerId: 'users|seller' }))?.storeName, 'seller store');
  assert.equal(await storefront(createCtx(db, null), { sellerId: 'users|pending' }), null);
});

test('an outsider passing the pending vendor ID cannot see that pending storefront', async () => {
  const db = listingDb();

  const result = await storefront(createCtx(db, 'clerk_outsider'), {
    sellerId: 'users|pending',
    viewerUserId: 'users|pending',
  });

  assert.equal(result, null);
});

test('the pending vendor and moderators see their pending storefront', async () => {
  const db = listingDb();

  assert.equal(
    (await storefront(createCtx(db, 'clerk_pending'), { sellerId: 'users|pending' }))?.storeName,
    'pending store',
  );
  assert.equal(
    (await storefront(createCtx(db, 'clerk_moderator'), { sellerId: 'users|pending' }))?.storeName,
    'pending store',
  );
});

test('return lists are scoped to each seller and filtered by status across mixed fixtures', async () => {
  const returnFor = (overrides: Record<string, unknown>) => ({ ...returnRequest, ...overrides });
  const db = deliveryDb({
    users: [...orderUsers, rival],
    orders: [orderRow(), orderRow({ _id: 'orders|2', sellerId: 'users|rival' })],
    returnRequests: [
      returnFor({
        _id: 'returnRequests|1',
        orderId: 'orders|1',
        sellerId: 'users|seller',
        status: 'requested',
        createdAt: 1,
      }),
      returnFor({
        _id: 'returnRequests|2',
        orderId: 'orders|1',
        sellerId: 'users|seller',
        status: 'refunded',
        createdAt: 2,
      }),
      returnFor({
        _id: 'returnRequests|3',
        orderId: 'orders|2',
        sellerId: 'users|rival',
        status: 'requested',
        createdAt: 3,
      }),
      returnFor({
        _id: 'returnRequests|4',
        orderId: 'orders|2',
        sellerId: 'users|rival',
        buyerId: 'users|outsider',
        status: 'approved',
        createdAt: 4,
      }),
    ],
  });
  const listHandler = handlerOf<ViewerArgs, Array<{ _id: string }>>(getReturnRequests);
  const idsFor = async (subject: string, args: ViewerArgs) =>
    (await listHandler(createCtx(db, subject), args)).map((row) => row._id);

  assert.deepEqual(await idsFor('clerk_seller', {}), ['returnRequests|2', 'returnRequests|1']);
  assert.deepEqual(await idsFor('clerk_seller', { status: 'requested' }), ['returnRequests|1']);
  assert.deepEqual(await idsFor('clerk_seller', { status: 'approved' }), []);
  assert.deepEqual(await idsFor('clerk_rival', { status: 'requested' }), ['returnRequests|3']);
  assert.deepEqual(await idsFor('clerk_admin', { status: 'requested' }), ['returnRequests|3', 'returnRequests|1']);
  assert.deepEqual(await idsFor('clerk_outsider', {}), ['returnRequests|4']);
});

// Vendor ownership and private order reads. The requests use only declared arguments, so ownership
// comes from the verified token. Argument-validator coverage lives in the BOUND checks in authorization.test.ts.
const applicant = { _id: 'users|applicant', clerkId: 'clerk_applicant', role: 'user', isBanned: false, email: 'ap@x' };
const applicantTwin = {
  _id: 'users|applicant2',
  clerkId: 'clerk_applicant2',
  role: 'user',
  isBanned: false,
  email: 'ap2@x',
};
const applicationInput = {
  storeName: 'Oak & Pine',
  description: 'Hand-finished furniture',
  contactEmail: 'studio@x',
  address: { street: '1 Main', city: 'City', province: 'Province', country: 'Country' },
};
const denialCases: Array<[string | null, RegExp]> = [
  ['clerk_banned', /Account is banned/],
  ['clerk_gone', /Account is deleted/],
  [null, /Unauthenticated/],
  ['clerk_ghost', /Account not found/],
];

function vendorDb(overrides: Tables = {}) {
  return listingDb({ users: [...listingUsers, applicant, applicantTwin], ...overrides });
}

const submitVendorApplication = handlerOf<Record<string, unknown>, Record<string, unknown> | null>(submitApplication);
const myVendorProfile = handlerOf<Record<string, unknown>, Record<string, unknown> | null>(getMyVendorProfile);

test("an applicant's submission creates a pending profile owned by the verified applicant", async () => {
  const db = vendorDb();

  const profile = await submitVendorApplication(createCtx(db, 'clerk_applicant'), applicationInput);

  assert.equal(profile?.ownerUserId, 'users|applicant');
  assert.equal(profile?.status, 'pending');
  assert.equal(profile?.slug, 'oak-pine');
  assert.equal(rowOf(db, 'vendorProfiles', 'vendorProfiles|seller')?.storeName, 'seller store');
});

test('stored URLs are normalized and two stores with the same name get distinct slugs', async () => {
  const db = vendorDb();

  const first = await submitVendorApplication(createCtx(db, 'clerk_applicant'), {
    ...applicationInput,
    logoUrl: 'example.com/logo.png',
  });
  const second = await submitVendorApplication(createCtx(db, 'clerk_applicant2'), applicationInput);

  assert.equal(first?.logoUrl, 'https://example.com/logo.png');
  assert.equal(first?.slug, 'oak-pine');
  assert.equal(second?.slug, 'oak-pine-2');
  assert.equal(second?.ownerUserId, 'users|applicant2');
});

test("an approved vendor's resubmission keeps the approved status and updates the profile", async () => {
  const db = vendorDb();

  const profile = await submitVendorApplication(createCtx(db, 'clerk_seller'), {
    ...applicationInput,
    description: 'Updated description',
  });

  assert.equal(profile?.status, 'approved');
  assert.equal(profile?.description, 'Updated description');
  assert.equal(profile?.ownerUserId, 'users|seller');
});

test("a pending applicant's resubmission stays pending", async () => {
  const db = vendorDb();

  const profile = await submitVendorApplication(createCtx(db, 'clerk_pending'), {
    ...applicationInput,
    storeName: 'Pending Store',
  });

  assert.equal(profile?.status, 'pending');
  assert.equal(profile?.slug, 'pending-store');
});

test('anonymous, unknown, banned, and deleted callers cannot create or change a vendor profile', async () => {
  for (const [subject, message] of denialCases) {
    const db = vendorDb();
    const before = stateOf(db);

    await assert.rejects(submitVendorApplication(createCtx(db, subject), applicationInput), message, String(subject));
    assert.deepEqual(db.tables, before, String(subject));
  }
});

test('a vendor reads their own profile and a customer without one reads none', async () => {
  const db = vendorDb();

  const own = await myVendorProfile(createCtx(db, 'clerk_seller'), {});
  const none = await myVendorProfile(createCtx(db, 'clerk_outsider'), {});

  assert.equal(own?.ownerUserId, 'users|seller');
  assert.equal(none, null);
});

test('guests and denied accounts cannot read a vendor profile', async () => {
  for (const [subject, message] of denialCases) {
    const db = vendorDb();

    await assert.rejects(myVendorProfile(createCtx(db, subject), {}), message, String(subject));
  }
});

const orderById = handlerOf<Record<string, unknown>, { _id: string; buyer?: unknown } | null>(getOrder);
const orderByNumber = handlerOf<Record<string, unknown>, { _id: string } | null>(getOrderByNumber);
const sellerOrderList = handlerOf<Record<string, unknown>, Array<{ _id: string; buyer?: unknown }>>(getSellerOrders);

const orderFixtures = [
  orderRow({ _id: 'orders|1', orderNumber: 'ORD-1', sellerId: 'users|seller', status: 'paid' }),
  orderRow({ _id: 'orders|2', orderNumber: 'ORD-2', sellerId: 'users|seller', status: 'delivered' }),
  orderRow({ _id: 'orders|3', orderNumber: 'ORD-3', sellerId: 'users|rival', status: 'paid' }),
  orderRow({ _id: 'orders|company', orderNumber: 'ORD-C', sellerId: 'users|company', status: 'paid' }),
];

function ordersDb(overrides: Tables = {}) {
  return listingDb({ orders: orderFixtures, ...overrides });
}

test('the buyer and the seller read an order, and the buyer reads it by its order number', async () => {
  const db = ordersDb();

  const asBuyer = await orderById(createCtx(db, 'clerk_buyer'), { orderId: 'orders|1' });
  const asSeller = await orderById(createCtx(db, 'clerk_seller'), { orderId: 'orders|1' });
  const byNumber = await orderByNumber(createCtx(db, 'clerk_buyer'), { orderNumber: 'ORD-1' });

  assert.equal(asBuyer?._id, 'orders|1');
  assert.equal((asSeller?.buyer as { _id?: string } | null)?._id, 'users|buyer');
  assert.equal(byNumber?._id, 'orders|1');
});

test('an unrelated customer cannot read an order by its ID', async () => {
  const db = ordersDb();

  await assert.rejects(orderById(createCtx(db, 'clerk_outsider'), { orderId: 'orders|1' }), /Unauthorized/);
});

test('an unrelated customer cannot read an order by its order number', async () => {
  const db = ordersDb();

  await assert.rejects(orderByNumber(createCtx(db, 'clerk_outsider'), { orderNumber: 'ORD-1' }), /Unauthorized/);
});

test('a catalog manager reads company-seller orders by ID but not another vendor order', async () => {
  const db = ordersDb();

  assert.equal((await orderById(createCtx(db, 'clerk_catalog'), { orderId: 'orders|company' }))?._id, 'orders|company');
  await assert.rejects(orderById(createCtx(db, 'clerk_catalog'), { orderId: 'orders|1' }), /Unauthorized/);
});

test('admins and moderators read any order under the existing review-role policy', async () => {
  const db = ordersDb();

  assert.equal((await orderById(createCtx(db, 'clerk_admin'), { orderId: 'orders|3' }))?._id, 'orders|3');
  assert.equal((await orderByNumber(createCtx(db, 'clerk_moderator'), { orderNumber: 'ORD-1' }))?._id, 'orders|1');
});

test('guests and denied accounts are refused by both order reads', async () => {
  for (const [subject, message] of denialCases) {
    const db = ordersDb();

    await assert.rejects(orderById(createCtx(db, subject), { orderId: 'orders|1' }), message, String(subject));
    await assert.rejects(orderByNumber(createCtx(db, subject), { orderNumber: 'ORD-1' }), message, String(subject));
  }
});

test('a missing order reads as null for a verified participant', async () => {
  const db = ordersDb();

  assert.equal(await orderById(createCtx(db, 'clerk_buyer'), { orderId: 'orders|404' }), null);
  assert.equal(await orderByNumber(createCtx(db, 'clerk_buyer'), { orderNumber: 'ORD-404' }), null);
});

test('a vendor reads only their own orders, filtered by status, with buyer summaries', async () => {
  const db = ordersDb();

  const all = await sellerOrderList(createCtx(db, 'clerk_seller'), { sellerId: 'users|seller' });
  const paid = await sellerOrderList(createCtx(db, 'clerk_seller'), { sellerId: 'users|seller', status: 'paid' });
  const rivalOrders = await sellerOrderList(createCtx(db, 'clerk_rival'), { sellerId: 'users|rival' });

  assert.deepEqual(idsOf(all), ['orders|1', 'orders|2']);
  assert.deepEqual(idsOf(paid), ['orders|1']);
  assert.deepEqual(idsOf(rivalOrders), ['orders|3']);
  assert.equal((all[0]?.buyer as { _id?: string } | null)?._id, 'users|buyer');
});

test('an outsider cannot read another vendor orders by passing that vendor ID', async () => {
  const db = ordersDb();

  await assert.rejects(sellerOrderList(createCtx(db, 'clerk_outsider'), { sellerId: 'users|seller' }), /Unauthorized/);
});

test('a catalog manager reads company-seller orders but not another vendor orders', async () => {
  const db = ordersDb();

  assert.deepEqual(idsOf(await sellerOrderList(createCtx(db, 'clerk_catalog'), { sellerId: 'users|company' })), [
    'orders|company',
  ]);
  await assert.rejects(sellerOrderList(createCtx(db, 'clerk_catalog'), { sellerId: 'users|seller' }), /Unauthorized/);
});

test('moderators and admins do not read seller order lists; they use the admin list instead', async () => {
  const db = ordersDb();

  await assert.rejects(sellerOrderList(createCtx(db, 'clerk_moderator'), { sellerId: 'users|seller' }), /Unauthorized/);
  await assert.rejects(sellerOrderList(createCtx(db, 'clerk_admin'), { sellerId: 'users|seller' }), /Unauthorized/);
});

test('guests and denied accounts cannot read seller order lists', async () => {
  for (const [subject, message] of denialCases) {
    const db = ordersDb();

    await assert.rejects(
      sellerOrderList(createCtx(db, subject), { sellerId: 'users|seller' }),
      message,
      String(subject),
    );
  }
});

test('a buyer passing their own ID reads no seller orders, because they sold none', async () => {
  const db = ordersDb();

  assert.deepEqual(await sellerOrderList(createCtx(db, 'clerk_buyer'), { sellerId: 'users|buyer' }), []);
});
