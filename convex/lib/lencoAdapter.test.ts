import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, createHmac } from 'node:crypto';

import {
  LENCO_BASE_URL,
  LENCO_TIMEOUT_MS,
  ZAMBIA_OPERATORS,
  centsToMajorUnits,
  createLencoAdapter,
  formatCentsToDecimal,
  isPositiveSafeCents,
  isSupportedOperator,
  isValidPhone,
  isValidProviderId,
  isValidReference,
  normalizeReceiptStatus,
  parseMajorDecimalToCents,
  type JsonValue,
  type LencoFetch,
  type LencoFetchInit,
} from './lencoAdapter';

// The adapter is exercised through its real factory with a scripted fake fetch. Each step is one HTTP
// attempt; a 'hang' step only settles when the adapter aborts it, so timeout and retry behavior runs
// through the real AbortController. Fixtures follow the published Lenco v2 shapes (nested
// mobileMoneyDetails/creditAccount, type/bearer/country facts, required transfer fee, id/name/country
// bank records) with synthetic values only: no real credentials, personal data, or docs samples.

const API_KEY = 'synthetic-bearer-token-for-adapter-tests-001';
const DEBIT_ACCOUNT = '123e4567-e89b-12d3-a456-426614174001';
const PROVIDER_ID = '123e4567-e89b-12d3-a456-426614174000';
const OTHER_ID = '123e4567-e89b-12d3-a456-426614174999';
const PHONE = '0971234567';
const BANK_ID = '007';
const BANK_ACCOUNT = '0123456789';

type Step = { kind: 'respond'; status: number; text: string } | { kind: 'throw'; message: string } | { kind: 'hang' };

type Call = { url: string; init: LencoFetchInit };

function jsonBody(body: unknown): string {
  return JSON.stringify(body);
}

function respond(status: number, body: unknown): Step {
  return { kind: 'respond', status, text: jsonBody(body) };
}

function envelope(data: unknown): { status: boolean; data: unknown } {
  return { status: true, data };
}

function officialCollectionData(overrides: Record<string, JsonValue> = {}): Record<string, JsonValue> {
  return {
    id: PROVIDER_ID,
    amount: '10.00',
    fee: '0.25',
    bearer: 'merchant',
    currency: 'ZMW',
    reference: 'SYN-COLL-001',
    type: 'mobile-money',
    status: 'successful',
    reasonForFailure: null,
    settlementStatus: null,
    mobileMoneyDetails: {
      country: 'zm',
      phone: PHONE,
      operator: 'airtel',
      accountName: 'Synthetic Payer',
      operatorTransactionId: null,
    },
    ...overrides,
  };
}

function officialMobileTransferData(overrides: Record<string, JsonValue> = {}): Record<string, JsonValue> {
  return {
    id: PROVIDER_ID,
    amount: '20.00',
    fee: '8.50',
    currency: 'ZMW',
    narration: 'Synthetic narration',
    accountId: DEBIT_ACCOUNT,
    creditAccount: {
      type: 'mobile-money',
      accountName: 'Synthetic Recipient',
      phone: PHONE,
      operator: 'zamtel',
      country: 'zm',
    },
    status: 'successful',
    reasonForFailure: null,
    reference: 'SYN-WDR-MM-001',
    extraData: { nipSessionId: null },
    ...overrides,
  };
}

function officialBankTransferData(overrides: Record<string, JsonValue> = {}): Record<string, JsonValue> {
  return {
    id: PROVIDER_ID,
    amount: '20.00',
    fee: '8.50',
    currency: 'ZMW',
    narration: 'Synthetic narration',
    accountId: DEBIT_ACCOUNT,
    creditAccount: {
      type: 'bank-account',
      accountName: 'Synthetic Recipient',
      accountNumber: BANK_ACCOUNT,
      bank: { id: '002', name: 'Synthetic Bank', country: 'zm' },
    },
    status: 'successful',
    reasonForFailure: null,
    reference: 'SYN-WDR-BK-001',
    extraData: { nipSessionId: null },
    ...overrides,
  };
}

function fakeFetch(steps: Step[]): { fetchImpl: LencoFetch; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  const fetchImpl: LencoFetch = async (url, init) => {
    calls.push({ url, init });
    const step = steps[index++];
    if (!step) {
      throw new Error('unexpected provider attempt');
    }
    if (step.kind === 'throw') {
      throw new Error(step.message);
    }
    if (step.kind === 'hang') {
      return await new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    return new Response(step.text, { status: step.status, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, calls };
}

function hangingBodyFetch(calls: Call[]): LencoFetch {
  return async (url, init) => {
    calls.push({ url, init });
    const response = new Response('unread-body', { status: 200, headers: { 'content-type': 'application/json' } });
    response.text = () =>
      new Promise<string>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    return response;
  };
}

function sentBody(call: Call | undefined): JsonValue {
  assert.ok(call?.init.body !== undefined, 'expected a request body');
  const parsed: JsonValue = JSON.parse(call.init.body);
  return parsed;
}

function sentKeys(call: Call | undefined): string[] {
  const body = sentBody(call);
  assert.ok(typeof body === 'object' && body !== null && !Array.isArray(body));
  return Object.keys(body).sort();
}

function configWith(fetchImpl: LencoFetch, timeoutMs = 500) {
  return createLencoAdapter({ apiKey: API_KEY, debitAccountId: DEBIT_ACCOUNT, timeoutMs }, fetchImpl);
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function webhookSignature(raw: Uint8Array, keyHex: string): string {
  return createHmac('sha512', Buffer.from(keyHex, 'utf8')).update(raw).digest('hex');
}

async function expectCollectionBadResponse(data: Record<string, JsonValue>): Promise<void> {
  const { fetchImpl } = fakeFetch([respond(200, envelope(data))]);
  const result = await configWith(fetchImpl).initiateMobileMoneyCollection({
    reference: 'SYN-COLL-009',
    phone: PHONE,
    operator: 'mtn',
    amountMinor: 100,
  });
  assert.deepEqual(result, { ok: false, code: 'bad_response', outcome: 'unknown', retryable: false });
}

test('money helpers convert cents to numeric major units with a lossless round-trip', () => {
  assert.equal(centsToMajorUnits(1001), 10.01);
  assert.equal(typeof centsToMajorUnits(1001), 'number');
  assert.equal(formatCentsToDecimal(1001), '10.01');
  assert.equal(formatCentsToDecimal(100), '1.00');
  for (const cents of [1, 99, 100, 101, 1001, 250000, 123456789, 9007199254740900]) {
    const major = centsToMajorUnits(cents);
    assert.ok(major !== null, `expected wire amount for ${cents}`);
    assert.notEqual(major, cents);
    assert.equal(parseMajorDecimalToCents(String(major)), cents);
    const canonical = formatCentsToDecimal(cents);
    assert.ok(canonical !== null);
    assert.equal(parseMajorDecimalToCents(canonical), cents);
  }
});

test('money helpers reject non-positive, non-integer, and unsafe cent values', () => {
  assert.equal(isPositiveSafeCents(0), false);
  assert.equal(isPositiveSafeCents(-5), false);
  assert.equal(isPositiveSafeCents(10.5), false);
  assert.equal(isPositiveSafeCents(Number.MAX_SAFE_INTEGER + 1), false);
  assert.equal(centsToMajorUnits(0), null);
  assert.equal(centsToMajorUnits(-100), null);
  assert.equal(centsToMajorUnits(10.5), null);
  assert.equal(centsToMajorUnits(Number.MAX_SAFE_INTEGER), null);
  assert.equal(formatCentsToDecimal(0), null);
});

test('strict decimal parsing accepts only non-negative strings with at most two decimals', () => {
  assert.equal(parseMajorDecimalToCents('0'), 0);
  assert.equal(parseMajorDecimalToCents('10'), 1000);
  assert.equal(parseMajorDecimalToCents('10.01'), 1001);
  assert.equal(parseMajorDecimalToCents('10.1'), 1010);
  assert.equal(parseMajorDecimalToCents('0.00'), 0);
  assert.equal(parseMajorDecimalToCents('007.50'), 750);
  assert.equal(parseMajorDecimalToCents('-1.00'), null);
  assert.equal(parseMajorDecimalToCents('+1.00'), null);
  assert.equal(parseMajorDecimalToCents('1.234'), null);
  assert.equal(parseMajorDecimalToCents('1.'), null);
  assert.equal(parseMajorDecimalToCents('.5'), null);
  assert.equal(parseMajorDecimalToCents(''), null);
  assert.equal(parseMajorDecimalToCents(' 10.00'), null);
  assert.equal(parseMajorDecimalToCents('10.00 '), null);
  assert.equal(parseMajorDecimalToCents('1e3'), null);
  assert.equal(parseMajorDecimalToCents('NaN'), null);
  assert.equal(parseMajorDecimalToCents('10,00'), null);
  assert.equal(parseMajorDecimalToCents('90071992547409.92'), null);
});

test('validators constrain references, provider ids, phones, and operators', () => {
  assert.equal(isValidReference('SYN-COLL-001'), true);
  assert.equal(isValidReference(''), false);
  assert.equal(isValidReference('TOP 1'), false);
  assert.equal(isValidReference('TOP/1'), false);
  assert.equal(isValidReference('TOP+1'), false);
  assert.equal(isValidProviderId(PROVIDER_ID), true);
  assert.equal(isValidProviderId(DEBIT_ACCOUNT), true);
  assert.equal(isValidProviderId('not-a-uuid'), false);
  assert.equal(isValidProviderId(''), false);
  assert.equal(isValidPhone(PHONE), true);
  assert.equal(isValidPhone(''), false);
  assert.equal(isValidPhone('abc'), false);
  for (const operator of ZAMBIA_OPERATORS) {
    assert.equal(isSupportedOperator(operator), true);
  }
  assert.deepEqual([...ZAMBIA_OPERATORS].sort(), ['airtel', 'mtn', 'zamtel']);
  assert.equal(isSupportedOperator('vodafone'), false);
  assert.equal(isSupportedOperator('MTN'), false);
});

test('collection initiation sends the exact whitelisted wire fields with a major-unit amount', async () => {
  const { fetchImpl, calls } = fakeFetch([respond(200, envelope(officialCollectionData()))]);
  const adapter = configWith(fetchImpl);
  const result = await adapter.initiateMobileMoneyCollection({
    reference: 'SYN-COLL-001',
    phone: PHONE,
    operator: 'airtel',
    amountMinor: 1000,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, `${LENCO_BASE_URL}/collections/mobile-money`);
  assert.equal(calls[0]?.init.method, 'POST');
  assert.equal(calls[0]?.init.headers['Authorization'], `Bearer ${API_KEY}`);
  assert.deepEqual(sentKeys(calls[0]), ['amount', 'country', 'operator', 'phone', 'reference']);
  const body = sentBody(calls[0]);
  assert.deepEqual(body, { amount: 10, reference: 'SYN-COLL-001', phone: PHONE, operator: 'airtel', country: 'zm' });
  assert.ok(result.ok);
  assert.deepEqual(result.value, {
    kind: 'collection',
    id: PROVIDER_ID,
    reference: 'SYN-COLL-001',
    amountMinor: 1000,
    feeMinor: 25,
    currency: 'ZMW',
    status: 'successful',
    collectionType: 'mobile-money',
    country: 'zm',
    bearer: 'merchant',
    operator: 'airtel',
    phone: PHONE,
    reasonForFailure: null,
    settlementStatus: null,
  });
});

test('collection initiation never sends the cents integer as the provider amount', async () => {
  const { fetchImpl, calls } = fakeFetch([respond(200, envelope(officialCollectionData({ amount: '25.50' })))]);
  const adapter = configWith(fetchImpl);
  const result = await adapter.initiateMobileMoneyCollection({
    reference: 'SYN-COLL-002',
    phone: PHONE,
    operator: 'airtel',
    amountMinor: 2550,
  });
  assert.ok(result.ok);
  const body = sentBody(calls[0]);
  assert.ok(typeof body === 'object' && body !== null && !Array.isArray(body));
  assert.equal(body['amount'], 25.5);
  assert.notEqual(body['amount'], 2550);
});

test('collections do not require a debit account but transfers do', async () => {
  const collect = fakeFetch([respond(200, envelope(officialCollectionData()))]);
  const withoutDebit = createLencoAdapter({ apiKey: API_KEY, timeoutMs: 500 }, collect.fetchImpl);
  const collection = await withoutDebit.initiateMobileMoneyCollection({
    reference: 'SYN-COLL-003',
    phone: PHONE,
    operator: 'zamtel',
    amountMinor: 500,
  });
  assert.ok(collection.ok);

  const mobileFetch = fakeFetch([respond(200, envelope(officialMobileTransferData()))]);
  const missingDebit = createLencoAdapter({ apiKey: API_KEY, timeoutMs: 500 }, mobileFetch.fetchImpl);
  const mobileTransfer = await missingDebit.initiateMobileMoneyTransfer({
    reference: 'SYN-WDR-MM-002',
    phone: PHONE,
    operator: 'mtn',
    amountMinor: 500,
  });
  assert.deepEqual(mobileTransfer, { ok: false, code: 'missing_config', outcome: 'not_started', retryable: false });
  assert.equal(mobileFetch.calls.length, 0);

  const bankFetch = fakeFetch([respond(200, envelope(officialBankTransferData()))]);
  const missingDebitBank = createLencoAdapter({ apiKey: API_KEY, timeoutMs: 500 }, bankFetch.fetchImpl);
  const bankTransfer = await missingDebitBank.initiateBankTransfer({
    reference: 'SYN-WDR-BK-002',
    bankId: BANK_ID,
    accountNumber: BANK_ACCOUNT,
    amountMinor: 500,
  });
  assert.deepEqual(bankTransfer, { ok: false, code: 'missing_config', outcome: 'not_started', retryable: false });
  assert.equal(bankFetch.calls.length, 0);
});

test('a non-UUID configured debit account fails before any provider attempt', async () => {
  const { fetchImpl, calls } = fakeFetch([respond(200, envelope(officialMobileTransferData()))]);
  const adapter = createLencoAdapter(
    { apiKey: API_KEY, debitAccountId: 'synthetic-debit-account-001', timeoutMs: 500 },
    fetchImpl,
  );
  assert.equal(adapter.configured, false);
  const result = await adapter.initiateMobileMoneyTransfer({
    reference: 'SYN-WDR-MM-003',
    phone: PHONE,
    operator: 'mtn',
    amountMinor: 500,
  });
  assert.deepEqual(result, { ok: false, code: 'invalid_config', outcome: 'not_started', retryable: false });
  assert.equal(calls.length, 0);
});

test('mobile-money transfer sends the configured accountId, major units, and an explicit country', async () => {
  const { fetchImpl, calls } = fakeFetch([respond(200, envelope(officialMobileTransferData()))]);
  const adapter = configWith(fetchImpl);
  const result = await adapter.initiateMobileMoneyTransfer({
    reference: 'SYN-WDR-MM-001',
    phone: PHONE,
    operator: 'zamtel',
    amountMinor: 2000,
  });
  assert.ok(result.ok);
  assert.equal(calls[0]?.url, `${LENCO_BASE_URL}/transfers/mobile-money`);
  assert.deepEqual(sentKeys(calls[0]), ['accountId', 'amount', 'country', 'operator', 'phone', 'reference']);
  const body = sentBody(calls[0]);
  assert.ok(typeof body === 'object' && body !== null && !Array.isArray(body));
  assert.equal(body['accountId'], DEBIT_ACCOUNT);
  assert.equal(body['amount'], 20);
  assert.equal(body['country'], 'zm');
  assert.equal(body['currency'], undefined);
  assert.equal(body['accountName'], undefined);
  assert.deepEqual(result.value, {
    kind: 'transfer',
    id: PROVIDER_ID,
    reference: 'SYN-WDR-MM-001',
    amountMinor: 2000,
    feeMinor: 850,
    currency: 'ZMW',
    status: 'successful',
    transferType: 'mobile-money',
    debitAccountId: DEBIT_ACCOUNT,
    destination: { kind: 'mobile-money', phone: PHONE, operator: 'zamtel', country: 'zm' },
    reasonForFailure: null,
    settlementStatus: null,
  });
});

test('bank transfer keeps bank identifiers as strings and omits currency and accountName', async () => {
  const { fetchImpl, calls } = fakeFetch([respond(200, envelope(officialBankTransferData()))]);
  const adapter = configWith(fetchImpl);
  const result = await adapter.initiateBankTransfer({
    reference: 'SYN-WDR-BK-001',
    bankId: BANK_ID,
    accountNumber: BANK_ACCOUNT,
    amountMinor: 2000,
  });
  assert.ok(result.ok);
  assert.equal(calls[0]?.url, `${LENCO_BASE_URL}/transfers/bank-account`);
  assert.deepEqual(sentKeys(calls[0]), ['accountId', 'accountNumber', 'amount', 'bankId', 'reference']);
  const body = sentBody(calls[0]);
  assert.ok(typeof body === 'object' && body !== null && !Array.isArray(body));
  assert.equal(body['bankId'], '007');
  assert.equal(typeof body['bankId'], 'string');
  assert.equal(body['accountNumber'], BANK_ACCOUNT);
  assert.deepEqual(result.value, {
    kind: 'transfer',
    id: PROVIDER_ID,
    reference: 'SYN-WDR-BK-001',
    amountMinor: 2000,
    feeMinor: 850,
    currency: 'ZMW',
    status: 'successful',
    transferType: 'bank-account',
    debitAccountId: DEBIT_ACCOUNT,
    destination: { kind: 'bank-account', bankId: '002', accountNumber: BANK_ACCOUNT, country: 'zm' },
    reasonForFailure: null,
    settlementStatus: null,
  });
});

test('a per-call debit account id cannot change the outbound debit account', async () => {
  const { fetchImpl, calls } = fakeFetch([respond(200, envelope(officialMobileTransferData()))]);
  const adapter = configWith(fetchImpl);
  const sneaky = {
    reference: 'SYN-WDR-MM-004',
    phone: PHONE,
    operator: 'mtn',
    amountMinor: 500,
    debitAccountId: '99999999-9999-4999-8999-999999999999',
  };
  const result = await adapter.initiateMobileMoneyTransfer(sneaky);
  assert.ok(result.ok);
  const body = sentBody(calls[0]);
  assert.ok(typeof body === 'object' && body !== null && !Array.isArray(body));
  assert.equal(body['accountId'], DEBIT_ACCOUNT);
  assert.notEqual(body['accountId'], sneaky.debitAccountId);
  assert.equal(result.value.debitAccountId, DEBIT_ACCOUNT);
});

test('missing configuration fails safe before any provider attempt', async () => {
  for (const adapter of [
    createLencoAdapter({ apiKey: '' }, async () => {
      throw new Error('must not be called');
    }),
    createLencoAdapter({ apiKey: '   ' }, async () => {
      throw new Error('must not be called');
    }),
  ]) {
    assert.equal(adapter.configured, false);
    const collection = await adapter.initiateMobileMoneyCollection({
      reference: 'SYN-COLL-004',
      phone: PHONE,
      operator: 'mtn',
      amountMinor: 100,
    });
    assert.deepEqual(collection, { ok: false, code: 'missing_config', outcome: 'not_started', retryable: false });
    assert.equal(await adapter.verifyWebhookSignature(new Uint8Array([1]), null), false);
  }
});

test('header-unsafe bearer values fail as invalid configuration without a provider attempt', async () => {
  let attempts = 0;
  const counting: LencoFetch = async () => {
    attempts += 1;
    return new Response('{}', { status: 200 });
  };
  for (const apiKey of ['synthetic-key\ninjected', 'synthetic-key\rinjected', 'synthetic-key\x00', 'padded-key ']) {
    const adapter = createLencoAdapter({ apiKey, debitAccountId: DEBIT_ACCOUNT }, counting);
    assert.equal(adapter.configured, false);
    const result = await adapter.initiateMobileMoneyCollection({
      reference: 'SYN-COLL-005',
      phone: PHONE,
      operator: 'mtn',
      amountMinor: 100,
    });
    assert.deepEqual(result, { ok: false, code: 'invalid_config', outcome: 'not_started', retryable: false });
  }
  assert.equal(attempts, 0);
});

test('unsupported base URLs fail as invalid configuration without a provider attempt', async () => {
  let attempts = 0;
  const counting: LencoFetch = async () => {
    attempts += 1;
    return new Response('{}', { status: 200 });
  };
  for (const baseUrl of [
    'http://api.lenco.co/access/v2',
    'https://user@example.com',
    'https://user:secret@example.com/access/v2',
    'https://example.com/access/v2?apiKey=synthetic-secret',
    'https://example.com/access/v2#fragment',
    'not-a-url',
    'https://',
  ]) {
    const adapter = createLencoAdapter({ apiKey: API_KEY, baseUrl }, counting);
    assert.equal(adapter.configured, false);
    const result = await adapter.listBanks();
    assert.deepEqual(result, { ok: false, code: 'invalid_config', outcome: 'not_started', retryable: false });
  }
  assert.equal(attempts, 0);
});

test('invalid inputs fail before any provider attempt', async () => {
  const { fetchImpl, calls } = fakeFetch([respond(200, envelope(officialCollectionData()))]);
  const adapter = configWith(fetchImpl);
  const badInputs = [
    adapter.initiateMobileMoneyCollection({ reference: 'bad ref', phone: PHONE, operator: 'mtn', amountMinor: 100 }),
    adapter.initiateMobileMoneyCollection({
      reference: 'SYN-COLL-006',
      phone: PHONE,
      operator: 'vodafone',
      amountMinor: 100,
    }),
    adapter.initiateMobileMoneyCollection({
      reference: 'SYN-COLL-006',
      phone: 'abc',
      operator: 'mtn',
      amountMinor: 100,
    }),
    adapter.initiateMobileMoneyCollection({ reference: 'SYN-COLL-006', phone: PHONE, operator: 'mtn', amountMinor: 0 }),
    adapter.getCollectionById('not-a-uuid'),
    adapter.getCollectionByReference(''),
    adapter.getTransferById('123'),
    adapter.initiateBankTransfer({
      reference: 'SYN-WDR-BK-003',
      bankId: '',
      accountNumber: BANK_ACCOUNT,
      amountMinor: 100,
    }),
    adapter.resolveMobileMoney({ phone: PHONE, operator: 'vodafone' }),
  ];
  for (const pending of badInputs) {
    assert.deepEqual(await pending, { ok: false, code: 'invalid_input', outcome: 'not_started', retryable: false });
  }
  assert.equal(calls.length, 0);
});

test('status lookups use id and encoded-reference status routes', async () => {
  const steps = [
    respond(200, envelope(officialCollectionData())),
    respond(200, envelope(officialCollectionData({ reference: 'SYN-COLL-007' }))),
    respond(200, envelope(officialMobileTransferData())),
  ];
  const { fetchImpl, calls } = fakeFetch(steps);
  const adapter = configWith(fetchImpl);
  assert.ok((await adapter.getCollectionById(PROVIDER_ID)).ok);
  assert.ok((await adapter.getCollectionByReference('SYN-COLL-007')).ok);
  assert.ok((await adapter.getTransferByReference('SYN-WDR-MM-001')).ok);
  assert.equal(calls[0]?.url, `${LENCO_BASE_URL}/collections/${PROVIDER_ID}`);
  assert.equal(calls[1]?.url, `${LENCO_BASE_URL}/collections/status/${encodeURIComponent('SYN-COLL-007')}`);
  assert.equal(calls[2]?.url, `${LENCO_BASE_URL}/transfers/status/${encodeURIComponent('SYN-WDR-MM-001')}`);
  for (const call of calls) {
    assert.equal(call.init.method, 'GET');
    assert.equal(call.init.body, undefined);
    assert.equal(call.init.headers['Authorization'], `Bearer ${API_KEY}`);
  }
});

test('every request disables redirects and carries the bearer token', async () => {
  const steps = [
    respond(200, envelope(officialCollectionData())),
    respond(200, envelope(officialMobileTransferData())),
    respond(200, envelope(officialCollectionData())),
    respond(200, envelope([{ id: '002', name: 'Synthetic Bank', country: 'zm' }])),
    respond(200, envelope({ type: 'mobile-money', accountName: null, phone: PHONE, operator: 'mtn', country: 'zm' })),
    respond(
      200,
      envelope({
        type: 'bank-account',
        accountName: null,
        accountNumber: BANK_ACCOUNT,
        bank: { id: '002', name: 'Synthetic Bank', country: 'zm' },
      }),
    ),
  ];
  const { fetchImpl, calls } = fakeFetch(steps);
  const adapter = configWith(fetchImpl);
  assert.ok(
    (
      await adapter.initiateMobileMoneyCollection({
        reference: 'SYN-COLL-008',
        phone: PHONE,
        operator: 'mtn',
        amountMinor: 100,
      })
    ).ok,
  );
  assert.ok(
    (
      await adapter.initiateMobileMoneyTransfer({
        reference: 'SYN-WDR-MM-005',
        phone: PHONE,
        operator: 'mtn',
        amountMinor: 100,
      })
    ).ok,
  );
  assert.ok((await adapter.getCollectionByReference('SYN-COLL-001')).ok);
  assert.ok((await adapter.listBanks()).ok);
  assert.ok((await adapter.resolveMobileMoney({ phone: PHONE, operator: 'mtn' })).ok);
  assert.ok((await adapter.resolveBankAccount({ accountNumber: BANK_ACCOUNT, bankId: '002' })).ok);
  assert.equal(calls.length, 6);
  for (const call of calls) {
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.headers['Authorization'], `Bearer ${API_KEY}`);
  }
});

test('null collection fee and reference are preserved instead of defaulted', async () => {
  const data = officialCollectionData({ reference: null, fee: null });
  const { fetchImpl } = fakeFetch([respond(200, envelope(data))]);
  const result = await configWith(fetchImpl).initiateMobileMoneyCollection({
    reference: 'SYN-COLL-009',
    phone: PHONE,
    operator: 'mtn',
    amountMinor: 1000,
  });
  assert.ok(result.ok);
  assert.equal(result.value.reference, null);
  assert.equal(result.value.feeMinor, null);
});

test('only successful and failed are terminal; aliases and challenges stay pending', async () => {
  const cases: Array<{ status: string; expected: 'successful' | 'failed' | 'pending' }> = [
    { status: 'successful', expected: 'successful' },
    { status: 'Successful', expected: 'successful' },
    { status: '  failed  ', expected: 'failed' },
    { status: 'pending', expected: 'pending' },
    { status: 'processing', expected: 'pending' },
    { status: 'pay-offline', expected: 'pending' },
    { status: 'otp-required', expected: 'pending' },
    { status: '3ds-auth-required', expected: 'pending' },
    { status: 'paid', expected: 'pending' },
    { status: 'success', expected: 'pending' },
    { status: 'completed', expected: 'pending' },
    { status: 'complete', expected: 'pending' },
    { status: 'reversed', expected: 'pending' },
    { status: 'cancelled', expected: 'pending' },
    { status: 'canceled', expected: 'pending' },
    { status: 'declined', expected: 'pending' },
    { status: 'failure', expected: 'pending' },
    { status: 'some-future-status', expected: 'pending' },
  ];
  for (const { status, expected } of cases) {
    assert.equal(normalizeReceiptStatus(status), expected, `status ${status}`);
  }
  const paidCollection = fakeFetch([respond(200, envelope(officialCollectionData({ status: 'paid' })))]);
  const paidResult = await configWith(paidCollection.fetchImpl).initiateMobileMoneyCollection({
    reference: 'SYN-COLL-010',
    phone: PHONE,
    operator: 'mtn',
    amountMinor: 1000,
  });
  assert.ok(paidResult.ok);
  assert.equal(paidResult.value.status, 'pending');

  const reversedTransfer = fakeFetch([respond(200, envelope(officialBankTransferData({ status: 'reversed' })))]);
  const reversedResult = await configWith(reversedTransfer.fetchImpl).initiateBankTransfer({
    reference: 'SYN-WDR-BK-004',
    bankId: BANK_ID,
    accountNumber: BANK_ACCOUNT,
    amountMinor: 2000,
  });
  assert.ok(reversedResult.ok);
  assert.equal(reversedResult.value.status, 'pending');

  assert.equal(normalizeReceiptStatus('pay-offline'), 'pending');
  assert.equal(normalizeReceiptStatus('OTP-REQUIRED'), 'pending');
});

test('a settled settlement flag is preserved as a fact and never upgrades a pending receipt', async () => {
  const data = officialCollectionData({ status: 'pending', settlementStatus: 'settled' });
  const { fetchImpl } = fakeFetch([respond(200, envelope(data))]);
  const result = await configWith(fetchImpl).getCollectionByReference('SYN-COLL-001');
  assert.ok(result.ok);
  assert.equal(result.value.status, 'pending');
  assert.equal(result.value.settlementStatus, 'settled');
});

test('collections require mobile-money type, merchant bearer, and nested payer facts', async () => {
  await expectCollectionBadResponse(officialCollectionData({ type: 'card' }));
  await expectCollectionBadResponse(officialCollectionData({ type: 'bank-account' }));
  await expectCollectionBadResponse(officialCollectionData({ type: null }));
  const missingType = officialCollectionData();
  delete missingType['type'];
  await expectCollectionBadResponse(missingType);
  await expectCollectionBadResponse(officialCollectionData({ bearer: 'customer' }));
  await expectCollectionBadResponse(officialCollectionData({ mobileMoneyDetails: null }));
  const missingDetails = officialCollectionData();
  delete missingDetails['mobileMoneyDetails'];
  await expectCollectionBadResponse(missingDetails);
  await expectCollectionBadResponse(
    officialCollectionData({
      mobileMoneyDetails: {
        country: 'mw',
        phone: PHONE,
        operator: 'airtel',
        accountName: null,
        operatorTransactionId: null,
      },
    }),
  );
  await expectCollectionBadResponse(
    officialCollectionData({
      mobileMoneyDetails: {
        country: 'zm',
        phone: PHONE,
        operator: 'vodafone',
        accountName: null,
        operatorTransactionId: null,
      },
    }),
  );
  await expectCollectionBadResponse(
    officialCollectionData({
      mobileMoneyDetails: {
        country: 'zm',
        phone: 'not-a-phone',
        operator: 'airtel',
        accountName: null,
        operatorTransactionId: null,
      },
    }),
  );
});

test('transfers require a decimal fee, a UUID debit account, and a creditAccount destination', async () => {
  async function expectTransferBadResponse(data: Record<string, JsonValue>, bank: boolean): Promise<void> {
    const { fetchImpl } = fakeFetch([respond(200, envelope(data))]);
    const adapter = configWith(fetchImpl);
    const result = bank
      ? await adapter.initiateBankTransfer({
          reference: 'SYN-WDR-BK-005',
          bankId: BANK_ID,
          accountNumber: BANK_ACCOUNT,
          amountMinor: 2000,
        })
      : await adapter.initiateMobileMoneyTransfer({
          reference: 'SYN-WDR-MM-006',
          phone: PHONE,
          operator: 'mtn',
          amountMinor: 2000,
        });
    assert.deepEqual(result, { ok: false, code: 'bad_response', outcome: 'unknown', retryable: false });
  }

  const missingFee = officialMobileTransferData();
  delete missingFee['fee'];

  await expectTransferBadResponse(missingFee, false);
  await expectTransferBadResponse(officialMobileTransferData({ fee: null }), false);
  await expectTransferBadResponse(officialMobileTransferData({ fee: 'abc' }), false);
  await expectTransferBadResponse(officialMobileTransferData({ fee: '-1.00' }), false);
  await expectTransferBadResponse(officialMobileTransferData({ fee: '8.501' }), false);
  const missingAccount = officialMobileTransferData();
  delete missingAccount['accountId'];
  await expectTransferBadResponse(missingAccount, false);
  await expectTransferBadResponse(officialMobileTransferData({ accountId: 'not-a-uuid' }), false);
  const missingCredit = officialMobileTransferData();
  delete missingCredit['creditAccount'];
  await expectTransferBadResponse(missingCredit, false);
  await expectTransferBadResponse(officialMobileTransferData({ creditAccount: null }), false);
  await expectTransferBadResponse(
    officialMobileTransferData({
      creditAccount: { type: 'card', phone: PHONE, operator: 'zamtel', country: 'zm' },
    }),
    false,
  );
  await expectTransferBadResponse(
    officialMobileTransferData({
      creditAccount: { type: 'mobile-money', phone: PHONE, operator: 'zamtel', country: 'mw' },
    }),
    false,
  );
  await expectTransferBadResponse(
    officialMobileTransferData({
      creditAccount: { type: 'mobile-money', phone: PHONE, operator: 'vodafone', country: 'zm' },
    }),
    false,
  );
  await expectTransferBadResponse(
    officialBankTransferData({
      creditAccount: {
        type: 'bank-account',
        accountName: 'Synthetic Recipient',
        bank: { id: '002', name: 'Synthetic Bank', country: 'zm' },
      },
    }),
    true,
  );
  await expectTransferBadResponse(
    officialBankTransferData({
      creditAccount: {
        type: 'bank-account',
        accountName: 'Synthetic Recipient',
        accountNumber: BANK_ACCOUNT,
        bank: { id: '002', name: 'Synthetic Bank', country: 'ng' },
      },
    }),
    true,
  );
  await expectTransferBadResponse(
    officialBankTransferData({
      creditAccount: {
        type: 'bank-account',
        accountName: 'Synthetic Recipient',
        accountNumber: BANK_ACCOUNT,
        bank: { name: 'Synthetic Bank', country: 'zm' },
      },
    }),
    true,
  );
});

test('a zero transfer fee is valid while collection fees stay nullable', async () => {
  for (const fee of ['0', '0.00']) {
    const { fetchImpl } = fakeFetch([respond(200, envelope(officialMobileTransferData({ fee })))]);
    const result = await configWith(fetchImpl).initiateMobileMoneyTransfer({
      reference: 'SYN-WDR-MM-007',
      phone: PHONE,
      operator: 'mtn',
      amountMinor: 2000,
    });
    assert.ok(result.ok, `fee ${fee}`);
    assert.equal(result.value.feeMinor, 0);
  }
});

test('provider-false envelopes stay unknown, with duplicates called out but never reversed', async () => {
  const plain = fakeFetch([respond(200, { status: false, message: 'provider declined' })]);
  const plainResult = await configWith(plain.fetchImpl).initiateMobileMoneyCollection({
    reference: 'SYN-COLL-011',
    phone: PHONE,
    operator: 'mtn',
    amountMinor: 100,
  });
  assert.deepEqual(plainResult, { ok: false, code: 'provider_error', outcome: 'unknown', retryable: false });

  const duplicate = fakeFetch([respond(200, { status: false, message: 'Duplicate reference already exists' })]);
  const duplicateResult = await configWith(duplicate.fetchImpl).initiateMobileMoneyCollection({
    reference: 'SYN-COLL-011',
    phone: PHONE,
    operator: 'mtn',
    amountMinor: 100,
  });
  assert.deepEqual(duplicateResult, { ok: false, code: 'duplicate_reference', outcome: 'unknown', retryable: false });
});

test('documented HTTP 400 duplicate payloads stay unknown with the duplicate code', async () => {
  const duplicateBody = { status: false, message: 'Duplicate reference', data: null };
  const collection = fakeFetch([{ kind: 'respond', status: 400, text: jsonBody(duplicateBody) }]);
  const collectionResult = await configWith(collection.fetchImpl).initiateMobileMoneyCollection({
    reference: 'SYN-COLL-012',
    phone: PHONE,
    operator: 'mtn',
    amountMinor: 100,
  });
  assert.deepEqual(collectionResult, {
    ok: false,
    code: 'duplicate_reference',
    outcome: 'unknown',
    retryable: false,
  });
  assert.equal(collection.calls.length, 1);

  const transfer = fakeFetch([{ kind: 'respond', status: 400, text: jsonBody(duplicateBody) }]);
  const transferResult = await configWith(transfer.fetchImpl).initiateBankTransfer({
    reference: 'SYN-WDR-BK-006',
    bankId: BANK_ID,
    accountNumber: BANK_ACCOUNT,
    amountMinor: 2000,
  });
  assert.deepEqual(transferResult, {
    ok: false,
    code: 'duplicate_reference',
    outcome: 'unknown',
    retryable: false,
  });
  assert.equal(transfer.calls.length, 1);
});

test('a plain HTTP 400 without a duplicate signal stays a conservative unknown', async () => {
  const plain = fakeFetch([
    { kind: 'respond', status: 400, text: jsonBody({ status: false, message: 'Request failed', data: null }) },
  ]);
  const plainResult = await configWith(plain.fetchImpl).initiateMobileMoneyCollection({
    reference: 'SYN-COLL-013',
    phone: PHONE,
    operator: 'mtn',
    amountMinor: 100,
  });
  assert.deepEqual(plainResult, { ok: false, code: 'http_error', outcome: 'unknown', retryable: false });
  assert.equal(plain.calls.length, 1);

  const nonJson = fakeFetch([{ kind: 'respond', status: 400, text: 'bad request' }]);
  const nonJsonResult = await configWith(nonJson.fetchImpl).initiateMobileMoneyCollection({
    reference: 'SYN-COLL-013',
    phone: PHONE,
    operator: 'mtn',
    amountMinor: 100,
  });
  assert.deepEqual(nonJsonResult, { ok: false, code: 'http_error', outcome: 'unknown', retryable: false });
});

test('malformed and mismatched responses stay unknown without receipt data', async () => {
  const bodies: unknown[] = [
    'not-json{{{',
    { status: 'yes', data: officialCollectionData() },
    { data: officialCollectionData() },
    { status: true },
    { status: true, data: null },
  ];
  for (const body of bodies) {
    const text = typeof body === 'string' ? body : jsonBody(body);
    const { fetchImpl } = fakeFetch([{ kind: 'respond', status: 200, text }]);
    const result = await configWith(fetchImpl).initiateMobileMoneyCollection({
      reference: 'SYN-COLL-014',
      phone: PHONE,
      operator: 'mtn',
      amountMinor: 100,
    });
    assert.deepEqual(result, { ok: false, code: 'bad_response', outcome: 'unknown', retryable: false });
  }
  // Each case below starts from the official-shaped body and changes exactly one critical field.
  await expectCollectionBadResponse(officialCollectionData({ amount: '10.011' }));
  await expectCollectionBadResponse(officialCollectionData({ amount: 10 }));
  await expectCollectionBadResponse(officialCollectionData({ amount: '-5.00' }));
  await expectCollectionBadResponse(officialCollectionData({ currency: 'USD' }));
  await expectCollectionBadResponse(officialCollectionData({ id: 'not-a-uuid' }));
  await expectCollectionBadResponse(officialCollectionData({ fee: 'abc' }));
  await expectCollectionBadResponse(officialCollectionData({ reference: 'bad ref' }));
});

test('HTTP rejections on POST stay unknown and never read as a reversal', async () => {
  const { fetchImpl } = fakeFetch([respond(500, { status: false })]);
  const result = await configWith(fetchImpl).initiateMobileMoneyCollection({
    reference: 'SYN-COLL-015',
    phone: PHONE,
    operator: 'mtn',
    amountMinor: 100,
  });
  assert.deepEqual(result, { ok: false, code: 'http_error', outcome: 'unknown', retryable: false });
});

test('POST performs zero automatic retries on transport failure', async () => {
  const { fetchImpl, calls } = fakeFetch([{ kind: 'throw', message: 'socket hang up' }]);
  const result = await configWith(fetchImpl).initiateMobileMoneyCollection({
    reference: 'SYN-COLL-016',
    phone: PHONE,
    operator: 'mtn',
    amountMinor: 100,
  });
  assert.equal(calls.length, 1);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.outcome, 'unknown');
    assert.equal(result.retryable, false);
  }
});

test('POST timeouts stay unknown after exactly one attempt', async () => {
  const { fetchImpl, calls } = fakeFetch([{ kind: 'hang' }]);
  const adapter = createLencoAdapter({ apiKey: API_KEY, debitAccountId: DEBIT_ACCOUNT, timeoutMs: 25 }, fetchImpl);
  const result = await adapter.initiateMobileMoneyCollection({
    reference: 'SYN-COLL-017',
    phone: PHONE,
    operator: 'mtn',
    amountMinor: 100,
  });
  assert.deepEqual(result, { ok: false, code: 'timeout', outcome: 'unknown', retryable: false });
  assert.equal(calls.length, 1);
});

test('a stalled POST body read stays unknown after exactly one attempt', async () => {
  const calls: Call[] = [];
  const adapter = createLencoAdapter(
    { apiKey: API_KEY, debitAccountId: DEBIT_ACCOUNT, timeoutMs: 25 },
    hangingBodyFetch(calls),
  );
  const result = await adapter.initiateMobileMoneyCollection({
    reference: 'SYN-COLL-018',
    phone: PHONE,
    operator: 'mtn',
    amountMinor: 100,
  });
  assert.deepEqual(result, { ok: false, code: 'timeout', outcome: 'unknown', retryable: false });
  assert.equal(calls.length, 1);
});

test('GET retries at most once for transient failures on the same URL', async () => {
  const { fetchImpl, calls } = fakeFetch([
    respond(500, { status: false }),
    respond(200, envelope(officialCollectionData())),
  ]);
  const result = await configWith(fetchImpl).getCollectionByReference('SYN-COLL-001');
  assert.ok(result.ok);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.url, calls[1]?.url);

  const failing = fakeFetch([respond(503, { status: false }), respond(503, { status: false })]);
  const failed = await configWith(failing.fetchImpl).getCollectionByReference('SYN-COLL-001');
  assert.deepEqual(failed, { ok: false, code: 'http_error', outcome: 'unknown', retryable: true });
  assert.equal(failing.calls.length, 2);

  const network = fakeFetch([
    { kind: 'throw', message: 'socket hang up' },
    respond(200, envelope(officialMobileTransferData())),
  ]);
  const recovered = await configWith(network.fetchImpl).getTransferById(PROVIDER_ID);
  assert.ok(recovered.ok);
  assert.equal(network.calls.length, 2);
});

test('GET never retries a 404 and reports it as not_found rather than a failed transfer', async () => {
  const { fetchImpl, calls } = fakeFetch([respond(404, { status: false, message: 'not found' })]);
  const result = await configWith(fetchImpl).getTransferById(OTHER_ID);
  assert.deepEqual(result, { ok: false, code: 'not_found', outcome: 'not_found', retryable: false });
  assert.equal(calls.length, 1);
});

test('GET never retries a non-transient rejection', async () => {
  const { fetchImpl, calls } = fakeFetch([respond(400, { status: false })]);
  const result = await configWith(fetchImpl).getCollectionById(PROVIDER_ID);
  assert.deepEqual(result, { ok: false, code: 'http_error', outcome: 'unknown', retryable: false });
  assert.equal(calls.length, 1);
});

test('credential-bearing redirects fail instead of resending the bearer token', async () => {
  const { fetchImpl, calls } = fakeFetch([{ kind: 'throw', message: 'Redirect failed: too many redirects' }]);
  const result = await configWith(fetchImpl).getCollectionById(PROVIDER_ID);
  assert.deepEqual(result, { ok: false, code: 'redirect', outcome: 'unknown', retryable: false });
  assert.equal(calls.length, 1);

  const posting = fakeFetch([{ kind: 'throw', message: 'fetch failed because of redirect mode error' }]);
  const posted = await configWith(posting.fetchImpl).initiateMobileMoneyCollection({
    reference: 'SYN-COLL-019',
    phone: PHONE,
    operator: 'mtn',
    amountMinor: 100,
  });
  assert.deepEqual(posted, { ok: false, code: 'redirect', outcome: 'unknown', retryable: false });
  assert.equal(posting.calls.length, 1);
});

test('bank directory listing uses the Zambia query and parses id/name/country records', async () => {
  const banks = [
    { id: '002', name: 'Synthetic Bank One', country: 'zm' },
    { id: '042', name: 'Synthetic Bank Two', country: 'zm' },
  ];
  const { fetchImpl, calls } = fakeFetch([respond(200, envelope(banks))]);
  const result = await configWith(fetchImpl).listBanks();
  assert.ok(result.ok);
  assert.equal(calls[0]?.url, `${LENCO_BASE_URL}/banks?country=zm`);
  assert.equal(calls[0]?.init.method, 'GET');
  assert.deepEqual(result.value, banks);
  assert.equal(typeof result.value[0]?.id, 'string');
  assert.equal(result.value[0]?.id, '002');
});

test('bank directory entries without a Zambia country fail safe', async () => {
  const cases: unknown[][] = [
    [{ id: '002', name: 'Synthetic Bank', code: 'SBO' }],
    [{ id: '002', name: 'Synthetic Bank' }],
    [{ id: '002', name: 'Synthetic Bank', country: 'xx' }],
    [{ id: '', name: 'Synthetic Bank', country: 'zm' }],
  ];
  for (const banks of cases) {
    const { fetchImpl } = fakeFetch([respond(200, envelope(banks))]);
    const result = await configWith(fetchImpl).listBanks();
    assert.deepEqual(result, { ok: false, code: 'bad_response', outcome: 'unknown', retryable: false });
  }
});

test('resolve routes send only the documented destination fields', async () => {
  const mobile = fakeFetch([
    respond(
      200,
      envelope({ type: 'mobile-money', accountName: 'Synthetic Name', phone: PHONE, operator: 'mtn', country: 'zm' }),
    ),
  ]);
  const mobileResult = await configWith(mobile.fetchImpl).resolveMobileMoney({ phone: PHONE, operator: 'mtn' });
  assert.ok(mobileResult.ok);
  assert.equal(mobile.calls[0]?.url, `${LENCO_BASE_URL}/resolve/mobile-money`);
  assert.deepEqual(sentKeys(mobile.calls[0]), ['operator', 'phone']);
  assert.deepEqual(mobileResult.value, {
    type: 'mobile-money',
    phone: PHONE,
    operator: 'mtn',
    country: 'zm',
    accountName: 'Synthetic Name',
  });

  const bank = fakeFetch([
    respond(
      200,
      envelope({
        type: 'bank-account',
        accountName: null,
        accountNumber: BANK_ACCOUNT,
        bank: { id: BANK_ID, name: 'Synthetic Bank', country: 'zm' },
      }),
    ),
  ]);
  const bankResult = await configWith(bank.fetchImpl).resolveBankAccount({
    accountNumber: BANK_ACCOUNT,
    bankId: BANK_ID,
  });
  assert.ok(bankResult.ok);
  assert.equal(bank.calls[0]?.url, `${LENCO_BASE_URL}/resolve/bank-account`);
  assert.deepEqual(sentKeys(bank.calls[0]), ['accountNumber', 'bankId']);
  assert.deepEqual(bankResult.value, {
    type: 'bank-account',
    accountNumber: BANK_ACCOUNT,
    bank: { id: BANK_ID, name: 'Synthetic Bank', country: 'zm' },
    accountName: null,
  });
});

test('resolve results with unknown type/country or malformed identifiers fail safe', async () => {
  async function expectMobileBadResponse(data: Record<string, JsonValue>): Promise<void> {
    const { fetchImpl } = fakeFetch([respond(200, envelope(data))]);
    const result = await configWith(fetchImpl).resolveMobileMoney({ phone: PHONE, operator: 'mtn' });
    assert.deepEqual(result, { ok: false, code: 'bad_response', outcome: 'unknown', retryable: false });
  }

  async function expectBankBadResponse(data: Record<string, JsonValue>): Promise<void> {
    const { fetchImpl } = fakeFetch([respond(200, envelope(data))]);
    const result = await configWith(fetchImpl).resolveBankAccount({ accountNumber: BANK_ACCOUNT, bankId: BANK_ID });
    assert.deepEqual(result, { ok: false, code: 'bad_response', outcome: 'unknown', retryable: false });
  }

  await expectMobileBadResponse({ phone: PHONE, operator: 'mtn', country: 'zm' });
  await expectMobileBadResponse({ type: 'bank-account', phone: PHONE, operator: 'mtn', country: 'zm' });
  await expectMobileBadResponse({ type: 'mobile-money', phone: PHONE, operator: 'mtn', country: 'mw' });
  await expectMobileBadResponse({ type: 'mobile-money', phone: PHONE, operator: 'vodafone', country: 'zm' });
  await expectBankBadResponse({ accountNumber: BANK_ACCOUNT, bank: { id: BANK_ID } });
  await expectBankBadResponse({
    type: 'bank-account',
    accountNumber: BANK_ACCOUNT,
    bank: { id: BANK_ID, name: 'Synthetic Bank', country: 'ng' },
  });
  await expectBankBadResponse({
    type: 'bank-account',
    accountNumber: BANK_ACCOUNT,
    bank: { name: 'Synthetic Bank', country: 'zm' },
  });
});

test('failures carry narrow codes without keys, personal data, or raw payloads', async () => {
  const marker = 'MARKER-PHONE-0979999999';
  const secret = 'synthetic-secret-bearer-998877';
  const { fetchImpl } = fakeFetch([respond(200, { status: false, message: 'declined', debug: { raw: 'sensitive' } })]);
  const adapter = createLencoAdapter({ apiKey: secret, debitAccountId: DEBIT_ACCOUNT, timeoutMs: 500 }, fetchImpl);
  const result = await adapter.initiateMobileMoneyCollection({
    reference: 'SYN-COLL-020',
    phone: marker,
    operator: 'mtn',
    amountMinor: 100,
  });
  assert.ok(!result.ok);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(secret));
  assert.ok(!serialized.includes(marker));
  assert.ok(!serialized.includes('sensitive'));
  assert.ok(!serialized.includes('debug'));

  const duplicateMarker = 'MARKER-DUPLICATE-REF-112233';
  const duplicate = fakeFetch([
    {
      kind: 'respond',
      status: 400,
      text: jsonBody({ status: false, message: `Duplicate reference ${duplicateMarker}`, data: null }),
    },
  ]);
  const duplicateAdapter = createLencoAdapter(
    { apiKey: secret, debitAccountId: DEBIT_ACCOUNT, timeoutMs: 500 },
    duplicate.fetchImpl,
  );
  const duplicateResult = await duplicateAdapter.initiateMobileMoneyCollection({
    reference: 'SYN-COLL-021',
    phone: PHONE,
    operator: 'mtn',
    amountMinor: 100,
  });
  assert.deepEqual(duplicateResult, {
    ok: false,
    code: 'duplicate_reference',
    outcome: 'unknown',
    retryable: false,
  });
  assert.ok(!JSON.stringify(duplicateResult).includes(duplicateMarker));
  assert.ok(!JSON.stringify(duplicateResult).includes(secret));
});

test('successes and failures log nothing', async () => {
  const logged: string[] = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...args: string[]) => {
    logged.push(args.join(' '));
  };
  console.log = (...args: string[]) => {
    logged.push(args.join(' '));
  };
  try {
    const failing = fakeFetch([respond(500, { status: false })]);
    await configWith(failing.fetchImpl).initiateMobileMoneyCollection({
      reference: 'SYN-COLL-022',
      phone: PHONE,
      operator: 'mtn',
      amountMinor: 100,
    });
    const succeeding = fakeFetch([respond(200, envelope(officialCollectionData()))]);
    await configWith(succeeding.fetchImpl).initiateMobileMoneyCollection({
      reference: 'SYN-COLL-022',
      phone: PHONE,
      operator: 'mtn',
      amountMinor: 1000,
    });
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
  assert.deepEqual(logged, []);
});

test('default timeout is twenty seconds', () => {
  assert.equal(LENCO_TIMEOUT_MS, 20_000);
});

test('webhook signatures verify against the hex-derived HMAC key', async () => {
  const raw = new TextEncoder().encode(jsonBody({ event: 'collection.success', reference: 'SYN-COLL-001' }));
  const keyHex = sha256Hex(API_KEY).toLowerCase();
  const signature = webhookSignature(raw, keyHex);
  assert.equal(signature.length, 128);
  const { fetchImpl } = fakeFetch([]);
  const adapter = configWith(fetchImpl);
  assert.equal(await adapter.verifyWebhookSignature(raw, signature), true);
  assert.equal(await adapter.verifyWebhookSignature(raw, signature.toUpperCase()), true);
});

test('webhook verification rejects tampered bytes and wrong keys', async () => {
  const raw = new TextEncoder().encode(jsonBody({ event: 'collection.success', reference: 'SYN-COLL-001' }));
  const keyHex = sha256Hex(API_KEY).toLowerCase();
  const signature = webhookSignature(raw, keyHex);
  const { fetchImpl } = fakeFetch([]);
  const adapter = configWith(fetchImpl);
  const tampered = Uint8Array.from(raw);
  tampered[0] = (tampered[0] as number) ^ 0xff;
  assert.equal(await adapter.verifyWebhookSignature(tampered, signature), false);
  const wrongKey = webhookSignature(raw, sha256Hex('synthetic-other-token-002').toLowerCase());
  assert.equal(await adapter.verifyWebhookSignature(raw, wrongKey), false);
  assert.equal(await adapter.verifyWebhookSignature(raw, '0'.repeat(128)), false);
});

test('webhook verification uses the hex text as key material, not the decoded digest', async () => {
  const raw = new TextEncoder().encode(jsonBody({ event: 'transfer.success', reference: 'SYN-WDR-MM-001' }));
  const keyHex = sha256Hex(API_KEY).toLowerCase();
  const decodedKeySignature = createHmac('sha512', Buffer.from(keyHex, 'hex')).update(raw).digest('hex');
  assert.notEqual(decodedKeySignature, webhookSignature(raw, keyHex));
  const { fetchImpl } = fakeFetch([]);
  const adapter = configWith(fetchImpl);
  assert.equal(await adapter.verifyWebhookSignature(raw, decodedKeySignature), false);
});

test('webhook verification is sensitive to exact raw bytes, not reserialized text', async () => {
  const compact = jsonBody({ a: 1, b: 2 });
  const spaced = jsonBody({ a: 1, b: 2 }).replace(',', ', ');
  assert.notEqual(compact, spaced);
  const rawCompact = new TextEncoder().encode(compact);
  const keyHex = sha256Hex(API_KEY).toLowerCase();
  const signature = webhookSignature(rawCompact, keyHex);
  const { fetchImpl } = fakeFetch([]);
  const adapter = configWith(fetchImpl);
  assert.equal(await adapter.verifyWebhookSignature(rawCompact, signature), true);
  assert.equal(await adapter.verifyWebhookSignature(new TextEncoder().encode(spaced), signature), false);
});

test('webhook verification rejects malformed signatures and missing configuration', async () => {
  const raw = new TextEncoder().encode('payload');
  const { fetchImpl } = fakeFetch([]);
  const adapter = configWith(fetchImpl);
  assert.equal(await adapter.verifyWebhookSignature(raw, null), false);
  assert.equal(await adapter.verifyWebhookSignature(raw, ''), false);
  assert.equal(await adapter.verifyWebhookSignature(raw, 'abc'), false);
  assert.equal(await adapter.verifyWebhookSignature(raw, 'z'.repeat(128)), false);
  assert.equal(await adapter.verifyWebhookSignature(raw, '0'.repeat(127)), false);
  const unconfigured = createLencoAdapter({ apiKey: '' }, fetchImpl);
  assert.equal(await unconfigured.verifyWebhookSignature(raw, '0'.repeat(128)), false);
});

test('empty delimiters and surrounding whitespace fail as invalid configuration without fetch', async () => {
  let attempts = 0;
  const counting: LencoFetch = async () => {
    attempts += 1;
    return new Response('{}', { status: 200 });
  };
  for (const baseUrl of [
    'https://example.com/access/v2?',
    'https://example.com/access/v2#',
    'https://example.com/access/v2 ',
    'https://example.com/access/v2\n',
  ]) {
    const adapter = createLencoAdapter({ apiKey: API_KEY, baseUrl }, counting);
    assert.equal(adapter.configured, false, `expected unconfigured for ${JSON.stringify(baseUrl)}`);
    const result = await adapter.listBanks();
    assert.deepEqual(result, { ok: false, code: 'invalid_config', outcome: 'not_started', retryable: false });
  }
  assert.equal(attempts, 0);
});

test('custom base URLs are canonicalized with trailing slashes removed', async () => {
  const { fetchImpl, calls } = fakeFetch([respond(200, envelope(officialCollectionData()))]);
  const adapter = createLencoAdapter(
    {
      apiKey: API_KEY,
      debitAccountId: DEBIT_ACCOUNT,
      timeoutMs: 500,
      baseUrl: 'https://example.com/access/v2///',
    },
    fetchImpl,
  );
  assert.equal(adapter.configured, true);
  const result = await adapter.getCollectionById(PROVIDER_ID);
  assert.ok(result.ok);
  assert.equal(calls[0]?.url, `https://example.com/access/v2/collections/${PROVIDER_ID}`);
});

test('generic GET transfer status without mobile-money country normalizes to an explicit null', async () => {
  const missingCountry = {
    type: 'mobile-money',
    accountName: 'Synthetic Recipient',
    phone: PHONE,
    operator: 'zamtel',
  };
  const byId = fakeFetch([respond(200, envelope(officialMobileTransferData({ creditAccount: missingCountry })))]);
  const idResult = await configWith(byId.fetchImpl).getTransferById(PROVIDER_ID);
  assert.ok(idResult.ok);
  assert.equal(idResult.value.transferType, 'mobile-money');
  assert.equal(idResult.value.destination.kind, 'mobile-money');
  if (idResult.value.destination.kind === 'mobile-money') {
    assert.equal(idResult.value.destination.country, null);
    assert.equal(idResult.value.destination.phone, PHONE);
    assert.equal(idResult.value.destination.operator, 'zamtel');
  }

  const byReference = fakeFetch([
    respond(200, envelope(officialMobileTransferData({ creditAccount: missingCountry }))),
  ]);
  const referenceResult = await configWith(byReference.fetchImpl).getTransferByReference('SYN-WDR-MM-001');
  assert.ok(referenceResult.ok);
  assert.equal(referenceResult.value.destination.kind, 'mobile-money');
  if (referenceResult.value.destination.kind === 'mobile-money') {
    assert.equal(referenceResult.value.destination.country, null);
  }
});

test('initiation still requires mobile-money country while GET rejects explicit foreign values', async () => {
  const missingCountry = {
    type: 'mobile-money',
    accountName: 'Synthetic Recipient',
    phone: PHONE,
    operator: 'zamtel',
  };
  const initiating = fakeFetch([respond(200, envelope(officialMobileTransferData({ creditAccount: missingCountry })))]);
  const initiated = await configWith(initiating.fetchImpl).initiateMobileMoneyTransfer({
    reference: 'SYN-WDR-MM-008',
    phone: PHONE,
    operator: 'mtn',
    amountMinor: 2000,
  });
  assert.deepEqual(initiated, { ok: false, code: 'bad_response', outcome: 'unknown', retryable: false });

  async function expectGetBadResponse(creditAccount: Record<string, JsonValue>): Promise<void> {
    const { fetchImpl } = fakeFetch([respond(200, envelope(officialMobileTransferData({ creditAccount })))]);
    const result = await configWith(fetchImpl).getTransferById(PROVIDER_ID);
    assert.deepEqual(result, { ok: false, code: 'bad_response', outcome: 'unknown', retryable: false });
  }

  await expectGetBadResponse({
    type: 'mobile-money',
    accountName: 'Synthetic Recipient',
    phone: PHONE,
    operator: 'zamtel',
    country: 'mw',
  });
  await expectGetBadResponse({
    type: 'mobile-money',
    accountName: 'Synthetic Recipient',
    phone: PHONE,
    operator: 'zamtel',
    country: null,
  });
});
