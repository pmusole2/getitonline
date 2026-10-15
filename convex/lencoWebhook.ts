import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { createLencoAdapter } from "./lib/lencoAdapter";
import { normalizeVerifiedWebhook, verifiedBodyDigest } from "./lib/lencoWebhook";

type WebhookDependencies = {
  env: () => { LENCO_API_KEY?: string };
};

export function createLencoWebhookAction(dependencies: WebhookDependencies): ReturnType<typeof httpAction> {
  return httpAction(async (ctx, request): Promise<Response> => {
    try {
      // Managed environment is read only inside the runtime callback.
      const adapter = createLencoAdapter({ apiKey: dependencies.env().LENCO_API_KEY ?? "" });
      if (!adapter.configured) {
        return new Response("Webhook unavailable", { status: 503 });
      }
      const raw = new Uint8Array(await request.arrayBuffer());
      if (!(await adapter.verifyWebhookSignature(raw, request.headers.get("X-Lenco-Signature")))) {
        return new Response("Webhook rejected", { status: 400 });
      }
      const bodyDigest = await verifiedBodyDigest(raw);
      const packet = normalizeVerifiedWebhook(raw);
      const inbox = await ctx.runMutation(internal.lencoWebhookData.ingest, {
        bodyDigest,
        eventKind: packet.eventKind,
        classification: packet.classification,
        ...(packet.reference === undefined ? {} : { reference: packet.reference }),
        ...(packet.providerId === undefined ? {} : { providerId: packet.providerId }),
      });
      if (inbox.classification === "terminal" && inbox.operationId !== undefined && packet.receipt !== undefined) {
        // Inbox identity is not financial proof. Even an exact replay must reach
        // the existing atomic/idempotent writer after an earlier partial action failure.
        const result = await ctx.runMutation(internal.providerSettlement.settleProviderReceipt, {
          operationId: inbox.operationId,
          receipt: packet.receipt,
          acquisition: { kind: "signed_webhook", eventId: bodyDigest },
        });
        await ctx.runMutation(internal.lencoWebhookData.recordResult, {
          inboxId: inbox.inboxId,
          bodyDigest,
          result,
        });
      }
      return new Response("Webhook accepted", { status: 200 });
    } catch {
      // Neither provider payloads nor infrastructure errors are safe to expose/log.
      return new Response("Webhook processing failed", { status: 500 });
    }
  });
}

export const lencoWebhook = createLencoWebhookAction({
  env: () => ({ LENCO_API_KEY: process.env.LENCO_API_KEY }),
});
