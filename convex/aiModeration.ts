import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { action } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { admitCaller, reserveCall, type GateRefusalCode } from "./lib/aiGate";
import {
  MODERATION_FALLBACKS,
  MODERATION_SETTINGS,
  buildModerationMessages,
  parseModerationOutput,
  type ModerationStatus,
  type StoredListing,
} from "./lib/aiModerationPolicy";
import { callChatModel, describeAiConfiguration, type AiEnv, type AiFetch } from "./lib/aiProvider";

// Pinkie's listing moderation: an advisory AI review of a listing a reviewer is looking at. The listing is never taken
// from the client. Order of operations is fixed: require current consent and a reviewer account, read the stored listing
// through an internal query that checks the reviewer first, decide any no-model result, reserve usage, call the model,
// then validate the output. Only a validated clear or flagged result is saved, through an internal mutation that rechecks
// the reviewer and the listing revision. A model that is unavailable, incomplete, or malformed gets an error-shaped
// fallback, and that fallback is never saved.

export type ModerateDeps = {
  env: () => AiEnv;
  fetchImpl?: AiFetch;
  timeoutMs?: number;
};

export type ModerationRefusalCode =
  | "consent_required"
  | "account_required"
  | "account_unavailable"
  | "forbidden"
  | "not_found"
  | "listing_invalid"
  | "rate_limited"
  | "stale"
  | "invalid_output"
  | "unavailable";

export type ModerateListingResult =
  | {
      ok: true;
      source: "ai";
      saved: true;
      revision: number;
      status: ModerationStatus;
      summary: string;
      flags: string[];
    }
  | {
      ok: true;
      source: "fallback";
      saved: false;
      revision: number;
      status: "error";
      summary: string;
      flags: string[];
    }
  | { ok: false; code: ModerationRefusalCode };

type ModerateActionCtx = Pick<ActionCtx, "auth" | "runQuery" | "runMutation">;
type Refusal = { ok: false; code: ModerationRefusalCode };

function refuse(code: ModerationRefusalCode): Refusal {
  return { ok: false, code };
}

// Moderation is for signed-in reviewers. The session code can only come from a guest path, so it maps to account_required.
function refusalOf(code: GateRefusalCode): ModerationRefusalCode {
  return code === "session_required" ? "account_required" : code;
}

// A failed read or write is logged by its safe label only, because its error text can carry listing data.
async function attempt<T>(label: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch {
    console.error(`[ai] ${label} failed`);
    return null;
  }
}

function fallback(revision: number, kind: keyof typeof MODERATION_FALLBACKS): ModerateListingResult {
  return {
    ok: true,
    source: "fallback",
    saved: false,
    revision,
    status: "error",
    summary: MODERATION_FALLBACKS[kind].summary,
    flags: [...MODERATION_FALLBACKS[kind].flags],
  };
}

async function askModel(listing: StoredListing, deps: ModerateDeps): Promise<string | null> {
  const outcome = await callChatModel({
    messages: buildModerationMessages(listing),
    jsonMode: true,
    maxTokens: MODERATION_SETTINGS.maxTokens,
    temperature: MODERATION_SETTINGS.temperature,
    env: deps.env(),
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.timeoutMs,
  });
  return outcome.ok ? outcome.text : null;
}

async function runModeration(
  ctx: ModerateActionCtx,
  args: { productId: Id<"products">; consentVersion?: number },
  deps: ModerateDeps
): Promise<ModerateListingResult> {
  const admission = await admitCaller(ctx, {
    consentVersion: args.consentVersion,
    sessionId: undefined,
    requireAccount: true,
  });
  if (!admission.ok) {
    return refuse(refusalOf(admission.code));
  }
  if (admission.caller.kind !== "account") {
    return refuse("account_required");
  }
  const userId = admission.caller.userId;

  const read = await attempt("listing read", () =>
    ctx.runQuery(internal.aiModerationData.listingForModeration, { userId, productId: args.productId })
  );
  if (read === null) {
    return refuse("unavailable");
  }
  if (!read.ok) {
    return refuse(read.code);
  }

  if (!describeAiConfiguration(deps.env()).configured) {
    return fallback(read.updatedAt, "unavailable");
  }
  const reserved = await reserveCall(ctx, { kind: "account", userId });
  if (reserved !== null) {
    return refuse(refusalOf(reserved));
  }

  const text = await askModel(read.listing, deps);
  const output = text === null ? null : parseModerationOutput(text);
  if (output === null) {
    return fallback(read.updatedAt, "failed");
  }

  const saved = await attempt("moderation save", () =>
    ctx.runMutation(internal.aiModerationData.saveModerationResult, {
      productId: args.productId,
      revision: read.revision,
      status: output.status,
      summary: output.summary,
      flags: output.flags,
      reviewerId: userId,
    })
  );
  if (saved === null) {
    return refuse("unavailable");
  }
  if (!saved.saved) {
    return refuse(saved.reason);
  }
  return {
    ok: true,
    source: "ai",
    saved: true,
    revision: read.updatedAt,
    status: output.status,
    summary: output.summary,
    flags: output.flags,
  };
}

/** Builds the moderation action with its dependencies injected. Production uses `moderateListing` below. */
export function createModerateListingAction(deps: ModerateDeps) {
  return action({
    args: { productId: v.id("products"), consentVersion: v.optional(v.number()) },
    handler: async (ctx, args): Promise<ModerateListingResult> => await runModeration(ctx, args, deps),
  });
}

export const moderateListing = createModerateListingAction({ env: () => process.env });
