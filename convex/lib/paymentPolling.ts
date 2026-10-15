import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export const FINANCIAL_POLL_OFFSETS: readonly number[] = [
  30_000,
  60_000,
  120_000,
  300_000,
  900_000,
  1_800_000,
  ...Array.from({ length: 24 }, (_, index) => (index + 1) * 3_600_000),
];
export const FINAL_GET_GRACE_MS = 60_000;
export const FINANCIAL_POLL_DEADLINE_MS = 86_400_000 + FINAL_GET_GRACE_MS;

export const financialPollStateValidator = v.union(
  v.literal("active"),
  v.literal("awaiting_exhaustion"),
  v.literal("stopped"),
  v.literal("exhausted")
);

export const financialPollArgs = {
  pollId: v.id("paymentFinancialPolls"),
  operationId: v.id("paymentOperations"),
  generation: v.number(),
  index: v.number(),
};

export function validPollOrigin(origin: number): boolean {
  return Number.isSafeInteger(origin) && origin >= 0 && Number.isSafeInteger(origin + FINANCIAL_POLL_DEADLINE_MS);
}

// Consumed only at the three new claim edges, inside the same mutation as the
// immutable attempt and reservations. Scheduler/persistence failures propagate:
// production commits all of these writes/jobs together or authorizes no POST.
export async function armFinancialPolling(ctx: MutationCtx, operationId: Id<"paymentOperations">): Promise<void> {
  const operation = await ctx.db.get(operationId);
  if (
    operation === null ||
    operation.kind === "wallet_purchase" ||
    operation.status !== "attempted" ||
    operation.attemptedAt === undefined ||
    !validPollOrigin(operation.attemptedAt)
  ) {
    throw new Error("Invalid financial poll claim");
  }
  const existing = await ctx.db
    .query("paymentFinancialPolls")
    .withIndex("by_operation", (q) => q.eq("operationId", operationId))
    .take(2);
  if (existing.length !== 0) {
    throw new Error("Financial poll already armed");
  }
  const origin = operation.attemptedAt;
  const dueAt = origin + FINANCIAL_POLL_OFFSETS[0]!;
  const pollId = await ctx.db.insert("paymentFinancialPolls", {
    operationId,
    origin,
    generation: 1,
    nextIndex: 0,
    dispatchedCount: 0,
    dueAt,
    state: "active",
  });
  const jobId = await ctx.scheduler.runAt(dueAt, internal.paymentPolling.checkpoint, {
    pollId,
    operationId,
    generation: 1,
    index: 0,
  });
  await ctx.db.patch(pollId, { jobId });
}
