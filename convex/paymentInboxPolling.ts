import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { INBOX_POLL_OFFSETS, inboxLookupCompleted, inboxPollArgs } from "./lib/paymentInboxPolling";
import { FINANCIAL_POLL_DEADLINE_MS, validPollOrigin } from "./lib/paymentPolling";
import { associatedInboxWork } from "./paymentReconciliationData";

type PollArgs = Infer<ReturnType<typeof v.object<typeof inboxPollArgs>>>;
type Poll = Doc<"paymentInboxPolls">;

async function loadCheckpoint(
  ctx: MutationCtx,
  args: PollArgs,
  safety: boolean
): Promise<{ poll: Poll; now: number } | null> {
  if (args.generation !== 1 || !Number.isSafeInteger(args.index) || args.index < 0 || args.index > 31) {
    return null;
  }
  const poll = await ctx.db.get(args.pollId);
  if (poll === null || poll.inboxId !== args.inboxId) {
    return null;
  }
  const rows = await ctx.db
    .query("paymentInboxPolls")
    .withIndex("by_inbox", (q) => q.eq("inboxId", poll.inboxId))
    .take(2);
  const active = poll.state === "active";
  const offset = poll.nextIndex === 31 ? FINANCIAL_POLL_DEADLINE_MS : INBOX_POLL_OFFSETS[poll.nextIndex];
  if (
    rows.length !== 1 ||
    rows[0]?._id !== poll._id ||
    !validPollOrigin(poll.origin) ||
    poll.generation !== 1 ||
    !Number.isSafeInteger(poll.nextIndex) ||
    poll.nextIndex < 0 ||
    poll.nextIndex > 31 ||
    !Number.isSafeInteger(poll.dispatchedCount) ||
    poll.dispatchedCount < 0 ||
    poll.dispatchedCount > poll.nextIndex ||
    poll.dispatchedCount > 31 ||
    offset === undefined ||
    poll.dueAt !== poll.origin + offset ||
    !/^[a-f0-9]{64}$/.test(poll.bodyDigest) ||
    !["active", "awaiting_exhaustion", "stopped", "exhausted"].includes(poll.state) ||
    ((active || poll.state === "awaiting_exhaustion") &&
      (typeof poll.jobId !== "string" ||
        poll.jobId.length === 0 ||
        (active ? poll.nextIndex === 31 : poll.nextIndex !== 31)))
  ) {
    throw new Error("Invalid inbox poll state");
  }
  if (
    poll.generation !== args.generation ||
    poll.nextIndex !== args.index ||
    (safety ? poll.state !== "awaiting_exhaustion" : poll.state !== "active")
  ) {
    return null;
  }
  const now = Date.now();
  if (!Number.isSafeInteger(now) || now < poll.dueAt) {
    return null;
  }
  return { poll, now };
}

async function stopIfResolved(ctx: MutationCtx, poll: Poll, now: number): Promise<boolean> {
  const work = await associatedInboxWork(ctx, poll.inboxId);
  if (
    work === null ||
    work.operation._id !== poll.operationId ||
    work.inbox.ingestedAt !== poll.origin ||
    work.inbox.bodyDigest !== poll.bodyDigest ||
    work.inbox.eventKind !== poll.eventKind ||
    work.inbox.classification !== poll.classification ||
    inboxLookupCompleted(work.inbox, now)
  ) {
    await ctx.db.patch(poll._id, { state: "stopped" });
    return true;
  }
  return false;
}

async function exhaustUnresolved(ctx: MutationCtx, poll: Poll, now: number): Promise<void> {
  if (!(await stopIfResolved(ctx, poll, now))) {
    // Silence expires only this observation's acquisition budget. The financial
    // engine, holds, fees, reservations and single settlement writer are separate.
    await ctx.db.patch(poll._id, { state: "exhausted" });
  }
}

export const checkpoint = internalMutation({
  args: inboxPollArgs,
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const current = await loadCheckpoint(ctx, args, false);
    if (current === null) {
      return null;
    }
    const { poll, now } = current;
    if (now >= poll.origin + FINANCIAL_POLL_DEADLINE_MS) {
      await exhaustUnresolved(ctx, poll, now);
      return null;
    }
    if (await stopIfResolved(ctx, poll, now)) {
      return null;
    }
    // One current GET, then the next strictly future opportunity; no burst or
    // reset. Final GET has its fixed safety already committed with the action.
    const nextIndex = INBOX_POLL_OFFSETS.findIndex(
      (offset, index) => index > poll.nextIndex && poll.origin + offset > now
    );
    const safety = nextIndex === -1;
    const index = safety ? 31 : nextIndex;
    const dueAt = poll.origin + (safety ? FINANCIAL_POLL_DEADLINE_MS : INBOX_POLL_OFFSETS[index]!);
    const jobId = await ctx.scheduler.runAt(
      dueAt,
      safety ? internal.paymentInboxPolling.exhaustion : internal.paymentInboxPolling.checkpoint,
      { pollId: poll._id, inboxId: poll.inboxId, generation: poll.generation, index }
    );
    await ctx.db.patch(poll._id, {
      state: safety ? "awaiting_exhaustion" : "active",
      nextIndex: index,
      dispatchedCount: poll.dispatchedCount + 1,
      dueAt,
      jobId,
    });
    await ctx.scheduler.runAfter(0, internal.paymentReconciliation.reconcileAssociatedInbox, {
      inboxId: poll.inboxId,
    });
    return null;
  },
});

export const exhaustion = internalMutation({
  args: inboxPollArgs,
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const current = await loadCheckpoint(ctx, args, true);
    if (current !== null) {
      await exhaustUnresolved(ctx, current.poll, current.now);
    }
    return null;
  },
});
