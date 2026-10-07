import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getAppleButtonAppearance,
  shouldShowAppleSignIn,
} from './appleSignInPolicy';

test('shows native Apple sign-in only when iOS reports it available', () => {
  assert.equal(shouldShowAppleSignIn('ios', true), true);
  assert.equal(shouldShowAppleSignIn('ios', false), false);
  assert.equal(shouldShowAppleSignIn('android', true), false);
});

test('uses a contrasting native Apple button appearance', () => {
  assert.equal(getAppleButtonAppearance(false), 'black');
  assert.equal(getAppleButtonAppearance(true), 'white');
});
