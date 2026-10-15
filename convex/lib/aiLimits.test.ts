import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_AI_LIMITS, aiWindowStart, resolveAiLimits } from './aiLimits';

test('default limits are the configured Pinkie allowances', () => {
  assert.deepEqual(DEFAULT_AI_LIMITS, {
    global: { perDay: 1000, perMinute: 100 },
    account: { perDay: 100, perMinute: 10 },
    allGuests: { perDay: 200, perMinute: 20 },
    guest: { perDay: 20, perMinute: 5 },
  });
});

test('missing or non-object overrides fall back to the defaults', () => {
  for (const overrides of [undefined, null, 'account', 42, [], true]) {
    assert.deepEqual(resolveAiLimits(overrides), DEFAULT_AI_LIMITS, String(overrides));
  }
});

test('an override replaces only the fields it names', () => {
  assert.deepEqual(resolveAiLimits({ account: { perMinute: 20 } }), {
    ...DEFAULT_AI_LIMITS,
    account: { perDay: 100, perMinute: 20 },
  });
});

test('malformed entries are ignored and keep the default for that field', () => {
  assert.deepEqual(
    resolveAiLimits({
      global: { perDay: Number.NaN, perMinute: Number.POSITIVE_INFINITY },
      account: { perDay: 0, perMinute: -5 },
      allGuests: { perDay: 1.5, perMinute: '20' },
      guest: 'five',
    }),
    DEFAULT_AI_LIMITS,
  );
});

test('a valid field is kept even when a sibling field is malformed', () => {
  assert.deepEqual(resolveAiLimits({ guest: { perDay: 40, perMinute: 0 } }).guest, { perDay: 40, perMinute: 5 });
});

test('unknown scopes are ignored', () => {
  assert.deepEqual(resolveAiLimits({ everyone: { perDay: 1, perMinute: 1 } }), DEFAULT_AI_LIMITS);
});

test('resolved limits are a fresh object, so callers cannot change the defaults', () => {
  const resolved = resolveAiLimits(undefined);
  resolved.global.perDay = 1;

  assert.equal(DEFAULT_AI_LIMITS.global.perDay, 1000);
});

test('a minute window starts at the UTC minute boundary', () => {
  const minuteStart = Date.UTC(2026, 9, 10, 12, 30, 0);

  assert.equal(aiWindowStart('minute', minuteStart), minuteStart);
  assert.equal(aiWindowStart('minute', minuteStart + 59_999), minuteStart);
  assert.equal(aiWindowStart('minute', minuteStart + 60_000), minuteStart + 60_000);
});

test('a day window starts at the UTC midnight boundary', () => {
  const midnight = Date.UTC(2026, 9, 10);

  assert.equal(aiWindowStart('day', midnight + 86_399_999), midnight);
  assert.equal(aiWindowStart('day', midnight + 86_400_000), midnight + 86_400_000);
});
