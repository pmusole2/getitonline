import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery } from "./_generated/server";
import { decideAccess } from "./lib/auth";
import { speakerSideOfMessage, isDisputeBuyer, type SpeakerSide } from "./lib/disputeAccess";
import { DISPUTE_LIMITS, addressesSecondPerson } from "./lib/aiDisputePolicy";
import { getCompanySellerUserId, isReviewerRole } from "./lib/platform";

// Internal reads and the one persistence write for Pinkie's dispute actions. The action passes the account it verified
// itself, and every read rechecks that account and the dispute. A caller who cannot read a dispute gets the same not_found
// as a missing dispute, and both do the same database work, so the result and the operations reveal nothing about other
// disputes. Each read returns only the fields its prompt needs; account contact data, addresses, and payment fields are
// never read here.

type Readable = { actor: Doc<"users">; dispute: Doc<"disputes">; side: SpeakerSide };

export type RephraseRead =
  | { ok: true; side: SpeakerSide; title: string; description: string }
  | { ok: false; code: "not_found" };

export type PromptMessageRead = { side: SpeakerSide; system: boolean; content: string };

export type ConversationRead =
  | {
      ok: true;
      side: SpeakerSide;
      reviewer: boolean;
      title: string;
      description: string;
      category: string;
      productTitle: string;
      orderAmount: number | null;
      orderCreatedAt: number | null;
      evidenceCount: number;
      messages: PromptMessageRead[];
    }
  | { ok: false; code: "not_found" };

export type ResolutionRead =
  | { ok: true; title: string; category: string; productTitle: string; orderAmount: number | null }
  | { ok: false; code: "not_found" | "forbidden" };

const UNKNOWN_PRODUCT = "Unknown Product";

// The side the account speaks for, or null when it may not read the dispute. It follows canReadDispute and speakerSideOf in
// lib/disputeAccess.ts, but uses the company seller id read by the caller, so the decision needs no further reads.
function sideOf(
  actor: Doc<"users">,
  dispute: Doc<"disputes">,
  companySellerId: Id<"users"> | null
): SpeakerSide | null {
  if (isDisputeBuyer(actor, dispute)) {
    return "buyer";
  }
  const actsForCompany = actor.role === "catalog_manager" && companySellerId === dispute.sellerId;
  if (dispute.sellerId === actor._id || actsForCompany) {
    return "seller";
  }
  return isReviewerRole(actor.role) ? "moderator" : null;
}

// Loads the account, the company seller context, and the dispute, and returns the side the account speaks for. All three
// reads run for every caller, in this order, whether or not the dispute exists, so a denial and a missing dispute do the
// same database work. Any failure returns null, which callers report as not_found.
async function readable(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  disputeId: Id<"disputes">
): Promise<Readable | null> {
  const actor = await ctx.db.get(userId);
  const companySellerId = await getCompanySellerUserId(ctx);
  const dispute = await ctx.db.get(disputeId);
  if (!actor || !dispute || !decideAccess({ subject: actor.clerkId, user: actor }).ok) {
    return null;
  }
  const side = sideOf(actor, dispute, companySellerId);
  return side === null ? null : { actor, dispute, side };
}

const userIdArg = v.id("users");
const disputeIdArg = v.id("disputes");

export const disputeForRephrase = internalQuery({
  args: { userId: userIdArg, disputeId: disputeIdArg },
  handler: async (ctx, args): Promise<RephraseRead> => {
    const found = await readable(ctx, args.userId, args.disputeId);
    if (found === null) {
      return { ok: false, code: "not_found" };
    }
    return {
      ok: true,
      side: found.side,
      title: found.dispute.title.slice(0, DISPUTE_LIMITS.titleLength),
      description: found.dispute.description.slice(0, DISPUTE_LIMITS.descriptionLength),
    };
  },
});

// The newest messages of this one dispute, in order. Speaker sides come from the stored side, falling back to the sender
// account for messages written before a side was recorded. Staff who are not a party are moderators.
export const disputeConversation = internalQuery({
  args: { userId: userIdArg, disputeId: disputeIdArg },
  handler: async (ctx, args): Promise<ConversationRead> => {
    const found = await readable(ctx, args.userId, args.disputeId);
    if (found === null) {
      return { ok: false, code: "not_found" };
    }
    const { dispute } = found;
    const order = await ctx.db.get(dispute.orderId);
    const newest = await ctx.db
      .query("messages")
      .withIndex("by_dispute_created", (q) => q.eq("disputeId", dispute._id))
      .order("desc")
      .take(DISPUTE_LIMITS.messageCount);

    return {
      ok: true,
      side: found.side,
      reviewer: isReviewerRole(found.actor.role),
      title: dispute.title.slice(0, DISPUTE_LIMITS.titleLength),
      description: dispute.description.slice(0, DISPUTE_LIMITS.descriptionLength),
      category: dispute.category,
      productTitle: (order?.items[0]?.title ?? UNKNOWN_PRODUCT).slice(0, DISPUTE_LIMITS.productTitleLength),
      orderAmount: order?.totalAmount ?? null,
      orderCreatedAt: order?.createdAt ?? null,
      evidenceCount: dispute.evidence.length,
      messages: newest.reverse().map((entry) => ({
        side: speakerSideOfMessage(entry, dispute),
        system: entry.isSystemMessage,
        content: entry.content.slice(0, DISPUTE_LIMITS.messageLength),
      })),
    };
  },
});

// Resolution drafts are for reviewers (admin and moderator) only. A participant who can read the dispute is forbidden.
export const disputeForResolution = internalQuery({
  args: { userId: userIdArg, disputeId: disputeIdArg },
  handler: async (ctx, args): Promise<ResolutionRead> => {
    const found = await readable(ctx, args.userId, args.disputeId);
    if (found === null) {
      return { ok: false, code: "not_found" };
    }
    if (!isReviewerRole(found.actor.role)) {
      return { ok: false, code: "forbidden" };
    }
    const order = await ctx.db.get(found.dispute.orderId);
    return {
      ok: true,
      title: found.dispute.title.slice(0, DISPUTE_LIMITS.titleLength),
      category: found.dispute.category,
      productTitle: (order?.items[0]?.title ?? UNKNOWN_PRODUCT).slice(0, DISPUTE_LIMITS.productTitleLength),
      orderAmount: order?.totalAmount ?? null,
    };
  },
});

// The only write the dispute actions make, and only for a reviewer's objective analysis. It rechecks that the account is a
// reviewer who can still read the dispute, and refuses second-person text and output over the caps. Participants can never
// store anything here, so one party's personalized analysis cannot replace or become the shared analysis.
export const persistAnalysis = internalMutation({
  args: {
    userId: userIdArg,
    disputeId: disputeIdArg,
    aiSummary: v.string(),
    aiSuggestions: v.array(v.string()),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const found = await readable(ctx, args.userId, args.disputeId);
    if (found === null || !isReviewerRole(found.actor.role)) {
      return false;
    }
    if (
      args.aiSummary.length > DISPUTE_LIMITS.summaryLength ||
      addressesSecondPerson(args.aiSummary) ||
      args.aiSuggestions.length > DISPUTE_LIMITS.resolutionCount ||
      args.aiSuggestions.some(
        (suggestion) =>
          suggestion.length > DISPUTE_LIMITS.resolutionDescriptionLength || addressesSecondPerson(suggestion)
      )
    ) {
      return false;
    }
    await ctx.db.patch(args.disputeId, {
      aiSummary: args.aiSummary,
      aiSuggestions: args.aiSuggestions,
      updatedAt: Date.now(),
    });
    return true;
  },
});
