import assert from 'node:assert/strict';
import test from 'node:test';

import * as delivery from './delivery';
import { denialMessage } from './lib/auth';
import { invokeFakeFunction } from '../tests/support/convexFakeActionCtx';
import { createCtx, createDb, type Db, type Row, type Tables } from '../tests/support/convexFakeDb';

// Delivery zones, methods and pickup points are public only while active. Asking for inactive records requires the
// admin role, the same policy as the delivery mutations in delivery.ts (ensureAdminActor). A refused call must not read
// any delivery table: the guard runs before the first read, so the only read it makes is the account lookup.

const INACTIVE_PHONE = 'PHONE-INACTIVE-0002';

const ACTORS: Array<{ label: string; subject: string | null; refusal: string | null }> = [
  { label: 'an anonymous caller', subject: null, refusal: denialMessage('unauthenticated') },
  { label: 'an ordinary user', subject: 'clerk_user', refusal: denialMessage('forbidden') },
  { label: 'a moderator', subject: 'clerk_moderator', refusal: denialMessage('forbidden') },
  { label: 'a catalog manager', subject: 'clerk_catalog', refusal: denialMessage('forbidden') },
  { label: 'an admin', subject: 'clerk_admin', refusal: null },
];

function account(id: string, clerkId: string, role: string): Row {
  return { _id: id, clerkId, email: `${clerkId}@example.invalid`, firstName: 'Fixture', role, isBanned: false };
}

function fixtureTables(): Tables {
  return {
    users: [
      account('users|user', 'clerk_user', 'user'),
      account('users|moderator', 'clerk_moderator', 'moderator'),
      account('users|catalog', 'clerk_catalog', 'catalog_manager'),
      account('users|admin', 'clerk_admin', 'admin'),
    ],
    deliveryZones: [
      { _id: 'deliveryZones|active', name: 'Lusaka', slug: 'lusaka', isActive: true, sortOrder: 1 },
      { _id: 'deliveryZones|inactive', name: 'Retired', slug: 'retired', isActive: false, sortOrder: 2 },
    ],
    deliveryMethods: [
      {
        _id: 'deliveryMethods|active',
        zoneId: 'deliveryZones|active',
        name: 'Standard',
        code: 'standard',
        type: 'standard',
        baseFee: 10,
        minDays: 1,
        maxDays: 2,
        isActive: true,
      },
      {
        _id: 'deliveryMethods|inactive',
        zoneId: 'deliveryZones|inactive',
        name: 'Old express',
        code: 'old-express',
        type: 'express',
        baseFee: 30,
        minDays: 1,
        maxDays: 1,
        isActive: false,
      },
    ],
    pickupPoints: [
      {
        _id: 'pickupPoints|active',
        zoneId: 'deliveryZones|active',
        name: 'Town store',
        code: 'town',
        address: { street: 'Cairo Road', city: 'Lusaka', province: 'Lusaka', country: 'Zambia' },
        contactPhone: 'PHONE-ACTIVE-0001',
        isActive: true,
      },
      {
        _id: 'pickupPoints|inactive',
        zoneId: 'deliveryZones|inactive',
        name: 'Closed depot',
        code: 'depot',
        address: { street: 'Old Road', city: 'Ndola', province: 'Copperbelt', country: 'Zambia' },
        contactPhone: INACTIVE_PHONE,
        isActive: false,
      },
    ],
  };
}

// Records each table the caller reads, so a test can show a refused call never reached a delivery table.
function recordReads(db: Db, reads: string[]): Db {
  return {
    ...db,
    query: (table: string) => {
      reads.push(table);
      return db.query(table);
    },
    get: async (id: string) => {
      reads.push(id.split('|')[0] ?? id);
      return await db.get(id);
    },
  };
}

const QUERIES: Array<{
  name: string;
  fn: unknown;
  activeId: string;
  inactiveId: string;
  table: string;
}> = [
  {
    name: 'listDeliveryZones',
    fn: delivery.listDeliveryZones,
    activeId: 'deliveryZones|active',
    inactiveId: 'deliveryZones|inactive',
    table: 'deliveryZones',
  },
  {
    name: 'listDeliveryMethods',
    fn: delivery.listDeliveryMethods,
    activeId: 'deliveryMethods|active',
    inactiveId: 'deliveryMethods|inactive',
    table: 'deliveryMethods',
  },
  {
    name: 'listPickupPoints',
    fn: delivery.listPickupPoints,
    activeId: 'pickupPoints|active',
    inactiveId: 'pickupPoints|inactive',
    table: 'pickupPoints',
  },
];

function idsOf(rows: unknown): string[] {
  assert.ok(Array.isArray(rows));
  return rows.map((row) => {
    assert.ok(typeof row === 'object' && row !== null && '_id' in row && typeof row._id === 'string');
    return row._id;
  });
}

for (const query of QUERIES) {
  for (const actor of ACTORS) {
    test(`${query.name} with includeInactive true for ${actor.label}`, async () => {
      const tables = fixtureTables();
      const db = createDb(tables);
      const reads: string[] = [];
      const ctx = createCtx(recordReads(db, reads), actor.subject);

      if (actor.refusal !== null) {
        await assert.rejects(invokeFakeFunction(query.fn, ctx, { includeInactive: true }), {
          message: actor.refusal,
        });
        assert.deepEqual(
          reads.filter((table) => table !== 'users'),
          [],
          `${query.name} must refuse before reading ${query.table}`,
        );
        return;
      }

      const ids = idsOf(await invokeFakeFunction(query.fn, ctx, { includeInactive: true }));
      assert.ok(ids.includes(query.activeId));
      assert.ok(ids.includes(query.inactiveId));
    });

    for (const variant of [
      { label: 'false', args: { includeInactive: false } },
      { label: 'omitted', args: {} },
    ]) {
      test(`${query.name} with includeInactive ${variant.label} for ${actor.label} returns only active records`, async () => {
        const db = createDb(fixtureTables());
        const ctx = createCtx(db, actor.subject);

        const rows = await invokeFakeFunction(query.fn, ctx, variant.args);
        const ids = idsOf(rows);

        assert.ok(ids.includes(query.activeId));
        assert.equal(ids.includes(query.inactiveId), false);
        assert.equal(JSON.stringify(rows).includes(INACTIVE_PHONE), false);
      });
    }
  }
}
