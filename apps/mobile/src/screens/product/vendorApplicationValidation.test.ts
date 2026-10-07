import assert from 'node:assert/strict';
import test from 'node:test';
import { getVendorApplicationValidationMessage } from './vendorApplicationValidation';

const completeApplication = {
  storeName: 'Lusaka Home Store',
  description: 'Household goods for shoppers in Lusaka.',
  contactEmail: 'vendor@example.com',
  street: '12 Cairo Road',
  city: 'Lusaka',
  province: 'Lusaka',
  country: 'Zambia',
};

test('identifies the missing required vendor application field before submitting', () => {
  assert.equal(
    getVendorApplicationValidationMessage({
      ...completeApplication,
      province: '   ',
    }),
    'Complete the required store details: Province.'
  );
});

test('accepts a complete vendor application before submitting', () => {
  assert.equal(getVendorApplicationValidationMessage(completeApplication), null);
});
