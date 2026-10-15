import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { requireUser } from "./lib/auth";
import { normalizeRequestId } from "./lib/providerOperationContracts";
import { recoverySelectorValidator, type RecoverySelector } from "./lib/paymentReconciliation";
import { webhookClassificationValidator, webhookEventKindValidator, webhookResultValidator } from "./lib/lencoWebhook";

type OwnedSelection =
  | { result: "found"; operation: Doc<"paymentOperations"> }
  | { result: "review"; reason: "ambiguous_request" }
  | null;

export async function selectOwnedOperation(ctx: QueryCtx, selector: RecoverySelector): Promise<OwnedSelection> {
  const actor = await requireUser(ctx);
  if ((selector.operationId === undefined) === (selector.requestId === undefined)) {
    throw new Error("Argument validation failed: provide exactly one recovery selector");
  }
  if (selector.operationId !== undefined) {
    const operation = await ctx.db.get(selector.operationId);
    if (operation === null) {
      return null;
    }
    if (operation.ownerId !== actor._id) {
      throw new Error("Unauthorized");
    }
    return { result: "found", operation };
  }
  // The exclusive-selector guard above leaves only the request selector here.
  const requestId = normalizeRequestId(selector.requestId ?? "");
  const matches = await ctx.db
    .query("paymentOperations")
    .withIndex("by_owner_request", (q) => q.eq("ownerId", actor._id).eq("requestId", requestId))
    .collect();
  if (matches.length > 1) {
    return { result: "review", reason: "ambiguous_request" };
  }
  const operation = matches[0];
  return operation === undefined ? null : { result: "found", operation };
}

// Raw frozen intents stay behind private registered queries. Public selectors
// never carry owner, destination, provider authority or a purported receipt.
export const getOwnedOperation = internalQuery({
  args: recoverySelectorValidator,
  handler: async (ctx, args): Promise<OwnedSelection> => await selectOwnedOperation(ctx, args),
});

export const getOperation = internalQuery({
  args: { operationId: v.id("paymentOperations") },
  handler: async (ctx, args): Promise<Doc<"paymentOperations"> | null> => await ctx.db.get(args.operationId),
});

type InboxWork = {
  inbox: Doc<"lencoWebhookInbox">;
  operation: Exclude<Doc<"paymentOperations">, { kind: "wallet_purchase" }>;
};

export async function associatedInboxWork(
  ctx: Pick<QueryCtx, "db">,
  inboxId: Doc<"lencoWebhookInbox">["_id"]
): Promise<InboxWork | null> {
  const inbox = await ctx.db.get(inboxId);
  if (
    inbox === null ||
    inbox.operationId === undefined ||
    !["lookup_required", "enrichment", "review", "terminal"].includes(inbox.classification)
  ) {
    return null;
  }
  const digests = await ctx.db
    .query("lencoWebhookInbox")
    .withIndex("by_digest", (q) => q.eq("bodyDigest", inbox.bodyDigest))
    .collect();
  if (digests.length !== 1 || digests[0]?._id !== inbox._id) {
    return null;
  }
  const operation = await ctx.db.get(inbox.operationId);
  if (operation === null || operation.kind === "wallet_purchase") {
    return null;
  }
  const allowedEvent =
    operation.kind === "withdrawal_transfer"
      ? ["transfer_successful", "transfer_failed"].includes(inbox.eventKind)
      : ["collection_successful", "collection_failed", "collection_settled"].includes(inbox.eventKind);
  if (!allowedEvent) {
    return null;
  }
  const references = await ctx.db
    .query("paymentOperations")
    .withIndex("by_provider_reference", (q) => q.eq("providerReference", operation.providerReference))
    .collect();
  const ids =
    operation.providerId === undefined
      ? []
      : await ctx.db
          .query("paymentOperations")
          .withIndex("by_provider_id", (q) => q.eq("providerId", operation.providerId))
          .collect();
  const candidates = [...new Map([...references, ...ids].map((entry) => [entry._id, entry])).values()];
  return candidates.length === 1 && candidates[0]?._id === operation._id ? { inbox, operation } : null;
}

export const getInboxWork = internalQuery({
  args: { inboxId: v.id("lencoWebhookInbox") },
  handler: async (ctx, args): Promise<InboxWork | null> => await associatedInboxWork(ctx, args.inboxId),
});

// Completion means an actual GET receipt reached the accepted settler, even
// for pending/null-fee results. It is neither financial proof nor a known fee.
export const recordLookupResult = internalMutation({
  args: {
    inboxId: v.id("lencoWebhookInbox"),
    bodyDigest: v.string(),
    operationId: v.id("paymentOperations"),
    eventKind: webhookEventKindValidator,
    classification: webhookClassificationValidator,
    result: webhookResultValidator,
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const work = await associatedInboxWork(ctx, args.inboxId);
    if (
      work === null ||
      work.inbox.bodyDigest !== args.bodyDigest ||
      work.inbox.operationId !== args.operationId ||
      work.inbox.classification !== args.classification ||
      work.inbox.eventKind !== args.eventKind
    ) {
      throw new Error("Lookup result mismatch");
    }
    await ctx.db.patch(work.inbox._id, { lookupCompletedAt: Date.now(), lookupResult: args.result });
    return null;
  },
});
