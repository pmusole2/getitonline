import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AI_CONSENT_VERSION,
  createAIConsentRecord,
  getAIConsentDisclosure,
  isAIConsentRecordForSubject,
} from './aiConsentPolicy';

test('consent is valid only for the active account and current version', () => {
  const record = createAIConsentRecord(
    'account:user_123',
    new Date('2026-07-21T10:00:00.000Z'),
  );

  assert.equal(record.version, AI_CONSENT_VERSION);
  assert.equal(
    isAIConsentRecordForSubject(record, 'account:user_123'),
    true,
  );
  assert.equal(
    isAIConsentRecordForSubject(record, 'account:user_456'),
    false,
  );
  assert.equal(isAIConsentRecordForSubject(record, 'guest'), false);
});

test('disclosure identifies the recipient, data, purpose, and retention', () => {
  const disclosure = getAIConsentDisclosure();
  const copy = Object.values(disclosure).join(' ');

  assert.match(copy, /OpenAI, LLC/);
  assert.match(copy, /images/i);
  assert.match(copy, /messages/i);
  assert.match(copy, /shopping activity/i);
  assert.match(copy, /generate/i);
  assert.match(copy, /30 days/i);
  assert.match(copy, /Settings/i);
});
