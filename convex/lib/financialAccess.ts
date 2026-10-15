import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { canActAsCompanySeller, isReviewerRole } from "./platform";

// The actor must come from requireUser(ctx). Financial order reads follow the established order-read policy.
export async function assertFinancialOrderAccess(
  ctx: QueryCtx,
  actor: Doc<"users">,
  parties: Pick<Doc<"orders">, "buyerId" | "sellerId">
): Promise<void> {
  if (
    parties.buyerId !== actor._id &&
    parties.sellerId !== actor._id &&
    !isReviewerRole(actor.role) &&
    !(await canActAsCompanySeller(ctx, actor, parties.sellerId))
  ) {
    throw new Error("Unauthorized");
  }
}

// Do not disclose another order through an inconsistent escrow link. Missing legacy orders remain null.
export async function requireEscrowReadAccess(
  ctx: QueryCtx,
  actor: Doc<"users">,
  escrow: Doc<"escrow">
): Promise<Doc<"orders"> | null> {
  await assertFinancialOrderAccess(ctx, actor, escrow);
  const order = await ctx.db.get(escrow.orderId);
  if (order) {
    await assertFinancialOrderAccess(ctx, actor, order);
  }

  return order;
}

// Standalone/aggregate payments belong to their payer and admins. Metadata never establishes order participation.
export async function requireTransactionReadAccess(
  ctx: QueryCtx,
  actor: Doc<"users">,
  transaction: Doc<"transactions">
): Promise<Doc<"orders"> | null> {
  const order = transaction.orderId ? await ctx.db.get(transaction.orderId) : null;
  const ownsPayment = transaction.userId === actor._id || actor.role === "admin";
  if (!ownsPayment && !order) {
    throw new Error("Unauthorized");
  }
  if (order) {
    await assertFinancialOrderAccess(ctx, actor, order);
  }

  return order;
}
