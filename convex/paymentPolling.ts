import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import {
  FINANCIAL_POLL_DEADLINE_MS,
  FINANCIAL_POLL_OFFSETS,
  financialPollArgs,
  validPollOrigin,
} from "./lib/paymentPolling";
import { projectRecoveryStatus } from "./lib/paymentReconciliation";

type PollArgs = Infer<ReturnType<typeof v.object<typeof financialPollArgs>>>;
type Poll = Doc<"paymentFinancialPolls">;
type Operation = Exclude<Doc<"paymentOperations">, { kind: "wallet_purchase" }>;

async function loadCheckpoint(
  ctx: MutationCtx,
  args: PollArgs,
  safety: boolean
): Promise<{ poll: Poll; operation: Operation; now: number } | null> {
  if (args.generation !== 1 || !Number.isSafeInteger(args.index) || args.index < 0 || args.index > 30) {
    return null;
  }
  const poll = await ctx.db.get(args.pollId);
  if (poll === null || poll.operationId !== args.operationId) {
    return null;
  }
  const rows = await ctx.db
    .query("paymentFinancialPolls")
    .withIndex("by_operation", (q) => q.eq("operationId", poll.operationId))
    .take(2);
  const operation = await ctx.db.get(poll.operationId);
  const active = poll.state === "active";
  const dueOffset = active ? FINANCIAL_POLL_OFFSETS[poll.nextIndex] : FINANCIAL_POLL_DEADLINE_MS;
  if (
    rows.length !== 1 ||
    rows[0]?._id !== poll._id ||
    operation === null ||
    operation.kind === "wallet_purchase" ||
    operation.attemptedAt !== poll.origin ||
    !validPollOrigin(poll.origin) ||
    poll.generation !== 1 ||
    !Number.isSafeInteger(poll.nextIndex) ||
    poll.nextIndex < 0 ||
    poll.nextIndex > 30 ||
    !Number.isSafeInteger(poll.dispatchedCount) ||
    poll.dispatchedCount < 0 ||
    poll.dispatchedCount > poll.nextIndex ||
    poll.dispatchedCount > 30 ||
    typeof poll.jobId !== "string" ||
    poll.jobId.length === 0 ||
    !["active", "awaiting_exhaustion", "stopped", "exhausted"].includes(poll.state) ||
    ((active || poll.state === "awaiting_exhaustion") &&
      (dueOffset === undefined || poll.dueAt !== poll.origin + dueOffset || (!active && poll.nextIndex !== 30)))
  ) {
    throw new Error("Invalid financial poll state");
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
  return { poll, operation, now };
}

async function stopIfResolved(ctx: MutationCtx, poll: Poll, operation: Operation): Promise<boolean> {
  if (operation.reviewNeeded === true) {
    await ctx.db.patch(poll._id, { state: "stopped" });
    return true;
  }
  const status = await projectRecoveryStatus(ctx, operation);
  // Positive original accounting wins even if fee-only enrichment is unknown
  // or contradictory. Sticky actual financial review remains a manual hold.
  if (status?.result === "found" && status.accountingApplied) {
    await ctx.db.patch(poll._id, { state: "stopped" });
    return true;
  }
  return false;
}

async function exhaustUnresolved(ctx: MutationCtx, poll: Poll, operation: Operation): Promise<void> {
  if (await stopIfResolved(ctx, poll, operation)) {
    return;
  }
  // No reservation or outcome is inferred from silence. This is the only
  // financial-operation field these callbacks may write; review is sticky.
  await ctx.db.patch(operation._id, { reviewNeeded: true });
  await ctx.db.patch(poll._id, { state: "exhausted" });
}

export const checkpoint = internalMutation({
  args: financialPollArgs,
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const current = await loadCheckpoint(ctx, args, false);
    if (current === null) {
      return null;
    }
    const { poll, operation, now } = current;
    if (now >= poll.origin + FINANCIAL_POLL_DEADLINE_MS) {
      await exhaustUnresolved(ctx, poll, operation);
      return null;
    }
    if (await stopIfResolved(ctx, poll, operation)) {
      return null;
    }
    // Skip missed offsets rather than replaying a burst. Origin and budget
    // never move; a late callback costs historical GET opportunities.
    const nextIndex = FINANCIAL_POLL_OFFSETS.findIndex(
      (offset, index) => index > poll.nextIndex && poll.origin + offset > now
    );
    const safety = nextIndex === -1;
    const index = safety ? 30 : nextIndex;
    const dueAt = poll.origin + (safety ? FINANCIAL_POLL_DEADLINE_MS : FINANCIAL_POLL_OFFSETS[index]!);
    const jobId = await ctx.scheduler.runAt(
      dueAt,
      safety ? internal.paymentPolling.exhaustion : internal.paymentPolling.checkpoint,
      { pollId: poll._id, operationId: operation._id, generation: poll.generation, index }
    );
    await ctx.db.patch(poll._id, {
      state: safety ? "awaiting_exhaustion" : "active",
      nextIndex: index,
      dispatchedCount: poll.dispatchedCount + 1,
      dueAt,
      jobId,
    });
    // Both jobs and metadata commit together. The at-most-once GET action has
    // no responsibility for its successor and never retries a financial POST.
    await ctx.scheduler.runAfter(0, internal.paymentReconciliation.reconcileStoredOperation, {
      operationId: operation._id,
    });
    return null;
  },
});

export const exhaustion = internalMutation({
  args: financialPollArgs,
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const current = await loadCheckpoint(ctx, args, true);
    if (current !== null) {
      await exhaustUnresolved(ctx, current.poll, current.operation);
    }
    return null;
  },
});
