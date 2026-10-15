import { v, type Infer } from "convex/values";
import { armInboxPolling } from "./lib/paymentInboxPolling";
import type { Doc } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import { isValidProviderId, isValidReference } from "./lib/lencoAdapter";
import {
  webhookClassificationValidator,
  webhookEventKindValidator,
  type WebhookClassification,
} from "./lib/lencoWebhook";
import { settlementResultValidator } from "./lib/providerSettlementContracts";

const ingestionResultValidator = v.object({
  inboxId: v.id("lencoWebhookInbox"),
  operationId: v.optional(v.id("paymentOperations")),
  classification: webhookClassificationValidator,
});

type IngestionResult = Infer<typeof ingestionResultValidator>;

// Only metadata writes. Indexed read sets rely on Convex transactional OCC,
// not a declarative unique index or an action-local dedup flag.
export const ingest = internalMutation({
  args: {
    bodyDigest: v.string(),
    eventKind: webhookEventKindValidator,
    classification: webhookClassificationValidator,
    reference: v.optional(v.string()),
    providerId: v.optional(v.string()),
  },
  returns: ingestionResultValidator,
  handler: async (ctx, args): Promise<IngestionResult> => {
    if (
      !/^[a-f0-9]{64}$/.test(args.bodyDigest) ||
      (args.reference !== undefined && !isValidReference(args.reference)) ||
      (args.providerId !== undefined && !isValidProviderId(args.providerId))
    ) {
      throw new Error("Invalid webhook identity");
    }
    const existing = await ctx.db
      .query("lencoWebhookInbox")
      .withIndex("by_digest", (q) => q.eq("bodyDigest", args.bodyDigest))
      .collect();
    if (existing.length > 1) {
      throw new Error("Ambiguous webhook identity");
    }
    const prior = existing[0];
    if (prior !== undefined && prior.eventKind !== args.eventKind) {
      throw new Error("Webhook identity mismatch");
    }
    const candidates: Doc<"paymentOperations">[] = [];
    if (args.reference !== undefined) {
      candidates.push(
        ...(await ctx.db
          .query("paymentOperations")
          .withIndex("by_provider_reference", (q) => q.eq("providerReference", args.reference))
          .collect())
      );
    }
    if (args.providerId !== undefined) {
      candidates.push(
        ...(await ctx.db
          .query("paymentOperations")
          .withIndex("by_provider_id", (q) => q.eq("providerId", args.providerId))
          .collect())
      );
    }
    const unique = [...new Map(candidates.map((entry) => [entry._id, entry])).values()];
    const operation = unique.length === 1 ? unique[0] : undefined;
    let classification: WebhookClassification = args.classification;
    if (unique.length > 1 || (prior?.operationId !== undefined && prior.operationId !== operation?._id)) {
      classification = "ambiguous";
    } else if (operation?.kind === "wallet_purchase") {
      classification = "unsupported";
    } else if (operation === undefined && args.classification === "terminal") {
      classification = "unmapped";
    }
    const operationId = prior?.operationId ?? operation?._id;
    const metadata = {
      classification,
      ...(operationId === undefined ? {} : { operationId }),
    };
    const inboxId =
      prior?._id ??
      (await ctx.db.insert("lencoWebhookInbox", {
        bodyDigest: args.bodyDigest,
        eventKind: args.eventKind,
        ingestedAt: Date.now(),
        ...metadata,
      }));
    if (prior !== undefined) {
      await ctx.db.patch(inboxId, metadata);
    }
    await armInboxPolling(ctx, inboxId);
    return { inboxId, ...metadata };
  },
});

// A result cannot select or change an inbox's authoritative operation association.
export const recordResult = internalMutation({
  args: {
    inboxId: v.id("lencoWebhookInbox"),
    bodyDigest: v.string(),
    result: settlementResultValidator,
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const inbox = await ctx.db.get(args.inboxId);
    if (
      inbox === null ||
      inbox.bodyDigest !== args.bodyDigest ||
      inbox.operationId !== args.result.operationId ||
      inbox.classification !== "terminal"
    ) {
      throw new Error("Webhook result mismatch");
    }
    await ctx.db.patch(inbox._id, { result: args.result.application });
    return null;
  },
});
