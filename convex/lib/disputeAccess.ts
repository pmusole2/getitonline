import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { canActAsCompanySeller, isReviewerRole } from "./platform";

// The buyer of the dispute's order.
export function isDisputeBuyer(actor: Doc<"users">, dispute: Doc<"disputes">) {
  return dispute.buyerId === actor._id;
}

// The seller side: the seller account itself, or catalog staff acting for the company seller account. Admins act as
// staff, so company delegation does not give them seller-side rights.
export async function actsAsDisputeSeller(ctx: QueryCtx | MutationCtx, actor: Doc<"users">, sellerId: Id<"users">) {
  if (sellerId === actor._id) {
    return true;
  }
  return actor.role === "catalog_manager" && (await canActAsCompanySeller(ctx, actor, sellerId));
}

// Reads and conversation access are open to the buyer, the seller side, and reviewers. Any other signed-in user is
// refused.
export async function canReadDispute(ctx: QueryCtx | MutationCtx, actor: Doc<"users">, dispute: Doc<"disputes">) {
  return (
    isDisputeBuyer(actor, dispute) ||
    isReviewerRole(actor.role) ||
    (await actsAsDisputeSeller(ctx, actor, dispute.sellerId))
  );
}

// Who spoke in a dispute conversation. Staff who are not a party are "moderator", whatever role they hold later.
export const speakerSideValidator = v.union(v.literal("buyer"), v.literal("seller"), v.literal("moderator"));

export type SpeakerSide = "buyer" | "seller" | "moderator";

// The side the verified actor speaks for. Call it only after canReadDispute has allowed the actor.
export async function speakerSideOf(
  ctx: QueryCtx | MutationCtx,
  actor: Doc<"users">,
  dispute: Doc<"disputes">
): Promise<SpeakerSide> {
  if (isDisputeBuyer(actor, dispute)) {
    return "buyer";
  }
  if (await actsAsDisputeSeller(ctx, actor, dispute.sellerId)) {
    return "seller";
  }
  return "moderator";
}

// Messages stored before speakerSide was recorded are labelled from the sender account alone: the buyer account, the
// seller account, and any other account as a moderator note. Roles are never used, because they change over time.
export function legacySpeakerSide(
  senderId: Id<"users">,
  dispute: Pick<Doc<"disputes">, "buyerId" | "sellerId">
): SpeakerSide {
  if (senderId === dispute.buyerId) {
    return "buyer";
  }
  if (senderId === dispute.sellerId) {
    return "seller";
  }
  return "moderator";
}

export function speakerSideOfMessage(
  message: Pick<Doc<"messages">, "senderId" | "speakerSide">,
  dispute: Pick<Doc<"disputes">, "buyerId" | "sellerId">
): SpeakerSide {
  return message.speakerSide ?? legacySpeakerSide(message.senderId, dispute);
}
