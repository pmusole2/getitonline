import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Containment: these functions must stay internal (not callable from clients) until
// authenticated replacements ship. Role, ban, and wallet-freeze functions were restored
// with actor checks in milestone 1 (see authorization.test.ts). See the migration spec.
const LOCKED_FUNCTIONS: Record<string, string[]> = {
  'paymentInboxPolling.ts': ['checkpoint', 'exhaustion'],
  'paymentPolling.ts': ['checkpoint', 'exhaustion'],
  'lencoWebhookData.ts': ['ingest', 'recordResult'],
  'wallet.ts': [
    'creditWallet',
    'debitWallet',
    'updateWithdrawalStatus',
    'updateTransactionExternalReference',
    'updateWalletTransactionByLencoId',
  ],
  'transactions.ts': [
    'createTransaction',
    'updateTransactionLencoIds',
    'updateTransactionStatus',
    'updateTransactionByLencoId',
    'createTopUpTransaction',
  ],
  'escrow.ts': ['createEscrowHold', 'releaseFunds', 'refundFull', 'refundPartial', 'markAsDisputed'],
  'orders.ts': ['createOrder', 'markPaidByWallet'],
  'promotions.ts': ['recordPromoCodeRedemption'],
  // Any signed-in or anonymous client could delete every user's favorites for a product id; only internal callers may.
  'favorites.ts': ['removeProductFavorites'],
  'loyalty.ts': ['awardPoints'],
  'seed.ts': ['createInitialAdmin', 'seedAllCategories'],
  'notifications.ts': [
    'createNotification',
    'notifyOrderPlaced',
    'notifyOrderStatusUpdate',
    'notifyDisputeUpdate',
    'notifyNewMessage',
    'notifyFundsReleased',
    'notifyNewReview',
    'notifyProductSold',
  ],
  'messages.ts': ['addSystemMessage'],
  // Any client could overwrite a dispute's AI summary through the public API; only the dispute actions write it now.
  'disputes.ts': ['updateAISummary'],
  // Dead public mutations with no caller; stock and counters change only through internal callers.
  'products.ts': ['decreaseQuantity', 'storeListingModerationResult'],
  'users.ts': ['updateUserRating', 'incrementSales', 'incrementPurchases'],
};

// Client files that must not reference a locked function through the public API.
const CLIENT_FILES = ['../apps/web/src/app/(main)/checkout/page.tsx', '../apps/mobile/src/hooks/useWallet.ts'];

const read = (relativePath: string) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('every containment function is internal, not public', () => {
  for (const [file, names] of Object.entries(LOCKED_FUNCTIONS)) {
    const source = read(file);
    for (const name of names) {
      assert.match(
        source,
        new RegExp(`export const ${name} = internalMutation\\(`),
        `${file}: ${name} must be internalMutation`,
      );
      assert.doesNotMatch(
        source,
        new RegExp(`export const ${name} = mutation\\(`),
        `${file}: ${name} must not be a public mutation`,
      );
    }
  }
});

test('clients do not call containment functions through the public API', () => {
  const moduleNames = Object.keys(LOCKED_FUNCTIONS).map((file) => file.replace('.ts', ''));
  for (const file of CLIENT_FILES) {
    const source = read(file);
    for (const [convexFile, names] of Object.entries(LOCKED_FUNCTIONS)) {
      const moduleName = convexFile.replace('.ts', '');
      if (!moduleNames.includes(moduleName)) {
        continue;
      }
      for (const name of names) {
        assert.doesNotMatch(
          source,
          new RegExp(`api\\.${moduleName}\\.${name}\\b`),
          `${file} must not call api.${moduleName}.${name}`,
        );
      }
    }
  }
});

test('reconciliation has distinct registered internal queries/actions and a strict metadata mutation', async () => {
  const reconciliation = await import('./paymentReconciliation');
  const data = await import('./paymentReconciliationData');
  for (const fn of [reconciliation.reconcileStoredOperation, reconciliation.reconcileAssociatedInbox]) {
    assert.equal(Reflect.get(fn, 'isInternal'), true);
    assert.equal(Reflect.get(fn, 'isAction'), true);
    assert.notEqual(Reflect.get(fn, 'isMutation'), true);
    assert.notEqual(Reflect.get(fn, 'isPublic'), true);
  }
  for (const fn of [data.getOperation, data.getOwnedOperation, data.getInboxWork]) {
    assert.equal(Reflect.get(fn, 'isInternal'), true);
    assert.equal(Reflect.get(fn, 'isQuery'), true);
    assert.notEqual(Reflect.get(fn, 'isMutation'), true);
    assert.notEqual(Reflect.get(fn, 'isPublic'), true);
  }
  assert.equal(Reflect.get(data.recordLookupResult, 'isInternal'), true);
  assert.equal(Reflect.get(data.recordLookupResult, 'isMutation'), true);
  assert.equal(Reflect.get(reconciliation.refresh, 'isPublic'), true);
  assert.equal(Reflect.get(reconciliation.refresh, 'isAction'), true);
  assert.equal(Reflect.get(reconciliation.getStatus, 'isPublic'), true);
  assert.equal(Reflect.get(reconciliation.getStatus, 'isQuery'), true);
  const schema = read('schema.ts');
  const inbox = schema.slice(schema.indexOf('lencoWebhookInbox: defineTable('), schema.indexOf('// Users table'));
  assert.match(inbox, /lookupCompletedAt: v.optional\(v.number\(\)\)/);
  assert.match(inbox, /lookupResult: v.optional\(webhookResultValidator\)/);
  assert.doesNotMatch(inbox, /rawPayload|receipt:|providerId:|providerReference:|phone:/);
  const { validateArgs } = await import('../tests/support/convexFakeActionCtx');
  assert.throws(
    () =>
      validateArgs(
        reconciliation.reconcileStoredOperation,
        { operationId: 'paymentOperations|1', ownerId: 'users|1' },
        'internal operation',
      ),
    /Argument validation failed/,
  );
  assert.throws(
    () =>
      validateArgs(
        reconciliation.reconcileAssociatedInbox,
        { inboxId: 'lencoWebhookInbox|1', receipt: {} },
        'internal inbox',
      ),
    /Argument validation failed/,
  );
  assert.throws(
    () =>
      validateArgs(
        data.recordLookupResult,
        {
          inboxId: 'lencoWebhookInbox|1',
          bodyDigest: 'digest',
          operationId: 'paymentOperations|1',
          eventKind: 'collection_successful',
          classification: 'terminal',
          result: 'applied',
          verified: true,
        },
        'metadata',
      ),
    /Argument validation failed/,
  );
});

test('financial poll callbacks are strict internal mutation identifiers with no supplied financial authority', async () => {
  const polling = await import('./paymentPolling');
  const { validateArgs } = await import('../tests/support/convexFakeActionCtx');
  const args = { pollId: 'paymentFinancialPolls|1', operationId: 'paymentOperations|1', generation: 1, index: 0 };
  for (const fn of [polling.checkpoint, polling.exhaustion]) {
    assert.equal(Reflect.get(fn, 'isInternal'), true);
    assert.equal(Reflect.get(fn, 'isMutation'), true);
    assert.notEqual(Reflect.get(fn, 'isPublic'), true);
    assert.deepEqual(validateArgs(fn, args, 'poll'), args);
    for (const key of ['ownerId', 'status', 'receipt', 'amountCents', 'clock', 'deadline', 'verified']) {
      assert.throws(() => validateArgs(fn, { ...args, [key]: 'supplied' }, 'poll'), /Argument validation failed/);
    }
    for (const override of [{ pollId: 'users|1' }, { operationId: 'users|1' }, { generation: '1' }, { index: '0' }]) {
      assert.throws(() => validateArgs(fn, { ...args, ...override }, 'poll'), /Argument validation failed/);
    }
  }
  const schema = (await import('./schema')).default;
  const table = schema.tables.paymentFinancialPolls;
  const validator = Reflect.get(table, 'validator');
  assert.ok(validator);
  const { internalMutation } = await import('./_generated/server');
  const schemaProbe = internalMutation({ args: validator, handler: async () => null });
  const metadata = {
    operationId: 'paymentOperations|1',
    origin: 1,
    generation: 1,
    nextIndex: 0,
    dispatchedCount: 0,
    dueAt: 30_001,
    state: 'active',
    jobId: '_scheduled_functions|1',
  };
  assert.deepEqual(validateArgs(schemaProbe, metadata, 'poll schema'), metadata);
  for (const override of [
    { state: 'successful' },
    { jobId: 'users|1' },
    { ownerId: 'users|1' },
    { rawPayload: '{}' },
  ]) {
    assert.throws(
      () => validateArgs(schemaProbe, { ...metadata, ...override }, 'poll schema'),
      /Argument validation failed/,
    );
  }
});

test('inbox acquisition callbacks and NONPII table have strict registered internal resource contracts', async () => {
  const polling = await import('./paymentInboxPolling');
  const { validateArgs } = await import('../tests/support/convexFakeActionCtx');
  const args = { pollId: 'paymentInboxPolls|1', inboxId: 'lencoWebhookInbox|1', generation: 1, index: 0 };
  for (const fn of [polling.checkpoint, polling.exhaustion]) {
    assert.equal(Reflect.get(fn, 'isInternal'), true);
    assert.equal(Reflect.get(fn, 'isMutation'), true);
    assert.notEqual(Reflect.get(fn, 'isPublic'), true);
    assert.deepEqual(validateArgs(fn, args, 'inbox poll'), args);
    for (const key of ['operationId', 'ownerId', 'status', 'receipt', 'amountCents', 'clock', 'deadline', 'verified']) {
      assert.throws(() => validateArgs(fn, { ...args, [key]: 'supplied' }, 'inbox poll'), /Argument validation failed/);
    }
    for (const override of [{ pollId: 'users|1' }, { inboxId: 'users|1' }, { generation: '1' }, { index: '0' }]) {
      assert.throws(() => validateArgs(fn, { ...args, ...override }, 'inbox poll'), /Argument validation failed/);
    }
  }
  const schema = (await import('./schema')).default;
  const table = schema.tables.paymentInboxPolls;
  const validator = Reflect.get(table, 'validator');
  assert.ok(validator);
  const { internalMutation } = await import('./_generated/server');
  const probe = internalMutation({ args: validator, handler: async () => null });
  const metadata = {
    inboxId: 'lencoWebhookInbox|1',
    operationId: 'paymentOperations|1',
    bodyDigest: 'a'.repeat(64),
    eventKind: 'transfer_successful',
    classification: 'lookup_required',
    origin: 1,
    generation: 1,
    nextIndex: 0,
    dispatchedCount: 0,
    dueAt: 1,
    state: 'active',
    jobId: '_scheduled_functions|1',
  };
  assert.deepEqual(validateArgs(probe, metadata, 'inbox poll schema'), metadata);
  const exportArgs: unknown = Reflect.get(probe, 'exportArgs');
  assert.ok(typeof exportArgs === 'function');
  const serialized: unknown = JSON.parse(exportArgs());
  assert.ok(typeof serialized === 'object' && serialized !== null);
  const shape: unknown = Reflect.get(serialized, 'value');
  assert.ok(typeof shape === 'object' && shape !== null);
  const fields = Object.keys(shape).sort();
  assert.deepEqual(fields, Object.keys(metadata).sort(), 'exact minimal metadata whitelist');
  for (const override of [
    { state: 'successful' },
    { jobId: 'users|1' },
    { inboxId: 'users|1' },
    { operationId: 'users|1' },
    { eventKind: 'other' },
    { classification: 'other' },
    { ownerId: 'users|1' },
    { rawPayload: '{}' },
    { phone: 'synthetic' },
    { receipt: {} },
    { providerReference: 'synthetic' },
  ]) {
    assert.throws(
      () => validateArgs(probe, { ...metadata, ...override }, 'inbox poll schema'),
      /Argument validation failed/,
    );
  }
});
