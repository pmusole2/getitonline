import assert from 'node:assert/strict';
import test from 'node:test';

import * as storage from './storage';
import { createCtx, createDb, handlerOf, type Db, type Row, type Tables } from '../tests/support/convexFakeDb';
import { invokeFakeFunction } from '../tests/support/convexFakeActionCtx';

// These tests run the real registered storage handlers over the in-memory fake. The fake has no `system` table and the
// handler context has no `storage`, so this file adds both: `db.system.get` reads the `_storage` table, and `storage`
// records every call. A refused call must make no storage call and change no table, because the fake does not roll back.

type Args = Record<string, unknown>;

const generateUploadUrl = handlerOf<Args, string>(storage.generateUploadUrl);
const getUrl = handlerOf<Args, string | null>(storage.getUrl);
const getUrls = handlerOf<Args, string[]>(storage.getUrls);
const deleteFile = handlerOf<Args, unknown>(storage.deleteFile);
const saveImageMetadata = handlerOf<Args, Row>(storage.saveImageMetadata);

const NOW = Date.now();
const OLD = NOW - 24 * 60 * 60 * 1000;
const RECENT = NOW - 60 * 1000;

const INDEXES = { storageFiles: { by_storage_id: ['storageId'] } };

function account(id: string, clerkId: string, role: string, extra: Partial<Row> = {}): Row {
  return {
    _id: id,
    clerkId,
    email: `${clerkId}@example.invalid`,
    firstName: 'Fixture',
    lastName: id,
    role,
    isBanned: false,
    ...extra,
  };
}

function fixtureTables(): Tables {
  return {
    users: [
      account('users|owner', 'clerk_owner', 'user'),
      account('users|other', 'clerk_other', 'user'),
      account('users|catalog', 'clerk_catalog', 'catalog_manager'),
      account('users|moderator', 'clerk_moderator', 'moderator'),
      account('users|admin', 'clerk_admin', 'admin'),
      account('users|banned', 'clerk_banned', 'user', { isBanned: true }),
      account('users|deleted', 'clerk_deleted', 'user', { deletedAt: 1 }),
    ],
    _storage: [
      { _id: '_storage|legacy', _creationTime: OLD },
      { _id: '_storage|fresh', _creationTime: RECENT },
      { _id: '_storage|ownedPublic', _creationTime: OLD },
      { _id: '_storage|ownedPrivate', _creationTime: OLD },
    ],
    storageFiles: [
      {
        _id: 'storageFiles|1',
        storageId: '_storage|ownedPublic',
        ownerUserId: 'users|owner',
        purpose: 'public',
        createdAt: 1,
      },
      {
        _id: 'storageFiles|2',
        storageId: '_storage|ownedPrivate',
        ownerUserId: 'users|owner',
        purpose: 'private',
        createdAt: 1,
      },
    ],
  };
}

type Harness = { db: Db; ctx: unknown; calls: string[] };

// `subject` null is an anonymous caller. The wrapper keeps the fake's db methods and adds the system table.
function setup(subject: string | null, tables: Tables = fixtureTables()): Harness {
  const db = createDb(tables, INDEXES);
  const calls: string[] = [];
  return { db, ctx: contextFor(db, calls, subject), calls };
}

// The context for one caller over a shared db and call log, so a test can run several accounts against one database.
function contextFor(db: Db, calls: string[], subject: string | null) {
  const stored = (id: unknown) => db.tables._storage?.find((row) => row._id === id) ?? null;
  const storageApi = {
    generateUploadUrl: async () => {
      calls.push('generateUploadUrl');
      return 'https://upload.invalid/u1';
    },
    getUrl: async (id: string) => {
      calls.push(`getUrl:${id}`);
      return stored(id) ? `https://files.invalid/${id}` : null;
    },
    delete: async (id: string) => {
      calls.push(`delete:${id}`);
      await db.delete(id);
    },
  };
  const system = { get: async (id: string) => stored(id) };
  return { ...createCtx(db, subject), db: { ...db, system }, storage: storageApi };
}

function snapshot(db: Db): Tables {
  return structuredClone(db.tables);
}

const DENIALS: Array<{ label: string; subject: string | null; message: string }> = [
  { label: 'anonymous', subject: null, message: 'Unauthenticated' },
  {
    label: 'unknown account',
    subject: 'clerk_nobody',
    message: 'Account not found. Sign in again to finish setting up your account.',
  },
  { label: 'banned account', subject: 'clerk_banned', message: 'Account is banned' },
  { label: 'deleted account', subject: 'clerk_deleted', message: 'Account is deleted' },
];

// generateUploadUrl: uploads need an active account.
for (const denial of DENIALS) {
  test(`generateUploadUrl refuses a ${denial.label} caller and makes no storage call`, async () => {
    const { ctx, calls, db } = setup(denial.subject);
    const before = snapshot(db);
    await assert.rejects(generateUploadUrl(ctx, {}), { message: denial.message });
    assert.deepEqual(calls, []);
    assert.deepEqual(db.tables, before);
  });
}

test('generateUploadUrl returns an upload URL for an active account', async () => {
  const { ctx, calls } = setup('clerk_owner');
  assert.equal(await generateUploadUrl(ctx, {}), 'https://upload.invalid/u1');
  assert.deepEqual(calls, ['generateUploadUrl']);
});

// saveImageMetadata: registering a file records ownership from the verified subject.
for (const denial of DENIALS) {
  test(`saveImageMetadata refuses a ${denial.label} caller and writes nothing`, async () => {
    const { ctx, calls, db } = setup(denial.subject);
    const before = snapshot(db);
    await assert.rejects(saveImageMetadata(ctx, registerArgs('_storage|fresh')), { message: denial.message });
    assert.deepEqual(calls, []);
    assert.deepEqual(db.tables, before);
  });
}

function registerArgs(storageId: string, extra: Args = {}): Args {
  return { storageId, fileName: 'photo.jpg', contentType: 'image/jpeg', size: 1024, ...extra };
}

test('saveImageMetadata records the verified caller as owner, defaulting to public', async () => {
  const { ctx, db } = setup('clerk_other');
  await saveImageMetadata(ctx, registerArgs('_storage|fresh'));
  const row = db.tables.storageFiles?.find((candidate) => candidate.storageId === '_storage|fresh');
  assert.equal(row?.ownerUserId, 'users|other');
  assert.equal(row?.purpose, 'public');
});

test('saveImageMetadata rejects a caller-supplied uploadedBy and writes nothing', async () => {
  const { ctx, db } = setup('clerk_other');
  const before = snapshot(db);
  await assert.rejects(
    invokeFakeFunction(storage.saveImageMetadata, ctx, registerArgs('_storage|fresh', { uploadedBy: 'users|owner' })),
    /Argument validation failed/,
  );
  assert.deepEqual(db.tables, before);
});

test('saveImageMetadata rejects an id that is not in storage and writes nothing', async () => {
  const { ctx, db } = setup('clerk_other');
  const before = snapshot(db);
  await assert.rejects(saveImageMetadata(ctx, registerArgs('_storage|missing')), { message: 'File not found' });
  assert.deepEqual(db.tables, before);
});

test('saveImageMetadata refuses to claim an old unregistered (legacy) file', async () => {
  const { ctx, db, calls } = setup('clerk_other');
  const before = snapshot(db);
  await assert.rejects(saveImageMetadata(ctx, registerArgs('_storage|legacy')), { message: 'Unauthorized' });
  assert.deepEqual(calls, []);
  assert.deepEqual(db.tables, before);
});

test('saveImageMetadata refuses a second account claiming a file already registered to someone else', async () => {
  const { ctx, db, calls } = setup('clerk_other');
  const before = snapshot(db);
  await assert.rejects(saveImageMetadata(ctx, registerArgs('_storage|ownedPublic')), { message: 'Unauthorized' });
  assert.deepEqual(calls, []);
  assert.deepEqual(db.tables, before);
});

test('saveImageMetadata is idempotent when the owner registers the same file again', async () => {
  const { ctx, db } = setup('clerk_owner');
  const before = snapshot(db);
  await saveImageMetadata(ctx, registerArgs('_storage|ownedPublic'));
  assert.deepEqual(db.tables.storageFiles, before.storageFiles);
});

test('saveImageMetadata lets the owner make their own public file private', async () => {
  const { ctx, db } = setup('clerk_owner');
  await saveImageMetadata(ctx, registerArgs('_storage|ownedPublic', { purpose: 'private' }));
  const row = db.tables.storageFiles?.find((candidate) => candidate.storageId === '_storage|ownedPublic');
  assert.equal(row?.purpose, 'private');
});

test('saveImageMetadata never lowers a private file back to public', async () => {
  const { ctx, db } = setup('clerk_owner');
  await saveImageMetadata(ctx, registerArgs('_storage|ownedPrivate', { purpose: 'public' }));
  const row = db.tables.storageFiles?.find((candidate) => candidate.storageId === '_storage|ownedPrivate');
  assert.equal(row?.purpose, 'private');
});

// deleteFile: the recorded owner or an admin only, checked before any write.
test('deleteFile lets the owner delete their own file from storage and the ownership table', async () => {
  const { ctx, db, calls } = setup('clerk_owner');
  await deleteFile(ctx, { storageId: '_storage|ownedPublic' });
  assert.deepEqual(calls, ['delete:_storage|ownedPublic']);
  assert.equal(
    db.tables._storage?.some((row) => row._id === '_storage|ownedPublic'),
    false,
  );
  assert.equal(
    db.tables.storageFiles?.some((row) => row.storageId === '_storage|ownedPublic'),
    false,
  );
});

test('deleteFile lets an admin delete a file owned by someone else', async () => {
  const { ctx, db, calls } = setup('clerk_admin');
  await deleteFile(ctx, { storageId: '_storage|ownedPrivate' });
  assert.deepEqual(calls, ['delete:_storage|ownedPrivate']);
  assert.equal(
    db.tables.storageFiles?.some((row) => row.storageId === '_storage|ownedPrivate'),
    false,
  );
});

for (const denial of DENIALS) {
  test(`deleteFile refuses a ${denial.label} caller and changes nothing`, async () => {
    const { ctx, db, calls } = setup(denial.subject);
    const before = snapshot(db);
    await assert.rejects(deleteFile(ctx, { storageId: '_storage|ownedPublic' }), { message: denial.message });
    assert.deepEqual(calls, []);
    assert.deepEqual(db.tables, before);
  });
}

for (const [label, subject] of [
  ['an unrelated user', 'clerk_other'],
  ['a catalog manager', 'clerk_catalog'],
  ['a moderator', 'clerk_moderator'],
] as const) {
  test(`deleteFile refuses ${label} for a file owned by someone else and changes nothing`, async () => {
    const { ctx, db, calls } = setup(subject);
    const before = snapshot(db);
    await assert.rejects(deleteFile(ctx, { storageId: '_storage|ownedPublic' }), { message: 'Unauthorized' });
    assert.deepEqual(calls, []);
    assert.deepEqual(db.tables, before);
  });
}

test('deleteFile lets an admin delete a legacy file with no ownership row', async () => {
  const { ctx, db, calls } = setup('clerk_admin');
  await deleteFile(ctx, { storageId: '_storage|legacy' });
  assert.deepEqual(calls, ['delete:_storage|legacy']);
  assert.equal(
    db.tables._storage?.some((row) => row._id === '_storage|legacy'),
    false,
  );
});

for (const [label, subject] of [
  ['an unrelated user', 'clerk_other'],
  ['a moderator', 'clerk_moderator'],
  ['a catalog manager', 'clerk_catalog'],
] as const) {
  test(`deleteFile refuses ${label} for a legacy file with no ownership row and changes nothing`, async () => {
    const { ctx, db, calls } = setup(subject);
    const before = snapshot(db);
    await assert.rejects(deleteFile(ctx, { storageId: '_storage|legacy' }), { message: 'Unauthorized' });
    assert.deepEqual(calls, []);
    assert.deepEqual(db.tables, before);
  });
}

// getUrl / getUrls: legacy and public files resolve for everyone; private files resolve for the owner and reviewers.
test('getUrl resolves a legacy file and a public file for an anonymous caller', async () => {
  const { ctx } = setup(null);
  assert.equal(await getUrl(ctx, { storageId: '_storage|legacy' }), 'https://files.invalid/_storage|legacy');
  assert.equal(await getUrl(ctx, { storageId: '_storage|ownedPublic' }), 'https://files.invalid/_storage|ownedPublic');
});

test('getUrl returns null for an anonymous caller asking for a private file, without resolving it', async () => {
  const { ctx, calls } = setup(null);
  assert.equal(await getUrl(ctx, { storageId: '_storage|ownedPrivate' }), null);
  assert.deepEqual(calls, []);
});

for (const [label, subject] of [
  ['an unrelated user', 'clerk_other'],
  ['a catalog manager', 'clerk_catalog'],
  ['a banned owner', 'clerk_banned'],
] as const) {
  test(`getUrl returns null for ${label} asking for a private file`, async () => {
    const { ctx, calls } = setup(subject);
    assert.equal(await getUrl(ctx, { storageId: '_storage|ownedPrivate' }), null);
    assert.deepEqual(calls, []);
  });
}

for (const [label, subject] of [
  ['the owner', 'clerk_owner'],
  ['an admin', 'clerk_admin'],
  ['a moderator', 'clerk_moderator'],
] as const) {
  test(`getUrl resolves a private file for ${label}`, async () => {
    const { ctx } = setup(subject);
    assert.equal(
      await getUrl(ctx, { storageId: '_storage|ownedPrivate' }),
      'https://files.invalid/_storage|ownedPrivate',
    );
  });
}

test('getUrl returns null for an id that is not in storage', async () => {
  const { ctx } = setup('clerk_owner');
  assert.equal(await getUrl(ctx, { storageId: '_storage|missing' }), null);
});

test('getUrls drops the private files an anonymous caller cannot read and keeps the rest', async () => {
  const { ctx } = setup(null);
  assert.deepEqual(
    await getUrls(ctx, { storageIds: ['_storage|ownedPrivate', '_storage|legacy', '_storage|ownedPublic'] }),
    ['https://files.invalid/_storage|legacy', 'https://files.invalid/_storage|ownedPublic'],
  );
});

test('getUrls returns a private file to its owner', async () => {
  const { ctx } = setup('clerk_owner');
  assert.deepEqual(await getUrls(ctx, { storageIds: ['_storage|ownedPrivate'] }), [
    'https://files.invalid/_storage|ownedPrivate',
  ]);
});

// Ownership binds each file to the account that registered it. Two accounts register two different files; each row
// records its own registrant, and neither account can read or delete the other's private file.
function twoFileTables(): Tables {
  const tables = fixtureTables();
  tables._storage?.push(
    { _id: '_storage|ownerFile', _creationTime: RECENT },
    { _id: '_storage|otherFile', _creationTime: RECENT },
  );
  return tables;
}

function registeredOwner(db: Db, storageId: string): unknown {
  return db.tables.storageFiles?.find((row) => row.storageId === storageId)?.ownerUserId;
}

test('two accounts registering different files each become the recorded owner of their own file', async () => {
  const { db, calls } = setup(null, twoFileTables());

  await saveImageMetadata(
    contextFor(db, calls, 'clerk_owner'),
    registerArgs('_storage|ownerFile', { purpose: 'private' }),
  );
  await saveImageMetadata(
    contextFor(db, calls, 'clerk_other'),
    registerArgs('_storage|otherFile', { purpose: 'private' }),
  );

  assert.equal(registeredOwner(db, '_storage|ownerFile'), 'users|owner');
  assert.equal(registeredOwner(db, '_storage|otherFile'), 'users|other');
});

test('neither account can read the other private file, and each account reads its own', async () => {
  const { db, calls } = setup(null, twoFileTables());
  await saveImageMetadata(
    contextFor(db, calls, 'clerk_owner'),
    registerArgs('_storage|ownerFile', { purpose: 'private' }),
  );
  await saveImageMetadata(
    contextFor(db, calls, 'clerk_other'),
    registerArgs('_storage|otherFile', { purpose: 'private' }),
  );
  calls.length = 0;

  assert.equal(await getUrl(contextFor(db, calls, 'clerk_other'), { storageId: '_storage|ownerFile' }), null);
  assert.equal(await getUrl(contextFor(db, calls, 'clerk_owner'), { storageId: '_storage|otherFile' }), null);
  assert.deepEqual(calls, []);
  assert.equal(
    await getUrl(contextFor(db, calls, 'clerk_other'), { storageId: '_storage|otherFile' }),
    'https://files.invalid/_storage|otherFile',
  );
});

test('neither account can delete the other file, and each account deletes only its own', async () => {
  const { db, calls } = setup(null, twoFileTables());
  await saveImageMetadata(
    contextFor(db, calls, 'clerk_owner'),
    registerArgs('_storage|ownerFile', { purpose: 'private' }),
  );
  await saveImageMetadata(
    contextFor(db, calls, 'clerk_other'),
    registerArgs('_storage|otherFile', { purpose: 'private' }),
  );
  calls.length = 0;
  const before = snapshot(db);

  await assert.rejects(deleteFile(contextFor(db, calls, 'clerk_owner'), { storageId: '_storage|otherFile' }), {
    message: 'Unauthorized',
  });
  await assert.rejects(deleteFile(contextFor(db, calls, 'clerk_other'), { storageId: '_storage|ownerFile' }), {
    message: 'Unauthorized',
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(db.tables, before);

  await deleteFile(contextFor(db, calls, 'clerk_other'), { storageId: '_storage|otherFile' });
  assert.deepEqual(calls, ['delete:_storage|otherFile']);
  assert.equal(registeredOwner(db, '_storage|ownerFile'), 'users|owner');
});
