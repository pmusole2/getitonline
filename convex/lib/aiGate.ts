import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import { hasCurrentAiConsent } from "./aiConsent";

// Admission steps shared by Pinkie's discovery actions: consent, caller resolution, and the usage reservation. The
// caller comes only from the verified identity; a guest must send a session and can name no account. This duplicates
// the matching steps in convex/ai.ts, which is under review and is not changed here; consolidate once that review ends.

export type AiCaller = { kind: "account"; userId: Id<"users"> } | { kind: "guest"; sessionId: string };

export type GateRefusalCode =
  | "consent_required"
  | "session_required"
  | "account_required"
  | "account_unavailable"
  | "rate_limited";

export type GateAdmission = { ok: true; caller: AiCaller } | { ok: false; code: GateRefusalCode };

export type GateCtx = Pick<ActionCtx, "auth" | "runQuery" | "runMutation">;

const AI_LIMIT_MESSAGE = "AI usage limit reached";
const INVALID_SESSION_MESSAGE = "Invalid AI session";

/**
 * Checks consent, then resolves the caller. Consent comes first, so a refused consent reads nothing. A signed-in account
 * that is unknown, banned, or deleted is refused and never falls through to guest. With `requireAccount`, a guest is
 * refused before any database read.
 */
export async function admitCaller(
  ctx: GateCtx,
  input: { consentVersion: unknown; sessionId: string | undefined; requireAccount: boolean }
): Promise<GateAdmission> {
  if (!hasCurrentAiConsent(input.consentVersion)) {
    return { ok: false, code: "consent_required" };
  }
  const identity = await ctx.auth.getUserIdentity();
  if (identity) {
    const account = await ctx.runQuery(internal.aiData.resolveChatAccount, { clerkId: identity.subject });
    return account.ok
      ? { ok: true, caller: { kind: "account", userId: account.userId } }
      : { ok: false, code: "account_unavailable" };
  }
  if (input.requireAccount) {
    return { ok: false, code: "account_required" };
  }
  const guestSession = input.sessionId?.trim() ?? "";
  return guestSession === ""
    ? { ok: false, code: "session_required" }
    : { ok: true, caller: { kind: "guest", sessionId: guestSession } };
}

/** Reserves one call across every bucket for this caller. A refused reservation changes nothing and returns its code. */
export async function reserveCall(ctx: GateCtx, caller: AiCaller): Promise<GateRefusalCode | null> {
  try {
    await ctx.runMutation(internal.aiUsage.reserveAiCall, {
      caller:
        caller.kind === "account"
          ? { kind: "account", userId: caller.userId }
          : { kind: "guest", sessionId: caller.sessionId },
    });
    return null;
  } catch (error: unknown) {
    // Convex may wrap the thrown message, so match on the text rather than equality.
    const message = error instanceof Error ? error.message : "";
    if (message.includes(AI_LIMIT_MESSAGE)) {
      return "rate_limited";
    }
    if (message.includes(INVALID_SESSION_MESSAGE)) {
      return "session_required";
    }
    throw error;
  }
}
