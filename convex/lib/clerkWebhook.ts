import { verifyWebhook, type WebhookEvent } from '@clerk/backend/webhooks';

export async function verifyClerkWebhookRequest(
  request: Request,
): Promise<WebhookEvent> {
  const signingSecret = process.env.CLERK_WEBHOOK_SIGNING_SECRET?.trim();
  if (!signingSecret) {
    throw new Error('Clerk webhook signing secret is not configured.');
  }

  return verifyWebhook(request, { signingSecret });
}
