import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { associatedInboxWork } from "../paymentReconciliationData";
import { FINANCIAL_POLL_DEADLINE_MS, FINANCIAL_POLL_OFFSETS, validPollOrigin } from "./paymentPolling";

export const INBOX_POLL_OFFSETS: readonly number[] = [0, ...FINANCIAL_POLL_OFFSETS];

export const inboxPollStateValidator = v.union(
  v.literal("active"),
  v.literal("awaiting_exhaustion"),
  v.literal("stopped"),
  v.literal("exhausted")
);

export const inboxPollArgs = {
  pollId: v.id("paymentInboxPolls"),
  inboxId: v.id("lencoWebhookInbox"),
  generation: v.number(),
  index: v.number(),
};

// Source-owned metadata records a performed GET, not money or fee authority.
// Partial, invalid or future completion metadata must never count as success.
export function inboxLookupCompleted(inbox: Doc<"lencoWebhookInbox">, now: number): boolean {
  if (inbox.lookupCompletedAt === undefined && inbox.lookupResult === undefined) {
    return false;
  }
  if (
    !Number.isSafeInteger(inbox.lookupCompletedAt) ||
    (inbox.lookupCompletedAt ?? -1) < inbox.ingestedAt ||
    (inbox.lookupCompletedAt ?? Infinity) > now ||
    !["pending", "applied", "review", "unsupported"].includes(inbox.lookupResult ?? "")
  ) {
    throw new Error("Invalid inbox lookup completion");
  }
  return true;
}

// The only arm edge is the verified ingestion mutation. Authority and the
// immutable budget come from current stored work, never callback parameters.
export async function armInboxPolling(ctx: MutationCtx, inboxId: Id<"lencoWebhookInbox">): Promise<void> {
  const existing = await ctx.db
    .query("paymentInboxPolls")
    .withIndex("by_inbox", (q) => q.eq("inboxId", inboxId))
    .take(2);
  if (existing.length > 1) {
    throw new Error("Ambiguous inbox poll");
  }
  // Identical redelivery cannot restart even stopped/exhausted observations.
  if (existing.length === 1) {
    return;
  }
  const work = await associatedInboxWork(ctx, inboxId);
  if (work === null) {
    return;
  }
  const origin = work.inbox.ingestedAt;
  const now = Date.now();
  if (!validPollOrigin(origin) || !Number.isSafeInteger(now) || now < origin) {
    throw new Error("Invalid inbox poll origin");
  }
  const completed = inboxLookupCompleted(work.inbox, now);
  const expired = now >= origin + FINANCIAL_POLL_DEADLINE_MS;
  const pollId = await ctx.db.insert("paymentInboxPolls", {
    inboxId,
    operationId: work.operation._id,
    bodyDigest: work.inbox.bodyDigest,
    eventKind: work.inbox.eventKind,
    classification: work.inbox.classification,
    origin,
    generation: 1,
    nextIndex: 0,
    dispatchedCount: 0,
    dueAt: origin,
    state: completed ? "stopped" : expired ? "exhausted" : "active",
  });
  if (!completed && !expired) {
    const jobId = await ctx.scheduler.runAt(origin, internal.paymentInboxPolling.checkpoint, {
      pollId,
      inboxId,
      generation: 1,
      index: 0,
    });
    await ctx.db.patch(pollId, { jobId });
  }
}
