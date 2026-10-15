import assert from 'node:assert/strict';
import test from 'node:test';

import { readFileSync } from 'node:fs';

import { AI_CONSENT_VERSION, hasCurrentAiConsent } from './aiConsent';

const MOBILE_POLICY_PATH = new URL('../../apps/mobile/src/services/aiConsentPolicy.ts', import.meta.url);

function mobileConsentVersion(): number {
  const source = readFileSync(MOBILE_POLICY_PATH, 'utf8');
  const match = /export const AI_CONSENT_VERSION = (\d+);/.exec(source);
  if (!match?.[1]) {
    throw new Error(`AI_CONSENT_VERSION not found in ${MOBILE_POLICY_PATH.pathname}`);
  }
  return Number(match[1]);
}

test('the server consent version matches the mobile disclosure version', () => {
  assert.equal(AI_CONSENT_VERSION, mobileConsentVersion());
});

test('only the exact current consent version counts as consent', () => {
  assert.equal(hasCurrentAiConsent(AI_CONSENT_VERSION), true);
  assert.equal(hasCurrentAiConsent(2), true);
});

test('missing, stale, future, string, and non-finite consent versions are rejected', () => {
  for (const consentVersion of [undefined, null, 0, 1, 3, '2', ' 2', '', NaN, Infinity, true, {}, [2]]) {
    assert.equal(hasCurrentAiConsent(consentVersion), false, `${String(consentVersion)} must not count as consent`);
  }
});
