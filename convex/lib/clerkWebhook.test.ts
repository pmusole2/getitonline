import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyClerkWebhookRequest } from './clerkWebhook';

test('rejects webhook requests when the signing secret is not configured', async () => {
  const originalSecret = process.env.CLERK_WEBHOOK_SIGNING_SECRET;
  delete process.env.CLERK_WEBHOOK_SIGNING_SECRET;

  try {
    await assert.rejects(
      verifyClerkWebhookRequest(
        new Request('https://example.com/clerk-webhook', {
          method: 'POST',
          body: JSON.stringify({ type: 'user.deleted', data: { id: 'user_1' } }),
        }),
      ),
      /signing secret is not configured/i,
    );
  } finally {
    if (originalSecret) {
      process.env.CLERK_WEBHOOK_SIGNING_SECRET = originalSecret;
    }
  }
});

test('rejects unsigned webhook requests', async () => {
  const originalSecret = process.env.CLERK_WEBHOOK_SIGNING_SECRET;
  process.env.CLERK_WEBHOOK_SIGNING_SECRET = 'whsec_test_secret';

  try {
    await assert.rejects(
      verifyClerkWebhookRequest(
        new Request('https://example.com/clerk-webhook', {
          method: 'POST',
          body: JSON.stringify({ type: 'user.deleted', data: { id: 'user_1' } }),
        }),
      ),
    );
  } finally {
    if (originalSecret) {
      process.env.CLERK_WEBHOOK_SIGNING_SECRET = originalSecret;
    } else {
      delete process.env.CLERK_WEBHOOK_SIGNING_SECRET;
    }
  }
});
